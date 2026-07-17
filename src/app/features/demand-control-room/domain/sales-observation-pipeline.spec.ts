import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCalendarScaffold } from './calendar-scaffold';
import {
  BaseDemandSource,
  DailyRecord,
  PromotionStatus,
  SalesObservationStatus,
  StockoutStatus,
  TechnicalFillStatus,
} from './models';
import { DEFAULT_POLICY } from './policy';
import { loadMockSimulationDataset } from '../data-access/testing/file-dataset.testing';
import { runStage2 } from '../stages/stage-02-stockout/stage-02-stockout.processor';
import { runStage3 } from '../stages/stage-03-stockout-baseline/stage-03-stockout-baseline.processor';
import { runStage4 } from '../stages/stage-04-promotion-baseline/stage-04-promotion-baseline.processor';
import { createInitialState, createSnapshot, fillAndBuildCycles } from '../stages/stage-support';

const COMPLETE = { salesDataThroughDate: '2026-01-31', stockDataThroughDate: '2026-01-31', extractionCompleted: true } as const;
const INCOMPLETE = { ...COMPLETE, salesDataThroughDate: '2026-01-01' } as const;

function record(date: string, sales: number | null, overrides: Partial<DailyRecord> = {}): DailyRecord {
  const hasSalesRecord = sales !== null;
  return {
    sku: 'P1', barcode: 'B1', date, sales, hasSalesRecord,
    salesObservationStatus: hasSalesRecord ? SalesObservationStatus.RECORDED_SALE : SalesObservationStatus.SOURCE_DATA_GAP,
    openStock: 10, closeStock: 10, receiptHour: null, promoCode: null,
    promotionStatus: PromotionStatus.NONE, stockoutStatus: StockoutStatus.NONE,
    baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP,
    isCleanObservedReference: false, technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    isReferenceOnly: false, stockCalculationStatus: 'CALCULATED', stockSource: 'OBSERVED',
    referenceDates: [], referenceEvidence: [], beforeReferenceDates: [], afterReferenceDates: [],
    referenceMedian: null, balanceStatus: null, selectionReason: '',
    ...overrides,
  };
}

function snapshot(rows: DailyRecord[]) {
  const definition = loadMockSimulationDataset().catalog[0];
  const state = createInitialState(definition, rows);
  return createSnapshot(1, DEFAULT_POLICY, { [definition.id]: state }, {}, []);
}

describe('SalesObservationStatus và Chặng 1–5', () => {
  it('1 — có sales row 4 → RECORDED_SALE, sales=4', () => {
    const [day] = buildCalendarScaffold('P1', [record('2026-01-02', 4)], '2026-01-02', '2026-01-02', () => false, COMPLETE);
    expect(day).toMatchObject({ hasSalesRecord: true, sales: 4, salesObservationStatus: SalesObservationStatus.RECORDED_SALE });
  });

  it('2 — không sales row, extract hoàn chỉnh, còn tồn → CONFIRMED_ZERO và giữ baseDemand=0', () => {
    const [day] = buildCalendarScaffold('P1', [], '2026-01-02', '2026-01-02', () => false, COMPLETE, [], 8);
    const stage3 = runStage3(runStage2(snapshot([day]), DEFAULT_POLICY), DEFAULT_POLICY);
    const result = Object.values(stage3.states)[0].daily[0];
    expect(result).toMatchObject({ hasSalesRecord: false, sales: 0, salesObservationStatus: SalesObservationStatus.CONFIRMED_ZERO, baseDemand: 0, baseDemandSource: BaseDemandSource.CLEAN_OBSERVED_ZERO });
  });

  it('3 — ngày vượt sales watermark → SOURCE_DATA_GAP, sales=null', () => {
    const [day] = buildCalendarScaffold('P1', [], '2026-01-02', '2026-01-02', () => false, INCOMPLETE, [], 8);
    expect(day).toMatchObject({ hasSalesRecord: false, sales: null, salesObservationStatus: SalesObservationStatus.SOURCE_DATA_GAP });
  });

  it('4 — không sales, tồn bằng 0 cả ngày → ALL_DAY_STOCKOUT_CANDIDATE, không clean zero', () => {
    const [day] = buildCalendarScaffold('P1', [], '2026-01-02', '2026-01-02', () => false, COMPLETE, [], 0);
    const stage3 = runStage3(runStage2(snapshot([day]), DEFAULT_POLICY), DEFAULT_POLICY);
    const result = Object.values(stage3.states)[0].daily[0];
    expect(result.stockoutStatus).toBe(StockoutStatus.ALL_DAY_STOCKOUT_CANDIDATE);
    expect(result.baseDemandSource).not.toBe(BaseDemandSource.CLEAN_OBSERVED_ZERO);
  });

  it('5 — nhập trễ dùng cutoff từ policy', () => {
    const result = runStage2(snapshot([record('2026-01-02', 0, { openStock: 0, closeStock: 8, receiptHour: 13 })]), { ...DEFAULT_POLICY, cutoffHour: '10:00' });
    expect(Object.values(result.states)[0].daily[0].stockoutStatus).toBe(StockoutStatus.LATE_RECEIPT_STOCKOUT);
  });

  it('6 — interval CTKM phủ ngày không sales row và Chặng 4 vẫn xử lý', () => {
    const rows = ['01', '02', '03', '05', '06', '07'].map(day => record(`2026-01-${day}`, 10));
    const calendar = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-07', () => false, COMPLETE, [{ sku: 'P1', code: 'KM1', name: null, startDate: '2026-01-04', endDate: '2026-01-04', promotionClass: 'DEEP_PROMO' }], 10);
    const result = runStage4(runStage3(runStage2(snapshot(calendar), DEFAULT_POLICY), DEFAULT_POLICY), DEFAULT_POLICY);
    const promoDay = Object.values(result.states)[0].daily.find(day => day.date === '2026-01-04')!;
    expect(promoDay.promotionStatus).toBe(PromotionStatus.PROMOTION);
    expect(promoDay.baseDemandSource).toBe(BaseDemandSource.PROMOTION_BASELINE);
  });

  it('6b — ngày ALWAYS_ON giữ nguyên Sales làm baseline sạch ở Chặng 3, không bị chuyển Chặng 4', () => {
    const rows = ['01', '02', '03'].map(day => record(`2026-01-${day}`, 10));
    const calendar = buildCalendarScaffold('P1', rows, '2026-01-01', '2026-01-03', () => false, COMPLETE, [{ sku: 'P1', code: 'KM-TT', name: null, startDate: '2026-01-02', endDate: '2026-01-02', promotionClass: 'ALWAYS_ON' }], 10);
    const stage4 = runStage4(runStage3(runStage2(snapshot(calendar), DEFAULT_POLICY), DEFAULT_POLICY), DEFAULT_POLICY);
    const alwaysOnDay = Object.values(stage4.states)[0].daily.find(day => day.date === '2026-01-02')!;
    expect(alwaysOnDay.promotionStatus).toBe(PromotionStatus.NONE);
    expect(alwaysOnDay.baseDemand).toBe(10);
    expect(alwaysOnDay.baseDemandSource).toBe(BaseDemandSource.CLEAN_OBSERVED_SALE);
    expect(alwaysOnDay.isCleanObservedReference).toBe(true);
  });

  it('7 — chu kỳ 10 ngày hợp lệ + 5 SOURCE_DATA_GAP được lấp bằng median', () => {
    const rows = Array.from({ length: 15 }, (_, index) => index < 10
      ? record(`2026-01-${String(index + 1).padStart(2, '0')}`, 10, { baseDemand: 10, baseDemandSource: BaseDemandSource.CLEAN_OBSERVED_SALE, isCleanObservedReference: true })
      : record(`2026-01-${String(index + 1).padStart(2, '0')}`, null));
    const result = fillAndBuildCycles(rows, 15, 3, 24);
    expect(result.daily.slice(10).every(day => day.baseDemand === 10 && day.baseDemandSource === BaseDemandSource.TECHNICAL_FILL)).toBe(true);
  });

  it('8 — chu kỳ 0 ngày baseDemand hợp lệ bị chặn, không tạo 15 ngày giả', () => {
    const rows = Array.from({ length: 15 }, (_, index) => record(`2026-01-${String(index + 1).padStart(2, '0')}`, null));
    const result = fillAndBuildCycles(rows, 15, 3, 24);
    expect(result.cycles[0].status).toBe('BLOCKED_NO_VALID_BASELINE');
    expect(result.daily.every(day => day.baseDemand === null)).toBe(true);
  });

  it('9 — TECHNICAL_FILL/STOCKOUT_BASELINE/PROMOTION_BASELINE không lan truyền làm nguồn', () => {
    const sources = [BaseDemandSource.CLEAN_OBSERVED_SALE, BaseDemandSource.CLEAN_OBSERVED_ZERO, BaseDemandSource.STOCKOUT_BASELINE, BaseDemandSource.PROMOTION_BASELINE, BaseDemandSource.TECHNICAL_FILL];
    const rows = sources.map((source, index) => record(`2026-01-0${index + 1}`, index + 1, { baseDemand: index + 1, baseDemandSource: source, isCleanObservedReference: source.startsWith('CLEAN_') }))
      .concat(Array.from({ length: 10 }, (_, index) => record(`2026-01-${String(index + 6).padStart(2, '0')}`, null)));
    const result = fillAndBuildCycles(rows, 15, 2, 24);
    expect(result.daily[5].referenceEvidence.filter(item => item.selected).every(item => item.source === BaseDemandSource.CLEAN_OBSERVED_SALE || item.source === BaseDemandSource.CLEAN_OBSERVED_ZERO)).toBe(true);
  });

  it('10 — RePosDetails không lọc sales, chỉ xuất hiện trong nhánh inventory movement', () => {
    const sql = readFileSync('Sql/sales-history.sql', 'utf8');
    const salesBlock = sql.slice(sql.indexOf('BƯỚC 1'), sql.indexOf('BƯỚC 2'));
    const inventoryBlock = sql.slice(sql.indexOf('BƯỚC 2'));
    expect(salesBlock).not.toContain('RePosDetails');
    expect(inventoryBlock).toContain('RePosDetails');
  });
});
