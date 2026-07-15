// Chặng 17 §1–§10 — cấp vốn theo đúng 7 tiêu chí sắp xếp (§7, tuyệt đối không lấy
// giá trị đơn làm tiêu chí ưu tiên — tài liệu §1 cấm rõ), chia 3 rổ (§5–§6) và cấp
// hết rổ 1 toàn danh mục trước khi đụng rổ 2, hết rổ 2 mới đến rổ 3.
import { BudgetAllocationState, BudgetAllocationStatus, SimulationPolicy, SkuPipelineState } from './models';
import { roundToPurchaseUnits } from './math';

const PRIORITY_RANK: Record<string, number> = {
  'Rất cao': 1, 'Cao': 2, 'Trung bình': 3, 'Trung bình thấp': 4, 'Thấp': 5, 'Rất thấp': 6,
};

interface Candidate {
  id: string;
  state: SkuPipelineState;
  orderQuantity: number;
  orderValue: number;
  landedCostIsEstimate: boolean;
  priorityRank: number | null;
  minimumToAvoidShortage: number;
  atRiskQuantity: number;
  additionalForProtection: number;
  fundingStepUnits: number;
  fundingMoqUnits: number;
}

// Doc(26) §17.8.2: số được cấp vốn phải là BỘI SỐ CỦA BƯỚC ĐẶT HÀNG (không phải MOQ) và, nếu đã
// cấp (>0), không được thấp hơn MOQ — hai ràng buộc khác nhau, không gộp làm một step như trước.
function fundingStepUnits(definition: SkuPipelineState['definition']): number {
  const perCarton = Math.max(1, definition.unitsPerCarton);
  const stepCartons = Math.max(1, definition.orderStep);
  return stepCartons * perCarton;
}

/** §7 — 7 tiêu chí sắp xếp; KHÔNG có orderValue trong danh sách (tài liệu §1 cấm dùng giá trị đơn làm ưu tiên). */
function compareCandidates(a: Candidate, b: Candidate): number {
  const aDays = a.state.orderPlan?.daysToStockout;
  const bDays = b.state.orderPlan?.daysToStockout;
  if ((aDays ?? Infinity) !== (bDays ?? Infinity)) return (aDays ?? Infinity) - (bDays ?? Infinity);
  const aShortage = a.state.orderPlan?.rawQuantity ?? 0;
  const bShortage = b.state.orderPlan?.rawQuantity ?? 0;
  if (aShortage !== bShortage) return bShortage - aShortage;
  if ((a.priorityRank ?? Infinity) !== (b.priorityRank ?? Infinity)) return (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity);
  const roleRank = (role: string) => role === 'core' ? 0 : role === 'strategic' ? 1 : role === 'traffic-driver' ? 2 : 3;
  const aRole = roleRank(a.state.definition.coreOrStrategicRole);
  const bRole = roleRank(b.state.definition.coreOrStrategicRole);
  if (aRole !== bRole) return aRole - bRole;
  const aLead = a.state.definition.leadTimeHistoryDays.length ? a.state.definition.leadTimeHistoryDays.reduce((sum, v) => sum + v, 0) / a.state.definition.leadTimeHistoryDays.length : 0;
  const bLead = b.state.definition.leadTimeHistoryDays.length ? b.state.definition.leadTimeHistoryDays.reduce((sum, v) => sum + v, 0) / b.state.definition.leadTimeHistoryDays.length : 0;
  if (aLead !== bLead) return bLead - aLead;
  if (a.state.definition.obsolescenceRiskRank !== b.state.definition.obsolescenceRiskRank) return a.state.definition.obsolescenceRiskRank - b.state.definition.obsolescenceRiskRank;
  return a.id.localeCompare(b.id);
}

function statusFor(fundedQuantity: number, orderQuantity: number, overBudgetProposal: BudgetAllocationState['overBudgetProposal']): BudgetAllocationStatus {
  if (orderQuantity <= 0) return 'out-of-scope';
  if (fundedQuantity >= orderQuantity) return 'funded-full';
  if (overBudgetProposal) return 'over-budget-proposal';
  if (fundedQuantity > 0) return 'funded-partial-valid';
  return 'deferred-no-budget';
}

/** Cấp vốn cho toàn danh mục theo đúng thứ tự rổ 1→2→3, chung một pool ngân sách. Mutates từng `state.budgetAllocation`. */
export function allocateBudget(states: Record<string, SkuPipelineState>, policy: SimulationPolicy): { totalValue: number; funded: number } {
  const candidates: Candidate[] = Object.values(states).map(state => {
    const orderQuantity = state.orderPlan?.orderQuantity ?? 0;
    const landedCostIsEstimate = state.definition.landedCostPerUnit === null;
    const unitCost = state.definition.landedCostPerUnit ?? state.definition.purchasePrice;
    const orderValue = orderQuantity * unitCost;
    const demandCover = state.orderPlan?.demandCover ?? 0;
    const freeStock = state.orderPlan?.freeStock ?? 0;
    const minimumRaw = Math.max(0, demandCover - freeStock);
    const minimumToAvoidShortage = Math.min(orderQuantity, roundToPurchaseUnits(minimumRaw, state.definition.unitsPerCarton, state.definition.moq, state.definition.orderStep).orderedUnits);
    const atRiskQuantity = Math.min(orderQuantity - minimumToAvoidShortage, state.orderPlan?.moqSurplus ?? 0);
    const additionalForProtection = Math.max(0, orderQuantity - minimumToAvoidShortage - atRiskQuantity);
    return {
      id: state.definition.id, state, orderQuantity, orderValue, landedCostIsEstimate,
      priorityRank: PRIORITY_RANK[state.capitalPriority] ?? null,
      minimumToAvoidShortage, atRiskQuantity, additionalForProtection,
      fundingStepUnits: fundingStepUnits(state.definition),
      fundingMoqUnits: Math.max(0, state.definition.moq),
    };
  });
  const sorted = [...candidates].sort(compareCandidates);
  const totalValue = candidates.reduce((sum, item) => sum + item.orderValue, 0);
  let remaining = policy.periodBudget;
  const funded = new Map<string, number>();

  function fundBasket(quantityOf: (candidate: Candidate) => number): void {
    for (const candidate of sorted) {
      if (candidate.priorityRank === null) continue;
      const already = funded.get(candidate.id) ?? 0;
      const basketNeed = quantityOf(candidate);
      if (basketNeed <= 0 || remaining <= 0) continue;
      const unitCost = candidate.state.definition.landedCostPerUnit ?? candidate.state.definition.purchasePrice;
      if (unitCost <= 0) { funded.set(candidate.id, already + basketNeed); continue; }
      const step = candidate.fundingStepUnits;
      const affordableSteps = Math.floor(remaining / (unitCost * step));
      let affordableUnits = affordableSteps * step;
      // Doc(26) §17.8.2: không cấp nửa vời dưới MOQ — dưới ngưỡng thì để lại cho rổ/kỳ sau.
      if (affordableUnits > 0 && affordableUnits < candidate.fundingMoqUnits) affordableUnits = 0;
      const fundable = Math.max(0, Math.min(basketNeed, affordableUnits));
      if (fundable <= 0) continue;
      funded.set(candidate.id, already + fundable);
      remaining = Math.max(0, remaining - fundable * unitCost);
    }
  }

  fundBasket(candidate => candidate.minimumToAvoidShortage);
  fundBasket(candidate => candidate.additionalForProtection);
  fundBasket(candidate => candidate.atRiskQuantity);

  for (const candidate of candidates) {
    const fundedQuantity = Math.min(candidate.orderQuantity, funded.get(candidate.id) ?? 0);
    const fundedValue = fundedQuantity * (candidate.state.definition.landedCostPerUnit ?? candidate.state.definition.purchasePrice);
    const cutQuantity = candidate.orderQuantity - fundedQuantity;
    const daysToStockout = candidate.state.orderPlan?.daysToStockout ?? null;
    const eligibleForProposal = cutQuantity > 0
      && candidate.state.definition.coreOrStrategicRole !== 'normal'
      && daysToStockout !== null
      && daysToStockout <= policy.overBudgetProposalWindowCycles * policy.cycleLength;
    const overBudgetProposal = eligibleForProposal ? {
      shortfallValue: cutQuantity * (candidate.state.definition.landedCostPerUnit ?? candidate.state.definition.purchasePrice),
      requiredQuantity: cutQuantity,
      stockoutDate: daysToStockout !== null ? new Date(new Date(`${policy.runDate}T00:00:00Z`).getTime() + daysToStockout * 86_400_000).toISOString().slice(0, 10) : null,
      impactIfNotFunded: `Dự kiến thiếu ${cutQuantity.toFixed(0)} sản phẩm, có nguy cơ hết hàng SKU thuộc vai trò ${candidate.state.definition.coreOrStrategicRole}.`,
      impactIfFunded: `Cần thêm ${(cutQuantity * (candidate.state.definition.landedCostPerUnit ?? candidate.state.definition.purchasePrice)).toLocaleString('vi-VN')} ₫ ngoài ngân sách kỳ để cấp đủ.`,
    } : null;
    let reason = 'Không có số đặt cần cấp vốn.';
    if (candidate.orderQuantity > 0 && candidate.priorityRank === null) reason = 'Chưa có ưu tiên vốn được khóa ở Chặng 8; không tự cấp vốn.';
    else if (candidate.orderQuantity > 0 && fundedQuantity >= candidate.orderQuantity) reason = 'Được cấp đủ theo 3 rổ phân bổ.';
    else if (fundedQuantity > 0) reason = 'Chỉ được cấp một phần theo thứ tự rổ và bội số mua hợp lệ do hết ngân sách.';
    else if (candidate.orderQuantity > 0) reason = 'Bị hoãn do ngân sách còn lại không đủ.';

    candidate.state.budgetAllocation = {
      orderValue: candidate.orderValue, priorityRank: candidate.priorityRank, fundedQuantity, fundedValue, cutQuantity, reason,
      basket: candidate.additionalForProtection > 0 && fundedQuantity > candidate.minimumToAvoidShortage ? 2 : candidate.atRiskQuantity > 0 && fundedQuantity > candidate.minimumToAvoidShortage + candidate.additionalForProtection ? 3 : 1,
      minimumToAvoidShortage: candidate.minimumToAvoidShortage, additionalForProtection: candidate.additionalForProtection, atRiskQuantity: candidate.atRiskQuantity,
      landedCostIsEstimate: candidate.landedCostIsEstimate,
      status: statusFor(fundedQuantity, candidate.orderQuantity, overBudgetProposal),
      overBudgetProposal,
    };
  }

  return { totalValue, funded: policy.periodBudget - remaining };
}
