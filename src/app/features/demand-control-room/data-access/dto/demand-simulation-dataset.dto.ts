import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataQualityError } from '../../../../core/errors/data-quality-error.class';
import { DailyHistoryRecordDto } from './daily-history-record.dto';
import { ProductDto } from './product.dto';
import { PromotionIntervalDto } from './promotion-interval.dto';
import { SimulationMetadataDto } from './simulation-metadata.dto';

export const DATASET_CONTRACT_VERSION = 'DEMAND-SIMULATION-DATASET-V1';
export type DatasetKind = 'MOCK' | 'REAL';

/**
 * DTO gốc của hợp đồng DEMAND-SIMULATION-DATASET-V1 — cổng DUY NHẤT chuyển payload
 * `unknown` (mock.dataset.json hoặc real.dataset.json) thành cây class instance bất biến.
 * Mock và real đi qua đúng một factory/validator này — không có parser nghiệp vụ thứ hai.
 *
 * Không tự sửa lỗi: không đổi null thành 0, không bỏ record, không lùi RunDate,
 * không fallback dataset khác — mọi vi phạm ném DataContractError/DataQualityError.
 */
export class DemandSimulationDatasetDto {
  readonly contractVersion!: typeof DATASET_CONTRACT_VERSION;
  readonly datasetId!: string;
  readonly datasetKind!: DatasetKind;
  readonly generatedAt!: string;
  readonly metadata!: SimulationMetadataDto;
  readonly products!: readonly ProductDto[];
  readonly dailyRecords!: readonly DailyHistoryRecordDto[];
  readonly promotionIntervals!: readonly PromotionIntervalDto[];

  private constructor(props: Omit<DemandSimulationDatasetDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown): DemandSimulationDatasetDto {
    const root = JsonObjectReader.read(value, 'dataset');
    // Version lạ dừng ngay TRƯỚC khi parse phần thân — không đoán cấu trúc của version chưa biết.
    const contractVersion = root.literal('contractVersion', [DATASET_CONTRACT_VERSION]);
    const datasetKind = root.literal('datasetKind', ['MOCK', 'REAL']);
    const dataset = new DemandSimulationDatasetDto({
      contractVersion,
      datasetId: root.requiredString('datasetId'),
      datasetKind,
      generatedAt: validateGeneratedAt(root),
      metadata: SimulationMetadataDto.fromUnknown(root.rawValue('metadata'), 'dataset.metadata', datasetKind),
      products: Object.freeze(root.array('products', (item, index) => ProductDto.fromUnknown(item, `dataset.products[${index}]`))),
      dailyRecords: Object.freeze(root.array('dailyRecords', (item, index) => DailyHistoryRecordDto.fromUnknown(item, `dataset.dailyRecords[${index}]`))),
      promotionIntervals: Object.freeze(root.array('promotionIntervals', (item, index) => PromotionIntervalDto.fromUnknown(item, `dataset.promotionIntervals[${index}]`))),
    });
    validateCrossRecords(dataset);
    return dataset;
  }
}

function validateGeneratedAt(root: JsonObjectReader): string {
  const raw = root.requiredString('generatedAt');
  if (Number.isNaN(new Date(raw).getTime())) {
    throw new DataQualityError('GENERATED_AT', `generatedAt="${raw}" không phải thời điểm ISO hợp lệ.`);
  }
  return raw;
}

/** Bất biến CHÉO bản ghi — chạy sau khi từng record đã hợp lệ cục bộ. */
function validateCrossRecords(dataset: DemandSimulationDatasetDto): void {
  const { metadata, products, dailyRecords, promotionIntervals } = dataset;

  // §3.15 — metadata row count phải khớp dữ liệu thực tế (chặn file bị cắt cụt giữa chừng).
  if (metadata.rowCounts.dailyRecords !== dailyRecords.length) {
    throw new DataQualityError('ROW_COUNT', `metadata khai ${metadata.rowCounts.dailyRecords} dòng ngày nhưng payload có ${dailyRecords.length} — file có thể bị đứt khi export.`);
  }
  if (metadata.rowCounts.products !== products.length) {
    throw new DataQualityError('ROW_COUNT', `metadata khai ${metadata.rowCounts.products} sản phẩm nhưng payload có ${products.length}.`);
  }

  // §3.14 — mọi dòng ngày phải thuộc một sản phẩm có trong catalog của dataset.
  const productIds = new Set<string>();
  for (const product of products) {
    if (productIds.has(product.id)) throw new DataQualityError('DUPLICATE_PRODUCT', `sản phẩm ${product.id} xuất hiện hai lần trong products.`);
    productIds.add(product.id);
  }

  // §3.1/3.2 — trùng khóa sku+date bị chặn, không tự giữ-bản-ghi-cuối như parser cũ.
  const seen = new Set<string>();
  for (let index = 0; index < dailyRecords.length; index++) {
    const record = dailyRecords[index];
    if (!productIds.has(record.sku)) {
      throw new DataQualityError('UNKNOWN_SKU', `dailyRecords[${index}] mang sku=${record.sku} không có trong products.`);
    }
    const key = `${record.sku}|${record.date}`;
    if (seen.has(key)) {
      throw new DataQualityError('DUPLICATE_DAILY_KEY', `trùng khóa sku+date: ${record.sku} ${record.date} (dailyRecords[${index}]).`);
    }
    seen.add(key);
  }

  for (const interval of promotionIntervals) {
    if (interval.sku !== null && !productIds.has(interval.sku)) {
      throw new DataQualityError('UNKNOWN_SKU', `promotionIntervals mang sku=${interval.sku} không có trong products.`);
    }
  }

  // §3.12 — dòng validation-actual không được nằm trước RunDate (nếu cờ được nguồn khai báo).
  for (let index = 0; index < dailyRecords.length; index++) {
    const record = dailyRecords[index];
    if (record.isValidationActual && record.date < metadata.runDate) {
      throw new DataQualityError('VALIDATION_WINDOW', `dailyRecords[${index}] (${record.sku} ${record.date}) gắn isValidationActual nhưng nằm trước runDate=${metadata.runDate}.`);
    }
  }
}
