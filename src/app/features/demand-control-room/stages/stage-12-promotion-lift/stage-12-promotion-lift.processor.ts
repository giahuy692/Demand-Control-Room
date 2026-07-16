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

export function runStage12(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const regions = buildPromoRegionSamples(state.daily);
    const factors = regions
      .filter(region => region.eligible)
      .map(region => region.factor!);
    const proposedFactor = factors.length ? median(factors) : null;
    state.promoFactor = proposedFactor;
    state.promoConfidence = factors.length >= 3 && proposedFactor! >= 1
      ? 'auto'
      : factors.length >= 2
        ? 'low'
        : factors.length === 1
          ? 'suggest-only'
          : regions.length
            ? 'blocked'
            : 'none';
  }
  return createSnapshot(12, policy, states, { 'Hệ số tự khóa': Object.values(states).filter(state => state.promoConfidence === 'auto').length, 'Cần duyệt': Object.values(states).filter(state => state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only').length, 'Bị chặn': Object.values(states).filter(state => state.promoConfidence === 'blocked').length, 'Không có mẫu': Object.values(states).filter(state => state.promoConfidence === 'none').length }, [
    'K = bán ghi nhận / nền tự nhiên theo vùng CTKM.', 'K < 1 được giữ làm bằng chứng và chuyển REVIEW, không tự nâng lên 1,00.',
    '[RULE-12-001] Chỉ học K từ vùng CTKM đủ căn cứ, không bị stockout làm méo (buildPromoRegionSamples loại hasStockout/missingBase); CTKM thường trực không tạo vùng vì đã bị loại khỏi promoCode trước Chặng 2.',
  ]);
}
