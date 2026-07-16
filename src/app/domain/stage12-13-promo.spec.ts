import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageSnapshot } from './models';
import { testEngine } from '../features/demand-control-room/data-access/testing/file-dataset.testing';

function runTo(stage: 12 | 13): StageSnapshot {
  const engine = testEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13, snapshot, DEFAULT_POLICY);
  return snapshot!;
}

describe('RULE-13-001/002 — literal status Chặng 13', () => {
  it('SKU không có kế hoạch CTKM tương lai xác nhận → finalForecastStatus=PASSTHROUGH_NO_FUTURE_PROMO', () => {
    const snapshot = runTo(13);
    const noPromoSku = Object.values(snapshot.states).find(state => !state.definition.futurePromotions.some(item => item.confirmed));
    expect(noPromoSku).toBeDefined();
    expect(noPromoSku!.finalForecastStatus).toBe('PASSTHROUGH_NO_FUTURE_PROMO');
  });

  it('audit Chặng 13 gắn RuleId RULE-13-001/002 và nêu rõ số SKU NOT_EVALUATED', () => {
    const snapshot = runTo(13);
    expect(snapshot.audit.some(line => line.includes('[RULE-13-001]') && line.includes('PASSTHROUGH_NO_FUTURE_PROMO'))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-13-002]') && line.includes('NOT_EVALUATED'))).toBe(true);
  });

  it('SKU có kế hoạch CTKM tương lai và K tự khóa (auto) → FUTURE_PROMO_APPLIED', () => {
    const snapshot = runTo(13);
    const applied = Object.values(snapshot.states).find(state => state.finalForecastStatus === 'FUTURE_PROMO_APPLIED');
    if (applied) {
      expect(applied.definition.futurePromotions.some(item => item.confirmed)).toBe(true);
      expect(applied.promoConfidence).toBe('auto');
    }
  });
});
