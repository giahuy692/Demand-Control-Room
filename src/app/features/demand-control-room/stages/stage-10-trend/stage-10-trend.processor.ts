import { calculateTrend } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';

import { cloneStates, createSnapshot, lockedCycleQualityBreakdown, lockedValues } from '../stage-support';

export function runStage10(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y' || state.seasonality === 'confirmed') continue;
    const result = calculateTrend(lockedValues(state));
    state.trend = result.trend;
    state.trendRates = result.rates;
  }
  const cycleQuality10 = lockedCycleQualityBreakdown(states);
  return createSnapshot(10, policy, states, {
    'Xu hướng tăng': Object.values(states).filter(state => state.trend === 'up').length,
    'Xu hướng giảm': Object.values(states).filter(state => state.trend === 'down').length,
    'Không xu hướng': Object.values(states).filter(state => state.trend === 'none').length,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality10.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality10.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality10.fallback,
  }, [
    '12 chu kỳ cuối chia đúng 3 đoạn × 4.', 'Chỉ kết luận khi cả g₁ và g₂ cùng vượt ngưỡng ±5%.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality10.observed} quan sát thuần, ${cycleQuality10.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality10.fallback} dùng nguồn dự phòng mùa vụ.`,
  ]);
}
