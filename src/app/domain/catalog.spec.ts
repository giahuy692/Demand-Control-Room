import { describe, expect, it } from 'vitest';
import { parseExtractMetadata, parseHachiBusinessRoles, parseRealDataset } from './catalog';
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

interface DailyRowOverrides {
  readonly returnQty?: number;
  readonly inventoryNetMovement?: number;
  readonly isOpeningAnchor?: boolean;
}

/** Yêu cầu cập nhật nguồn dữ liệu thật §4 — một dòng DAILY-SOURCE-V2 hợp lệ (JSON), sales có thể null. */
function dailyRow(sku: string, date: string, openStock: number, closeStock: number, sales: number | null, promoCode: string | null = null, overrides: DailyRowOverrides = {}): Record<string, unknown> {
  return {
    SKU: sku, Date: date, OpenStock: openStock, CloseStock: closeStock,
    Sales: sales, HasSalesRecord: sales !== null,
    ReturnQty: overrides.returnQty ?? null, HasReturnRecord: overrides.returnQty !== undefined,
    InventoryNetMovement: overrides.inventoryNetMovement ?? null, HasInventoryMovement: overrides.inventoryNetMovement !== undefined,
    ReceiptHour: null, PromoCode: promoCode, PromoName: null, Price: 100000, ProductName: null,
    IsOpeningAnchor: overrides.isOpeningAnchor ?? false,
  };
}

function dailyRowsJson(sku: string, start: string, days: number, sales: number, promoCode: string | null = null): Record<string, unknown>[] {
  return Array.from({ length: days }, (_, index) => dailyRow(sku, dateAfter(start, index), 10, 10 - sales, sales, promoCode));
}

const PASSING_METADATA = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  ExtractId: 'EXTRACT-001', QueryVersion: 'demand-planing-v6-pos-real-backtest', DataContractVersion: 'DAILY-SOURCE-V2',
  RunMode: 'HISTORICAL_VALIDATION', RunDate: '2026-06-01', StoreCode: 'GLOBAL_POS', SelectedSkuCount: 1,
  PortfolioMode: 'SELECTED_SKU_SIMULATION', StockReconciliationGate: 'PASS', StockMismatchSkuCount: 0,
  GeneratedAt: '2026-07-13T00:00:00Z', ...overrides,
});

describe('real dataset import', () => {
  it('đọc CSV theo header (không còn theo vị trí cột) và nối metadata sản phẩm tối thiểu', () => {
    const header = 'SKU,Date,OpenStock,CloseStock,Sales,HasSalesRecord,ReceiptHour,PromoCode,PromoName,Price,ProductName';
    const rows = [
      'P1,2026-01-01,0,4,1,1,,,,100000,',
      'P1,2026-01-02,4,3,1,1,09:30,KM01,Promo,100000,Real Name',
    ];
    const dataset = parseRealDataset([header, ...rows].join('\n'), productRow('P1', 'Tên từ Product', 120000, 70000));

    expect(dataset.catalog[0].id).toBe('P1');
    expect(dataset.catalog[0].name).toBe('Real Name');
    expect(dataset.catalog[0].category).toBe('Nhóm ERP 45');
    expect(dataset.catalog[0].purchasePrice).toBe(70000);
    expect(dataset.dailyBySku['P1']).toHaveLength(2);
    expect(dataset.dailyBySku['P1'][1].promoCode).toBe('KM01');
  });

  it('CSV thiếu cột HasSalesRecord bị chặn ngay với thông báo rõ ràng (hợp đồng DAILY-SOURCE-V2 bắt buộc)', () => {
    const header = 'SKU,Date,OpenStock,CloseStock,Sales,ReceiptHour,PromoCode,PromoName,Price,ProductName';
    const row = 'P1,2026-01-01,0,4,1,,,,100000,';
    expect(() => parseRealDataset([header, row].join('\n'), productRow('P1', 'X', 100000, 70000))).toThrow(/HasSalesRecord/);
  });

  it('Chặng 1 dùng daily thật trong lịch sử và actual thật sau ngày chạy', () => {
    const dataset = parseRealDataset(
      JSON.stringify([
        ...dailyRowsJson('P1', '2026-01-01', 30, 1),
        ...dailyRowsJson('P1', '2026-02-01', 15, 2, 'KM01'),
      ]),
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
    // #18 §9 — HISTORICAL_VALIDATION không được dựng kế hoạch CTKM tương lai từ giao dịch thực tế sau
    // runDate (khác `actualDemand` ở trên — đó là hậu kiểm Chặng 19, không nuôi ngược vào dự báo Chặng 13).
    expect(state.definition.futurePromotions).toEqual([]);

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
    const dataset = parseRealDataset(JSON.stringify(dailyRowsJson('P1', '2026-01-01', 5, 1)), productRow('P1', 'SKU thật', 100000, 70000));

    expect(dataset.portfolioMode).toBe('SELECTED_SKU_SIMULATION');
    expect(dataset.extractIsTruncated).toBe(true);
    expect(dataset.catalog[0].portfolioMode).toBe('SELECTED_SKU_SIMULATION');
  });

  it('RULE-02-001/003: Chặng 2 chặn stockout tự động ở ngày ANCHOR_MISSING (đầu vùng tham chiếu) và giữ nguyên tồn âm khi tự động đánh giá, cả hai đều tạo exception task gắn RuleId', () => {
    const rows = dailyRowsJson('P1', '2026-01-01', 4, 1);
    rows[2] = dailyRow('P1', '2026-01-03', 10, -3, 5); // tồn âm ngày thật
    const dataset = parseRealDataset(JSON.stringify(rows), productRow('P1', 'SKU thật', 100000, 70000));
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
      dailyRow('30259', '2026-01-01', 10, 9, 1),
      dailyRow('30259', '2026-01-02', 9, 7, 2, 'MEMBER'),
      dailyRow('37237', '2026-01-01', 12, 11, 1),
    ]);
    const productJson = JSON.stringify([
      { Product: '30259', PriceCandidate: 88696.97, ApproxDemandShape: 'Z_INTERMITTENT', CoverageScore: 83 },
      { Product: '37237', PriceCandidate: 51891.16, ApproxDemandShape: 'X_STABLE', CoverageScore: 81 },
    ]);

    const dataset = parseRealDataset(dailyJson, productJson);

    expect(dataset.catalog).toHaveLength(2);
    expect(dataset.catalog[0].id).toBe('30259');
    expect(dataset.catalog[0].category).toBe('Dạng nhu cầu Z_INTERMITTENT');
    expect(dataset.dailyBySku['30259'][1].promoCode).toBe('MEMBER');
    expect(dataset.audit[0]).toContain('demand-planning-real.json');
    expect(dataset.dateRange).toEqual({ min: '2026-01-01', max: '2026-01-02', recommendedRunDate: '2026-01-01' });
  });

  // #1/#2 Yêu cầu cập nhật nguồn dữ liệu thật §8 — round-trip null/0 phải giữ nguyên phân biệt.
  it('#1 Sales=null, HasSalesRecord=false round-trip JSON vẫn là null (không suy diễn 0)', () => {
    const dataset = parseRealDataset(JSON.stringify([dailyRow('P1', '2026-01-01', 10, 10, null)]), '[]');
    const row = dataset.dailyBySku['P1'][0];
    expect(row.sales).toBeNull();
    expect(row.salesStatus).toBe('SOURCE_UNKNOWN');
  });

  it('#2 Sales=0, HasSalesRecord=true vẫn là số 0 quan sát (khác null)', () => {
    const dataset = parseRealDataset(JSON.stringify([dailyRow('P1', '2026-01-01', 10, 10, 0)]), '[]');
    const row = dataset.dailyBySku['P1'][0];
    expect(row.sales).toBe(0);
    expect(row.salesStatus).toBe('OBSERVED_ZERO');
  });

  it('#3 ngày chỉ có trả hàng (HasReturnRecord=true, HasSalesRecord=false) không trở thành ngày bán 0', () => {
    const dataset = parseRealDataset(JSON.stringify([dailyRow('P1', '2026-01-01', 10, 12, null, null, { returnQty: 2 })]), '[]');
    const row = dataset.dailyBySku['P1'][0];
    expect(row.sales).toBeNull();
    expect(row.salesStatus).toBe('SOURCE_UNKNOWN');
  });

  it('#4 ngày chỉ có nhập/xuất kho (HasInventoryMovement=true, HasSalesRecord=false) không trở thành ngày bán 0', () => {
    const dataset = parseRealDataset(JSON.stringify([dailyRow('P1', '2026-01-01', 10, 30, null, null, { inventoryNetMovement: 20 })]), '[]');
    const row = dataset.dailyBySku['P1'][0];
    expect(row.sales).toBeNull();
    expect(row.salesStatus).toBe('SOURCE_UNKNOWN');
  });

  it('#12 IsOpeningAnchor=true không được tính là ngày lịch sử — loại hẳn khỏi dailyBySku', () => {
    const rows = [
      dailyRow('P1', '2025-12-01', 5, 5, null, null, { isOpeningAnchor: true }),
      ...dailyRowsJson('P1', '2026-01-01', 3, 1),
    ];
    const dataset = parseRealDataset(JSON.stringify(rows), '[]');
    expect(dataset.dailyBySku['P1']).toHaveLength(3);
    expect(dataset.dailyBySku['P1'].some(row => row.date === '2025-12-01')).toBe(false);
  });

  it('#17 §9 — đọc ExtractMetadata thật khi asset có sẵn, thay vì hard-code portfolioMode/extractIsTruncated/recommendedRunDate', () => {
    const dataset = parseRealDataset(
      JSON.stringify(dailyRowsJson('P1', '2026-01-01', 5, 1)),
      productRow('P1', 'SKU thật', 100000, 70000),
      PASSING_METADATA({ PortfolioMode: 'FULL_PORTFOLIO' }),
    );

    expect(dataset.portfolioMode).toBe('FULL_PORTFOLIO');
    expect(dataset.extractIsTruncated).toBe(false);
    expect(dataset.catalog[0].portfolioMode).toBe('FULL_PORTFOLIO');
    // #11 — recommendedRunDate PHẢI lấy từ metadata.RunDate, không suy từ maxDate.
    expect(dataset.dateRange?.recommendedRunDate).toBe('2026-06-01');
    expect(dataset.audit.some(line => line.includes('[§9][ExtractMetadata]') && line.includes('EXTRACT-001'))).toBe(true);
  });

  it('#17b parseExtractMetadata trả null khi payload rỗng hoặc là mảng rỗng (quy ước fetchTextOptional cho asset vắng mặt)', () => {
    expect(parseExtractMetadata('')).toBeNull();
    expect(parseExtractMetadata('[]')).toBeNull();
    expect(parseExtractMetadata('not json')).toBeNull();
  });

  it('#9 StockReconciliationGate=FAIL PHẢI chặn nạp dữ liệu thật vào mô phỏng, không fallback âm thầm', () => {
    const payload = PASSING_METADATA({ StockReconciliationGate: 'FAIL', StockMismatchSkuCount: 3 });
    expect(() => parseRealDataset(JSON.stringify(dailyRowsJson('P1', '2026-01-01', 5, 1)), '[]', payload)).toThrow(/StockReconciliationGate=FAIL/);
  });

  it('gate vắng mặt/không hợp lệ trong metadata được coi là FAIL (an toàn theo mặc định), không mặc định PASS', () => {
    const metadata = parseExtractMetadata(JSON.stringify({ ExtractId: 'X', RunDate: '2026-06-01' }));
    expect(metadata?.stockReconciliationGate).toBe('FAIL');
  });

  it('#18 §9 — HISTORICAL_VALIDATION không tự dựng kế hoạch CTKM tương lai dù dữ liệu thật sau runDate CÓ CTKM quan sát được', () => {
    const dataset = parseRealDataset(
      JSON.stringify([...dailyRowsJson('P1', '2026-01-01', 15, 1), ...dailyRowsJson('P1', '2026-01-16', 30, 3, 'KM99')]),
      productRow('P1', 'SKU thật', 100000, 70000),
    );
    const engine = new SimulationEngine();
    engine.setDataset(dataset);

    const snapshot = engine.run(1, null, { ...DEFAULT_POLICY, runDate: '2026-01-16', cycleLength: 15 });

    expect(snapshot.states['P1'].definition.futurePromotions).toEqual([]);
  });

  it('parseHachiBusinessRoles chỉ nhận role hợp lệ, bỏ qua SKU/role trống hoặc sai literal', () => {
    const map = parseHachiBusinessRoles(JSON.stringify([
      { SKU: 'SKU-001', HachiBusinessRole: 'CORE' },
      { SKU: '', HachiBusinessRole: 'CORE' },
      { SKU: 'SKU-002', HachiBusinessRole: 'NOT_A_ROLE' },
    ]));

    expect(map).toEqual({ 'SKU-001': 'CORE' });
  });
});
