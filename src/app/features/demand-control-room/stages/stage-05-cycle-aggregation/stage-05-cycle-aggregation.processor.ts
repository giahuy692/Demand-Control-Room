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

export function runStage5(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const result = fillAndBuildCycles(state.daily, policy.cycleLength, policy.minimumReferences, policy.maxReferenceRadius, policy.enableTier2CycleFallback);
    state.daily = result.daily;
    state.cycles = result.cycles;
    // §5 LỆNH CODEX / RULE-05-006 — MỘT task ngoại lệ GỘP theo chu kỳ cho mỗi CK không khóa (không tạo
    // nhiều dòng lặp theo từng ngày unresolved bên trong chu kỳ đó).
    for (const cycle of result.cycles) {
      if (!cycle.locked) exceptions.push(buildCycleException(state.definition.id, cycle, policy));
    }
  }
  const cycles = Object.values(states).flatMap(state => state.cycles);
  const countByStatus = (status: CycleStatus) => cycles.filter(cycle => cycle.status === status).length;
  return createSnapshot(5, policy, states, {
    'Chu kỳ đã khóa': cycles.filter(cycle => cycle.locked).length, 'Chu kỳ 0 ngày có nền': cycles.filter(cycle => cycle.emptyCycle).length, 'Chu kỳ thiếu một phần nền': cycles.filter(cycle => !cycle.locked && !cycle.emptyCycle).length,
    'NO_SOURCE_RECORD': countByStatus('NO_SOURCE_RECORD'), 'BASELINE_UNRESOLVED': countByStatus('BASELINE_UNRESOLVED'), 'PARTIAL_BASELINE': countByStatus('PARTIAL_BASELINE'), 'LOCKED_OBSERVED': countByStatus('LOCKED_OBSERVED'),
    'LOCKED_ADJUSTED': countByStatus('LOCKED_ADJUSTED'), 'LOCKED_FALLBACK': countByStatus('LOCKED_FALLBACK'),
    'Chu kỳ lấp Tầng 2': cycles.filter(cycle => cycle.tier2Filled).length,
    'Ngoại lệ cấp chu kỳ (RULE-05-006)': exceptions.length,
  }, [
    'Chỉ chu kỳ locked=true được bàn giao cho Chặng 6–11.', 'Số bán CTKM thô không được cộng vào sức mua chu kỳ.',
    `[RULE-05-001] NO_SOURCE_RECORD chỉ gán khi sourceRecordDays=0, không dùng unresolvedDays=15 để kết luận "trống".`,
    `[RULE-05-003][DEC-P03/P04/P05·ĐỀ XUẤT] Lấp Tầng 2 (mức đại diện chu kỳ) đang ${policy.enableTier2CycleFallback ? 'BẬT' : 'TẮT MẶC ĐỊNH — chưa phê duyệt chính thức'}.`,
    `[RULE-05-005] Đã gán đủ trạng thái chu kỳ; OUTSIDE_ACTIVE_PERIOD/DATA_ERROR không có nguồn dữ liệu để phát hiện nên không bao giờ xuất hiện — không giả vờ có khả năng này.`,
    `[RULE-05-006] ${exceptions.length} ngoại lệ cấp chu kỳ được tạo (1 dòng/CK không khóa, gộp mọi ngày unresolved bên trong) — MÔ PHỎNG CHỈ ĐỀ XUẤT phương án xử lý, CHƯA THỰC HIỆN.`,
  ], exceptions);
}
