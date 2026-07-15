import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { CycleRecord, CycleStatus, StageNumber, StageSnapshot } from './models';

/**
 * Kỹ thuật chung: chạy engine thật tới Chặng 5 (dữ liệu giả gapless mặc định), rồi cấy trực tiếp
 * một mảng `CycleRecord[]` tùy ý vào state của MỘT SKU (mutate in-place — `state.cycles` không bị
 * Object.freeze sâu, chỉ bản thân object state bị đóng băng nông) để dựng chính xác kịch bản có
 * khoảng đứt quãng theo đúng vị trí mong muốn, sau đó chạy tiếp Chặng 6/7/8/11 trên state đã cấy.
 */
function makeCycle(index: number, locked: boolean, status: CycleStatus, baseDemand = 10): CycleRecord {
  return {
    cycleIndex: index, dateStart: `2020-01-${String((index % 28) + 1).padStart(2, '0')}`, dateEnd: `2020-01-${String((index % 28) + 1).padStart(2, '0')}`,
    days: 15, baseDemand: locked ? baseDemand : 0, locked, emptyCycle: !locked && status === 'BASELINE_UNRESOLVED',
    cleanDays: locked ? 15 : 0, stockoutLiftedDays: 0, promoNormalizedDays: 0, technicalFillDays: 0,
    unresolvedDays: locked ? 0 : 15, sourceRecordDays: 15, fallbackDays: 0, tier2Filled: false,
    status, seasonRound: Math.floor((index - 1) / 24) + 1, seasonPosition: ((index - 1) % 24) + 1,
  };
}

function runTo5(): { engine: SimulationEngine; snapshot: StageSnapshot } {
  const engine = new SimulationEngine();
  let snapshot: StageSnapshot | null = null;
  for (let stage = 1; stage <= 5; stage++) snapshot = engine.run(stage as StageNumber, snapshot, DEFAULT_POLICY);
  return { engine, snapshot: snapshot! };
}

function plantCycles(snapshot: StageSnapshot, skuId: string, cycles: CycleRecord[]): void {
  (snapshot.states[skuId].cycles as CycleRecord[]).splice(0, snapshot.states[skuId].cycles.length, ...cycles);
}

describe('RULE-06-003/RULE-05-006 — cửa sổ ABC là 24 vị trí gần nhất theo lịch, chỉ năm hóa đoạn CK khóa LIÊN TIẾP (GT-32/GT-34)', () => {
  it('GT-32: CK14, CK15, CK25 khóa nhưng CK16-24 unresolved → không nối thành chuỗi, ABC bị chặn', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 13; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(14, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(15, true, 'LOCKED_OBSERVED'));
    for (let i = 16; i <= 24; i++) cycles.push(makeCycle(i, false, 'BASELINE_UNRESOLVED'));
    cycles.push(makeCycle(25, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const state = s6.states[skuId];

    // Cửa sổ 24 vị trí gần nhất = CK2..CK25; đoạn khóa LIÊN TIẾP cuối cùng chỉ có CK25 (CK24 unresolved
    // chặn ngay trước đó) → 1 CK, dưới ngưỡng tối thiểu 6 → ABC_INPUT_BLOCKED (GT-32 "không nối thành chuỗi").
    expect(state.classification.abc).toBe('N/A');
    expect(state.classification.abcStatus).toBe('not-rated');
    expect(state.classification.lockedCycles).toBe(1);
    expect(s6.exceptions.find(item => item.skuId === skuId && item.code === 'ABC_INPUT_BLOCKED')).toBeDefined();
  });

  it('Chỉ 5 CK khóa trong cửa sổ 24 vị trí (dưới ngưỡng tối thiểu 6) → ABC=N/A, abcStatus=not-rated, tạo task ABC_INPUT_BLOCKED', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles = Array.from({ length: 24 }, (_, i) => makeCycle(i + 1, i < 5, i < 5 ? 'LOCKED_OBSERVED' : 'BASELINE_UNRESOLVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const state = s6.states[skuId];

    expect(state.classification.abc).toBe('N/A');
    expect(state.classification.abcStatus).toBe('not-rated');
    const task = s6.exceptions.find(item => item.skuId === skuId && item.code === 'ABC_INPUT_BLOCKED');
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-06-003');
  });

  it('6 chu kỳ khóa liên tiếp (lịch sử ngắn hơn cửa sổ) → được năm hóa ANNUALIZED_WITH_GAPS (đối chứng: không phải mọi ABC=N/A đều do thiếu dữ liệu)', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles = Array.from({ length: 6 }, (_, i) => makeCycle(i + 1, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const state = s6.states[skuId];

    expect(state.classification.abc).not.toBe('N/A');
    expect(state.classification.abcStatus).toBe('annualized');
    expect(s6.exceptions.find(item => item.skuId === skuId && item.code === 'ABC_INPUT_BLOCKED')).toBeUndefined();
  });

  it('24/24 CK đều khóa → FULL_COVERAGE', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles = Array.from({ length: 24 }, (_, i) => makeCycle(i + 1, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const state = s6.states[skuId];

    expect(state.classification.abcStatus).toBe('full');
    expect(state.classification.lockedCycles).toBe(24);
    expect(state.classification.annualizationFactor).toBe(1);
  });

  it('GT-34: 6 CK khóa liên tiếp cuối cửa sổ (đoạn 1-6 khóa rải rác trước gap không được tính) → periodQuantity chỉ cộng đúng đoạn liên tiếp', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 6; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED', 10));
    for (let i = 7; i <= 18; i++) cycles.push(makeCycle(i, false, 'BASELINE_UNRESOLVED'));
    for (let i = 19; i <= 24; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED', 20));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const state = s6.states[skuId];

    // Đoạn khóa liên tiếp cuối cửa sổ = CK19-24 (6 CK, baseDemand=20 mỗi CK). CK1-6 khóa nhưng nằm
    // TRƯỚC khoảng gap 7-18 nên KHÔNG được cộng chung — đúng GT-34 "nếu 6 CK nằm rải rác thì không được dùng".
    expect(state.classification.lockedCycles).toBe(6);
    expect(state.classification.periodQuantity).toBeCloseTo(6 * 20, 5);
    expect(state.classification.abcStatus).toBe('annualized');
  });
});

describe('RULE-07-003 — cửa sổ XYZ là đúng 24 vị trí gần nhất theo lịch, có gap trong cửa sổ → CLASSIFICATION_BLOCKED', () => {
  it('GT-23/32: một chu kỳ BASELINE_UNRESOLVED nằm trong cửa sổ 24 vị trí gần nhất → xyz=null, classificationBlockReason=BASELINE_UNRESOLVED, không phải D', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 13; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(14, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(15, true, 'LOCKED_OBSERVED'));
    for (let i = 16; i <= 24; i++) cycles.push(makeCycle(i, false, 'BASELINE_UNRESOLVED'));
    cycles.push(makeCycle(25, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const s7 = engine.run(7, s6, DEFAULT_POLICY);
    const state = s7.states[skuId];

    expect(state.classification.xyz).toBeNull();
    expect(state.classification.classificationStatus).toBe('CLASSIFICATION_BLOCKED');
    expect(state.classification.classificationBlockReason).toBe('BASELINE_UNRESOLVED');
    expect(state.classification.dSubtype).toBeNull();
    expect(state.classification.classificationReason).toContain('CLASSIFICATION_BLOCKED_BASELINE_UNRESOLVED');
    const task = s7.exceptions.find(item => item.skuId === skuId && item.code === 'CLASSIFICATION_BLOCKED');
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-07-003');
  });

  it('GT-33: lịch sử dài (75 CK) chỉ 22 CK khóa rải rác xen kẽ → CLASSIFICATION_BLOCKED, không phải D, và Chặng 11 không tự phát hành dự báo', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = Array.from({ length: 75 }, (_, i) => {
      const index = i + 1;
      const locked = index % 3 === 0 && index !== 75; // rải rác, và CK cuối cùng CỐ Ý unresolved
      return makeCycle(index, locked, locked ? 'LOCKED_OBSERVED' : 'BASELINE_UNRESOLVED');
    });
    plantCycles(snapshot, skuId, cycles);

    let s: StageSnapshot = engine.run(6, snapshot, DEFAULT_POLICY);
    for (let stage = 7; stage <= 11; stage++) s = engine.run(stage as StageNumber, s, DEFAULT_POLICY);
    const state = s.states[skuId];

    expect(state.classification.xyz).toBeNull();
    expect(state.classification.classificationStatus).toBe('CLASSIFICATION_BLOCKED');
    expect(state.classification.dSubtype).toBeNull();
    expect(state.forecast).not.toBeNull();
    expect(state.forecast!.lockStatus).toBe('exception');
    expect(state.forecast!.model).toBe('PurchasePlan');
    expect(state.forecast!.reason).toContain('FORECAST_INPUT_BLOCKED');
  });

  it('GT-35: SKU mới 4 chu kỳ hoạt động, extractIsTruncated=false, cả 4 đã khóa → vẫn D/D_SHORT_HISTORY (không lẫn với CLASSIFICATION_BLOCKED)', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    (snapshot.states[skuId].definition as { extractIsTruncated: boolean }).extractIsTruncated = false;
    const cycles = Array.from({ length: 4 }, (_, i) => makeCycle(i + 1, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const s7 = engine.run(7, s6, DEFAULT_POLICY);
    const state = s7.states[skuId];

    expect(state.classification.xyz).toBe('D');
    expect(state.classification.classificationStatus).toBe('CLASSIFIED');
    expect(state.classification.dSubtype).toBe('D_SHORT_HISTORY');
  });

  it('GT-36: SKU-014 (mock catalog có sẵn — 6 chu kỳ khóa, baseDemand=0) → NO_POSITIVE_DEMAND_REVIEW, KHÔNG phải D (hồi quy: trước bản sửa sẽ là D)', () => {
    const engine = new SimulationEngine();
    let snapshot: StageSnapshot | null = null;
    for (let stage = 1; stage <= 7; stage++) snapshot = engine.run(stage as StageNumber, snapshot, DEFAULT_POLICY);
    const state = snapshot!.states['SKU-014'];

    expect(state.classification.xyz).toBeNull();
    expect(state.classification.classificationStatus).toBe('NO_POSITIVE_DEMAND_REVIEW');
    expect(state.classification.dSubtype).toBeNull();
    expect(state.classification.n).toBeGreaterThanOrEqual(6);
    expect(state.classification.m).toBe(0);
    expect(state.classification.adi).toBeNull();
  });
});

describe('RULE-11-001 — chuỗi học Chặng 11 không bỏ khoảng trống rồi nén chuỗi', () => {
  it('có một khoảng đứt quãng xa hơn 24 chu kỳ (ngoài cửa sổ XYZ) → phân loại vẫn CLASSIFIED, nhưng Chặng 11 vẫn ghi nhận lịch sử cũ hơn bị loại (FORECAST_INPUT_BLOCKED), không im lặng nén chuỗi', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 10; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(11, false, 'BASELINE_UNRESOLVED')); // gap CÁCH cuối 29 chu kỳ — ngoài cửa sổ 24 của Chặng 7
    for (let i = 12; i <= 40; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    let s: StageSnapshot = engine.run(6, snapshot, DEFAULT_POLICY);
    for (let stage = 7; stage <= 11; stage++) s = engine.run(stage as StageNumber, s, DEFAULT_POLICY);
    const state = s.states[skuId];

    // Cửa sổ 24 gần nhất (CK17-40) hoàn toàn sạch → phân loại KHÔNG bị chặn.
    expect(state.classification.classificationStatus).toBe('CLASSIFIED');
    expect(state.classification.xyz).not.toBeNull();
    // Nhưng Chặng 11 vẫn phải biết CK1-10 KHÔNG được dùng chung với CK12-40 (khác 39 CK bị nén sai).
    const task = s.exceptions.find(item => item.skuId === skuId && item.code === 'FORECAST_INPUT_BLOCKED');
    expect(task).toBeDefined();
    expect(task!.ruleId).toBe('RULE-11-001');
    expect(task!.evidence).toContain('29/40');
  });

  it('GT-37 (dạng chặt): gap nằm ngay trong cửa sổ gần nhất → Chặng 7 CLASSIFICATION_BLOCKED và Chặng 11 chặn cứng luôn, không tự chuyển D, không nén chuỗi', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 19; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    cycles.push(makeCycle(20, false, 'BASELINE_UNRESOLVED')); // gap "ở giữa" cửa sổ gần nhất
    for (let i = 21; i <= 30; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    let s: StageSnapshot = engine.run(6, snapshot, DEFAULT_POLICY);
    for (let stage = 7; stage <= 11; stage++) s = engine.run(stage as StageNumber, s, DEFAULT_POLICY);
    const state = s.states[skuId];

    expect(state.classification.classificationStatus).toBe('CLASSIFICATION_BLOCKED');
    expect(state.classification.dSubtype).toBeNull();
    expect(state.forecast!.lockStatus).toBe('exception');
    expect(state.forecast!.model).toBe('PurchasePlan');
    expect(state.forecast!.reason).toContain('FORECAST_INPUT_BLOCKED');
    expect(state.forecast!.baseForecast).toHaveLength(0);
  });
});

describe('RULE-07-002 §2.2 LỆNH CODEX — seriesQualityRatio chia cho ĐỘ DÀI CỬA SỔ, không chia cho toàn bộ lịch sử', () => {
  it('lịch sử 75 CK nhưng cửa sổ 24 CK gần nhất chỉ có 20 CK khóa → seriesQualityRatio ≈ 20/24, không phải 20/75', () => {
    const { engine, snapshot } = runTo5();
    const skuId = Object.keys(snapshot.states)[0];
    const cycles: CycleRecord[] = [];
    for (let i = 1; i <= 51; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    for (let i = 52; i <= 55; i++) cycles.push(makeCycle(i, false, 'BASELINE_UNRESOLVED'));
    for (let i = 56; i <= 75; i++) cycles.push(makeCycle(i, true, 'LOCKED_OBSERVED'));
    plantCycles(snapshot, skuId, cycles);

    const s6 = engine.run(6, snapshot, DEFAULT_POLICY);
    const s7 = engine.run(7, s6, DEFAULT_POLICY);
    const state = s7.states[skuId];

    expect(state.classification.classificationStatus).toBe('CLASSIFICATION_BLOCKED');
    expect(state.classification.seriesQualityRatio).toBeCloseTo(20 / 24, 5);
    expect(state.classification.seriesQualityRatio).not.toBeCloseTo(20 / 75, 2);
  });
});
