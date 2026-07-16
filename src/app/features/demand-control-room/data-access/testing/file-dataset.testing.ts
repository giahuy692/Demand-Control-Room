import { readFileSync } from 'node:fs';
import { DatasetDomainMapper } from '../mappers/dataset-domain.mapper';
import { SimulationDatasetKind, SimulationDatasetRepository } from '../repositories/simulation-dataset.repository';
import { SimulationDatasetService } from '../services/simulation-dataset.service';

/**
 * CHỈ DÙNG TRONG TEST (vitest chạy môi trường node, không fetch được asset) —
 * đọc đúng hai file dataset đã build từ đĩa, đi qua đúng DTO/mapper như production.
 */
export class FileSimulationDatasetRepository extends SimulationDatasetRepository {
  load(kind: SimulationDatasetKind): Promise<unknown> {
    const path = kind === 'REAL'
      ? 'src/assets/demand-planning/datasets/real.dataset.json'
      : 'src/assets/demand-planning/datasets/mock.dataset.json';
    return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  }
}

export function fileDatasetService(): SimulationDatasetService {
  return new SimulationDatasetService(new FileSimulationDatasetRepository(), new DatasetDomainMapper());
}
