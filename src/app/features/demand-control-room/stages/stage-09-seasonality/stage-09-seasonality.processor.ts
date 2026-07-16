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

export function runStage9(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y') {
      state.seasonality = 'not-applicable';
      continue;
    }
    // §12 (Chặng 9-12) — chỉ nhận chuỗi chu kỳ có trạng thái phù hợp: dùng trailingLockedRun thay
    // vì cycles.filter(locked) cũ (xóa khoảng trống rồi nối 2 đoạn xa nhau thành chuỗi liên tục giả).
    const values = trailingLockedRun(state.cycles).map(cycle => cycle.baseDemand);
    if (values.length < 48) {
      state.seasonality = 'insufficient-structure';
      continue;
    }
    const rounds = Array.from({ length: Math.floor(values.length / 24) }, (_, round) => values.slice(round * 24, round * 24 + 24));
    const repeatingPositions = Array.from({ length: 24 }, (_, position) => {
      const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
      const average = mean(ratios);
      const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
      const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
      return (average >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) || (average <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat));
    });
    state.seasonality = repeatingPositions.some(Boolean) ? 'confirmed' : 'no-clear-season';
  }
  const cycleQuality9 = lockedCycleQualityBreakdown(states);
  return createSnapshot(9, policy, states, {
    'Mùa vụ xác nhận': Object.values(states).filter(state => state.seasonality === 'confirmed').length,
    'Không mùa vụ rõ': Object.values(states).filter(state => state.seasonality === 'no-clear-season').length,
    'Thiếu cấu trúc': Object.values(states).filter(state => state.seasonality === 'insufficient-structure').length,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality9.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality9.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality9.fallback,
  }, [
    'Chỉ nhóm Y được kiểm tra.', 'Cần đồng thời đạt hệ số vị trí và tỷ lệ lặp ≥ 67%.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality9.observed} quan sát thuần, ${cycleQuality9.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality9.fallback} dùng nguồn dự phòng mùa vụ — không đổi phép tính, chỉ tách theo chất lượng nguồn (RULE-05-005).`,
  ]);
}
