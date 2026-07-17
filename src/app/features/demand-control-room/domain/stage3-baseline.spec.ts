import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';
import { fixtureDailyRecord } from '../data-access/dto/dataset-fixture';
import { realDatasetFromRows } from '../data-access/testing/file-dataset.testing';

function dateAfter(iso: string, offset: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe('RULE-03-003 — stockout không đủ ngày sạch quan sát', () => {
  const start = '2024-01-01';
  const totalDays = 750;
  const stockoutIndex = 400; // ngày cần nâng nền
  const yearOffset = 24 * DEFAULT_POLICY.cycleLength; // 360

  function buildRows(withYearAgoBaseline: boolean): Record<string, unknown>[] {
    return Array.from({ length: totalDays }, (_, index) => {
      const date = dateAfter(start, index);
      const distanceFromStockout = Math.abs(index - stockoutIndex);
      if (index === stockoutIndex) return fixtureDailyRecord({ sku: 'P1', date, openStock: 0, closeStock: 0, sales: 0, totalStockDelta: 0 });
      // Cấp 1 dò tuần tự tới tận ±24 nên phải làm bẩn TOÀN BỘ ±24 quanh ngày stockout mới thật sự ép cấp 1 thất bại.
      if (distanceFromStockout >= 1 && distanceFromStockout <= 24) return fixtureDailyRecord({ sku: 'P1', date, openStock: 10, closeStock: 9, sales: 5, totalStockDelta: -1, promoCode: 'KM01' });
      const distanceFromYearAgo = Math.abs(index - (stockoutIndex - yearOffset));
      if (!withYearAgoBaseline && distanceFromYearAgo <= 24) return fixtureDailyRecord({ sku: 'P1', date, openStock: 10, closeStock: 9, sales: 5, totalStockDelta: -1, promoCode: 'KM01' });
      return fixtureDailyRecord({ sku: 'P1', date, openStock: 10, closeStock: 9, sales: 5, totalStockDelta: -1 });
    });
  }

  it('không dùng ngày mùa vụ năm trước ngoài cửa sổ ±24 làm nguồn thay thế', () => {
    const dataset = realDatasetFromRows(buildRows(true));
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 3, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const state = s3.states['1'];
    const stockoutDate = dateAfter(start, stockoutIndex);
    const record = state.daily.find(row => row.date === stockoutDate)!;

    expect(record.baseDemandSource).toBe('STOCKOUT_UNRESOLVED');
    expect(record.baseDemand).toBeNull();
    expect(s3.exceptions.some(item => item.date === stockoutDate && item.code === 'BASELINE_NOT_IDENTIFIABLE')).toBe(true);
  });

  it('cấp 1 và cấp 3 đều thất bại → BASELINE_UNRESOLVED (insufficient) và tạo task ngoại lệ BASELINE_NOT_IDENTIFIABLE gắn RULE-03-003', () => {
    const dataset = realDatasetFromRows(buildRows(false));
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 3, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const state = s3.states['1'];
    const stockoutDate = dateAfter(start, stockoutIndex);
    const record = state.daily.find(row => row.date === stockoutDate)!;

    expect(record.baseDemandSource).toBe('STOCKOUT_UNRESOLVED');
    expect(record.baseDemand).toBeNull();
    const task = s3.exceptions.find(item => item.date === stockoutDate);
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-03-003');
    expect(task!.code).toBe('BASELINE_NOT_IDENTIFIABLE');
    expect(task!.status).toBe('OPEN');
  });
});
