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

export function runStage10(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y' || state.seasonality === 'confirmed') continue;
    const result = calculateTrend(lockedValues(state));
    state.trend = result.trend;
    state.trendRates = result.rates;
  }
  const cycleQuality10 = lockedCycleQualityBreakdown(states);
  return createSnapshot(10, policy, states, {
    'Xu hướng tăng': Object.values(states).filter(state => state.trend === 'up').length,
    'Xu hướng giảm': Object.values(states).filter(state => state.trend === 'down').length,
    'Không xu hướng': Object.values(states).filter(state => state.trend === 'none').length,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality10.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality10.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality10.fallback,
  }, [
    '12 chu kỳ cuối chia đúng 3 đoạn × 4.', 'Chỉ kết luận khi cả g₁ và g₂ cùng vượt ngưỡng ±5%.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality10.observed} quan sát thuần, ${cycleQuality10.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality10.fallback} dùng nguồn dự phòng mùa vụ.`,
  ]);
}
