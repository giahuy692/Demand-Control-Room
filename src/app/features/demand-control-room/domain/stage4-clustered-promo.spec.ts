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

describe('RULE-04-004 — cụm CTKM gần như liên tục không tách được nền → BASELINE_NOT_IDENTIFIABLE', () => {
  const start = '2024-01-01';
  const totalDays = 60;
  it('toàn bộ chuỗi bị hai mã CTKM liền kề phủ kín, không còn ngày sạch nào → cả cụm gộp lại vẫn insufficient, tạo task RULE-04-004', () => {
    const rows = Array.from({ length: totalDays }, (_, index) => {
      const date = dateAfter(start, index);
      const code = index < totalDays / 2 ? 101 : 102;
      return fixtureDailyRecord({ sku: 'P1', date, openStock: 10, closeStock: 9, sales: 5, totalStockDelta: -1, promoCode: code });
    });
    const dataset = realDatasetFromRows(rows, { extractionCompleted: false });
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 1, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const s4 = engine.run(4, s3, policy);
    const state = s4.states['1'];
    const sourceRows = state.daily.filter(row => row.date >= start && row.date <= dateAfter(start, totalDays - 1));

    expect(sourceRows).toHaveLength(totalDays);
    expect(sourceRows.every(row => row.promoCode === '101' || row.promoCode === '102')).toBe(true);
    expect(sourceRows.every(row => row.baseDemandSource === 'PROMOTION_UNRESOLVED')).toBe(true);
    const tasks = s4.exceptions.filter(task => task.skuId === '1');
    expect(tasks.some(task => task.ruleId === 'RULE-04-004' && task.code === 'BASELINE_NOT_IDENTIFIABLE')).toBe(true);
    expect(Number(s4.summary['Ngày không xác định được nền'])).toBeGreaterThan(0);
    expect(s4.audit.some(line => line.includes('[RULE-04-004]'))).toBe(true);
  });

  it('hai vùng CTKM tách biệt có đủ ngày sạch xen giữa → không gắn clustered, không tạo task RULE-04-004', () => {
    const rows = Array.from({ length: totalDays }, (_, index) => {
      const date = dateAfter(start, index);
      const inFirstPromo = index >= 20 && index < 25;
      const inSecondPromo = index >= 35 && index < 40;
      const promoCode = inFirstPromo ? 101 : inSecondPromo ? 102 : null;
      return fixtureDailyRecord({ sku: 'P1', date, openStock: 10, closeStock: 9, sales: 5, totalStockDelta: -1, promoCode });
    });
    const dataset = realDatasetFromRows(rows);
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 1, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const s4 = engine.run(4, s3, policy);
    const s4State = s4.states['1'];

    const promoRows = s4State.daily.filter(row => row.promoCode === '101' || row.promoCode === '102');
    expect(promoRows.length).toBeGreaterThan(0);
    const tasks = s4.exceptions.filter(task => task.skuId === '1');
    expect(tasks.some(task => task.ruleId === 'RULE-04-004')).toBe(false);
  });
});
