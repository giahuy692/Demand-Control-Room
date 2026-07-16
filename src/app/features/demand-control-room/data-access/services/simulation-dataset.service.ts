import { Injectable } from '@angular/core';
import { DataSourceId } from '../../domain/catalog';
import { DataQualityError } from '../../../../core/errors/data-quality-error.class';
import { SimulationSession } from '../../domain/models/simulation-session.class';
import { DemandSimulationDatasetDto } from '../dto/demand-simulation-dataset.dto';
import { DatasetDomainMapper } from '../mappers/dataset-domain.mapper';
import { SimulationDatasetKind, SimulationDatasetRepository } from '../repositories/simulation-dataset.repository';

/**
 * Luồng nạp DUY NHẤT cho cả hai dataset: repository (unknown) → DTO factory
 * (validate) → mapper (domain). Lỗi ném nguyên vẹn lên caller — KHÔNG fallback
 * kind khác, KHÔNG trả kết quả cũ như kết quả mới.
 */
@Injectable({ providedIn: 'root' })
export class SimulationDatasetService {
  private readonly cache = new Map<DataSourceId, Promise<SimulationSession>>();

  constructor(
    private readonly repository: SimulationDatasetRepository,
    private readonly mapper: DatasetDomainMapper,
  ) {}

  load(kind: DataSourceId): Promise<SimulationSession> {
    const cached = this.cache.get(kind);
    if (cached) return cached;
    const pending = this.loadFresh(kind);
    // Chỉ cache khi thành công — lỗi phải được thử lại được, không "kẹt" lỗi cũ.
    pending.catch(() => this.cache.delete(kind));
    this.cache.set(kind, pending);
    return pending;
  }

  private async loadFresh(kind: DataSourceId): Promise<SimulationSession> {
    const expected: SimulationDatasetKind = kind === 'real' ? 'REAL' : 'MOCK';
    const raw = await this.repository.load(expected);
    const dto = DemandSimulationDatasetDto.fromUnknown(raw);
    if (dto.datasetKind !== expected) {
      throw new DataQualityError('DATASET_KIND', `yêu cầu ${expected} nhưng asset khai datasetKind=${dto.datasetKind} — kiểm tra map đường dẫn asset.`);
    }
    return this.mapper.toDomain(dto);
  }
}
