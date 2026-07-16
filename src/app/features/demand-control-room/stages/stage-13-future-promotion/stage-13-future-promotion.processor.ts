import { FORECAST_HORIZON } from '../../domain/forecast-models';
import { applyPromoFactor } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';

import { cloneStates, createSnapshot } from '../stage-support';

export function runStage13(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let kNotEvaluated = 0;
  for (const state of Object.values(states)) {
    const base = state.forecast?.baseForecast ?? [];
    const hasConfirmedFuturePromo = state.definition.futurePromotions.some(item => item.confirmed);
    // RULE-13-002 — nhánh áp K tương lai chỉ thật sự được đánh giá khi có kế hoạch CTKM tương lai
    // đã xác nhận VÀ K đã tự khóa (promoConfidence='auto'); các trường hợp khác (không có kế hoạch,
    // hoặc có kế hoạch nhưng K chưa đủ tin cậy) đều là NOT_EVALUATED — không được báo "đã khóa đầy đủ".
    if (hasConfirmedFuturePromo && state.promoConfidence !== 'auto') kNotEvaluated++;
    state.finalForecast = base.map((forecast, index) => {
      const promotion = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
      const promoDays = Math.min(policy.cycleLength, promotion?.promoDays ?? 0);
      const factor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
      return applyPromoFactor(forecast, promoDays, policy.cycleLength, factor);
    });
    state.finalForecastStatus = hasConfirmedFuturePromo && state.promoConfidence === 'auto' ? 'FUTURE_PROMO_APPLIED' : 'PASSTHROUGH_NO_FUTURE_PROMO';
  }
  const confirmedPlans = Object.values(states).reduce((sum, state) => sum + state.definition.futurePromotions.filter(item => item.confirmed).length, 0);
  const passthroughCount = Object.values(states).filter(state => state.finalForecastStatus === 'PASSTHROUGH_NO_FUTURE_PROMO').length;
  return createSnapshot(13, policy, states, {
    'Chu kỳ tương lai': FORECAST_HORIZON, 'Kế hoạch KM đã xác nhận': confirmedPlans, 'SKU cần duyệt K': Object.values(states).filter(state => state.promoFactor !== null && state.promoConfidence !== 'auto').length,
    'PASSTHROUGH_NO_FUTURE_PROMO': passthroughCount, 'Nhánh áp K NOT_EVALUATED': kNotEvaluated,
  }, [
    'Chỉ phần nền tương ứng số ngày KM được nhân K.', 'Không sao chép số bán CTKM lịch sử sang tương lai.', 'Kế hoạch KM chưa xác nhận không được áp dụng.',
    `[RULE-13-001][DEC-008/009] ${passthroughCount}/${Object.keys(states).length} SKU ở trạng thái PASSTHROUGH_NO_FUTURE_PROMO (finalForecast=baselineForecast) — đúng phiên HISTORICAL_VALIDATION hiện tại, không tự tạo kế hoạch tương lai từ CTKM lịch sử.`,
    `[RULE-13-002] ${kNotEvaluated} SKU có kế hoạch CTKM tương lai nhưng K chưa tự khóa — nhánh áp K của các SKU này ghi NOT_EVALUATED, không được báo "đã khóa đầy đủ".`,
  ]);
}
