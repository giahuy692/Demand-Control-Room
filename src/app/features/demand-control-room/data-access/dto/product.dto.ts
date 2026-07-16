import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';

/** Chặng 14 §8 — 5 mức tin cậy lô hàng đang về (khớp LotReliability của domain). */
const LOT_RELIABILITIES = ['shipped-confirmed', 'supplier-confirmed', 'planned', 'overdue', 'cancelled'] as const;
const PORTFOLIO_ROLES = ['core', 'strategic', 'traffic-driver', 'normal'] as const;

export interface InboundLotDtoShape {
  readonly offsetDays: number;
  readonly quantity: number;
  readonly confirmed: boolean;
  readonly label: string;
  readonly reliability: (typeof LOT_RELIABILITIES)[number];
  readonly receivedQuantity: number;
  readonly cancelledQuantity: number;
  readonly lotId: string;
}

export interface CommitmentDtoShape {
  readonly offsetDays: number;
  readonly quantity: number;
  readonly label: string;
}

export interface FuturePromotionDtoShape {
  readonly cycleOffset: number;
  readonly promoDays: number;
  readonly code: string;
  readonly confirmed: boolean;
}

/**
 * Một sản phẩm trong dataset, mang KÈM đầu vào vận hành Chặng 14–19 của chính nó.
 *
 * SAI KHÁC CÓ CHỦ ĐÍCH so với bản nháp handoff (operationalInputs.supply/leadTimes/
 * purchaseRules/budgets tách 4 mảng cấp dataset): domain `SkuDefinition` tiêu thụ các
 * trường này THEO TỪNG SKU — tách 4 mảng cấp dataset rồi join lại theo sku trong mapper
 * chỉ thêm một tầng ghép không có người dùng thật. Dữ liệu thật hiện chưa có nguồn cho
 * các trường này (notes §9.2) → real.dataset.json mang default trung tính bucket-(c).
 */
export class ProductDto {
  readonly id!: string;
  readonly name!: string;
  readonly type!: string;
  readonly price!: number;
  readonly cycles!: number;
  readonly description!: string;
  readonly category!: string;
  readonly supplier!: string;
  readonly inboundPlan!: readonly InboundLotDtoShape[];
  readonly commitments!: readonly CommitmentDtoShape[];
  readonly futurePromotions!: readonly FuturePromotionDtoShape[];
  readonly leadTimeHistoryDays!: readonly number[];
  readonly maxStock!: number;
  readonly warehouseCapacity!: number;
  readonly shelfLifeDays!: number | null;
  readonly purchasePrice!: number;
  readonly moq!: number;
  readonly purchaseTermsComplete!: boolean;
  readonly actualDemand!: readonly number[];
  readonly actualEndingStock!: number;
  readonly actualReceiptDelayDays!: readonly number[];
  readonly actualBudgetUsed!: number;
  readonly heldStock!: number;
  readonly damagedStock!: number;
  readonly blockedStock!: number;
  readonly unsellableStock!: number;
  readonly displayMinimumStock!: number;
  readonly unitsPerCarton!: number;
  readonly orderStep!: number;
  readonly supplierMinOrderValue!: number | null;
  readonly receivingLocation!: string;
  readonly currency!: string;
  readonly landedCostPerUnit!: number | null;
  readonly coreOrStrategicRole!: (typeof PORTFOLIO_ROLES)[number];
  readonly obsolescenceRiskRank!: number;

  private constructor(props: Omit<ProductDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown, path: string): ProductDto {
    const row = JsonObjectReader.read(value, path);
    const moq = row.requiredNumber('moq');
    if (moq <= 0) throw new DataContractError(`${path}.moq`, `phải > 0 (Chặng 16 chia theo MOQ), nhận được ${moq}.`);
    const unitsPerCarton = row.requiredNumber('unitsPerCarton');
    const orderStep = row.requiredNumber('orderStep');
    if (unitsPerCarton < 1) throw new DataContractError(`${path}.unitsPerCarton`, `phải ≥ 1, nhận được ${unitsPerCarton}.`);
    if (orderStep < 1) throw new DataContractError(`${path}.orderStep`, `phải ≥ 1, nhận được ${orderStep}.`);
    return new ProductDto({
      id: row.requiredString('id'),
      name: row.requiredString('name'),
      type: row.requiredString('type'),
      price: row.nonNegativeNumber('price'),
      cycles: row.nonNegativeInteger('cycles'),
      description: row.nullableString('description') ?? '',
      category: row.requiredString('category'),
      supplier: row.requiredString('supplier'),
      inboundPlan: row.array('inboundPlan', (item, index) => {
        const lot = JsonObjectReader.read(item, `${path}.inboundPlan[${index}]`);
        return {
          offsetDays: lot.requiredNumber('offsetDays'),
          quantity: lot.nonNegativeNumber('quantity'),
          confirmed: lot.requiredBoolean('confirmed'),
          label: lot.requiredString('label'),
          reliability: lot.literal('reliability', LOT_RELIABILITIES),
          receivedQuantity: lot.nonNegativeNumber('receivedQuantity'),
          cancelledQuantity: lot.nonNegativeNumber('cancelledQuantity'),
          lotId: lot.requiredString('lotId'),
        };
      }),
      commitments: row.array('commitments', (item, index) => {
        const commitment = JsonObjectReader.read(item, `${path}.commitments[${index}]`);
        return {
          offsetDays: commitment.requiredNumber('offsetDays'),
          quantity: commitment.nonNegativeNumber('quantity'),
          label: commitment.requiredString('label'),
        };
      }),
      futurePromotions: row.array('futurePromotions', (item, index) => {
        const promo = JsonObjectReader.read(item, `${path}.futurePromotions[${index}]`);
        return {
          cycleOffset: promo.nonNegativeInteger('cycleOffset'),
          promoDays: promo.nonNegativeInteger('promoDays'),
          code: promo.requiredString('code'),
          confirmed: promo.requiredBoolean('confirmed'),
        };
      }),
      leadTimeHistoryDays: row.numberArray('leadTimeHistoryDays'),
      maxStock: row.nonNegativeNumber('maxStock'),
      warehouseCapacity: row.nonNegativeNumber('warehouseCapacity'),
      shelfLifeDays: row.nullablePositiveNumber('shelfLifeDays'),
      purchasePrice: row.nonNegativeNumber('purchasePrice'),
      moq,
      purchaseTermsComplete: row.requiredBoolean('purchaseTermsComplete'),
      actualDemand: row.numberArray('actualDemand'),
      actualEndingStock: row.requiredNumber('actualEndingStock'),
      actualReceiptDelayDays: row.numberArray('actualReceiptDelayDays'),
      actualBudgetUsed: row.nonNegativeNumber('actualBudgetUsed'),
      heldStock: row.nonNegativeNumber('heldStock'),
      damagedStock: row.nonNegativeNumber('damagedStock'),
      blockedStock: row.nonNegativeNumber('blockedStock'),
      unsellableStock: row.nonNegativeNumber('unsellableStock'),
      displayMinimumStock: row.nonNegativeNumber('displayMinimumStock'),
      unitsPerCarton,
      orderStep,
      supplierMinOrderValue: row.nullablePositiveNumber('supplierMinOrderValue'),
      receivingLocation: row.requiredString('receivingLocation'),
      currency: row.requiredString('currency'),
      landedCostPerUnit: row.nullablePositiveNumber('landedCostPerUnit'),
      coreOrStrategicRole: row.literal('coreOrStrategicRole', PORTFOLIO_ROLES),
      obsolescenceRiskRank: row.nonNegativeInteger('obsolescenceRiskRank'),
    });
  }
}
