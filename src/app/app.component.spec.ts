import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { AppComponent } from './app.component';
import { SimulationEngine } from './features/demand-control-room/domain/simulation-engine';
import { SimulationStore } from './features/demand-control-room/application/state/simulation.store';
import { fileDatasetService } from './features/demand-control-room/data-access/testing/file-dataset.testing';
import { SalesObservationStatus, StockoutStatus } from './features/demand-control-room/domain/models';

function createApp(): { app: AppComponent; store: SimulationStore } {
  const store = new SimulationStore(new SimulationEngine(), fileDatasetService());
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
  it('giới hạn DOM bảng audit nhưng vẫn cho phép mở toàn bộ dữ liệu', async () => {
    const { app, store } = createApp();

    await store.selectStage(1);
    expect(app.renderedAuditDailyRows().length).toBeLessThanOrEqual(300);

    app.auditRowsExpanded.set(true);
    expect(app.renderedAuditDailyRows()).toHaveLength(app.auditDailyRows().length);
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

  it('sắp xếp danh sách SKU theo tiêu chí của chặng', async () => {
    const { app, store } = createApp();

    // Default sorting (by ID ascending) when pipeline has not run
    const catalogBefore = app.visibleCatalog();
    for (let i = 0; i < catalogBefore.length - 1; i++) {
      expect(catalogBefore[i].id.localeCompare(catalogBefore[i+1].id)).toBeLessThan(0);
    }

    // Run to Stage 2 (Stockout)
    await store.selectStage(2);
    const catalogStage2 = app.visibleCatalog();

    for (let i = 0; i < catalogStage2.length - 1; i++) {
      const aState = app.stateFor(catalogStage2[i].id);
      const bState = app.stateFor(catalogStage2[i+1].id);
      const aSO = aState?.daily?.filter(d => d.stockoutStatus !== StockoutStatus.NONE).length ?? 0;
      const bSO = bState?.daily?.filter(d => d.stockoutStatus !== StockoutStatus.NONE).length ?? 0;

      if (aSO !== bSO) {
        expect(aSO).toBeGreaterThan(bSO);
      } else {
        expect(catalogStage2[i].id.localeCompare(catalogStage2[i+1].id)).toBeLessThan(0);
      }
    }
  });

  it('Snapshot Chặng 1 chỉ đếm và sắp xếp theo ngày có bản ghi nguồn', async () => {
    const { app, store } = createApp();

    await store.selectStage(1);
    const catalog = app.visibleCatalog();

    for (let i = 0; i < catalog.length; i++) {
      const recordedDays = app.stateFor(catalog[i].id)!.daily.filter(day => day.hasSalesRecord).length;
      expect(app.getSkuSortValueLabel(catalog[i])).toBe(`${recordedDays} ngày ghi nhận bán`);
      if (i > 0) {
        const previousRecordedDays = app.stateFor(catalog[i - 1].id)!.daily.filter(day => day.hasSalesRecord).length;
        expect(previousRecordedDays).toBeGreaterThanOrEqual(recordedDays);
      }
    }
  });

  it('sắp xếp Chặng 7 từ nhu cầu ổn định đến thiếu dữ liệu', async () => {
    const { app, store } = createApp();
    const order: Record<string, number> = { X: 4, Y: 3, Z: 2, D: 1, BLOCKED: 0 };

    await store.selectStage(7);
    const catalog = app.visibleCatalog();

    for (let i = 0; i < catalog.length - 1; i++) {
      const current = app.stateFor(catalog[i].id)?.classification.xyz ?? 'BLOCKED';
      const next = app.stateFor(catalog[i + 1].id)?.classification.xyz ?? 'BLOCKED';
      expect(order[current] ?? 0).toBeGreaterThanOrEqual(order[next] ?? 0);
    }
  });

  it('vẽ cấu trúc nhu cầu đúng grain và không biến dữ liệu thiếu thành 0', async () => {
    const { app, store } = createApp();

    await store.selectStage(1);
    const dailyChart = app.demandStructureChart();
    const recentDays = app.auditDailyRows().slice(-60);
    expect(dailyChart?.bars).toHaveLength(recentDays.length);
    recentDays.forEach((row, index) => {
      if (row.salesObservationStatus === SalesObservationStatus.SOURCE_DATA_GAP) {
        expect(dailyChart?.bars[index].kind).toBe('missing');
        expect(dailyChart?.bars[index].value).toBeNull();
      }
    });

    // Chặng 2–4 cũng làm việc cấp ngày — panel phải hiển thị (trước đây trả null làm panel biến mất),
    // và ngày chưa có nền/bằng chứng bán vẫn là missing, không bị biến thành 0.
    await store.selectStage(2);
    const stage2Chart = app.demandStructureChart();
    expect(stage2Chart).not.toBeNull();
    expect(stage2Chart!.unit).toBe('đơn vị/ngày');
    app.auditDailyRows().slice(-60).forEach((row, index) => {
      if (row.baseDemand === null && row.salesObservationStatus === SalesObservationStatus.SOURCE_DATA_GAP) {
        expect(stage2Chart!.bars[index].kind).toBe('missing');
        expect(stage2Chart!.bars[index].value).toBeNull();
      }
    });

    await store.selectStage(3);
    const stage3Chart = app.demandStructureChart()!;
    app.auditDailyRows().slice(-60).forEach((row, index) => {
      expect(stage3Chart.bars[index].value).toBe(row.baseDemand);
    });

    await store.selectStage(6);
    const cycleChart = app.demandStructureChart();
    expect(cycleChart).not.toBeNull();
    for (const bar of cycleChart!.bars) {
      const cycle = app.auditCycles().find(item => `CK-${item.cycleIndex}` === bar.key);
      if (cycle && !cycle.locked) expect(bar.value).toBeNull();
    }

    // Chặng 7–20 mang dữ liệu chu kỳ và finalForecast đi tiếp nên panel cũng phải hiển thị.
    for (const stage of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const) {
      await store.selectStage(stage);
      expect(app.demandStructureChart(), `Chặng ${stage} phải có biểu đồ`).not.toBeNull();
    }
    const finalState = store.view().state!;
    expect(app.demandStructureChart()!.bars.filter(bar => bar.kind === 'forecast')).toHaveLength(Math.min(6, finalState.finalForecast.length));
  });

  it('nút chặng trước/sau đổi đúng snapshot dữ liệu và biểu đồ', async () => {
    const { app, store } = createApp();
    await store.selectStage(6);

    const stage6State = app.auditState();
    const stage6Chart = app.demandStructureChart();
    app.auditDate.set(stage6State!.daily[0]!.date);
    app.highlightedCycleIndex.set(1);
    app.currentAnomalyIndex.set({ type: 'stockout', index: 0 });
    app.goPrevious();
    const stage5State = app.auditState();
    const stage5Chart = app.demandStructureChart();

    expect(store.activeStage()).toBe(5);
    expect(stage5State).toBe(store.snapshots()[5]!.states[store.selectedSkuId()]);
    expect(stage5State).not.toBe(stage6State);
    expect(stage5Chart?.unit).toBe('đơn vị/ngày');
    expect(stage6Chart?.unit).toBe('đơn vị/chu kỳ');
    expect(app.auditDate()).toBeNull();
    expect(app.highlightedCycleIndex()).toBeNull();
    expect(app.currentAnomalyIndex()).toEqual({ type: '', index: -1 });

    app.goNext();
    expect(store.activeStage()).toBe(6);
    expect(app.auditState()).toBe(stage6State);
    expect(app.demandStructureChart()).toEqual(stage6Chart);
  });

  it('phân biệt thiếu nguồn với có nguồn nhưng chưa đủ nền ở Chặng 6', async () => {
    const { app, store } = createApp();
    await store.selectStage(6);
    const source = app.auditCycles()[0];
    const row = app.auditDailyRows()[0];
    const noSource = { ...source, locked: false, emptyCycle: true, status: 'NO_SOURCE_RECORD' as const, sourceRecordDays: 0, unresolvedDays: source.days };
    const noBaseline = { ...source, locked: false, emptyCycle: true, status: 'BLOCKED_NO_VALID_BASELINE' as const, sourceRecordDays: source.days, unresolvedDays: source.days };

    expect(app.cycleStatusLabel(noSource)).toBe('KHÔNG CÓ NGUỒN');
    expect(app.cycleStatusExplanation(noSource)).toContain('thiếu nguồn');
    expect(app.cycleStatusLabel(noBaseline)).toContain('CHẶN');
    expect(app.cycleDayIssue({ ...row, hasSalesRecord: false, salesObservationStatus: SalesObservationStatus.SOURCE_DATA_GAP, sales: null, baseDemand: null })).toContain('không phải 0');
  });
});

