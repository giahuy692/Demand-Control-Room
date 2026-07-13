import { describe, expect, it } from 'vitest';
import { parseRealDataset } from './catalog';
import { SimulationEngine } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';

function productRow(id: string, name: string, price: number, purchasePrice: number): string {
  const row = Array.from({ length: 20 }, () => '');
  row[0] = id;
  row[3] = name;
  row[9] = '45';
  row[17] = String(price);
  row[19] = String(purchasePrice);
  return row.join(',');
}

function dateAfter(iso: string, offset: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function dailyRows(sku: string, start: string, days: number, sales: number, promoCode = 'NULL'): string[] {
  return Array.from({ length: days }, (_, index) => {
    const date = dateAfter(start, index);
    return `${sku},${date},10,${10 - sales},${sales},NULL,${promoCode},NULL,100000,NULL`;
  });
}

describe('real dataset import', () => {
  it('đọc CSV không header và nối metadata sản phẩm tối thiểu', () => {
    const dataset = parseRealDataset(
      [
        'P1,2026-01-01,0,4,1,NULL,NULL,NULL,100000,NULL',
        'P1,2026-01-02,4,3,1,09:30,KM01,Promo,100000,Real Name',
      ].join('\n'),
      productRow('P1', 'Tên từ Product', 120000, 70000),
    );

    expect(dataset.catalog[0].id).toBe('P1');
    expect(dataset.catalog[0].name).toBe('Real Name');
    expect(dataset.catalog[0].category).toBe('Nhóm ERP 45');
    expect(dataset.catalog[0].purchasePrice).toBe(70000);
    expect(dataset.dailyBySku['P1']).toHaveLength(2);
    expect(dataset.dailyBySku['P1'][1].promoCode).toBe('KM01');
  });

  it('Chặng 1 dùng daily thật trong lịch sử và actual thật sau ngày chạy', () => {
    const dataset = parseRealDataset(
      [
        ...dailyRows('P1', '2026-01-01', 30, 1),
        ...dailyRows('P1', '2026-02-01', 15, 2, 'KM01'),
      ].join('\n'),
      productRow('P1', 'SKU thật', 120000, 70000),
    );
    const engine = new SimulationEngine();
    engine.setDataset(dataset);

    const snapshot = engine.run(1, null, { ...DEFAULT_POLICY, runDate: '2026-02-01', cycleLength: 15 });
    const state = snapshot.states['P1'];

    // RULE-01-001 — module phải tạo lịch liên tục cho TOÀN BỘ khung xử lý (fixture chỉ cung
    // cấp 30 ngày nguồn thật trong một khung nhiều năm), không chỉ trả về đúng số dòng nguồn có sẵn.
    const expectedWindowDays = Number(snapshot.summary['Chu kỳ đầy đủ N']) * DEFAULT_POLICY.cycleLength;
    expect(state.daily).toHaveLength(expectedWindowDays);
    const realDays = state.daily.filter(row => row.hasRecord);
    expect(realDays).toHaveLength(30);
    expect(realDays.every(row => row.sales === 1)).toBe(true);
    const scaffoldDays = state.daily.filter(row => !row.hasRecord);
    expect(scaffoldDays).toHaveLength(expectedWindowDays - 30);
    expect(scaffoldDays.every(row => row.sales === null && row.salesStatus === 'SOURCE_UNKNOWN')).toBe(true);

    expect(state.definition.actualDemand).toEqual([30]);
    expect(state.definition.futurePromotions).toEqual([{ cycleOffset: 1, code: 'KM01', promoDays: 15, confirmed: true }]);

    // RULE-01-003 — vùng đọc tham chiếu trước khung được nạp riêng, có scaffold, KHÔNG lẫn vào daily.
    expect(state.referenceOnlyDaily.length).toBeGreaterThan(0);
    expect(state.referenceOnlyDaily.every(row => row.isReferenceOnly)).toBe(true);
    expect(state.daily.every(row => !row.isReferenceOnly)).toBe(true);

    // RULE-01-001/003/004 — log Chặng 1 phải gắn RuleId để truy vết quyết định.
    expect(snapshot.audit.some(line => line.includes('[RULE-01-001]'))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-01-003]'))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-01-004]'))).toBe(true);
  });

  it('RULE-01-004: dữ liệu thật chưa có ExtractMetadata.PortfolioMode → mặc định bảo thủ SELECTED_SKU_SIMULATION, không tự nhận FULL_PORTFOLIO', () => {
    const dataset = parseRealDataset(dailyRows('P1', '2026-01-01', 5, 1).join('\n'), productRow('P1', 'SKU thật', 100000, 70000));

    expect(dataset.portfolioMode).toBe('SELECTED_SKU_SIMULATION');
    expect(dataset.extractIsTruncated).toBe(true);
    expect(dataset.catalog[0].portfolioMode).toBe('SELECTED_SKU_SIMULATION');
  });

  it('RULE-02-001/003: Chặng 2 chặn stockout tự động ở ngày ANCHOR_MISSING (đầu vùng tham chiếu) và giữ nguyên tồn âm khi tự động đánh giá, cả hai đều tạo exception task gắn RuleId', () => {
    const rows = [...dailyRows('P1', '2026-01-01', 4, 1)];
    rows[2] = 'P1,2026-01-03,10,-3,5,NULL,NULL,NULL,100000,NULL'; // tồn âm ngày thật
    const dataset = parseRealDataset(rows.join('\n'), productRow('P1', 'SKU thật', 100000, 70000));
    const engine = new SimulationEngine();
    engine.setDataset(dataset);

    const snapshot1 = engine.run(1, null, { ...DEFAULT_POLICY, runDate: '2026-01-10', cycleLength: 15, maxReferenceRadius: 3 });
    const snapshot2 = engine.run(2, snapshot1, { ...DEFAULT_POLICY, runDate: '2026-01-10', cycleLength: 15, maxReferenceRadius: 3 });
    const state1 = snapshot1.states['P1'];
    const state2 = snapshot2.states['P1'];

    // Ngày đầu tiên của vùng đọc tham chiếu không có mốc tồn trước đó → ANCHOR_MISSING ở Chặng 1.
    expect(state1.referenceOnlyDaily[0].stockCalculationStatus).toBe('ANCHOR_MISSING');

    const negativeDay = state2.daily.find(row => row.date === '2026-01-03')!;
    expect(negativeDay.closeStock).toBe(-3);
    expect(negativeDay.stockCalculationStatus).toBe('NEGATIVE_REVIEW');

    const ruleIds = snapshot2.exceptions.map(task => task.ruleId);
    expect(ruleIds).toContain('RULE-02-003');
    expect(snapshot2.exceptions.every(task => task.status === 'OPEN' && task.code === 'STOCK_ANCHOR_MISSING')).toBe(true);
    expect(snapshot2.audit.some(line => line.includes('[RULE-02-001]'))).toBe(true);
    expect(snapshot2.audit.some(line => line.includes('[RULE-02-003]'))).toBe(true);
  });

  it('đọc JSON thật và metadata List-product để mô phỏng nhiều SKU', () => {
    const dailyJson = JSON.stringify([
      { SKU: 30259, Date: '2026-01-01', OpenStock: 10, CloseStock: 9, Sales: 1, ReceiptHour: null, PromoCode: null, PromoName: null, Price: 88500, ProductName: null },
      { SKU: 30259, Date: '2026-01-02', OpenStock: 9, CloseStock: 7, Sales: 2, ReceiptHour: '09:00', PromoCode: 'MEMBER', PromoName: null, Price: 88500, ProductName: null },
      { SKU: 37237, Date: '2026-01-01', OpenStock: 12, CloseStock: 11, Sales: 1, ReceiptHour: null, PromoCode: null, PromoName: null, Price: 52000, ProductName: null },
    ]);
    const productJson = JSON.stringify([
      { Product: '30259', PriceCandidate: 88696.97, ApproxDemandShape: 'Z_INTERMITTENT', CoverageScore: 83 },
      { Product: '37237', PriceCandidate: 51891.16, ApproxDemandShape: 'X_STABLE', CoverageScore: 81 },
    ]);

    const dataset = parseRealDataset(dailyJson, productJson);

    expect(dataset.catalog).toHaveLength(2);
    expect(dataset.catalog[0].id).toBe('30259');
    expect(dataset.catalog[0].name).toBe('SKU 30259');
    expect(dataset.catalog[0].category).toBe('Dạng nhu cầu Z_INTERMITTENT');
    expect(dataset.dailyBySku['30259'][1].promoCode).toBe('MEMBER');
    expect(dataset.audit[0]).toContain('demand-planning-real.json');
    expect(dataset.dateRange).toEqual({ min: '2026-01-01', max: '2026-01-02', recommendedRunDate: '2026-01-01' });
  });

  it('giữ HasRecord=false khi JSON dùng 0 dạng string', () => {
    const dataset = parseRealDataset(
      JSON.stringify([
        { SKU: 'P1', Date: '2026-01-01', OpenStock: 0, CloseStock: 0, Sales: 0, HasRecord: '0', ReceiptHour: null, PromoCode: null, Price: 100000 },
      ]),
      '[]',
    );

    expect(dataset.dailyBySku['P1'][0].hasRecord).toBe(false);
  });
});
