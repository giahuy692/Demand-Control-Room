import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../domain/simulation-engine';
import { SkuPipelineState, StageNumber, StageSnapshot } from '../domain/models';
import { fileDatasetService } from './testing/file-dataset.testing';

describe('runtime dataset → pipeline parity', () => {
  for (const kind of ['mock', 'real'] as const) {
    it(`${kind} chạy đủ 20 stage qua cùng session/policy`, async () => {
      const session = await fileDatasetService().load(kind);
      const engine = new SimulationEngine();
      engine.setDataset(session.dataset);
      let snapshot: StageSnapshot | null = null;
      for (let number = 1; number <= 20; number++) {
        snapshot = engine.run(number as StageNumber, snapshot, session.policy);
      }
      expect(snapshot.stage).toBe(20);
      expect(Object.keys(snapshot.states)).toHaveLength(session.dataset.catalog.length);
      expect(session.dataset.source).toBe(kind);
    }, 30_000);
  }

  it('REAL báo cáo độ phủ sales observation và kết quả lấp Chặng 5', async () => {
    const session = await fileDatasetService().load('real');
    const engine = new SimulationEngine();
    engine.setDataset(session.dataset);
    let snapshot: StageSnapshot | null = null;
    const summaries: Record<number, Record<string, unknown>> = {};
    for (let number = 1; number <= 6; number++) {
      snapshot = engine.run(number as StageNumber, snapshot, session.policy);
      summaries[number] = snapshot.summary;
    }
    const sourceRows = Object.values(session.dataset.dailyBySku).reduce((sum, rows) => sum + rows.length, 0);
    const result = {
      sourceRowsBeforeCalendar: sourceRows,
      recordedSale: summaries[1]['RECORDED_SALE'],
      confirmedZero: summaries[1]['CONFIRMED_ZERO'],
      sourceDataGap: summaries[1]['SOURCE_DATA_GAP'],
      technicalFillDays: summaries[5]['Ngày được bổ sung'],
      blockedCycles: summaries[6]['BLOCKED_NO_VALID_BASELINE'],
    };
    expect(Number(result.recordedSale) + Number(result.confirmedZero) + Number(result.sourceDataGap)).toBeGreaterThan(sourceRows);
    expect(result).toMatchInlineSnapshot(`
      {
        "blockedCycles": 423,
        "confirmedZero": 45541,
        "recordedSale": 27224,
        "sourceDataGap": 0,
        "sourceRowsBeforeCalendar": 72275,
        "technicalFillDays": 79,
      }
    `);
  }, 30_000);

  it('golden compact cho SKU REAL đại diện và SKU có CTKM dày nhất', async () => {
    const session = await fileDatasetService().load('real');
    const engine = new SimulationEngine();
    engine.setDataset(session.dataset);
    let snapshot: StageSnapshot | null = null;
    for (let number = 1; number <= 20; number++) {
      snapshot = engine.run(number as StageNumber, snapshot, session.policy);
    }

    const representativeSku = session.dataset.catalog[0]?.id ?? '';
    const promoDenseSku = Object.entries(session.dataset.dailyBySku)
      .map(([sku, rows]) => ({ sku, promoDays: rows.filter(row => row.promoCode !== null).length }))
      .sort((a, b) => b.promoDays - a.promoDays || a.sku.localeCompare(b.sku))[0]?.sku ?? '';
    const compact = (state: SkuPipelineState) => ({
      sku: state.definition.id,
      days: state.daily.length,
      stockoutDays: state.daily.filter(row => row.stockoutStatus !== 'NONE').length,
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
