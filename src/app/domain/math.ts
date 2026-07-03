import { DailyRecord } from './models';

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

export function detectPulse(values: readonly number[]): { ready: boolean; interval: number | null; quantity: number | null } {
  const events = values.map((value, index) => ({ value, index })).filter(event => event.value > 0);
  if (events.length < 3) return { ready: false, interval: null, quantity: null };
  const gaps = events.slice(1).map((event, index) => event.index - events[index].index);
  if (!gaps.every(gap => gap === gaps[0])) return { ready: false, interval: null, quantity: null };
  return { ready: true, interval: gaps[0], quantity: median(events.map(event => event.value)) };
}
