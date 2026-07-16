import { buildLearning, fitSes } from '../../domain/forecast-models';
import { ForecastModelStrategy } from '../forecast-model-strategy.interface';

export class SesStrategy implements ForecastModelStrategy {
  readonly model = 'SES' as const;

  supports(context: Parameters<ForecastModelStrategy['supports']>[0]): boolean {
    return (context.xyz === 'X' || context.xyz === 'Y') && context.historyLength > 0;
  }

  fitAndForecast(input: Parameters<ForecastModelStrategy['fitAndForecast']>[0]) {
    const fitted = fitSes(input.values, input.trainSize);
    return {
      learning: buildLearning(this.model, fitted.params, fitted.run, input.trainSize, input.testSize,
        `α = ${fitted.params['alpha']} chọn bằng Grid Search thô rồi tinh chỉnh bước 0,01 trong miền 0,05–0,5 [C11 §5.5].`),
    };
  }
}
