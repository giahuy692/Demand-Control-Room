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

export function runStage8(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const { abc, xyz } = state.classification;
    // Mở rộng gate: xyz===null gồm cả CLASSIFICATION_BLOCKED (RULE-07-003) và NO_POSITIVE_DEMAND_REVIEW
    // (RULE-07-004) — không SKU nào trong 2 nhóm này có X/Y/Z hợp lệ để tra ma trận 3×3.
    if (xyz === null || xyz === 'D' || abc === 'N/A') {
      // RULE-08-002 — thiếu phân loại dùng null + POLICY_UNRESOLVED, KHÔNG dùng serviceLevel=0 làm placeholder.
      state.serviceLevel = null;
      state.capitalPriority = 'Chính sách riêng / cần duyệt';
      exceptions.push({
        id: `${state.definition.id}:8:POLICY_UNRESOLVED`,
        ruleId: 'RULE-08-002', code: 'POLICY_UNRESOLVED', stage: 8, skuId: state.definition.id, date: null,
        evidence: `Không xếp được vào ma trận 3×3 (ABC=${abc}, XYZ/D=${xyz ?? state.classification.classificationStatus}).`,
        suggestedAction: 'Duyệt ma trận/chính sách trước chặng sau.', role: 'Chủ nghiệp vụ + Thu mua', status: 'OPEN', decisionVersion: policy.version,
      });
      continue;
    }
    const cell = `${abc}${xyz}`;
    state.serviceLevel = policy.serviceLevels[cell] ?? null;
    state.capitalPriority = policy.capitalPriorities[cell] ?? 'Cần duyệt';
    if (state.serviceLevel === null) {
      exceptions.push({
        id: `${state.definition.id}:8:POLICY_UNRESOLVED`,
        ruleId: 'RULE-08-002', code: 'POLICY_UNRESOLVED', stage: 8, skuId: state.definition.id, date: null,
        evidence: `Ô ma trận ${cell} chưa có mức phục vụ cấu hình.`,
        suggestedAction: 'Duyệt ma trận/chính sách trước chặng sau.', role: 'Chủ nghiệp vụ + Thu mua', status: 'OPEN', decisionVersion: policy.version,
      });
    }
  }
  return createSnapshot(8, policy, states, { 'Ô ma trận đã khóa': Object.values(states).filter(state => state.serviceLevel !== null).length, 'Chính sách D/ngoại lệ': Object.values(states).filter(state => state.serviceLevel === null).length, 'Phiên chính sách': policy.version }, [
    'D không đi vào ma trận 3×3.', 'Mức phục vụ được khóa và chỉ truyền xuôi sang Chặng 15.',
    `[RULE-08-001] Ma trận ABC×XYZ dùng phiên chính sách ${policy.version}. Ứng dụng mô phỏng một lượt chạy này không lưu lịch sử phiên bản qua nhiều lần chạy nên KHÔNG THỂ đảm bảo "không hồi tố" giữa các lần chạy khác nhau — ghi nhận tường minh, không giả vờ có cơ chế đó.`,
    `[RULE-08-002] ${exceptions.length} SKU ở trạng thái POLICY_UNRESOLVED (serviceLevel=null, không dùng 0 làm placeholder).`,
  ], exceptions);
}
