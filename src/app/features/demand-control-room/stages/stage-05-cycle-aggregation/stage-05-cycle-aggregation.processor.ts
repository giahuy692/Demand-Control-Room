import { CycleStatus, ExceptionTask, SimulationPolicy, StageSnapshot } from '../../domain/models';

import { aggregateCycles, buildCycleException, buildTier2ReviewException, cloneStates, createSnapshot } from '../stage-support';

export function runStage5(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    state.cycles = aggregateCycles(state.daily, policy.cycleLength, policy.enableTier2CycleFallback);
    // §5 LỆNH CODEX / RULE-05-006 — MỘT task ngoại lệ GỘP theo chu kỳ cho mỗi CK không khóa (không tạo
    // nhiều dòng lặp theo từng ngày unresolved bên trong chu kỳ đó).
    for (const cycle of state.cycles) {
      if (!cycle.locked) exceptions.push(buildCycleException(state.definition.id, cycle, policy));
      // RULE-05-003 — chu kỳ đã khóa NHỜ lấp Tầng 2 vẫn bắt buộc một task rà soát riêng (không chặn chặng nào).
      else if (cycle.reviewRequired) exceptions.push(buildTier2ReviewException(state.definition.id, cycle, policy));
    }
  }
  const cycles = Object.values(states).flatMap(state => state.cycles);
  const days = Object.values(states).flatMap(state => state.daily);
  const countByStatus = (status: CycleStatus) => cycles.filter(cycle => cycle.status === status).length;
  return createSnapshot(5, policy, states, {
    'Chu kỳ đã khóa': cycles.filter(cycle => cycle.locked).length, 'Chu kỳ 0 ngày có nền': cycles.filter(cycle => cycle.emptyCycle).length, 'Chu kỳ thiếu một phần nền': cycles.filter(cycle => !cycle.locked && !cycle.emptyCycle).length,
    'BLOCKED_NO_VALID_BASELINE': countByStatus('BLOCKED_NO_VALID_BASELINE'), 'NO_SOURCE_RECORD': countByStatus('NO_SOURCE_RECORD'), 'BASELINE_UNRESOLVED': countByStatus('BASELINE_UNRESOLVED'), 'PARTIAL_BASELINE': countByStatus('PARTIAL_BASELINE'), 'LOCKED_OBSERVED': countByStatus('LOCKED_OBSERVED'),
    'LOCKED_ADJUSTED': countByStatus('LOCKED_ADJUSTED'), 'LOCKED_FALLBACK': countByStatus('LOCKED_FALLBACK'),
    'Chu kỳ lấp Tầng 2': cycles.filter(cycle => cycle.tier2Filled).length,
    'Chu kỳ cần rà soát (Tầng 2)': cycles.filter(cycle => cycle.reviewRequired).length,
    'Ngoại lệ cấp chu kỳ (RULE-05-006)': exceptions.length,
    'Ngày được lấp kỹ thuật': days.filter(day => day.baseDemandSource === 'TECHNICAL_FILL').length,
  }, [
    'Chỉ chu kỳ locked=true được bàn giao cho Chặng 6–11.', 'Số bán CTKM thô không được cộng vào sức mua chu kỳ.',
    `[RULE-05-001] NO_SOURCE_RECORD chỉ gán khi sourceRecordDays=0, không dùng unresolvedDays=15 để kết luận "trống".`,
    `[RULE-05] Chỉ lấp SOURCE_DATA_GAP/STOCKOUT_UNRESOLVED/PROMOTION_UNRESOLVED từ CLEAN_OBSERVED_*; ngày đã ước tính không làm nguồn.`,
    `[RULE-05-003/004][DEC-P03/P04/P05 ĐÃ KHÓA 2026-07-20] enableTier2CycleFallback=${policy.enableTier2CycleFallback} — chu kỳ có 12–14 ngày nền hợp lệ được lấp bằng median chính chu kỳ (LOCKED_ADJUSTED); 8–11 ngày chỉ lấp khi trải ≥2/3 đoạn đầu-giữa-cuối; 0–7 ngày không bao giờ dùng chính chu kỳ làm nguồn duy nhất. ${cycles.filter(cycle => cycle.tier2Filled).length} chu kỳ đã lấp Tầng 2, đều gắn cờ rà soát bắt buộc.`,
    `[RULE-05-005] Đã gán đủ trạng thái chu kỳ; OUTSIDE_ACTIVE_PERIOD/DATA_ERROR không có nguồn dữ liệu để phát hiện nên không bao giờ xuất hiện — không giả vờ có khả năng này.`,
    `[RULE-05-006] ${exceptions.length} ngoại lệ cấp chu kỳ được tạo (1 dòng/CK không khóa hoặc cần rà soát Tầng 2) — MÔ PHỎNG CHỈ ĐỀ XUẤT phương án xử lý, CHƯA THỰC HIỆN.`,
  ], exceptions);
}
