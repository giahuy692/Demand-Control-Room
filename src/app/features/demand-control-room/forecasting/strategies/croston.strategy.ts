import { buildLearning, fitCroston } from '../../domain/forecast-models';
import { ForecastModelStrategy } from '../forecast-model-strategy.interface';

export class CrostonStrategy implements ForecastModelStrategy {
  readonly model = 'Croston' as const;

  supports(context: Parameters<ForecastModelStrategy['supports']>[0]): boolean {
    return context.xyz === 'Z' && context.historyLength > 0;
  }

  fitAndForecast(input: Parameters<ForecastModelStrategy['fitAndForecast']>[0]) {
    const fitted = fitCroston(input.values, input.trainSize);
    return {
      learning: buildLearning(this.model, fitted.params, fitted.run, input.trainSize, input.testSize,
        `α = ${fitted.params['alpha']} chọn bằng Grid Search trên TRAIN; F = Z/P là bình quân mỗi chu kỳ.`),
    };
  }
}
