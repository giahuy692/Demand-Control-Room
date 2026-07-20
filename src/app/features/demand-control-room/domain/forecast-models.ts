import { calculateBias, calculateTrend, calculateWape, detectPulse, detectShortCycle, mean, trailingLockedRun } from './math';
import { ForecastResult, SimulationPolicy, SkuPipelineState, XyzClass } from './models';
import { DEFAULT_FORECAST_MODEL_REGISTRY, ForecastModelRegistry } from '../forecasting/forecast-model-registry.service';
import { ForecastEligibilityContext, ForecastInput, RegisteredForecastModel } from '../forecasting/forecast-model-strategy.interface';

/**
 * Cài đặt các mô hình dự báo nền của Chặng 11 theo đúng Tài liệu giải pháp [C11]:
 * - SES §5, Holt §6, Holt-Winters §7 (m=24), Seasonal-naïve §8 (nhánh 11XY-SN),
 *   Croston và nhịp phát sinh mục 9 (nhóm Z).
 * - Chia TRAIN/TEST theo thời gian (P24 = 20% cuối, tối thiểu 1 CK); tham số chỉ tối ưu
 *   bằng Grid Search trên TRAIN (thô rồi tinh chỉnh quanh điểm tốt nhất [§4.4];
 *   SES kẹp 0,05–0,5 [§5.5]; β ≤ α, γ ≤ 1−α [§4.2]);
 *   backtest one-step-ahead trên TEST bằng chính mô hình đã khóa tham số.
 * - Quy tắc thắng [§4.3 bước 7]: Holt phải thắng SES; Holt-Winters phải thắng Holt/SES;
 *   Seasonal-naïve phải thắng mô hình đang thắng; thua → fallback [§4.5].
 * - Toàn bộ diễn biến học từng chu kỳ (L/T/S/F hoặc Z/P/F) được trả về để giao diện soi.
 */

export const FORECAST_HORIZON = 6;
export const SEASON_LENGTH = 24;
const TREND_CAP = 0.15; // C10 §6: giới hạn an toàn xu hướng khi dự phóng

export type ForecastWindowPolicy = SimulationPolicy['forecastWindowCycles'];

/** DEC-P11 — bản sao mặc định của SimulationPolicy.forecastWindowCycles, dùng khi caller không
 * truyền policy riêng (test thuần, các nơi chỉ dựng lại diễn biến học để hiển thị). Cùng số với
 * DEFAULT_POLICY trong policy.ts — xem chú thích đầy đủ tại models.ts SimulationPolicy.forecastWindowCycles. */
export const DEFAULT_FORECAST_WINDOW_CYCLES: ForecastWindowPolicy = {
  ses: { min: 12, reliable: 18 },
  holt: { min: 15, reliable: 24 },
  holtWinters: { minSeasons: 2, reliableSeasons: 3 },
  croston: { min: 24, reliable: 48 },
};

export type ForecastWindowModel = 'SES' | 'Holt' | 'Holt-Winters' | 'Croston' | 'PulseRhythm';

export interface ModelWindow {
  readonly values: number[];
  readonly trainSize: number;
  readonly testSize: number;
  readonly reliability: 'ok' | 'low';
  readonly usedCycles: number;
  readonly totalCycles: number;
}

/**
 * DEC-P11 — cửa sổ lịch sử riêng cho từng mô hình, đếm NGƯỢC từ chu kỳ gần nhất:
 * `usedCycles = min(totalCycles, reliable)` — cắt bớt nếu lịch sử dài hơn mức tin cậy, KHÔNG bao giờ
 * kéo dài thêm nếu lịch sử ngắn hơn. Dưới `min` vẫn cho chạy (không chặn SKU chỉ vì thiếu lịch sử,
 * đúng nguyên tắc bucket-(c)) nhưng gắn `reliability:'low'` để tầng hiển thị/quyết định biết không nên
 * tự động khóa. SeasonalNaive (cửa chu kỳ ngắn 11XY-SN) KHÔNG dùng hàm này — nó vẫn so sánh trên đúng
 * cửa sổ của mô hình đối chứng đang thắng, giữ nguyên cơ chế thắng/thua hiện có.
 */
export function windowForModel(model: ForecastWindowModel, fullValues: readonly number[], windowPolicy: ForecastWindowPolicy = DEFAULT_FORECAST_WINDOW_CYCLES): ModelWindow {
  const totalCycles = fullValues.length;
  const { min, reliable } = model === 'SES' ? windowPolicy.ses
    : model === 'Holt' ? windowPolicy.holt
    : model === 'Holt-Winters' ? { min: windowPolicy.holtWinters.minSeasons * SEASON_LENGTH, reliable: windowPolicy.holtWinters.reliableSeasons * SEASON_LENGTH }
    : windowPolicy.croston; // Croston và PulseRhythm dùng chung cửa sổ Z.
  const usedCycles = Math.min(totalCycles, reliable);
  const values = fullValues.slice(-usedCycles);
  const { trainSize, testSize } = splitSizes(values.length);
  const reliability: 'ok' | 'low' = totalCycles >= min && testSize >= 3 ? 'ok' : 'low';
  return { values, trainSize, testSize, reliability, usedCycles, totalCycles };
}

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

export interface ModelRun {
  rows: LearningRow[];
  future: number[];
  trainSse: number;
}

export function splitSizes(n: number): { trainSize: number; testSize: number } {
  const testSize = Math.max(1, Math.floor(n * 0.2));
  return { trainSize: n - testSize, testSize };
}

function phaseOf(index: number, trainSize: number): LearningPhase {
  return index < trainSize ? 'train' : 'test';
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

export function testMetrics(rows: LearningRow[]): Pick<ModelLearning, 'rmse' | 'nrmse' | 'wape' | 'bias' | 'hitRate' | 'missedPulses' | 'falsePulses' | 'wapePositive'> {
  const testRows = rows.filter(row => row.phase === 'test');
  // Chỉ tiêu nhịp đếm trên MỌI chu kỳ TEST: có nhu cầu mà mô hình không có dự báo dương vẫn là missed.
  const actualPulseCount = testRows.filter(row => row.actual > 0).length;
  const hitCount = testRows.filter(row => row.actual > 0 && (row.forecast ?? 0) > 0).length;
  const missedPulses = testRows.filter(row => row.actual > 0 && (row.forecast ?? 0) <= 0).length;
  const falsePulses = testRows.filter(row => row.actual <= 0 && (row.forecast ?? 0) > 0).length;
  const hitRate = actualPulseCount ? hitCount / actualPulseCount : null;
  // Sai số liên tục chỉ đo trên chu kỳ mô hình THỰC SỰ có dự báo (F = null ≠ F = 0 —
  // Croston/nhịp bị cấm phát dự báo trước khi đủ căn cứ, không được phạt như dự báo 0).
  const scoredRows = testRows.filter(row => row.forecast !== null);
  if (!scoredRows.length) return { rmse: null, nrmse: null, wape: null, bias: null, hitRate, missedPulses, falsePulses, wapePositive: null };
  const actual = scoredRows.map(row => row.actual);
  const forecast = scoredRows.map(row => row.forecast!);
  const errors = actual.map((value, index) => value - forecast[index]);
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  const actualMean = mean(actual);
  const positiveActual = actual.filter(value => value > 0);
  const positiveForecast = forecast.filter((_, index) => actual[index] > 0);
  return {
    rmse, nrmse: actualMean > 0 ? rmse / actualMean : null,
    wape: calculateWape(actual, forecast), bias: calculateBias(actual, forecast),
    hitRate, missedPulses, falsePulses, wapePositive: calculateWape(positiveActual, positiveForecast),
  };
}

/** Grid Search thô bước 0,1 rồi tinh chỉnh ±0,05 bước 0,01 quanh điểm tốt nhất [C11 §4.4]. */
function gridSearch(evaluate: (alpha: number) => number, lo = 0.1, hi = 0.9, clampLo = 0.01, clampHi = 0.99): number {
  let best = lo;
  let bestSse = Infinity;
  for (let alpha = lo; alpha <= hi + 0.001; alpha += 0.1) {
    const sse = evaluate(Number(alpha.toFixed(2)));
    if (sse < bestSse) { bestSse = sse; best = Number(alpha.toFixed(2)); }
  }
  for (let alpha = best - 0.05; alpha <= best + 0.051; alpha += 0.01) {
    const candidate = Number(Math.min(clampHi, Math.max(clampLo, alpha)).toFixed(2));
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

export function fitSes(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
  // Ràng buộc riêng của SES: 0,05 ≤ α ≤ 0,5 [C11 §5.5] — hẹp hơn miền vận hành chung 0,1→0,9 của §4.8.
  const alpha = gridSearch(a => runSes(values, a, trainSize).trainSse, 0.1, 0.5, 0.05, 0.5);
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

export function fitHolt(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
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

export function fitHoltWinters(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } | null {
  let best: { alpha: number; beta: number; gamma: number } | null = null;
  let bestSse = Infinity;
  for (let alpha = 0.1; alpha <= 0.91; alpha += 0.1) {
    for (let beta = 0.1; beta <= alpha + 0.001; beta += 0.1) { // β ≤ α [C11 §4.2]
      for (let gamma = 0.1; gamma <= 1 - alpha + 0.001 && gamma <= 0.91; gamma += 0.1) { // γ ≤ 1 − α [C11 §4.2]
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

export function fitCroston(values: readonly number[], trainSize: number): { run: ModelRun; params: Record<string, number> } {
  const alpha = gridSearch(a => runCroston(values, a, trainSize).trainSse);
  return { run: runCroston(values, alpha, trainSize), params: { alpha } };
}

// ── Nhịp phát sinh [C11 §8.6]: D=khoảng cách đều; Q=Median quy mô; F=Q khi (t−t_r) mod D = 0 ──
export function runPulse(values: readonly number[], intervalD: number, quantityQ: number, trainSize: number): ModelRun {
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

// ── Seasonal-naïve [C11 §8]: Fₜ = Yₜ₋ₚ; p* dò bằng tương quan Pearson trên TRAIN [§8.5]; tương lai lặp mẫu p* giá trị cuối [§8.9] ──
export function runSeasonalNaive(values: readonly number[], period: number, trainSize: number): ModelRun {
  const rows: LearningRow[] = [];
  let trainSse = 0;
  for (let t = 0; t < values.length; t++) {
    const forecast = t >= period ? values[t - period] : null;
    const error = forecast === null ? null : values[t] - forecast;
    if (error !== null && t < trainSize) trainSse += error ** 2;
    rows.push({
      // "season" bị tái dùng để lưu số thứ tự chu kỳ NGUỒN (1-based) mà F sao chép sang —
      // hiển thị thẳng trong bảng học thay vì chỉ lộ ra khi hover ô F [C11 §8.9/§8.12].
      index: t + 1, actual: values[t], phase: forecast === null ? 'init' : phaseOf(t, trainSize),
      level: null, trend: null, season: forecast === null ? null : t + 1 - period, forecast, error,
    });
  }
  const future: number[] = [];
  for (let k = 0; k < FORECAST_HORIZON; k++) {
    const sourceIndex = values.length + k - period;
    future.push(clampNonNegative(sourceIndex < values.length ? values[sourceIndex] : future[sourceIndex - values.length]));
  }
  return { rows, future, trainSse };
}

/** Chu kỳ nguồn (1-based) được sao chép cho từng F tương lai: F₁₃ = Y₉… [C11 §8.12]. */
function seasonalNaiveFutureSources(historyLength: number, period: number): number[] {
  return Array.from({ length: FORECAST_HORIZON }, (_, k) => {
    let source = historyLength + k - period;
    while (source >= historyLength) source -= period; // truy về đúng chu kỳ lịch sử gốc của mẫu lặp
    return source + 1;
  });
}

function lockStatusFrom(wape: number | null, bias: number | null): ForecastResult['lockStatus'] {
  if (wape === null || bias === null) return 'exception';
  // Tài liệu không ban hành giá trị ngưỡng P25 chính thức. Không được dùng ngưỡng tự đặt để khóa tự động.
  return 'review';
}

export function buildLearning(
  model: ForecastResult['model'], params: Record<string, number>, run: ModelRun,
  trainSize: number, testSize: number, note: string,
): ModelLearning {
  const metrics = testMetrics(run.rows);
  const labels: Record<string, [string | null, string | null, string | null]> = {
    SES: ['L · mức nền', null, null],
    Holt: ['L · mức nền', 'T · xu hướng', null],
    'Holt-Winters': ['L · mức nền', 'T · xu hướng', 'S · mùa vụ'],
    Croston: ['Z · quy mô', 'P · khoảng cách', null],
    SeasonalNaive: [null, null, 'Nguồn F · CK'],
    PulseRhythm: [null, null, null],
    PurchasePlan: [null, null, null],
  };
  const [levelLabel, trendLabel, seasonLabel] = labels[model];
  return { model, params, rows: run.rows, trainSize, testSize, future: run.future, ...metrics, levelLabel, trendLabel, seasonLabel, note };
}

interface FitExtras {
  rpScan?: ForecastResult['rpScan'];
  pStar?: number | null;
  controlModel?: ForecastResult['controlModel'];
  controlWape?: number | null;
  reliability?: ForecastResult['reliability'];
  futureSources?: number[] | null;
}

function toFit(learning: ModelLearning, reason: string, extras: FitExtras = {}): ForecastFit {
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
      rpScan: extras.rpScan ?? null,
      pStar: extras.pStar ?? null,
      controlModel: extras.controlModel ?? null,
      controlWape: extras.controlWape ?? null,
      reliability: extras.reliability ?? 'ok',
      futureSources: extras.futureSources ?? null,
    },
  };
}

const LOW_CONFIDENCE_FLAG = 'ĐỘ TIN CẬY THẤP — KHÔNG DÙNG ĐỂ SO MÔ HÌNH TỰ ĐỘNG';

function pct(wape: number | null): string {
  return wape === null ? '—' : `${(wape * 100).toFixed(1)}%`;
}

/**
 * Chọn nhánh mô hình CHỈ từ đầu ra đã khóa của Chặng 7/9/10 [C11 §3] rồi fit theo spec:
 * 1. Chọn "mô hình đang thắng" theo bảng chuyển nhánh mục 3 và quy tắc thắng §4.3 bước 7:
 *    Holt phải thắng SES; Holt-Winters phải thắng Holt/SES; thua thì fallback [§4.5].
 * 2. Cửa chu kỳ ngắn 11XY-SN đặt SAU mọi nhánh X/Y [sơ đồ mục 13]: Seasonal-naïve chỉ được
 *    chọn khi thắng mô hình đang thắng trên TEST [§8.10] và tập TEST đủ 3 chu kỳ [§8.10, mục 12].
 * Hàm thuần và tất định: engine và giao diện gọi chung để không bao giờ lệch số.
 */
export function fitBaseForecast(
  values: readonly number[],
  xyz: XyzClass | null,
  seasonality: SkuPipelineState['seasonality'],
  trend: SkuPipelineState['trend'],
  registry: ForecastModelRegistry = DEFAULT_FORECAST_MODEL_REGISTRY,
  windowPolicy: ForecastWindowPolicy = DEFAULT_FORECAST_WINDOW_CYCLES,
): ForecastFit {
  if (xyz === 'D' || xyz === null || !values.length) {
    // RULE-11-001 — xyz=null (CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW ở Chặng 7) hoặc
    // values rỗng (chu kỳ gần nhất theo lịch chính là một khoảng chưa khóa) đều bị CHẶN tự học,
    // KHÔNG được tự chuyển thành nhóm D — dùng chung khung placeholder với D nhưng khác reason.
    const reason = xyz === 'D'
      ? 'Nhóm D chưa có kế hoạch Thu mua hoặc SKU tương tự đã được duyệt; không tự phát hành dự báo.'
      : 'FORECAST_INPUT_BLOCKED — không có chu kỳ liên tiếp nào tính từ hiện tại để học (chu kỳ gần nhất theo lịch chưa khóa hoặc phân loại đã bị chặn); không nén chuỗi, không tự chuyển nhóm D.';
    return {
      learning: null,
      result: {
        model: 'PurchasePlan', params: {}, baseForecast: [],
        rmse: null, nrmse: null, wape: null, bias: null, hitRate: null, missedPulses: 0, falsePulses: 0, wapePositive: null,
        lockStatus: 'exception', reason,
        rpScan: null, pStar: null, controlModel: null, controlWape: null, reliability: 'low', futureSources: null,
      },
    };
  }

  // DEC-P11 — mỗi mô hình (SES/Holt/Holt-Winters/Croston) chỉ nhận đúng cửa sổ lịch sử nó cần,
  // đếm ngược từ chu kỳ gần nhất — KHÔNG dùng chung một cửa sổ toàn chuỗi như trước. Xem
  // windowForModel() và SimulationPolicy.forecastWindowCycles. Bước 2 (chu kỳ ngắn 11XY-SN) CHƯA
  // nằm trong DEC-P11 — cố tình giữ nguyên trên toàn chuỗi/TEST gốc để không đổi cơ chế so "thắng
  // mô hình đối chứng" đã có [§8.10/§8.11].
  const { trainSize: globalTrainSize, testSize: globalTestSize } = splitSizes(values.length);
  const globalReliability: ForecastResult['reliability'] = globalTestSize >= 3 ? 'ok' : 'low';
  const candidateWindowed = (model: RegisteredForecastModel): ModelLearning | null => {
    const window = windowForModel(model as ForecastWindowModel, values, windowPolicy);
    const context: ForecastEligibilityContext = {
      xyz, seasonality, trend, historyLength: window.values.length,
      trainSize: window.trainSize, testSize: window.testSize, seasonalPeriod: null, seasonalCorrelation: null,
    };
    const input: ForecastInput = { values: window.values, trainSize: window.trainSize, testSize: window.testSize, seasonalPeriod: null, seasonalCorrelation: null };
    return registry.fit(model, context, input)?.learning ?? null;
  };
  const candidate = (model: RegisteredForecastModel, explicitContext: ForecastEligibilityContext, explicitInput: ForecastInput): ModelLearning | null =>
    registry.fit(model, explicitContext, explicitInput)?.learning ?? null;
  const windowNote = (model: ForecastWindowModel): string => {
    const w = windowForModel(model, values, windowPolicy);
    if (w.usedCycles < w.totalCycles) return ` Cửa sổ ${model}: dùng ${w.usedCycles}/${w.totalCycles} CK gần nhất [DEC-P11].`;
    if (w.reliability === 'low') return ` Cửa sổ ${model}: chỉ ${w.usedCycles} CK, dưới mức khuyến nghị DEC-P11 → ${LOW_CONFIDENCE_FLAG}.`;
    return '';
  };

  if (xyz === 'Z') {
    // Croston và Nhịp phát sinh đọc CHUNG một cửa sổ Z [DEC-P11] — cả hai cùng ước lượng nhịp/quy mô
    // phát sinh từ cùng một chuỗi gần nhất, không có lý do tách riêng.
    const zWindow = windowForModel('Croston', values, windowPolicy);
    const pulse = detectPulse(zWindow.values);
    if (pulse.ready) {
      const learning = buildLearning('PulseRhythm', { D: pulse.interval!, Q: pulse.quantity! }, runPulse(zWindow.values, pulse.interval!, pulse.quantity!, zWindow.trainSize), zWindow.trainSize, zWindow.testSize, `Khoảng cách phát sinh đều D = ${pulse.interval}; quy mô Q = Median = ${pulse.quantity}.`);
      return toFit(learning, `Nhóm Z, nhịp phát sinh ổn định → mô hình nhịp [C11 §8.6].${windowNote('PulseRhythm')}`, { reliability: zWindow.reliability });
    }
    const learning = candidateWindowed('Croston')!;
    return toFit(learning, `Nhóm Z, khoảng cách phát sinh không đều → Croston bình quân [C11 §8.5].${windowNote('Croston')}`, { reliability: zWindow.reliability });
  }

  // ── Bước 1: chọn mô hình đang thắng của nhánh X/Y theo mục 3 + quy tắc thắng §4.3-7/§4.5 ──
  const sesLearning = candidateWindowed('SES')!;
  const beats = (challenger: ModelLearning, incumbent: ModelLearning): boolean =>
    challenger.wape !== null && (incumbent.wape === null || challenger.wape < incumbent.wape);

  let incumbent = sesLearning;
  let incumbentReason = (xyz === 'X'
    ? 'Nhóm X không có xu hướng rõ → SES nền ổn định [C11 §3, nhánh 11X].'
    : 'Nhóm Y không mùa vụ, không xu hướng → SES nền ổn định [C11 §3, nhánh 11Y-3].') + windowNote('SES');

  if (xyz === 'Y' && seasonality === 'confirmed') {
    // Nhánh 11Y-1: Holt-Winters phải thắng Holt/SES trên TEST [C11 §4.3 bước 7]; thua/không chạy được → fallback Holt → SES [§4.5].
    const holtLearning = candidateWindowed('Holt');
    const hwLearning = candidateWindowed('Holt-Winters');
    if (hwLearning && (!holtLearning || beats(hwLearning, holtLearning)) && beats(hwLearning, sesLearning)) {
      incumbent = hwLearning;
      incumbentReason = `Nhóm Y có mùa vụ đủ căn cứ (C9) và Holt-Winters (WAPE ${pct(hwLearning.wape)}) thắng Holt/SES trên TEST → Holt-Winters [C11 §7, §4.3 bước 7].${windowNote('Holt-Winters')}`;
    } else if (holtLearning && beats(holtLearning, sesLearning)) {
      incumbent = holtLearning;
      incumbentReason = (hwLearning
        ? `Holt-Winters (WAPE ${pct(hwLearning.wape)}) không thắng đối chứng → fallback Holt (WAPE ${pct(holtLearning.wape)}) vì Holt thắng SES [C11 §4.5].`
        : 'Chuỗi chưa đủ 2 vòng mùa cho Holt-Winters → fallback Holt vì Holt thắng SES trên TEST [C11 §4.5].') + windowNote('Holt');
    } else {
      incumbentReason = (hwLearning
        ? `Holt-Winters (WAPE ${pct(hwLearning.wape)}) và Holt không thắng SES (WAPE ${pct(sesLearning.wape)}) trên TEST → fallback SES [C11 §4.5].`
        : 'Mùa vụ xác nhận nhưng chuỗi TRAIN chưa đủ m+2 và Holt không thắng SES → fallback SES [C11 §4.5].') + windowNote('SES');
    }
  } else if (xyz === 'Y' && (trend === 'up' || trend === 'down') && values.length >= 3) {
    // Nhánh 11Y-2: Holt phải thắng SES trên TEST; thua → dùng SES [C11 §4.3 bước 7, §4.5].
    const holtLearning = candidateWindowed('Holt')!;
    if (beats(holtLearning, sesLearning)) {
      incumbent = holtLearning;
      incumbentReason = `Nhóm Y có xu hướng ${trend === 'up' ? 'tăng' : 'giảm'} (C10) và Holt (WAPE ${pct(holtLearning.wape)}) thắng SES (WAPE ${pct(sesLearning.wape)}) trên TEST → Holt [C11 §6, §4.3 bước 7].${windowNote('Holt')}`;
    } else {
      incumbentReason = `Nhóm Y có xu hướng ${trend === 'up' ? 'tăng' : 'giảm'} (C10) nhưng Holt (WAPE ${pct(holtLearning.wape)}) không thắng SES trên TEST → SES [C11 §4.5].${windowNote('SES')}`;
    }
  } else if (xyz === 'X' && values.length >= 3) {
    // Nhánh 11X: nhóm X không qua C10 nên dò xu hướng cục bộ; Holt chỉ thắng khi backtest tốt hơn SES [C11 §3].
    const localTrend = calculateTrend(values);
    if (localTrend.trend === 'up' || localTrend.trend === 'down') {
      const holtLearning = candidateWindowed('Holt')!;
      holtLearning.note = `α = ${holtLearning.params['alpha']}, β = ${holtLearning.params['beta']}; Holt thắng SES khi WAPE backtest thấp hơn.`;
      if (beats(holtLearning, sesLearning)) {
        incumbent = holtLearning;
        incumbentReason = `Nhóm X có xu hướng rõ và backtest Holt (WAPE ${pct(holtLearning.wape)}) tốt hơn SES → Holt [C11 §3, nhánh 11X].${windowNote('Holt')}`;
      } else {
        incumbentReason = `Nhóm X có xu hướng nhưng Holt không tốt hơn SES trên TEST → SES [C11 §3, §4.5].${windowNote('SES')}`;
      }
    }
  }

  // ── Bước 2: cửa chu kỳ lặp ngắn 11XY-SN sau MỌI nhánh X/Y [sơ đồ mục 13, §8.3] ──
  // Dò p* CHỈ trên TRAIN bằng tương quan Pearson [§8.5, §8.8]; lưu toàn bộ r(p) làm bằng chứng [§8.12].
  // Cố tình dùng values/globalTrainSize/globalTestSize (KHÔNG windowing riêng theo DEC-P11) để giữ
  // nguyên cơ chế so "thắng mô hình đối chứng" trên cùng một tập TEST như đã đặc tả [§8.10/§8.11].
  const shortCycle = detectShortCycle(values.slice(0, globalTrainSize));
  const context: ForecastEligibilityContext = { xyz, seasonality, trend, historyLength: values.length, trainSize: globalTrainSize, testSize: globalTestSize, seasonalPeriod: null, seasonalCorrelation: null };
  const input: ForecastInput = { values, trainSize: globalTrainSize, testSize: globalTestSize, seasonalPeriod: null, seasonalCorrelation: null };
  // Độ tin cậy hiển thị = "và" của độ tin cậy TEST toàn cục (mục 12, cửa SN) VÀ độ tin cậy cửa sổ
  // riêng của chính mô hình đang thắng [DEC-P11] — thấp ở vế nào cũng phải cảnh báo.
  const incumbentWindowReliability = windowForModel(incumbent.model as ForecastWindowModel, values, windowPolicy).reliability;
  const reliability: ForecastResult['reliability'] = globalReliability === 'ok' && incumbentWindowReliability === 'ok' ? 'ok' : 'low';
  const gate: FitExtras = {
    rpScan: shortCycle.scan,
    controlModel: incumbent.model,
    controlWape: incumbent.wape,
    reliability,
  };
  if (shortCycle.ready) {
    const seasonalContext = { ...context, seasonalPeriod: shortCycle.period!, seasonalCorrelation: shortCycle.correlation! };
    const seasonalInput = { ...input, seasonalPeriod: shortCycle.period!, seasonalCorrelation: shortCycle.correlation! };
    const naiveLearning = candidate('SeasonalNaive', seasonalContext, seasonalInput)!;
    if (globalReliability === 'low') {
      // §8.10 + mục 12 + SN-04: TEST < 3 chu kỳ → SN chỉ được tính sai số tham khảo, không được tự thắng bằng so sánh.
      return toFit(incumbent, `${incumbentReason} Có ứng viên chu kỳ ngắn p* = ${shortCycle.period} (r = ${shortCycle.correlation!.toFixed(2)}) nhưng tập TEST chỉ ${globalTestSize} chu kỳ < 3 → ${LOW_CONFIDENCE_FLAG}; giữ mô hình đối chứng, WAPE seasonal-naïve ${pct(naiveLearning.wape)} chỉ để tham khảo [C11 §8.10, mục 12].`, { ...gate, pStar: shortCycle.period });
    }
    if (beats(naiveLearning, incumbent)) {
      return toFit(naiveLearning, `Chu kỳ lặp ngắn p* = ${shortCycle.period} (r = ${shortCycle.correlation!.toFixed(2)} ≥ 0,60) và backtest seasonal-naïve (WAPE ${pct(naiveLearning.wape)}) thắng mô hình đối chứng ${incumbent.model} (WAPE ${pct(incumbent.wape)}) trên TEST → Seasonal-naïve [C11 §8.10, nhánh 11XY-SN]. Ngưỡng sai số nhóm chưa ban hành nên trạng thái vẫn cần xem xét.`, {
        ...gate,
        pStar: shortCycle.period,
        futureSources: seasonalNaiveFutureSources(values.length, shortCycle.period!),
      });
    }
    // SN-08: chênh lệch không thắng chặt (kể cả hòa) → giữ mô hình đang dùng [C11 §8.11].
    return toFit(incumbent, `${incumbentReason} Ứng viên seasonal-naïve p* = ${shortCycle.period} (r = ${shortCycle.correlation!.toFixed(2)}) không thắng ${incumbent.model} trên TEST (WAPE ${pct(naiveLearning.wape)} so với ${pct(incumbent.wape)}) → giữ mô hình đối chứng [C11 §8.11].`, { ...gate, pStar: shortCycle.period });
  }
  return toFit(incumbent, incumbentReason, gate);
}

/**
 * Chuỗi khóa cho Chặng 11 (khác cửa sổ 24 CK của C6/C7 — Holt-Winters cần ≥ 2 vòng, không giới
 * hạn độ dài). RULE-11-001 — dùng `trailingLockedRun` (đoạn chu kỳ khóa LIÊN TIẾP tính từ chu kỳ
 * gần nhất theo lịch) thay vì `cycles.filter(locked)` cũ (xóa khoảng trống rồi nối 2 đoạn xa nhau
 * thành chuỗi liên tục giả).
 */
export function lockedSeriesAll(state: Readonly<SkuPipelineState>): number[] {
  return trailingLockedRun(state.cycles).map(cycle => cycle.baseDemand);
}

/** Dựng lại toàn bộ diễn biến học của SKU đang chọn — cùng hàm với engine nên khớp số tuyệt đối. */
export function buildForecastLearning(state: Readonly<SkuPipelineState>): ForecastFit {
  return fitBaseForecast(lockedSeriesAll(state), state.classification.xyz, state.seasonality, state.trend);
}

// ── Giải thích từng ô của bảng học C11: ô nào được tính từ những ô nào [C11 §5–§8.6] ──

export type LearningColumn = 'actual' | 'level' | 'trend' | 'season' | 'forecast' | 'error';

export interface LearningCellSource { index: number; column: LearningColumn }

export interface LearningCellExplanation {
  title: string;         // ví dụ "L tại CK 05 · mức nền"
  formula: string;       // công thức chữ đúng spec
  substitution: string | null; // phép tính thay số từ chính các ô nguồn
  meaning: string;       // diễn giải cho người đọc không chuyên
  sources: LearningCellSource[]; // các ô cần sáng lên
}

function fmtCell(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('vi-VN', { maximumFractionDigits: digits });
}

function ck(index: number): string {
  return `CK ${index.toString().padStart(2, '0')}`;
}

/**
 * Trả về lời giải cho một ô trong bảng diễn biến học (bảng "Dữ liệu qua từng chặng" của C11).
 * Chỉ đọc lại rows/params đã tính — không tính lại mô hình nên không bao giờ lệch số.
 */
export function explainLearningCell(learning: ModelLearning, index: number, column: LearningColumn): LearningCellExplanation | null {
  const rows = learning.rows;
  const row = rows.find(item => item.index === index);
  if (!row) return null;
  const prev = rows.find(item => item.index === index - 1) ?? null;
  const { model, params } = learning;
  const alpha = params['alpha'];
  const beta = params['beta'];
  const gamma = params['gamma'];

  if (column === 'actual') {
    return {
      title: `Y thực tại ${ck(index)}`,
      formula: 'Yₜ = Σ sức mua nền các ngày trong chu kỳ (đã khóa ở Chặng 5)',
      substitution: null,
      meaning: 'Đây là dữ liệu ĐẦU VÀO, không tính từ ô nào trong bảng. Mọi cột khác đều học từ chuỗi Y này.',
      sources: [],
    };
  }

  if (column === 'error') {
    if (row.error === null || row.forecast === null) {
      return {
        title: `Sai số tại ${ck(index)}`,
        formula: 'e = Y − F',
        substitution: null,
        meaning: 'Chu kỳ này chưa có dự báo one-step-ahead (pha khởi tạo) nên chưa đo được sai số.',
        sources: [],
      };
    }
    return {
      title: `Sai số tại ${ck(index)}`,
      formula: 'eₜ = Yₜ − Fₜ',
      substitution: `e = ${fmtCell(row.actual, 1)} − ${fmtCell(row.forecast)} = ${fmtCell(row.error, 1)}`,
      meaning: 'Sai số dương → mô hình dự báo THẤP hơn thực tế (nguy cơ thiếu hàng); âm → dự báo CAO hơn thực tế (nguy cơ thừa hàng). RMSE/WAPE/Bias ở chân bảng gộp từ các ô sai số pha TEST.',
      sources: [{ index, column: 'actual' }, { index, column: 'forecast' }],
    };
  }

  // ── SES [C11 §5] ──
  if (model === 'SES') {
    if (column === 'level') {
      if (index === 1) {
        return {
          title: `L khởi tạo tại ${ck(1)}`,
          formula: 'L₁ = Y₁',
          substitution: `L = ${fmtCell(row.actual, 1)}`,
          meaning: 'Mức nền được gieo bằng chính sức mua chu kỳ đầu tiên — chưa có gì để làm mượt.',
          sources: [{ index: 1, column: 'actual' }],
        };
      }
      return {
        title: `L · mức nền tại ${ck(index)}`,
        formula: 'Lₜ = α×Yₜ + (1−α)×Lₜ₋₁',
        substitution: `L = ${fmtCell(alpha)}×${fmtCell(row.actual, 1)} + ${fmtCell(1 - alpha)}×${fmtCell(prev?.level)} = ${fmtCell(row.level)}`,
        meaning: `Mức nền mới trộn ${fmtCell(alpha * 100, 0)}% dữ liệu thực chu kỳ này với ${fmtCell((1 - alpha) * 100, 0)}% mức nền cũ — α càng lớn mô hình phản ứng càng nhanh.`,
        sources: [{ index, column: 'actual' }, { index: index - 1, column: 'level' }],
      };
    }
    if (column === 'forecast') {
      return {
        title: `F dự báo tại ${ck(index)}`,
        formula: 'Fₜ = Lₜ₋₁',
        substitution: `F = ${fmtCell(prev?.level)}`,
        meaning: 'Dự báo one-step-ahead của SES chỉ là mức nền vừa chốt ở chu kỳ TRƯỚC — được tính trước khi biết Y thực của chu kỳ này.',
        sources: [{ index: index - 1, column: 'level' }],
      };
    }
  }

  // ── Holt [C11 §6] ──
  if (model === 'Holt') {
    if (column === 'level') {
      if (index <= 2) {
        return {
          title: `L khởi tạo tại ${ck(index)}`,
          formula: 'L₂ = Y₂',
          substitution: index === 2 ? `L = ${fmtCell(row.actual, 1)}` : null,
          meaning: 'Holt cần 2 chu kỳ đầu để gieo mức nền và xu hướng, nên L chỉ xuất hiện từ CK 02.',
          sources: index === 2 ? [{ index: 2, column: 'actual' }] : [],
        };
      }
      return {
        title: `L · mức nền tại ${ck(index)}`,
        formula: 'Lₜ = α×Yₜ + (1−α)×(Lₜ₋₁ + Tₜ₋₁)',
        substitution: `L = ${fmtCell(alpha)}×${fmtCell(row.actual, 1)} + ${fmtCell(1 - alpha)}×(${fmtCell(prev?.level)} + ${fmtCell(prev?.trend)}) = ${fmtCell(row.level)}`,
        meaning: 'Mức nền mới trộn dữ liệu thực với "mức nền cũ đã trượt theo xu hướng". Nhờ cộng Tₜ₋₁, Holt không bị tụt lại khi chuỗi đang tăng/giảm đều.',
        sources: [{ index, column: 'actual' }, { index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }],
      };
    }
    if (column === 'trend') {
      if (index <= 2) {
        return {
          title: `T khởi tạo tại ${ck(index)}`,
          formula: 'T₂ = Y₂ − Y₁',
          substitution: index === 2 ? `T = ${fmtCell(row.actual, 1)} − ${fmtCell(rows[0]?.actual, 1)} = ${fmtCell(row.trend)}` : null,
          meaning: 'Xu hướng ban đầu là chênh lệch giữa 2 chu kỳ đầu tiên — ước lượng thô, sẽ được làm mượt dần bằng β.',
          sources: index === 2 ? [{ index: 1, column: 'actual' }, { index: 2, column: 'actual' }] : [],
        };
      }
      return {
        title: `T · xu hướng tại ${ck(index)}`,
        formula: 'Tₜ = β×(Lₜ − Lₜ₋₁) + (1−β)×Tₜ₋₁',
        substitution: `T = ${fmtCell(beta)}×(${fmtCell(row.level)} − ${fmtCell(prev?.level)}) + ${fmtCell(1 - beta)}×${fmtCell(prev?.trend)} = ${fmtCell(row.trend)}`,
        meaning: 'Xu hướng mới trộn "bước nhảy mức nền vừa quan sát" với xu hướng cũ. Khi dự phóng tương lai, T bị chặn ±15% mức nền để không phóng đại.',
        sources: [{ index, column: 'level' }, { index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }],
      };
    }
    if (column === 'forecast') {
      return {
        title: `F dự báo tại ${ck(index)}`,
        formula: 'Fₜ = Lₜ₋₁ + Tₜ₋₁',
        substitution: `F = ${fmtCell(prev?.level)} + ${fmtCell(prev?.trend)} = ${fmtCell(row.forecast)}`,
        meaning: 'Dự báo là mức nền chu kỳ trước cộng thêm một bước xu hướng — được chốt TRƯỚC khi biết Y thực của chu kỳ này.',
        sources: [{ index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }],
      };
    }
  }

  // ── Holt-Winters nhân tính [C11 §7], m = 24 ──
  if (model === 'Holt-Winters') {
    const m = SEASON_LENGTH;
    if (column === 'season') {
      if (index <= m) {
        return {
          title: `S khởi tạo vị trí ${index} (vòng mùa 1)`,
          formula: 'Sᵢ = Yᵢ / trungBình(Y₁…Y₂₄)',
          substitution: `S = ${fmtCell(row.actual, 1)} / ${fmtCell(row.season ? row.actual / row.season : null, 1)} = ${fmtCell(row.season)}`,
          meaning: 'Hệ số mùa ban đầu đo vị trí này cao/thấp bao nhiêu so với trung bình cả vòng mùa đầu tiên (24 CK). S > 1 là mùa cao, S < 1 là mùa thấp.',
          sources: rows.slice(0, m).map(item => ({ index: item.index, column: 'actual' as LearningColumn })),
        };
      }
      const sourceIndex = index - m;
      const sourceRow = rows.find(item => item.index === sourceIndex);
      if (sourceRow && sourceIndex > m + 1) {
        return {
          title: `S · hệ số mùa dùng tại ${ck(index)}`,
          formula: 'S = γ×(Yₜ₋₂₄ / Lₜ₋₂₄) + (1−γ)×Sₜ₋₂₄',
          substitution: `S = ${fmtCell(gamma)}×(${fmtCell(sourceRow.actual, 1)} / ${fmtCell(sourceRow.level)}) + ${fmtCell(1 - gamma)}×${fmtCell(sourceRow.season)} = ${fmtCell(row.season)}`,
          meaning: `Hệ số mùa của vị trí này được cập nhật lần cuối ở ${ck(sourceIndex)} — đúng vị trí đó của vòng mùa trước (cách 24 CK).`,
          sources: [
            { index: sourceIndex, column: 'actual' }, { index: sourceIndex, column: 'level' }, { index: sourceIndex, column: 'season' },
          ],
        };
      }
      return {
        title: `S · hệ số mùa dùng tại ${ck(index)}`,
        formula: 'S kế thừa hệ số cùng vị trí của vòng mùa trước',
        substitution: `S = ${fmtCell(row.season)}`,
        meaning: `Vị trí mùa này lấy lại hệ số đã khởi tạo ở ${ck(Math.max(1, sourceIndex))} (cách đúng một vòng 24 CK).`,
        sources: sourceRow ? [{ index: sourceIndex, column: 'season' }] : [],
      };
    }
    if (column === 'level') {
      if (index <= m + 1) {
        return {
          title: `L khởi tạo tại ${ck(index)}`,
          formula: 'L₂₅ = Y₂₅ / S₁',
          substitution: index === m + 1 ? `L = ${fmtCell(row.actual, 1)} / ${fmtCell(rows[0]?.season)} = ${fmtCell(row.level)}` : null,
          meaning: 'Holt-Winters cần trọn vòng mùa 1 để gieo hệ số S, nên mức nền chỉ bắt đầu từ CK 25: lấy Y chia hệ số mùa để "khử mùa".',
          sources: index === m + 1 ? [{ index, column: 'actual' }, { index: 1, column: 'season' }] : [],
        };
      }
      return {
        title: `L · mức nền tại ${ck(index)}`,
        formula: 'Lₜ = α×(Yₜ/Sₜ) + (1−α)×(Lₜ₋₁ + Tₜ₋₁)',
        substitution: `L = ${fmtCell(alpha)}×(${fmtCell(row.actual, 1)}/${fmtCell(row.season)}) + ${fmtCell(1 - alpha)}×(${fmtCell(prev?.level)} + ${fmtCell(prev?.trend)}) = ${fmtCell(row.level)}`,
        meaning: 'Y thực được chia hệ số mùa để khử mùa trước, rồi mới trộn với mức nền cũ đã trượt theo xu hướng — nên L là "sức mua nền đã bỏ yếu tố mùa".',
        sources: [{ index, column: 'actual' }, { index, column: 'season' }, { index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }],
      };
    }
    if (column === 'trend') {
      if (index <= m + 1) {
        return {
          title: `T khởi tạo tại ${ck(index)}`,
          formula: 'T₂₅ = Y₂₅/S₁ − Y₂₄/S₂₄',
          substitution: null,
          meaning: 'Xu hướng ban đầu là chênh lệch giữa hai mức nền đã khử mùa liên tiếp cuối pha khởi tạo.',
          sources: index === m + 1 ? [{ index: m, column: 'actual' }, { index: m + 1, column: 'actual' }, { index: 1, column: 'season' }, { index: m, column: 'season' }] : [],
        };
      }
      return {
        title: `T · xu hướng tại ${ck(index)}`,
        formula: 'Tₜ = β×(Lₜ − Lₜ₋₁) + (1−β)×Tₜ₋₁',
        substitution: `T = ${fmtCell(beta)}×(${fmtCell(row.level)} − ${fmtCell(prev?.level)}) + ${fmtCell(1 - beta)}×${fmtCell(prev?.trend)} = ${fmtCell(row.trend)}`,
        meaning: 'Giống Holt: trộn bước nhảy mức nền vừa quan sát với xu hướng cũ; khi dự phóng bị chặn ±15% để an toàn.',
        sources: [{ index, column: 'level' }, { index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }],
      };
    }
    if (column === 'forecast') {
      return {
        title: `F dự báo tại ${ck(index)}`,
        formula: 'Fₜ = (Lₜ₋₁ + Tₜ₋₁) × Sₜ',
        substitution: `F = (${fmtCell(prev?.level)} + ${fmtCell(prev?.trend)}) × ${fmtCell(row.season)} = ${fmtCell(row.forecast)}`,
        meaning: 'Lấy mức nền + xu hướng của chu kỳ trước (phần "khử mùa") rồi NHÂN lại hệ số mùa của vị trí này để trả yếu tố mùa vào dự báo.',
        sources: [{ index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }, { index, column: 'season' }],
      };
    }
  }

  // ── Croston [C11 §8.5]: level = Z (quy mô), trend = P (khoảng cách) ──
  if (model === 'Croston') {
    const isEvent = row.actual > 0;
    const firstEventIndex = rows.find(item => item.actual > 0)?.index ?? null;
    if (column === 'level') {
      if (!isEvent) {
        return {
          title: `Z · quy mô tại ${ck(index)}`,
          formula: 'Không phát sinh nhu cầu → Z giữ nguyên',
          substitution: `Z = ${fmtCell(row.level)}`,
          meaning: 'Croston chỉ học ở chu kỳ CÓ nhu cầu; chu kỳ trống mang nguyên trạng thái cũ sang.',
          sources: prev ? [{ index: index - 1, column: 'level' }] : [],
        };
      }
      if (index === firstEventIndex) {
        return {
          title: `Z khởi tạo tại ${ck(index)}`,
          formula: 'Z = Y tại lần phát sinh đầu tiên',
          substitution: `Z = ${fmtCell(row.actual, 1)}`,
          meaning: 'Quy mô được gieo bằng đúng lượng bán của lần phát sinh đầu tiên.',
          sources: [{ index, column: 'actual' }],
        };
      }
      return {
        title: `Z · quy mô tại ${ck(index)}`,
        formula: 'Z = α×Yₜ + (1−α)×Z_cũ',
        substitution: `Z = ${fmtCell(alpha)}×${fmtCell(row.actual, 1)} + ${fmtCell(1 - alpha)}×${fmtCell(prev?.level)} = ${fmtCell(row.level)}`,
        meaning: 'Mỗi lần CÓ nhu cầu, quy mô trung bình được làm mượt lại giữa lượng bán mới và quy mô cũ.',
        sources: [{ index, column: 'actual' }, { index: index - 1, column: 'level' }],
      };
    }
    if (column === 'trend') {
      if (!isEvent || row.trend === null) {
        return {
          title: `P · khoảng cách tại ${ck(index)}`,
          formula: row.trend === null ? 'Chưa đủ 2 lần phát sinh → P chưa xác định' : 'Không phát sinh → P giữ nguyên',
          substitution: row.trend === null ? null : `P = ${fmtCell(row.trend)}`,
          meaning: 'P là khoảng cách trung bình GIỮA các lần phát sinh; cấm dùng khoảng cách từ đầu chuỗi đến lần đầu tiên.',
          sources: prev && row.trend !== null ? [{ index: index - 1, column: 'trend' }] : [],
        };
      }
      return {
        title: `P · khoảng cách tại ${ck(index)}`,
        formula: 'P = α×(khoảng cách từ lần phát sinh trước) + (1−α)×P_cũ',
        substitution: `P = … = ${fmtCell(row.trend)}`,
        meaning: 'Khoảng cách mới nhất giữa 2 lần phát sinh được trộn với khoảng cách trung bình cũ bằng cùng hệ số α.',
        sources: [{ index, column: 'actual' }, ...(prev ? [{ index: index - 1, column: 'trend' as LearningColumn }] : [])],
      };
    }
    if (column === 'forecast') {
      if (row.forecast === null) {
        return {
          title: `F dự báo tại ${ck(index)}`,
          formula: 'F = null trước khi đủ 2 lần phát sinh',
          substitution: null,
          meaning: 'Croston bị CẤM phát dự báo khi chưa đủ căn cứ (cần tối thiểu 2 lần phát sinh để có P đầu tiên).',
          sources: [],
        };
      }
      return {
        title: `F dự báo tại ${ck(index)}`,
        formula: 'Fₜ = Z_cũ / P_cũ',
        substitution: `F = ${fmtCell(prev?.level)} / ${fmtCell(prev?.trend)} = ${fmtCell(row.forecast)}`,
        meaning: 'Dự báo là "bình quân mỗi chu kỳ": quy mô mỗi lần phát sinh chia khoảng cách giữa các lần — trạng thái lấy từ chu kỳ trước.',
        sources: prev ? [{ index: index - 1, column: 'level' }, { index: index - 1, column: 'trend' }] : [],
      };
    }
  }

  // ── Seasonal-naïve [C11 §8.9] ──
  if (model === 'SeasonalNaive' && column === 'forecast') {
    const period = params['p'];
    if (row.forecast === null) {
      return {
        title: `F dự báo tại ${ck(index)}`,
        formula: 'F = null trong p chu kỳ đầu (chưa có vòng lặp trước để soi)',
        substitution: null,
        meaning: `Mô hình cần ít nhất một vòng lặp p* = ${fmtCell(period, 0)} chu kỳ trước khi được phát dự báo.`,
        sources: [],
      };
    }
    return {
      title: `F dự báo tại ${ck(index)}`,
      formula: 'Fₜ = Yₜ₋ₚ*',
      substitution: `F = Y tại ${ck(index - period)} = ${fmtCell(row.forecast, 1)}`,
      meaning: `Chuỗi lặp lại sau mỗi p* = ${fmtCell(period, 0)} chu kỳ (tương quan Pearson dãy A/B lệch p* trên TRAIN: r = ${fmtCell(params['r'])} [C11 §8.5]), nên dự báo lấy đúng giá trị của cùng vị trí ở vòng lặp trước — ${ck(index - period)} là "chu kỳ nguồn được sao chép" [C11 §8.12].`,
      sources: [{ index: index - period, column: 'actual' }],
    };
  }
  if (model === 'SeasonalNaive' && column === 'season') {
    const period = params['p'];
    if (row.season === null) {
      return {
        title: `Nguồn F tại ${ck(index)}`,
        formula: 'Chưa có vòng lặp trước để soi',
        substitution: null,
        meaning: `${ck(index)} nằm trong p* = ${fmtCell(period, 0)} chu kỳ đầu nên chưa có chu kỳ nguồn nào cách đó ${fmtCell(period, 0)} kỳ về trước — F để trống.`,
        sources: [],
      };
    }
    return {
      title: `Nguồn F tại ${ck(index)}`,
      formula: 'Fₜ sao chép nguyên giá trị Y của chu kỳ cách đó đúng p* kỳ',
      substitution: `Nguồn = ${ck(row.season)} (= ${ck(index)} − p* ${fmtCell(period, 0)})`,
      meaning: `Cột này chỉ thẳng ra chu kỳ nguồn mà ô "F dự báo" bên cạnh sao chép — không cần hover mới thấy. Di chuột vào đây hoặc vào ô F đều sáng cùng một ô Y nguồn.`,
      sources: [{ index: row.season, column: 'actual' }],
    };
  }

  // ── Nhịp phát sinh [C11 §8.6] ──
  if (model === 'PulseRhythm' && column === 'forecast') {
    const intervalD = params['D'];
    const quantityQ = params['Q'];
    return {
      title: `F dự báo tại ${ck(index)}`,
      formula: 'F = Q nếu chu kỳ rơi đúng nhịp D, ngược lại F = 0',
      substitution: `D = ${fmtCell(intervalD, 0)} CK · Q = Median = ${fmtCell(quantityQ, 1)} → F = ${fmtCell(row.forecast, 1)}`,
      meaning: 'Mô hình nhịp không có L/T: nó đếm khoảng cách từ lần phát sinh gần nhất; cứ đủ D chu kỳ thì bơm đúng quy mô trung vị Q.',
      sources: [],
    };
  }

  return null;
}
