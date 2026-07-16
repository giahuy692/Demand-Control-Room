import { renderToString } from 'katex';
import { describe, expect, it } from 'vitest';
import { getStageFormulas } from './formula-registry';
import { DEFAULT_POLICY } from './policy';
import { ForecastResult, SkuPipelineState, StageNumber } from './models';

const MODELS: ForecastResult['model'][] = ['SES', 'Holt', 'Holt-Winters', 'SeasonalNaive', 'Croston', 'PulseRhythm', 'PurchasePlan'];

describe('Formula registry', () => {
  it('mọi công thức Chặng 1–19 render được bằng KaTeX và có nguồn tài liệu', () => {
    for (let number = 1; number <= 19; number++) {
      const formulas = getStageFormulas(number as StageNumber, null, DEFAULT_POLICY);
      expect(formulas.length).toBeGreaterThan(0);
      for (const formula of formulas) {
        expect(formula.source).toMatch(/^C\d+/);
        expect(() => renderToString(formula.expression, { throwOnError: true })).not.toThrow();
      }
    }
  });

  it.each(MODELS)('công thức Chặng 11 nhánh %s render hợp lệ', model => {
    const state = { forecast: { model } } as unknown as SkuPipelineState;
    const formulas = getStageFormulas(11, state, DEFAULT_POLICY);
    expect(formulas.length).toBeGreaterThanOrEqual(2);
    formulas.forEach(formula => expect(() => renderToString(formula.expression, { throwOnError: true })).not.toThrow());
  });
});
