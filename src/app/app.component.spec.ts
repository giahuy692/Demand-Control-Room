import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { SimulationEngine } from './domain/simulation-engine';
import { SimulationStore } from './state/simulation.store';

function createApp(): { app: AppComponent; store: SimulationStore } {
  const store = new SimulationStore(new SimulationEngine());
  const app = new AppComponent(store);
  return { app, store };
}

describe('Demand Planning Monitor', () => {
  it('không hiển thị số minh họa khi chưa có snapshot', () => {
    const { app } = createApp();
    expect(app.monitorSnapshot()).toBeNull();
    expect(app.monitorRows()).toEqual([]);
    expect(app.monitorStats().total).toBe(0);
  });

  it('phủ đủ control board 19 chặng và cho phép một SKU có nhiều quyết định', async () => {
    const { app, store } = createApp();
    await store.selectStage(19);

    expect(app.monitorSnapshot()?.stage).toBe(19);
    expect(app.monitorStats().total).toBe(store.catalog.length);
    expect(app.monitorStats().completed).toBe(19);
    expect(app.monitorStageControls()).toHaveLength(19);
    expect(app.monitorStageControls().every(control => control.status !== 'pending')).toBe(true);
    expect(app.monitorDecisions().length).toBeGreaterThan(store.catalog.length);
    expect(new Set(app.monitorDecisions().map(item => item.sku.id)).size).toBeLessThan(app.monitorDecisions().length);
    expect(app.monitorDecisions().every(row => row.stage >= 1 && row.stage <= 19)).toBe(true);
  });

  it('tạo đúng các cổng duyệt quan trọng cho Z/D, forecast và phát hành', async () => {
    const { app, store } = createApp();
    await store.selectStage(19);
    const decisions = app.monitorDecisions();

    expect(decisions.some(item => item.stage === 7 && item.title.includes('Nhóm Z'))).toBe(true);
    expect(decisions.some(item => item.stage === 7 && item.title.includes('Nhóm D'))).toBe(true);
    expect(decisions.some(item => item.stage === 11 && item.title.includes('Dự báo'))).toBe(true);
    expect(app.monitorStageControls()[17].processed).toBe(store.catalog.length);
    expect(app.monitorStageControls()[17].result).toContain('Dòng phát hành');
    expect(app.monitorOutcomes()).toHaveLength(store.catalog.length);
  });

  it('lọc hàng đợi và drill-down về đúng SKU/chặng', async () => {
    const { app, store } = createApp();
    await store.selectStage(19);
    const target = app.monitorRows()[0];

    app.monitorQuery.set(target.sku.id);
    expect(app.monitorRows().length).toBeGreaterThan(0);
    expect(app.monitorRows().every(row => row.sku.id === target.sku.id)).toBe(true);

    app.monitorStageFilter.set(target.stage);
    expect(app.monitorRows().every(row => row.stage === target.stage)).toBe(true);

    app.openMonitorSku(target);
    expect(app.appMode()).toBe('simulation');
    expect(store.selectedSkuId()).toBe(target.sku.id);
    expect(store.activeStage()).toBe(target.stage);
  });
});
