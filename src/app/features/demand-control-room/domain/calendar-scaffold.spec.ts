import { describe, expect, it } from 'vitest';
import { buildCalendarScaffold } from './calendar-scaffold';
import { BaseDemandSource, DailyRecord, PromotionStatus, SalesObservationStatus, StockoutStatus, TechnicalFillStatus } from './models';

function sourceRow(date: string, sales: number, extra: Partial<DailyRecord> = {}): DailyRecord {
  return {
    sku: 'P1', barcode: 'B1', date, openStock: 10, closeStock: 10 - sales, sales, hasSalesRecord: true,
    receiptHour: null, promoCode: null, promotionStatus: PromotionStatus.NONE, stockoutStatus: StockoutStatus.NONE,
    baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP, isCleanObservedReference: false, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [],
    referenceMedian: null, balanceStatus: null, selectionReason: '', salesObservationStatus: SalesObservationStatus.RECORDED_SALE, isReferenceOnly: false,
    stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    ...extra,
  };
}

describe('buildCalendarScaffold — RULE-01-001 tạo lịch liên tục', () => {
  it('GT-01: SQL thưa có ngày 1 và 3 → module tạo ngày 2 với hasRecord=false, sales=null', () => {
    const rows = [sourceRow('2026-01-01', 5), sourceRow('2026-01-03', 7)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-03', () => false);

    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2026-01-01');
    expect(result[0].hasSalesRecord).toBe(true);
    expect(result[1].date).toBe('2026-01-02');
    expect(result[1].hasSalesRecord).toBe(false);
    expect(result[1].sales).toBeNull();
    expect(result[1].salesObservationStatus).toBe('SOURCE_DATA_GAP');
    expect(result[2].date).toBe('2026-01-03');
    expect(result[2].hasSalesRecord).toBe(true);
  });

  it('GT-02: ngày scaffold không được xem là số 0 quan sát hoặc ngày sạch', () => {
    const rows = [sourceRow('2026-01-01', 5)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);
    const scaffoldDay = result[1];

    expect(scaffoldDay.sales).toBeNull();
    expect(scaffoldDay.sales).not.toBe(0);
    expect(scaffoldDay.salesObservationStatus).toBe('SOURCE_DATA_GAP');
  });

  it('DEC-006/007: ngày nguồn có Qty=0 thật được gắn OBSERVED_ZERO, khác hẳn scaffold SOURCE_UNKNOWN', () => {
    const rows = [sourceRow('2026-01-01', 0)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false);

    expect(result[0].sales).toBe(0);
    expect(result[0].salesObservationStatus).toBe('RECORDED_SALE');
    expect(result[0].hasSalesRecord).toBe(true);
  });

  it('không tạo dòng ngoài khoảng [startIso, endIso]', () => {
    const rows = [sourceRow('2025-12-31', 9), sourceRow('2026-01-05', 9)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);

    expect(result.map(row => row.date)).toEqual(['2026-01-01', '2026-01-02']);
    expect(result.every(row => row.hasSalesRecord === false)).toBe(true);
  });

  it('RULE-01-003: gắn đúng isReferenceOnly theo hàm phân loại truyền vào, không phụ thuộc hasRecord', () => {
    const rows = [sourceRow('2026-01-01', 4), sourceRow('2026-01-03', 6)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-03', iso => iso < '2026-01-03');

    expect(result[0].isReferenceOnly).toBe(true);
    expect(result[1].isReferenceOnly).toBe(true);
    expect(result[2].isReferenceOnly).toBe(false);
  });

  it('dòng trùng ngày trong nguồn: giữ bản ghi cuối cùng, không nhân đôi ngày', () => {
    const rows = [sourceRow('2026-01-01', 4), sourceRow('2026-01-01', 9)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false);

    expect(result).toHaveLength(1);
    expect(result[0].sales).toBe(9);
  });
});

describe('buildCalendarScaffold — phân loại CTKM theo PromotionClass (02-Hop-dong-du-lieu-dau-vao.md)', () => {
  const COMPLETE = { salesDataThroughDate: '2026-12-31', stockDataThroughDate: '2026-12-31', extractionCompleted: true };

  it('ALWAYS_ON: dòng nguồn giữ nguyên class, promotionStatus=NONE — Sales vẫn là mức bán nền, KHÔNG bị ép DEEP_PROMO', () => {
    const rows = [sourceRow('2026-01-01', 5, { promoCode: '888', promotionClass: 'ALWAYS_ON' })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false, COMPLETE);

    expect(result[0].promotionClass).toBe('ALWAYS_ON');
    expect(result[0].promotionStatus).toBe(PromotionStatus.NONE);
  });

  it('DEEP_PROMO: dòng nguồn mang promotionStatus=PROMOTION để Chặng 3 loại khỏi baseline và chuyển Chặng 4', () => {
    const rows = [sourceRow('2026-01-01', 50, { promoCode: '999', promotionClass: 'DEEP_PROMO' })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false, COMPLETE);

    expect(result[0].promotionClass).toBe('DEEP_PROMO');
    expect(result[0].promotionStatus).toBe(PromotionStatus.PROMOTION);
  });

  it('ngày scaffold trong khoảng interval nhận đúng class của interval — ALWAYS_ON không còn mặc nhiên thành DEEP_PROMO', () => {
    const rows = [sourceRow('2026-01-01', 5)];
    const intervals = [{ sku: 'P1', code: 'KM-TT', name: null, startDate: '2026-01-02', endDate: '2026-01-02', promotionClass: 'ALWAYS_ON' as const }];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[1].promoCode).toBe('KM-TT');
    expect(result[1].promotionClass).toBe('ALWAYS_ON');
    expect(result[1].promotionStatus).toBe(PromotionStatus.NONE);
  });

  it('hai interval chồng ngày: chỉ cần một DEEP_PROMO là ngày mất tư cách mức bán tự nhiên', () => {
    const rows = [sourceRow('2026-01-01', 5)];
    const intervals = [
      { sku: 'P1', code: 'KM-TT', name: null, startDate: '2026-01-02', endDate: '2026-01-02', promotionClass: 'ALWAYS_ON' as const },
      { sku: 'P1', code: 'KM-SAU', name: null, startDate: '2026-01-02', endDate: '2026-01-02', promotionClass: 'DEEP_PROMO' as const },
    ];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[1].promotionClass).toBe('DEEP_PROMO');
    expect(result[1].promotionStatus).toBe(PromotionStatus.PROMOTION);
  });

  it('dòng nguồn NO_PROMOTION nằm trong interval ALWAYS_ON: nhận class của interval, vẫn là ngày bán bình thường', () => {
    const rows = [sourceRow('2026-01-02', 5, { promotionClass: 'NO_PROMOTION' })];
    const intervals = [{ sku: 'P1', code: 'KM-TT', name: null, startDate: '2026-01-01', endDate: '2026-01-03', promotionClass: 'ALWAYS_ON' as const }];
    const result = buildCalendarScaffold('P1', rows, '2026-01-02', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[0].promotionClass).toBe('ALWAYS_ON');
    expect(result[0].promotionStatus).toBe(PromotionStatus.NONE);
  });

  it('ngày scaffold (không có dòng nguồn) trong khoảng interval mang đúng tên CTKM của interval, không rơi về null', () => {
    const rows = [sourceRow('2026-01-01', 5)];
    const intervals = [{ sku: 'P1', code: 'KM-TT', name: 'ƯU ĐÃI BEST PRICE', startDate: '2026-01-02', endDate: '2026-01-02', promotionClass: 'DEEP_PROMO' as const }];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[1].promoCode).toBe('KM-TT');
    expect(result[1].promotionName).toBe('ƯU ĐÃI BEST PRICE');
  });

  it('dòng nguồn có promoCode nhưng không tự mang tên: lấy tên từ interval trùng ngày thay vì để null', () => {
    const rows = [sourceRow('2026-01-02', 50, { promoCode: 'KM-TT', promotionClass: 'DEEP_PROMO', promotionName: null })];
    const intervals = [{ sku: 'P1', code: 'KM-TT', name: 'ƯU ĐÃI BEST PRICE', startDate: '2026-01-01', endDate: '2026-01-03', promotionClass: 'DEEP_PROMO' as const }];
    const result = buildCalendarScaffold('P1', rows, '2026-01-02', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[0].promotionName).toBe('ƯU ĐÃI BEST PRICE');
  });

  it('dòng nguồn đã tự mang tên riêng thì giữ nguyên, không bị interval ghi đè', () => {
    const rows = [sourceRow('2026-01-02', 50, { promoCode: 'KM-TT', promotionClass: 'DEEP_PROMO', promotionName: 'TÊN GỐC TỪ SQL' })];
    const intervals = [{ sku: 'P1', code: 'KM-TT', name: 'TÊN INTERVAL KHÁC', startDate: '2026-01-01', endDate: '2026-01-03', promotionClass: 'DEEP_PROMO' as const }];
    const result = buildCalendarScaffold('P1', rows, '2026-01-02', '2026-01-02', () => false, COMPLETE, intervals);

    expect(result[0].promotionName).toBe('TÊN GỐC TỪ SQL');
  });
});

describe('buildCalendarScaffold — RULE-02: tính tồn ngày scaffold (02-Hop-dong-du-lieu-dau-vao.md §6)', () => {
  it('ngày nguồn thật giữ nguyên openStock/closeStock, gắn stockSource=OBSERVED, stockCalculationStatus=CALCULATED', () => {
    const rows = [sourceRow('2026-01-01', 5, { openStock: 20, closeStock: 15 })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false);

    expect(result[0].openStock).toBe(20);
    expect(result[0].closeStock).toBe(15);
    expect(result[0].stockSource).toBe('OBSERVED');
    expect(result[0].stockCalculationStatus).toBe('CALCULATED');
  });

  it('RULE-02-003/DEC-005/06 §6: ngày scaffold mang tồn cuối ngày trước sang (O_d=C_{d-1}, C_d=O_d), gắn CARRIED_FORWARD', () => {
    const rows = [sourceRow('2026-01-01', 5, { openStock: 20, closeStock: 15 })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);
    const scaffoldDay = result[1];

    expect(scaffoldDay.openStock).toBe(15);
    expect(scaffoldDay.closeStock).toBe(15);
    expect(scaffoldDay.stockSource).toBe('CARRIED_FORWARD');
    expect(scaffoldDay.stockCalculationStatus).toBe('CALCULATED');
  });

  it('ngày scaffold đầu tiên của khung, không có mốc trước đó → ANCHOR_MISSING, không suy diễn tồn', () => {
    const result = buildCalendarScaffold('P1', [], '2026-01-01', '2026-01-01', () => false);

    expect(result[0].stockCalculationStatus).toBe('ANCHOR_MISSING');
    expect(result[0].stockSource).toBe('CARRIED_FORWARD');
  });

  it('GT-06/RULE-02-003: tồn âm được GIỮ NGUYÊN số âm, gắn NEGATIVE_REVIEW, không tự đổi thành 0', () => {
    const rows = [sourceRow('2026-01-01', 5, { openStock: 10, closeStock: -3 })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false);

    expect(result[0].closeStock).toBe(-3);
    expect(result[0].stockCalculationStatus).toBe('NEGATIVE_REVIEW');
  });

  it('tồn âm mang sang ngày scaffold kế tiếp vẫn giữ NEGATIVE_REVIEW, không âm thầm làm tròn 0', () => {
    const rows = [sourceRow('2026-01-01', 5, { openStock: 10, closeStock: -3 })];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);

    expect(result[1].openStock).toBe(-3);
    expect(result[1].closeStock).toBe(-3);
    expect(result[1].stockCalculationStatus).toBe('NEGATIVE_REVIEW');
  });
});
