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

export function runStage11(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    // RULE-11-001 — chuỗi học là đoạn chu kỳ khóa LIÊN TIẾP gần nhất theo lịch (trailingLockedRun),
    // không bỏ khoảng trống rồi nén chuỗi như lockedSeriesAll cũ (cycles.filter(locked), không giới
    // hạn độ dài vì Holt-Winters cần ≥2 vòng mùa vụ).
    const run = trailingLockedRun(state.cycles);
    const values = run.map(cycle => cycle.baseDemand);
    state.forecast = fitBaseForecast(values, state.classification.xyz, state.seasonality, state.trend).result;
    if (state.cycles.length > run.length) {
      // Có chu kỳ cũ hơn bị loại khỏi chuỗi học vì một khoảng đứt quãng — KHÔNG nén lại để dùng
      // chung; mô hình vẫn có thể chạy được trên phần đuôi liên tục còn lại (đúng ngưỡng riêng của
      // từng mô hình), chỉ ghi nhận để người vận hành biết lịch sử dùng được ngắn hơn thực tế.
      exceptions.push({
        id: `${state.definition.id}:11:FORECAST_INPUT_BLOCKED`,
        ruleId: 'RULE-11-001', code: 'FORECAST_INPUT_BLOCKED', stage: 11, skuId: state.definition.id, date: null,
        evidence: `Chuỗi học chỉ dùng ${run.length}/${state.cycles.length} chu kỳ (đoạn liên tiếp gần nhất theo lịch); phần còn lại bị loại vì một khoảng chu kỳ chưa khóa, không được nén lại để dùng chung.`,
        suggestedAction: 'Rà soát khoảng chu kỳ chưa khóa trước khi tin dự báo chỉ dựa trên lịch sử ngắn hơn thực tế.',
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
    }
  }
  const cycleQuality11 = lockedCycleQualityBreakdown(states);
  const forecastInputBlockedCount = exceptions.length;
  return createSnapshot(11, policy, states, {
    'Mô hình đã khóa': Object.values(states).filter(state => state.forecast?.lockStatus === 'locked').length,
    'Cần kiểm tra': Object.values(states).filter(state => state.forecast?.lockStatus !== 'locked').length,
    'Tầm dự báo': `${FORECAST_HORIZON} chu kỳ`,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality11.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality11.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality11.fallback,
    'Chuỗi học bị đứt quãng': forecastInputBlockedCount,
  }, [
    'Chia TRAIN/TEST theo thời gian; tham số Grid Search chỉ trên TRAIN.', 'C11 chỉ đọc nhãn đã khóa; không tự phân loại lại SKU.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality11.observed} quan sát thuần, ${cycleQuality11.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality11.fallback} dùng nguồn dự phòng mùa vụ.`,
    `[RULE-11-001] ${forecastInputBlockedCount} SKU có chuỗi học ngắn hơn tổng lịch sử vì một khoảng chu kỳ chưa khóa (FORECAST_INPUT_BLOCKED) — không nén chuỗi, chỉ dùng đoạn liên tiếp gần nhất.`,
  ], exceptions);
}
