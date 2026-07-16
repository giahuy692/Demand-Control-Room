import { buildCalendarScaffold } from '../../domain/calendar-scaffold';
import { SimulationDataset } from '../../domain/catalog';
import { FORECAST_HORIZON, fitBaseForecast } from '../../domain/forecast-models';
import { applyPromoFactor, calculateAvailableStock, calculateBias, calendarWindowAbcMetrics, calculateFreeStock, calculateNrmse, calculateRmse, calculateTrend, calculateWape, classifyPromoRegionPolicy, classifyXyz, fixedCalendarWindow, isStockout, mean, median, meetsSeasonRepeatThreshold, requireObservedSales, stripStandingPromoCodes, trailingLockedRun } from '../../domain/math';
import { AbcClass, BalanceStatus, Classification, CycleRecord, CycleStatus, DailyRecord, DSubtype, ExceptionResolutionOption, ExceptionResolutionType, ExceptionTask, LotReliability, SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot, XyzClass } from '../../domain/models';
import { chooseSafetyStock } from '../../domain/safety-stock';
import { applySupplierConsolidation, buildOrderPlan } from '../../domain/order-plan';
import { allocateBudget } from '../../domain/budget-allocation';
import { applyPurchaseOrderGrouping } from '../../domain/purchase-orders';
import { CAPITAL_PRIORITIES, DEFAULT_POLICY, SERVICE_LEVELS } from '../../domain/policy';
import { buildPromoRegionSamples } from '../../domain/promo-analysis';
import { demandRiskInputs } from '../../domain/demand-risk';


import { emptyClassification, cloneStates, operationalStatusNote, createSnapshot, isObservedClean, collectCleanSide, selectReferences, qualifySelection, applyReferenceAudit, buildPromoRegions, resetDailyRecord, createInitialState, futureActualDemand, lockedValues, lockedCycleQualityBreakdown, seasonalFallbackSelection, tier2RepresentativeFill, fillAndBuildCycles, cycleStatus, buildCycles, buildCycleException, classifyDSubtype, dateAfter } from '../stage-support';

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
    for (const region of buildPromoRegions(source, policy)) {
      region.codes.forEach(code => promoCodes.add(code));
      const firstIndex = region.indexes[0];
      const lastIndex = region.indexes.at(-1)!;
      // RULE-04-001 — CTKM chưa xác định loại KHÔNG được tự chuẩn hóa; chuyển hàng đợi phê duyệt.
      const classification = classifyPromoRegionPolicy(region.codes, policy.unknownReviewPromotionCodes, policy.clearancePromotionCodes);
      if (classification === 'UNKNOWN_REVIEW') {
        pendingReview += region.indexes.length;
        exceptions.push({
          id: `${state.definition.id}:4:PROMO_TYPE_UNKNOWN:${processed[firstIndex].date}`,
          ruleId: 'RULE-04-001', code: 'PROMO_TYPE_UNKNOWN', stage: 4, skuId: state.definition.id, date: processed[firstIndex].date,
          evidence: `Mã CTKM ${region.codes.join(', ')} nằm trong danh sách chờ phân loại (policy.unknownReviewPromotionCodes).`,
          suggestedAction: 'Phân loại CTKM.', role: 'Marketing/MD', status: 'OPEN', decisionVersion: policy.version,
        });
        continue; // Giữ nguyên baseSource='promo-defer' từ Chặng 3 — không tự quyết định nền.
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
          processed[index] = { ...audited, baseDemand: null, baseSource: 'insufficient' };
          continue;
        }
        normalized++;
        processed[index] = { ...audited, baseDemand: audited.referenceMedian, baseSource: 'promo-normalized' };
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
    `[RULE-04-001] ${pendingReview} ngày CTKM chưa xác định loại (UNKNOWN_REVIEW) bị chặn chuẩn hóa, chuyển hàng đợi phê duyệt.`,
    `[RULE-04-004] ${notIdentifiable} ngày thuộc cụm CTKM gần như liên tục không xác định được nền (BASELINE_NOT_IDENTIFIABLE).`,
  ], exceptions);
}
