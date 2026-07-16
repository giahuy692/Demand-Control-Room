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

export function runStage2(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let stockoutDays = 0;
  let blockedByStockStatus = 0;
  let negativeReviewDays = 0;
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    state.daily = state.daily.map(record => {
      // RULE-02-001 — không đủ căn cứ tính tồn (ANCHOR_MISSING/UNRESOLVED) thì không được tự đánh stockout.
      if (record.stockCalculationStatus === 'ANCHOR_MISSING' || record.stockCalculationStatus === 'UNRESOLVED') {
        blockedByStockStatus++;
        exceptions.push({
          id: `${state.definition.id}:2:STOCK_ANCHOR_MISSING:${record.date}`,
          ruleId: 'RULE-02-001', code: 'STOCK_ANCHOR_MISSING', stage: 2, skuId: state.definition.id, date: record.date,
          evidence: `stockCalculationStatus=${record.stockCalculationStatus} — không đủ căn cứ để đánh giá stockout tự động.`,
          suggestedAction: 'Bổ sung mốc tồn/đối soát nguồn.', role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
        });
        return record.isStockout || record.stockoutReason !== null ? { ...record, isStockout: false, stockoutReason: null, stockoutReviewRequired: false } : record;
      }
      const flagged = isStockout(record, policy.cutoffHour, record.stockCalculationStatus);
      // RULE-02-003 — "quyết định stockout phụ thuộc tồn âm": tồn âm là dữ liệu bất thường nên MỌI
      // kết luận Chặng 2 của ngày này (dù flagged=true hay false) đều không đáng tin đầy đủ, không
      // chỉ riêng trường hợp trùng khớp đúng hai điều kiện (===0) vốn không thể xảy ra khi số âm.
      const reviewRequired = record.stockCalculationStatus === 'NEGATIVE_REVIEW';
      if (reviewRequired) {
        negativeReviewDays++;
        exceptions.push({
          id: `${state.definition.id}:2:STOCK_ANCHOR_MISSING:${record.date}:negative`,
          ruleId: 'RULE-02-003', code: 'STOCK_ANCHOR_MISSING', stage: 2, skuId: state.definition.id, date: record.date,
          evidence: `Tồn âm (openStock=${record.openStock}, closeStock=${record.closeStock}) vẫn được giữ nguyên, không tự đổi thành 0.`,
          suggestedAction: 'Bổ sung mốc tồn/đối soát nguồn.', role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
        });
      }
      if (!flagged) return record.isStockout || record.stockoutReason !== null || record.stockoutReviewRequired !== reviewRequired ? { ...record, isStockout: false, stockoutReason: null, stockoutReviewRequired: reviewRequired } : record;
      stockoutDays++;
      const reason = record.openStock === 0 && record.closeStock === 0 ? 'empty-all-day' as const : 'late-receipt' as const;
      return { ...record, isStockout: true, stockoutReason: reason, stockoutReviewRequired: reviewRequired };
    });
  }
  return createSnapshot(2, policy, states, {
    'Ngày stockout': stockoutDays, 'Điều kiện nghiệp vụ': 2,
    'Ngày chặn do thiếu căn cứ tồn': blockedByStockStatus, 'Ngày tồn âm cần xem xét': negativeReviewDays,
  }, [
    `[RULE-02-001] Áp đúng hai điều kiện stockout cho ${Object.keys(states).length} SKU; không áp heuristic theo loại SKU hoặc tần suất bán.`,
    `[RULE-02-001] ${blockedByStockStatus} ngày bị chặn đánh stockout tự động vì stockCalculationStatus=ANCHOR_MISSING/UNRESOLVED.`,
    `[RULE-02-003] ${negativeReviewDays} ngày tồn âm vẫn được đánh giá bình thường nhưng gắn stockoutReviewRequired=true, giữ nguyên số âm — không tự đổi thành 0.`,
  ], exceptions);
}
