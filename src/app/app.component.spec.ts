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

describe('Demand Planning simulation shell', () => {
  it('khởi động vào màn hình mô phỏng chính', () => {
    const { app, store } = createApp();

    expect(app.visibleCatalog()).toHaveLength(store.catalog.length);
    expect(store.activeStage()).toBe(1);
    expect(store.completedStage()).toBe(0);
  });

  it('chọn chặng sẽ chạy tuần tự pipeline và giữ đúng SKU đang xem', async () => {
    const { app, store } = createApp();

    app.selectSkuId('SKU-005');
    await store.selectStage(8);

    expect(store.completedStage()).toBe(8);
    expect(store.selectedSkuId()).toBe('SKU-005');
    expect(app.stageStatus(8)).toBe('active');
    expect(app.visibleCatalog().some(sku => sku.id === 'SKU-005')).toBe(true);
  });

  it('đổi nguồn dữ liệu đặt lại lựa chọn ngày audit', () => {
    const { app } = createApp();

    app.auditDate.set('2026-01-01');
    app.selectDataSource('mock');

    expect(app.auditDate()).toBeNull();
  });
});
