import { ForecastFit } from './forecast-models';
import {
  BudgetAllocationState,
  DailyRecord,
  OrderPlanState,
  ReleaseDecisionState,
  SimulationPolicy,
  SkuPipelineState,
  StageNumber,
  StageSnapshot,
} from './models';
import { STAGES } from './policy';
import {
  buildAbcBoard,
  buildFinalForecastAudit,
  buildForecastAudit,
  buildPolicyMatrix,
  buildPromoAudit,
  buildSafetyAudit,
  buildSeasonalityAudit,
  buildSupplyAudit,
  buildTrendAudit,
  buildXyzBoard,
} from './stage-insights';

export type TableCellValue = string | number | boolean | null;
export type StageExportRow = Record<string, TableCellValue>;

export interface StageTableExport {
  readonly stage: StageNumber;
  readonly title: string;
  readonly scope: string;
  readonly fileName: string;
  readonly columns: readonly string[];
  readonly rows: readonly StageExportRow[];
}

const DAILY_COLUMNS = [
  'sku', 'barcode', 'date', 'hasSalesRecord', 'salesObservationStatus', 'sales', 'openStock', 'closeStock',
  'receiptHour', 'promotionStatus', 'stockoutStatus', 'baseDemand', 'baseDemandSource',
  'isCleanObservedReference', 'technicalFillStatus', 'referenceDatesUsed', 'referenceEvidence', 'reason',
] as const;

const CYCLE_COLUMNS = [
  'sku', 'cycleIndex', 'dateStart', 'dateEnd', 'days', 'baseDemand', 'locked',
  'status', 'emptyCycle', 'cleanDays', 'stockoutLiftedDays', 'promoNormalizedDays',
  'technicalFillDays', 'unresolvedDays', 'sourceRecordDays', 'fallbackDays',
  'tier2Filled', 'reviewRequired',
] as const;

export function buildStageTableExport(
  snapshot: StageSnapshot | null,
  selectedSkuId: string,
  policy: SimulationPolicy,
): StageTableExport | null {
  if (!snapshot) return null;
  const stage = snapshot.stage;
  const state = snapshot.states[selectedSkuId] ?? Object.values(snapshot.states)[0] ?? null;
  const selectedScope = state ? `${state.definition.id} - ${state.definition.name}` : selectedSkuId;
  const title = `Chặng ${stage.toString().padStart(2, '0')} - ${STAGES[stage - 1].title}`;
  const base = {
    stage,
    title,
    fileName: buildStageTableFileName(stage, selectedSkuId, policy.runDate),
  };

  if (stage === 5) {
    return {
      ...base,
      scope: selectedScope,
      columns: DAILY_COLUMNS,
      rows: state ? state.daily.map(dailyRow) : [],
    };
  }

  switch ((stage > 5 ? stage - 1 : stage) as Exclude<StageNumber, 20>) {
    case 1:
    case 2:
    case 3:
    case 4:
      return {
        ...base,
        scope: selectedScope,
        columns: DAILY_COLUMNS,
        rows: state ? state.daily.map(dailyRow) : [],
      };
    case 5:
      return {
        ...base,
        scope: selectedScope,
        columns: CYCLE_COLUMNS,
        rows: state ? state.cycles.map(row => cycleRow(state.definition.id, row)) : [],
      };
    case 6:
      return {
        ...base,
        scope: 'Toàn danh mục',
        columns: ['rank', 'sku', 'name', 'lockedCycles', 'annualQuantity', 'annualValue', 'valueShare', 'cumulativeShare', 'abc', 'abcStatus'],
        rows: buildAbcBoard(snapshot.states).map(row => ({
          rank: row.rank, sku: row.id, name: row.name, lockedCycles: row.lockedCycles,
          annualQuantity: row.annualQuantity, annualValue: row.annualValue,
          valueShare: row.valueShare, cumulativeShare: row.cumulativeShare,
          abc: row.abc, abcStatus: row.abcStatus,
        })),
      };
    case 7:
      return {
        ...base,
        scope: 'Toàn danh mục',
        columns: ['sku', 'name', 'n', 'm', 'adi', 'positiveMean', 'positiveStdev', 'cv', 'cv2', 'rule', 'xyz'],
        rows: buildXyzRows(snapshot, policy),
      };
    case 8:
      return {
        ...base,
        scope: 'Toàn danh mục',
        columns: ['cell', 'abc', 'xyz', 'serviceLevel', 'capitalPriority', 'skuCount', 'hasSelectedSku'],
        rows: buildPolicyRows(snapshot, selectedSkuId, policy),
      };
    case 9:
      return state ? buildSeasonalityRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 10:
      return state ? buildTrendRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 11:
      return state ? buildForecastRows(base, selectedScope, buildForecastAudit(state)) : emptyExport(base, selectedScope);
    case 12:
      return state ? buildPromoRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 13:
      return state ? buildFinalForecastRows(base, selectedScope, state, policy) : emptyExport(base, selectedScope);
    case 14:
      return state ? buildSupplyRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 15:
      return state ? buildSafetyRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 16:
      return state ? buildOrderPlanRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 17:
      return state ? buildBudgetRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 18:
      return state ? buildReleaseRows(base, selectedScope, state) : emptyExport(base, selectedScope);
    case 19:
      return state ? buildPostAuditRows(base, selectedScope, state) : emptyExport(base, selectedScope);
  }
}

export function encodeStageTableCsv(exportData: StageTableExport): string {
  const metadataRows = [
    ['title', exportData.title],
    ['scope', exportData.scope],
    ['rows', String(exportData.rows.length)],
    [],
  ];
  const dataRows = [
    [...exportData.columns],
    ...exportData.rows.map(row => exportData.columns.map(column => stringifyCell(row[column]))),
  ];
  return [...metadataRows, ...dataRows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

function buildStageTableFileName(stage: StageNumber, selectedSkuId: string, runDate: string): string {
  const safeSku = sanitizeFilePart(selectedSkuId || 'all-sku');
  const safeDate = sanitizeFilePart(runDate || 'khong-ro-ngay');
  return `audit-insight-chang-${stage.toString().padStart(2, '0')}-${safeSku}-${safeDate}.csv`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'na';
}

function dailyRow(row: DailyRecord): StageExportRow {
  return {
    sku: row.sku, barcode: row.barcode, date: row.date,
    hasSalesRecord: row.hasSalesRecord, salesObservationStatus: row.salesObservationStatus, sales: row.sales,
    openStock: row.openStock, closeStock: row.closeStock, receiptHour: row.receiptHour,
    promotionStatus: row.promotionStatus, stockoutStatus: row.stockoutStatus,
    baseDemand: row.baseDemand, baseDemandSource: row.baseDemandSource,
    isCleanObservedReference: row.isCleanObservedReference, technicalFillStatus: row.technicalFillStatus,
    referenceDatesUsed: joinList(row.referenceDates), referenceEvidence: JSON.stringify(row.referenceEvidence), reason: row.selectionReason,
  };
}

function cycleRow(sku: string, row: SkuPipelineState['cycles'][number]): StageExportRow {
  return {
    sku, cycleIndex: row.cycleIndex, dateStart: row.dateStart, dateEnd: row.dateEnd,
    days: row.days, baseDemand: row.baseDemand, locked: row.locked, status: row.status,
    emptyCycle: row.emptyCycle, cleanDays: row.cleanDays,
    stockoutLiftedDays: row.stockoutLiftedDays, promoNormalizedDays: row.promoNormalizedDays,
    technicalFillDays: row.technicalFillDays, unresolvedDays: row.unresolvedDays,
    sourceRecordDays: row.sourceRecordDays, fallbackDays: row.fallbackDays, tier2Filled: row.tier2Filled,
    reviewRequired: row.reviewRequired,
  };
}

function buildXyzRows(snapshot: StageSnapshot, policy: SimulationPolicy): StageExportRow[] {
  return buildXyzBoard(snapshot.states, policy).map(row => ({
    sku: row.id, name: row.name, n: row.n, m: row.m, adi: row.adi,
    positiveMean: row.positiveMean, positiveStdev: row.positiveStdev,
    cv: row.cv, cv2: row.cv2, rule: row.rule, xyz: row.xyz,
  }));
}

function buildPolicyRows(snapshot: StageSnapshot, selectedSkuId: string, policy: SimulationPolicy): StageExportRow[] {
  const matrix = buildPolicyMatrix(snapshot.states, selectedSkuId, policy);
  const rows: StageExportRow[] = matrix.rows.flatMap(row => row.cells.map(cell => ({
    cell: cell.cell, abc: row.abc, xyz: cell.cell.slice(1), serviceLevel: cell.serviceLevel,
    capitalPriority: cell.capitalPriority, skuCount: cell.count, hasSelectedSku: cell.hasSelected,
  })));
  rows.push({
    cell: 'D/N-A', abc: 'D/N-A', xyz: 'ngoại lệ', serviceLevel: null,
    capitalPriority: 'Chính sách riêng / cần duyệt', skuCount: matrix.exceptions.count,
    hasSelectedSku: matrix.exceptions.hasSelected,
  });
  return rows;
}

function buildSeasonalityRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = buildSeasonalityAudit(state);
  if (!audit.rows.length) {
    return {
      ...base, scope,
      columns: ['sku', 'status', 'reason', 'roundCount'],
      rows: [{ sku: state.definition.id, status: audit.status, reason: audit.reason, roundCount: audit.roundCount }],
    };
  }
  const roundColumns = audit.roundMeans.flatMap((_, index) => [`round${index + 1}Value`, `round${index + 1}Ratio`]);
  return {
    ...base, scope,
    columns: ['sku', 'position', ...roundColumns, 'sp', 'highRepeat', 'lowRepeat', 'verdict'],
    rows: audit.rows.map(row => {
      const perRound = Object.fromEntries(row.perRound.flatMap((item, index) => [
        [`round${index + 1}Value`, item.value],
        [`round${index + 1}Ratio`, item.ratio],
      ]));
      return {
        sku: state.definition.id, position: row.position, ...perRound,
        sp: row.sp, highRepeat: row.highRepeat, lowRepeat: row.lowRepeat, verdict: row.verdict,
      };
    }),
  };
}

function buildTrendRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = buildTrendAudit(state);
  if (!audit.applicable) {
    return {
      ...base, scope,
      columns: ['sku', 'status', 'reason', 'g1', 'g2'],
      rows: [{ sku: state.definition.id, status: audit.status, reason: audit.reason, g1: audit.g1, g2: audit.g2 }],
    };
  }
  return {
    ...base, scope,
    columns: ['sku', 'segment', 'values', 'mean', 'g1', 'g2', 'status'],
    rows: audit.segments.map(segment => ({
      sku: state.definition.id, segment: segment.label, values: joinList(segment.values),
      mean: segment.mean, g1: audit.g1, g2: audit.g2, status: audit.status,
    })),
  };
}

function buildForecastRows(base: ExportBase, scope: string, fit: ForecastFit): StageTableExport {
  if (!fit.learning) {
    return {
      ...base, scope,
      columns: ['model', 'lockStatus', 'reason'],
      rows: [{ model: fit.result.model, lockStatus: fit.result.lockStatus, reason: fit.result.reason }],
    };
  }
  const learning = fit.learning;
  return {
    ...base, scope,
    columns: [
      'model', 'cycleIndex', 'phase', 'actual', 'level', 'trend', 'season', 'forecast', 'error',
      'trainSize', 'testSize', 'rmse', 'nrmse', 'wape', 'bias', 'lockStatus',
    ],
    rows: learning.rows.map(row => ({
      model: learning.model, cycleIndex: row.index, phase: row.phase, actual: row.actual,
      level: row.level, trend: row.trend, season: row.season, forecast: row.forecast,
      error: row.error, trainSize: learning.trainSize, testSize: learning.testSize,
      rmse: fit.result.rmse, nrmse: fit.result.nrmse, wape: fit.result.wape,
      bias: fit.result.bias, lockStatus: fit.result.lockStatus,
    })),
  };
}

function buildPromoRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = buildPromoAudit(state);
  return {
    ...base, scope,
    columns: ['sku', 'dateRange', 'days', 'promoCode', 'sales', 'base', 'k', 'rawMedian', 'factor', 'confidence', 'totalRegions', 'rejected'],
    rows: audit.rows.length ? audit.rows.map(row => ({
      sku: state.definition.id, dateRange: row.dateRange, days: row.days, promoCode: row.code,
      sales: row.sales, base: row.base, k: row.k, rawMedian: audit.rawMedian,
      factor: audit.factor, confidence: audit.confidence, totalRegions: audit.totalRegions, rejected: audit.rejected,
    })) : [{
      sku: state.definition.id, dateRange: null, days: 0, promoCode: null, sales: null,
      base: null, k: null, rawMedian: audit.rawMedian, factor: audit.factor,
      confidence: audit.confidence, totalRegions: audit.totalRegions, rejected: audit.rejected,
    }],
  };
}

function buildFinalForecastRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTableExport {
  const audit = buildFinalForecastAudit(state);
  return {
    ...base, scope,
    columns: ['sku', 'cycleOffset', 'baseForecast', 'promoDays', 'cycleLength', 'appliedFactor', 'finalForecast', 'confidence'],
    rows: audit.rows.map(row => ({
      sku: state.definition.id, cycleOffset: row.index, baseForecast: row.base,
      promoDays: row.promoDays, cycleLength: policy.cycleLength, appliedFactor: row.factor,
      finalForecast: row.final, confidence: audit.confidence,
    })),
  };
}

function buildSupplyRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = buildSupplyAudit(state);
  const excludedRows = audit.excludedLots.map(lot => ({
    sku: state.definition.id, section: 'excluded-lot', supplier: audit.supplier,
    date: null, label: lot.lotId, quantity: lot.quantity, reason: lot.reason,
    onHand: null, confirmedInbound: null, committed: null, freeStock: null,
  }));
  const milestoneRows = audit.milestones.map(row => ({
    sku: state.definition.id, section: 'milestone', supplier: audit.supplier,
    date: row.date, label: row.label, quantity: null, reason: null,
    onHand: row.onHand, confirmedInbound: row.confirmedInbound,
    committed: row.committed, freeStock: row.freeStock,
  }));
  return {
    ...base, scope,
    columns: ['sku', 'section', 'supplier', 'date', 'label', 'quantity', 'reason', 'onHand', 'confirmedInbound', 'committed', 'freeStock'],
    rows: [...excludedRows, ...milestoneRows],
  };
}

function buildSafetyRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = buildSafetyAudit(state);
  const metricRows: StageExportRow[] = [
    metricRow(state, 'applicable', audit.applicable),
    metricRow(state, 'reason', audit.reason),
    metricRow(state, 'method', audit.method),
    metricRow(state, 'sourceTier', audit.sourceTier),
    metricRow(state, 'serviceLevel', audit.serviceLevel),
    metricRow(state, 'z', audit.z),
    metricRow(state, 'dBar', audit.dBar),
    metricRow(state, 'sigmaD', audit.sigmaD),
    metricRow(state, 'sigmaDSource', audit.sigmaDSource),
    metricRow(state, 'sigmaDObservationCount', audit.sigmaDObservationCount),
    metricRow(state, 'ltBarCycles', audit.ltBarCycles),
    metricRow(state, 'sigmaLtCycles', audit.sigmaLtCycles),
    metricRow(state, 'demandTerm', audit.demandTerm),
    metricRow(state, 'leadTerm', audit.leadTerm),
    metricRow(state, 'safetyStock', audit.safetyStock),
    metricRow(state, 'protection', audit.protection),
    metricRow(state, 'unmetProtection', audit.unmetProtection),
    ...audit.warnings.map((warning, index) => metricRow(state, `warning${index + 1}`, warning)),
    ...audit.serviceLevelSearch.map(row => ({
      sku: state.definition.id, section: 'service-level-search',
      metric: `SL ${row.candidate}`, value: row.passed, note: joinList(row.failedConditions),
    })),
  ];
  return { ...base, scope, columns: ['sku', 'section', 'metric', 'value', 'note'], rows: metricRows };
}

function buildOrderPlanRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const plan = state.orderPlan;
  return {
    ...base, scope, columns: ['sku', 'section', 'metric', 'value', 'note'],
    rows: plan ? orderPlanMetricRows(state, plan) : [metricRow(state, 'status', 'Chưa có orderPlan')],
  };
}

function orderPlanMetricRows(state: Readonly<SkuPipelineState>, plan: OrderPlanState): StageExportRow[] {
  return [
    metricRow(state, 'coverageCycles', plan.coverageCycles),
    metricRow(state, 'coverageDays', plan.coverageDays),
    metricRow(state, 'demandCover', plan.demandCover),
    metricRow(state, 'freeStock', plan.freeStock),
    metricRow(state, 'rawQuantity', plan.rawQuantity),
    metricRow(state, 'moq', plan.moq),
    metricRow(state, 'orderQuantity', plan.orderQuantity),
    metricRow(state, 'cartonsOrdered', plan.cartonsOrdered),
    metricRow(state, 'moqSurplus', plan.moqSurplus),
    metricRow(state, 'shortageBeforeNewLot', plan.shortageBeforeNewLot),
    metricRow(state, 'daysToStockout', plan.daysToStockout),
    metricRow(state, 'consolidationStatus', plan.consolidationStatus),
    metricRow(state, 'expiryRisk', plan.expiryRisk),
    metricRow(state, 'capacityRisk', plan.capacityRisk),
    ...plan.warnings.map((warning, index) => metricRow(state, `warning${index + 1}`, warning)),
  ];
}

function buildBudgetRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const allocation = state.budgetAllocation;
  return {
    ...base, scope, columns: ['sku', 'section', 'metric', 'value', 'note'],
    rows: allocation ? budgetMetricRows(state, allocation) : [metricRow(state, 'status', 'Chưa có budgetAllocation')],
  };
}

function budgetMetricRows(state: Readonly<SkuPipelineState>, allocation: BudgetAllocationState): StageExportRow[] {
  return [
    metricRow(state, 'status', allocation.status),
    metricRow(state, 'basket', allocation.basket),
    metricRow(state, 'priorityRank', allocation.priorityRank),
    metricRow(state, 'orderValue', allocation.orderValue),
    metricRow(state, 'fundedQuantity', allocation.fundedQuantity),
    metricRow(state, 'fundedValue', allocation.fundedValue),
    metricRow(state, 'cutQuantity', allocation.cutQuantity),
    metricRow(state, 'minimumToAvoidShortage', allocation.minimumToAvoidShortage),
    metricRow(state, 'additionalForProtection', allocation.additionalForProtection),
    metricRow(state, 'atRiskQuantity', allocation.atRiskQuantity),
    metricRow(state, 'landedCostIsEstimate', allocation.landedCostIsEstimate),
    metricRow(state, 'reason', allocation.reason),
    metricRow(state, 'overBudgetProposal.shortfallValue', allocation.overBudgetProposal?.shortfallValue ?? null),
    metricRow(state, 'overBudgetProposal.requiredQuantity', allocation.overBudgetProposal?.requiredQuantity ?? null),
    metricRow(state, 'overBudgetProposal.stockoutDate', allocation.overBudgetProposal?.stockoutDate ?? null),
    metricRow(state, 'overBudgetProposal.impactIfNotFunded', allocation.overBudgetProposal?.impactIfNotFunded ?? null),
    metricRow(state, 'overBudgetProposal.impactIfFunded', allocation.overBudgetProposal?.impactIfFunded ?? null),
  ];
}

function buildReleaseRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const decision = state.releaseDecision;
  return {
    ...base, scope, columns: ['sku', 'section', 'metric', 'value', 'note'],
    rows: decision ? releaseMetricRows(state, decision) : [metricRow(state, 'status', 'Chưa có releaseDecision')],
  };
}

function releaseMetricRows(state: Readonly<SkuPipelineState>, decision: ReleaseDecisionState): StageExportRow[] {
  return [
    metricRow(state, 'status', decision.status),
    metricRow(state, 'quantityBeforeApproval', decision.quantityBeforeApproval),
    metricRow(state, 'quantityAfterApproval', decision.quantityAfterApproval),
    metricRow(state, 'releasedQuantity', decision.releasedQuantity),
    metricRow(state, 'purchaseOrderGroupKey', decision.purchaseOrderGroupKey),
    metricRow(state, 'duplicateReleaseBlocked', decision.duplicateReleaseBlocked),
    ...decision.reasons.map((reason, index) => metricRow(state, `reason${index + 1}`, reason)),
  ];
}

function buildPostAuditRows(base: ExportBase, scope: string, state: Readonly<SkuPipelineState>): StageTableExport {
  const audit = state.postAudit;
  return {
    ...base, scope, columns: ['sku', 'section', 'metric', 'value', 'note'],
    rows: audit ? [
      metricRow(state, 'forecastWape', audit.forecastWape),
      metricRow(state, 'baseForecastWape', audit.baseForecastWape),
      metricRow(state, 'baseForecastRmse', audit.baseForecastRmse),
      metricRow(state, 'baseForecastNrmse', audit.baseForecastNrmse),
      metricRow(state, 'baseForecastBias', audit.baseForecastBias),
      metricRow(state, 'finalForecastRmse', audit.finalForecastRmse),
      metricRow(state, 'finalForecastNrmse', audit.finalForecastNrmse),
      metricRow(state, 'finalForecastBias', audit.finalForecastBias),
      metricRow(state, 'actualDemand', audit.actualDemand),
      metricRow(state, 'stockoutUnits', audit.stockoutUnits),
      metricRow(state, 'endingStock', audit.endingStock),
      metricRow(state, 'averageReceiptDelayDays', audit.averageReceiptDelayDays),
      metricRow(state, 'leadTimeActualDays', audit.leadTimeActualDays),
      metricRow(state, 'receiptDelayDaysVsPlan', audit.receiptDelayDaysVsPlan),
      metricRow(state, 'budgetVariance', audit.budgetVariance),
      metricRow(state, 'moqSurplusResidual', audit.moqSurplusResidual),
      metricRow(state, 'budgetCutUnits', audit.budgetCutUnits),
      metricRow(state, 'manualReductionUnits', audit.manualReductionUnits),
      metricRow(state, 'primaryCause', audit.primaryCause),
      metricRow(state, 'contributingCauses', joinList(audit.contributingCauses)),
      metricRow(state, 'proposalStatus', audit.proposalStatus),
      metricRow(state, 'proposal', audit.proposal),
      ...audit.evidence.map((evidence, index) => metricRow(state, `evidence${index + 1}`, evidence)),
    ] : [metricRow(state, 'status', 'Chưa có postAudit')],
  };
}

function metricRow(state: Readonly<SkuPipelineState>, metric: string, value: TableCellValue, note: TableCellValue = null): StageExportRow {
  return { sku: state.definition.id, section: 'metric', metric, value, note };
}

function emptyExport(base: ExportBase, scope: string): StageTableExport {
  return { ...base, scope, columns: ['status'], rows: [{ status: 'Không có dữ liệu để xuất' }] };
}

function joinList(values: readonly (string | number)[]): string {
  return values.join(' | ');
}

function stringifyCell(value: TableCellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

type ExportBase = Pick<StageTableExport, 'stage' | 'title' | 'fileName'>;
