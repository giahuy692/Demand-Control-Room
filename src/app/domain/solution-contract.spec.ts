import { describe, expect, it } from 'vitest';
import { applyPromoFactor, classifyAbcRows, mean, meetsSeasonRepeatThreshold, sampleStdev } from './math';
import { StageNumber, StageSnapshot } from './models';
import { CAPITAL_PRIORITIES, DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';

function runTo(stage: StageNumber, policy = DEFAULT_POLICY): StageSnapshot {
  const engine = new SimulationEngine();
  let snapshot: StageSnapshot | null = null;
  for (let current = 1; current <= stage; current++) snapshot = engine.run(current as StageNumber, snapshot, policy);
  return snapshot!;
}

describe('hợp đồng đối chiếu trực tiếp Tài liệu giải pháp C1–C19', () => {
  it('C1 không đọc lịch sử SKU vượt ngoài số chu kỳ đầy đủ của phiên', () => {
    const policy = { ...DEFAULT_POLICY, historyYears: 2 };
    const snapshot = runTo(1, policy);
    const maxDays = Number(snapshot.summary['Chu kỳ đầy đủ N']) * policy.cycleLength;
    for (const state of Object.values(snapshot.states)) expect(state.daily.length).toBeLessThanOrEqual(maxDays);
  });

  it('C6 giữ SKU đứng đầu là A khi một mình vượt 80% và dùng C từ đúng 90%', () => {
    expect(classifyAbcRows([{ id: 'TOP', annualValue: 90 }, { id: 'TAIL', annualValue: 10 }])).toEqual({ TOP: 'A', TAIL: 'C' });
  });

  it('C8 gán ưu tiên vốn theo từng ô AX…CZ, không suy rộng theo A/B/C', () => {
    const snapshot = runTo(8);
    for (const state of Object.values(snapshot.states)) {
      const { abc, xyz } = state.classification;
      if (abc === 'N/A' || xyz === 'D') continue;
      expect(state.capitalPriority).toBe(CAPITAL_PRIORITIES[`${abc}${xyz}`]);
    }
  });

  it('C9 hiểu 2/3 vòng là 67% theo cách trình bày của tài liệu', () => {
    expect(meetsSeasonRepeatThreshold(2 / 3)).toBe(true);
  });

  it('C11 không tự LOCKED khi tài liệu chưa có ngưỡng P25 được phê duyệt', () => {
    const snapshot = runTo(11);
    for (const state of Object.values(snapshot.states)) {
      expect(state.forecast?.lockStatus).not.toBe('locked');
      if (state.forecast?.model === 'PurchasePlan') expect(state.forecast.lockStatus).toBe('exception');
    }
  });

  it('C13 chỉ đọc kế hoạch CTKM đã xác nhận từ input SKU', () => {
    const snapshot = runTo(13);
    for (const state of Object.values(snapshot.states)) {
      const base = state.forecast?.baseForecast ?? [];
      const factor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
      base.forEach((value, index) => {
        const plan = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
        const expected = applyPromoFactor(value, plan?.promoDays ?? 0, DEFAULT_POLICY.cycleLength, factor);
        expect(state.finalForecast[index]).toBeCloseTo(expected, 10);
      });
    }
  });

  it('C14 tính I_free theo từng mốc và không cộng lô chưa xác nhận', () => {
    const snapshot = runTo(14);
    for (const state of Object.values(snapshot.states)) {
      const expectedInbound = state.definition.inboundPlan.filter(item => item.confirmed).reduce((sum, item) => sum + item.quantity, 0);
      const final = state.supplyMilestones.at(-1)!;
      expect(final.confirmedInbound).toBe(expectedInbound);
      state.supplyMilestones.forEach(row => expect(row.freeStock).toBe(row.onHand + row.confirmedInbound - row.committed));
    }
  });

  it('C15 lấy LT̄/σLT từ lịch sử lead time của SKU và giữ nguyên cảnh báo ràng buộc', () => {
    const snapshot = runTo(15);
    for (const state of Object.values(snapshot.states)) {
      const audit = state.safetyStockAudit;
      if (!audit || !state.definition.leadTimeHistoryDays.length) continue;
      expect(audit.ltBarDays).toBeCloseTo(mean(state.definition.leadTimeHistoryDays), 10);
      expect(audit.sigmaLtDays).toBeCloseTo(sampleStdev(state.definition.leadTimeHistoryDays), 10);
      if (state.safetyStock !== null && state.safetyStock > state.definition.maxStock) {
        expect(audit.warnings.some(warning => warning.includes('vượt trần tồn'))).toBe(true);
        expect(state.safetyStock).toBeGreaterThan(state.definition.maxStock);
      }
    }
  });

  it('C16 tính Qraw rồi làm tròn lên đúng bội số MOQ, chưa xét ngân sách', () => {
    const snapshot = runTo(16);
    for (const state of Object.values(snapshot.states)) {
      const plan = state.orderPlan!;
      if (plan.warnings.length) continue;
      expect(plan.rawQuantity).toBeCloseTo(Math.max(0, plan.demandCover + state.safetyStock! - plan.freeStock), 10);
      expect(plan.orderQuantity).toBe(plan.rawQuantity > 0 ? Math.ceil(plan.rawQuantity / plan.moq) * plan.moq : 0);
      expect(plan.moqSurplus).toBeCloseTo(plan.orderQuantity - plan.rawQuantity, 10);
    }
  });

  it('C17 không vượt ngân sách và không cấp phần lẻ sai MOQ', () => {
    const snapshot = runTo(17);
    const fundedValue = Object.values(snapshot.states).reduce((sum, state) => sum + (state.budgetAllocation?.fundedValue ?? 0), 0);
    expect(fundedValue).toBeLessThanOrEqual(DEFAULT_POLICY.periodBudget);
    for (const state of Object.values(snapshot.states)) {
      expect((state.budgetAllocation?.fundedQuantity ?? 0) % state.definition.moq).toBe(0);
      expect(state.budgetAllocation?.fundedQuantity ?? 0).toBeLessThanOrEqual(state.orderPlan?.orderQuantity ?? 0);
    }
  });

  it('C18 không tính lại số đặt và chỉ phát hành dòng qua đủ ba cổng', () => {
    const snapshot = runTo(18);
    for (const state of Object.values(snapshot.states)) {
      const decision = state.releaseDecision!;
      if (decision.status === 'issued') {
        expect(decision.releasedQuantity).toBe(state.budgetAllocation?.fundedQuantity);
        expect(decision.reasons).toHaveLength(0);
      } else {
        expect(decision.releasedQuantity).toBe(0);
      }
    }
  });

  it('C19 tính WAPE trên actual và chỉ tạo đề xuất cho phiên tương lai', () => {
    const snapshot = runTo(19);
    for (const state of Object.values(snapshot.states)) {
      const audit = state.postAudit!;
      const actual = state.definition.actualDemand;
      const denominator = actual.reduce((sum, value) => sum + value, 0);
      if (denominator && state.finalForecast.length >= actual.length) {
        const expected = actual.reduce((sum, value, index) => sum + Math.abs(value - state.finalForecast[index]), 0) / denominator;
        expect(audit.forecastWape).toBeCloseTo(expected, 10);
      }
      expect(['future-version', 'monitor']).toContain(audit.proposalStatus);
    }
  });

  it('C19 dữ liệu thực tế mô phỏng phải tiếp nối đúng mẫu nhu cầu lịch sử của từng SKU', () => {
    const snapshot = runTo(1);
    const definitionOf = (id: string) => snapshot.states[id].definition;
    // Nhịp 3 chu kỳ (SKU-003, lịch sử 24 CK): chu kỳ tương lai 26 & 29 → index 2 & 5 có nhu cầu, còn lại 0.
    const pulse = definitionOf('SKU-003').actualDemand;
    expect(pulse.map(value => value > 0)).toEqual([false, false, true, false, false, true]);
    expect(pulse[2]).toBeGreaterThan(75);
    // Mùa vụ 24 vị trí (SKU-002, 72 CK lịch sử): tương lai bắt đầu lại từ vị trí 0 (mùa thấp ~20).
    const seasonal = definitionOf('SKU-002').actualDemand;
    expect(seasonal[0]).toBeGreaterThan(15);
    expect(seasonal[0]).toBeLessThan(30);
    expect(seasonal[5]).toBeGreaterThan(seasonal[0]); // vị trí 5 (≈96) cao hơn hẳn vị trí 0 (≈20)
    // Nhóm D nhu cầu 0 (SKU-014) không được có "thực tế" dương giả tạo.
    expect(definitionOf('SKU-014').actualDemand.every(value => value === 0)).toBe(true);
  });
});
