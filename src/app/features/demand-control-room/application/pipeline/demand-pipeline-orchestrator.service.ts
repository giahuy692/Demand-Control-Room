import { StageSnapshot } from '../../domain/models';
import { DemandStageRegistry } from './demand-stage-registry.service';
import { StageExecutionContext } from './stage-execution-context.class';

export type DemandStageExecutionResult =
  | { readonly status: 'COMPLETED'; readonly snapshot: StageSnapshot }
  | { readonly status: 'NOT_APPLICABLE'; readonly snapshot: null }
  | { readonly status: 'BLOCKED'; readonly snapshot: null; readonly error: Error };

export class DemandPipelineOrchestrator {
  constructor(private readonly registry: DemandStageRegistry) {}

  run(context: StageExecutionContext): DemandStageExecutionResult {
    const processor = this.registry.get(context.stage);
    if (!processor.isApplicable(context)) return { status: 'NOT_APPLICABLE', snapshot: null };
    try {
      return { status: 'COMPLETED', snapshot: processor.execute(context) };
    } catch (error) {
      return { status: 'BLOCKED', snapshot: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}
