import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageNumber, StageSnapshot } from './models';
import { buildSimulationReport } from './report-builder';

function runTo(stage: StageNumber, policy = DEFAULT_POLICY): StageSnapshot {
  const engine = new SimulationEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as StageNumber, snapshot, policy);
  return snapshot!;
}

describe('04 §14 / DEC-W05 — Chặng 14–19 mặc định SIMULATION_ONLY khi thiếu dữ liệu vận hành thật', () => {
  it('operationalDataStatus mặc định NOT_APPLICABLE (đúng DEC-W05)', () => {
    expect(DEFAULT_POLICY.operationalDataStatus).toBe('NOT_APPLICABLE');
  });

  for (const stage of [14, 15, 16, 17, 18, 19] as const) {
    it(`Chặng ${stage}: mặc định gắn nhãn SIMULATION_ONLY và không thay đổi bất kỳ số liệu nào`, () => {
      const simulationSnapshot = runTo(stage);
      expect(simulationSnapshot.summary['Trạng thái vận hành']).toBe('SIMULATION_ONLY');
      expect(simulationSnapshot.audit.some(line => line.includes('SIMULATION_ONLY'))).toBe(true);

      const operationalSnapshot = runTo(stage, { ...DEFAULT_POLICY, operationalDataStatus: 'CONFIRMED' });
      expect(operationalSnapshot.summary['Trạng thái vận hành']).toBe('OPERATIONAL');
      // Nhãn hóa không được đổi bất kỳ số liệu nghiệp vụ nào — so một vài số liệu đại diện.
      for (const key of Object.keys(simulationSnapshot.summary)) {
        if (key === 'Trạng thái vận hành') continue;
        expect(operationalSnapshot.summary[key]).toEqual(simulationSnapshot.summary[key]);
      }
    });
  }

  it('operationalDataStatus=CONFIRMED bỏ nhãn SIMULATION_ONLY khỏi audit', () => {
    const snapshot = runTo(17, { ...DEFAULT_POLICY, operationalDataStatus: 'CONFIRMED' });
    expect(snapshot.audit.some(line => line.includes('SIMULATION_ONLY'))).toBe(false);
  });

  for (const stage of [14, 15, 16, 17, 18, 19] as const) {
    it(`Chặng ${stage}: báo cáo mô phỏng (buildSimulationReport) hiển thị nhãn SIMULATION_ONLY cho toàn bộ SKU khi chưa CONFIRMED`, () => {
      const snapshot = runTo(stage);
      const engine = new SimulationEngine();
      const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
      let previous: StageSnapshot | null = null;
      for (let current = 1; current <= stage; current++) {
        previous = engine.run(current as StageNumber, previous, DEFAULT_POLICY);
        snapshots[current as StageNumber] = previous;
      }
      const report = buildSimulationReport(snapshots, stage, DEFAULT_POLICY.runDate, DEFAULT_POLICY.operationalDataStatus);
      const section = report.sections.find(item => item.stage === stage)!;
      const simOnlyIssue = section.issues.find(item => item.title.includes('SIMULATION_ONLY'));

      expect(simOnlyIssue).toBeDefined();
      expect(simOnlyIssue!.severity).toBe('info');
      expect(new Set(simOnlyIssue!.skuIds)).toEqual(new Set(Object.keys(snapshot.states)));
    });
  }

  it('operationalDataStatus=CONFIRMED: báo cáo mô phỏng KHÔNG hiển thị nhãn SIMULATION_ONLY', () => {
    const policy = { ...DEFAULT_POLICY, operationalDataStatus: 'CONFIRMED' as const };
    const engine = new SimulationEngine();
    const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
    let previous: StageSnapshot | null = null;
    for (let current = 1; current <= 17; current++) {
      previous = engine.run(current as StageNumber, previous, policy);
      snapshots[current as StageNumber] = previous;
    }
    const report = buildSimulationReport(snapshots, 17, policy.runDate, policy.operationalDataStatus);
    for (const section of report.sections) {
      expect(section.issues.some(item => item.title.includes('SIMULATION_ONLY'))).toBe(false);
    }
  });
});
