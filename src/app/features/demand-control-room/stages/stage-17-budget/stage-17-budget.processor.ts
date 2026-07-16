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

export function runStage17(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const { totalValue, funded } = allocateBudget(states, policy);
  const note17 = operationalStatusNote(policy, 17);
  return createSnapshot(17, policy, states, {
    'Tổng giá trị đề xuất': totalValue,
    'Ngân sách kỳ': policy.periodBudget,
    'Ngân sách đã cấp': funded,
    'Dòng bị cắt/hoãn': Object.values(states).filter(state => (state.budgetAllocation?.cutQuantity ?? 0) > 0).length,
    'Đề xuất vượt ngân sách': Object.values(states).filter(state => state.budgetAllocation?.status === 'over-budget-proposal').length,
    ...note17.summary,
  }, ['Không sửa dự báo, tồn kho an toàn hoặc số đặt sau MOQ.', 'Sắp xếp theo 7 tiêu chí của tài liệu — tuyệt đối không dùng giá trị đơn hàng làm tiêu chí ưu tiên.', 'Cấp hết Rổ 1 (tránh hết hàng) toàn danh mục trước khi đụng Rổ 2 (bảo vệ), rồi mới đến Rổ 3 (rủi ro MOQ).', ...note17.audit]);
}
