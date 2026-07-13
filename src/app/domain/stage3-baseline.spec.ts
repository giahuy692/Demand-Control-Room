import { describe, expect, it } from 'vitest';
import { parseRealDataset } from './catalog';
import { SimulationEngine } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';

function dateAfter(iso: string, offset: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function productRow(id: string): string {
  const row = Array.from({ length: 20 }, () => '');
  row[0] = id;
  row[3] = 'SKU thật';
  row[17] = '100000';
  row[19] = '70000';
  return row.join(',');
}

describe('RULE-03-003 — cấp 3 mùa vụ năm trước + task ngoại lệ khi hết cấp', () => {
  const start = '2024-01-01';
  const totalDays = 750;
  const stockoutIndex = 400; // ngày cần nâng nền
  const yearOffset = 24 * DEFAULT_POLICY.cycleLength; // 360

  // Yêu cầu cập nhật nguồn dữ liệu thật §6 — CSV giờ đọc theo header, bắt buộc có cột HasSalesRecord.
  const HEADER = 'SKU,Date,OpenStock,CloseStock,Sales,HasSalesRecord,ReceiptHour,PromoCode,PromoName,Price,ProductName';

  function buildRows(withYearAgoBaseline: boolean): string[] {
    return [HEADER, ...Array.from({ length: totalDays }, (_, index) => {
      const date = dateAfter(start, index);
      const distanceFromStockout = Math.abs(index - stockoutIndex);
      if (index === stockoutIndex) return `P1,${date},0,0,0,1,NULL,NULL,NULL,100000,NULL`; // trống cả ngày → stockout
      // Cấp 1 dò tuần tự tới tận ±24 nên phải làm bẩn TOÀN BỘ ±24 quanh ngày stockout mới thật sự ép cấp 1 thất bại.
      if (distanceFromStockout >= 1 && distanceFromStockout <= 24) return `P1,${date},10,9,5,1,NULL,KM01,NULL,100000,NULL`;
      const distanceFromYearAgo = Math.abs(index - (stockoutIndex - yearOffset));
      if (!withYearAgoBaseline && distanceFromYearAgo <= 24) return `P1,${date},10,9,5,1,NULL,KM01,NULL,100000,NULL`; // xóa luôn nền năm trước để kiểm tra nhánh BASELINE_UNRESOLVED
      return `P1,${date},10,9,5,1,NULL,NULL,NULL,100000,NULL`;
    })];
  }

  it('cấp 1 thất bại nhưng cấp 3 (mùa vụ năm trước) đủ căn cứ → nâng nền bằng cấp 3, không rơi về BASELINE_UNRESOLVED', () => {
    const dataset = parseRealDataset(buildRows(true).join('\n'), productRow('P1'));
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 3, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const state = s3.states['P1'];
    const stockoutDate = dateAfter(start, stockoutIndex);
    const record = state.daily.find(row => row.date === stockoutDate)!;

    expect(record.baseSource).toBe('stockout-lifted');
    expect(record.baseDemand).not.toBeNull();
    expect(record.selectionReason).toContain('Cấp 3');
    expect(Number(s3.summary['Dùng cấp mùa vụ năm trước'])).toBeGreaterThan(0);
    expect(s3.audit.some(line => line.includes('[RULE-03-003]'))).toBe(true);
  });

  it('cấp 1 và cấp 3 đều thất bại → BASELINE_UNRESOLVED (insufficient) và tạo task ngoại lệ BASELINE_NOT_IDENTIFIABLE gắn RULE-03-003', () => {
    const dataset = parseRealDataset(buildRows(false).join('\n'), productRow('P1'));
    const engine = new SimulationEngine();
    engine.setDataset(dataset);
    const runDate = dateAfter(start, totalDays + 5);
    const policy = { ...DEFAULT_POLICY, runDate, historyYears: 3, cycleLength: 15 };

    const s1 = engine.run(1, null, policy);
    const s2 = engine.run(2, s1, policy);
    const s3 = engine.run(3, s2, policy);
    const state = s3.states['P1'];
    const stockoutDate = dateAfter(start, stockoutIndex);
    const record = state.daily.find(row => row.date === stockoutDate)!;

    expect(record.baseSource).toBe('insufficient');
    expect(record.baseDemand).toBeNull();
    const task = s3.exceptions.find(item => item.date === stockoutDate);
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-03-003');
    expect(task!.code).toBe('BASELINE_NOT_IDENTIFIABLE');
    expect(task!.status).toBe('OPEN');
  });
});
