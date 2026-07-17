import { BaseDemandSource, SimulationPolicy, StageSnapshot, TechnicalFillStatus } from '../../domain/models';
import { cloneStates, createSnapshot, fillMissingBaselines } from '../stage-support';

export function runStage5MissingBaseline(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    state.daily = fillMissingBaselines(state.daily, policy.cycleLength, policy.minimumReferences, policy.maxReferenceRadius);
  }

  const days = Object.values(states).flatMap(state => state.daily);
  const filled = days.filter(day => day.baseDemandSource === BaseDemandSource.TECHNICAL_FILL);
  const unresolved = days.filter(day => day.baseDemand === null && day.technicalFillStatus === TechnicalFillStatus.UNRESOLVED);

  return createSnapshot(5, policy, states, {
    'Ngày được bổ sung': filled.length,
    'Ngày chưa đủ căn cứ': unresolved.length,
    'Số 0 thật được giữ nguyên': days.filter(day => day.baseDemandSource === BaseDemandSource.CLEAN_OBSERVED_ZERO).length,
  }, [
    'Chặng 5 chỉ hoàn thiện dữ liệu cấp ngày; chưa cộng chu kỳ.',
    'Ngày bán bằng 0 thật được giữ nguyên; ngày đã ước lượng không được dùng làm nguồn cho ngày khác.',
    `${unresolved.length} ngày vẫn chưa đủ căn cứ và được giữ nguyên vị trí thời gian.`,
  ]);
}
