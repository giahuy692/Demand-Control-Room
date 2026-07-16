import { buildLearning, fitHolt } from '../../domain/forecast-models';
import { ForecastModelStrategy } from '../forecast-model-strategy.interface';

export class HoltStrategy implements ForecastModelStrategy {
  readonly model = 'Holt' as const;

  supports(context: Parameters<ForecastModelStrategy['supports']>[0]): boolean {
    return (context.xyz === 'X' || context.xyz === 'Y') && context.historyLength >= 3;
  }

  fitAndForecast(input: Parameters<ForecastModelStrategy['fitAndForecast']>[0]) {
    const fitted = fitHolt(input.values, input.trainSize);
    return {
      learning: buildLearning(this.model, fitted.params, fitted.run, input.trainSize, input.testSize,
        `α = ${fitted.params['alpha']}, β = ${fitted.params['beta']} (β ≤ α) chọn bằng Grid Search trên TRAIN.`),
    };
  }
}
