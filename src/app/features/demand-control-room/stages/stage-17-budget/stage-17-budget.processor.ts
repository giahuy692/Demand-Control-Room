import { allocateBudget } from '../../domain/budget-allocation';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';

import { cloneStates, createSnapshot, operationalStatusNote } from '../stage-support';

export function runStage17(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const { totalValue, funded } = allocateBudget(states, policy);
  const note17 = operationalStatusNote(policy, 17);
  return createSnapshot(17, policy, states, {
    'Tổng giá trị đề xuất': totalValue,
    'Ngân sách kỳ': policy.periodBudget,
    'Ngân sách đã cấp': funded,
    'Dòng bị cắt/hoãn': Object.values(states).filter(state => (state.budgetAllocation?.cutQuantity ?? 0) > 0).length,
    'Đề xuất vượt ngân sách': Object.values(states).filter(state => state.budgetAllocation?.status === 'over-budget-proposal').length,
    ...note17.summary,
  }, ['Không sửa dự báo, tồn kho an toàn hoặc số đặt sau MOQ.', 'Sắp xếp theo 7 tiêu chí của tài liệu — tuyệt đối không dùng giá trị đơn hàng làm tiêu chí ưu tiên.', 'Cấp hết Rổ 1 (tránh hết hàng) toàn danh mục trước khi đụng Rổ 2 (bảo vệ), rồi mới đến Rổ 3 (rủi ro MOQ).', ...note17.audit]);
}
