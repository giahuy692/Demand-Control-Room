import { buildLearning, fitHoltWinters } from '../../domain/forecast-models';
import { ForecastModelStrategy } from '../forecast-model-strategy.interface';

export class HoltWintersStrategy implements ForecastModelStrategy {
  readonly model = 'Holt-Winters' as const;

  supports(context: Parameters<ForecastModelStrategy['supports']>[0]): boolean {
    return context.xyz === 'Y' && context.seasonality === 'confirmed';
  }

  fitAndForecast(input: Parameters<ForecastModelStrategy['fitAndForecast']>[0]) {
    const fitted = fitHoltWinters(input.values, input.trainSize);
    return fitted ? {
      learning: buildLearning(this.model, fitted.params, fitted.run, input.trainSize, input.testSize,
        'm = 24; α/β/γ chọn bằng Grid Search trên TRAIN (β ≤ α, γ ≤ 1−α).'),
    } : null;
  }
}
