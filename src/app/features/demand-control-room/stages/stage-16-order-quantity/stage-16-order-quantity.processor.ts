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

export function runStage16(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    state.orderPlan = buildOrderPlan(state, policy);
  }
  applySupplierConsolidation(states);
  const note16 = operationalStatusNote(policy, 16);
  return createSnapshot(16, policy, states, {
    'Tổng số cần trước làm tròn': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.rawQuantity ?? 0), 0)),
    'Tổng số đặt sau MOQ': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.orderQuantity ?? 0), 0)),
    'Dòng thiếu điều kiện': Object.values(states).filter(state => state.orderPlan?.warnings.length).length,
    'SKU có nguy cơ thiếu trước lô mới': Object.values(states).filter(state => (state.orderPlan?.shortageBeforeNewLot ?? 0) > 0).length,
    ...note16.summary,
  }, ['Vùng cần bao phủ = lead time (thật hoặc mặc định chính sách) + chu kỳ lập kế hoạch, không còn cứng toàn bộ tầm dự báo.', 'Không xét ngân sách tại Chặng 16.', 'Phần dư MOQ và thiếu hàng trước lô mới được giữ riêng để Chặng 17/18 kiểm tra ngoại lệ.', ...note16.audit]);
}
