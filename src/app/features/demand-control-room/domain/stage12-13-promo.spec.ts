import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { StageSnapshot } from './models';
import { testEngine } from '../data-access/testing/file-dataset.testing';

function runTo(stage: 13 | 14): StageSnapshot {
  const engine = testEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13, snapshot, DEFAULT_POLICY);
  return snapshot!;
}

describe('RULE-14-001/002 — literal status Chặng 14', () => {
  it('SKU không có kế hoạch CTKM tương lai xác nhận → finalForecastStatus=PASSTHROUGH_NO_FUTURE_PROMO', () => {
    const snapshot = runTo(14);
    const noPromoSku = Object.values(snapshot.states).find(state => !state.definition.futurePromotions.some(item => item.confirmed));
    expect(noPromoSku).toBeDefined();
    expect(noPromoSku!.finalForecastStatus).toBe('PASSTHROUGH_NO_FUTURE_PROMO');
  });

  it('audit Chặng 14 gắn RuleId RULE-14-001/002 và nêu rõ số SKU NOT_EVALUATED', () => {
    const snapshot = runTo(14);
    expect(snapshot.audit.some(line => line.includes('[RULE-14-001]') && line.includes('PASSTHROUGH_NO_FUTURE_PROMO'))).toBe(true);
    expect(snapshot.audit.some(line => line.includes('[RULE-14-002]') && line.includes('NOT_EVALUATED'))).toBe(true);
  });

  it('SKU có kế hoạch CTKM tương lai và K tự khóa (auto) → FUTURE_PROMO_APPLIED', () => {
    const snapshot = runTo(14);
    const applied = Object.values(snapshot.states).find(state => state.finalForecastStatus === 'FUTURE_PROMO_APPLIED');
    if (applied) {
      expect(applied.definition.futurePromotions.some(item => item.confirmed)).toBe(true);
      expect(applied.promoConfidence).toBe('auto');
    }
  });
});

