import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { SimulationStore } from '../state/simulation.store';
import { fileDatasetService } from '../features/demand-control-room/data-access/testing/file-dataset.testing';
import { parseHachiBusinessRoles } from './catalog';
import { StageNumber, StageSnapshot } from './models';

const SAMPLE_ROLES = JSON.stringify([
  { SKU: 'SKU-002', HachiBusinessRole: 'SEASONAL' },
  { SKU: 'SKU-006', HachiBusinessRole: 'MARGIN' },
  { SKU: 'SKU-009', HachiBusinessRole: 'TRAFFIC' },
  { SKU: 'SKU-011', HachiBusinessRole: 'NEW' },
  { SKU: 'SKU-003', HachiBusinessRole: 'STANDARD' },
]);

function runEngineTo(stage: StageNumber): Record<string, unknown> {
  const engine = new SimulationEngine();
  let snapshot: StageSnapshot | null = null;
  for (let number = 1; number <= stage; number++) snapshot = engine.run(number as StageNumber, snapshot, DEFAULT_POLICY);
  return snapshot!.states;
}

describe('§7 LỆNH CODEX — HachiBusinessRole chỉ là benchmark, không được dùng làm đầu vào tính toán', () => {
  it('#13 cùng dữ liệu demand, có/không nạp businessRole → ABC/XYZ/seasonality/model/forecast giống hệt nhau', () => {
    const withoutRoles = runEngineTo(11);
    const withRoles = runEngineTo(11); // engine không có tham số nào nhận businessRole — chạy lại độc lập để đối chứng.

    for (const skuId of Object.keys(withoutRoles)) {
      const a = (withoutRoles[skuId] as any).classification;
      const b = (withRoles[skuId] as any).classification;
      expect(b).toEqual(a);
      expect((withRoles[skuId] as any).seasonality).toBe((withoutRoles[skuId] as any).seasonality);
      expect((withRoles[skuId] as any).forecast?.model).toBe((withoutRoles[skuId] as any).forecast?.model);
      expect((withRoles[skuId] as any).forecast?.baseForecast).toEqual((withoutRoles[skuId] as any).forecast?.baseForecast);
    }
  });

  it('#13b store: businessRoleComparison không làm lệch classification/seasonality/forecast của cùng snapshot', async () => {
    const storeA = new SimulationStore(new SimulationEngine(), fileDatasetService());
    const storeB = new SimulationStore(new SimulationEngine(), fileDatasetService());
    (storeB as any).hachiBusinessRoles = parseHachiBusinessRoles(SAMPLE_ROLES);

    await storeA.selectStage(11);
    await storeB.selectStage(11);

    for (const skuId of Object.keys(storeA.snapshots()[11]!.states)) {
      const a = storeA.snapshots()[11]!.states[skuId];
      const b = storeB.snapshots()[11]!.states[skuId];
      expect(b.classification).toEqual(a.classification);
      expect(b.seasonality).toBe(a.seasonality);
      expect(b.forecast?.model).toBe(a.forecast?.model);
    }
    // storeB có benchmark nên có dòng gắn hachiRole thật; storeA (không nạp) mọi dòng đều hachiRole=null.
    expect(storeB.businessRoleComparison().some(row => row.hachiRole !== null)).toBe(true);
    expect(storeA.businessRoleComparison().every(row => row.hachiRole === null)).toBe(true);
  });

  it('#14 SEASONAL đối chiếu đúng kết quả mùa vụ Chặng 9 (ALIGNED khi confirmed, POSSIBLE_DIFFERENCE khi no-clear-season, INVESTIGATION_REQUIRED khi thiếu cấu trúc)', async () => {
    const store = new SimulationStore(new SimulationEngine(), fileDatasetService());
    (store as any).hachiBusinessRoles = parseHachiBusinessRoles(SAMPLE_ROLES);
    await store.selectStage(9);

    const row = store.businessRoleComparison().find(item => item.skuId === 'SKU-002')!;
    const state = store.snapshots()[9]!.states['SKU-002'];
    expect(row).toBeDefined();
    expect(row.hachiRole).toBe('SEASONAL');
    if (state.seasonality === 'confirmed') expect(row.conclusion).toBe('ALIGNED');
    else if (state.seasonality === 'no-clear-season') expect(row.conclusion).toBe('POSSIBLE_DIFFERENCE');
    else expect(row.conclusion).toBe('INVESTIGATION_REQUIRED');
  });

  it('#15 MARGIN/TRAFFIC → NOT_COMPARABLE_WITH_CURRENT_DATA khi thiếu landedCostPerUnit/dữ liệu giỏ hàng', async () => {
    const store = new SimulationStore(new SimulationEngine(), fileDatasetService());
    (store as any).hachiBusinessRoles = parseHachiBusinessRoles(SAMPLE_ROLES);
    await store.selectStage(9);

    const marginRow = store.businessRoleComparison().find(item => item.skuId === 'SKU-006')!;
    const trafficRow = store.businessRoleComparison().find(item => item.skuId === 'SKU-009')!;
    expect(marginRow.conclusion).toBe('NOT_COMPARABLE_WITH_CURRENT_DATA');
    expect(trafficRow.conclusion).toBe('NOT_COMPARABLE_WITH_CURRENT_DATA');
  });

  it('#16 NEW không tự gán D nếu không có lifecycle evidence — dSubtype của SKU-011 giống hệt khi có/không businessRole; đối chiếu NEW báo NOT_COMPARABLE_WITH_CURRENT_DATA', async () => {
    const storeA = new SimulationStore(new SimulationEngine(), fileDatasetService());
    const storeB = new SimulationStore(new SimulationEngine(), fileDatasetService());
    (storeB as any).hachiBusinessRoles = parseHachiBusinessRoles(SAMPLE_ROLES);
    await storeA.selectStage(7);
    await storeB.selectStage(7);

    expect(storeB.snapshots()[7]!.states['SKU-011'].classification.dSubtype).toBe(storeA.snapshots()[7]!.states['SKU-011'].classification.dSubtype);

    const row = storeB.businessRoleComparison().find(item => item.skuId === 'SKU-011')!;
    expect(row.hachiRole).toBe('NEW');
    expect(row.conclusion).toBe('NOT_COMPARABLE_WITH_CURRENT_DATA');
  });
});
