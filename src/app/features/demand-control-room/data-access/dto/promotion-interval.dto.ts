import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';

/**
 * Một khoảng CTKM [startDate, endDate] cấp dataset. Pipeline ingest hiện tại chưa xuất
 * bảng interval riêng (promo nằm inline `promoCode` trên từng dòng ngày) — mảng này
 * rỗng ở cả hai dataset cho tới khi SQL export RESULT SET interval; hợp đồng giữ sẵn
 * chỗ để không phải nâng contractVersion khi nguồn bổ sung.
 */
export class PromotionIntervalDto {
  readonly sku!: string | null;
  readonly code!: string;
  readonly name!: string | null;
  readonly startDate!: string;
  readonly endDate!: string;

  private constructor(props: Omit<PromotionIntervalDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown, path: string): PromotionIntervalDto {
    const row = JsonObjectReader.read(value, path);
    const interval = new PromotionIntervalDto({
      sku: row.nullableString('sku'),
      code: row.requiredString('code'),
      name: row.nullableString('name'),
      startDate: row.isoDate('startDate'),
      endDate: row.isoDate('endDate'),
    });
    if (interval.startDate > interval.endDate) {
      throw new DataContractError(`${path}.startDate`, `startDate=${interval.startDate} > endDate=${interval.endDate}.`);
    }
    return interval;
  }
}
