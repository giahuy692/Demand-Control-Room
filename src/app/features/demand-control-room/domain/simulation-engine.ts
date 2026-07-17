import { Inject, Injectable, Optional } from '@angular/core';
import { DemandPipelineOrchestrator } from '../application/pipeline/demand-pipeline-orchestrator.service';
import { DemandStageProcessor, DEMAND_STAGE_PROCESSORS } from '../application/pipeline/demand-stage-processor.interface';
import { DemandStageRegistry } from '../application/pipeline/demand-stage-registry.service';
import { StageExecutionContext } from '../application/pipeline/stage-execution-context.class';
import { SimulationDataset } from './catalog';
import { SimulationPolicy, StageNumber, StageSnapshot } from './models';
import { runStage1 } from '../stages/stage-01-history-window/stage-01-history-window.processor';
import { runStage2 } from '../stages/stage-02-stockout/stage-02-stockout.processor';
import { runStage3 } from '../stages/stage-03-stockout-baseline/stage-03-stockout-baseline.processor';
import { runStage4 } from '../stages/stage-04-promotion-baseline/stage-04-promotion-baseline.processor';
import { runStage5MissingBaseline } from '../stages/stage-05-missing-baseline/stage-05-missing-baseline.processor';
import { runStage5 } from '../stages/stage-05-cycle-aggregation/stage-05-cycle-aggregation.processor';
import { runStage6 } from '../stages/stage-06-abc/stage-06-abc.processor';
import { runStage7 } from '../stages/stage-07-xyz/stage-07-xyz.processor';
import { runStage8 } from '../stages/stage-08-policy/stage-08-policy.processor';
import { runStage9 } from '../stages/stage-09-seasonality/stage-09-seasonality.processor';
import { runStage10 } from '../stages/stage-10-trend/stage-10-trend.processor';
import { runStage11 } from '../stages/stage-11-forecast/stage-11-forecast.processor';
import { runStage12 } from '../stages/stage-12-promotion-lift/stage-12-promotion-lift.processor';
import { runStage13 } from '../stages/stage-13-future-promotion/stage-13-future-promotion.processor';
import { runStage14 } from '../stages/stage-14-supply/stage-14-supply.processor';
import { runStage15 } from '../stages/stage-15-safety-stock/stage-15-safety-stock.processor';
import { runStage16 } from '../stages/stage-16-order-quantity/stage-16-order-quantity.processor';
import { runStage17 } from '../stages/stage-17-budget/stage-17-budget.processor';
import { runStage18 } from '../stages/stage-18-release/stage-18-release.processor';
import { runStage19 } from '../stages/stage-19-review/stage-19-review.processor';

export { buildCycles, qualifySelection, selectReferences } from '../stages/stage-support';

const STAGE_EXECUTORS: readonly ((context: StageExecutionContext) => StageSnapshot)[] = [
  context => runStage1(context.policy, context.dataset),
  context => runStage2(context.requirePrevious(), context.policy),
  context => runStage3(context.requirePrevious(), context.policy),
  context => runStage4(context.requirePrevious(), context.policy),
  context => runStage5MissingBaseline(context.requirePrevious(), context.policy),
  context => remapLegacySnapshot(runStage5(context.requirePrevious(), context.policy), 6),
  context => remapLegacySnapshot(runStage6(context.requirePrevious(), context.policy), 7),
  context => remapLegacySnapshot(runStage7(context.requirePrevious(), context.policy), 8),
  context => remapLegacySnapshot(runStage8(context.requirePrevious(), context.policy), 9),
  context => remapLegacySnapshot(runStage9(context.requirePrevious(), context.policy), 10),
  context => remapLegacySnapshot(runStage10(context.requirePrevious(), context.policy), 11),
  context => remapLegacySnapshot(runStage11(context.requirePrevious(), context.policy), 12),
  context => remapLegacySnapshot(runStage12(context.requirePrevious(), context.policy), 13),
  context => remapLegacySnapshot(runStage13(context.requirePrevious(), context.policy), 14),
  context => remapLegacySnapshot(runStage14(context.requirePrevious(), context.policy), 15),
  context => remapLegacySnapshot(runStage15(context.requirePrevious(), context.policy), 16),
  context => remapLegacySnapshot(runStage16(context.requirePrevious(), context.policy), 17),
  context => remapLegacySnapshot(runStage17(context.requirePrevious(), context.policy), 18),
  context => remapLegacySnapshot(runStage18(context.requirePrevious(), context.policy), 19),
  context => remapLegacySnapshot(runStage19(context.requirePrevious(), context.policy), 20),
];

function remapLegacySnapshot(snapshot: StageSnapshot, stage: StageNumber): StageSnapshot {
  const shift = (value: StageNumber): StageNumber => (value >= 5 ? value + 1 : value) as StageNumber;
  const shiftText = (value: string): string => value.replace(/Chặng (\d+)/g, (match, raw: string) => {
    const number = Number(raw);
    return number >= 5 ? `Chặng ${number + 1}` : match;
  }).replace(/RULE-(\d{2})/g, (match, raw: string) => {
    const number = Number(raw);
    return number >= 5 ? `RULE-${String(number + 1).padStart(2, '0')}` : match;
  });
  return Object.freeze({
    ...snapshot,
    stage,
    audit: Object.freeze(snapshot.audit.map(shiftText)),
    exceptions: Object.freeze(snapshot.exceptions.map(exception => Object.freeze({
      ...exception,
      id: exception.id.replace(`:${snapshot.stage}:`, `:${stage}:`),
      ruleId: shiftText(exception.ruleId),
      stage,
      evidence: shiftText(exception.evidence),
      suggestedAction: shiftText(exception.suggestedAction),
      blockingStages: exception.blockingStages?.map(shift),
    }))),
  });
}

export const DEFAULT_DEMAND_STAGE_PROCESSORS: readonly DemandStageProcessor[] = Object.freeze(
  STAGE_EXECUTORS.map((execute, index) => {
    const id = (index + 1) as StageNumber;
    return Object.freeze({
      id,
      order: id,
      dependsOn: id === 1 ? [] : [id - 1 as StageNumber],
      isApplicable: () => true,
      execute,
    });
  }),
);

@Injectable({ providedIn: 'root' })
export class SimulationEngine {
  private dataset: SimulationDataset | null = null;
  private readonly orchestrator: DemandPipelineOrchestrator;

  constructor(
    @Optional() @Inject(DEMAND_STAGE_PROCESSORS) processors: readonly DemandStageProcessor[] | null = null,
  ) {
    this.orchestrator = new DemandPipelineOrchestrator(new DemandStageRegistry(processors?.length ? processors : DEFAULT_DEMAND_STAGE_PROCESSORS));
  }

  setDataset(dataset: SimulationDataset | null): void {
    this.dataset = dataset;
  }

  run(stage: StageNumber, previous: StageSnapshot | null, policy: SimulationPolicy): StageSnapshot {
    const result = this.orchestrator.run(new StageExecutionContext(stage, previous, policy, this.dataset));
    if (result.status === 'COMPLETED') return result.snapshot;
    if (result.status === 'BLOCKED') throw result.error;
    throw new Error(`Chặng ${stage} không áp dụng cho phiên hiện tại.`);
  }
}
