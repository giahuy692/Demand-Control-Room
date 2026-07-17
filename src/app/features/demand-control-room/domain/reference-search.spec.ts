import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { selectReferences } from './simulation-engine';
import { BaseDemandSource, DailyRecord, PromotionStatus, SalesObservationStatus, StockoutStatus, TechnicalFillStatus } from './models';

function record(index: number, overrides: Partial<DailyRecord> = {}): DailyRecord {
  const promoCode = overrides.promoCode ?? null;
  return {
    sku: 'TEST', barcode: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: 5,
    salesObservationStatus: SalesObservationStatus.RECORDED_SALE, isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasSalesRecord: true, receiptHour: null, promoCode, promotionStatus: promoCode ? PromotionStatus.PROMOTION : PromotionStatus.NONE, stockoutStatus: StockoutStatus.NONE,
    baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP, isCleanObservedReference: false, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [],
    referenceMedian: null, balanceStatus: null, selectionReason: '',
    ...overrides,
  };
}

describe('selectReferences — RULE-03-001 dò tuần tự ±7 → ±14 → ±24', () => {
  it('tìm đủ 2+2 ngày sạch ngay ở ±7 thì không mở rộng thêm', () => {
    const records = Array.from({ length: 31 }, (_, index) => record(index));
    const selection = selectReferences(records, 15, 15, DEFAULT_POLICY);

    expect(selection.searchRadius).toBe(DEFAULT_POLICY.referenceRadius);
    expect(selection.status).toBe('balanced');
  });

  it('±7 không đủ (toàn CTKM) nhưng ±14 đủ 2+2 → dừng ở mốc 14, không cần mở tới 24', () => {
    const records = Array.from({ length: 31 }, (_, index) => {
      const distance = Math.abs(index - 15);
      const dirty = distance >= 1 && distance <= 7; // toàn bộ ±7 là CTKM, không sạch
      return record(index, dirty ? { promoCode: 'KM01' } : {});
    });
    const selection = selectReferences(records, 15, 15, DEFAULT_POLICY);

    expect(selection.searchRadius).toBe(DEFAULT_POLICY.referenceRadiusExtended);
    expect(selection.status).toBe('balanced');
    expect(selection.before.every(item => item.distance > 7)).toBe(true);
  });

  it('cả ±7 và ±14 đều không đủ nhưng ±24 đủ → mở tới mốc tối đa', () => {
    const records = Array.from({ length: 51 }, (_, index) => {
      const distance = Math.abs(index - 25);
      const dirty = distance >= 1 && distance <= 14;
      return record(index, dirty ? { promoCode: 'KM01' } : {});
    });
    const selection = selectReferences(records, 25, 25, DEFAULT_POLICY);

    expect(selection.searchRadius).toBe(DEFAULT_POLICY.maxReferenceRadius);
  });
});
