import { describe, expect, it } from 'vitest';
import { buildCalendarScaffold } from './calendar-scaffold';
import { DailyRecord } from './models';

function sourceRow(date: string, sales: number, extra: Partial<DailyRecord> = {}): DailyRecord {
  return {
    sku: 'P1', date, openStock: 10, closeStock: 10 - sales, sales, hasRecord: true,
    receiptHour: null, promoCode: null, isStockout: false, stockoutReviewRequired: false, stockoutReason: null,
    baseDemand: null, baseSource: null, referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [],
    referenceMedian: null, balanceStatus: null, selectionReason: '', salesStatus: 'OBSERVED', isReferenceOnly: false,
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
    expect(result[0].hasRecord).toBe(true);
    expect(result[1].date).toBe('2026-01-02');
    expect(result[1].hasRecord).toBe(false);
    expect(result[1].sales).toBeNull();
    expect(result[1].salesStatus).toBe('SOURCE_UNKNOWN');
    expect(result[2].date).toBe('2026-01-03');
    expect(result[2].hasRecord).toBe(true);
  });

  it('GT-02: ngày scaffold không được xem là số 0 quan sát hoặc ngày sạch', () => {
    const rows = [sourceRow('2026-01-01', 5)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);
    const scaffoldDay = result[1];

    expect(scaffoldDay.sales).toBeNull();
    expect(scaffoldDay.sales).not.toBe(0);
    expect(scaffoldDay.salesStatus).not.toBe('OBSERVED_ZERO');
    expect(scaffoldDay.salesStatus).not.toBe('CONFIRMED_ZERO');
  });

  it('DEC-006/007: ngày nguồn có Qty=0 thật được gắn OBSERVED_ZERO, khác hẳn scaffold SOURCE_UNKNOWN', () => {
    const rows = [sourceRow('2026-01-01', 0)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-01', () => false);

    expect(result[0].sales).toBe(0);
    expect(result[0].salesStatus).toBe('OBSERVED_ZERO');
    expect(result[0].hasRecord).toBe(true);
  });

  it('không tạo dòng ngoài khoảng [startIso, endIso]', () => {
    const rows = [sourceRow('2025-12-31', 9), sourceRow('2026-01-05', 9)];
    const result = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-02', () => false);

    expect(result.map(row => row.date)).toEqual(['2026-01-01', '2026-01-02']);
    expect(result.every(row => row.hasRecord === false)).toBe(true);
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
