import { AbcClass, LockStatus, SkuPipelineState, XyzClass } from '../models';
import { PosDetailRawDto, PosMasterRawDto } from './raw-erp.dto';

/** Input thuần dữ liệu cho constructor — factory là nơi DUY NHẤT được phép tạo ra shape này. */
interface SkuViewModelInit {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly supplier: string;
  readonly abc: AbcClass;
  readonly xyz: XyzClass | null;
  readonly onHand: number;
  readonly purchasePrice: number;
  readonly moq: number;
  readonly leadTimeDays: number;
  readonly safetyStock: number | null;
  readonly finalForecast: readonly number[];
  readonly lockStatus: LockStatus;
}

/**
 * View Model DTO — dữ liệu đã tiền xử lý, tối ưu cho binding lên bảng/thẻ Angular.
 * Class (không phải interface) vì cần:
 *  - Object.freeze ở constructor để Angular OnPush coi instance là bất biến (identity-based CD, không dò field-by-field);
 *  - getter tính sẵn (totalForecast, isStockoutRisk...) thay vì lặp lại logic trong template/pipe;
 *  - static factory để chuẩn hoá đường mapping duy nhất từ domain state hoặc từ raw API.
 */
export class SkuViewModel {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly supplier: string;
  readonly abc: AbcClass;
  readonly xyz: XyzClass | null;
  readonly onHand: number;
  readonly purchasePrice: number;
  readonly moq: number;
  readonly leadTimeDays: number;
  readonly safetyStock: number | null;
  readonly finalForecast: readonly number[];
  readonly lockStatus: LockStatus;

  private constructor(init: SkuViewModelInit) {
    this.id = init.id;
    this.name = init.name;
    this.category = init.category;
    this.supplier = init.supplier;
    this.abc = init.abc;
    this.xyz = init.xyz;
    this.onHand = init.onHand;
    this.purchasePrice = init.purchasePrice;
    this.moq = init.moq;
    this.leadTimeDays = init.leadTimeDays;
    this.safetyStock = init.safetyStock;
    this.finalForecast = init.finalForecast;
    this.lockStatus = init.lockStatus;
    Object.freeze(this);
  }

  /** Đường mapping chính thức: từ state pipeline đã chạy qua 19 chặng (dữ liệu nội bộ app hiện tại). */
  static fromPipelineState(id: string, state: SkuPipelineState): SkuViewModel {
    return new SkuViewModel({
      id,
      name: state.definition.name,
      category: state.definition.category,
      supplier: state.definition.supplier,
      abc: state.classification.abc,
      xyz: state.classification.xyz,
      onHand: state.daily.at(-1)?.closeStock ?? 0,
      purchasePrice: state.definition.purchasePrice,
      moq: state.definition.moq,
      leadTimeDays: average(state.definition.leadTimeHistoryDays) ?? 0,
      safetyStock: state.safetyStock,
      finalForecast: Object.freeze([...state.finalForecast]),
      lockStatus: state.forecast?.lockStatus ?? 'review',
    });
  }

  /**
   * Đường mapping tương lai: khi có API thật trả về tbl_SALPoSMaster/Details cho 1 SKU.
   * Ví dụ minh hoạ tách lớp Raw DTO khỏi View Model — mọi field nghiệp vụ khác (ABC/XYZ, safety stock...)
   * vẫn phải đến từ domain/simulation-engine, KHÔNG được suy luận lại ở tầng DTO.
   */
  static fromRawPos(product: { id: string; name: string; category: string; supplier: string; purchasePrice: number; moq: number; leadTimeDays: number }, details: readonly PosDetailRawDto[], masters: readonly PosMasterRawDto[]): SkuViewModel {
    const masterByCode = new Map(masters.map(m => [m.Code, m]));
    const onHand = details
      .filter(d => masterByCode.get(d.PoSMaster)?.IsApproved)
      .reduce((sum, d) => sum + d.Qty, 0);
    return new SkuViewModel({
      id: product.id,
      name: product.name,
      category: product.category,
      supplier: product.supplier,
      abc: 'N/A',
      xyz: 'D',
      onHand,
      purchasePrice: product.purchasePrice,
      moq: product.moq,
      leadTimeDays: product.leadTimeDays,
      safetyStock: null,
      finalForecast: Object.freeze([]),
      lockStatus: 'review',
    });
  }

  /** Tổng nhu cầu dự báo cuối trên toàn bộ chân trời đã tính (C13). */
  get totalForecast(): number {
    return this.finalForecast.reduce((sum, value) => sum + value, 0);
  }

  /** Nhu cầu bình quân mỗi chu kỳ — dùng để ước lượng số ngày còn đủ hàng. */
  get averageCycleForecast(): number {
    return this.finalForecast.length ? this.totalForecast / this.finalForecast.length : 0;
  }

  /** Giá trị tồn hiện có theo giá vốn — dùng cho tổng hợp giá trị tồn kho theo danh mục. */
  get stockValue(): number {
    return this.onHand * this.purchasePrice;
  }

  /** Rủi ro thiếu hàng: tồn hiện có không đủ che phủ 1 chu kỳ nhu cầu kế tiếp cộng tồn an toàn. */
  get isStockoutRisk(): boolean {
    if (!this.finalForecast.length) return false;
    const nextCycleNeed = this.finalForecast[0] + (this.safetyStock ?? 0);
    return this.onHand < nextCycleNeed;
  }

  /** Số chu kỳ tồn hiện có đủ che phủ theo nhu cầu bình quân — null nếu chưa có dự báo. */
  get cyclesOfSupply(): number | null {
    return this.averageCycleForecast > 0 ? this.onHand / this.averageCycleForecast : null;
  }
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
