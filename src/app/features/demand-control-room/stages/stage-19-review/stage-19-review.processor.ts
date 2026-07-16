import { calculateBias, calculateNrmse, calculateRmse, calculateWape, mean } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';

import { CAUSE_TABLE, PostAuditContext, cloneStates, createSnapshot, operationalStatusNote } from '../stage-support';

export function runStage19(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const actual = state.definition.actualDemand;
    const finalForecastSlice = state.finalForecast.slice(0, actual.length);
    const baseForecastSlice = (state.forecast?.baseForecast ?? []).slice(0, actual.length);
    const actualDemand = actual.reduce((sum, value) => sum + value, 0);
    const forecastWape = actual.length && finalForecastSlice.length === actual.length ? calculateWape(actual, finalForecastSlice) : null;
    const finalForecastRmse = actual.length ? calculateRmse(actual, finalForecastSlice) : null;
    const finalForecastNrmse = actual.length ? calculateNrmse(actual, finalForecastSlice) : null;
    const finalForecastBias = actual.length ? calculateBias(actual, finalForecastSlice) : null;

    // §4.1 — sai số dự báo NỀN chỉ đo trên chu kỳ KHÔNG có CTKM xác nhận (tách khỏi tác động hệ số K).
    const nonPromoIndexes = actual.map((_, index) => index).filter(index => !state.definition.futurePromotions.some(item => item.confirmed && item.cycleOffset === index + 1));
    const nonPromoActual = nonPromoIndexes.map(index => actual[index]);
    const nonPromoBase = nonPromoIndexes.map(index => baseForecastSlice[index] ?? 0);
    const hasBaseSample = nonPromoActual.length > 0 && baseForecastSlice.length === actual.length;
    const baseForecastWape = hasBaseSample ? calculateWape(nonPromoActual, nonPromoBase) : null;
    const baseForecastRmse = hasBaseSample ? calculateRmse(nonPromoActual, nonPromoBase) : null;
    const baseForecastNrmse = hasBaseSample ? calculateNrmse(nonPromoActual, nonPromoBase) : null;
    const baseForecastBias = hasBaseSample ? calculateBias(nonPromoActual, nonPromoBase) : null;

    const promoIndexes = actual.map((_, index) => index).filter(index => state.definition.futurePromotions.some(item => item.confirmed && item.cycleOffset === index + 1));
    const promoActual = promoIndexes.map(index => actual[index]);
    const promoFinal = promoIndexes.map(index => finalForecastSlice[index] ?? 0);
    const promoUnderlearned = promoIndexes.length > 0 && (state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only' || state.promoConfidence === 'blocked')
      && promoActual.reduce((sum, value) => sum + value, 0) > promoFinal.reduce((sum, value) => sum + value, 0);

    const released = state.releaseDecision?.releasedQuantity ?? 0;
    const available = Math.max(0, state.freeStock ?? 0) + released;
    const stockoutUnits = Math.max(0, actualDemand - available);
    const delays = state.definition.actualReceiptDelayDays;
    const averageReceiptDelayDays = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
    const budgetVariance = (state.budgetAllocation?.fundedValue ?? 0) - state.definition.actualBudgetUsed;
    const moqSurplusResidual = state.orderPlan?.moqSurplus ?? 0;
    const budgetCutUnits = state.budgetAllocation?.cutQuantity ?? 0;
    const manualReductionUnits = Math.max(0, (state.releaseDecision?.quantityBeforeApproval ?? 0) - (state.releaseDecision?.quantityAfterApproval ?? 0));
    const leadTimeActualDays = state.definition.leadTimeHistoryDays.length ? mean(state.definition.leadTimeHistoryDays) + averageReceiptDelayDays : null;
    const definition = state.definition;

    const context: PostAuditContext = {
      stockoutUnits, averageReceiptDelayDays, budgetCutUnits, manualReductionUnits, moqSurplusResidual,
      endingStock: state.definition.actualEndingStock,
      baseUnderforecast: hasBaseSample && nonPromoActual.reduce((sum, value) => sum + value, 0) > nonPromoBase.reduce((sum, value) => sum + value, 0) * 1.1,
      promoUnderlearned,
      heldOrDamagedOrBlockedOrUnsellable: definition.heldStock + definition.damagedStock + definition.blockedStock + definition.unsellableStock > 0,
    };
    const matched = CAUSE_TABLE.filter(row => row.test(context));
    const primaryCause = matched[0]?.label ?? 'Chưa đủ dấu hiệu để quy nguyên nhân; tiếp tục theo dõi.';
    const proposal = matched[0]?.proposal ?? 'Giữ chính sách hiện tại và tiếp tục thu thập kết quả thực tế.';
    // §10 — cổng mức độ nghiêm trọng thay cho phát hiện "lặp lại" thật (engine không lưu lịch sử nhiều phiên).
    const severeEnough = matched.length > 0 && (stockoutUnits > 0 || (forecastWape ?? 0) > 0.3);
    const proposalStatus: 'future-version' | 'monitor' = severeEnough ? 'future-version' : 'monitor';
    const evidence = [
      `Sai số WAPE dự báo cuối: ${forecastWape === null ? 'chưa đủ dữ liệu' : `${(forecastWape * 100).toFixed(1)}%`}.`,
      `Thiếu hàng thực tế: ${stockoutUnits.toFixed(0)} sản phẩm.`,
      `Trễ nhận hàng bình quân: ${averageReceiptDelayDays.toFixed(1)} ngày.`,
      `Ngân sách bị cắt: ${budgetCutUnits.toFixed(0)} sản phẩm · Giảm do duyệt thủ công: ${manualReductionUnits.toFixed(0)} sản phẩm.`,
    ];

    state.postAudit = {
      forecastWape, actualDemand, stockoutUnits, endingStock: state.definition.actualEndingStock,
      averageReceiptDelayDays, budgetVariance, primaryCause, proposal, proposalStatus,
      baseForecastWape, baseForecastRmse, baseForecastNrmse, baseForecastBias,
      finalForecastRmse, finalForecastNrmse, finalForecastBias,
      moqSurplusResidual, budgetCutUnits, manualReductionUnits,
      leadTimeActualDays, receiptDelayDaysVsPlan: averageReceiptDelayDays,
      contributingCauses: matched.map(row => row.label), evidence,
    };
  }
  const note19 = operationalStatusNote(policy, 19);
  return createSnapshot(19, policy, states, {
    'WAPE danh mục': (() => {
      const items = Object.values(states).map(state => state.postAudit).filter(Boolean);
      const actual = items.reduce((sum, item) => sum + item!.actualDemand, 0);
      const error = Object.values(states).reduce((sum, state) => {
        const demand = state.definition.actualDemand;
        return sum + demand.reduce((subtotal, value, index) => subtotal + Math.abs(value - (state.finalForecast[index] ?? 0)), 0);
      }, 0);
      return actual > 0 ? error / actual : 0;
    })(),
    'SKU phát sinh thiếu hàng': Object.values(states).filter(state => (state.postAudit?.stockoutUnits ?? 0) > 0).length,
    'Đề xuất cho phiên tương lai': Object.values(states).filter(state => state.postAudit?.proposalStatus === 'future-version').length,
    ...note19.summary,
  }, ['Giữ nguyên toàn bộ snapshot C1–C18; không hồi tố.', 'Tách nguyên nhân theo dữ liệu, nguồn hàng, tồn an toàn, MOQ, ngân sách và duyệt ngoại lệ.', 'Mọi thay đổi chỉ là đề xuất cho phiên bản tương lai.', ...note19.audit]);
}
