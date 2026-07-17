import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { BaseDemandSource, DailyRecord, StageNumber, StageSnapshot } from './models';
import { testEngine } from '../data-access/testing/file-dataset.testing';

/**
 * §5/§10 LỆNH CODEX (RULE-06-006) — ngoại lệ cấp CHU KỲ sau Chặng 6: một task GỘP theo CK, không lặp
 * theo từng ngày unresolved bên trong. Kỹ thuật: chạy engine thật tới Chặng 4, "cấy" 15 ngày của một CK cụ
 * thể thành baseDemand=null (BASELINE_UNRESOLVED giả lập), rồi chạy Chặng 6 để kiểm tra ngoại lệ phát sinh.
 */
function runTo4(): { engine: SimulationEngine; snapshot: StageSnapshot } {
  const engine = testEngine();
  let snapshot: StageSnapshot | null = null;
  for (let stage = 1; stage <= 4; stage++) snapshot = engine.run(stage as StageNumber, snapshot, DEFAULT_POLICY);
  return { engine, snapshot: snapshot! };
}

function plantUnresolvedCycle(snapshot: StageSnapshot, skuId: string, cycleIndex: number, cycleLength: number): void {
  const daily = snapshot.states[skuId].daily as DailyRecord[];
  const start = (cycleIndex - 1) * cycleLength;
  for (let index = start; index < start + cycleLength; index++) {
    daily[index] = { ...daily[index], baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP, isCleanObservedReference: false };
  }
}

describe('RULE-06-006 §5 LỆNH CODEX — ngoại lệ cấp chu kỳ sau Chặng 6', () => {
  it('#1 CK7 không có nền hợp lệ → chặn đúng CK7, đúng khoảng ngày và có resolutionOptions', () => {
    const { engine, snapshot } = runTo4();
    const skuId = 'SKU-001';
    plantUnresolvedCycle(snapshot, skuId, 7, DEFAULT_POLICY.cycleLength);

    const s5 = engine.run(5, snapshot, DEFAULT_POLICY);
    const s6 = engine.run(6, s5, DEFAULT_POLICY);
    const cycle7 = s6.states[skuId].cycles.find(c => c.cycleIndex === 7)!;
    expect(cycle7.locked).toBe(false);
    expect(cycle7.status).toBe('BLOCKED_NO_VALID_BASELINE');

    const task = s6.exceptions.find(item => item.skuId === skuId && item.code === 'CYCLE_EXCEPTION' && item.cycleIndexes?.includes(7));
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-06-006');
    expect(task!.cycleIndexes).toEqual([7]);
    expect(task!.affectedDateFrom).toBe(cycle7.dateStart);
    expect(task!.affectedDateTo).toBe(cycle7.dateEnd);
    expect(task!.simulationOnly).toBe(true);
    expect(task!.resolutionOptions!.length).toBeGreaterThan(0);
    expect(task!.resolutionOptions!.map(option => option.type)).toContain('REFERENCE_STORE');
    expect(task!.blockingStages).toContain(7);
    expect(task!.blockingStages).toContain(12);
  });

  it('#2 nhiều ngày lỗi trong CÙNG một CK chỉ tạo MỘT dòng ngoại lệ cấp CK, không lặp theo ngày', () => {
    const { engine, snapshot } = runTo4();
    const skuId = 'SKU-001';
    plantUnresolvedCycle(snapshot, skuId, 3, DEFAULT_POLICY.cycleLength); // toàn bộ 15 ngày của CK3 đều lỗi

    const s5 = engine.run(5, snapshot, DEFAULT_POLICY);
    const s6 = engine.run(6, s5, DEFAULT_POLICY);
    const tasksForCycle3 = s6.exceptions.filter(item => item.skuId === skuId && item.code === 'CYCLE_EXCEPTION' && item.cycleIndexes?.includes(3));

    expect(tasksForCycle3).toHaveLength(1);
  });

  it('#4 mọi resolutionOptions đều executableInSimulation=false và task simulationOnly=true — mô phỏng không tự áp dụng', () => {
    const { engine, snapshot } = runTo4();
    const skuId = 'SKU-001';
    plantUnresolvedCycle(snapshot, skuId, 5, DEFAULT_POLICY.cycleLength);

    const s5 = engine.run(5, snapshot, DEFAULT_POLICY);
    const s6 = engine.run(6, s5, DEFAULT_POLICY);
    const tasks = s6.exceptions.filter(item => item.code === 'CYCLE_EXCEPTION');
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.simulationOnly).toBe(true);
      for (const option of task.resolutionOptions ?? []) {
        expect(option.executableInSimulation).toBe(false);
      }
    }
  });
});

