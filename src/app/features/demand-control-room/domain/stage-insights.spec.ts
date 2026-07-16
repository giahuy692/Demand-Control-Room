import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { testEngine } from '../data-access/testing/file-dataset.testing';
import { StageNumber, StageSnapshot } from './models';
import {
  buildAbcBoard, buildFinalForecastAudit, buildForecastAudit, buildPolicyMatrix, buildPromoAudit,
  buildSafetyAudit, buildSeasonalityAudit, buildSupplyAudit, buildTrendAudit, buildXyzBoard,
} from './stage-insights';

function runPipeline(): Partial<Record<StageNumber, StageSnapshot>> {
  const engine = testEngine();
  const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
  let previous: StageSnapshot | null = null;
  for (let stage = 1; stage <= 15; stage++) {
    previous = engine.run(stage as StageNumber, previous, DEFAULT_POLICY);
    snapshots[stage as StageNumber] = previous;
  }
  return snapshots;
}

describe('stage-insights — panel trái đối ứng từng chặng', () => {
  const snapshots = runPipeline();

  it('bảng ABC/XYZ/ma trận phủ đúng toàn bộ danh mục', () => {
    const states6 = snapshots[6]!.states;
    const board = buildAbcBoard(states6);
    expect(board).toHaveLength(Object.keys(states6).length);
    const rated = board.filter(row => row.rank !== null);
    const notRated = board.filter(row => row.rank === null);
    // Chỉ SKU đủ N >= 6 tham gia tỷ trọng/lũy kế; N/A nằm ngoài mẫu số.
    expect(rated.reduce((sum, row) => sum + row.valueShare, 0)).toBeCloseTo(1);
    for (let index = 1; index < rated.length; index++) {
      expect(rated[index].cumulativeShare).toBeGreaterThanOrEqual(rated[index - 1].cumulativeShare);
    }
    expect(notRated.every(row => row.valueShare === 0 && row.annualQuantity === null && row.abc === 'N/A')).toBe(true);
    const xyz = buildXyzBoard(snapshots[7]!.states);
    expect(xyz).toHaveLength(board.length);
    const matrix = buildPolicyMatrix(snapshots[8]!.states, 'SKU-001');
    const total = matrix.totalInMatrix + matrix.exceptions.count;
    expect(total).toBe(board.length);
  });

  it('các cột kết quả Chặng 6–7 khớp dữ liệu engine đã khóa', () => {
    const abc = buildAbcBoard(snapshots[6]!.states);
    for (const row of abc) {
      const locked = snapshots[6]!.states[row.id].classification;
      expect(row.lockedCycles).toBe(locked.lockedCycles);
      expect(row.annualQuantity).toBe(locked.annualQuantity);
      expect(row.annualValue).toBe(locked.annualValue);
      expect(row.valueShare).toBe(locked.valueShare);
      expect(row.cumulativeShare).toBe(locked.cumulativeShare);
      expect(row.abc).toBe(locked.abc);
    }

    const xyz = buildXyzBoard(snapshots[7]!.states);
    for (const row of xyz) {
      const locked = snapshots[7]!.states[row.id].classification;
      expect(row.n).toBe(locked.n);
      expect(row.m).toBe(locked.m);
      expect(row.adi).toBe(locked.adi);
      expect(row.positiveMean).toBe(locked.positiveMean);
      expect(row.positiveStdev).toBe(locked.positiveStdev);
      expect(row.cv).toBe(locked.cv);
      expect(row.cv2).toBe(locked.cv2);
      expect(row.xyz).toBe(locked.xyz);
    }
  });

  it('mọi SKU đều dựng được insight ở mọi chặng 9–15 mà không lỗi', () => {
    for (const skuId of Object.keys(snapshots[15]!.states)) {
      expect(() => {
        buildSeasonalityAudit(snapshots[9]!.states[skuId]);
        buildTrendAudit(snapshots[10]!.states[skuId]);
        buildForecastAudit(snapshots[11]!.states[skuId]);
        buildPromoAudit(snapshots[12]!.states[skuId]);
        buildFinalForecastAudit(snapshots[13]!.states[skuId]);
        buildSupplyAudit(snapshots[14]!.states[skuId]);
        buildSafetyAudit(snapshots[15]!.states[skuId]);
      }, `SKU ${skuId}`).not.toThrow();
    }
  });

  it('diễn biến học Chặng 11 dựng lại khớp tuyệt đối kết quả engine đã khóa', () => {
    for (const state of Object.values(snapshots[11]!.states)) {
      const fit = buildForecastAudit(state);
      expect(fit.result.model).toBe(state.forecast!.model);
      expect(fit.result.params).toEqual(state.forecast!.params);
      expect(fit.result.baseForecast).toEqual(state.forecast!.baseForecast);
      expect(fit.result.wape).toBe(state.forecast!.wape);
      expect(fit.result.bias).toBe(state.forecast!.bias);
      expect(fit.result.lockStatus).toBe(state.forecast!.lockStatus);
    }
  });

  it('bảng mùa vụ Chặng 9 khớp kết luận engine cho SKU nhóm Y đủ chuỗi', () => {
    for (const state of Object.values(snapshots[9]!.states)) {
      const audit = buildSeasonalityAudit(state);
      expect(audit.status).toBe(state.seasonality);
      if (state.seasonality === 'confirmed') {
        expect(audit.rows.some(row => row.verdict !== '—')).toBe(true);
      }
      if (state.seasonality === 'no-clear-season') {
        expect(audit.rows.every(row => row.verdict === '—')).toBe(true);
      }
    }
  });

  it('hệ số K Chặng 12 dựng lại khớp promoFactor engine', () => {
    for (const state of Object.values(snapshots[12]!.states)) {
      const audit = buildPromoAudit(state);
      if (audit.rawMedian === null) expect(state.promoFactor).toBeNull();
      else expect(audit.rawMedian).toBe(state.promoFactor);
      expect(audit.confidence).toBe(state.promoConfidence);
    }
  });

  it('Chặng 15 ưu tiên sai số backtest và quy đổi lead time theo độ dài chu kỳ', () => {
    const snapshots = runPipeline();
    const state = Object.values(snapshots[15]!.states).find(item => item.serviceLevel && item.forecast?.model !== 'PurchasePlan')!;
    const audit = buildSafetyAudit(state);
    expect(audit.ltBarCycles).toBe(8);
    expect(audit.sigmaLtCycles).toBe(1.2);
    expect(audit.sigmaDSource).toBe('backtest');
    expect(audit.sigmaDObservationCount).toBeGreaterThanOrEqual(2);
  });
});
