import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { buildCycles, SimulationEngine } from './simulation-engine';
import { applyPromoFactor, calculateFreeStock, calculateTrend, classifyAbcRows, classifySeasonPosition, classifyXyz, croston, detectPulse, isStockout, median, populationStdev, promoBaseline, safetyStock, stockoutBaseline } from './math';
import { DailyRecord } from './models';
import { buildPromoRegionSamples } from './promo-analysis';
import { testEngine } from '../features/demand-control-room/data-access/testing/file-dataset.testing';

function dailyRecord(index: number, baseDemand: number | null, baseSource: DailyRecord['baseSource']): DailyRecord {
  return {
    sku: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: baseDemand ?? 5,
    salesStatus: 'OBSERVED', isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasRecord: true,
    receiptHour: null, promoCode: null, isStockout: false, stockoutReviewRequired: false, stockoutReason: null, baseDemand, baseSource, referenceDates: [],
    beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null, balanceStatus: null, selectionReason: '',
  };
}

describe('21 acceptance tests từ Developer Spec', () => {
  it('T01 · Chặng 1: 01/06/2026 tạo 1247 ngày, 83 chu kỳ, dư 2', () => {
    const snapshot = testEngine().run(1, null, DEFAULT_POLICY);
    expect(snapshot.summary['Tổng ngày D']).toBe(1247);
    expect(snapshot.summary['Chu kỳ đầy đủ N']).toBe(83);
    expect(snapshot.summary['Ngày dư r']).toBe(2);
  });

  it('T02 · Chặng 2: nhập 13:00 sau cutoff là stockout', () => {
    expect(isStockout({ openStock: 0, closeStock: 20, sales: 0, receiptHour: '13:00', hasRecord: true }, '10:00')).toBe(true);
  });

  it('T03 · Chặng 2: trống cả ngày luôn là stockout, không có heuristic SKU thưa', () => {
    expect(isStockout({ openStock: 0, closeStock: 0, sales: 0, receiptHour: null, hasRecord: true }, '10:00')).toBe(true);
  });

  it('T04 · Chặng 3: max(8, median 18/20/21/19) = 19,5', () => {
    expect(stockoutBaseline(8, [18, 20, 21, 19])).toBe(19.5);
  });

  it('T05 · Chặng 3: một phía 17/18/20 cho nền tạm 18', () => {
    expect(stockoutBaseline(8, [17, 18, 20])).toBe(18);
  });

  it('T06 · Chặng 4: cụm bị chặn dùng k=4, median=5,5', () => {
    expect(promoBaseline([5, 5, 7, 6, 6, 6, 5, 5])).toBe(5.5);
  });

  it('T07 · Chặng 4: sales KM 43 không được max với nền 21,5', () => {
    expect(promoBaseline([20, 21, 22, 22])).toBe(21.5);
  });

  it('T08 · Chặng 5: chu kỳ không có ngày đủ căn cứ là empty và không khóa', () => {
    const cycle = buildCycles(Array.from({ length: 15 }, (_, index) => dailyRecord(index, null, 'insufficient')), 15, 3, 7)[0];
    expect(cycle.emptyCycle).toBe(true);
    expect(cycle.locked).toBe(false);
  });

  it('T09 · Chặng 5: chu kỳ thiếu hai ngày được lấp và khóa', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, index < 2 ? null : 10, index < 2 ? 'insufficient' : 'clean'));
    const cycle = buildCycles(records, 15, 3, 7)[0];
    expect(cycle.locked).toBe(true);
    expect(cycle.technicalFillDays).toBe(2);
  });

  it('T10 · Chặng 6: biên đúng 90% bắt đầu nhóm C', () => {
    const result = classifyAbcRows([
      { id: 'B001', annualValue: 45 }, { id: 'A001', annualValue: 35 }, { id: 'C001', annualValue: 10 },
      { id: 'D001', annualValue: 6 }, { id: 'E001', annualValue: 4 },
    ]);
    expect(result).toEqual({ B001: 'A', A001: 'A', C001: 'C', D001: 'C', E001: 'C' });
  });

  it('T11 · Chặng 7: 0,0,30,0,0,25 có ADI=3 và thuộc Z', () => {
    const result = classifyXyz([0, 0, 30, 0, 0, 25]);
    expect(result.adi).toBe(3);
    expect(result.positiveMean).toBe(27.5);
    expect(result.positiveStdev).toBe(2.5);
    expect(result.cv).toBeCloseTo(2.5 / 27.5);
    expect(result.cv2).toBeCloseTo((2.5 / 27.5) ** 2);
    expect(result.xyz).toBe('Z');
  });

  it('T12 · Chặng 7: sigma quần thể của 30 và 25 bằng 2,5', () => {
    expect(populationStdev([30, 25])).toBe(2.5);
  });

  it('T13 · Chặng 9: tỷ lệ 1,45/1,50/1,40 là LẶP CAO', () => {
    expect(classifySeasonPosition([1.45, 1.5, 1.4])).toBe('LẶP CAO');
  });

  it('T14 · Chặng 9: tỷ lệ trung tính vẫn là CHƯA RÕ', () => {
    expect(classifySeasonPosition([1.13, 1.09, 1.1])).toBe('CHƯA RÕ');
  });

  it('T15 · Chặng 10: g1=7%, g2=30% tăng, cắt 15% và cần xem xét', () => {
    const result = calculateTrend([100, 100, 100, 100, 107, 107, 107, 107, 139.1, 139.1, 139.1, 139.1]);
    expect(result.trend).toBe('up');
    expect(result.rates[0]).toBeCloseTo(0.07);
    expect(result.rates[1]).toBeCloseTo(0.3);
    expect(result.cappedRate).toBe(0.15);
    expect(result.needsReview).toBe(true);
  });

  it('T16 · Chặng 11: Croston cần hai phát sinh và P1 là khoảng cách giữa chúng', () => {
    expect(croston([0, 0, 30, 0, 0, 25]).firstInterval).toBe(3);
    expect(croston([0, 0, 30, 0, 0, 0]).forecast).toBeNull();
  });

  it('T17 · Chặng 11: nhịp 93 mỗi ba chu kỳ có D=3, Q=93', () => {
    const values = Array.from({ length: 18 }, (_, index) => index >= 2 && (index - 2) % 3 === 0 ? 93 : 0);
    expect(detectPulse(values)).toEqual({ ready: true, interval: 3, quantity: 93 });
  });

  it('T18 · Chặng 12: median K 1,5/1,4/1,5 bằng 1,5', () => {
    expect(median([1.5, 1.4, 1.5])).toBe(1.5);
  });

  it('T18b · Chặng 12: mỗi vùng CTKM chỉ tạo một K từ tổng Q / tổng nền', () => {
    const first = { ...dailyRecord(0, 10, 'promo-normalized'), promoCode: 'KM-A', sales: 20 };
    const second = { ...dailyRecord(1, 30, 'promo-normalized'), promoCode: 'KM-A', sales: 30 };
    const samples = buildPromoRegionSamples([first, second]);
    expect(samples).toHaveLength(1);
    expect(samples[0].factor).toBe(1.25);
  });

  it('T19 · Chặng 13: nền 150, KM 5/15 ngày, K=1,5 cho 175', () => {
    expect(applyPromoFactor(150, 5, 15, 1.5)).toBe(175);
  });

  it('T20 · Chặng 14: hàng tự do 100+50−30 bằng 120', () => {
    expect(calculateFreeStock(100, 50, 30)).toBe(120);
    expect(calculateFreeStock(10, 0, 30)).toBe(-20);
  });

  it('T21 · Chặng 15: công thức đầy đủ cho SS=276', () => {
    expect(Math.ceil(safetyStock(1.65, 120, 30, 8, 1.2))).toBe(276);
    expect(Math.round(1.65 * 30 * Math.sqrt(8))).toBe(140);
  });
});
