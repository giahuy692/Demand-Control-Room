// Chặng 18 §8–§9 — gộp các dòng đã đủ điều kiện phát hành thành một đơn mua theo
// nhà cung cấp/tiền tệ/kho nhận; nhóm nào không đạt giá trị tối thiểu bị hạ cả
// nhóm về chờ duyệt, không phát hành riêng lẻ từng dòng để né điều kiện gộp.
import { SkuPipelineState } from './models';

export interface PurchaseOrderGroup {
  key: string;
  supplier: string;
  currency: string;
  receivingLocation: string;
  lineIds: string[];
  totalValue: number;
  minOrderValue: number | null;
  meetsSupplierMinimum: boolean;
}

export function buildPurchaseOrderGroups(states: Readonly<Record<string, Readonly<SkuPipelineState>>>): PurchaseOrderGroup[] {
  const groups = new Map<string, PurchaseOrderGroup>();
  for (const state of Object.values(states)) {
    if (state.releaseDecision?.status !== 'issued') continue;
    const definition = state.definition;
    const key = `${definition.supplier}::${definition.currency}::${definition.receivingLocation}`;
    const group = groups.get(key) ?? {
      key, supplier: definition.supplier, currency: definition.currency, receivingLocation: definition.receivingLocation,
      lineIds: [], totalValue: 0, minOrderValue: definition.supplierMinOrderValue, meetsSupplierMinimum: true,
    };
    group.lineIds.push(definition.id);
    group.totalValue += state.budgetAllocation?.fundedValue ?? 0;
    if (definition.supplierMinOrderValue) group.minOrderValue = Math.max(group.minOrderValue ?? 0, definition.supplierMinOrderValue);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.meetsSupplierMinimum = !group.minOrderValue || group.totalValue >= group.minOrderValue;
  return [...groups.values()];
}

/** Hạ cả nhóm về `awaiting-approval` khi nhóm không đạt giá trị tối thiểu NCC gộp (§8's mandatory re-check). Mutates `states`. */
export function applyPurchaseOrderGrouping(states: Record<string, SkuPipelineState>): void {
  for (const group of buildPurchaseOrderGroups(states)) {
    if (group.meetsSupplierMinimum) {
      for (const id of group.lineIds) {
        const state = states[id];
        if (state.releaseDecision) state.releaseDecision = { ...state.releaseDecision, purchaseOrderGroupKey: group.key };
      }
      continue;
    }
    for (const id of group.lineIds) {
      const state = states[id];
      if (!state.releaseDecision) continue;
      state.releaseDecision = {
        ...state.releaseDecision,
        status: 'awaiting-approval',
        quantityAfterApproval: 0,
        purchaseOrderGroupKey: group.key,
        reasons: [...state.releaseDecision.reasons, 'Chưa đạt giá trị đơn hàng tối thiểu của nhà cung cấp sau khi gộp đơn — cần duyệt gộp cùng các dòng khác.'],
      };
    }
  }
}
