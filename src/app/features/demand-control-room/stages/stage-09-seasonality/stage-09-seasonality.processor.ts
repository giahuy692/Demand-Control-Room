import { mean, meetsSeasonRepeatThreshold, trailingLockedRun } from '../../domain/math';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';

import { cloneStates, createSnapshot, lockedCycleQualityBreakdown } from '../stage-support';

export function runStage9(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y') {
      state.seasonality = 'not-applicable';
      continue;
    }
    // §12 (Chặng 9-12) — chỉ nhận chuỗi chu kỳ có trạng thái phù hợp: dùng trailingLockedRun thay
    // vì cycles.filter(locked) cũ (xóa khoảng trống rồi nối 2 đoạn xa nhau thành chuỗi liên tục giả).
    const values = trailingLockedRun(state.cycles).map(cycle => cycle.baseDemand);
    if (values.length < 48) {
      state.seasonality = 'insufficient-structure';
      continue;
    }
    const rounds = Array.from({ length: Math.floor(values.length / 24) }, (_, round) => values.slice(round * 24, round * 24 + 24));
    // Tài liệu giải pháp §Chặng 10: Sₚ = Rᵣ*,ₚ (tỷ lệ vòng GẦN NHẤT đủ căn cứ), không phải trung
    // bình các vòng — nhiều vòng chỉ dùng để tính tỷ lệ LẶP tín hiệu (highRepeat/lowRepeat).
    const repeatingPositions = Array.from({ length: 24 }, (_, position) => {
      const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
      const sp = ratios[ratios.length - 1];
      const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
      const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
      return (sp >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) || (sp <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat));
    });
    state.seasonality = repeatingPositions.some(Boolean) ? 'confirmed' : 'no-clear-season';
  }
  const cycleQuality9 = lockedCycleQualityBreakdown(states);
  return createSnapshot(9, policy, states, {
    'Mùa vụ xác nhận': Object.values(states).filter(state => state.seasonality === 'confirmed').length,
    'Không mùa vụ rõ': Object.values(states).filter(state => state.seasonality === 'no-clear-season').length,
    'Thiếu cấu trúc': Object.values(states).filter(state => state.seasonality === 'insufficient-structure').length,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality9.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality9.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality9.fallback,
  }, [
    'Chỉ nhóm Y được kiểm tra.', 'Cần đồng thời đạt hệ số vị trí và tỷ lệ lặp ≥ 67%.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality9.observed} quan sát thuần, ${cycleQuality9.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality9.fallback} dùng nguồn dự phòng mùa vụ — không đổi phép tính, chỉ tách theo chất lượng nguồn (RULE-05-005).`,
  ]);
}
