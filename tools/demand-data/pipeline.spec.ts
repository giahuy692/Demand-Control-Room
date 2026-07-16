import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, generateDailyRecords } from '../../src/app/domain/catalog';
import { DEFAULT_POLICY } from '../../src/app/domain/policy';
import { splitDataLine, readDelimitedFile } from './csv-reader.mjs';
import { validateDataset } from './data-contract.mjs';
import { buildMockDailyRows, buildMockProducts, fullCycleCount, MOCK_CYCLE_LENGTH, MOCK_HISTORY_YEARS, MOCK_RUN_DATE } from './mock-generator.mjs';

describe('mock-generator.mjs — PORT phải tái tạo đúng từng số của catalog.ts', () => {
  it('products khớp buildCatalog() (trừ portfolioMode/extractIsTruncated đã dời lên metadata)', () => {
    const ported = buildMockProducts();
    const original = buildCatalog().map(({ portfolioMode, extractIsTruncated, ...rest }) => rest);
    expect(ported).toEqual(original);
  });

  it('dòng ngày khớp generateDailyRecords() từng field dùng chung', () => {
    const maxCycles = fullCycleCount(MOCK_RUN_DATE, MOCK_HISTORY_YEARS, MOCK_CYCLE_LENGTH);
    expect(maxCycles).toBe(83); // T01 — 2026-06-01 tạo 83 chu kỳ
    const portedRows = buildMockDailyRows();
    const originalRows = buildCatalog().flatMap(definition =>
      generateDailyRecords(definition, DEFAULT_POLICY.runDate, DEFAULT_POLICY.cycleLength, maxCycles));
    expect(portedRows.length).toBe(originalRows.length);
    for (let index = 0; index < originalRows.length; index++) {
      const ported = portedRows[index];
      const original = originalRows[index];
      expect({ sku: ported.sku, date: ported.date, openStock: ported.openStock, closeStock: ported.closeStock, sales: ported.sales, receiptHour: ported.receiptHour, promoCode: ported.promoCode })
        .toEqual({ sku: original.sku, date: original.date, openStock: original.openStock, closeStock: original.closeStock, sales: original.sales, receiptHour: original.receiptHour, promoCode: original.promoCode });
    }
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
        sourceWatermarks: { sales: null, stock: null },
        qualityGates: { stockReconciliation: 'PASS', stockMismatchSkuCount: 0 },
        rowCounts: { dailyRecords: 1, products: 1 }, policyOverrides: {},
      },
      products: [{ id: 'S1' }],
      dailyRecords: [{
        sku: 'S1', date: '2026-05-01', openStock: 1, closeStock: 1, sales: 0, hasSalesRecord: true,
        isZeroSaleInferred: false, returnQty: null, hasReturnRecord: false, inventoryNetMovement: null,
        hasInventoryMovement: false, isHistoryRecord: true, isValidationActual: false,
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
    expect(validateDataset(dataset).join('\n')).toMatch(/vi phạm null\/0/);
  });

  it('§12.17 — SKU không thuộc products (lệch cohort) bị chặn', () => {
    const dataset = minimalDataset();
    (dataset['dailyRecords'] as Record<string, unknown>[])[0]['sku'] = 'S2';
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
});
