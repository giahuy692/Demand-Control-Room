import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../domain/simulation-engine';
import { SkuPipelineState, StageNumber, StageSnapshot } from '../domain/models';
import { fileDatasetService } from './testing/file-dataset.testing';

describe('runtime dataset → pipeline parity', () => {
  for (const kind of ['mock', 'real'] as const) {
    it(`${kind} chạy đủ 19 stage qua cùng session/policy`, async () => {
      const session = await fileDatasetService().load(kind);
      const engine = new SimulationEngine();
      engine.setDataset(session.dataset);
      let snapshot: StageSnapshot | null = null;
      for (let number = 1; number <= 19; number++) {
        snapshot = engine.run(number as StageNumber, snapshot, session.policy);
      }
      expect(snapshot.stage).toBe(19);
      expect(Object.keys(snapshot.states)).toHaveLength(session.dataset.catalog.length);
      expect(session.dataset.source).toBe(kind);
    }, 30_000);
  }

  it('golden compact cho SKU REAL đại diện và SKU có CTKM dày nhất', async () => {
    const session = await fileDatasetService().load('real');
    const engine = new SimulationEngine();
    engine.setDataset(session.dataset);
    let snapshot: StageSnapshot | null = null;
    for (let number = 1; number <= 19; number++) {
      snapshot = engine.run(number as StageNumber, snapshot, session.policy);
    }

    const representativeSku = session.dataset.catalog[0]?.id ?? '';
    const promoDenseSku = Object.entries(session.dataset.dailyBySku)
      .map(([sku, rows]) => ({ sku, promoDays: rows.filter(row => row.promoCode !== null).length }))
      .sort((a, b) => b.promoDays - a.promoDays || a.sku.localeCompare(b.sku))[0]?.sku ?? '';
    const compact = (state: SkuPipelineState) => ({
      sku: state.definition.id,
      days: state.daily.length,
      stockoutDays: state.daily.filter(row => row.isStockout).length,
      lockedCycles: state.cycles.filter(cycle => cycle.locked).length,
      classification: state.classification,
      seasonality: state.seasonality,
      trend: state.trend,
      forecastModel: state.forecast?.model ?? null,
      forecastStatus: state.forecast?.status ?? null,
      promoFactor: state.promoFactor,
      finalForecastStatus: state.finalForecastStatus,
      supplyStatus: state.supplyStatus,
      releaseStatus: state.releaseDecision?.status ?? null,
      postAuditStatus: state.postAudit?.status ?? null,
    });

    expect({
      datasetId: session.datasetId,
      representative: compact(snapshot.states[representativeSku]),
      promoDense: compact(snapshot.states[promoDenseSku]),
    }).toMatchSnapshot();
  }, 30_000);
});
