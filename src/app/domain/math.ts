import { DailyRecord, ShortCycleScanEntry } from './models';

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function populationStdev(values: readonly number[]): number {
  if (!values.length) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

export function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function isStockout(record: Pick<DailyRecord, 'openStock' | 'closeStock' | 'sales' | 'receiptHour'>, cutoffHour = '10:00'): boolean {
  const lateReceipt = record.openStock === 0 && record.closeStock > 0 && !!record.receiptHour && record.receiptHour > cutoffHour;
  const emptyAllDay = record.openStock === 0 && record.closeStock === 0 && record.sales === 0;
  return lateReceipt || emptyAllDay;
}

export function stockoutBaseline(sales: number, references: readonly number[]): number | null {
  return references.length >= 3 ? Math.max(sales, median(references)) : null;
}

export function promoBaseline(references: readonly number[]): number | null {
  return references.length >= 3 ? median(references) : null;
}

export function classifyAbcRows(rows: readonly { id: string; annualValue: number; eligible?: boolean }[]): Record<string, 'A' | 'B' | 'C' | 'N/A'> {
  const sorted = [...rows].sort((a, b) => b.annualValue - a.annualValue);
  const total = sorted.filter(row => row.eligible !== false).reduce((sum, row) => sum + row.annualValue, 0);
  let cumulative = 0;
  return Object.fromEntries(sorted.map((row, index) => {
    if (row.eligible === false) return [row.id, 'N/A'];
    cumulative += row.annualValue;
    const share = total ? cumulative / total : 0;
    return [row.id, index === 0 || share <= 0.8 ? 'A' : share >= 0.9 ? 'C' : 'B'];
  }));
}

export function classifySeasonPosition(ratios: readonly number[]): 'LẶP CAO' | 'LẶP THẤP' | 'CHƯA RÕ' {
  if (!ratios.length) return 'CHƯA RÕ';
  const average = mean(ratios);
  const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
  const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
  if (average >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) return 'LẶP CAO';
  if (average <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat)) return 'LẶP THẤP';
  return 'CHƯA RÕ';
}

/** Tài liệu biểu diễn 2/3 vòng là 67%; so theo phần trăm làm tròn để 2/3 không bị loại vì 66,666…%. */
export function meetsSeasonRepeatThreshold(rate: number): boolean {
  return Math.round(rate * 100) >= 67;
}

export function applyPromoFactor(baseForecast: number, promoDays: number, cycleDays: number, factor: number): number {
  const promoShare = promoDays / cycleDays;
  return baseForecast * (1 - promoShare) + baseForecast * promoShare * factor;
}

export function calculateFreeStock(onHand: number, confirmedInbound: number, committed: number): number {
  return onHand + confirmedInbound - committed;
}

export function classifyXyz(values: readonly number[]): {
  xyz: 'X' | 'Y' | 'Z' | 'D'; n: number; m: number; adi: number | null;
  positiveMean: number | null; positiveStdev: number | null; cv: number | null; cv2: number | null;
} {
  const n = values.length;
  const positive = values.filter(value => value > 0);
  const m = positive.length;
  if (n < 6 || !m) return { xyz: 'D', n, m, adi: null, positiveMean: null, positiveStdev: null, cv: null, cv2: null };
  const adi = n / m;
  const positiveMean = mean(positive);
  const positiveStdev = populationStdev(positive);
  const cv = positiveMean ? positiveStdev / positiveMean : null;
  const cv2 = cv === null ? null : cv ** 2;
  if (adi > 1.32) return { xyz: 'Z', n, m, adi, positiveMean, positiveStdev, cv, cv2 };
  return { xyz: (cv2 ?? Infinity) <= 0.49 ? 'X' : 'Y', n, m, adi, positiveMean, positiveStdev, cv, cv2 };
}

export function calculateTrend(values: readonly number[]): { trend: 'up' | 'down' | 'none' | 'insufficient'; rates: [number | null, number | null]; cappedRate: number | null; needsReview: boolean } {
  if (values.length < 12) return { trend: 'insufficient', rates: [null, null], cappedRate: null, needsReview: false };
  const recent = values.slice(-12);
  const groups = [mean(recent.slice(0, 4)), mean(recent.slice(4, 8)), mean(recent.slice(8, 12))];
  if (!groups[0] || !groups[1]) return { trend: 'none', rates: [0, 0], cappedRate: 0, needsReview: false };
  const g1 = (groups[1] - groups[0]) / groups[0];
  const g2 = (groups[2] - groups[1]) / groups[1];
  const maxRate = Math.max(Math.abs(g1), Math.abs(g2));
  const cappedRate = Math.min(0.15, maxRate);
  if (g1 >= 0.05 && g2 >= 0.05) return { trend: 'up', rates: [g1, g2], cappedRate, needsReview: maxRate > 0.25 };
  if (g1 <= -0.05 && g2 <= -0.05) return { trend: 'down', rates: [g1, g2], cappedRate: -cappedRate, needsReview: maxRate > 0.25 };
  return { trend: 'none', rates: [g1, g2], cappedRate: 0, needsReview: false };
}

export function calculateWape(actual: readonly number[], forecast: readonly number[]): number | null {
  const denominator = actual.reduce((sum, value) => sum + value, 0);
  if (!denominator) return null;
  return actual.reduce((sum, value, index) => sum + Math.abs(value - (forecast[index] ?? 0)), 0) / denominator;
}

export function calculateBias(actual: readonly number[], forecast: readonly number[]): number | null {
  const denominator = actual.reduce((sum, value) => sum + value, 0);
  if (!denominator) return null;
  return actual.reduce((sum, value, index) => sum + ((forecast[index] ?? 0) - value), 0) / denominator;
}

export function safetyStock(z: number, averageDemand: number, demandSigma: number, leadTimeCycles: number, leadTimeSigmaCycles: number): number {
  return z * Math.sqrt(leadTimeCycles * demandSigma ** 2 + averageDemand ** 2 * leadTimeSigmaCycles ** 2);
}

export function croston(values: readonly number[], alpha = 0.2): { ready: boolean; forecast: number | null; firstInterval: number | null } {
  const events = values.map((value, index) => ({ value, index })).filter(event => event.value > 0);
  if (events.length < 2) return { ready: false, forecast: null, firstInterval: null };
  let size = events[0].value;
  let interval = events[1].index - events[0].index;
  let previousIndex = events[1].index;
  size = alpha * events[1].value + (1 - alpha) * size;
  for (const event of events.slice(2)) {
    const gap = event.index - previousIndex;
    size = alpha * event.value + (1 - alpha) * size;
    interval = alpha * gap + (1 - alpha) * interval;
    previousIndex = event.index;
  }
  return { ready: true, forecast: size / interval, firstInterval: events[1].index - events[0].index };
}

export interface ShortCycleDetection {
  ready: boolean;
  period: number | null;
  correlation: number | null;
  scan: ShortCycleScanEntry[];
}

/**
 * Dò chu kỳ lặp NGẮN (p = 2..12 CK) theo đúng công thức chuẩn [C11 §8.5]:
 * r(p) = tương quan Pearson giữa dãy A = Y_{p+1..T} và dãy B = Y_{1..T−p}
 * (hai trung bình riêng Ā, B̄; mẫu số √(ΣA²·ΣB²)). Đây là "một công thức chuẩn
 * duy nhất" tài liệu yêu cầu — không dùng ACF một trung bình chung.
 * Khác mùa vụ năm C9 (cố định 24 vị trí): đây là dao động lặp trong vài chu kỳ.
 * Chỉ dò trên TRAIN. Toàn bộ danh sách r(p) đã thử được trả về làm bằng chứng
 * chọn/loại từng p [C11 §8.8 bước 5, §8.12].
 *
 * "Gần như hòa" [C11 §8.8]: bội số của chu kỳ thật cũng cho r cao (p=4 thật thì
 * r(8), r(12) cũng cao); nhiễu có thể làm bội số nhỉnh hơn vài phần trăm. p lớn hơn
 * chỉ được thay p nhỏ khi r vượt quá dung sai hòa — ưu tiên p nhỏ vì cần ít lịch sử
 * hơn và dễ kiểm chứng hơn. Dung sai 0,05 là khởi điểm đề xuất, chưa phải ngưỡng
 * đã phê duyệt; danh sách scan lưu đủ mọi ứng viên để người duyệt đối chiếu.
 */
const NEAR_TIE_TOLERANCE = 0.05;

export function detectShortCycle(values: readonly number[], minCorrelation = 0.6, maxPeriod = 12): ShortCycleDetection {
  const scan: ShortCycleScanEntry[] = [];
  let best: { period: number; correlation: number } | null = null;
  for (let period = 2; period <= maxPeriod; period++) {
    // Cần tối thiểu 2 vòng lặp trong TRAIN để dãy A/B phủ trọn một vòng.
    if (period * 2 > values.length) {
      scan.push({ p: period, r: null, status: 'insufficient-data' });
      continue;
    }
    const seriesA = values.slice(period);
    const seriesB = values.slice(0, values.length - period);
    const meanA = mean(seriesA);
    const meanB = mean(seriesB);
    let numerator = 0;
    let sumSqA = 0;
    let sumSqB = 0;
    for (let i = 0; i < seriesA.length; i++) {
      numerator += (seriesA[i] - meanA) * (seriesB[i] - meanB);
      sumSqA += (seriesA[i] - meanA) ** 2;
      sumSqB += (seriesB[i] - meanB) ** 2;
    }
    const denominator = Math.sqrt(sumSqA * sumSqB);
    if (denominator <= 0) {
      // Một trong hai dãy là hằng số → tương quan không xác định, không mở p này.
      scan.push({ p: period, r: null, status: 'insufficient-data' });
      continue;
    }
    const correlation = numerator / denominator;
    const passes = correlation >= minCorrelation;
    scan.push({ p: period, r: correlation, status: passes ? 'candidate' : 'below-threshold' });
    // Duyệt p tăng dần: p lớn chỉ thay p nhỏ khi vượt dung sai hòa [C11 §8.8: gần như hòa → ưu tiên p nhỏ].
    if (passes && (!best || correlation > best.correlation + NEAR_TIE_TOLERANCE)) best = { period, correlation };
  }
  if (!best) {
    const bestSeen = scan.reduce<ShortCycleScanEntry | null>((acc, entry) => entry.r !== null && (acc === null || entry.r > (acc.r ?? -Infinity)) ? entry : acc, null);
    return { ready: false, period: null, correlation: bestSeen?.r ?? null, scan };
  }
  return { ready: true, period: best.period, correlation: best.correlation, scan };
}

export function detectPulse(values: readonly number[]): { ready: boolean; interval: number | null; quantity: number | null } {
  const events = values.map((value, index) => ({ value, index })).filter(event => event.value > 0);
  if (events.length < 3) return { ready: false, interval: null, quantity: null };
  const gaps = events.slice(1).map((event, index) => event.index - events[index].index);
  if (!gaps.every(gap => gap === gaps[0])) return { ready: false, interval: null, quantity: null };
  return { ready: true, interval: gaps[0], quantity: median(events.map(event => event.value)) };
}
