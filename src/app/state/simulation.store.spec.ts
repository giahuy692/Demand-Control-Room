import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../domain/simulation-engine';
import { SimulationStore } from './simulation.store';

describe('SimulationStore synchronization invariants', () => {
  it('khởi tạo ở Chặng 1 nhưng chưa chạy snapshot nào', () => {
    const store = new SimulationStore(new SimulationEngine());
    expect(store.activeStage()).toBe(1);
    expect(store.completedStage()).toBe(0);
    expect(store.snapshots()).toEqual({});
    expect(store.view().hasRun).toBe(false);
    expect(store.view().state).toBeNull();
  });

  it('giữ snapshot Chặng 6 bất biến sau khi tự chạy Chặng 7', async () => {
    const store = new SimulationStore(new SimulationEngine());
    await store.selectStage(6);
    const snapshot6 = store.snapshots()[6]!;
    const before = JSON.stringify(snapshot6);
    expect(store.stageLabel(snapshot6.states['SKU-005'], 6)).toBe(snapshot6.states['SKU-005'].classification.abc);
    await store.selectStage(7);
    expect(JSON.stringify(store.snapshots()[6])).toBe(before);
  });

  it('click thẳng Chặng 8 tự chạy tuần tự 1→8 và đổi SKU cùng snapshot', async () => {
    const store = new SimulationStore(new SimulationEngine());
    await store.selectStage(8);
    expect(store.completedStage()).toBe(8);
    expect(Object.keys(store.snapshots())).toHaveLength(8);
    store.selectSku('SKU-005');
    const state = store.snapshots()[8]!.states['SKU-005'];
    expect(store.view().state?.definition.id).toBe('SKU-005');
    expect(store.stageLabel(store.view().state)).toBe(state.serviceLevel === null ? 'D' : `${state.classification.abc}${state.classification.xyz}`);
    await store.selectStage(6);
    expect(store.stageLabel(store.view().state)).toBe(store.view().state?.classification.abc);
  });

  it('đổi tham số phiên giữ nguyên chặng active và tự chạy lại đến chặng đó', async () => {
    const store = new SimulationStore(new SimulationEngine());
    await store.selectStage(6);
    const previousSnapshot = store.snapshots()[6];

    await store.updatePolicy({ cycleLength: 7 });

    expect(store.policy().cycleLength).toBe(7);
    expect(store.activeStage()).toBe(6);
    expect(store.completedStage()).toBe(6);
    expect(Object.keys(store.snapshots())).toHaveLength(6);
    expect(store.snapshots()[6]).not.toBe(previousSnapshot);
    expect(store.view().hasRun).toBe(true);
  });

  it('lưu ngày méo, ngày sạch tham chiếu và lineage Chặng 3→4 trong snapshot', async () => {
    const store = new SimulationStore(new SimulationEngine());
    await store.selectStage(4);
    const stage3 = store.snapshots()[3]!.states['SKU-001'];
    const distorted = stage3.daily.find(row => row.isStockout && !row.promoCode && row.referenceDates.length >= 3)!;
    expect(distorted.balanceStatus).not.toBeNull();
    expect(distorted.referenceMedian).not.toBeNull();
    expect([...distorted.beforeReferenceDates, ...distorted.afterReferenceDates]).toEqual(distorted.referenceDates);
    expect(distorted.referenceDates.every(date => {
      const reference = stage3.daily.find(row => row.date === date)!;
      return !reference.isStockout && !reference.promoCode && reference.baseSource === 'clean';
    })).toBe(true);
    const promoAtStage3 = stage3.daily.find(row => row.promoCode && row.baseSource === 'promo-defer')!;
    const promoAtStage4 = store.snapshots()[4]!.states['SKU-001'].daily.find(row => row.date === promoAtStage3.date)!;
    expect(promoAtStage3.baseDemand).toBeNull();
    expect(promoAtStage4.baseSource).toMatch(/promo-normalized|insufficient/);
  });
});
