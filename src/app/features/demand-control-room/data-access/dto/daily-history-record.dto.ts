import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';
import { DEEP_PROMO_MECHANISM_TYPES, PromotionClass, StockStatus } from '../../domain/models';

/**
 * MỘT dòng lịch sử ngày theo hợp đồng DEMAND-SIMULATION-DATASET-V1 (Schema mới 2026-07).
 * Mock lẫn real đều phải qua đúng lớp này — không có schema riêng cho dữ liệu giả.
 */
export class DailyHistoryRecordDto {
  readonly storeCode!: number;
  readonly productCode!: number;
  readonly barcode!: string | null;
  readonly productName!: string | null;
  readonly date!: string;
  readonly hasSalesRecord!: boolean;
  readonly sales!: number | null;
  readonly price!: number | null;
  readonly promotionCode!: number | null;
  readonly promotionName!: string | null;
  readonly promotionStartDate!: string | null;
  readonly promotionEndDate!: string | null;
  readonly promotionType!: number | null;
  readonly promotionMechanismType!: number | null;
  readonly promotionClass!: PromotionClass;
  readonly openStock!: number | null;
  readonly closeStock!: number | null;
  readonly receiptHour!: number | null;
  readonly stockStatus!: StockStatus;

  private constructor(props: Omit<DailyHistoryRecordDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown, path: string): DailyHistoryRecordDto {
    const row = JsonObjectReader.read(value, path);
    const record = new DailyHistoryRecordDto({
      storeCode: row.requiredNumber('storeCode'),
      productCode: row.requiredNumber('productCode'),
      barcode: row.nullableString('barcode'),
      productName: row.nullableString('productName'),
      date: row.isoDate('date'),
      hasSalesRecord: row.requiredBoolean('hasSalesRecord'),
      sales: row.nullableNumber('sales'),
      price: row.nullableNumber('price'),
      promotionCode: row.nullableNumber('promotionCode'),
      promotionName: row.nullableString('promotionName'),
      promotionStartDate: row.nullableString('promotionStartDate'),
      promotionEndDate: row.nullableString('promotionEndDate'),
      promotionType: row.nullableNumber('promotionType'),
      promotionMechanismType: row.nullableNumber('promotionMechanismType'),
      promotionClass: row.literal('promotionClass', ['NO_PROMOTION', 'ALWAYS_ON', 'DEEP_PROMO', 'PROMOTION_UNRESOLVED']),
      openStock: row.nullableNumber('openStock'),
      closeStock: row.nullableNumber('closeStock'),
      receiptHour: row.nullableNumber('receiptHour'),
      stockStatus: row.literal('stockStatus', ['CALCULATED', 'NEGATIVE_STOCK', 'ANCHOR_MISSING']),
    });
    assertPairInvariant(record.hasSalesRecord, record.sales, path, 'hasSalesRecord', 'sales');
    if (record.sales !== null && record.sales < 0) {
      throw new DataContractError(`${path}.sales`, `sales=${record.sales} phải >= 0.`);
    }
    if ((record.openStock === null) !== (record.closeStock === null)) {
      throw new DataContractError(path, 'openStock và closeStock phải cùng null hoặc cùng có số.');
    }
    assertPromotionClassInvariant(record, path);
    return record;
  }
}

/** hasRecord=false ⇔ value=null — vi phạm ở cả hai chiều đều bị chặn, không tự sửa. */
function assertPairInvariant(hasRecord: boolean, value: number | null, path: string, flagKey: string, valueKey: string): void {
  if (hasRecord && value === null) throw new DataContractError(`${path}.${valueKey}`, `${flagKey}=true nhưng ${valueKey}=null.`);
  if (!hasRecord && value !== null) throw new DataContractError(`${path}.${valueKey}`, `${flagKey}=false nhưng ${valueKey}=${value} — vi phạm bất biến null/0.`);
}

/**
 * Bất biến phân loại CTKM (02-Hop-dong-du-lieu-dau-vao.md):
 * DEEP_PROMO ⇔ tbl_POLPromotion.[Type] ∈ {2, 7}. Nguồn nào (SQL export hay mock
 * generator) vi phạm đều bị chặn tại đây — không tự sửa lại phân loại.
 */
function assertPromotionClassInvariant(record: DailyHistoryRecordDto, path: string): void {
  const isDeepMechanism = record.promotionMechanismType !== null && DEEP_PROMO_MECHANISM_TYPES.includes(record.promotionMechanismType);
  if (record.promotionClass === 'DEEP_PROMO' && !isDeepMechanism) {
    throw new DataContractError(`${path}.promotionClass`, `DEEP_PROMO nhưng promotionMechanismType=${record.promotionMechanismType} ∉ {${DEEP_PROMO_MECHANISM_TYPES.join(', ')}}.`);
  }
  if (record.promotionCode !== null && isDeepMechanism && record.promotionClass !== 'DEEP_PROMO') {
    throw new DataContractError(`${path}.promotionClass`, `promotionMechanismType=${record.promotionMechanismType} ∈ {${DEEP_PROMO_MECHANISM_TYPES.join(', ')}} thì promotionClass phải là DEEP_PROMO, nhận được ${record.promotionClass}.`);
  }
  if (record.promotionClass === 'NO_PROMOTION' && record.promotionCode !== null) {
    throw new DataContractError(`${path}.promotionClass`, `NO_PROMOTION nhưng promotionCode=${record.promotionCode} — ngày có CTKM phải mang class ALWAYS_ON/DEEP_PROMO/PROMOTION_UNRESOLVED.`);
  }
}
