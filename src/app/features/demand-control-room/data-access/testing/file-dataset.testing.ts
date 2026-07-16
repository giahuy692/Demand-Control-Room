import { readFileSync } from 'node:fs';
import { SimulationDataset } from '../../../../domain/catalog';
import { SimulationEngine } from '../../../../domain/simulation-engine';
import { DemandSimulationDatasetDto } from '../dto/demand-simulation-dataset.dto';
import { fixtureDataset, fixtureProduct } from '../dto/dataset-fixture';
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

let cachedMockDataset: SimulationDataset | null = null;

/** Dataset mock từ ĐÚNG file asset + DTO + mapper production (đồng bộ, cache module). */
export function loadMockSimulationDataset(): SimulationDataset {
  if (!cachedMockDataset) {
    const raw = JSON.parse(readFileSync('src/assets/demand-planning/datasets/mock.dataset.json', 'utf8')) as unknown;
    cachedMockDataset = new DatasetDomainMapper().toDomain(DemandSimulationDatasetDto.fromUnknown(raw)).dataset;
  }
  return cachedMockDataset;
}

/** Engine đã nạp dataset mock — thay cho `new SimulationEngine()` trong spec (engine không còn fallback nội bộ). */
export function testEngine(): SimulationEngine {
  const engine = new SimulationEngine();
  engine.setDataset(loadMockSimulationDataset());
  return engine;
}

/**
 * Dataset REAL nhỏ dựng từ mảng dòng ngày (dạng object hợp đồng V1) — thay cho
 * parseRealDataset(chuỗi CSV) trong các spec Chặng 1–4: đi qua đúng DTO + mapper.
 */
export function realDatasetFromRows(rows: Record<string, unknown>[], metadataOverrides: Record<string, unknown> = {}): SimulationDataset {
  const skus = [...new Set(rows.map(row => String(row['sku'])))].sort();
  const dates = rows.map(row => String(row['date'])).sort();
  const maxDate = dates.at(-1) ?? '2026-01-01';
  const raw = fixtureDataset({
    datasetKind: 'REAL',
    products: skus.map(sku => fixtureProduct({ id: sku, name: 'SKU thật', price: 100000, purchasePrice: 70000, type: 'REAL', category: 'ERP' })),
    dailyRecords: rows,
    metadata: {
      runDate: maxDate,
      sourceWatermarks: { sales: maxDate, stock: maxDate },
      ...metadataOverrides,
    },
  });
  return new DatasetDomainMapper().toDomain(DemandSimulationDatasetDto.fromUnknown(raw)).dataset;
}
