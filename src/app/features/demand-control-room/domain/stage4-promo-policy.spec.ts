import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { testEngine } from '../data-access/testing/file-dataset.testing';

function runToStage4(policy = DEFAULT_POLICY) {
  const engine = testEngine();
  let snapshot = engine.run(1, null, policy);
  snapshot = engine.run(2, snapshot, policy);
  snapshot = engine.run(3, snapshot, policy);
  snapshot = engine.run(4, snapshot, policy);
  return snapshot;
}

describe('runStage4 — RULE-04-001 UNKNOWN_REVIEW chặn chuẩn hóa CTKM chưa phân loại', () => {
  it('mã CTKM MEMBER nằm trong danh sách chờ duyệt → không được chuẩn hóa (baseSource giữ promo-defer), tạo task PROMO_TYPE_UNKNOWN', () => {
    const policy = { ...DEFAULT_POLICY, unknownReviewPromotionCodes: ['999'] };
    const snapshot = runToStage4(policy);
    const state = snapshot.states['SKU-001'];
    const promoDays = state.daily.filter(row => row.promoCode === '999');

    expect(promoDays.length).toBeGreaterThan(0);
    expect(promoDays.every(row => row.baseDemandSource === 'PROMOTION_UNRESOLVED')).toBe(true);
    expect(Number(snapshot.summary['Ngày chờ phân loại CTKM'])).toBeGreaterThan(0);
    const tasks = snapshot.exceptions.filter(task => task.skuId === 'SKU-001');
    expect(tasks.some(task => task.ruleId === 'RULE-04-001' && task.code === 'PROMO_TYPE_UNKNOWN')).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-04-001]'))).toBe(true);
  });

  it('không cấu hình danh sách chờ duyệt (mặc định) → hành vi CAMPAIGN như cũ, CTKM vẫn được chuẩn hóa bình thường', () => {
    const snapshot = runToStage4(DEFAULT_POLICY);
    const state = snapshot.states['SKU-001'];
    const promoDays = state.daily.filter(row => row.promoCode === '999');

    expect(promoDays.some(row => row.baseDemandSource === 'PROMOTION_BASELINE' || row.baseDemandSource === 'PROMOTION_UNRESOLVED')).toBe(true);
    expect(Number(snapshot.summary['Ngày chờ phân loại CTKM'])).toBe(0);
  });
});
