import { SimulationDataset } from '../../domain/catalog';
import { SimulationPolicy, StageNumber, StageSnapshot } from '../../domain/models';

export class StageExecutionContext {
  constructor(
    readonly stage: StageNumber,
    readonly previous: StageSnapshot | null,
    readonly policy: SimulationPolicy,
    readonly dataset: SimulationDataset | null,
  ) {}

  requirePrevious(): StageSnapshot {
    if (!this.previous || this.previous.stage !== this.stage - 1) {
      throw new Error(`Chặng ${this.stage} cần snapshot đã khóa của Chặng ${this.stage - 1}.`);
    }
    return this.previous;
  }
}
