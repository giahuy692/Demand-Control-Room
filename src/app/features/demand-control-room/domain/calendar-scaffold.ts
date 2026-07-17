import { ExtractMetadata, PromotionInterval } from './catalog';
import {
  BaseDemandSource,
  DailyRecord,
  isBaselineExcludedPromo,
  PromotionClass,
  PromotionStatus,
  SalesObservationStatus,
  StockCalculationStatus,
  StockoutStatus,
  TechnicalFillStatus,
} from './models';

function addDaysIso(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function classifyStockStatus(openStock: number | null, closeStock: number | null): StockCalculationStatus {
  if (openStock === null || closeStock === null) return 'ANCHOR_MISSING';
  if (openStock < 0 || closeStock < 0) return 'NEGATIVE_REVIEW';
  return 'CALCULATED';
}

function salesObservation(date: string, hasSalesRecord: boolean, sales: number | null, metadata: ExtractMetadata): Pick<DailyRecord, 'hasSalesRecord' | 'sales' | 'salesObservationStatus'> {
  if (hasSalesRecord) {
    if (sales === null || sales < 0) throw new Error(`Bất biến sales vỡ tại ${date}: hasSalesRecord=true yêu cầu sales >= 0.`);
    return { hasSalesRecord: true, sales, salesObservationStatus: SalesObservationStatus.RECORDED_SALE };
  }
  if (metadata.extractionCompleted && date <= metadata.salesDataThroughDate) {
    return { hasSalesRecord: false, sales: 0, salesObservationStatus: SalesObservationStatus.CONFIRMED_ZERO };
  }
  return { hasSalesRecord: false, sales: null, salesObservationStatus: SalesObservationStatus.SOURCE_DATA_GAP };
}

function promotionFor(date: string, intervals: readonly PromotionInterval[]): { code: string | null; promotionClass: PromotionClass | null } {
  const active = intervals.filter(interval => interval.startDate <= date && date <= interval.endDate);
  if (!active.length) return { code: null, promotionClass: null };
  const codes = [...new Set(active.map(interval => interval.code))];
  // Nhiều CTKM chồng ngày: chỉ cần MỘT chương trình kích cầu mạnh/chưa phân loại là ngày
  // đó không còn là mức bán tự nhiên — lấy class "mạnh nhất" theo thứ tự loại trừ baseline.
  const classes = active.map(interval => interval.promotionClass);
  const promotionClass: PromotionClass = classes.includes('DEEP_PROMO')
    ? 'DEEP_PROMO'
    : classes.includes('PROMOTION_UNRESOLVED')
      ? 'PROMOTION_UNRESOLVED'
      : 'ALWAYS_ON';
  return { code: codes.join('|'), promotionClass };
}

/** promotionStatus đi theo phân loại CTKM: chỉ DEEP_PROMO (mechanismType 2/7) mới loại ngày khỏi baseline (Chặng 3 → Chặng 4). */
function promotionStatusFor(promotionClass: PromotionClass): PromotionStatus {
  return isBaselineExcludedPromo(promotionClass) ? PromotionStatus.PROMOTION : PromotionStatus.NONE;
}

function scaffoldRecord(sku: string, barcode: string, date: string, isReferenceOnly: boolean, stock: number | null, metadata: ExtractMetadata, promoCode: string | null, promotionClass: PromotionClass): DailyRecord {
  return {
    sku, barcode, date, openStock: stock, closeStock: stock,
    ...salesObservation(date, false, null, metadata),
    isReferenceOnly, stockCalculationStatus: classifyStockStatus(stock, stock), stockSource: 'CARRIED_FORWARD',
    receiptHour: null, promoCode, promotionStatus: promotionStatusFor(promotionClass),
    stockoutStatus: StockoutStatus.NONE, baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP,
    isCleanObservedReference: false, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '',
    storeCode: 11,
    productCode: Number(sku.replace('SKU-', '')) || 1,
    promotionName: null,
    promotionStartDate: null,
    promotionEndDate: null,
    promotionType: null,
    promotionMechanismType: null,
    promotionClass,
    stockStatus: stock === null ? 'ANCHOR_MISSING' : stock < 0 ? 'NEGATIVE_STOCK' : 'CALCULATED',
  };
}

/** Tạo lịch SKU × ngày, left join nguồn thưa và phân loại ngày không có sales bằng watermark đã xác nhận. */
export function buildCalendarScaffold(
  sku: string,
  sourceRows: readonly DailyRecord[],
  startIso: string,
  endIso: string,
  isReferenceOnlyAt: (iso: string) => boolean,
  metadata: ExtractMetadata = { salesDataThroughDate: '0000-01-01', stockDataThroughDate: '0000-01-01', extractionCompleted: false },
  promotionIntervals: readonly PromotionInterval[] = [],
  openingAnchor: number | null = null,
): DailyRecord[] {
  const bySourceDate = new Map(sourceRows.map(row => [row.date, row]));
  const result: DailyRecord[] = [];
  const barcode = sourceRows[0]?.barcode ?? sku;
  let previousClose = openingAnchor;
  for (let date = startIso; date <= endIso; date = addDaysIso(date, 1)) {
    const existing = bySourceDate.get(date);
    const intervalPromo = promotionFor(date, promotionIntervals);
    const promoCode = [existing?.promoCode, intervalPromo.code].filter(Boolean).join('|') || null;
    if (existing) {
      const openStock = existing.openStock;
      const closeStock = existing.closeStock;
      // Dòng nguồn là thẩm quyền phân loại của chính nó (PromotionClass do SQL/DTO tính từ
      // tbl_POLPromotion.[Type]); interval chỉ bổ sung khi dòng nguồn KHÔNG ghi nhận CTKM
      // (ngày trong khoảng KM nhưng bán không gắn mã). Không còn mặc nhiên ép DEEP_PROMO.
      const promotionClass: PromotionClass = !promoCode
        ? 'NO_PROMOTION'
        : existing.promotionClass !== 'NO_PROMOTION'
          ? existing.promotionClass
          : intervalPromo.promotionClass ?? 'DEEP_PROMO';
      result.push({
        ...existing,
        ...salesObservation(date, existing.hasSalesRecord, existing.sales, metadata),
        promoCode,
        promotionStatus: promotionStatusFor(promotionClass),
        isReferenceOnly: isReferenceOnlyAt(date),
        stockSource: 'OBSERVED',
        stockCalculationStatus: classifyStockStatus(openStock, closeStock),
        promotionClass,
      });
      previousClose = closeStock;
    } else {
      result.push(scaffoldRecord(sku, barcode, date, isReferenceOnlyAt(date), previousClose, metadata, promoCode, intervalPromo.promotionClass ?? (promoCode ? 'DEEP_PROMO' : 'NO_PROMOTION')));
    }
  }
  return result;
}
