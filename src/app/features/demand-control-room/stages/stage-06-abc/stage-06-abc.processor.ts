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

export function runStage6(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  const windowSize = policy.abcWindowCycles;
  const minimumLockedCycles = policy.minimumAbcLockedCycles;
  const ranked = Object.values(states).map(state => {
    // RULE-05-006/RULE-06-003 — cửa sổ CỐ ĐỊNH 24 vị trí chu kỳ gần nhất theo lịch (RULE-05-006, giữ
    // nguyên mọi vị trí kể cả chưa khóa để audit), nhưng năm hóa chỉ dùng đoạn chu kỳ khóa LIÊN TIẾP
    // trong cửa sổ đó (RULE-06-003 — "không đếm các chu kỳ khóa nằm rải rác ở hai phía của một khoảng
    // unresolved như một đoạn liên tiếp"), tối thiểu 6 CK khóa liên tiếp mới được năm hóa.
    // Chu kỳ CHƯA khóa không bao giờ được cộng vào periodQuantity (calendarWindowAbcMetrics tự loại).
    const metrics = calendarWindowAbcMetrics(state.cycles, windowSize, minimumLockedCycles);
    const annualizationFactor = metrics.eligible ? windowSize / metrics.lockedCycleCount : null;
    const annualQuantity = annualizationFactor === null ? null : metrics.periodQuantity * annualizationFactor;
    const annualValue = annualQuantity === null ? 0 : annualQuantity * state.definition.price;
    if (!metrics.eligible) {
      exceptions.push({
        id: `${state.definition.id}:6:ABC_INPUT_BLOCKED`,
        ruleId: 'RULE-06-003', code: 'ABC_INPUT_BLOCKED', stage: 6, skuId: state.definition.id, date: null,
        evidence: `Cửa sổ ${windowSize} vị trí chu kỳ gần nhất theo lịch chỉ có ${metrics.lockedCycleCount}/${minimumLockedCycles} chu kỳ khóa tối thiểu (đã xét ${metrics.window.length} vị trí) — NOT_RATED, không được năm hóa.`,
        suggestedAction: 'Rà soát nguyên nhân các chu kỳ chưa khóa trong cửa sổ 24 chu kỳ gần nhất (Chặng 3–5) trước khi coi SKU là chưa đủ dữ liệu ABC.',
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
    }
    return { state, metrics, eligible: metrics.eligible, periodQuantity: metrics.periodQuantity, annualizationFactor, annualQuantity, annualValue };
  }).sort((a, b) => b.annualValue - a.annualValue);
  const total = ranked.filter(item => item.eligible).reduce((sum, item) => sum + item.annualValue, 0);
  let cumulative = 0;
  let rank = 0;
  for (const item of ranked) {
    const valueShare = item.eligible && total ? item.annualValue / total : 0;
    if (item.eligible) cumulative += item.annualValue;
    const cumulativeShare = item.eligible && total ? cumulative / total : 0;
    let abc: AbcClass = 'N/A';
    if (item.eligible) {
      rank++;
      abc = rank === 1 || cumulativeShare <= policy.abcThresholds.aMaxCumulativeShare ? 'A' : cumulativeShare >= policy.abcThresholds.cMinCumulativeShare ? 'C' : 'B';
    }
    // RULE-06-001/DEC-010 — ABC chỉ chính thức khi chạy toàn danh mục hoặc dùng snapshot đã duyệt.
    const abcOfficial = item.state.definition.portfolioMode === 'FULL_PORTFOLIO' || item.state.definition.portfolioMode === 'USE_APPROVED_SNAPSHOT';
    item.state.classification = {
      ...item.state.classification,
      abc,
      abcOfficial,
      approvalStatus: 'PROPOSED', // RULE-06-002 — hệ thống chỉ tự sinh PROPOSED; không có quy trình duyệt bền vững trong app này.
      abcStatus: !item.eligible ? 'not-rated' : item.metrics.fullCoverage ? 'full' : 'annualized',
      lockedCycles: item.metrics.lockedCycleCount,
      periodQuantity: item.periodQuantity,
      annualizationFactor: item.annualizationFactor,
      annualQuantity: item.annualQuantity,
      annualValue: item.annualValue,
      valueShare,
      cumulativeShare,
      abcRank: item.eligible ? rank : null,
    };
  }
  const officialCount = ranked.filter(item => item.state.classification.abcOfficial).length;
  const notRatedCount = ranked.filter(item => !item.eligible).length;
  const fullCoverageCount = ranked.filter(item => item.state.classification.abcStatus === 'full').length;
  const withGapsCount = ranked.filter(item => item.state.classification.abcStatus === 'annualized').length;
  return createSnapshot(6, policy, states, {
    'Nhóm A': ranked.filter(item => item.state.classification.abc === 'A').length, 'Nhóm B': ranked.filter(item => item.state.classification.abc === 'B').length,
    'Nhóm C': ranked.filter(item => item.state.classification.abc === 'C').length, 'Chưa xếp hạng': ranked.filter(item => item.state.classification.abc === 'N/A').length,
    'SKU ABC chính thức': officialCount, 'SKU chỉ xếp hạng mô phỏng': ranked.length - officialCount,
    [`FULL_COVERAGE (${windowSize}/${windowSize})`]: fullCoverageCount, 'ANNUALIZED_WITH_GAPS': withGapsCount, [`NOT_RATED (<${minimumLockedCycles} CK khóa)`]: notRatedCount,
  }, [
    'Điểm cắt C bắt đầu khi lũy kế đạt từ 90% trở lên.', 'Tính trên bảng xếp hạng riêng, không đổi thứ tự dữ liệu gốc.',
    `[RULE-06-001][DEC-010] ${officialCount}/${ranked.length} SKU có ABC chính thức (portfolioMode=FULL_PORTFOLIO/USE_APPROVED_SNAPSHOT); còn lại chỉ là xếp hạng trong tập mô phỏng hiện tại (SELECTED_SKU_SIMULATION), KHÔNG được dùng làm kết luận ABC vận hành thật.`,
    `[RULE-06-002] Mọi ABC ở đây đều approvalStatus='PROPOSED' — công cụ mô phỏng một lượt chạy này không có quy trình phê duyệt/lưu vết bền vững để tự chuyển EFFECTIVE.`,
    `[RULE-06-003][RULE-05-006] Cửa sổ ABC là ${windowSize} vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí (kể cả chưa khóa) để audit; đếm CK khóa bất kể khoảng khuyết, tối thiểu ${minimumLockedCycles} CK khóa mới năm hóa. ${fullCoverageCount} SKU FULL_COVERAGE, ${withGapsCount} SKU ANNUALIZED_WITH_GAPS (đủ ngưỡng nhưng có khoảng khuyết), ${notRatedCount} SKU NOT_RATED (dưới ${minimumLockedCycles} CK khóa, ABC_INPUT_BLOCKED).`,
  ], exceptions);
}
