import { ForecastCandidateResult, ForecastEligibilityContext, ForecastInput, ForecastModelStrategy, RegisteredForecastModel } from './forecast-model-strategy.interface';
import { CrostonStrategy } from './strategies/croston.strategy';
import { HoltWintersStrategy } from './strategies/holt-winters.strategy';
import { HoltStrategy } from './strategies/holt.strategy';
import { SeasonalNaiveStrategy } from './strategies/seasonal-naive.strategy';
import { SesStrategy } from './strategies/ses.strategy';

export class ForecastModelRegistry {
  private readonly byModel: ReadonlyMap<RegisteredForecastModel, ForecastModelStrategy>;

  constructor(strategies: readonly ForecastModelStrategy[]) {
    const entries = strategies.map(strategy => [strategy.model, strategy] as const);
    const models = entries.map(([model]) => model);
    if (new Set(models).size !== models.length) throw new Error('Forecast strategy model must be unique.');
    this.byModel = new Map(entries);
  }

  registeredModels(): readonly RegisteredForecastModel[] {
    return [...this.byModel.keys()];
  }

  fit(model: RegisteredForecastModel, context: ForecastEligibilityContext, input: ForecastInput): ForecastCandidateResult | null {
    const strategy = this.byModel.get(model);
    if (!strategy) throw new Error(`Forecast strategy is not registered: ${model}`);
    return strategy.supports(context) ? strategy.fitAndForecast(input) : null;
  }
}

export const DEFAULT_FORECAST_MODEL_REGISTRY = new ForecastModelRegistry([
  new SesStrategy(),
  new HoltStrategy(),
  new HoltWintersStrategy(),
  new CrostonStrategy(),
  new SeasonalNaiveStrategy(),
]);
