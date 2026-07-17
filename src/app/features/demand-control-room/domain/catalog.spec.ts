import { describe, expect, it } from 'vitest';
import { fixtureDailyRecord } from '../data-access/dto/dataset-fixture';
import { realDatasetFromRows } from '../data-access/testing/file-dataset.testing';
import { parseHachiBusinessRoles } from './catalog';

describe('SimulationDataset domain mapping', () => {
  it('giữ null khác zero', () => {
    const dataset = realDatasetFromRows([
      fixtureDailyRecord({ sku: '1', date: '2026-01-01', sales: null, hasSalesRecord: false, openStock: 10, closeStock: 10, totalStockDelta: 0 }),
      fixtureDailyRecord({ sku: '1', date: '2026-01-02', sales: 0, hasSalesRecord: true, openStock: 10, closeStock: 10, totalStockDelta: 0 }),
    ]);

    expect(dataset.dailyBySku['1'].map(row => row.sales)).toEqual([null, 0]);
    expect(dataset.dailyBySku['1'].map(row => row.salesObservationStatus)).toEqual(['SOURCE_DATA_GAP', 'RECORDED_SALE']);
  });

});

describe('parseHachiBusinessRoles', () => {
  it('chỉ nhận role hợp lệ', () => {
    expect(parseHachiBusinessRoles(JSON.stringify([
      { SKU: 'SKU-001', HachiBusinessRole: 'CORE' },
      { SKU: '', HachiBusinessRole: 'CORE' },
      { SKU: 'SKU-002', HachiBusinessRole: 'NOT_A_ROLE' },
    ]))).toEqual({ 'SKU-001': 'CORE' });
  });

  it('payload hỏng trả map rỗng vì asset benchmark là optional', () => {
    expect(parseHachiBusinessRoles('not json')).toEqual({});
  });
});
