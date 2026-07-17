import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitDataLine, readDelimitedFile } from './csv-reader.mjs';
import { validateDataset } from './data-contract.mjs';
import { buildMockDailyRows, buildMockProducts, fullCycleCount, MOCK_CYCLE_LENGTH, MOCK_HISTORY_YEARS, MOCK_RUN_DATE } from './mock-generator.mjs';
import { isoDateFrom, requiredNumber } from './normalizers.mjs';

describe('mock-generator.mjs', () => {
  it('giữ đúng cửa sổ lịch đã khóa trong baseline', () => {
    expect(fullCycleCount(MOCK_RUN_DATE, MOCK_HISTORY_YEARS, MOCK_CYCLE_LENGTH)).toBe(83);
  });

  it('§12.15 — output deterministic: hai lần sinh giống hệt nhau', () => {
    expect(buildMockDailyRows()).toEqual(buildMockDailyRows());
    expect(buildMockProducts()).toEqual(buildMockProducts());
  });
});

describe('csv-reader.mjs — §12.13 nhận cả comma lẫn tab', () => {
  it('splitDataLine: tab, comma quoted RFC4180, comma trơn', () => {
    expect(splitDataLine('a\tb\tc')).toEqual(['a', 'b', 'c']);
    expect(splitDataLine('a,"b,1","c""x"')).toEqual(['a', 'b,1', 'c"x']);
    expect(splitDataLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('đọc theo TÊN header, thiếu cột bắt buộc là lỗi (§8.1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demand-data-'));
    const tsv = join(dir, 'sample.csv');
    writeFileSync(tsv, 'B\tA\n2\t1\n');
    expect(readDelimitedFile(tsv, ['A', 'B'])).toEqual([{ A: '1', B: '2' }]);
    expect(() => readDelimitedFile(tsv, ['A', 'C'])).toThrowError(/thiếu cột bắt buộc \[C\]/);
  });
});

describe('data-contract.mjs — validator CLI (§12.16–18)', () => {
  function minimalDataset(): Record<string, unknown> {
    return JSON.parse(JSON.stringify({
      contractVersion: 'DEMAND-SIMULATION-DATASET-V1',
      datasetId: 'test',
      datasetKind: 'MOCK',
      generatedAt: '2026-07-16T00:00:00Z',
      metadata: {
        runMode: 'PLANNING_SIMULATION', runDate: '2026-06-01', calendarScaffold: 'PRESCAFFOLDED',
        historyYears: 3, cycleLengthDays: 15, storeCode: 'M', storeScopeStatus: 'SYNTHETIC_FIXTURE',
        portfolioMode: 'SELECTED_SKU_SIMULATION', extractIsTruncated: true,
        sourceWatermarks: { sales: '2026-05-31', stock: '2026-05-31' }, extractionCompleted: true,
        qualityGates: { stockReconciliation: 'PASS', stockMismatchSkuCount: 0 },
        rowCounts: { dailyRecords: 1, products: 1 }, policyOverrides: {},
      },
      products: [{ id: 'SKU-011' }],
      dailyRecords: [{
        storeCode: 11, productCode: 11, barcode: '11', productName: 'Prod 11', date: '2026-05-01',
        openStock: 1, closeStock: 1, sales: 0, hasSalesRecord: true, price: 10,
        promotionCode: null, promotionName: null, promotionStartDate: null, promotionEndDate: null,
        promotionType: null, promotionMechanismType: null, promotionClass: 'NO_PROMOTION',
        receiptHour: null, stockStatus: 'CALCULATED',
      }],
      promotionIntervals: [],
    }));
  }

  it('dataset hợp lệ tối thiểu: không lỗi', () => {
    expect(validateDataset(minimalDataset())).toEqual([]);
  });

  it('§12.18 — không đổi null thành 0: hasSalesRecord=false + sales=0 bị chặn', () => {
    const dataset = minimalDataset();
    (dataset['dailyRecords'] as Record<string, unknown>[])[0]['hasSalesRecord'] = false;
    (dataset['dailyRecords'] as Record<string, unknown>[])[0]['sales'] = 0;
    expect(validateDataset(dataset).join('\n')).toMatch(/vi phạm null\/0/);
  });

  it('§12.17 — SKU không thuộc products (lệch cohort) bị chặn', () => {
    const dataset = minimalDataset();
    (dataset['dailyRecords'] as Record<string, unknown>[])[0]['productCode'] = 12;
    expect(validateDataset(dataset).join('\n')).toMatch(/UNKNOWN_SKU/);
  });

  it('§12.16 — row count metadata lệch thực tế bị chặn', () => {
    const dataset = minimalDataset();
    ((dataset['metadata'] as Record<string, unknown>)['rowCounts'] as Record<string, unknown>)['dailyRecords'] = 5;
    expect(validateDataset(dataset).join('\n')).toMatch(/ROW_COUNT/);
  });

  it('trùng khóa sku+date bị chặn', () => {
    const dataset = minimalDataset();
    const rows = dataset['dailyRecords'] as Record<string, unknown>[];
    rows.push({ ...rows[0] });
    ((dataset['metadata'] as Record<string, unknown>)['rowCounts'] as Record<string, unknown>)['dailyRecords'] = 2;
    expect(validateDataset(dataset).join('\n')).toMatch(/DUPLICATE_DAILY_KEY/);
  });

  it('gate đối soát tồn FAIL là lỗi Critical', () => {
    const dataset = minimalDataset();
    ((dataset['metadata'] as Record<string, unknown>)['qualityGates'] as Record<string, unknown>)['stockReconciliation'] = 'FAIL';
    expect(validateDataset(dataset).join('\n')).toMatch(/STOCK_RECONCILIATION/);
  });
});

describe('hai file dataset đã build đạt hợp đồng CLI', () => {
  it.each([
    'src/assets/demand-planning/datasets/mock.dataset.json',
    'src/assets/demand-planning/datasets/real.dataset.json',
  ])('%s', path => {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(validateDataset(parsed)).toEqual([]);
  });

  it('REAL sparse không tự xác nhận ngày thiếu sales row là zero', () => {
    const parsed = JSON.parse(readFileSync('src/assets/demand-planning/datasets/real.dataset.json', 'utf8')) as {
      dailyRecords: { hasSalesRecord: boolean; sales: number | null }[];
    };
    const hasSparseDay = parsed.dailyRecords.some(r => !r.hasSalesRecord && r.sales === null);
    expect(hasSparseDay).toBe(true);
  });

  it('sales trong REAL JSON bằng đúng tổng Sales theo SKU-ngày của CSV', () => {
    const csvRows = readDelimitedFile('Sql/sales-history.csv', ['ProductCode', 'Date', 'Sales', 'HasSalesRecord']);
    const expected = new Map<string, number>();
    for (const row of csvRows) {
      if (row.HasSalesRecord !== '1') continue;
      const key = `${row.ProductCode}|${isoDateFrom(row.Date)}`;
      expected.set(key, (expected.get(key) ?? 0) + requiredNumber(row.Sales, key));
    }
    const parsed = JSON.parse(readFileSync('src/assets/demand-planning/datasets/real.dataset.json', 'utf8')) as {
      dailyRecords: { productCode: number; date: string; sales: number | null; hasSalesRecord: boolean }[];
    };
    const actual = new Map(parsed.dailyRecords.filter(row => row.hasSalesRecord).map(row => [`${row.productCode}|${row.date}`, row.sales]));
    expect(actual.size).toBe(expected.size);
    for (const [key, qty] of expected) expect(actual.get(key), key).toBe(qty);
  });
});
