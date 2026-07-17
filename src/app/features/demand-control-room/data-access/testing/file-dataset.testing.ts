import { readFileSync } from 'node:fs';
import { SimulationDataset } from '../../domain/catalog';
import { SimulationEngine } from '../../domain/simulation-engine';
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
 * Các spec Chặng 1–4 vẫn đi qua đúng DTO + mapper production, không dựng domain object tắt.
 */
export function realDatasetFromRows(rows: Record<string, unknown>[], metadataOverrides: Record<string, unknown> = {}): SimulationDataset {
  const mappedRows = rows.map(row => {
    const sku = String(row['sku'] ?? row['productCode'] ?? '1');
    const numericCode = Number(sku.replace('SKU-', '')) || 1;
    const isPromo = row['promoCode'] !== undefined && row['promoCode'] !== null && row['promoCode'] !== '';
    // `promoCode` là shorthand "ngày KM sâu" của spec — nó thắng class mặc định NO_PROMOTION
    // của fixtureDailyRecord (bất biến DTO cấm NO_PROMOTION kèm promotionCode); class khác
    // NO_PROMOTION do spec chỉ định rõ (ALWAYS_ON/PROMOTION_UNRESOLVED) vẫn được giữ.
    const explicitClass = row['promotionClass'];
    const promotionClass = isPromo
      ? (explicitClass && explicitClass !== 'NO_PROMOTION' ? explicitClass : 'DEEP_PROMO')
      : (explicitClass ?? 'NO_PROMOTION');
    return {
      storeCode: 11,
      productCode: numericCode,
      barcode: sku,
      productName: String(row['productName'] ?? 'Sản phẩm kiểm thử'),
      date: String(row['date']),
      hasSalesRecord: row['hasSalesRecord'] ?? (row['sales'] !== null && row['sales'] !== undefined),
      sales: row['sales'] !== undefined ? row['sales'] : 2,
      price: Number(row['price'] ?? 100000),
      promotionCode: row['promoCode']
        ? (typeof row['promoCode'] === 'number'
            ? row['promoCode']
            : (/^\d+$/.test(String(row['promoCode']))
                ? Number(row['promoCode'])
                : 999))
        : null,
      promotionName: row['promoName'] ?? null,
      promotionStartDate: null,
      promotionEndDate: null,
      promotionType: null,
      // Bất biến DTO: DEEP_PROMO ⇔ mechanismType ∈ {2, 7} — fixture mặc định 2 cho ngày KM sâu
      // (?? cố ý nuốt cả null: fixtureDailyRecord đầy đủ luôn mang mechanismType=null sẵn).
      promotionMechanismType: row['promotionMechanismType'] ?? (promotionClass === 'DEEP_PROMO' ? 2 : null),
      promotionClass,
      openStock: row['openStock'] !== undefined ? row['openStock'] : 10,
      closeStock: row['closeStock'] !== undefined ? row['closeStock'] : 8,
      receiptHour: row['receiptHour'] !== undefined ? (typeof row['receiptHour'] === 'number' ? row['receiptHour'] : (row['receiptHour'] ? Number(String(row['receiptHour']).slice(0, 2)) : null)) : null,
      stockStatus: row['stockCalculationStatus'] === 'NEGATIVE_REVIEW' ? 'NEGATIVE_STOCK' : (row['stockCalculationStatus'] === 'ANCHOR_MISSING' ? 'ANCHOR_MISSING' : 'CALCULATED'),
    };
  });
  const skus = [...new Set(mappedRows.map(row => row.productCode.toString()))].sort();
  const dates = mappedRows.map(row => row.date).sort();
  const maxDate = dates.at(-1) ?? '2026-01-01';
  const raw = fixtureDataset({
    datasetKind: 'REAL',
    products: skus.map(sku => fixtureProduct({ id: sku, name: 'SKU thật', price: 100000, purchasePrice: 70000, type: 'REAL', category: 'ERP' })),
    dailyRecords: mappedRows,
    metadata: {
      runDate: maxDate,
      sourceWatermarks: { sales: maxDate, stock: maxDate },
      ...metadataOverrides,
    },
  });
  return new DatasetDomainMapper().toDomain(DemandSimulationDatasetDto.fromUnknown(raw)).dataset;
}
