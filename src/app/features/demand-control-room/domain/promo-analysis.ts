import { DailyRecord, isBaselineExcludedPromo } from './models';

export interface PromoRegionSample {
  startDate: string;
  endDate: string;
  codes: string[];
  rows: DailyRecord[];
  actualSales: number;
  naturalBase: number;
  factor: number | null;
  eligible: boolean;
  rejectionReason: string | null;
}

/** Dựng đúng vùng/cụm CTKM mà Chặng 4 đã xử lý, sau đó tính một mẫu K cho cả vùng. */
export function buildPromoRegionSamples(daily: readonly DailyRecord[]): PromoRegionSample[] {
  const regions: { rows: DailyRecord[]; codes: string[] }[] = [];
  // Vùng học K phải khớp đúng vùng Chặng 4 đã chuẩn hóa: chỉ ngày DEEP_PROMO (mech 2/7).
  // Ngày ALWAYS_ON/PROMOTION_UNRESOLVED giữ Sales làm nền tự nhiên nên KHÔNG tạo vùng —
  // tránh SKU chỉ có ưu đãi thường trực bị báo 'blocked' oan dù không có gì phải học.
  const isRegionDay = (row: DailyRecord): boolean => !!row.promoCode && isBaselineExcludedPromo(row.promotionClass);
  for (let index = 0; index < daily.length; index++) {
    if (!isRegionDay(daily[index])) continue;
    const code = daily[index].promoCode!;
    const rows = [daily[index]];
    while (index + 1 < daily.length && isRegionDay(daily[index + 1]) && daily[index + 1].promoCode === code) rows.push(daily[++index]);

    const previous = regions.at(-1);
    if (previous) {
      const previousReferences = previous.rows[0].referenceDates.join('|');
      const currentReferences = rows[0].referenceDates.join('|');
      if (previousReferences && previousReferences === currentReferences) {
        previous.rows.push(...rows);
        previous.codes = [...new Set([...previous.codes, code])];
        continue;
      }
    }
    regions.push({ rows, codes: [code] });
  }

  return regions.map(region => {
    // RULE-01-001 — ngày CTKM có thể là scaffold (sales=null, chưa có nguồn thật); tổng actualSales
    // chỉ mang tính hiển thị bằng chứng, KHÔNG dùng để quyết định K vì missingUnknownSales/missingBase
    // bên dưới đã loại toàn bộ vùng có ngày sales=null khỏi việc tính hệ số K [DEC-006/007].
    const missingUnknownSales = region.rows.some(row => row.sales === null);
    const actualSales = region.rows.reduce((sum, row) => sum + (row.sales ?? 0), 0);
    const naturalBase = region.rows.reduce((sum, row) => sum + (row.baseDemand ?? 0), 0);
    const hasStockout = region.rows.some(row => row.stockoutStatus !== 'NONE');
    const missingBase = region.rows.some(row => row.baseDemandSource !== 'PROMOTION_BASELINE' || row.baseDemand === null);
    const rejectionReason = hasStockout
      ? 'Vùng có stockout, số bán bị bóp méo.'
      : missingUnknownSales
        ? 'Có ngày chưa có nguồn bán thật (scaffold), không đủ căn cứ tính K.'
        : missingBase
          ? 'Có ngày chưa được Chặng 4 khóa nền tự nhiên.'
          : naturalBase <= 0
            ? 'Tổng nền tự nhiên của vùng không dương.'
            : null;
    return {
      startDate: region.rows[0].date,
      endDate: region.rows.at(-1)!.date,
      codes: region.codes,
      rows: region.rows,
      actualSales,
      naturalBase,
      factor: rejectionReason ? null : actualSales / naturalBase,
      eligible: rejectionReason === null,
      rejectionReason,
    };
  });
}
