import { describe, expect, it } from 'vitest';
import { buildPromoRegions } from '../stages/stage-support';
import { DEFAULT_POLICY } from './policy';
import { BaseDemandSource, DailyRecord, PromotionStatus, SalesObservationStatus, StockoutStatus, TechnicalFillStatus } from './models';

function clean(index: number): DailyRecord {
  return {
    sku: 'TEST', barcode: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: 5,
    salesObservationStatus: SalesObservationStatus.RECORDED_SALE, isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasSalesRecord: true, receiptHour: null, promoCode: null, promotionStatus: PromotionStatus.NONE, stockoutStatus: StockoutStatus.NONE,
    baseDemand: 5, baseDemandSource: BaseDemandSource.CLEAN_OBSERVED_SALE, isCleanObservedReference: true, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '', storeCode: 11, productCode: 1, promotionName: null,
    promotionStartDate: null, promotionEndDate: null, promotionType: null, promotionMechanismType: null,
    promotionClass: 'NO_PROMOTION', stockStatus: 'CALCULATED',
  };
}

function promo(index: number, code: string): DailyRecord {
  return { ...clean(index), promoCode: code, promotionStatus: PromotionStatus.PROMOTION, promotionClass: 'DEEP_PROMO', baseDemand: null, baseDemandSource: BaseDemandSource.PROMOTION_UNRESOLVED, isCleanObservedReference: false };
}

describe('RULE-04-002 — hai cụm CTKM liền kề TUYỆT ĐỐI (đổi mã, không có ngày nào xen giữa) luôn gộp thành một', () => {
  it('cụm A (mã X) rồi cụm B (mã Y) liền kề ngay sau, mỗi cụm riêng đều "tự đủ" (temporary, không insufficient) nếu xét độc lập → vẫn phải gộp làm một vì liền kề tuyệt đối', () => {
    const records: DailyRecord[] = [];
    for (let i = 0; i < 7; i++) records.push(clean(i)); // 0-6: ngày sạch trước cụm A
    for (let i = 7; i <= 11; i++) records.push(promo(i, 'X')); // 7-11: cụm A, mã X
    for (let i = 12; i <= 16; i++) records.push(promo(i, 'Y')); // 12-16: cụm B, mã Y — liền kề tuyệt đối với A
    for (let i = 17; i <= 23; i++) records.push(clean(i)); // 17-23: ngày sạch sau cụm B

    const regions = buildPromoRegions(records, DEFAULT_POLICY);

    expect(regions).toHaveLength(1);
    expect(regions[0].clustered).toBe(true);
    expect(regions[0].codes).toEqual(expect.arrayContaining(['X', 'Y']));
    expect(regions[0].indexes[0]).toBe(7);
    expect(regions[0].indexes.at(-1)).toBe(16);
  });

  it('cụm A và cụm B có ít nhất một ngày sạch xen giữa (không liền kề tuyệt đối) và cả hai đều tự đủ tham chiếu → KHÔNG gộp', () => {
    const records: DailyRecord[] = [];
    for (let i = 0; i < 7; i++) records.push(clean(i));
    for (let i = 7; i <= 11; i++) records.push(promo(i, 'X'));
    records.push(clean(12)); // 1 ngày sạch xen giữa
    for (let i = 13; i <= 17; i++) records.push(promo(i, 'Y'));
    for (let i = 18; i <= 24; i++) records.push(clean(i));

    const regions = buildPromoRegions(records, DEFAULT_POLICY);

    expect(regions).toHaveLength(2);
    expect(regions[0].clustered).toBe(false);
    expect(regions[1].clustered).toBe(false);
  });
});
