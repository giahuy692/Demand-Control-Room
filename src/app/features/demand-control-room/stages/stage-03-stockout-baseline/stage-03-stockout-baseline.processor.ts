import {
  BaseDemandSource,
  ExceptionTask,
  PromotionStatus,
  SalesObservationStatus,
  SimulationPolicy,
  StageSnapshot,
  StockoutStatus,
} from '../../domain/models';
import { applyReferenceAudit, cloneStates, createSnapshot, qualifySelection, selectReferences } from '../stage-support';

export function runStage3(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let lifted = 0;
  let insufficient = 0;
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const source = state.daily;
    state.daily = source.map((record, index) => {
      if (record.promotionStatus === PromotionStatus.PROMOTION) {
        return { ...record, baseDemand: null, baseDemandSource: BaseDemandSource.PROMOTION_UNRESOLVED, isCleanObservedReference: false };
      }
      if (record.stockoutStatus === StockoutStatus.NONE) {
        if (record.salesObservationStatus === SalesObservationStatus.SOURCE_DATA_GAP) {
          return { ...record, baseDemand: null, baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP, isCleanObservedReference: false };
        }
        const isConfirmedZero = record.salesObservationStatus === SalesObservationStatus.CONFIRMED_ZERO;
        return {
          ...record,
          baseDemand: record.sales,
          baseDemandSource: isConfirmedZero ? BaseDemandSource.CLEAN_OBSERVED_ZERO : BaseDemandSource.CLEAN_OBSERVED_SALE,
          isCleanObservedReference: true,
        };
      }
      const selection = qualifySelection(selectReferences(source, index, index, policy), source.length, index, index);
      const audited = applyReferenceAudit(record, selection);
      if (selection.status === 'insufficient' || audited.referenceMedian === null) {
        insufficient++;
        exceptions.push({
          id: `${state.definition.id}:3:BASELINE_NOT_IDENTIFIABLE:${record.date}`,
          ruleId: 'RULE-03-003', code: 'BASELINE_NOT_IDENTIFIABLE', stage: 3, skuId: state.definition.id, date: record.date,
          evidence: `Không đủ ${policy.minimumReferences} ngày CLEAN_OBSERVED_* trong bán kính tối đa ${policy.maxReferenceRadius}.`,
          suggestedAction: 'Giữ STOCKOUT_UNRESOLVED và bổ sung nguồn sạch.', role: 'MD/Thu mua', status: 'OPEN', decisionVersion: policy.version,
        });
        return { ...audited, baseDemand: null, baseDemandSource: BaseDemandSource.STOCKOUT_UNRESOLVED, isCleanObservedReference: false };
      }
      lifted++;
      return { ...audited, baseDemand: audited.referenceMedian, baseDemandSource: BaseDemandSource.STOCKOUT_BASELINE, isCleanObservedReference: false };
    });
  }
  return createSnapshot(3, policy, states, {
    'Ngày stockout có nền': lifted,
    'Ngày stockout chưa giải quyết': insufficient,
  }, [
    `[RULE-03] Chỉ xử lý ngày stockout không CTKM; baseline là median ngày sạch quan sát, không dùng max(sales, median).`,
  ], exceptions);
}
