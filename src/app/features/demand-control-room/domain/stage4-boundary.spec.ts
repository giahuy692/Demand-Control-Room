import { describe, expect, it } from 'vitest';
import { qualifySelection, selectReferences } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';
import { DailyRecord } from './models';

function record(index: number): DailyRecord {
  return {
    sku: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: 5,
    salesStatus: 'OBSERVED', isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasRecord: true, receiptHour: null, promoCode: null, isStockout: false, stockoutReviewRequired: false, stockoutReason: null,
    baseDemand: null, baseSource: null, referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [],
    referenceMedian: null, balanceStatus: null, selectionReason: '',
  };
}

describe('RULE-04-003 — BOUNDARY_REFERENCE tách biệt khỏi UNBALANCED_FIXED do thiếu dữ liệu thường', () => {
  it('ngày ở sát đầu mảng (chỉ 1 ngày sạch phía trước) → gắn cờ [BOUNDARY_REFERENCE], không lẫn với lý do "thiếu dữ liệu"', () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index));
    const raw = selectReferences(records, 1, 1, DEFAULT_POLICY);
    const qualified = qualifySelection(raw, records.length, 1, 1);

    expect(qualified.status).toBe('fixed');
    expect(qualified.reason).toContain('[BOUNDARY_REFERENCE]');
    expect(qualified.reason).toContain('Biên lịch sử đã đóng');
  });

  it('ngày ở giữa mảng, đủ dữ liệu hai phía → không gắn BOUNDARY_REFERENCE', () => {
    const records = Array.from({ length: 60 }, (_, index) => record(index));
    const raw = selectReferences(records, 30, 30, DEFAULT_POLICY);
    const qualified = qualifySelection(raw, records.length, 30, 30);

    expect(qualified.reason).not.toContain('[BOUNDARY_REFERENCE]');
  });
});
