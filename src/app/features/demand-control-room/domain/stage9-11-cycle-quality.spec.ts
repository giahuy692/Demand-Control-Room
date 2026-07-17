import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageNumber, StageSnapshot } from './models';
import { testEngine } from '../data-access/testing/file-dataset.testing';

function runTo(stage: StageNumber): StageSnapshot {
  const engine = testEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as StageNumber, snapshot, DEFAULT_POLICY);
  return snapshot!;
}

function countByStatus(snapshot: StageSnapshot, status: string): number {
  return Object.values(snapshot.states).reduce((sum, state) => sum + state.cycles.filter(cycle => cycle.status === status).length, 0);
}

describe('Chặng 10-12 — log breakdown chất lượng chu kỳ khóa (LOCKED_OBSERVED/LOCKED_ADJUSTED/LOCKED_FALLBACK)', () => {
  for (const stage of [10, 11, 12] as const) {
    it(`Chặng ${stage}: summary tách đúng 3 loại chu kỳ khóa, khớp với số đếm trực tiếp trên state.cycles`, () => {
      const snapshot = runTo(stage);

      const observed = Number(snapshot.summary['CK khóa - quan sát thuần (LOCKED_OBSERVED)']);
      const adjusted = Number(snapshot.summary['CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)']);
      const fallback = Number(snapshot.summary['CK khóa - fallback mùa vụ (LOCKED_FALLBACK)']);

      expect(observed).toBe(countByStatus(snapshot, 'LOCKED_OBSERVED'));
      expect(adjusted).toBe(countByStatus(snapshot, 'LOCKED_ADJUSTED'));
      expect(fallback).toBe(countByStatus(snapshot, 'LOCKED_FALLBACK'));
      // Log chỉ tổng hợp, không được ảnh hưởng tới bất kỳ nhãn nghiệp vụ nào đã có sẵn.
      expect(snapshot.audit.some(line => line.includes('quan sát thuần') && line.includes('đã điều chỉnh'))).toBe(true);
    });
  }
});

