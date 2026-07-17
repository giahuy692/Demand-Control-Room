import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';
import { PromotionClass } from '../../domain/models';

/**
 * Một khoảng CTKM [startDate, endDate] cấp dataset — builder dựng từ các dòng ngày có
 * promotionCode + start/end. Scaffold dùng nó để gắn mã và PHÂN LOẠI cho những ngày trong
 * khoảng KM nhưng không có dòng nguồn. `promotionClass` vắng mặt (dataset build trước
 * 2026-07) mặc định DEEP_PROMO — đúng hành vi cũ (mọi ngày interval đều bị coi là KM sâu).
 */
export class PromotionIntervalDto {
  readonly sku!: string | null;
  readonly code!: string;
  readonly name!: string | null;
  readonly startDate!: string;
  readonly endDate!: string;
  readonly promotionClass!: PromotionClass;

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
      promotionClass: row.optionalLiteral('promotionClass', ['NO_PROMOTION', 'ALWAYS_ON', 'DEEP_PROMO', 'PROMOTION_UNRESOLVED'], 'DEEP_PROMO'),
    });
    if (interval.startDate > interval.endDate) {
      throw new DataContractError(`${path}.startDate`, `startDate=${interval.startDate} > endDate=${interval.endDate}.`);
    }
    return interval;
  }
}
