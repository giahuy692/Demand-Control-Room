import { describe, expect, it } from 'vitest';
import { qualifySelection, selectReferences } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';
import { BaseDemandSource, DailyRecord, PromotionStatus, SalesObservationStatus, StockoutStatus, TechnicalFillStatus } from './models';

function record(index: number): DailyRecord {
  return {
    sku: 'TEST', barcode: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: 5,
    salesObservationStatus: SalesObservationStatus.RECORDED_SALE, isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasSalesRecord: true, receiptHour: null, promoCode: null, promotionStatus: PromotionStatus.NONE, stockoutStatus: StockoutStatus.NONE,
    baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP, isCleanObservedReference: false, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [],
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

describe('Tài liệu giải pháp §Chặng 3 mục 8 — chỉ cận DƯỚI khóa vĩnh viễn, cận TRÊN phải giữ TẠM · KIỂM TRA', () => {
  it('ngày gần CUỐI mảng (phía sau bị cắt bởi rìa mảng — gần ngày hiện tại, tương lai còn phát sinh thêm ngày sạch) → giữ temporary, KHÔNG khóa fixed', () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index));
    const targetIndex = 28; // chỉ còn 1 ngày sau (index 29) trước khi hết mảng.
    const raw = selectReferences(records, targetIndex, targetIndex, DEFAULT_POLICY);
    const qualified = qualifySelection(raw, records.length, targetIndex, targetIndex);

    expect(qualified.status).toBe('temporary');
    expect(qualified.reason).not.toContain('[BOUNDARY_REFERENCE]');
    expect(qualified.reason).toContain('cận trên');
  });

  it('ngày gần ĐẦU mảng (phía trước bị cắt bởi rìa mảng — đầu lịch sử đã đóng) → khóa fixed KHÔNG CÂN BẰNG CỐ ĐỊNH', () => {
    const records = Array.from({ length: 30 }, (_, index) => record(index));
    const targetIndex = 1; // chỉ còn 1 ngày trước (index 0) trước khi hết mảng.
    const raw = selectReferences(records, targetIndex, targetIndex, DEFAULT_POLICY);
    const qualified = qualifySelection(raw, records.length, targetIndex, targetIndex);

    expect(qualified.status).toBe('fixed');
    expect(qualified.reason).toContain('[BOUNDARY_REFERENCE]');
    expect(qualified.reason).toContain('cận dưới');
  });
});
