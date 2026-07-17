import { median } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';
import { buildPromoRegionSamples } from '../../domain/promo-analysis';

import { cloneStates, createSnapshot } from '../stage-support';

export function runStage12(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const regions = buildPromoRegionSamples(state.daily);
    const factors = regions
      .filter(region => region.eligible)
      .map(region => region.factor!);
    const proposedFactor = factors.length ? median(factors) : null;
    state.promoFactor = proposedFactor;
    state.promoConfidence = factors.length >= 3 && proposedFactor! >= 1
      ? 'auto'
      : factors.length >= 2
        ? 'low'
        : factors.length === 1
          ? 'suggest-only'
          : regions.length
            ? 'blocked'
            : 'none';
  }
  return createSnapshot(12, policy, states, { 'Hệ số tự khóa': Object.values(states).filter(state => state.promoConfidence === 'auto').length, 'Cần duyệt': Object.values(states).filter(state => state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only').length, 'Bị chặn': Object.values(states).filter(state => state.promoConfidence === 'blocked').length, 'Không có mẫu': Object.values(states).filter(state => state.promoConfidence === 'none').length }, [
    'K = bán ghi nhận / nền tự nhiên theo vùng CTKM.', 'K < 1 được giữ làm bằng chứng và chuyển REVIEW, không tự nâng lên 1,00.',
    '[RULE-12-001] Chỉ học K từ vùng CTKM đủ căn cứ, không bị stockout làm méo (buildPromoRegionSamples loại hasStockout/missingBase); CTKM thường trực không tạo vùng vì đã bị loại khỏi promoCode trước Chặng 2; ngày ALWAYS_ON giữ Sales làm nền tự nhiên nên cũng không tạo vùng học K.',
  ]);
}
