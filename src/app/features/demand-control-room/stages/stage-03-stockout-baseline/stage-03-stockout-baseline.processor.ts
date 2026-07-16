import { requireObservedSales } from '../../domain/math';
import { ExceptionTask, SimulationPolicy, StageSnapshot } from '../../domain/models';

import { applyReferenceAudit, cloneStates, createSnapshot, qualifySelection, seasonalFallbackSelection, selectReferences } from '../stage-support';

export function runStage3(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let lifted = 0;
  let insufficient = 0;
  let seasonalFallback = 0;
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const source = state.daily;
    state.daily = source.map((record, index) => {
      if (record.promoCode) return { ...record, baseDemand: null, baseSource: 'promo-defer' as const };
      if (record.hasRecord && !record.isStockout) return { ...record, baseDemand: requireObservedSales(record), baseSource: 'clean' as const };
      if (!record.hasRecord) {
        // Ngày không có bản ghi nguồn: KHÔNG tự nâng nền ở Chặng 3 (không đủ căn
        // cứ để coi là stockout hay sạch) — để nguyên 'insufficient', giao cho
        // Chặng 5 lấp nền kỹ thuật với bán kính tìm rộng hơn.
        insufficient++;
        return { ...record, baseDemand: null, baseSource: 'insufficient' as const };
      }
      let selection = qualifySelection(selectReferences(source, index, index, policy), source.length, index, index);
      if (selection.status === 'insufficient') {
        const fallback = seasonalFallbackSelection(source, index, policy, false);
        if (fallback) { selection = fallback; seasonalFallback++; }
      }
      const audited = applyReferenceAudit(record, selection);
      if (selection.status === 'insufficient' || audited.referenceMedian === null) {
        insufficient++;
        exceptions.push({
          id: `${state.definition.id}:3:BASELINE_NOT_IDENTIFIABLE:${record.date}`,
          ruleId: 'RULE-03-003', code: 'BASELINE_NOT_IDENTIFIABLE', stage: 3, skuId: state.definition.id, date: record.date,
          evidence: `Cấp 1 (theo thời gian) và cấp 3 (mùa vụ năm trước) đều không đủ ${policy.minimumReferences} ngày sạch tham chiếu.`,
          suggestedAction: 'Chọn SKU tương tự đã duyệt hoặc nhập nền thủ công MD (cấp 4/5 — cần phê duyệt trước khi dùng chính thức).',
          role: 'MD/Thu mua', status: 'OPEN', decisionVersion: policy.version,
        });
        return { ...audited, baseDemand: null, baseSource: 'insufficient' as const };
      }
      lifted++;
      return { ...audited, baseDemand: Math.max(requireObservedSales(record), audited.referenceMedian), baseSource: 'stockout-lifted' as const };
    });
  }
  return createSnapshot(3, policy, states, { 'Ngày đã nâng nền': lifted, 'Ngày thiếu căn cứ': insufficient, 'k tối đa mỗi phía': policy.maxBalancedPerSide, 'Dùng cấp mùa vụ năm trước': seasonalFallback }, [
    `[RULE-03-001] Mỗi ngày nâng nền dò tuần tự ±${policy.referenceRadius}/±${policy.referenceRadiusExtended}/±${policy.maxReferenceRadius}, tối thiểu ${policy.minimumReferences} ngày sạch quan sát.`,
    'Ngày CTKM được chuyển nguyên trạng sang Chặng 4.',
    `[RULE-03-003] ${seasonalFallback} ngày dùng cấp 3 (mùa vụ năm trước) sau khi cấp 1 không đủ căn cứ.`,
    `[RULE-03-003] ${exceptions.length} ngày còn BASELINE_UNRESOLVED sau khi hết cấp 1/3 — đã tạo task ngoại lệ đề nghị cấp 4/5 (cần phê duyệt).`,
  ], exceptions);
}
