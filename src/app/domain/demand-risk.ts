import { buildForecastLearning } from './forecast-models';
import { mean, sampleStdev } from './math';
import { SimulationPolicy, SkuPipelineState } from './models';

export interface DemandRiskInputs {
  dBar: number;
  sigmaD: number;
  sigmaDSource: 'backtest' | 'cycle-std';
  sigmaDObservationCount: number;
  ltBarDays: number;
  sigmaLtDays: number;
  ltBarCycles: number;
  sigmaLtCycles: number;
}

/** Ưu tiên sai số TEST của Chặng 11; chỉ fallback sang dao động chu kỳ khi chưa đủ backtest. */
export function demandRiskInputs(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): DemandRiskInputs {
  const fit = buildForecastLearning(state);
  const backtestErrors = fit.learning?.rows
    .filter(row => row.phase === 'test' && row.error !== null)
    .map(row => row.error!) ?? [];
  const fallbackValues = state.cycles.filter(cycle => cycle.locked).slice(-12).map(cycle => cycle.baseDemand);
  const useBacktest = backtestErrors.length >= 2;
  const values = useBacktest ? backtestErrors : fallbackValues;
  const leadTimes = state.definition.leadTimeHistoryDays;
  const ltBarDays = mean(leadTimes);
  const sigmaLtDays = sampleStdev(leadTimes);
  return {
    dBar: mean(state.finalForecast),
    sigmaD: sampleStdev(values),
    sigmaDSource: useBacktest ? 'backtest' : 'cycle-std',
    sigmaDObservationCount: values.length,
    ltBarDays,
    sigmaLtDays,
    ltBarCycles: ltBarDays / policy.cycleLength,
    sigmaLtCycles: sigmaLtDays / policy.cycleLength,
  };
}
