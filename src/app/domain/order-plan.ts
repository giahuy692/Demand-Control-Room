// Chặng 16 §3–§10 — vùng bao phủ theo lead time thật của SKU, mô phỏng tồn từng
// chu kỳ để phát hiện thiếu hàng trước khi lô mới về, quy đổi carton/MOQ/order-step
// đúng 4 bước, và gộp đơn theo nhà cung cấp/kho/tiền tệ.
import { mean, roundToPurchaseUnits, sellableBeforeExpiry } from './math';
import { OrderPlanState, SimulationPolicy, SkuPipelineState } from './models';

/** §3 — vùng cần bao phủ = lead time (thật hoặc mặc định chính sách khi SKU chưa có lịch sử) + chu kỳ lập kế hoạch. */
export function resolveCoverageWindow(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): { coverageDays: number; leadTimeDays: number } {
  const leadTimeDays = state.definition.leadTimeHistoryDays.length ? mean(state.definition.leadTimeHistoryDays) : policy.defaultLeadTimeDays;
  return { coverageDays: leadTimeDays + policy.cycleLength, leadTimeDays };
}

/** §4 — cộng đủ số chu kỳ trong vùng bao phủ, phần lẻ cuối cùng được tính theo tỷ lệ ngày dư (proration), không cộng tràn quá tầm dự báo đã khóa. */
export function demandInCoverageWindow(finalForecast: readonly number[], coverageDays: number, cycleLength: number): number {
  const fullCycles = Math.min(finalForecast.length, Math.floor(coverageDays / cycleLength));
  const remainderDays = coverageDays - fullCycles * cycleLength;
  let demand = 0;
  for (let index = 0; index < fullCycles; index++) demand += finalForecast[index];
  if (remainderDays > 0 && fullCycles < finalForecast.length) demand += finalForecast[fullCycles] * (remainderDays / cycleLength);
  return demand;
}

/** Lũy kế (lô xác nhận − cam kết) tại một mốc ngày offset, nội suy bằng mốc gần nhất ≤ offset đã có trong chuỗi milestone của Chặng 14. */
function netInboundAtOffset(milestones: readonly SkuPipelineState['supplyMilestones'][number][], runDate: string, offsetDays: number): number {
  const targetDate = new Date(`${runDate}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + offsetDays);
  const targetIso = targetDate.toISOString().slice(0, 10);
  let best: SkuPipelineState['supplyMilestones'][number] | null = null;
  for (const milestone of milestones) {
    if (milestone.date <= targetIso && (!best || milestone.date > best.date)) best = milestone;
  }
  return best ? best.confirmedInbound - best.committed : 0;
}

export interface CycleProjection {
  shortageBeforeNewLot: number;
  daysToStockout: number | null;
}

/** §7 — mô phỏng tồn dự kiến từng chu kỳ để phát hiện thiếu hàng trước khi lô mới về. */
export function projectCycleInventory(
  availableStock: number,
  milestones: readonly SkuPipelineState['supplyMilestones'][number][],
  finalForecast: readonly number[],
  policy: SimulationPolicy,
  leadTimeDays: number,
): CycleProjection {
  let close = availableStock;
  let previousNet = 0;
  let daysToStockout: number | null = null;
  let worstBeforeLeadTime = 0;
  for (let cycle = 0; cycle < finalForecast.length; cycle++) {
    const endOffset = (cycle + 1) * policy.cycleLength;
    const net = netInboundAtOffset(milestones, policy.runDate, endOffset);
    const inboundInCycle = net - previousNet;
    previousNet = net;
    close = close + inboundInCycle - finalForecast[cycle];
    if (close < 0 && daysToStockout === null) daysToStockout = endOffset;
    if (endOffset <= leadTimeDays) worstBeforeLeadTime = Math.min(worstBeforeLeadTime, close);
  }
  return { shortageBeforeNewLot: Math.max(0, -worstBeforeLeadTime), daysToStockout };
}

export interface OrderPlanResult extends OrderPlanState {}

/** §8 — tính số cần đặt và làm tròn đúng 4 bước carton→MOQ→order-step→units; §10 — cờ rủi ro hạn dùng/sức chứa. */
export function buildOrderPlan(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): OrderPlanResult {
  const { coverageDays, leadTimeDays } = resolveCoverageWindow(state, policy);
  const demandCover = demandInCoverageWindow(state.finalForecast, coverageDays, policy.cycleLength);
  const freeStock = state.freeStock ?? 0;
  const availableStock = state.availableStockAudit?.availableStock ?? freeStock;
  const warnings: string[] = [];
  if (!state.finalForecast.length) warnings.push('Thiếu dự báo cuối từ Chặng 13.');
  if (state.safetyStock === null) warnings.push('Thiếu tồn kho an toàn được tính ở Chặng 15.');
  if (!state.definition.moq) warnings.push('Thiếu MOQ hoặc quy cách mua.');

  const protection = state.safetyStockAudit?.protection ?? state.safetyStock ?? 0;
  const rawQuantity = warnings.length ? 0 : Math.max(0, demandCover + protection - freeStock);
  const { orderedUnits, cartonsOrdered, moqSurplus } = roundToPurchaseUnits(rawQuantity, state.definition.unitsPerCarton, state.definition.moq, state.definition.orderStep);

  const projection = state.finalForecast.length
    ? projectCycleInventory(availableStock, state.supplyMilestones, state.finalForecast, policy, leadTimeDays)
    : { shortageBeforeNewLot: 0, daysToStockout: null };

  const averageDemandPerCycle = mean(state.finalForecast);
  const sellable = sellableBeforeExpiry(averageDemandPerCycle, state.definition.shelfLifeDays, policy.cycleLength);
  const expiryRisk = orderedUnits > sellable;
  const capacityRisk = orderedUnits > Math.max(0, state.definition.warehouseCapacity - availableStock);
  if (expiryRisk) warnings.push(`Số đặt ${orderedUnits} vượt nhu cầu ước tính trong hạn dùng còn lại.`);
  if (capacityRisk) warnings.push(`Số đặt ${orderedUnits} vượt sức chứa kho còn trống.`);
  if (projection.shortageBeforeNewLot > 0) warnings.push(`Dự kiến thiếu ${projection.shortageBeforeNewLot.toFixed(0)} sản phẩm trước khi lô mới về.`);

  return {
    coverageCycles: Math.min(state.finalForecast.length, Math.ceil(coverageDays / policy.cycleLength)),
    demandCover, freeStock, rawQuantity, orderQuantity: orderedUnits,
    moq: state.definition.moq, moqSurplus, warnings,
    coverageDays, cartonsOrdered,
    shortageBeforeNewLot: projection.shortageBeforeNewLot, daysToStockout: projection.daysToStockout,
    // Trạng thái thật (ok/below-supplier-minimum) chỉ biết được sau khi gộp toàn danh mục — xem applySupplierConsolidation().
    consolidationStatus: state.definition.supplierMinOrderValue ? 'ok' : 'not-applicable',
    expiryRisk, capacityRisk,
  };
}

/** §9 — gộp theo (supplier, currency, receivingLocation); nhóm nào không đạt giá trị tối thiểu bị gắn cờ cho CẢ nhóm, không tự đôn 1 SKU lên để bù. */
export function applySupplierConsolidation(states: Readonly<Record<string, SkuPipelineState>>): void {
  const groups = new Map<string, { key: string; minOrderValue: number; skuIds: string[]; totalValue: number }>();
  for (const state of Object.values(states)) {
    const definition = state.definition;
    if (!definition.supplierMinOrderValue || !state.orderPlan) continue;
    const key = `${definition.supplier}::${definition.currency}::${definition.receivingLocation}`;
    const value = state.orderPlan.orderQuantity * (definition.landedCostPerUnit ?? definition.purchasePrice);
    const group = groups.get(key) ?? { key, minOrderValue: definition.supplierMinOrderValue, skuIds: [], totalValue: 0 };
    group.skuIds.push(definition.id);
    group.totalValue += value;
    group.minOrderValue = Math.max(group.minOrderValue, definition.supplierMinOrderValue);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const status = group.totalValue < group.minOrderValue ? 'below-supplier-minimum' : 'ok';
    for (const skuId of group.skuIds) {
      const state = states[skuId];
      if (state.orderPlan) state.orderPlan = { ...state.orderPlan, consolidationStatus: status };
    }
  }
}
