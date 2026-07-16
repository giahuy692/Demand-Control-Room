import { InjectionToken } from '@angular/core';
import { StageNumber, StageSnapshot } from '../../domain/models';
import { StageExecutionContext } from './stage-execution-context.class';

export interface DemandStageProcessor {
  readonly id: StageNumber;
  readonly order: number;
  readonly dependsOn: readonly StageNumber[];
  isApplicable(context: StageExecutionContext): boolean;
  execute(context: StageExecutionContext): StageSnapshot;
}

export const DEMAND_STAGE_PROCESSORS = new InjectionToken<readonly DemandStageProcessor[]>('DEMAND_STAGE_PROCESSORS');
