import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';
import { StageNumber, StageSnapshot } from './models';
import { buildStageTrace } from './stage-trace';

describe('stage-trace sanity', () => {
  const engine = new SimulationEngine();
  const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
  let previous: StageSnapshot | null = null;
  for (let stage = 1; stage <= 19; stage++) {
    previous = engine.run(stage as StageNumber, previous, DEFAULT_POLICY);
    snapshots[stage as StageNumber] = previous;
  }

  it('tạo trace không lỗi cho mọi chặng × mọi SKU × mọi điểm méo', { timeout: 120_000 }, () => {
    for (let stage = 1 as StageNumber; stage <= 19; stage++) {
      const snapshot = snapshots[stage as StageNumber]!;
      for (const state of Object.values(snapshot.states)) {
        const general = buildStageTrace(stage as StageNumber, state, DEFAULT_POLICY, null);
        expect(general.heading.length).toBeGreaterThan(0);
        expect(general.steps.length).toBeGreaterThan(0);
        for (const point of general.points ?? []) {
          const focused = buildStageTrace(stage as StageNumber, state, DEFAULT_POLICY, point.date);
          expect(focused.steps.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('trace chặng 3 thế số đúng bằng kết quả engine đã khóa', () => {
    const snapshot = snapshots[3]!;
    for (const state of Object.values(snapshot.states)) {
      const lifted = state.daily.find(record => record.baseSource === 'stockout-lifted');
      if (!lifted) continue;
      const trace = buildStageTrace(3, state, DEFAULT_POLICY, lifted.date);
      const final = trace.steps.at(-1)!;
      expect(final.substitution).toContain(`max(${lifted.sales.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}`);
      expect(final.tone).toBe('good');
    }
  });

  it('trace chặng 4 dùng median, không dùng max', () => {
    const snapshot = snapshots[4]!;
    for (const state of Object.values(snapshot.states)) {
      const normalized = state.daily.find(record => record.baseSource === 'promo-normalized');
      if (!normalized) continue;
      const trace = buildStageTrace(4, state, DEFAULT_POLICY, normalized.date);
      const final = trace.steps.at(-1)!;
      expect(final.substitution).toContain('Median');
      expect(final.substitution).not.toContain('max(');
    }
  });

  it('trace Chặng 6 đủ 8 bước ABC và giải thích a_N', () => {
    for (const state of Object.values(snapshots[6]!.states)) {
      const trace = buildStageTrace(6, state, DEFAULT_POLICY, null);
      expect(trace.steps).toHaveLength(8);
      expect(trace.context).toContain('a_N');
      expect(trace.steps[2].detail).toContain('Q_năm');
      expect(trace.steps[3].title).toContain('tỷ trọng giá trị');
    }
  });

  it('trace Chặng 7 đủ các mục 4.4.1–4.4.9 và khớp μ/σ/CV² engine', () => {
    for (const state of Object.values(snapshots[7]!.states)) {
      const trace = buildStageTrace(7, state, DEFAULT_POLICY, null);
      expect(trace.steps).toHaveLength(9);
      expect(trace.steps.map(step => step.title)).toEqual(expect.arrayContaining([
        expect.stringContaining('4.4.1'), expect.stringContaining('4.4.9'),
      ]));
      if (state.classification.m) {
        expect(trace.steps[5].substitution).toContain('μ');
        expect(trace.steps[6].substitution).toContain('σ');
        expect(trace.steps[7].substitution).toContain('CV²');
      }
    }
  });

  it('process-panel giữ đủ số bước chuẩn của tài liệu cho các chặng có quy trình cố định', () => {
    const firstState = (stage: StageNumber) => Object.values(snapshots[stage]!.states)[0];
    const expected: Partial<Record<StageNumber, number>> = {
      1: 10, 2: 4, 3: 8, 4: 8, 5: 8, 6: 8, 7: 9, 8: 8, 12: 7, 13: 6, 14: 5, 15: 8,
      16: 12, 17: 10, 18: 9, 19: 11,
    };
    for (const [stageText, count] of Object.entries(expected)) {
      const stage = Number(stageText) as StageNumber;
      expect(buildStageTrace(stage, firstState(stage), DEFAULT_POLICY, null).steps, `Chặng ${stage}`).toHaveLength(count);
    }

    const stage9State = Object.values(snapshots[9]!.states).find(state => state.classification.xyz === 'Y' && state.cycles.filter(cycle => cycle.locked).length >= 48)!;
    expect(buildStageTrace(9, stage9State, DEFAULT_POLICY, null).steps).toHaveLength(8);
    const stage10State = Object.values(snapshots[10]!.states).find(state => state.classification.xyz === 'Y' && state.seasonality !== 'confirmed' && state.cycles.filter(cycle => cycle.locked).length >= 12)!;
    expect(buildStageTrace(10, stage10State, DEFAULT_POLICY, null).steps).toHaveLength(8);
    const stage11State = Object.values(snapshots[11]!.states).find(state => state.classification.xyz !== 'D')!;
    expect(buildStageTrace(11, stage11State, DEFAULT_POLICY, null).steps).toHaveLength(9);
  });

  it('trace chặng 15 khớp safety stock engine', () => {
    const snapshot = snapshots[15]!;
    for (const state of Object.values(snapshot.states)) {
      const trace = buildStageTrace(15, state, DEFAULT_POLICY, null);
      const final = trace.steps.at(-1)!;
      if (state.safetyStock === null) {
        expect(final.tone).toBe('warn');
      } else {
        expect(final.substitution).toContain(`= ${state.safetyStock.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}`);
      }
    }
  });
});
