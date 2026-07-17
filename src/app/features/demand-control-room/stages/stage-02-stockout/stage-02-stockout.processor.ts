import { ExceptionTask, SimulationPolicy, StageSnapshot, StockoutStatus } from '../../domain/models';
import { cloneStates, createSnapshot } from '../stage-support';

function cutoffAsHour(cutoffHour: string): number {
  const [hours, minutes] = cutoffHour.split(':').map(Number);
  return hours + minutes / 60;
}

function classifyStockout(openStock: number | null, closeStock: number | null, receiptHour: number | null, cutoffHour: string): StockoutStatus {
  if ((openStock !== null && openStock < 0) || (closeStock !== null && closeStock < 0)) return StockoutStatus.NEGATIVE_STOCK_REVIEW;
  if (openStock === 0 && closeStock === 0) return StockoutStatus.ALL_DAY_STOCKOUT_CANDIDATE;
  if (openStock === 0 && closeStock !== null && closeStock > 0 && receiptHour !== null && receiptHour > cutoffAsHour(cutoffHour)) return StockoutStatus.LATE_RECEIPT_STOCKOUT;
  if (openStock !== null && openStock > 0 && closeStock === 0) return StockoutStatus.DEPLETION_REVIEW;
  return StockoutStatus.NONE;
}

export function runStage2(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  const counts = new Map<StockoutStatus, number>();
  for (const state of Object.values(states)) {
    state.daily = state.daily.map(record => {
      const stockoutStatus = classifyStockout(record.openStock, record.closeStock, record.receiptHour, policy.cutoffHour);
      counts.set(stockoutStatus, (counts.get(stockoutStatus) ?? 0) + 1);
      if (stockoutStatus === StockoutStatus.NEGATIVE_STOCK_REVIEW) {
        exceptions.push({
          id: `${state.definition.id}:2:NEGATIVE_STOCK_REVIEW:${record.date}`,
          ruleId: 'RULE-02-003', code: 'STOCK_ANCHOR_MISSING', stage: 2, skuId: state.definition.id, date: record.date,
          evidence: `openStock=${record.openStock}, closeStock=${record.closeStock}; giữ nguyên số âm.`,
          suggestedAction: 'Đối soát nguồn tồn trước khi dùng ngày này làm nền.', role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
        });
      }
      return { ...record, stockoutStatus };
    });
  }
  return createSnapshot(2, policy, states, {
    ALL_DAY_STOCKOUT_CANDIDATE: counts.get(StockoutStatus.ALL_DAY_STOCKOUT_CANDIDATE) ?? 0,
    LATE_RECEIPT_STOCKOUT: counts.get(StockoutStatus.LATE_RECEIPT_STOCKOUT) ?? 0,
    DEPLETION_REVIEW: counts.get(StockoutStatus.DEPLETION_REVIEW) ?? 0,
    NEGATIVE_STOCK_REVIEW: counts.get(StockoutStatus.NEGATIVE_STOCK_REVIEW) ?? 0,
  }, [
    `[RULE-02] cutoffHour=${policy.cutoffHour} lấy từ policy; tồn âm giữ nguyên; stock row không quyết định sales completeness.`,
  ], exceptions);
}
