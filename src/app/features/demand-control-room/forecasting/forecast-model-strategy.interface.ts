import type { ModelLearning, ModelRun } from '../domain/forecast-models';
import type { ForecastResult, SkuPipelineState, XyzClass } from '../domain/models';

export type RegisteredForecastModel = Exclude<ForecastResult['model'], 'PurchasePlan' | 'PulseRhythm'>;

export interface ForecastEligibilityContext {
  readonly xyz: XyzClass;
  readonly seasonality: SkuPipelineState['seasonality'];
  readonly trend: SkuPipelineState['trend'];
  readonly historyLength: number;
  readonly trainSize: number;
  readonly testSize: number;
  readonly seasonalPeriod: number | null;
  readonly seasonalCorrelation: number | null;
}

export interface ForecastInput {
  readonly values: readonly number[];
  readonly trainSize: number;
  readonly testSize: number;
  readonly seasonalPeriod: number | null;
  readonly seasonalCorrelation: number | null;
}

export interface ForecastCandidateResult {
  readonly learning: ModelLearning;
}

export interface ForecastModelStrategy {
  readonly model: RegisteredForecastModel;
  supports(context: ForecastEligibilityContext): boolean;
  fitAndForecast(input: ForecastInput): ForecastCandidateResult | null;
}

export interface FittedModelRun {
  readonly run: ModelRun;
  readonly params: Record<string, number>;
}
