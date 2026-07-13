import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';

function runToStage4(policy = DEFAULT_POLICY) {
  const engine = new SimulationEngine();
  let snapshot = engine.run(1, null, policy);
  snapshot = engine.run(2, snapshot, policy);
  snapshot = engine.run(3, snapshot, policy);
  snapshot = engine.run(4, snapshot, policy);
  return snapshot;
}

describe('runStage4 — RULE-04-001 UNKNOWN_REVIEW chặn chuẩn hóa CTKM chưa phân loại', () => {
  it('mã CTKM MEMBER nằm trong danh sách chờ duyệt → không được chuẩn hóa (baseSource giữ promo-defer), tạo task PROMO_TYPE_UNKNOWN', () => {
    const policy = { ...DEFAULT_POLICY, unknownReviewPromotionCodes: ['MEMBER'] };
    const snapshot = runToStage4(policy);
    const state = snapshot.states['SKU-001'];
    const promoDays = state.daily.filter(row => row.promoCode === 'MEMBER');

    expect(promoDays.length).toBeGreaterThan(0);
    expect(promoDays.every(row => row.baseSource === 'promo-defer')).toBe(true);
    expect(Number(snapshot.summary['Ngày chờ phân loại CTKM'])).toBeGreaterThan(0);
    const tasks = snapshot.exceptions.filter(task => task.skuId === 'SKU-001');
    expect(tasks.some(task => task.ruleId === 'RULE-04-001' && task.code === 'PROMO_TYPE_UNKNOWN')).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-04-001]'))).toBe(true);
  });

  it('không cấu hình danh sách chờ duyệt (mặc định) → hành vi CAMPAIGN như cũ, CTKM vẫn được chuẩn hóa bình thường', () => {
    const snapshot = runToStage4(DEFAULT_POLICY);
    const state = snapshot.states['SKU-001'];
    const promoDays = state.daily.filter(row => row.promoCode === 'MEMBER');

    expect(promoDays.some(row => row.baseSource === 'promo-normalized' || row.baseSource === 'insufficient')).toBe(true);
    expect(Number(snapshot.summary['Ngày chờ phân loại CTKM'])).toBe(0);
  });
});
