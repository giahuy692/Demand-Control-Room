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

export function runStage7(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    // RULE-07-003 — cửa sổ CỐ ĐỊNH 24 vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí kể
    // cả chu kỳ không khóa (khác lockedValues cũ — trích chu kỳ khóa rồi nối lại). Có gap → chặn.
    const fixed = fixedCalendarWindow(state.cycles, policy.abcWindowCycles);
    // §2.2 LỆNH CODEX — tỷ lệ chất lượng chuỗi PHẢI chia cho độ dài CỬA SỔ đang xét (lockedCyclesInWindow /
    // window.length), không chia cho toàn bộ lịch sử `state.cycles.length` (bản trước làm lệch tỷ lệ khi
    // lịch sử dài hơn nhiều so với cửa sổ 24 CK — ví dụ 20/24 khóa trong cửa sổ nhưng lịch sử có 75 CK sẽ ra
    // 20/75≈27% thay vì đúng 20/24≈83%). Không đổi chính sách chặn/không chặn của Chặng 7 — chỉ sửa bằng chứng.
    const seriesQualityRatio = fixed.window.length ? fixed.window.filter(cycle => cycle.locked).length / fixed.window.length : null;
    if (fixed.blocked) {
      const blockReason = fixed.blockingStatus!;
      const totalHistory = state.cycles.length;
      const usableRun = trailingLockedRun(state.cycles).length;
      const reason = `CLASSIFICATION_BLOCKED_${blockReason} — cửa sổ ${policy.abcWindowCycles} vị trí gần nhất theo lịch có chu kỳ ${blockReason}, không được nối các chu kỳ khóa còn lại thành chuỗi liên tục giả.`
        + (totalHistory > usableRun + 1 ? ` Lịch sử dài hơn nhiều so với đoạn dùng được (INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY, ${totalHistory} chu kỳ toàn bộ, chỉ ${usableRun} chu kỳ liên tiếp gần nhất còn dùng được).` : '');
      state.classification = {
        ...state.classification, xyz: null, classificationStatus: 'CLASSIFICATION_BLOCKED', classificationBlockReason: blockReason,
        n: fixed.window.length, m: fixed.window.filter(cycle => cycle.locked && cycle.baseDemand > 0).length,
        adi: null, positiveMean: null, positiveStdev: null, cv: null, cv2: null,
        dSubtype: null, seriesQualityRatio, classificationReason: reason,
      };
      exceptions.push({
        id: `${state.definition.id}:7:CLASSIFICATION_BLOCKED`,
        ruleId: 'RULE-07-003', code: 'CLASSIFICATION_BLOCKED', stage: 7, skuId: state.definition.id, date: null,
        evidence: reason, suggestedAction: `Rà soát nguyên nhân chu kỳ chưa khóa trong cửa sổ ${policy.abcWindowCycles} chu kỳ gần nhất (Chặng 3–5) trước khi tin vào kết luận X/Y/Z/D.`,
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
      continue;
    }
    const result = classifyXyz(fixed.window.map(cycle => cycle.baseDemand), policy.xyzThresholds);
    if (result.xyz === 'D') {
      const { dSubtype, reason } = classifyDSubtype(state);
      state.classification = { ...state.classification, ...result, classificationStatus: 'CLASSIFIED', classificationBlockReason: null, dSubtype, seriesQualityRatio, classificationReason: reason };
    } else if (result.xyz === null) {
      // RULE-07-004 — cửa sổ liên tục và đủ dài (n≥6) nhưng không có chu kỳ dương nào.
      const reason = `NO_POSITIVE_DEMAND_REVIEW — ${result.n} chu kỳ liên tục đều khóa nhưng toàn bộ bằng 0; không gán D, không tính ADI bằng phép chia cho 0.`;
      state.classification = { ...state.classification, ...result, classificationStatus: 'NO_POSITIVE_DEMAND_REVIEW', classificationBlockReason: null, dSubtype: null, seriesQualityRatio, classificationReason: reason };
    } else {
      const reason = `${result.xyz}: ADI=${result.adi?.toFixed(2) ?? '—'}, CV²=${result.cv2?.toFixed(3) ?? '—'} trên ${result.n} chu kỳ khóa (${result.m} chu kỳ dương).`;
      state.classification = { ...state.classification, ...result, classificationStatus: 'CLASSIFIED', classificationBlockReason: null, dSubtype: null, seriesQualityRatio, classificationReason: reason };
    }
  }
  const counts = (xyz: XyzClass) => Object.values(states).filter(state => state.classification.xyz === xyz).length;
  const blockedCount = Object.values(states).filter(state => state.classification.classificationStatus === 'CLASSIFICATION_BLOCKED').length;
  const noPositiveDemandCount = Object.values(states).filter(state => state.classification.classificationStatus === 'NO_POSITIVE_DEMAND_REVIEW').length;
  return createSnapshot(7, policy, states, {
    'Nhóm X': counts('X'), 'Nhóm Y': counts('Y'), 'Nhóm Z': counts('Z'), 'Nhóm D': counts('D'),
    'Chặn phân loại (đứt quãng)': blockedCount, 'Không có nhu cầu dương': noPositiveDemandCount,
  }, [
    'ADI dùng n/m; m là số chu kỳ có nhu cầu dương.', 'CV² dùng độ lệch chuẩn quần thể, mẫu số m.',
    `[RULE-07-001] Nhóm D được tách theo dSubtype (D_NEW/D_SHORT_HISTORY/D_EXTRACT_TRUNCATED), không gộp mọi nguyên nhân.`,
    `[RULE-07-002] Đã ghi seriesQualityRatio (tỷ lệ chu kỳ khóa/tổng chu kỳ trong khung) và classificationReason cho mọi SKU.`,
    `[RULE-07-003] Cửa sổ XYZ là đúng ${policy.abcWindowCycles} vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí; ${blockedCount} SKU bị CLASSIFICATION_BLOCKED vì cửa sổ có chu kỳ chưa khóa.`,
    `[RULE-07-004] ${noPositiveDemandCount} SKU có cửa sổ liên tục đủ dài nhưng toàn bộ bằng 0 → NO_POSITIVE_DEMAND_REVIEW, không gán D.`,
  ], exceptions);
}
