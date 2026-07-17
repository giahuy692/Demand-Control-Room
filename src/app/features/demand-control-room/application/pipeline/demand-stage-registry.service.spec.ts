import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../domain/policy';
import { DEFAULT_DEMAND_STAGE_PROCESSORS } from '../../domain/simulation-engine';
import { StageNumber } from '../../domain/models';
import { DemandPipelineOrchestrator } from './demand-pipeline-orchestrator.service';
import { DemandStageProcessor } from './demand-stage-processor.interface';
import { DemandStageRegistry } from './demand-stage-registry.service';
import { StageExecutionContext } from './stage-execution-context.class';

function processor(
  id: StageNumber,
  dependsOn: readonly StageNumber[] = [],
  isApplicable = true,
  execute: DemandStageProcessor['execute'] = () => { throw new Error('not executed'); },
): DemandStageProcessor {
  return { id, order: id, dependsOn, isApplicable: () => isApplicable, execute };
}

describe('DemandStageRegistry', () => {
  it('đăng ký đủ 20 stage theo dependency, không còn switch dispatch', () => {
    const registry = new DemandStageRegistry([...DEFAULT_DEMAND_STAGE_PROCESSORS].reverse());
    expect(registry.ordered.map(item => item.id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it('chặn id trùng, dependency thiếu và dependency cycle', () => {
    expect(() => new DemandStageRegistry([processor(1), processor(1)])).toThrow(/Trùng/);
    expect(() => new DemandStageRegistry([processor(2, [1])])).toThrow(/chưa đăng ký/);
    expect(() => new DemandStageRegistry([processor(1, [2]), processor(2, [1])])).toThrow(/Cycle/);
  });
});

describe('DemandPipelineOrchestrator', () => {
  const context = new StageExecutionContext(1, null, DEFAULT_POLICY, null);

  it('trả NOT_APPLICABLE và không execute processor', () => {
    const orchestrator = new DemandPipelineOrchestrator(new DemandStageRegistry([processor(1, [], false)]));
    expect(orchestrator.run(context)).toEqual({ status: 'NOT_APPLICABLE', snapshot: null });
  });

  it('đổi lỗi stage thành BLOCKED để caller không chạy tiếp âm thầm', () => {
    const orchestrator = new DemandPipelineOrchestrator(new DemandStageRegistry([
      processor(1, [], true, () => { throw new Error('source failed'); }),
    ]));
    const result = orchestrator.run(context);
    expect(result.status).toBe('BLOCKED');
    expect(result.status === 'BLOCKED' ? result.error.message : '').toBe('source failed');
  });
});
