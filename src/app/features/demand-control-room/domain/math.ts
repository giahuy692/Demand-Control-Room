import { CycleRecord, CycleStatus, DailyRecord, PolicyClassification, ShortCycleScanEntry, StockCalculationStatus } from './models';

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

/**
 * RULE-01-001 — `sales` chỉ là `null` khi `hasRecord=false` (ngày scaffold, xem
 * calendar-scaffold.ts). Dùng ở những nhánh đã tự chứng minh `hasRecord=true`
 * (ví dụ sau khi đã loại nhánh `!hasRecord` bằng return sớm) để lấy `number` an
 * toàn kiểu dữ liệu mà KHÔNG coi null là 0 — nếu bất biến bị vi phạm, báo lỗi rõ
 * ràng thay vì âm thầm tính sai.
 */
export function requireObservedSales(record: Pick<DailyRecord, 'sku' | 'date' | 'sales' | 'hasSalesRecord'>): number {
  if (!record.hasSalesRecord || record.sales === null) throw new Error(`Bất biến vỡ: SKU ${record.sku} ngày ${record.date} không có sales row hợp lệ.`);
  return record.sales;
}

/**
 * RULE-02-001 — `stockCalculationStatus` mặc định 'CALCULATED' để giữ nguyên hành vi cũ ở mọi
 * lời gọi chưa truyền tham số này (test cũ, dữ liệu giả); chỉ khi gọi từ Chặng 2 thật với trạng
 * thái ANCHOR_MISSING/UNRESOLVED thì mới chặn đánh dấu stockout tự động.
 */
export function isStockout(record: Pick<DailyRecord, 'openStock' | 'closeStock' | 'receiptHour'>, cutoffHour = '10:00', stockCalculationStatus: StockCalculationStatus = 'CALCULATED'): boolean {
  // RULE-02-001 — không đủ căn cứ tính tồn thì không được kết luận stockout tự động.
  if (stockCalculationStatus === 'ANCHOR_MISSING' || stockCalculationStatus === 'UNRESOLVED') return false;
  // lateReceipt chỉ cần tồn đầu/cuối/giờ nhập (nguồn sổ tồn kho, tin được kể cả
  // ngày không có giao dịch bán) nên không cần gate theo hasRecord.
  const [cutoffHours, cutoffMinutes] = cutoffHour.split(':').map(Number);
  const lateReceipt = record.openStock === 0 && record.closeStock !== null && record.closeStock > 0 && record.receiptHour !== null && record.receiptHour > cutoffHours + cutoffMinutes / 60;
  // emptyAllDay cần Q=0 đã XÁC NHẬN — ngày không có bản ghi (hasRecord=false)
  // không được suy diễn thành bán=0 [nguyên tắc bất biến #2, C1 §3].
  const emptyAllDay = record.openStock === 0 && record.closeStock === 0;
  return lateReceipt || emptyAllDay;
}

/**
 * Loại mã CTKM THƯỜNG TRỰC (policy.standingPromotionCodes) khỏi một promoCode
 * đã ghép nhiều mã bằng "|". Ngày chỉ dính mã thường trực trở thành ngày
 * không CTKM (null) — được Chặng 2-4 xử lý như bán bình thường. Nếu vẫn còn
 * mã CHIẾN DỊCH khác sau khi loại, ngày đó vẫn là ngày CTKM (đúng phần còn lại).
 */
export function stripStandingPromoCodes(promoCode: string | null, standingCodes: readonly string[]): string | null {
  if (!promoCode || !standingCodes.length) return promoCode;
  const standing = new Set(standingCodes);
  const remaining = promoCode.split('|').filter(code => !standing.has(code));
  return remaining.length ? remaining.join('|') : null;
}

/**
 * RULE-04-001 — phân loại một mã CTKM (đã qua stripStandingPromoCodes, không còn khả năng là
 * STANDING_PRICE) thành CAMPAIGN/CLEARANCE/UNKNOWN_REVIEW theo hai danh sách chính sách đã duyệt.
 * Mặc định CAMPAIGN khi không khớp danh sách nào — giữ nguyên hành vi hiện có, không tự đoán.
 */
export function classifyPromoPolicy(code: string, unknownReviewCodes: readonly string[], clearanceCodes: readonly string[]): PolicyClassification {
  if (unknownReviewCodes.includes(code)) return 'UNKNOWN_REVIEW';
  if (clearanceCodes.includes(code)) return 'CLEARANCE';
  return 'CAMPAIGN';
}

/** RULE-04-001 — một vùng/cụm có nhiều mã: UNKNOWN_REVIEW nếu BẤT KỲ mã nào trong vùng chưa xác định loại (an toàn, không tự quyết một phần vùng). */
export function classifyPromoRegionPolicy(codes: readonly string[], unknownReviewCodes: readonly string[], clearanceCodes: readonly string[]): PolicyClassification {
  const classifications = codes.map(code => classifyPromoPolicy(code, unknownReviewCodes, clearanceCodes));
  if (classifications.includes('UNKNOWN_REVIEW')) return 'UNKNOWN_REVIEW';
  if (classifications.includes('CLEARANCE')) return 'CLEARANCE';
  return 'CAMPAIGN';
}

export function stockoutBaseline(sales: number, references: readonly number[]): number | null {
  return references.length >= 3 ? median(references) : null;
}

export function promoBaseline(references: readonly number[]): number | null {
  return references.length >= 3 ? median(references) : null;
}

export function classifyAbcRows(
  rows: readonly { id: string; annualValue: number; eligible?: boolean }[],
  thresholds = { aMaxCumulativeShare: 0.8, cMinCumulativeShare: 0.9 },
): Record<string, 'A' | 'B' | 'C' | 'N/A'> {
  const sorted = [...rows].sort((a, b) => b.annualValue - a.annualValue);
  const total = sorted.filter(row => row.eligible !== false).reduce((sum, row) => sum + row.annualValue, 0);
  let cumulative = 0;
  return Object.fromEntries(sorted.map((row, index) => {
    if (row.eligible === false) return [row.id, 'N/A'];
    cumulative += row.annualValue;
    const share = total ? cumulative / total : 0;
    return [row.id, index === 0 || share <= thresholds.aMaxCumulativeShare ? 'A' : share >= thresholds.cMinCumulativeShare ? 'C' : 'B'];
  }));
}

/**
 * Tài liệu giải pháp §Chặng 10 công thức: Sₚ = Rᵣ*,ₚ — tỷ lệ của VÒNG GẦN NHẤT đủ căn cứ tại vị
 * trí p, KHÔNG lấy trung bình/trung vị các vòng. Nhiều vòng chỉ dùng để tính tỷ lệ LẶP tín hiệu
 * (highRepeat/lowRepeat) — đó là hai việc khác nhau. `ratios` phải theo thứ tự vòng tăng dần theo
 * thời gian (vòng cũ nhất trước) để phần tử cuối cùng đúng là vòng gần nhất.
 */
export function classifySeasonPosition(ratios: readonly number[]): 'LẶP CAO' | 'LẶP THẤP' | 'CHƯA RÕ' {
  if (!ratios.length) return 'CHƯA RÕ';
  const sp = ratios[ratios.length - 1];
  const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
  const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
  if (sp >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) return 'LẶP CAO';
  if (sp <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat)) return 'LẶP THẤP';
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

/**
 * Chặng 14 §5.1 — tồn có thể sử dụng ngay = tồn thực tế trừ hàng giữ/hư hỏng/khóa/
 * không bán được, chặn dưới tại 0. Khác hoàn toàn calculateFreeStock/I_free (§9),
 * vốn được PHÉP âm để làm tín hiệu sớm cho thiếu hàng — không được gộp hai khái
 * niệm này lại với nhau.
 */
export function calculateAvailableStock(actualStock: number, heldStock: number, damagedStock: number, blockedStock: number, unsellableStock: number): { availableStock: number; mismatch: boolean } {
  const raw = actualStock - heldStock - damagedStock - blockedStock - unsellableStock;
  return { availableStock: Math.max(0, raw), mismatch: raw < 0 };
}

/** Nội suy tuyến tính phân vị p (0..1) trên mảng đã sắp xếp tăng dần; mảng rỗng trả về 0. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (!sortedAscending.length) return 0;
  if (sortedAscending.length === 1) return sortedAscending[0];
  const clamped = Math.min(1, Math.max(0, p));
  const index = clamped * (sortedAscending.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedAscending[lower];
  const weight = index - lower;
  return sortedAscending[lower] * (1 - weight) + sortedAscending[upper] * weight;
}

/**
 * Chặng 16 §8 — quy đổi số cần đặt (đơn vị lẻ) qua đúng 4 bước: đơn vị → carton,
 * áp sàn MOQ theo carton, làm tròn lên bội số order-step, rồi đổi ngược ra đơn vị.
 * Với unitsPerCarton=orderStep=1 (mặc định khi chưa có dữ liệu quy cách), công
 * thức này cho kết quả giống hệt ceil(raw/moq)*moq trước đây — không có regression.
 */
export function roundToPurchaseUnits(rawQuantity: number, unitsPerCarton: number, moqUnits: number, orderStepCartons: number): { orderedUnits: number; cartonsOrdered: number; moqSurplus: number } {
  if (rawQuantity <= 0) return { orderedUnits: 0, cartonsOrdered: 0, moqSurplus: 0 };
  const perCarton = Math.max(1, unitsPerCarton);
  const step = Math.max(1, orderStepCartons);
  const cartonsNeeded = Math.ceil(rawQuantity / perCarton);
  const moqCartons = Math.max(1, Math.ceil(Math.max(0, moqUnits) / perCarton));
  // Doc(26) §8.2: MOQ là SÀN, không phải bội số — cartonsNeeded>=MOQ dùng nguyên cartonsNeeded,
  // chỉ nâng lên MOQ khi 0<cartonsNeeded<MOQ. §8.3 mới làm tròn theo bước đặt hàng.
  const cartonsAtMoqFloor = Math.max(cartonsNeeded, moqCartons);
  const cartonsOrdered = Math.ceil(cartonsAtMoqFloor / step) * step;
  const orderedUnits = cartonsOrdered * perCarton;
  return { orderedUnits, cartonsOrdered, moqSurplus: orderedUnits - rawQuantity };
}

/** Chặng 15 §8 / Chặng 16 §10 — lượng tối đa bán được trước khi hết hạn dùng, quy đổi theo nhu cầu bình quân chu kỳ. Trả về Infinity khi SKU không có hạn dùng. */
export function sellableBeforeExpiry(averageDemandPerCycle: number, shelfLifeDays: number | null, cycleLength: number): number {
  if (!shelfLifeDays) return Infinity;
  return averageDemandPerCycle * shelfLifeDays / cycleLength;
}

/**
 * RULE-06-003/07-003 — chạy ngược từ chu kỳ gần nhất theo lịch, gom chu kỳ khóa liên tiếp, DỪNG
 * ngay khi gặp chu kỳ không khóa. KHÔNG bao giờ nối 2 đoạn khóa cách nhau bởi một khoảng
 * unresolved thành một chuỗi liên tục giả — khác hẳn `cycles.filter(cycle => cycle.locked)`
 * (xóa hẳn khoảng trống rồi ghép hai bên lại, vi phạm trực tiếp RULE-06-003/07-003).
 */
export function trailingLockedRun(cycles: readonly CycleRecord[]): CycleRecord[] {
  const run: CycleRecord[] = [];
  for (let index = cycles.length - 1; index >= 0; index--) {
    if (!cycles[index].locked) break;
    run.unshift(cycles[index]);
  }
  return run;
}

/**
 * RULE-07-003 — cửa sổ CỐ ĐỊNH đúng `size` vị trí chu kỳ gần nhất theo lịch (không phải `size`
 * chu kỳ khóa gần nhất) — giữ nguyên mọi vị trí kể cả chu kỳ không khóa, để phát hiện đứt quãng.
 * `blocked=true` ngay khi có ít nhất một vị trí trong cửa sổ không khóa; `blockingStatus` là
 * trạng thái của vị trí không khóa gần nhất theo lịch (vị trí đầu tiên gặp khi dò ngược từ cuối).
 */
export function fixedCalendarWindow(cycles: readonly CycleRecord[], size: number): { window: CycleRecord[]; blocked: boolean; blockingStatus: CycleStatus | null } {
  const window = cycles.slice(-size);
  for (let index = window.length - 1; index >= 0; index--) {
    if (!window[index].locked) return { window, blocked: true, blockingStatus: window[index].status };
  }
  return { window, blocked: false, blockingStatus: null };
}

/**
 * RULE-05-006 — cửa sổ ABC là đúng `size` vị trí chu kỳ gần nhất theo lịch, GIỮ NGUYÊN mọi vị trí
 * (kể cả chu kỳ không khóa) để audit. RULE-06-003 (đặc thù Chặng 6, ưu tiên cao hơn cho quyết định
 * năm hóa): chỉ đoạn chu kỳ khóa LIÊN TIẾP kết thúc tại chu kỳ đủ điều kiện gần nhất mới được năm
 * hóa — "Không đếm các chu kỳ khóa nằm rải rác ở hai phía của một khoảng unresolved như một đoạn
 * liên tiếp". Vì vậy `eligible`/`lockedCycleCount`/`periodQuantity` dùng `trailingLockedRun` trong
 * cửa sổ, KHÔNG đếm mọi CK khóa rải rác trong `window` (đã sửa lại theo đúng RULE-06-003, một bản
 * trước đây đổi sang đếm rải rác trích dẫn "§2.1 LỆNH CODEX" — không tồn tại trong bộ tài liệu
 * governance, không có căn cứ để ghi đè RULE-06-003). `fullCoverage` chỉ true khi đủ `size` vị trí
 * VÀ toàn bộ đã khóa.
 */
export function calendarWindowAbcMetrics(cycles: readonly CycleRecord[], size: number, minimumLocked: number): {
  window: CycleRecord[]; lockedCycles: CycleRecord[]; lockedCycleCount: number; periodQuantity: number; eligible: boolean; fullCoverage: boolean;
} {
  const window = cycles.slice(-size);
  const lockedCycles = trailingLockedRun(window);
  const periodQuantity = lockedCycles.reduce((sum, cycle) => sum + cycle.baseDemand, 0);
  return {
    window, lockedCycles, lockedCycleCount: lockedCycles.length, periodQuantity,
    eligible: lockedCycles.length >= minimumLocked,
    fullCoverage: window.length === size && lockedCycles.length === size,
  };
}

export function classifyXyz(
  values: readonly number[],
  thresholds = { zMinAdi: 1.32, xMaxCv2: 0.49 },
): {
  xyz: 'X' | 'Y' | 'Z' | 'D' | null; n: number; m: number; adi: number | null;
  positiveMean: number | null; positiveStdev: number | null; cv: number | null; cv2: number | null;
} {
  const n = values.length;
  const positive = values.filter(value => value > 0);
  const m = positive.length;
  if (n < 6) return { xyz: 'D', n, m, adi: null, positiveMean: null, positiveStdev: null, cv: null, cv2: null };
  // RULE-07-004 — cửa sổ đủ dài (n≥6) nhưng không có chu kỳ dương nào: KHÔNG được gán D (đó là lý
  // do dành cho lịch sử thật sự ngắn), và KHÔNG tính ADI bằng phép chia cho 0. Caller (runStage7)
  // đọc xyz=null + n≥6 để gán classificationStatus='NO_POSITIVE_DEMAND_REVIEW'.
  if (!m) return { xyz: null, n, m, adi: null, positiveMean: null, positiveStdev: null, cv: null, cv2: null };
  const adi = n / m;
  const positiveMean = mean(positive);
  const positiveStdev = populationStdev(positive);
  const cv = positiveMean ? positiveStdev / positiveMean : null;
  const cv2 = cv === null ? null : cv ** 2;
  if (adi > thresholds.zMinAdi) return { xyz: 'Z', n, m, adi, positiveMean, positiveStdev, cv, cv2 };
  return { xyz: (cv2 ?? Infinity) <= thresholds.xMaxCv2 ? 'X' : 'Y', n, m, adi, positiveMean, positiveStdev, cv, cv2 };
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

export function calculateRmse(actual: readonly number[], forecast: readonly number[]): number | null {
  if (!actual.length) return null;
  const errors = actual.map((value, index) => value - (forecast[index] ?? 0));
  return Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
}

export function calculateNrmse(actual: readonly number[], forecast: readonly number[]): number | null {
  const rmse = calculateRmse(actual, forecast);
  const actualMean = mean(actual);
  return rmse !== null && actualMean > 0 ? rmse / actualMean : null;
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
