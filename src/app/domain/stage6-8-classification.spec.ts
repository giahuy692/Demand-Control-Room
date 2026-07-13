import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageSnapshot } from './models';

function runTo(stage: 6 | 7 | 8): StageSnapshot {
  const engine = new SimulationEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, snapshot, DEFAULT_POLICY);
  return snapshot!;
}

describe('RULE-06-001/002 — Chặng 6 ABC official/approval', () => {
  it('dữ liệu mock (SELECTED_SKU_SIMULATION mặc định) → không SKU nào có ABC chính thức', () => {
    const snapshot = runTo(6);
    const officials = Object.values(snapshot.states).filter(state => state.classification.abcOfficial);

    expect(officials).toHaveLength(0);
    expect(Number(snapshot.summary['SKU ABC chính thức'])).toBe(0);
    expect(snapshot.audit.some(line => line.includes('[RULE-06-001]'))).toBe(true);
  });

  it('mọi SKU có approvalStatus=PROPOSED, không bao giờ tự chuyển EFFECTIVE', () => {
    const snapshot = runTo(6);
    expect(Object.values(snapshot.states).every(state => state.classification.approvalStatus === 'PROPOSED')).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-06-002]'))).toBe(true);
  });

  it('portfolioMode=FULL_PORTFOLIO → ABC được coi là chính thức', () => {
    const engine = new SimulationEngine();
    let snapshot: StageSnapshot | null = engine.run(1, null, DEFAULT_POLICY);
    for (const state of Object.values(snapshot.states)) (state.definition as { portfolioMode: string }).portfolioMode = 'FULL_PORTFOLIO';
    for (let stage = 2; stage <= 6; stage++) snapshot = engine.run(stage as 2 | 3 | 4 | 5 | 6, snapshot, DEFAULT_POLICY);
    const officials = Object.values(snapshot!.states).filter(state => state.classification.abcOfficial);

    expect(officials.length).toBeGreaterThan(0);
  });
});

describe('RULE-07-001/002 — Chặng 7 phân loại D theo lý do', () => {
  it('SKU-011 (0 chu kỳ, mới hoàn toàn) → D_NEW', () => {
    const snapshot = runTo(7);
    const state = snapshot.states['SKU-011'];

    expect(state.classification.xyz).toBe('D');
    expect(state.classification.dSubtype).toBe('D_NEW');
    expect(state.classification.classificationReason.length).toBeGreaterThan(0);
  });

  it('SKU-013 (5 chu kỳ, chưa đủ 6) → D_EXTRACT_TRUNCATED vì catalog demo cũng gắn extractIsTruncated=true (RULE-01-004, không tự nhận FULL_PORTFOLIO ngay cả với dữ liệu giả)', () => {
    const snapshot = runTo(7);
    const state = snapshot.states['SKU-013'];

    expect(state.classification.xyz).toBe('D');
    expect(state.classification.dSubtype).toBe('D_EXTRACT_TRUNCATED');
  });

  it('D_SHORT_HISTORY chỉ đạt tới khi extractIsTruncated=false (biết chắc không bị cắt)', () => {
    const engine = new SimulationEngine();
    let snapshot: StageSnapshot | null = engine.run(1, null, DEFAULT_POLICY);
    (snapshot.states['SKU-013'].definition as { extractIsTruncated: boolean }).extractIsTruncated = false;
    for (let stage = 2; stage <= 7; stage++) snapshot = engine.run(stage as 2 | 3 | 4 | 5 | 6 | 7, snapshot, DEFAULT_POLICY);

    expect(snapshot!.states['SKU-013'].classification.dSubtype).toBe('D_SHORT_HISTORY');
  });

  it('SKU không thuộc nhóm D thì dSubtype=null và vẫn có classificationReason', () => {
    const snapshot = runTo(7);
    const nonD = Object.values(snapshot.states).find(state => state.classification.xyz !== 'D')!;

    expect(nonD.classification.dSubtype).toBeNull();
    expect(nonD.classification.classificationReason.length).toBeGreaterThan(0);
    expect(nonD.classification.seriesQualityRatio).not.toBeNull();
  });

  it('audit Chặng 7 gắn RuleId RULE-07-001/002', () => {
    const snapshot = runTo(7);
    expect(snapshot.audit.some(line => line.includes('[RULE-07-001]'))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-07-002]'))).toBe(true);
  });
});

describe('RULE-08-001/002 — Chặng 8 chính sách', () => {
  it('SKU nhóm D/N-A → serviceLevel=null (không dùng 0), tạo task POLICY_UNRESOLVED', () => {
    const snapshot = runTo(8);
    const dSku = Object.values(snapshot.states).find(state => state.classification.xyz === 'D')!;

    expect(dSku.serviceLevel).toBeNull();
    const task = snapshot.exceptions.find(item => item.skuId === dSku.definition.id && item.code === 'POLICY_UNRESOLVED');
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-08-002');
  });

  it('audit Chặng 8 ghi rõ phiên chính sách (RULE-08-001) và giới hạn không hồi tố', () => {
    const snapshot = runTo(8);
    expect(snapshot.audit.some(line => line.includes('[RULE-08-001]') && line.includes(DEFAULT_POLICY.version))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-08-002]'))).toBe(true);
  });
});
