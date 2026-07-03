import { calculateBias, calculateTrend, calculateWape, detectPulse, mean } from './math';
import { ForecastResult, SkuPipelineState, XyzClass } from './models';

/**
 * Cài đặt các mô hình dự báo nền của Chặng 11 theo đúng Developer Spec [C11]:
 * - SES §5, Holt §6, Holt-Winters §7 (m=24), Croston §8.5, Nhịp phát sinh §8.6.
 * - Chia TRAIN/TEST theo thời gian (P24 = 20% cuối, tối thiểu 1 CK); tham số chỉ tối ưu
 *   bằng Grid Search trên TRAIN (thô 0,1→0,9 rồi tinh chỉnh quanh điểm tốt nhất);
 *   backtest one-step-ahead trên TEST bằng chính mô hình đã khóa tham số.
 * - Toàn bộ diễn biến học từng chu kỳ (L/T/S/F hoặc Z/P/F) được trả về để giao diện soi.
 */

export const FORECAST_HORIZON = 6;
const SEASON_LENGTH = 24;
const TREND_CAP = 0.15; // C10 §6: giới hạn an toàn xu hướng khi dự phóng

export type LearningPhase = 'init' | 'train' | 'test';

export interface LearningRow {
  index: number; // thứ tự chu kỳ 1-based trong chuỗi khóa
  actual: number;
  phase: LearningPhase;
  level: number | null;  // L (SES/Holt/HW) hoặc Z (Croston)
  trend: number | null;  // T (Holt/HW) hoặc P (Croston)
  season: number | null; // S dùng cho dự báo (Holt-Winters)
  forecast: number | null; // F one-step-ahead
  error: number | null;    // Y − F
}

export interface ModelLearning {
  model: ForecastResult['model'];
  params: Record<string, number>;
  rows: LearningRow[];
  trainSize: number;
  testSize: number;
  future: number[];
  rmse: number | null;
  nrmse: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  missedPulses: number;
  falsePulses: number;
  wapePositive: number | null;
  levelLabel: string | null;
  trendLabel: string | null;
  seasonLabel: string | null;
  note: string;
}

export interface ForecastFit {
  result: ForecastResult;
  learning: ModelLearning | null;
}

interface ModelRun {
  rows: LearningRow[];
  future: number[];
  trainSse: number;
}

function splitSizes(n: number): { trainSize: number; testSize: number } {
  const testSize = Math.max(1, Math.floor(n * 0.2));
  return { trainSize: n - testSize, testSize };
}

function phaseOf(index: number, trainSize: number): LearningPhase {
  return index < trainSize ? 'train' : 'test';
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function testMetrics(rows: LearningRow[], trainSize: number): Pick<ModelLearning, 'rmse' | 'nrmse' | 'wape' | 'bias' | 'hitRate' | 'missedPulses' | 'falsePulses' | 'wapePositive'> {
  const testRows = rows.filter(row => row.phase === 'test');
  if (!testRows.length || testRows.every(row => row.forecast === null)) return { rmse: null, nrmse: null, wape: null, bias: null, hitRate: null, missedPulses: 0, falsePulses: 0, wapePositive: null };
  const actual = testRows.map(row => row.actual);
  const forecast = testRows.map(row => row.forecast ?? 0);
  const errors = actual.map((value, index) => value - forecast[index]);
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  const actualMean = mean(actual);
  const actualPulseCount = actual.filter(value => value > 0).length;
  const hitCount = actual.filter((value, index) => value > 0 && forecast[index] > 0).length;
  const missedPulses = actual.filter((value, index) => value > 0 && forecast[index] <= 0).length;
  const falsePulses = actual.filter((value, index) => value <= 0 && forecast[index] > 0).length;
  const positiveActual = actual.filter(value => value > 0);
  const positiveForecast = forecast.filter((_, index) => actual[index] > 0);
  return {
    rmse, nrmse: actualMean > 0 ? rmse / actualMean : null,
    wape: calculateWape(actual, forecast), bias: calculateBias(actual, forecast),
    hitRate: actualPulseCount ? hitCount / actualPulseCount : null,
    missedPulses, falsePulses, wapePositive: calculateWape(positiveActual, positiveForecast),
  };
}

/** Grid Search thô 0,1→0,9 bước 0,1 rồi tinh chỉnh ±0,05 bước 0,01 quanh điểm tốt nhất [C11 §4]. */
function gridSearch(evaluate: (alpha: number) => number): number {
  let best = 0.1;
  let bestSse = Infinity;
  for (let alpha = 0.1; alpha <= 0.91; alpha += 0.1) {
    const sse = evaluate(Number(alpha.toFixed(2)));
    if (sse < bestSse) { bestSse = sse; best = Number(alpha.toFixed(2)); }
  }
  for (let alpha = best - 0.05; alpha <= best + 0.051; alpha += 0.01) {
    const candidate = Number(Math.min(0.99, Math.max(0.01, alpha)).toFixed(2));
    const sse = evaluate(candidate);
    if (sse < bestSse) { bestSse = sse; best = candidate; }
  }
  return best;
}

// ── SES [C11 §5]: L₁=Y₁; F_t=L_{t−1}; L_t=αY_t+(1−α)L_{t−1}; F_{t+k}=L_t ──
function runSes(values: readonly number[], alpha: number, trainSize: number): ModelRun {
  const rows: LearningRow[] = [];
  let level = values[0];
  let trainSse = 0;
  rows.push({ index: 1, actual: values[0], phase: 'init', level, trend: null, season: null, forecast: null, error: null });
  for (let t = 1; t < values.length; t++) {
    const forecast = level;
    const error = values[t] - forecast;
    if (t < trainSize) trainSse += error ** 2;
    level = alpha * values[t] + (1 - alpha) * level;
    rows.push({ index: t + 1, actual: values[t], phase: phaseOf(t, trainSize), level, trend: null, season: null, forecast, error });
  }
  return { rows, future: Array(FORECAST_HORIZON).fill(clampNonNegative(level)), trainSse };
}

function fitSes(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
  const alpha = gridSearch(a => runSes(values, a, trainSize).trainSse);
  return { run: runSes(values, alpha, trainSize), params: { alpha } };
}

// ── Holt [C11 §6]: L₂=Y₂; T₂=Y₂−Y₁; F_t=L_{t−1}+T_{t−1}; F_{t+k}=L_t+kT_t (chặn xu hướng 15%) ──
function runHolt(values: readonly number[], alpha: number, beta: number, trainSize: number): ModelRun {
  const rows: LearningRow[] = [];
  let level = values[1];
  let trend = values[1] - values[0];
  let trainSse = 0;
  rows.push({ index: 1, actual: values[0], phase: 'init', level: null, trend: null, season: null, forecast: null, error: null });
  rows.push({ index: 2, actual: values[1], phase: 'init', level, trend, season: null, forecast: null, error: null });
  for (let t = 2; t < values.length; t++) {
    const forecast = level + trend;
    const error = values[t] - forecast;
    if (t < trainSize) trainSse += error ** 2;
    const nextLevel = alpha * values[t] + (1 - alpha) * (level + trend);
    trend = beta * (nextLevel - level) + (1 - beta) * trend;
    level = nextLevel;
    rows.push({ index: t + 1, actual: values[t], phase: phaseOf(t, trainSize), level, trend, season: null, forecast, error });
  }
  const cappedTrend = Math.max(-TREND_CAP * Math.abs(level), Math.min(TREND_CAP * Math.abs(level), trend));
  const future = Array.from({ length: FORECAST_HORIZON }, (_, k) => clampNonNegative(level + (k + 1) * cappedTrend));
  return { rows, future, trainSse };
}

function fitHolt(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
  let best = { alpha: 0.1, beta: 0.1 };
  let bestSse = Infinity;
  const consider = (alpha: number, beta: number) => {
    if (beta > alpha) return; // ràng buộc β ≤ α [C11 §4]
    const a = Number(Math.min(0.99, Math.max(0.01, alpha)).toFixed(2));
    const b = Number(Math.min(0.99, Math.max(0.01, beta)).toFixed(2));
    const sse = runHolt(values, a, b, trainSize).trainSse;
    if (sse < bestSse) { bestSse = sse; best = { alpha: a, beta: b }; }
  };
  for (let alpha = 0.1; alpha <= 0.91; alpha += 0.1) for (let beta = 0.1; beta <= 0.91; beta += 0.1) consider(alpha, beta);
  const coarse = best;
  for (let da = -0.04; da <= 0.041; da += 0.02) for (let db = -0.04; db <= 0.041; db += 0.02) consider(coarse.alpha + da, coarse.beta + db);
  return { run: runHolt(values, best.alpha, best.beta, trainSize), params: best };
}

// ── Holt-Winters nhân tính [C11 §7]: m=24; Sᵢ=Yᵢ/mean(mùa 1); L_{m+1}=Y_{m+1}/S₁ ──
function runHoltWinters(values: readonly number[], alpha: number, beta: number, gamma: number, trainSize: number): ModelRun | null {
  const m = SEASON_LENGTH;
  if (values.length < m + 2 || trainSize < m + 2) return null;
  const seasonBase = mean(values.slice(0, m));
  if (seasonBase <= 0) return null;
  const seasonal: number[] = values.slice(0, m).map(value => value / seasonBase);
  const rows: LearningRow[] = seasonal.map((season, index) => ({
    index: index + 1, actual: values[index], phase: 'init', level: null, trend: null, season, forecast: null, error: null,
  }));
  const s1 = seasonal[0] > 0 ? seasonal[0] : 1;
  const sm = seasonal[m - 1] > 0 ? seasonal[m - 1] : 1;
  let level = values[m] / s1;
  let trend = values[m] / s1 - values[m - 1] / sm;
  seasonal.push(seasonal[0]); // S tại t=m+1 kế thừa vị trí 1
  rows.push({ index: m + 1, actual: values[m], phase: 'init', level, trend, season: seasonal[0], forecast: null, error: null });
  let trainSse = 0;
  for (let t = m + 1; t < values.length; t++) {
    const seasonIndex = seasonal[t - m] > 0 ? seasonal[t - m] : 1;
    const forecast = (level + trend) * seasonIndex;
    const error = values[t] - forecast;
    if (t < trainSize) trainSse += error ** 2;
    const nextLevel = alpha * (values[t] / seasonIndex) + (1 - alpha) * (level + trend);
    trend = beta * (nextLevel - level) + (1 - beta) * trend;
    level = nextLevel;
    seasonal.push(level > 0 ? gamma * (values[t] / level) + (1 - gamma) * seasonIndex : seasonIndex);
    rows.push({ index: t + 1, actual: values[t], phase: phaseOf(t, trainSize), level, trend, season: seasonIndex, forecast, error });
  }
  const cappedTrend = Math.max(-TREND_CAP * Math.abs(level), Math.min(TREND_CAP * Math.abs(level), trend));
  const future = Array.from({ length: FORECAST_HORIZON }, (_, k) => {
    const season = seasonal[values.length + k - m];
    return clampNonNegative((level + (k + 1) * cappedTrend) * (season > 0 ? season : 1));
  });
  return { rows, future, trainSse };
}

function fitHoltWinters(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } | null {
  let best: { alpha: number; beta: number; gamma: number } | null = null;
  let bestSse = Infinity;
  for (let alpha = 0.1; alpha <= 0.91; alpha += 0.1) {
    for (let beta = 0.1; beta <= alpha + 0.001; beta += 0.1) { // β ≤ α
      for (let gamma = 0.1; gamma <= 0.91; gamma += 0.1) {
        const a = Number(alpha.toFixed(1)), b = Number(beta.toFixed(1)), g = Number(gamma.toFixed(1));
        const run = runHoltWinters(values, a, b, g, trainSize);
        if (run && run.trainSse < bestSse) { bestSse = run.trainSse; best = { alpha: a, beta: b, gamma: g }; }
      }
    }
  }
  if (!best) return null;
  const run = runHoltWinters(values, best.alpha, best.beta, best.gamma, trainSize)!;
  return { run, params: best };
}

// ── Croston [C11 §8.5]: Z=Y lần 1; P₁=t₂−t₁; F=null trước khi đủ 2 lần phát sinh ──
function runCroston(values: readonly number[], alpha: number, trainSize: number): ModelRun {
  const rows: LearningRow[] = [];
  let size: number | null = null;
  let interval: number | null = null;
  let forecast: number | null = null;
  let lastEventIndex = -1;
  let trainSse = 0;
  for (let t = 0; t < values.length; t++) {
    const rowForecast = forecast;
    const error = rowForecast === null ? null : values[t] - rowForecast;
    if (error !== null && t < trainSize) trainSse += error ** 2;
    if (values[t] > 0) {
      if (size === null) {
        size = values[t]; // khởi tạo Z tại lần phát sinh đầu tiên
      } else if (interval === null) {
        interval = t - lastEventIndex; // P₁ = t₂ − t₁, KHÔNG dùng khoảng cách từ đầu chuỗi
        size = alpha * values[t] + (1 - alpha) * size;
        forecast = size / interval;
      } else {
        size = alpha * values[t] + (1 - alpha) * size;
        interval = alpha * (t - lastEventIndex) + (1 - alpha) * interval;
        forecast = size / interval;
      }
      lastEventIndex = t;
    }
    rows.push({
      index: t + 1, actual: values[t],
      phase: forecast === null && rowForecast === null ? 'init' : phaseOf(t, trainSize),
      level: size, trend: interval, season: null, forecast: rowForecast, error,
    });
  }
  return { rows, future: Array(FORECAST_HORIZON).fill(clampNonNegative(forecast ?? 0)), trainSse };
}

function fitCroston(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
  const alpha = gridSearch(a => runCroston(values, a, trainSize).trainSse);
  return { run: runCroston(values, alpha, trainSize), params: { alpha } };
}

// ── Nhịp phát sinh [C11 §8.6]: D=khoảng cách đều; Q=Median quy mô; F=Q khi (t−t_r) mod D = 0 ──
function runPulse(values: readonly number[], intervalD: number, quantityQ: number, trainSize: number): ModelRun {
  const firstEvent = values.findIndex(value => value > 0);
  const rows: LearningRow[] = [];
  for (let t = 0; t < values.length; t++) {
    const predictable = t > firstEvent;
    const forecast = predictable ? ((t - firstEvent) % intervalD === 0 ? quantityQ : 0) : null;
    rows.push({
      index: t + 1, actual: values[t], phase: predictable ? phaseOf(t, trainSize) : 'init',
      level: null, trend: null, season: null, forecast, error: forecast === null ? null : values[t] - forecast,
    });
  }
  const lastEvent = values.reduce((last, value, index) => (value > 0 ? index : last), -1);
  const future = Array.from({ length: FORECAST_HORIZON }, (_, k) => {
    const futureIndex = values.length + k;
    return (futureIndex - lastEvent) % intervalD === 0 ? quantityQ : 0;
  });
  return { rows, future, trainSse: 0 };
}

function lockStatusFrom(wape: number | null, bias: number | null): ForecastResult['lockStatus'] {
  if (wape === null || bias === null) return 'exception';
  // Tài liệu không ban hành giá trị ngưỡng P25 chính thức. Không được dùng ngưỡng tự đặt để khóa tự động.
  return 'review';
}

function buildLearning(
  model: ForecastResult['model'], params: Record<string, number>, run: ModelRun,
  trainSize: number, testSize: number, note: string,
): ModelLearning {
  const metrics = testMetrics(run.rows, trainSize);
  const labels: Record<string, [string | null, string | null, string | null]> = {
    SES: ['L · mức nền', null, null],
    Holt: ['L · mức nền', 'T · xu hướng', null],
    'Holt-Winters': ['L · mức nền', 'T · xu hướng', 'S · mùa vụ'],
    Croston: ['Z · quy mô', 'P · khoảng cách', null],
    PulseRhythm: [null, null, null],
    PurchasePlan: [null, null, null],
  };
  const [levelLabel, trendLabel, seasonLabel] = labels[model];
  return { model, params, rows: run.rows, trainSize, testSize, future: run.future, ...metrics, levelLabel, trendLabel, seasonLabel, note };
}

function toFit(learning: ModelLearning, reason: string): ForecastFit {
  return {
    learning,
    result: {
      model: learning.model,
      params: learning.params,
      baseForecast: learning.future,
      rmse: learning.rmse,
      nrmse: learning.nrmse,
      wape: learning.wape,
      bias: learning.bias,
      hitRate: learning.hitRate,
      missedPulses: learning.missedPulses,
      falsePulses: learning.falsePulses,
      wapePositive: learning.wapePositive,
      lockStatus: lockStatusFrom(learning.wape, learning.bias),
      reason,
    },
  };
}

/**
 * Chọn nhánh mô hình CHỈ từ đầu ra đã khóa của Chặng 7/9/10 [C11 §3] rồi fit theo spec.
 * Hàm thuần và tất định: engine và giao diện gọi chung để không bao giờ lệch số.
 */
export function fitBaseForecast(
  values: readonly number[],
  xyz: XyzClass,
  seasonality: SkuPipelineState['seasonality'],
  trend: SkuPipelineState['trend'],
): ForecastFit {
  if (xyz === 'D' || !values.length) {
    return {
      learning: null,
      result: {
        model: 'PurchasePlan', params: {}, baseForecast: [],
        rmse: null, nrmse: null, wape: null, bias: null, hitRate: null, missedPulses: 0, falsePulses: 0, wapePositive: null,
        lockStatus: 'exception', reason: 'Nhóm D chưa có kế hoạch Thu mua hoặc SKU tương tự đã được duyệt; không tự phát hành dự báo.',
      },
    };
  }
  const { trainSize, testSize } = splitSizes(values.length);

  if (xyz === 'Z') {
    const pulse = detectPulse(values);
    if (pulse.ready) {
      const learning = buildLearning('PulseRhythm', { D: pulse.interval!, Q: pulse.quantity! }, runPulse(values, pulse.interval!, pulse.quantity!, trainSize), trainSize, testSize, `Khoảng cách phát sinh đều D = ${pulse.interval}; quy mô Q = Median = ${pulse.quantity}.`);
      return toFit(learning, 'Nhóm Z, nhịp phát sinh ổn định → mô hình nhịp [C11 §8.6].');
    }
    const { run, params } = fitCroston(values, trainSize);
    const learning = buildLearning('Croston', params, run, trainSize, testSize, `α = ${params['alpha']} chọn bằng Grid Search trên TRAIN; F = Z/P là bình quân mỗi chu kỳ.`);
    return toFit(learning, 'Nhóm Z, khoảng cách phát sinh không đều → Croston bình quân [C11 §8.5].');
  }

  if (xyz === 'Y' && seasonality === 'confirmed') {
    const hw = fitHoltWinters(values, trainSize);
    if (hw) {
      const learning = buildLearning('Holt-Winters', hw.params, hw.run, trainSize, testSize, `m = 24; α/β/γ chọn bằng Grid Search trên TRAIN (β ≤ α).`);
      return toFit(learning, 'Nhóm Y có mùa vụ đủ căn cứ (C9) → Holt-Winters [C11 §7].');
    }
    const ses = fitSes(values, trainSize);
    const learning = buildLearning('SES', ses.params, ses.run, trainSize, testSize, `Chuỗi chưa đủ 2 vòng cho Holt-Winters → fallback SES với α = ${ses.params['alpha']}.`);
    return toFit(learning, 'Mùa vụ xác nhận nhưng chuỗi TRAIN chưa đủ m+2 → fallback SES.');
  }

  if (xyz === 'Y' && (trend === 'up' || trend === 'down') && values.length >= 3) {
    const holt = fitHolt(values, trainSize);
    const learning = buildLearning('Holt', holt.params, holt.run, trainSize, testSize, `α = ${holt.params['alpha']}, β = ${holt.params['beta']} (β ≤ α) chọn bằng Grid Search trên TRAIN.`);
    return toFit(learning, `Nhóm Y có xu hướng ${trend === 'up' ? 'tăng' : 'giảm'} (C10) → Holt [C11 §6].`);
  }

  const ses = fitSes(values, trainSize);
  if (xyz === 'X' && values.length >= 3) {
    const localTrend = calculateTrend(values);
    if (localTrend.trend === 'up' || localTrend.trend === 'down') {
      const holt = fitHolt(values, trainSize);
      const holtLearning = buildLearning('Holt', holt.params, holt.run, trainSize, testSize, `α = ${holt.params['alpha']}, β = ${holt.params['beta']}; Holt thắng SES khi WAPE backtest thấp hơn.`);
      const sesLearning = buildLearning('SES', ses.params, ses.run, trainSize, testSize, '');
      if (holtLearning.wape !== null && (sesLearning.wape === null || holtLearning.wape < sesLearning.wape)) {
        return toFit(holtLearning, `Nhóm X có xu hướng (thuật toán C10) và backtest Holt (WAPE ${(holtLearning.wape * 100).toFixed(1)}%) tốt hơn SES → Holt [C11 §3].`);
      }
      const learning = buildLearning('SES', ses.params, ses.run, trainSize, testSize, `α = ${ses.params['alpha']}; Holt không thắng backtest nên giữ SES.`);
      return toFit(learning, 'Nhóm X có xu hướng nhưng Holt không tốt hơn SES trên TEST → SES [C11 §3].');
    }
  }
  const learning = buildLearning('SES', ses.params, ses.run, trainSize, testSize, `α = ${ses.params['alpha']} chọn bằng Grid Search thô 0,1→0,9 rồi tinh chỉnh bước 0,01.`);
  return toFit(learning, xyz === 'X' ? 'Nhóm X không có xu hướng rõ → SES nền ổn định [C11 §3].' : 'Nhóm Y không mùa vụ, không xu hướng → SES nền ổn định [C11 §3].');
}

/** Chuỗi khóa ĐẦY ĐỦ cho Chặng 11 (khác cửa sổ 24 CK của C6/C7 — Holt-Winters cần ≥ 2 vòng). */
export function lockedSeriesAll(state: Readonly<SkuPipelineState>): number[] {
  return state.cycles.filter(cycle => cycle.locked).map(cycle => cycle.baseDemand);
}

/** Dựng lại toàn bộ diễn biến học của SKU đang chọn — cùng hàm với engine nên khớp số tuyệt đối. */
export function buildForecastLearning(state: Readonly<SkuPipelineState>): ForecastFit {
  return fitBaseForecast(lockedSeriesAll(state), state.classification.xyz, state.seasonality, state.trend);
}
