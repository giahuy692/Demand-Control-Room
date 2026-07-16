import { calculateAvailableStock, calculateFreeStock } from '../../domain/math';
import { SimulationPolicy, SkuPipelineState, StageSnapshot } from '../../domain/models';

import { EXCLUDED_LOT_REASON, cloneStates, createSnapshot, dateAfter, operationalStatusNote } from '../stage-support';

export function runStage14(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const actualStock = state.daily.at(-1)?.closeStock ?? 0;
    const { availableStock, mismatch } = calculateAvailableStock(
      actualStock, state.definition.heldStock, state.definition.damagedStock, state.definition.blockedStock, state.definition.unsellableStock,
    );
    state.availableStockAudit = { actualStock, heldStock: state.definition.heldStock, damagedStock: state.definition.damagedStock, blockedStock: state.definition.blockedStock, unsellableStock: state.definition.unsellableStock, availableStock, mismatch };

    const lotIds = state.definition.inboundPlan.map(item => item.lotId);
    const duplicateLotIds = new Set(lotIds.filter((id, index) => lotIds.indexOf(id) !== index));
    const supplyReasons: string[] = [];
    if (mismatch) supplyReasons.push('Dữ liệu tồn không khớp: tồn thực tế nhỏ hơn tổng hàng giữ/hư hỏng/khóa/không bán được.');
    if (duplicateLotIds.size) supplyReasons.push(`Phát hiện ${duplicateLotIds.size} lotId trùng lặp trong kế hoạch nhập hàng — cần kiểm tra trước khi tính là nguồn độc lập.`);
    state.supplyStatus = { pendingVerification: supplyReasons.length > 0, reasons: supplyReasons };

    const excludedLots: SkuPipelineState['excludedLots'] = [];
    const countableInbound = state.definition.inboundPlan
      .filter(item => item.reliability === 'shipped-confirmed' || item.reliability === 'supplier-confirmed')
      .map(item => ({ ...item, remaining: Math.max(0, item.quantity - item.receivedQuantity - item.cancelledQuantity) }));
    for (const item of state.definition.inboundPlan) {
      if (item.reliability === 'shipped-confirmed' || item.reliability === 'supplier-confirmed') continue;
      excludedLots.push({ lotId: item.lotId, quantity: item.quantity, reliability: item.reliability, reason: EXCLUDED_LOT_REASON[item.reliability] });
    }
    state.excludedLots = excludedLots;

    const offsets = [...new Set([
      0,
      ...state.definition.inboundPlan.map(item => item.offsetDays),
      ...state.definition.commitments.map(item => item.offsetDays),
    ])].sort((a, b) => a - b);
    state.supplyMilestones = offsets.map(offset => {
      const inboundAtOffset = state.definition.inboundPlan.filter(item => item.offsetDays === offset);
      const commitmentsAtOffset = state.definition.commitments.filter(item => item.offsetDays === offset);
      const confirmedInbound = countableInbound
        .filter(item => item.offsetDays <= offset)
        .reduce((sum, item) => sum + item.remaining, 0);
      const committed = state.definition.commitments
        .filter(item => item.offsetDays <= offset)
        .reduce((sum, item) => sum + item.quantity, 0);
      const labels = [
        ...inboundAtOffset.map(item => item.label),
        ...commitmentsAtOffset.map(item => item.label),
      ];
      return {
        date: dateAfter(policy.runDate, offset),
        label: offset === 0 ? 'Ngày chạy kế hoạch' : labels.join(' · ') || `Mốc +${offset} ngày`,
        onHand: availableStock,
        confirmedInbound,
        committed,
        freeStock: calculateFreeStock(availableStock, confirmedInbound, committed),
      };
    });
    state.freeStock = state.supplyMilestones.at(-1)?.freeStock ?? availableStock;
  }
  const note14 = operationalStatusNote(policy, 14);
  return createSnapshot(14, policy, states, {
    'Mốc nguồn hàng': Object.values(states).reduce((sum, state) => sum + state.supplyMilestones.length, 0),
    'Lô bị loại': Object.values(states).reduce((sum, state) => sum + state.excludedLots.length, 0),
    'SKU chờ kiểm tra nguồn hàng': Object.values(states).filter(state => state.supplyStatus.pendingVerification).length,
    'SKU có vị thế tồn': Object.values(states).filter(state => state.supplyMilestones.length > 0).length,
    ...note14.summary,
  }, ['Tồn có thể sử dụng ngay đã trừ hàng giữ/hư hỏng/khóa/không bán được trước khi tính mốc nguồn hàng.', 'Chỉ cộng lô đã xác nhận (shipped-confirmed/supplier-confirmed); lô planned/overdue/cancelled bị loại kèm lý do.', 'Hàng tự do = tồn có thể sử dụng ngay + lô xác nhận lũy kế − cam kết lũy kế.', ...note14.audit]);
}
