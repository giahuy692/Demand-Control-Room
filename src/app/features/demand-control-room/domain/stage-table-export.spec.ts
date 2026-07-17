import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageNumber, StageSnapshot } from './models';
import { buildStageTableExport, encodeStageTableCsv, StageTableExport } from './stage-table-export';
import { testEngine } from '../data-access/testing/file-dataset.testing';

function runAllStages(): Partial<Record<StageNumber, StageSnapshot>> {
  const engine = testEngine();
  const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
  let previous: StageSnapshot | null = null;
  for (let number = 1; number <= 20; number++) {
    const stage = number as StageNumber;
    previous = engine.run(stage, previous, DEFAULT_POLICY);
    snapshots[stage] = previous;
  }
  return snapshots;
}

describe('stage-table-export', () => {
  const snapshots = runAllStages();
  const selectedSkuId = Object.keys(snapshots[1]!.states)[0];

  it('mọi chặng đã chạy đều có dữ liệu xuất cho bảng audit/insight đang xem', { timeout: 60_000 }, () => {
    for (let number = 1; number <= 20; number++) {
      const stage = number as StageNumber;
      const exportData = buildStageTableExport(snapshots[stage]!, selectedSkuId, DEFAULT_POLICY);

      expect(exportData, `Chặng ${stage}`).not.toBeNull();
      expect(exportData!.columns.length, `Chặng ${stage}`).toBeGreaterThan(0);
      expect(exportData!.rows.length, `Chặng ${stage}`).toBeGreaterThan(0);
      expect(exportData!.fileName).toContain(`chang-${stage.toString().padStart(2, '0')}`);
    }
  });

  it('Chặng 1–4 xuất bảng ngày với các cột truy vết nền và tham chiếu', () => {
    const exportData = buildStageTableExport(snapshots[4]!, selectedSkuId, DEFAULT_POLICY)!;

    expect(exportData.columns).toEqual(expect.arrayContaining([
      'sku', 'date', 'hasSalesRecord', 'salesObservationStatus', 'sales',
      'openStock', 'closeStock', 'receiptHour', 'promotionStatus', 'stockoutStatus',
      'baseDemand', 'baseDemandSource', 'isCleanObservedReference', 'technicalFillStatus',
      'referenceDatesUsed', 'referenceEvidence', 'reason',
    ]));
    expect(exportData.rows[0]['sku']).toBe(selectedSkuId);
  });

  it('Chặng 7 và 9 xuất dữ liệu toàn danh mục, không chỉ SKU đang chọn', () => {
    const stage7 = buildStageTableExport(snapshots[7]!, selectedSkuId, DEFAULT_POLICY)!;
    const stage9 = buildStageTableExport(snapshots[9]!, selectedSkuId, DEFAULT_POLICY)!;

    expect(stage7.scope).toBe('Toàn danh mục');
    expect(stage7.rows.length).toBe(Object.keys(snapshots[7]!.states).length);
    expect(stage9.rows.map(row => row['cell'])).toEqual(expect.arrayContaining(['AX', 'BY', 'CZ', 'D/N-A']));
  });

  it('CSV giữ metadata và escape đúng dấu phẩy, nháy kép, xuống dòng', () => {
    const exportData: StageTableExport = {
      stage: 1,
      title: 'Chặng 01 - Kiểm thử',
      scope: 'SKU-TEST',
      fileName: 'audit-insight-chang-01-SKU-TEST.csv',
      columns: ['sku', 'note'],
      rows: [{ sku: 'SKU-TEST', note: 'Có dấu, có "nháy"\nvà xuống dòng' }],
    };

    const csv = encodeStageTableCsv(exportData);

    expect(csv).toContain('title,Chặng 01 - Kiểm thử');
    expect(csv).toContain('"Có dấu, có ""nháy""\nvà xuống dòng"');
  });
});
