// Chặng 15 §4–§8 — dò mức phục vụ thấp nhất vừa đủ đạt 4 điều kiện mô phỏng, ưu
// tiên phương pháp percentile độ lệch actual−forecast trong lead time (§5); chỉ
// fallback sang công thức Z×√(LT×σd²+D̄²×σLT²) (§6) khi thật sự thiếu dữ liệu.
import { buildForecastLearning } from './forecast-models';
import { demandRiskInputs } from './demand-risk';
import { mean, percentile, safetyStock as zFormulaSafetyStock } from './math';
import { Z_VALUES } from './policy';
import { SafetyStockAuditState, SafetyStockMethod, SafetyStockSourceTier, SimulationPolicy, SkuPipelineState } from './models';

function backtestErrorsOf(state: Readonly<SkuPipelineState>): number[] {
  const fit = buildForecastLearning(state);
  return fit.learning?.rows.filter(row => row.phase === 'test' && row.error !== null).map(row => row.error!) ?? [];
}

/** Gộp sai số theo cửa sổ ⌈ltCycles⌉ chu kỳ liên tiếp — xấp xỉ độ lệch tích lũy trong một vòng lead time. */
function rollingWindowDeviations(errors: readonly number[], windowCycles: number): number[] {
  const size = Math.max(1, Math.round(windowCycles));
  if (errors.length < size) return [];
  const windows: number[] = [];
  for (let start = 0; start + size <= errors.length; start++) {
    windows.push(errors.slice(start, start + size).reduce((sum, value) => sum + Math.abs(value), 0));
  }
  return windows;
}

function leadTimeDeviationSamples(
  state: Readonly<SkuPipelineState>,
  allStates: Readonly<Record<string, Readonly<SkuPipelineState>>>,
  policy: SimulationPolicy,
  ltCycles: number,
): { samples: number[]; sourceTier: SafetyStockSourceTier } {
  const own = rollingWindowDeviations(backtestErrorsOf(state), ltCycles);
  if (own.length >= policy.minimumLeadTimeWindows) return { samples: own, sourceTier: 'sku-history' };
  const cell = `${state.classification.abc}${state.classification.xyz}`;
  const siblingErrors = Object.values(allStates)
    .filter(sibling => sibling.definition.id !== state.definition.id && `${sibling.classification.abc}${sibling.classification.xyz}` === cell)
    .flatMap(sibling => backtestErrorsOf(sibling));
  const group = rollingWindowDeviations(siblingErrors, ltCycles);
  if (group.length >= policy.minimumLeadTimeWindows) return { samples: group, sourceTier: 'abc-xyz-group' };
  return { samples: [], sourceTier: 'policy-fallback' };
}

function evaluateCandidate(ssValue: number, samples: readonly number[], dBar: number, purchasePrice: number, policy: SimulationPolicy): { passed: boolean; failedConditions: string[] } {
  const failed: string[] = [];
  if (samples.length) {
    const shortageCap = samples.reduce((sum, sample) => sum + Math.max(0, sample - ssValue), 0);
    if (shortageCap > dBar) failed.push(`Điều kiện 1 — tổng thiếu hụt dự kiến (${shortageCap.toFixed(1)}) vượt nhu cầu bình quân một chu kỳ (${dBar.toFixed(1)}).`);
    const breachRate = samples.filter(sample => sample > ssValue).length / samples.length;
    if (breachRate > policy.maxLeadTimeBreachRate) failed.push(`Điều kiện 2 — tỷ lệ vượt tồn an toàn ${(breachRate * 100).toFixed(0)}% cao hơn ngưỡng ${(policy.maxLeadTimeBreachRate * 100).toFixed(0)}%.`);
  }
  if (ssValue > policy.safetyStockSurplusCapMultiplier * dBar) failed.push(`Điều kiện 3 — tồn an toàn (${ssValue.toFixed(1)}) vượt trần dư thừa ${policy.safetyStockSurplusCapMultiplier}×D̄.`);
  if (Number.isFinite(policy.safetyStockCapitalCapPerSku) && ssValue * purchasePrice > policy.safetyStockCapitalCapPerSku) failed.push('Điều kiện 4 — vốn khóa trong tồn an toàn vượt trần vốn cho phép của SKU.');
  return { passed: failed.length === 0, failedConditions: failed };
}

export interface SafetyStockChoice {
  audit: Omit<SafetyStockAuditState, 'formula'>;
  safetyStockValue: number | null;
}

/**
 * Dò mức phục vụ thấp nhất trong `policy.serviceLevelCandidates` (chỉ xét từ sàn
 * đã khóa ở Chặng 8 trở lên) vừa đủ đạt cả 4 điều kiện mô phỏng của §4. Không
 * mức nào đạt → giữ mức sàn Chặng 8, đánh dấu unfeasiblePolicy để Chặng 18 biết
 * mà chuyển duyệt, tuyệt đối không tự hạ mức phục vụ dưới sàn đã khóa.
 */
export function chooseSafetyStock(
  state: Readonly<SkuPipelineState>,
  allStates: Readonly<Record<string, Readonly<SkuPipelineState>>>,
  policy: SimulationPolicy,
): SafetyStockChoice | null {
  const risk = demandRiskInputs(state, policy);
  const hasDemandRisk = risk.sigmaDObservationCount >= 2;
  const hasLeadRisk = state.definition.leadTimeHistoryDays.length >= 2;
  if (!state.serviceLevel || !state.finalForecast.length || !hasDemandRisk || !hasLeadRisk) return null;

  const { samples, sourceTier } = leadTimeDeviationSamples(state, allStates, policy, risk.ltBarCycles);
  const method: SafetyStockMethod = sourceTier === 'policy-fallback' ? 'z-formula' : 'percentile';
  const sortedSamples = [...samples].sort((a, b) => a - b);

  const candidates = [...policy.serviceLevelCandidates]
    .filter(candidate => candidate >= state.serviceLevel! && Z_VALUES[candidate] !== undefined)
    .sort((a, b) => a - b);
  if (!candidates.length) candidates.push(state.serviceLevel);

  const search: { candidate: number; passed: boolean; failedConditions: string[] }[] = [];
  let chosen: { candidate: number; ssValue: number } | null = null;
  for (const candidate of candidates) {
    const z = Z_VALUES[candidate] ?? Z_VALUES[state.serviceLevel] ?? 0;
    const ssValue = method === 'percentile'
      ? Math.max(0, percentile(sortedSamples, candidate / 100))
      : Math.max(0, zFormulaSafetyStock(z, risk.dBar, risk.sigmaD, risk.ltBarCycles, risk.sigmaLtCycles));
    const evaluation = evaluateCandidate(ssValue, sortedSamples, risk.dBar, state.definition.purchasePrice, policy);
    search.push({ candidate, ...evaluation });
    if (evaluation.passed && !chosen) chosen = { candidate, ssValue };
  }

  const unfeasiblePolicy = chosen === null;
  const finalCandidate = chosen?.candidate ?? state.serviceLevel;
  const finalZ = Z_VALUES[finalCandidate] ?? 0;
  const safetyStockValue = chosen
    ? Math.ceil(chosen.ssValue)
    : method === 'percentile'
      ? Math.ceil(Math.max(0, percentile(sortedSamples, finalCandidate / 100)))
      : Math.ceil(Math.max(0, zFormulaSafetyStock(finalZ, risk.dBar, risk.sigmaD, risk.ltBarCycles, risk.sigmaLtCycles)));

  const displayMinimumStock = state.definition.displayMinimumStock;
  const protection = Math.max(safetyStockValue, displayMinimumStock);
  const maxProtectableCandidates = [state.definition.maxStock, state.definition.warehouseCapacity];
  if (state.definition.shelfLifeDays) maxProtectableCandidates.push(mean(state.finalForecast) * state.definition.shelfLifeDays / policy.cycleLength);
  const maxProtectable = maxProtectableCandidates.length ? Math.min(...maxProtectableCandidates) : null;
  const unmetProtection = maxProtectable !== null ? Math.max(0, protection - maxProtectable) : 0;

  return {
    safetyStockValue,
    audit: {
      z: finalZ, serviceLevel: finalCandidate, dBar: risk.dBar, sigmaD: risk.sigmaD,
      sigmaDSource: risk.sigmaDSource, sigmaDObservationCount: risk.sigmaDObservationCount,
      ltBarDays: risk.ltBarDays, sigmaLtDays: risk.sigmaLtDays, ltBarCycles: risk.ltBarCycles, sigmaLtCycles: risk.sigmaLtCycles,
      warnings: [],
      method, sourceTier, percentileSample: method === 'percentile' ? sortedSamples : null,
      serviceLevelSearch: search, unfeasiblePolicy,
      protection, maxProtectable, unmetProtection,
    },
  };
}
