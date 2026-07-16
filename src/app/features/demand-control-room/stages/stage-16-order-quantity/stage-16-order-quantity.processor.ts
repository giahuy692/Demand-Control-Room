import { SimulationPolicy, StageSnapshot } from '../../domain/models';
import { applySupplierConsolidation, buildOrderPlan } from '../../domain/order-plan';

import { cloneStates, createSnapshot, operationalStatusNote } from '../stage-support';

export function runStage16(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    state.orderPlan = buildOrderPlan(state, policy);
  }
  applySupplierConsolidation(states);
  const note16 = operationalStatusNote(policy, 16);
  return createSnapshot(16, policy, states, {
    'Tổng số cần trước làm tròn': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.rawQuantity ?? 0), 0)),
    'Tổng số đặt sau MOQ': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.orderQuantity ?? 0), 0)),
    'Dòng thiếu điều kiện': Object.values(states).filter(state => state.orderPlan?.warnings.length).length,
    'SKU có nguy cơ thiếu trước lô mới': Object.values(states).filter(state => (state.orderPlan?.shortageBeforeNewLot ?? 0) > 0).length,
    ...note16.summary,
  }, ['Vùng cần bao phủ = lead time (thật hoặc mặc định chính sách) + chu kỳ lập kế hoạch, không còn cứng toàn bộ tầm dự báo.', 'Không xét ngân sách tại Chặng 16.', 'Phần dư MOQ và thiếu hàng trước lô mới được giữ riêng để Chặng 17/18 kiểm tra ngoại lệ.', ...note16.audit]);
}
