import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';

/**
 * MỘT dòng lịch sử ngày theo hợp đồng DEMAND-SIMULATION-DATASET-V1.
 *
 * SAI KHÁC CÓ CHỦ ĐÍCH so với bản nháp handoff (salesRecords/stockRecords tách riêng):
 * giữ dạng MERGED sales+stock của DAILY-SOURCE-V2 vì (1) việc ghép sales↔stock theo
 * ngày đã được thực hiện và kiểm thử ở build-time (tools/demand-data), (2) nguồn thật
 * hiện KHÔNG có storeCode/barcode tách dòng — tách hai mảng lúc này là dựng hợp đồng
 * cho dữ liệu chưa tồn tại. Khi nguồn có storeCode thật, nâng contractVersion.
 *
 * Bất biến null/0 (DEC-006/007): `hasSalesRecord=false ⇔ sales=null` — không bao giờ
 * suy diễn 0 khi không có bằng chứng, không bao giờ giữ số khi cờ nói không có bằng chứng.
 */
export class DailyHistoryRecordDto {
  readonly sku!: string;
  readonly date!: string;
  /**
   * `null` CHỈ hợp lệ trên dòng isValidationActual (bán sau ngày cắt stock của nguồn —
   * SQL stock dừng ở ProcessingEndDate nên không có bằng chứng tồn; không được bịa 0).
   * Dòng lịch sử bắt buộc có số tồn.
   */
  readonly openStock!: number | null;
  readonly closeStock!: number | null;
  readonly sales!: number | null;
  readonly hasSalesRecord!: boolean;
  readonly isZeroSaleInferred!: boolean;
  readonly returnQty!: number | null;
  readonly hasReturnRecord!: boolean;
  readonly inventoryNetMovement!: number | null;
  readonly hasInventoryMovement!: boolean;
  readonly totalStockDelta!: number;
  readonly receiptHour!: string | null;
  readonly hasReceiptRecord!: boolean;
  readonly receiptTimeSource!: 'RECEIPT_DATE' | 'CREATE_TIME_FALLBACK' | 'UNRESOLVED' | null;
  readonly promoCode!: string | null;
  readonly promoName!: string | null;
  readonly price!: number | null;
  readonly productName!: string | null;
  readonly isOpeningAnchor!: boolean;
  readonly isReferenceOnly!: boolean;
  readonly isHistoryRecord!: boolean;
  readonly isValidationActual!: boolean;

  private constructor(props: Omit<DailyHistoryRecordDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown, path: string): DailyHistoryRecordDto {
    const row = JsonObjectReader.read(value, path);
    const record = new DailyHistoryRecordDto({
      sku: row.requiredString('sku'),
      date: row.isoDate('date'),
      // Tồn có thể ÂM hợp lệ (NEGATIVE_REVIEW ở scaffold) — chỉ yêu cầu hữu hạn.
      openStock: row.nullableNumber('openStock'),
      closeStock: row.nullableNumber('closeStock'),
      sales: row.nullableNumber('sales'),
      hasSalesRecord: row.requiredBoolean('hasSalesRecord'),
      isZeroSaleInferred: row.requiredBoolean('isZeroSaleInferred'),
      returnQty: row.nullableNumber('returnQty'),
      hasReturnRecord: row.requiredBoolean('hasReturnRecord'),
      inventoryNetMovement: row.nullableNumber('inventoryNetMovement'),
      hasInventoryMovement: row.requiredBoolean('hasInventoryMovement'),
      totalStockDelta: row.requiredNumber('totalStockDelta'),
      receiptHour: validateReceiptHour(row.nullableString('receiptHour'), `${path}.receiptHour`),
      hasReceiptRecord: row.requiredBoolean('hasReceiptRecord'),
      receiptTimeSource: row.nullableLiteral('receiptTimeSource', ['RECEIPT_DATE', 'CREATE_TIME_FALLBACK', 'UNRESOLVED']),
      promoCode: row.nullableString('promoCode'),
      promoName: row.nullableString('promoName'),
      price: row.nullableNumber('price'),
      productName: row.nullableString('productName'),
      isOpeningAnchor: row.requiredBoolean('isOpeningAnchor'),
      isReferenceOnly: row.requiredBoolean('isReferenceOnly'),
      isHistoryRecord: row.requiredBoolean('isHistoryRecord'),
      isValidationActual: row.requiredBoolean('isValidationActual'),
    });
    assertPairInvariant(record.hasSalesRecord, record.sales, path, 'hasSalesRecord', 'sales');
    assertPairInvariant(record.hasReturnRecord, record.returnQty, path, 'hasReturnRecord', 'returnQty');
    assertPairInvariant(record.hasInventoryMovement, record.inventoryNetMovement, path, 'hasInventoryMovement', 'inventoryNetMovement');
    if (record.isHistoryRecord && record.isValidationActual) {
      throw new DataContractError(path, 'một dòng không được vừa isHistoryRecord vừa isValidationActual.');
    }
    if ((record.openStock === null) !== (record.closeStock === null)) {
      throw new DataContractError(path, 'openStock và closeStock phải cùng null hoặc cùng có số.');
    }
    if (record.openStock === null && !record.isValidationActual) {
      throw new DataContractError(path, 'dòng lịch sử bắt buộc có bằng chứng tồn — chỉ dòng isValidationActual được phép openStock/closeStock=null.');
    }
    return record;
  }
}

/** hasRecord=false ⇔ value=null — vi phạm ở cả hai chiều đều bị chặn, không tự sửa. */
function assertPairInvariant(hasRecord: boolean, value: number | null, path: string, flagKey: string, valueKey: string): void {
  if (hasRecord && value === null) throw new DataContractError(`${path}.${valueKey}`, `${flagKey}=true nhưng ${valueKey}=null.`);
  if (!hasRecord && value !== null) throw new DataContractError(`${path}.${valueKey}`, `${flagKey}=false nhưng ${valueKey}=${value} — vi phạm bất biến null/0 (không suy diễn số khi không có bằng chứng).`);
}

function validateReceiptHour(value: string | null, path: string): string | null {
  if (value !== null && !/^\d{2}:\d{2}$/.test(value)) {
    throw new DataContractError(path, `"${value}" không phải giờ dạng HH:MM.`);
  }
  return value;
}
