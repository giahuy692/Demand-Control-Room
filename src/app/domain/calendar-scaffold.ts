import { DailyRecord, SalesStatus, StockCalculationStatus } from './models';

function addDaysIso(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function classifySalesStatus(sales: number | null): SalesStatus {
  // DEC-W03 (chờ dữ liệu): chưa có trạng thái POS-đầy-đủ theo ngày để phân biệt
  // CONFIRMED_ZERO/OUTSIDE_ACTIVE_PERIOD khỏi SOURCE_UNKNOWN — mọi dòng nguồn thật
  // hiện tại luôn có Sales là số cụ thể (ingest bắt buộc), nên chỉ 2 nhánh này thật sự đạt tới.
  if (sales === null) return 'SOURCE_UNKNOWN';
  return sales > 0 ? 'OBSERVED' : 'OBSERVED_ZERO';
}

/** RULE-02-003 — tồn âm PHẢI giữ nguyên số âm và gắn NEGATIVE_REVIEW, không tự đổi thành 0. */
function classifyStockStatus(openStock: number, closeStock: number, carriedFromMissingAnchor: boolean): StockCalculationStatus {
  if (carriedFromMissingAnchor) return 'ANCHOR_MISSING';
  if (openStock < 0 || closeStock < 0) return 'NEGATIVE_REVIEW';
  return 'CALCULATED';
}

function scaffoldRecord(sku: string, date: string, isReferenceOnly: boolean, openStock: number, closeStock: number, stockCalculationStatus: StockCalculationStatus): DailyRecord {
  return {
    sku, date, openStock, closeStock, sales: null, salesStatus: 'SOURCE_UNKNOWN',
    hasRecord: false, receiptHour: null, promoCode: null,
    isStockout: false, stockoutReason: null, stockoutReviewRequired: false, baseDemand: null, baseSource: null,
    referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '', isReferenceOnly,
    stockSource: 'CARRIED_FORWARD', stockCalculationStatus,
  };
}

/**
 * RULE-01-001 (04 §4) — tạo lịch liên tục cho một SKU trong [startIso, endIso] (hai đầu bao gồm).
 * Ngày đã có trong `sourceRows` được giữ nguyên (chỉ gán lại salesStatus/isReferenceOnly/trạng thái
 * tồn); ngày không có nguồn thật được chèn thêm dạng scaffold: hasRecord=false, sales=null,
 * salesStatus='SOURCE_UNKNOWN' — KHÔNG được suy diễn thành bán=0 [DEC-006, DEC-007, GT-01, GT-02].
 * `isReferenceOnlyAt(iso)` phân loại ngày nào thuộc vùng đọc tham chiếu trước khung xử lý (RULE-01-003).
 *
 * RULE-02-003/02-Hop-dong-du-lieu-dau-vao.md §6 — ngày scaffold mang tồn cuối ngày trước sang
 * (O_d=C_{d-1}, C_d=O_d), gắn stockSource=CARRIED_FORWARD; ngày đầu tiên của cả khoảng không có
 * mốc trước đó (`openingAnchor=null`) được gắn ANCHOR_MISSING thay vì suy diễn tồn=0. Tồn âm được
 * mang tiếp NGUYÊN VẸN (không clamp 0) và tiếp tục gắn NEGATIVE_REVIEW ở các ngày kế tiếp.
 */
export function buildCalendarScaffold(sku: string, sourceRows: readonly DailyRecord[], startIso: string, endIso: string, isReferenceOnlyAt: (iso: string) => boolean, openingAnchor: number | null = null): DailyRecord[] {
  const bySourceDate = new Map<string, DailyRecord>();
  for (const row of sourceRows) bySourceDate.set(row.date, row); // Trùng ngày: giữ bản ghi cuối cùng — không nhân đôi ngày trong lịch.
  const result: DailyRecord[] = [];
  let previousClose = openingAnchor;
  for (let iso = startIso; iso <= endIso; iso = addDaysIso(iso, 1)) {
    const existing = bySourceDate.get(iso);
    const isReferenceOnly = isReferenceOnlyAt(iso);
    if (existing) {
      const stockCalculationStatus = classifyStockStatus(existing.openStock, existing.closeStock, false);
      result.push({ ...existing, salesStatus: classifySalesStatus(existing.sales), isReferenceOnly, stockSource: 'OBSERVED', stockCalculationStatus });
      previousClose = existing.closeStock;
    } else {
      const anchorMissing = previousClose === null;
      const value = previousClose ?? 0;
      const stockCalculationStatus = classifyStockStatus(value, value, anchorMissing);
      result.push(scaffoldRecord(sku, iso, isReferenceOnly, value, value, stockCalculationStatus));
      previousClose = value;
    }
  }
  return result;
}
