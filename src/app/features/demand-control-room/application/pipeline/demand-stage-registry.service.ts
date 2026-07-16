import { DemandStageProcessor } from './demand-stage-processor.interface';

export class DemandStageRegistry {
  readonly ordered: readonly DemandStageProcessor[];
  private readonly byId: ReadonlyMap<number, DemandStageProcessor>;

  constructor(processors: readonly DemandStageProcessor[]) {
    const byId = new Map<number, DemandStageProcessor>();
    for (const processor of processors) {
      if (byId.has(processor.id)) throw new Error(`Trùng stage processor id=${processor.id}.`);
      byId.set(processor.id, processor);
    }
    for (const processor of processors) {
      for (const dependency of processor.dependsOn) {
        if (!byId.has(dependency)) throw new Error(`Stage ${processor.id} phụ thuộc stage ${dependency} chưa đăng ký.`);
      }
    }
    this.byId = byId;
    this.ordered = Object.freeze(topologicalSort(processors, byId));
  }

  get(id: number): DemandStageProcessor {
    const processor = this.byId.get(id);
    if (!processor) throw new Error(`Stage ${id} chưa đăng ký processor.`);
    return processor;
  }
}

function topologicalSort(processors: readonly DemandStageProcessor[], byId: ReadonlyMap<number, DemandStageProcessor>): DemandStageProcessor[] {
  const result: DemandStageProcessor[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (processor: DemandStageProcessor): void => {
    if (visited.has(processor.id)) return;
    if (visiting.has(processor.id)) throw new Error(`Cycle dependency tại stage ${processor.id}.`);
    visiting.add(processor.id);
    for (const dependency of processor.dependsOn) visit(byId.get(dependency)!);
    visiting.delete(processor.id);
    visited.add(processor.id);
    result.push(processor);
  };
  for (const processor of [...processors].sort((a, b) => a.order - b.order)) visit(processor);
  return result;
}
