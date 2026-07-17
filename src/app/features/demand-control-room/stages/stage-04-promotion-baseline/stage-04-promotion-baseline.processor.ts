import { classifyPromoRegionPolicy } from '../../domain/math';
import { BaseDemandSource, ExceptionTask, SimulationPolicy, StageSnapshot } from '../../domain/models';

import { applyReferenceAudit, buildPromoRegions, cloneStates, createSnapshot, qualifySelection, selectReferences } from '../stage-support';

export function runStage4(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let normalized = 0;
  let pendingReview = 0;
  let notIdentifiable = 0;
  const promoCodes = new Set<string>();
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const source = state.daily;
    const processed = source.slice();
    // QUYẾT ĐỊNH 2026-07-17 — Chặng 4 CHỈ chuẩn hóa DEEP_PROMO (mechanismType 2/7; buildPromoRegions
    // đã lọc theo isBaselineExcludedPromo). Ngày PROMOTION_UNRESOLVED là ngày bán bình thường cho
    // baseline nhưng RULE-04-001 vẫn tạo task nhắc phân loại — không tự quyết im lặng.
    const unresolvedDays = source.filter(record => record.promotionClass === 'PROMOTION_UNRESOLVED');
    if (unresolvedDays.length) {
      pendingReview += unresolvedDays.length;
      exceptions.push({
        id: `${state.definition.id}:4:PROMO_TYPE_UNKNOWN:${unresolvedDays[0].date}`,
        ruleId: 'RULE-04-001', code: 'PROMO_TYPE_UNKNOWN', stage: 4, skuId: state.definition.id, date: unresolvedDays[0].date,
        evidence: `${unresolvedDays.length} ngày có CTKM chưa xác định loại (PROMOTION_UNRESOLVED) — đang được coi là ngày bán bình thường theo quyết định chỉ xử lý mechanismType 2/7; cần phân loại để xác nhận.`,
        suggestedAction: 'Phân loại CTKM (tbl_POLPromotion.[Type]).', role: 'Marketing/MD', status: 'OPEN', decisionVersion: policy.version,
      });
    }
    for (const region of buildPromoRegions(source, policy)) {
      region.codes.forEach(code => promoCodes.add(code));
      const firstIndex = region.indexes[0];
      const lastIndex = region.indexes.at(-1)!;
      // RULE-04-001 — mã CTKM nằm trong danh sách chờ phân loại do chính sách chỉ định
      // (unknownReviewPromotionCodes) KHÔNG được tự chuẩn hóa; chuyển hàng đợi phê duyệt.
      const isUnresolved = region.indexes.some(idx =>
        processed[idx].promoCode !== null && policy.unknownReviewPromotionCodes?.includes(processed[idx].promoCode!)
      );
      if (isUnresolved) {
        pendingReview += region.indexes.length;
        exceptions.push({
          id: `${state.definition.id}:4:PROMO_TYPE_UNKNOWN:${processed[firstIndex].date}`,
          ruleId: 'RULE-04-001', code: 'PROMO_TYPE_UNKNOWN', stage: 4, skuId: state.definition.id, date: processed[firstIndex].date,
          evidence: `Mã CTKM ${region.codes.join(', ')} nằm trong danh sách chờ phân loại (UNKNOWN_REVIEW).`,
          suggestedAction: 'Phân loại CTKM.', role: 'Marketing/MD', status: 'OPEN', decisionVersion: policy.version,
        });
        continue;
      }
      const selection = qualifySelection(selectReferences(source, firstIndex, lastIndex, policy, true), source.length, firstIndex, lastIndex, region.clustered);
      // RULE-04-004 — CTKM gần như liên tục không tách được nền: gắn BASELINE_NOT_IDENTIFIABLE thay vì lặng lẽ dùng chung nhãn 'insufficient' với thiếu dữ liệu thường.
      if (selection.status === 'insufficient' && region.clustered) {
        notIdentifiable += region.indexes.length;
        exceptions.push({
          id: `${state.definition.id}:4:BASELINE_NOT_IDENTIFIABLE:${processed[firstIndex].date}`,
          ruleId: 'RULE-04-004', code: 'BASELINE_NOT_IDENTIFIABLE', stage: 4, skuId: state.definition.id, date: processed[firstIndex].date,
          evidence: `Cụm CTKM ${region.codes.join(', ')} gần như liên tục, không đủ ngày sạch đối chứng: ${selection.reason}`,
          suggestedAction: 'Chọn cửa hàng/SKU đối chứng hoặc nhập nền MD.', role: 'MD/Thu mua', status: 'OPEN', decisionVersion: policy.version,
        });
      }
      for (const index of region.indexes) {
        const audited = applyReferenceAudit(processed[index], selection);
        if (selection.status === 'insufficient' || audited.referenceMedian === null) {
          processed[index] = { ...audited, baseDemand: null, baseDemandSource: BaseDemandSource.PROMOTION_UNRESOLVED, isCleanObservedReference: false };
          continue;
        }
        normalized++;
        processed[index] = { ...audited, baseDemand: audited.referenceMedian, baseDemandSource: BaseDemandSource.PROMOTION_BASELINE, isCleanObservedReference: false };
      }
    }
    state.daily = processed;
  }
  return createSnapshot(4, policy, states, {
    'Ngày KM chuẩn hóa': normalized, 'Mã CTKM': promoCodes.size,
    'Ngày chờ phân loại CTKM': pendingReview, 'Ngày không xác định được nền': notIdentifiable,
  }, [
    'Dùng Median ngày sạch quanh vùng; không dùng max(sales, median).',
    'Giữ nguyên sales và promoCode để Chặng 12 học hệ số.',
    'Chỉ xử lý CTKM kích cầu mạnh (mechanismType 2/7 — DEEP_PROMO); các class khác được coi là ngày bán bình thường.',
    `[RULE-04-001] ${pendingReview} ngày CTKM chưa xác định loại (UNKNOWN_REVIEW/PROMOTION_UNRESOLVED) được đưa vào hàng đợi phê duyệt.`,
    `[RULE-04-004] ${notIdentifiable} ngày thuộc cụm CTKM gần như liên tục không xác định được nền (BASELINE_NOT_IDENTIFIABLE).`,
  ], exceptions);
}
