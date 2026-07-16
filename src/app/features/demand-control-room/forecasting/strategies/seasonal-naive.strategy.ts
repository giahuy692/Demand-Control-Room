import { buildLearning, runSeasonalNaive } from '../../domain/forecast-models';
import { ForecastModelStrategy } from '../forecast-model-strategy.interface';

export class SeasonalNaiveStrategy implements ForecastModelStrategy {
  readonly model = 'SeasonalNaive' as const;

  supports(context: Parameters<ForecastModelStrategy['supports']>[0]): boolean {
    return (context.xyz === 'X' || context.xyz === 'Y') && context.seasonalPeriod !== null;
  }

  fitAndForecast(input: Parameters<ForecastModelStrategy['fitAndForecast']>[0]) {
    if (input.seasonalPeriod === null) return null;
    const period = input.seasonalPeriod;
    const correlation = input.seasonalCorrelation;
    if (correlation === null) return null;
    const run = runSeasonalNaive(input.values, period, input.trainSize);
    return {
      learning: buildLearning(this.model, { p: period, r: Number(correlation.toFixed(2)) }, run, input.trainSize, input.testSize,
        `Chu kỳ lặp p* = ${period} dò bằng tương quan Pearson trên TRAIN (r = ${correlation.toFixed(2)} ≥ 0,60) [C11 §8.5]; F = Y của đúng ${period} chu kỳ trước [C11 §8.9].`),
    };
  }
}
