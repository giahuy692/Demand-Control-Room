import { demandRiskInputs } from '../../domain/demand-risk';
import { SimulationPolicy, StageSnapshot } from '../../domain/models';
import { chooseSafetyStock } from '../../domain/safety-stock';

import { cloneStates, createSnapshot, operationalStatusNote } from '../stage-support';

export function runStage15(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const choice = chooseSafetyStock(state, states, policy);
    if (!choice) {
      const risk = demandRiskInputs(state, policy);
      const hasDemandRisk = risk.sigmaDObservationCount >= 2;
      const hasLeadRisk = state.definition.leadTimeHistoryDays.length >= 2;
      state.safetyStock = null;
      const warnings = [
        !state.serviceLevel ? 'Thiếu mức phục vụ từ Chặng 8.' : '',
        !state.finalForecast.length ? 'Thiếu dự báo cuối từ Chặng 13.' : '',
        !hasDemandRisk ? 'Không đủ ít nhất 2 quan sát để tính σd.' : '',
        !hasLeadRisk ? 'Không đủ lịch sử lead time để tính LT̄ và σLT.' : '',
      ].filter(Boolean);
      state.safetyStockAudit = {
        z: 0, serviceLevel: state.serviceLevel ?? 0, dBar: risk.dBar, sigmaD: risk.sigmaD,
        sigmaDSource: risk.sigmaDSource, sigmaDObservationCount: risk.sigmaDObservationCount,
        ltBarDays: risk.ltBarDays, sigmaLtDays: risk.sigmaLtDays,
        ltBarCycles: risk.ltBarCycles, sigmaLtCycles: risk.sigmaLtCycles,
        formula: 'policy', warnings,
        method: 'policy-buffer', sourceTier: 'policy-fallback', percentileSample: null,
        serviceLevelSearch: [], unfeasiblePolicy: true,
        protection: state.definition.displayMinimumStock, maxProtectable: null, unmetProtection: 0,
      };
      continue;
    }
    state.safetyStock = choice.safetyStockValue;
    const warnings: string[] = [];
    if ((state.safetyStock ?? 0) > state.definition.maxStock) warnings.push(`SS ${state.safetyStock} vượt trần tồn ${state.definition.maxStock}; chuyển Chặng 18, không tự cắt.`);
    if ((state.safetyStock ?? 0) > state.definition.warehouseCapacity) warnings.push(`SS ${state.safetyStock} vượt sức chứa ${state.definition.warehouseCapacity}; chuyển Chặng 18, không tự cắt.`);
    if (choice.audit.sigmaDSource === 'cycle-std') warnings.push('σd dùng dao động sức mua chu kỳ thay cho sai số backtest; độ tin cậy thấp.');
    if (choice.audit.sourceTier === 'abc-xyz-group') warnings.push('Dùng độ lệch lead time của cả nhóm ABC×XYZ vì SKU chưa đủ lịch sử riêng — độ tin cậy thấp hơn.');
    if (choice.audit.unfeasiblePolicy) warnings.push('Không mức phục vụ nào trong danh sách dò đạt đủ 4 điều kiện chính sách; giữ mức sàn Chặng 8 và cần duyệt ngoại lệ.');
    if (choice.audit.unmetProtection > 0) warnings.push(`Phần bảo vệ không thể đáp ứng: ${choice.audit.unmetProtection.toFixed(0)} sản phẩm vượt trần tồn/sức chứa/hạn dùng.`);
    state.safetyStockAudit = { ...choice.audit, formula: choice.audit.method === 'policy-buffer' ? 'policy' : 'full', warnings };
  }
  const note15 = operationalStatusNote(policy, 15);
  return createSnapshot(15, policy, states, {
    'SKU đã tính SS': Object.values(states).filter(state => state.safetyStock !== null).length,
    'Dò theo percentile': Object.values(states).filter(state => state.safetyStockAudit?.method === 'percentile').length,
    'Dùng công thức Z×√(...)': Object.values(states).filter(state => state.safetyStockAudit?.method === 'z-formula').length,
    'Đơn vị LT': `chu kỳ ${policy.cycleLength} ngày`,
    ...note15.summary,
  }, ['Ưu tiên phương pháp percentile độ lệch actual−forecast trong lead time; chỉ fallback sang công thức Z×√(...) khi thiếu dữ liệu.', 'Dò mức phục vụ thấp nhất đạt đủ 4 điều kiện, không thấp hơn sàn đã khóa ở Chặng 8.', 'Mức cần bảo vệ = max(SS, tồn trưng bày tối thiểu); phần không thể đáp ứng được ghi lại, không tự hạ.', ...note15.audit]);
}
