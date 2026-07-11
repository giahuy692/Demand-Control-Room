import { Injectable } from '@angular/core';
import { buildCatalog, generateDailyRecords, SimulationDataset } from './catalog';
import { FORECAST_HORIZON, fitBaseForecast, lockedSeriesAll } from './forecast-models';
import { applyPromoFactor, calculateFreeStock, calculateTrend, classifyXyz, isStockout, mean, median, meetsSeasonRepeatThreshold, safetyStock, stripStandingPromoCodes } from './math';
import { AbcClass, BalanceStatus, Classification, CycleRecord, DailyRecord, SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot, XyzClass } from './models';
import { CAPITAL_PRIORITIES, DEFAULT_POLICY, SERVICE_LEVELS, Z_VALUES } from './policy';
import { buildPromoRegionSamples } from './promo-analysis';
import { demandRiskInputs } from './demand-risk';

function emptyClassification(): Classification {
  return {
    abc: 'N/A', abcStatus: 'not-rated', lockedCycles: 0, periodQuantity: 0,
    annualizationFactor: null, annualQuantity: null, annualValue: 0, valueShare: 0,
    cumulativeShare: 0, abcRank: null, xyz: 'D', n: 0, m: 0, adi: null,
    positiveMean: null, positiveStdev: null, cv: null, cv2: null,
  };
}

// Copy-on-write: mỗi chặng chỉ nhân bản vỏ state và thay đúng những trường nó ghi (daily, cycles, classification…).
// Dữ liệu không đổi được chia sẻ tham chiếu giữa các snapshot — không chặng nào được mutate object/mảng đã bàn giao.
function cloneStates(snapshot: StageSnapshot): Record<string, SkuPipelineState> {
  const states: Record<string, SkuPipelineState> = {};
  for (const [id, state] of Object.entries(snapshot.states)) states[id] = { ...state };
  return states;
}

function createSnapshot(stage: StageNumber, policy: SimulationPolicy, states: Record<string, SkuPipelineState>, summary: Record<string, string | number>, audit: string[]): StageSnapshot {
  Object.values(states).forEach(state => Object.freeze(state));
  return Object.freeze({ stage, completedAt: new Date().toISOString(), policyVersion: policy.version, states: Object.freeze(states), summary: Object.freeze(summary), audit: Object.freeze(audit) });
}

interface ReferenceItem { record: DailyRecord; distance: number; side: 'before' | 'after' }
interface ReferenceSelection {
  status: Exclude<BalanceStatus, null>;
  before: ReferenceItem[];
  after: ReferenceItem[];
  references: ReferenceItem[];
  searchRadius: number;
  reason: string;
}

function isObservedClean(record: DailyRecord): boolean {
  // Ngày không có bản ghi (hasRecord=false) không được dùng làm nền tham chiếu
  // cho ngày khác — chưa xác nhận nó thật sự "sạch" [nguyên tắc bất biến #2, C1 §3].
  return record.hasRecord && !record.promoCode && !record.isStockout && (record.baseSource === null || record.baseSource === 'clean');
}

function collectCleanSide(records: DailyRecord[], fromIndex: number, direction: -1 | 1, radius: number, stopAtPromoBoundary: boolean): ReferenceItem[] {
  const found: ReferenceItem[] = [];
  for (let distance = 1; distance <= radius; distance++) {
    const index = fromIndex + direction * distance;
    if (index < 0 || index >= records.length) break;
    const record = records[index];
    if (stopAtPromoBoundary && record.promoCode) break;
    if (isObservedClean(record)) found.push({ record, distance, side: direction < 0 ? 'before' : 'after' });
  }
  return found;
}

function selectReferences(records: DailyRecord[], beforeIndex: number, afterIndex: number, policy: SimulationPolicy, stopAtPromoBoundary = false): ReferenceSelection {
  let searchRadius = policy.referenceRadius;
  let before = collectCleanSide(records, beforeIndex, -1, searchRadius, stopAtPromoBoundary);
  let after = collectCleanSide(records, afterIndex, 1, searchRadius, stopAtPromoBoundary);
  if (Math.min(before.length, after.length) < 2 || before.length !== after.length) {
    searchRadius = policy.maxReferenceRadius;
    before = collectCleanSide(records, beforeIndex, -1, searchRadius, stopAtPromoBoundary);
    after = collectCleanSide(records, afterIndex, 1, searchRadius, stopAtPromoBoundary);
  }
  const k = Math.min(before.length, after.length, policy.maxBalancedPerSide);
  if (k >= 2) {
    const selectedBefore = before.slice(0, k);
    const selectedAfter = after.slice(0, k);
    return { status: 'balanced', before: selectedBefore, after: selectedAfter, references: [...selectedBefore, ...selectedAfter], searchRadius, reason: `Chọn k=${k} ngày gần nhất mỗi phía; cắt phía dư để giữ nền cân bằng.` };
  }
  const nearest = [...before, ...after].sort((a, b) => a.distance - b.distance || (a.side === 'before' ? -1 : 1)).slice(0, 14);
  if (nearest.length < policy.minimumReferences) {
    return { status: 'insufficient', before: before.slice(0, 7), after: after.slice(0, 7), references: nearest, searchRadius, reason: `Chỉ có ${nearest.length}/${policy.minimumReferences} ngày sạch trong bán kính tối đa.` };
  }
  return { status: 'temporary', before: nearest.filter(item => item.side === 'before'), after: nearest.filter(item => item.side === 'after'), references: nearest, searchRadius, reason: `Không tạo được 2+2; dùng tạm ${nearest.length} ngày sạch gần nhất và đưa vào kiểm tra.` };
}

function qualifySelection(selection: ReferenceSelection, recordCount: number, firstIndex: number, lastIndex: number, clusteredPromo = false): ReferenceSelection {
  if (selection.status !== 'temporary') return selection;
  const nearLowerBoundary = firstIndex < 24 && selection.before.length < 2;
  const nearUpperBoundary = recordCount - 1 - lastIndex < 24 && selection.after.length < 2;
  if (clusteredPromo && nearLowerBoundary) {
    const oneSided = selection.before.length ? selection.before : selection.after;
    if (oneSided.length < 14) return { ...selection, status: 'insufficient', references: oneSided, reason: `Cụm CTKM sát cận dưới chỉ có ${oneSided.length}/14 ngày sạch một phía.` };
    const references = oneSided.slice(0, 14);
    return { ...selection, status: 'fixed', before: selection.before.length ? references : [], after: selection.after.length ? references : [], references, reason: 'Cụm CTKM sát cận dưới: khóa 14 ngày sạch một phía — KHÔNG CÂN BẰNG CỐ ĐỊNH.' };
  }
  if (nearLowerBoundary !== nearUpperBoundary) return { ...selection, status: 'fixed', reason: `${selection.reason} Biên lịch sử đã đóng nên khóa KHÔNG CÂN BẰNG CỐ ĐỊNH.` };
  return selection;
}

function applyReferenceAudit(record: DailyRecord, selection: ReferenceSelection): DailyRecord {
  const referenceValues = selection.references.map(item => item.record.baseDemand ?? item.record.sales);
  return {
    ...record,
    referenceDates: selection.references.map(item => item.record.date),
    beforeReferenceDates: selection.before.map(item => item.record.date),
    afterReferenceDates: selection.after.map(item => item.record.date),
    referenceMedian: referenceValues.length >= 3 ? median(referenceValues) : null,
    balanceStatus: selection.status,
    selectionReason: selection.reason,
  };
}

function buildPromoRegions(records: DailyRecord[], policy: SimulationPolicy): { indexes: number[]; codes: string[]; clustered: boolean }[] {
  const runs: { indexes: number[]; codes: string[]; clustered: boolean }[] = [];
  for (let index = 0; index < records.length; index++) {
    if (!records[index].promoCode) continue;
    const code = records[index].promoCode!;
    const indexes = [index];
    while (index + 1 < records.length && records[index + 1].promoCode === code) indexes.push(++index);
    const previous = runs.at(-1);
    if (!previous) {
      runs.push({ indexes, codes: [code], clustered: false });
      continue;
    }
    const previousSelection = selectReferences(records, previous.indexes[0], previous.indexes.at(-1)!, policy, true);
    const currentSelection = selectReferences(records, indexes[0], indexes.at(-1)!, policy, true);
    const cannotBuildSeparateValidBaselines = previousSelection.status === 'insufficient' || currentSelection.status === 'insufficient';
    if (cannotBuildSeparateValidBaselines) {
      previous.indexes.push(...indexes);
      previous.codes = [...new Set([...previous.codes, code])];
      previous.clustered = true;
    } else runs.push({ indexes, codes: [code], clustered: false });
  }
  return runs;
}

function resetDailyRecord(record: DailyRecord): DailyRecord {
  return {
    ...record,
    isStockout: false, stockoutReason: null, baseDemand: null, baseSource: null,
    referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '',
  };
}

function createInitialState(definition: SkuPipelineState['definition'], daily: DailyRecord[]): SkuPipelineState {
  return {
    definition,
    daily,
    cycles: [], classification: emptyClassification(), serviceLevel: null, capitalPriority: 'Chưa xác định',
    seasonality: 'not-applicable', trend: 'insufficient', trendRates: [null, null], forecast: null,
    promoFactor: null, promoConfidence: 'none', finalForecast: [], freeStock: null, supplyMilestones: [], safetyStock: null, safetyStockAudit: null,
    orderPlan: null, budgetAllocation: null, releaseDecision: null, postAudit: null,
  };
}

function futureActualDemand(rows: readonly DailyRecord[], policy: SimulationPolicy): number[] {
  const future = rows.filter(row => row.date >= policy.runDate).sort((a, b) => a.date.localeCompare(b.date));
  const actual: number[] = [];
  for (let index = 0; index + policy.cycleLength <= future.length && actual.length < 6; index += policy.cycleLength) {
    actual.push(future.slice(index, index + policy.cycleLength).reduce((sum, row) => sum + row.sales, 0));
  }
  return actual;
}

function futurePromotions(rows: readonly DailyRecord[], policy: SimulationPolicy): SkuPipelineState['definition']['futurePromotions'] {
  const future = rows.filter(row => row.date >= policy.runDate).sort((a, b) => a.date.localeCompare(b.date)).slice(0, policy.cycleLength * 6);
  const counts = new Map<string, { cycleOffset: number; code: string; promoDays: number }>();
  future.forEach((row, index) => {
    if (!row.promoCode) return;
    const cycleOffset = Math.floor(index / policy.cycleLength) + 1;
    const key = `${cycleOffset}:${row.promoCode}`;
    const current = counts.get(key) ?? { cycleOffset, code: row.promoCode, promoDays: 0 };
    current.promoDays++;
    counts.set(key, current);
  });
  return [...counts.values()].map(item => ({ ...item, confirmed: true }));
}

function lockedValues(state: SkuPipelineState): number[] {
  return state.cycles.filter(cycle => cycle.locked).slice(-24).map(cycle => cycle.baseDemand);
}

function runStage1(policy: SimulationPolicy, dataset: SimulationDataset | null): StageSnapshot {
  const runDate = new Date(`${policy.runDate}T00:00:00Z`);
  const historyStart = new Date(Date.UTC(runDate.getUTCFullYear() - policy.historyYears, 0, 1));
  const historyEnd = new Date(runDate);
  historyEnd.setUTCDate(historyEnd.getUTCDate() - 1);
  const totalDays = Math.round((historyEnd.getTime() - historyStart.getTime()) / 86_400_000) + 1;
  const cycleCount = Math.floor(totalDays / policy.cycleLength);
  const fullCycleDays = cycleCount * policy.cycleLength;
  const historyEndIso = historyEnd.toISOString().slice(0, 10);
  const fullCycleStart = dateAfter(historyEndIso, -fullCycleDays + 1);
  const states: Record<string, SkuPipelineState> = {};
  if (dataset?.source === 'real') {
    for (const baseDefinition of dataset.catalog) {
      const allRows = [...(dataset.dailyBySku[baseDefinition.id] ?? [])]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({ ...row, promoCode: stripStandingPromoCodes(row.promoCode, policy.standingPromotionCodes) }));
      const daily = allRows
        .filter(row => row.date >= fullCycleStart && row.date <= historyEndIso)
        .slice(-fullCycleDays)
        .map(resetDailyRecord);
      const definition = {
        ...baseDefinition,
        cycles: Math.floor(daily.length / policy.cycleLength),
        futurePromotions: futurePromotions(allRows, policy),
        actualDemand: futureActualDemand(allRows, policy),
        actualEndingStock: allRows.filter(row => row.date >= policy.runDate).at(-1)?.closeStock ?? daily.at(-1)?.closeStock ?? 0,
      };
      states[definition.id] = createInitialState(definition, daily);
    }
  } else {
    for (const definition of buildCatalog()) {
      states[definition.id] = createInitialState(
        definition,
        generateDailyRecords(definition, policy.runDate, policy.cycleLength, cycleCount),
      );
    }
  }
  return createSnapshot(1, policy, states, {
    'Nguồn dữ liệu': dataset?.label ?? 'Dữ liệu giả',
    'SKU': Object.keys(states).length,
    'Bắt đầu lịch sử': historyStart.toISOString().slice(0, 10),
    'Kết thúc lịch sử': historyEnd.toISOString().slice(0, 10),
    'Tổng ngày D': totalDays,
    'Chu kỳ đầy đủ N': cycleCount,
    'Ngày dư r': totalDays - cycleCount * policy.cycleLength,
  }, [
    `Khóa ${totalDays} ngày lịch theo chính sách ${policy.version}.`,
    `Tạo ${cycleCount} chu kỳ cố định, không phụ thuộc số bản ghi của từng SKU.`,
    ...(dataset?.audit ?? ['Sinh dữ liệu giả nội bộ để mô phỏng.']),
  ]);
}

function runStage2(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let stockoutDays = 0;
  for (const state of Object.values(states)) {
    state.daily = state.daily.map(record => {
      const flagged = isStockout(record, policy.cutoffHour);
      if (!flagged) return record.isStockout || record.stockoutReason !== null ? { ...record, isStockout: false, stockoutReason: null } : record;
      stockoutDays++;
      const reason = record.openStock === 0 && record.closeStock === 0 ? 'empty-all-day' as const : 'late-receipt' as const;
      return { ...record, isStockout: true, stockoutReason: reason };
    });
  }
  return createSnapshot(2, policy, states, { 'Ngày stockout': stockoutDays, 'Điều kiện nghiệp vụ': 2 }, [`Áp đúng hai điều kiện stockout cho ${Object.keys(states).length} SKU.`, 'Không áp heuristic theo loại SKU hoặc tần suất bán.']);
}

function runStage3(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let lifted = 0;
  let insufficient = 0;
  for (const state of Object.values(states)) {
    const source = state.daily;
    state.daily = source.map((record, index) => {
      if (record.promoCode) return { ...record, baseDemand: null, baseSource: 'promo-defer' as const };
      if (record.hasRecord && !record.isStockout) return { ...record, baseDemand: record.sales, baseSource: 'clean' as const };
      if (!record.hasRecord) {
        // Ngày không có bản ghi nguồn: KHÔNG tự nâng nền ở Chặng 3 (không đủ căn
        // cứ để coi là stockout hay sạch) — để nguyên 'insufficient', giao cho
        // Chặng 5 lấp nền kỹ thuật với bán kính tìm rộng hơn.
        insufficient++;
        return { ...record, baseDemand: null, baseSource: 'insufficient' as const };
      }
      const selection = qualifySelection(selectReferences(source, index, index, policy), source.length, index, index);
      const audited = applyReferenceAudit(record, selection);
      if (selection.status === 'insufficient' || audited.referenceMedian === null) {
        insufficient++;
        return { ...audited, baseDemand: null, baseSource: 'insufficient' as const };
      }
      lifted++;
      return { ...audited, baseDemand: Math.max(record.sales, audited.referenceMedian), baseSource: 'stockout-lifted' as const };
    });
  }
  return createSnapshot(3, policy, states, { 'Ngày đã nâng nền': lifted, 'Ngày thiếu căn cứ': insufficient, 'k tối đa mỗi phía': policy.maxBalancedPerSide }, [`Mỗi ngày nâng nền dùng tối thiểu ${policy.minimumReferences} ngày sạch quan sát.`, 'Ngày CTKM được chuyển nguyên trạng sang Chặng 4.']);
}

function runStage4(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let normalized = 0;
  const promoCodes = new Set<string>();
  for (const state of Object.values(states)) {
    const source = state.daily;
    const processed = source.slice();
    for (const region of buildPromoRegions(source, policy)) {
      region.codes.forEach(code => promoCodes.add(code));
      const firstIndex = region.indexes[0];
      const lastIndex = region.indexes.at(-1)!;
      const selection = qualifySelection(selectReferences(source, firstIndex, lastIndex, policy, true), source.length, firstIndex, lastIndex, region.clustered);
      for (const index of region.indexes) {
        const audited = applyReferenceAudit(processed[index], selection);
        if (selection.status === 'insufficient' || audited.referenceMedian === null) {
          processed[index] = { ...audited, baseDemand: null, baseSource: 'insufficient' };
          continue;
        }
        normalized++;
        processed[index] = { ...audited, baseDemand: audited.referenceMedian, baseSource: 'promo-normalized' };
      }
    }
    state.daily = processed;
  }
  return createSnapshot(4, policy, states, { 'Ngày KM chuẩn hóa': normalized, 'Mã CTKM': promoCodes.size }, ['Dùng Median ngày sạch quanh vùng; không dùng max(sales, median).', 'Giữ nguyên sales và promoCode để Chặng 12 học hệ số.']);
}

function fillAndBuildCycles(records: DailyRecord[], cycleLength: number, minimumReferences: number, maxRadius: number): { daily: DailyRecord[]; cycles: CycleRecord[] } {
  const filled = records.slice();
  const fillPolicy: SimulationPolicy = { ...DEFAULT_POLICY, minimumReferences, maxReferenceRadius: maxRadius };
  for (let index = 0; index < filled.length; index++) {
    if (filled[index].baseDemand !== null) continue;
    const cycleStart = Math.floor(index / cycleLength) * cycleLength;
    const originalCycle = records.slice(cycleStart, cycleStart + cycleLength);
    if (originalCycle.length === cycleLength && originalCycle.every(row => row.baseDemand === null)) continue;
    const selection = selectReferences(filled, index, index, fillPolicy);
    const audited = applyReferenceAudit(filled[index], selection);
    if (selection.status !== 'insufficient' && audited.referenceMedian !== null) {
      filled[index] = { ...audited, baseDemand: audited.referenceMedian, baseSource: 'technical-fill', balanceStatus: selection.status };
    }
  }
  const cycles: CycleRecord[] = [];
  for (let start = 0; start + cycleLength <= filled.length; start += cycleLength) {
    let baseDemand = 0, unresolvedDays = 0, cleanDays = 0, stockoutLiftedDays = 0, promoNormalizedDays = 0, technicalFillDays = 0;
    for (let index = start; index < start + cycleLength; index++) {
      const row = filled[index];
      if (row.baseDemand === null) unresolvedDays++;
      else baseDemand += row.baseDemand;
      if (row.baseSource === 'clean') cleanDays++;
      else if (row.baseSource === 'stockout-lifted') stockoutLiftedDays++;
      else if (row.baseSource === 'promo-normalized') promoNormalizedDays++;
      else if (row.baseSource === 'technical-fill') technicalFillDays++;
    }
    const emptyCycle = unresolvedDays === cycleLength;
    const cycleIndex = cycles.length + 1;
    cycles.push({
      cycleIndex, dateStart: filled[start].date, dateEnd: filled[start + cycleLength - 1].date, days: cycleLength,
      baseDemand: unresolvedDays ? 0 : baseDemand,
      locked: !emptyCycle && unresolvedDays === 0, emptyCycle,
      cleanDays, stockoutLiftedDays, promoNormalizedDays, technicalFillDays,
      unresolvedDays, seasonRound: Math.floor((cycleIndex - 1) / 24) + 1, seasonPosition: ((cycleIndex - 1) % 24) + 1,
    });
  }
  return { daily: filled, cycles };
}

export function buildCycles(records: DailyRecord[], cycleLength: number, minimumReferences: number, maxRadius: number): CycleRecord[] {
  return fillAndBuildCycles(records, cycleLength, minimumReferences, maxRadius).cycles;
}

function runStage5(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const result = fillAndBuildCycles(state.daily, policy.cycleLength, policy.minimumReferences, policy.maxReferenceRadius);
    state.daily = result.daily;
    state.cycles = result.cycles;
  }
  const cycles = Object.values(states).flatMap(state => state.cycles);
  return createSnapshot(5, policy, states, { 'Chu kỳ đã khóa': cycles.filter(cycle => cycle.locked).length, 'Chu kỳ trống': cycles.filter(cycle => cycle.emptyCycle).length, 'Chu kỳ chưa đủ': cycles.filter(cycle => !cycle.locked && !cycle.emptyCycle).length }, ['Chỉ chu kỳ locked=true được bàn giao cho Chặng 6–11.', 'Số bán CTKM thô không được cộng vào sức mua chu kỳ.']);
}

function runStage6(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const ranked = Object.values(states).map(state => {
    const values = lockedValues(state);
    const eligible = values.length >= 6;
    const periodQuantity = values.reduce((sum, value) => sum + value, 0);
    const annualizationFactor = eligible ? (values.length >= 24 ? 1 : 24 / values.length) : null;
    const annualQuantity = annualizationFactor === null ? null : periodQuantity * annualizationFactor;
    const annualValue = annualQuantity === null ? 0 : annualQuantity * state.definition.price;
    return { state, values, eligible, periodQuantity, annualizationFactor, annualQuantity, annualValue };
  }).sort((a, b) => b.annualValue - a.annualValue);
  const total = ranked.filter(item => item.eligible).reduce((sum, item) => sum + item.annualValue, 0);
  let cumulative = 0;
  let rank = 0;
  for (const item of ranked) {
    const valueShare = item.eligible && total ? item.annualValue / total : 0;
    if (item.eligible) cumulative += item.annualValue;
    const cumulativeShare = item.eligible && total ? cumulative / total : 0;
    let abc: AbcClass = 'N/A';
    if (item.eligible) {
      rank++;
      abc = rank === 1 || cumulativeShare <= 0.8 ? 'A' : cumulativeShare >= 0.9 ? 'C' : 'B';
    }
    item.state.classification = {
      ...item.state.classification,
      abc,
      abcStatus: !item.eligible ? 'not-rated' : item.values.length < 24 ? 'annualized' : 'full',
      lockedCycles: item.values.length,
      periodQuantity: item.periodQuantity,
      annualizationFactor: item.annualizationFactor,
      annualQuantity: item.annualQuantity,
      annualValue: item.annualValue,
      valueShare,
      cumulativeShare,
      abcRank: item.eligible ? rank : null,
    };
  }
  return createSnapshot(6, policy, states, { 'Nhóm A': ranked.filter(item => item.state.classification.abc === 'A').length, 'Nhóm B': ranked.filter(item => item.state.classification.abc === 'B').length, 'Nhóm C': ranked.filter(item => item.state.classification.abc === 'C').length, 'Chưa xếp hạng': ranked.filter(item => item.state.classification.abc === 'N/A').length }, ['Điểm cắt C bắt đầu khi lũy kế đạt từ 90% trở lên.', 'Tính trên bảng xếp hạng riêng, không đổi thứ tự dữ liệu gốc.']);
}

function runStage7(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const result = classifyXyz(lockedValues(state));
    state.classification = { ...state.classification, ...result };
  }
  const counts = (xyz: XyzClass) => Object.values(states).filter(state => state.classification.xyz === xyz).length;
  return createSnapshot(7, policy, states, { 'Nhóm X': counts('X'), 'Nhóm Y': counts('Y'), 'Nhóm Z': counts('Z'), 'Nhóm D': counts('D') }, ['ADI dùng n/m; m là số chu kỳ có nhu cầu dương.', 'CV² dùng độ lệch chuẩn quần thể, mẫu số m.']);
}

function runStage8(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const { abc, xyz } = state.classification;
    if (xyz === 'D' || abc === 'N/A') {
      state.serviceLevel = null;
      state.capitalPriority = 'Chính sách riêng / cần duyệt';
      continue;
    }
    const cell = `${abc}${xyz}`;
    state.serviceLevel = SERVICE_LEVELS[cell] ?? null;
    state.capitalPriority = CAPITAL_PRIORITIES[cell] ?? 'Cần duyệt';
  }
  return createSnapshot(8, policy, states, { 'Ô ma trận đã khóa': Object.values(states).filter(state => state.serviceLevel !== null).length, 'Chính sách D/ngoại lệ': Object.values(states).filter(state => state.serviceLevel === null).length, 'Phiên chính sách': policy.version }, ['D không đi vào ma trận 3×3.', 'Mức phục vụ được khóa và chỉ truyền xuôi sang Chặng 15.']);
}

function runStage9(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y') {
      state.seasonality = 'not-applicable';
      continue;
    }
    const values = state.cycles.filter(cycle => cycle.locked).map(cycle => cycle.baseDemand);
    if (values.length < 48) {
      state.seasonality = 'insufficient-structure';
      continue;
    }
    const rounds = Array.from({ length: Math.floor(values.length / 24) }, (_, round) => values.slice(round * 24, round * 24 + 24));
    const repeatingPositions = Array.from({ length: 24 }, (_, position) => {
      const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
      const average = mean(ratios);
      const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
      const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
      return (average >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) || (average <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat));
    });
    state.seasonality = repeatingPositions.some(Boolean) ? 'confirmed' : 'no-clear-season';
  }
  return createSnapshot(9, policy, states, { 'Mùa vụ xác nhận': Object.values(states).filter(state => state.seasonality === 'confirmed').length, 'Không mùa vụ rõ': Object.values(states).filter(state => state.seasonality === 'no-clear-season').length, 'Thiếu cấu trúc': Object.values(states).filter(state => state.seasonality === 'insufficient-structure').length }, ['Chỉ nhóm Y được kiểm tra.', 'Cần đồng thời đạt hệ số vị trí và tỷ lệ lặp ≥ 67%.']);
}

function runStage10(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y' || state.seasonality === 'confirmed') continue;
    const result = calculateTrend(lockedValues(state));
    state.trend = result.trend;
    state.trendRates = result.rates;
  }
  return createSnapshot(10, policy, states, { 'Xu hướng tăng': Object.values(states).filter(state => state.trend === 'up').length, 'Xu hướng giảm': Object.values(states).filter(state => state.trend === 'down').length, 'Không xu hướng': Object.values(states).filter(state => state.trend === 'none').length }, ['12 chu kỳ cuối chia đúng 3 đoạn × 4.', 'Chỉ kết luận khi cả g₁ và g₂ cùng vượt ngưỡng ±5%.']);
}

function runStage11(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    state.forecast = fitBaseForecast(lockedSeriesAll(state), state.classification.xyz, state.seasonality, state.trend).result;
  }
  return createSnapshot(11, policy, states, { 'Mô hình đã khóa': Object.values(states).filter(state => state.forecast?.lockStatus === 'locked').length, 'Cần kiểm tra': Object.values(states).filter(state => state.forecast?.lockStatus !== 'locked').length, 'Tầm dự báo': `${FORECAST_HORIZON} chu kỳ` }, ['Chia TRAIN/TEST theo thời gian; tham số Grid Search chỉ trên TRAIN.', 'C11 chỉ đọc nhãn đã khóa; không tự phân loại lại SKU.']);
}

function runStage12(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const regions = buildPromoRegionSamples(state.daily);
    const factors = regions
      .filter(region => region.eligible)
      .map(region => region.factor!);
    const proposedFactor = factors.length ? median(factors) : null;
    state.promoFactor = proposedFactor;
    state.promoConfidence = factors.length >= 3 && proposedFactor! >= 1
      ? 'auto'
      : factors.length >= 2
        ? 'low'
        : factors.length === 1
          ? 'suggest-only'
          : regions.length
            ? 'blocked'
            : 'none';
  }
  return createSnapshot(12, policy, states, { 'Hệ số tự khóa': Object.values(states).filter(state => state.promoConfidence === 'auto').length, 'Cần duyệt': Object.values(states).filter(state => state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only').length, 'Bị chặn': Object.values(states).filter(state => state.promoConfidence === 'blocked').length, 'Không có mẫu': Object.values(states).filter(state => state.promoConfidence === 'none').length }, ['K = bán ghi nhận / nền tự nhiên theo vùng CTKM.', 'K < 1 được giữ làm bằng chứng và chuyển REVIEW, không tự nâng lên 1,00.']);
}

function runStage13(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const base = state.forecast?.baseForecast ?? [];
    state.finalForecast = base.map((forecast, index) => {
      const promotion = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
      const promoDays = Math.min(policy.cycleLength, promotion?.promoDays ?? 0);
      const factor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
      return applyPromoFactor(forecast, promoDays, policy.cycleLength, factor);
    });
  }
  const confirmedPlans = Object.values(states).reduce((sum, state) => sum + state.definition.futurePromotions.filter(item => item.confirmed).length, 0);
  return createSnapshot(13, policy, states, { 'Chu kỳ tương lai': FORECAST_HORIZON, 'Kế hoạch KM đã xác nhận': confirmedPlans, 'SKU cần duyệt K': Object.values(states).filter(state => state.promoFactor !== null && state.promoConfidence !== 'auto').length }, ['Chỉ phần nền tương ứng số ngày KM được nhân K.', 'Không sao chép số bán CTKM lịch sử sang tương lai.', 'Kế hoạch KM chưa xác nhận không được áp dụng.']);
}

function dateAfter(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function runStage14(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const onHand = state.daily.at(-1)?.closeStock ?? 0;
    const offsets = [...new Set([
      0,
      ...state.definition.inboundPlan.map(item => item.offsetDays),
      ...state.definition.commitments.map(item => item.offsetDays),
    ])].sort((a, b) => a - b);
    state.supplyMilestones = offsets.map(offset => {
      const inboundAtOffset = state.definition.inboundPlan.filter(item => item.offsetDays === offset);
      const commitmentsAtOffset = state.definition.commitments.filter(item => item.offsetDays === offset);
      const confirmedInbound = state.definition.inboundPlan
        .filter(item => item.confirmed && item.offsetDays <= offset)
        .reduce((sum, item) => sum + item.quantity, 0);
      const committed = state.definition.commitments
        .filter(item => item.offsetDays <= offset)
        .reduce((sum, item) => sum + item.quantity, 0);
      const labels = [
        ...inboundAtOffset.map(item => item.label),
        ...commitmentsAtOffset.map(item => item.label),
      ];
      return {
        date: dateAfter(policy.runDate, offset),
        label: offset === 0 ? 'Ngày chạy kế hoạch' : labels.join(' · ') || `Mốc +${offset} ngày`,
        onHand,
        confirmedInbound,
        committed,
        freeStock: calculateFreeStock(onHand, confirmedInbound, committed),
      };
    });
    state.freeStock = state.supplyMilestones.at(-1)?.freeStock ?? onHand;
  }
  return createSnapshot(14, policy, states, {
    'Mốc nguồn hàng': Object.values(states).reduce((sum, state) => sum + state.supplyMilestones.length, 0),
    'Lô chưa xác nhận bị loại': Object.values(states).reduce((sum, state) => sum + state.definition.inboundPlan.filter(item => !item.confirmed).length, 0),
    'SKU có vị thế tồn': Object.values(states).filter(state => state.supplyMilestones.length > 0).length,
  }, ['Sắp xếp mốc theo thời gian và tính hàng tự do tại từng mốc.', 'Chỉ cộng lô có ngày về kho đã xác nhận.', 'Hàng tự do = tồn hiện có + lô xác nhận lũy kế − cam kết lũy kế.']);
}

function runStage15(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const z = state.serviceLevel ? Z_VALUES[state.serviceLevel] : undefined;
    const risk = demandRiskInputs(state, policy);
    const hasDemandRisk = risk.sigmaDObservationCount >= 2;
    const hasLeadRisk = state.definition.leadTimeHistoryDays.length >= 2;
    if (!state.serviceLevel || z === undefined || !state.finalForecast.length || !hasDemandRisk || !hasLeadRisk) {
      state.safetyStock = null;
      const warnings = [
        !state.serviceLevel ? 'Thiếu mức phục vụ từ Chặng 8.' : '',
        state.serviceLevel && z === undefined ? 'Mức phục vụ chưa có hệ số Z được phê duyệt.' : '',
        !state.finalForecast.length ? 'Thiếu dự báo cuối từ Chặng 13.' : '',
        !hasDemandRisk ? 'Không đủ ít nhất 2 quan sát để tính σd.' : '',
        !hasLeadRisk ? 'Không đủ lịch sử lead time để tính LT̄ và σLT.' : '',
      ].filter(Boolean);
      state.safetyStockAudit = {
        z: z ?? 0, serviceLevel: state.serviceLevel ?? 0, dBar: risk.dBar, sigmaD: risk.sigmaD,
        sigmaDSource: risk.sigmaDSource, sigmaDObservationCount: risk.sigmaDObservationCount,
        ltBarDays: risk.ltBarDays, sigmaLtDays: risk.sigmaLtDays,
        ltBarCycles: risk.ltBarCycles, sigmaLtCycles: risk.sigmaLtCycles,
        formula: 'policy', warnings,
      };
      continue;
    }
    state.safetyStock = Math.ceil(safetyStock(z, risk.dBar, risk.sigmaD, risk.ltBarCycles, risk.sigmaLtCycles));
    const warnings: string[] = [];
    if (state.safetyStock > state.definition.maxStock) warnings.push(`SS ${state.safetyStock} vượt trần tồn ${state.definition.maxStock}; chuyển Chặng 18, không tự cắt.`);
    if (state.safetyStock > state.definition.warehouseCapacity) warnings.push(`SS ${state.safetyStock} vượt sức chứa ${state.definition.warehouseCapacity}; chuyển Chặng 18, không tự cắt.`);
    if (state.definition.shelfLifeDays) {
      const sellableBeforeExpiry = risk.dBar * state.definition.shelfLifeDays / policy.cycleLength;
      if (state.safetyStock > sellableBeforeExpiry) warnings.push(`SS vượt nhu cầu ước tính trong hạn dùng ${state.definition.shelfLifeDays} ngày; cần duyệt ngoại lệ.`);
    }
    if (risk.sigmaDSource === 'cycle-std') warnings.push('σd dùng dao động sức mua chu kỳ thay cho sai số backtest; độ tin cậy thấp.');
    state.safetyStockAudit = {
      z, serviceLevel: state.serviceLevel, dBar: risk.dBar, sigmaD: risk.sigmaD,
      sigmaDSource: risk.sigmaDSource, sigmaDObservationCount: risk.sigmaDObservationCount,
      ltBarDays: risk.ltBarDays, sigmaLtDays: risk.sigmaLtDays,
      ltBarCycles: risk.ltBarCycles, sigmaLtCycles: risk.sigmaLtCycles,
      formula: 'full', warnings,
    };
  }
  return createSnapshot(15, policy, states, { 'SKU đã tính SS': Object.values(states).filter(state => state.safetyStock !== null).length, 'Công thức': 'Đầy đủ: nhu cầu + lead time', 'Đơn vị LT': `chu kỳ ${policy.cycleLength} ngày` }, ['Ưu tiên σd từ sai số backtest Chặng 11; chỉ fallback sang độ lệch sức mua chu kỳ khi chưa đủ mẫu.', 'Lead time và độ lệch lead time đã quy đổi cùng đơn vị chu kỳ.', 'Không dùng công thức rút gọn khi σLT > 0.']);
}

function runStage16(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const coverageCycles = state.finalForecast.length;
    const demandCover = state.finalForecast.reduce((sum, value) => sum + value, 0);
    const freeStock = state.freeStock ?? 0;
    const warnings: string[] = [];
    if (!coverageCycles) warnings.push('Thiếu dự báo cuối từ Chặng 13.');
    if (state.safetyStock === null) warnings.push('Thiếu tồn kho an toàn được tính ở Chặng 15.');
    if (!state.definition.moq) warnings.push('Thiếu MOQ hoặc quy cách mua.');
    const rawQuantity = warnings.length ? 0 : Math.max(0, demandCover + state.safetyStock! - freeStock);
    const orderQuantity = rawQuantity > 0 && state.definition.moq > 0
      ? Math.ceil(rawQuantity / state.definition.moq) * state.definition.moq
      : 0;
    state.orderPlan = {
      coverageCycles, demandCover, freeStock, rawQuantity, orderQuantity,
      moq: state.definition.moq, moqSurplus: orderQuantity - rawQuantity, warnings,
    };
  }
  return createSnapshot(16, policy, states, {
    'Tổng số cần trước làm tròn': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.rawQuantity ?? 0), 0)),
    'Tổng số đặt sau MOQ': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.orderQuantity ?? 0), 0)),
    'Dòng thiếu điều kiện': Object.values(states).filter(state => state.orderPlan?.warnings.length).length,
  }, ['Vùng bao phủ là toàn bộ chân trời dự báo cuối đã khóa ở Chặng 13.', 'Không xét ngân sách tại Chặng 16.', 'Phần dư MOQ được giữ riêng để Chặng 18 kiểm tra ngoại lệ.']);
}

const PRIORITY_RANK: Record<string, number> = {
  'Rất cao': 1, 'Cao': 2, 'Trung bình': 3, 'Trung bình thấp': 4, 'Thấp': 5, 'Rất thấp': 6,
};

function runStage17(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const candidates = Object.values(states).map(state => ({
    state,
    orderQuantity: state.orderPlan?.orderQuantity ?? 0,
    orderValue: (state.orderPlan?.orderQuantity ?? 0) * state.definition.purchasePrice,
    priorityRank: PRIORITY_RANK[state.capitalPriority] ?? null,
  }));
  const totalValue = candidates.reduce((sum, item) => sum + item.orderValue, 0);
  let remaining = policy.periodBudget;
  const sorted = [...candidates].sort((a, b) => (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity)
    || b.orderValue - a.orderValue || a.state.definition.id.localeCompare(b.state.definition.id));
  for (const item of sorted) {
    const { state, orderQuantity, orderValue, priorityRank } = item;
    let fundedQuantity = 0;
    let reason = 'Không có số đặt cần cấp vốn.';
    if (orderQuantity > 0 && priorityRank === null) {
      reason = 'Chưa có ưu tiên vốn được khóa ở Chặng 8; không tự cấp vốn.';
    } else if (orderQuantity > 0 && totalValue <= policy.periodBudget) {
      fundedQuantity = orderQuantity;
      reason = 'Ngân sách đủ; cấp toàn bộ dòng đủ điều kiện.';
    } else if (orderQuantity > 0) {
      const affordable = Math.floor(remaining / (state.definition.purchasePrice * state.definition.moq)) * state.definition.moq;
      fundedQuantity = Math.min(orderQuantity, affordable);
      reason = fundedQuantity === orderQuantity ? 'Được cấp đủ theo thứ tự ưu tiên.'
        : fundedQuantity > 0 ? 'Chỉ được cấp một phần theo bội số MOQ do hết ngân sách.'
        : 'Bị hoãn do ngân sách còn lại không đủ một MOQ.';
    }
    const fundedValue = fundedQuantity * state.definition.purchasePrice;
    remaining = Math.max(0, remaining - fundedValue);
    state.budgetAllocation = { orderValue, priorityRank, fundedQuantity, fundedValue, cutQuantity: orderQuantity - fundedQuantity, reason };
  }
  return createSnapshot(17, policy, states, {
    'Tổng giá trị đề xuất': totalValue,
    'Ngân sách kỳ': policy.periodBudget,
    'Ngân sách đã cấp': policy.periodBudget - remaining,
    'Dòng bị cắt/hoãn': Object.values(states).filter(state => (state.budgetAllocation?.cutQuantity ?? 0) > 0).length,
  }, ['Không sửa dự báo, tồn kho an toàn hoặc số đặt sau MOQ.', 'Cấp theo mức ưu tiên vốn đã khóa tại Chặng 8.', 'Mọi phần cấp đều giữ đúng bội số MOQ.']);
}

function runStage18(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const funded = state.budgetAllocation?.fundedQuantity ?? 0;
    const complete = !!state.definition.supplier && state.definition.purchasePrice > 0 && state.definition.moq > 0
      && state.definition.purchaseTermsComplete && state.definition.inboundPlan.some(item => item.confirmed);
    const reasons: string[] = [];
    if (!complete) reasons.push('Thiếu ETA xác nhận, MOQ, giá mua, nhà cung cấp hoặc điều kiện đơn mua.');
    if ((state.budgetAllocation?.cutQuantity ?? 0) > 0) reasons.push('Dòng bị cắt/hoãn do ngân sách.');
    if (state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only') reasons.push('Hệ số CTKM ở trạng thái REVIEW, chỉ được áp nếu người duyệt xác nhận.');
    if (state.definition.futurePromotions.some(item => item.confirmed) && (state.promoConfidence === 'blocked' || state.promoConfidence === 'none')) reasons.push('Kế hoạch CTKM có hiệu lực nhưng hệ số đang BLOCKED/MANUAL_ONLY; giữ dự báo nền và chờ xử lý.');
    if (state.safetyStockAudit?.warnings.length) reasons.push(...state.safetyStockAudit.warnings);
    let status: 'not-issued' | 'awaiting-info' | 'awaiting-approval' | 'issued' = 'issued';
    if (funded <= 0) status = 'not-issued';
    else if (!complete) status = 'awaiting-info';
    else if (reasons.length) status = 'awaiting-approval';
    state.releaseDecision = { status, releasedQuantity: status === 'issued' ? funded : 0, reasons };
  }
  return createSnapshot(18, policy, states, {
    'Dòng phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'issued').length,
    'Dòng chờ bổ sung': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-info').length,
    'Dòng chờ duyệt': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-approval').length,
    'Dòng không phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'not-issued').length,
  }, ['Chặng 18 không tính lại số đặt.', 'Dòng có ngoại lệ được giữ nguyên số trước duyệt và không tự phát hành.', 'Không có thao tác duyệt giả lập thay cho người có thẩm quyền.']);
}

function runStage19(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const actual = state.definition.actualDemand;
    const forecast = state.finalForecast.slice(0, actual.length);
    const actualDemand = actual.reduce((sum, value) => sum + value, 0);
    const absoluteError = actual.reduce((sum, value, index) => sum + Math.abs(value - (forecast[index] ?? 0)), 0);
    const forecastWape = actualDemand > 0 && forecast.length === actual.length ? absoluteError / actualDemand : null;
    const released = state.releaseDecision?.releasedQuantity ?? 0;
    const available = Math.max(0, state.freeStock ?? 0) + released;
    const stockoutUnits = Math.max(0, actualDemand - available);
    const delays = state.definition.actualReceiptDelayDays;
    const averageReceiptDelayDays = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
    const budgetVariance = (state.budgetAllocation?.fundedValue ?? 0) - state.definition.actualBudgetUsed;
    let primaryCause = 'Chưa đủ dấu hiệu để quy nguyên nhân; tiếp tục theo dõi.';
    let proposal = 'Giữ chính sách hiện tại và tiếp tục thu thập kết quả thực tế.';
    let proposalStatus: 'future-version' | 'monitor' = 'monitor';
    if (stockoutUnits > 0 && averageReceiptDelayDays > 0) {
      primaryCause = 'Thiếu hàng đi kèm hàng về trễ; ưu tiên kiểm tra Chặng 14.';
      proposal = 'Đề xuất kiểm chứng lại lead time theo nhà cung cấp ở phiên chính sách tương lai.';
      proposalStatus = 'future-version';
    } else if (stockoutUnits > 0 && (state.budgetAllocation?.cutQuantity ?? 0) > 0) {
      primaryCause = 'Thiếu hàng sau khi dòng bị cắt vốn tại Chặng 17.';
      proposal = 'Đề xuất kiểm chứng lại thứ tự ưu tiên ngân sách ở phiên tương lai.';
      proposalStatus = 'future-version';
    } else if (state.releaseDecision?.status === 'awaiting-approval') {
      primaryCause = 'Số đặt chưa phát hành vì ngoại lệ ở Chặng 18.';
      proposal = 'Đề xuất đo thời gian và kết quả duyệt trước khi thay đổi ngưỡng ngoại lệ.';
      proposalStatus = 'future-version';
    }
    state.postAudit = {
      forecastWape, actualDemand, stockoutUnits, endingStock: state.definition.actualEndingStock,
      averageReceiptDelayDays, budgetVariance, primaryCause, proposal, proposalStatus,
    };
  }
  return createSnapshot(19, policy, states, {
    'WAPE danh mục': (() => {
      const items = Object.values(states).map(state => state.postAudit).filter(Boolean);
      const actual = items.reduce((sum, item) => sum + item!.actualDemand, 0);
      const error = Object.values(states).reduce((sum, state) => {
        const demand = state.definition.actualDemand;
        return sum + demand.reduce((subtotal, value, index) => subtotal + Math.abs(value - (state.finalForecast[index] ?? 0)), 0);
      }, 0);
      return actual > 0 ? error / actual : 0;
    })(),
    'SKU phát sinh thiếu hàng': Object.values(states).filter(state => (state.postAudit?.stockoutUnits ?? 0) > 0).length,
    'Đề xuất cho phiên tương lai': Object.values(states).filter(state => state.postAudit?.proposalStatus === 'future-version').length,
  }, ['Giữ nguyên toàn bộ snapshot C1–C18; không hồi tố.', 'Tách nguyên nhân theo dữ liệu, nguồn hàng, tồn an toàn, MOQ, ngân sách và duyệt ngoại lệ.', 'Mọi thay đổi chỉ là đề xuất cho phiên bản tương lai.']);
}

@Injectable({ providedIn: 'root' })
export class SimulationEngine {
  private dataset: SimulationDataset | null = null;

  setDataset(dataset: SimulationDataset | null): void {
    this.dataset = dataset;
  }

  run(stage: StageNumber, previous: StageSnapshot | null, policy: SimulationPolicy): StageSnapshot {
    if (stage === 1) return runStage1(policy, this.dataset);
    if (!previous || previous.stage !== stage - 1) throw new Error(`Chặng ${stage} cần snapshot đã khóa của Chặng ${stage - 1}.`);
    switch (stage) {
      case 2: return runStage2(previous, policy);
      case 3: return runStage3(previous, policy);
      case 4: return runStage4(previous, policy);
      case 5: return runStage5(previous, policy);
      case 6: return runStage6(previous, policy);
      case 7: return runStage7(previous, policy);
      case 8: return runStage8(previous, policy);
      case 9: return runStage9(previous, policy);
      case 10: return runStage10(previous, policy);
      case 11: return runStage11(previous, policy);
      case 12: return runStage12(previous, policy);
      case 13: return runStage13(previous, policy);
      case 14: return runStage14(previous, policy);
      case 15: return runStage15(previous, policy);
      case 16: return runStage16(previous, policy);
      case 17: return runStage17(previous, policy);
      case 18: return runStage18(previous, policy);
      case 19: return runStage19(previous, policy);
    }
  }
}
