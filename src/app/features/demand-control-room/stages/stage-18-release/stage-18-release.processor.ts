import { mean } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';
import { applyPurchaseOrderGrouping } from '../../domain/purchase-orders';

import { cloneStates, createSnapshot, lockedValues, operationalStatusNote } from '../stage-support';

export function runStage18(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const funded = state.budgetAllocation?.fundedQuantity ?? 0;
    const complete = !!state.definition.supplier && state.definition.purchasePrice > 0 && state.definition.moq > 0
      && state.definition.purchaseTermsComplete && state.definition.inboundPlan.some(item => item.confirmed);
    const reasons: string[] = [];
    if (!complete) reasons.push('Thiếu ETA xác nhận, MOQ, giá mua, nhà cung cấp hoặc điều kiện đơn mua.');
    if ((state.budgetAllocation?.cutQuantity ?? 0) > 0) reasons.push('Dòng bị cắt/hoãn do ngân sách.');
    if (state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only') reasons.push('Hệ số CTKM ở trạng thái REVIEW, chỉ được áp nếu người duyệt xác nhận.');
    if (state.definition.futurePromotions.some(item => item.confirmed) && (state.promoConfidence === 'blocked' || state.promoConfidence === 'none')) reasons.push('Kế hoạch CTKM có hiệu lực nhưng hệ số đang BLOCKED/MANUAL_ONLY; giữ dự báo nền và chờ xử lý.');
    if (state.safetyStockAudit?.warnings.length) reasons.push(...state.safetyStockAudit.warnings);
    const orderQuantity = state.orderPlan?.orderQuantity ?? 0;
    const moqSurplus = state.orderPlan?.moqSurplus ?? 0;
    if (orderQuantity > 0 && moqSurplus > policy.moqSurplusApprovalThresholdRatio * orderQuantity) reasons.push(`MOQ tạo tồn dư lớn: ${moqSurplus.toFixed(0)} sản phẩm dư (>${(policy.moqSurplusApprovalThresholdRatio * 100).toFixed(0)}% số đặt).`);
    const trailingAvgDemand = mean(lockedValues(state));
    if (trailingAvgDemand > 0 && orderQuantity > policy.abnormalOrderMultiplier * trailingAvgDemand) reasons.push(`Số lượng đặt tăng bất thường: gấp ${(orderQuantity / trailingAvgDemand).toFixed(1)} lần nhu cầu bình quân các chu kỳ khóa gần nhất.`);
    if ((state.orderPlan?.shortageBeforeNewLot ?? 0) > 0) reasons.push(`Có nguy cơ thiếu ${(state.orderPlan!.shortageBeforeNewLot).toFixed(0)} sản phẩm trước khi lô mới về.`);
    if (state.supplyStatus.pendingVerification) reasons.push(...state.supplyStatus.reasons.map(reason => `Nguồn hàng: ${reason}`));
    // "Người dùng tự sửa số đề xuất": TODO(product) — ứng dụng chưa có state lưu chỉnh sửa thủ công của người dùng, không có input path để kiểm tra điều kiện này.
    let status: 'not-issued' | 'awaiting-info' | 'awaiting-approval' | 'issued' = 'issued';
    if (funded <= 0) status = 'not-issued';
    else if (!complete) status = 'awaiting-info';
    else if (reasons.length) status = 'awaiting-approval';
    state.releaseDecision = {
      status, releasedQuantity: status === 'issued' ? funded : 0, reasons,
      quantityBeforeApproval: funded, quantityAfterApproval: status === 'issued' ? funded : 0,
      purchaseOrderGroupKey: null, duplicateReleaseBlocked: false,
    };
  }
  applyPurchaseOrderGrouping(states);
  const note18 = operationalStatusNote(policy, 18);
  return createSnapshot(18, policy, states, {
    'Dòng phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'issued').length,
    'Dòng chờ bổ sung': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-info').length,
    'Dòng chờ duyệt': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-approval').length,
    'Dòng không phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'not-issued').length,
    ...note18.summary,
  }, ['Chặng 18 không tính lại số đặt.', 'Dòng có ngoại lệ được giữ nguyên số trước duyệt và không tự phát hành.', 'Nhóm cùng NCC/tiền tệ/kho nhận không đạt giá trị tối thiểu bị hạ cả nhóm về chờ duyệt.', 'Không có thao tác duyệt giả lập thay cho người có thẩm quyền.', ...note18.audit,
    ...(policy.operationalDataStatus !== 'CONFIRMED' ? [`[Chặng 18][SIMULATION_ONLY] "Phát hành" (issued) ở chặng này KHÔNG phải phát hành đơn mua thật — không có tích hợp hệ thống mua hàng thật đứng sau trạng thái này.`] : []),
  ]);
}
