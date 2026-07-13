import { AbcClass, SkuPipelineState, XyzClass } from '../models';
import { SkuViewModel } from './sku-view.model';

/** DTO bọc (Wrapper) cho kết quả phân trang/lọc — không phải mảng phẳng, luôn kèm metadata. */
export interface PagedResultDto<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

/** DTO bọc cho số liệu tổng hợp toàn danh mục — tính 1 lần, dùng lại cho mọi widget tổng quan. */
export interface CatalogAggregateDto {
  readonly totalSku: number;
  readonly totalForecast: number;
  readonly totalStockValue: number;
  readonly stockoutRiskCount: number;
  readonly countByAbc: Readonly<Record<AbcClass, number>>;
  /** BLOCKED gồm CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW (xyz=null, RULE-07-003/004). */
  readonly countByXyz: Readonly<Record<XyzClass | 'BLOCKED', number>>;
}

/**
 * Bộ sưu tập SKU dạng Indexed/Mapped (Record<string, SkuViewModel>) thay vì mảng phẳng.
 *  - `get(id)` là tra cứu theo key — O(1), không cần Array.find O(n) trên 8000+ phần tử mỗi lần render.
 *  - `byId` được đóng băng (Object.freeze) sau khi build: instance nào cũng immutable, an toàn cho
 *    Angular OnPush/signal — thay dữ liệu nghĩa là build collection MỚI, không mutate collection cũ.
 *  - Các phép lọc/tổng hợp (filterByAbc, aggregate, toPage) chỉ đọc `ids` đã sắp xếp sẵn, không phải
 *    duyệt toàn bộ Record mỗi lần bằng Object.values().
 */
export class SkuCatalogCollection {
  private constructor(
    private readonly byId: Readonly<Record<string, SkuViewModel>>,
    private readonly ids: readonly string[],
  ) {
    Object.freeze(this);
  }

  /** Factory duy nhất: build từ snapshot pipeline hiện có trong `StageSnapshot.states`. */
  static fromPipelineStates(states: Readonly<Record<string, Readonly<SkuPipelineState>>>): SkuCatalogCollection {
    const byId: Record<string, SkuViewModel> = {};
    const ids = Object.keys(states).sort();
    for (const id of ids) byId[id] = SkuViewModel.fromPipelineState(id, states[id]);
    return new SkuCatalogCollection(Object.freeze(byId), Object.freeze(ids));
  }

  static fromViewModels(items: readonly SkuViewModel[]): SkuCatalogCollection {
    const byId: Record<string, SkuViewModel> = {};
    for (const item of items) byId[item.id] = item;
    const ids = Object.freeze(items.map(item => item.id).sort());
    return new SkuCatalogCollection(Object.freeze(byId), ids);
  }

  /** Tra cứu O(1) theo mã SKU — thay thế `array.find(x => x.id === id)`. */
  get(id: string): SkuViewModel | undefined {
    return this.byId[id];
  }

  get size(): number {
    return this.ids.length;
  }

  /** Chỉ dùng khi thực sự cần toàn bộ danh sách (ví dụ export); ưu tiên `toPage`/`filterByAbc` khi render bảng. */
  all(): readonly SkuViewModel[] {
    return this.ids.map(id => this.byId[id]);
  }

  filterByAbc(abc: AbcClass): readonly SkuViewModel[] {
    return this.ids.map(id => this.byId[id]).filter(sku => sku.abc === abc);
  }

  filterByXyz(xyz: XyzClass): readonly SkuViewModel[] {
    return this.ids.map(id => this.byId[id]).filter(sku => sku.xyz === xyz);
  }

  stockoutRisk(): readonly SkuViewModel[] {
    return this.ids.map(id => this.byId[id]).filter(sku => sku.isStockoutRisk);
  }

  /** Phân trang có metadata — component bảng chỉ bind `page.items`, không tự slice mảng gốc. */
  toPage(page: number, pageSize: number, predicate?: (sku: SkuViewModel) => boolean): PagedResultDto<SkuViewModel> {
    const source = predicate ? this.all().filter(predicate) : this.all();
    const start = page * pageSize;
    return Object.freeze({
      items: Object.freeze(source.slice(start, start + pageSize)),
      page,
      pageSize,
      totalItems: source.length,
      totalPages: Math.ceil(source.length / pageSize),
    });
  }

  /** Tổng hợp toàn danh mục — tính bằng 1 lượt duyệt, không lặp lại filter cho từng chỉ số. */
  aggregate(): CatalogAggregateDto {
    const countByAbc: Record<AbcClass, number> = { A: 0, B: 0, C: 0, 'N/A': 0 };
    const countByXyz: Record<XyzClass | 'BLOCKED', number> = { X: 0, Y: 0, Z: 0, D: 0, BLOCKED: 0 };
    let totalForecast = 0;
    let totalStockValue = 0;
    let stockoutRiskCount = 0;
    for (const id of this.ids) {
      const sku = this.byId[id];
      countByAbc[sku.abc]++;
      countByXyz[sku.xyz ?? 'BLOCKED']++;
      totalForecast += sku.totalForecast;
      totalStockValue += sku.stockValue;
      if (sku.isStockoutRisk) stockoutRiskCount++;
    }
    return Object.freeze({
      totalSku: this.ids.length,
      totalForecast,
      totalStockValue,
      stockoutRiskCount,
      countByAbc: Object.freeze(countByAbc),
      countByXyz: Object.freeze(countByXyz),
    });
  }
}
