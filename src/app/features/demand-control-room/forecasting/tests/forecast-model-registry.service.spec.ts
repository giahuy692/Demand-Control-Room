import { describe, expect, it } from 'vitest';
import { ForecastEligibilityContext, ForecastInput } from '../forecast-model-strategy.interface';
import { DEFAULT_FORECAST_MODEL_REGISTRY, ForecastModelRegistry } from '../forecast-model-registry.service';
import { SesStrategy } from '../strategies/ses.strategy';

const context: ForecastEligibilityContext = {
  xyz: 'Y',
  seasonality: 'confirmed',
  trend: 'up',
  historyLength: 48,
  trainSize: 39,
  testSize: 9,
  seasonalPeriod: 4,
  seasonalCorrelation: 0.85,
};

const input: ForecastInput = {
  values: Array.from({ length: 48 }, (_, index) => 80 + index + (index % 4) * 10),
  trainSize: 39,
  testSize: 9,
  seasonalPeriod: 4,
  seasonalCorrelation: 0.85,
};

describe('ForecastModelRegistry', () => {
  it('đăng ký động đủ 5 strategy theo handoff và chặn model trùng', () => {
    expect(DEFAULT_FORECAST_MODEL_REGISTRY.registeredModels()).toEqual([
      'SES', 'Holt', 'Holt-Winters', 'Croston', 'SeasonalNaive',
    ]);
    expect(() => new ForecastModelRegistry([new SesStrategy(), new SesStrategy()]))
      .toThrow('Forecast strategy model must be unique.');
  });

  it('mọi candidate dùng đúng cùng TRAIN/TEST window do selector truyền vào', () => {
    for (const model of ['SES', 'Holt', 'Holt-Winters', 'SeasonalNaive'] as const) {
      const learning = DEFAULT_FORECAST_MODEL_REGISTRY.fit(model, context, input)?.learning;
      expect(learning?.trainSize).toBe(input.trainSize);
      expect(learning?.testSize).toBe(input.testSize);
      expect(learning?.rows).toHaveLength(input.values.length);
    }
  });

  it('không chạy strategy ngoài eligibility của demand class', () => {
    expect(DEFAULT_FORECAST_MODEL_REGISTRY.fit('Croston', context, input)).toBeNull();
  });
});
