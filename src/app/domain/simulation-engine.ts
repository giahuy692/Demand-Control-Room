import { Injectable } from '@angular/core';
import { buildCalendarScaffold } from './calendar-scaffold';
import { buildCatalog, generateDailyRecords, SimulationDataset } from './catalog';
import { FORECAST_HORIZON, fitBaseForecast } from './forecast-models';
import { applyPromoFactor, calculateAvailableStock, calculateBias, calendarWindowAbcMetrics, calculateFreeStock, calculateNrmse, calculateRmse, calculateTrend, calculateWape, classifyPromoRegionPolicy, classifyXyz, fixedCalendarWindow, isStockout, mean, median, meetsSeasonRepeatThreshold, requireObservedSales, stripStandingPromoCodes, trailingLockedRun } from './math';
import { AbcClass, BalanceStatus, Classification, CycleRecord, CycleStatus, DailyRecord, DSubtype, ExceptionResolutionOption, ExceptionResolutionType, ExceptionTask, LotReliability, SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot, XyzClass } from './models';
import { chooseSafetyStock } from './safety-stock';
import { applySupplierConsolidation, buildOrderPlan } from './order-plan';
import { allocateBudget } from './budget-allocation';
import { applyPurchaseOrderGrouping } from './purchase-orders';
import { CAPITAL_PRIORITIES, DEFAULT_POLICY, SERVICE_LEVELS } from './policy';
import { buildPromoRegionSamples } from './promo-analysis';
import { demandRiskInputs } from './demand-risk';

function emptyClassification(): Classification {
  return {
    abc: 'N/A', abcOfficial: false, approvalStatus: 'PROPOSED', abcStatus: 'not-rated', lockedCycles: 0, periodQuantity: 0,
    annualizationFactor: null, annualQuantity: null, annualValue: 0, valueShare: 0,
    cumulativeShare: 0, abcRank: null, xyz: null, classificationStatus: 'CLASSIFICATION_BLOCKED', classificationBlockReason: null,
    n: 0, m: 0, adi: null,
    positiveMean: null, positiveStdev: null, cv: null, cv2: null,
    dSubtype: null, seriesQualityRatio: null, classificationReason: '',
  };
}

// Copy-on-write: mỗi chặng chỉ nhân bản vỏ state và thay đúng những trường nó ghi (daily, cycles, classification…).
// Dữ liệu không đổi được chia sẻ tham chiếu giữa các snapshot — không chặng nào được mutate object/mảng đã bàn giao.
function cloneStates(snapshot: StageSnapshot): Record<string, SkuPipelineState> {
  const states: Record<string, SkuPipelineState> = {};
  for (const [id, state] of Object.entries(snapshot.states)) states[id] = { ...state };
  return states;
}

/**
 * 04 §14/DEC-W05 — Chặng 14–19 mặc định SIMULATION_ONLY khi ngân sách/MOQ/nhà cung cấp/ETA thật
 * chưa sẵn sàng ("KHÔNG ÁP DỤNG HIỆN TẠI"). Chỉ nhãn hóa đầu ra (summary + audit), KHÔNG đổi bất
 * kỳ phép tính nào — dữ liệu mô phỏng vẫn hữu ích để kiểm tra thuật toán, chỉ không được coi là
 * kết luận vận hành thật cho tới khi operationalDataStatus='CONFIRMED'.
 */
function operationalStatusNote(policy: SimulationPolicy, stage: StageNumber): { summary: Record<string, string | number>; audit: string[] } {
  const evaluationStatus = policy.operationalDataStatus === 'CONFIRMED' ? 'OPERATIONAL' : 'SIMULATION_ONLY';
  return {
    summary: { 'Trạng thái vận hành': evaluationStatus },
    audit: [`[Chặng ${stage}][04 §14/DEC-W05] operationalDataStatus=${policy.operationalDataStatus} → đầu ra là ${evaluationStatus}${evaluationStatus === 'SIMULATION_ONLY' ? ' — KHÔNG dùng để ra quyết định vận hành thật; ngân sách/MOQ/nhà cung cấp/ETA thật chưa sẵn sàng.' : '.'}`],
  };
}

function createSnapshot(stage: StageNumber, policy: SimulationPolicy, states: Record<string, SkuPipelineState>, summary: Record<string, string | number>, audit: string[], exceptions: ExceptionTask[] = []): StageSnapshot {
  Object.values(states).forEach(state => Object.freeze(state));
  return Object.freeze({ stage, completedAt: new Date().toISOString(), policyVersion: policy.version, states: Object.freeze(states), summary: Object.freeze(summary), audit: Object.freeze(audit), exceptions: Object.freeze(exceptions) });
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

/** RULE-03-001 — "Tìm ±7, mở ±14, tối đa ±24": dò tuần tự 3 mốc, dừng ngay khi cân bằng 2+2. */
export function selectReferences(records: DailyRecord[], beforeIndex: number, afterIndex: number, policy: SimulationPolicy, stopAtPromoBoundary = false): ReferenceSelection {
  const radii = [policy.referenceRadius, policy.referenceRadiusExtended, policy.maxReferenceRadius];
  let searchRadius = radii[0];
  let before = collectCleanSide(records, beforeIndex, -1, searchRadius, stopAtPromoBoundary);
  let after = collectCleanSide(records, afterIndex, 1, searchRadius, stopAtPromoBoundary);
  for (let tier = 1; tier < radii.length && (Math.min(before.length, after.length) < 2 || before.length !== after.length); tier++) {
    searchRadius = radii[tier];
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

export function qualifySelection(selection: ReferenceSelection, recordCount: number, firstIndex: number, lastIndex: number, clusteredPromo = false): ReferenceSelection {
  if (selection.status !== 'temporary') return selection;
  const nearLowerBoundary = firstIndex < 24 && selection.before.length < 2;
  const nearUpperBoundary = recordCount - 1 - lastIndex < 24 && selection.after.length < 2;
  if (clusteredPromo && nearLowerBoundary) {
    const oneSided = selection.before.length ? selection.before : selection.after;
    if (oneSided.length < 14) return { ...selection, status: 'insufficient', references: oneSided, reason: `Cụm CTKM sát cận dưới chỉ có ${oneSided.length}/14 ngày sạch một phía.` };
    const references = oneSided.slice(0, 14);
    return { ...selection, status: 'fixed', before: selection.before.length ? references : [], after: selection.after.length ? references : [], references, reason: 'Cụm CTKM sát cận dưới: khóa 14 ngày sạch một phía — KHÔNG CÂN BẰNG CỐ ĐỊNH.' };
  }
  // RULE-04-003 — gắn cờ BOUNDARY_REFERENCE riêng biệt khỏi UNBALANCED_FIXED do thiếu dữ liệu thường (RULE-03-002): đây là do CHẠM biên lịch sử, không phải do thiếu ngày sạch.
  if (nearLowerBoundary !== nearUpperBoundary) return { ...selection, status: 'fixed', reason: `${selection.reason} [BOUNDARY_REFERENCE] Biên lịch sử đã đóng nên khóa KHÔNG CÂN BẰNG CỐ ĐỊNH.` };
  return selection;
}

function applyReferenceAudit(record: DailyRecord, selection: ReferenceSelection): DailyRecord {
  // isObservedClean() (collectCleanSide) đã lọc chỉ giữ hasRecord=true nên sales không thể null ở đây.
  const referenceValues = selection.references.map(item => item.record.baseDemand ?? requireObservedSales(item.record));
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
    isStockout: false, stockoutReason: null, stockoutReviewRequired: false, baseDemand: null, baseSource: null,
    referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '',
  };
}

function createInitialState(definition: SkuPipelineState['definition'], daily: DailyRecord[], referenceOnlyDaily: DailyRecord[] = []): SkuPipelineState {
  return {
    definition,
    daily,
    referenceOnlyDaily,
    cycles: [], classification: emptyClassification(), serviceLevel: null, capitalPriority: 'Chưa xác định',
    seasonality: 'not-applicable', trend: 'insufficient', trendRates: [null, null], forecast: null,
    promoFactor: null, promoConfidence: 'none', finalForecast: [], finalForecastStatus: 'PASSTHROUGH_NO_FUTURE_PROMO', freeStock: null, supplyMilestones: [], safetyStock: null, safetyStockAudit: null,
    orderPlan: null, budgetAllocation: null, releaseDecision: null, postAudit: null,
    availableStockAudit: null, excludedLots: [], supplyStatus: { pendingVerification: false, reasons: [] },
  };
}

function futureActualDemand(rows: readonly DailyRecord[], policy: SimulationPolicy): number[] {
  const future = rows.filter(row => row.date >= policy.runDate).sort((a, b) => a.date.localeCompare(b.date));
  const actual: number[] = [];
  // GIỚI HẠN ĐÃ GHI NHẬN: vùng tương lai (dùng làm "thực tế" cho hậu kiểm Chặng 19) chưa
  // được tạo lịch liên tục (RULE-01-001/002) — nếu nguồn thật thưa ở đây, việc gộp theo
  // index mảng có thể lệch ngày. Hiện `row.sales` luôn là số cụ thể vì đây là dòng nguồn
  // thật chưa qua scaffold (ingest bắt buộc Sales); `?? 0` chỉ là chốt an toàn kiểu dữ liệu,
  // không phải quyết định null→0 nghiệp vụ. Cần xử lý cùng đợt với RULE-01-001/002 cho Chặng 19.
  for (let index = 0; index + policy.cycleLength <= future.length && actual.length < 6; index += policy.cycleLength) {
    actual.push(future.slice(index, index + policy.cycleLength).reduce((sum, row) => sum + (row.sales ?? 0), 0));
  }
  return actual;
}

/**
 * RULE-06-003 — chuỗi khóa dùng cho Chặng 10 (xu hướng, cần 12 chu kỳ cuối). Đã đổi sang
 * `trailingLockedRun` (dò ngược từ chu kỳ gần nhất theo lịch, dừng ở khoảng trống đầu tiên) thay
 * vì `cycles.filter(locked)` cũ (xóa khoảng trống rồi nối 2 đoạn xa nhau thành chuỗi liên tục giả).
 * Khi không có khoảng trống nào, kết quả giống hệt hành vi cũ.
 */
function lockedValues(state: SkuPipelineState): number[] {
  return trailingLockedRun(state.cycles).slice(-24).map(cycle => cycle.baseDemand);
}

/**
 * Chặng 9–11 dùng chung chuỗi chu kỳ đã khóa (`lockedValues`/`cycles.filter(locked)`) nhưng tới
 * trước bản này chỉ log tổng số "đã khóa", không tách theo chất lượng nguồn — bổ sung log tổng hợp
 * (không đổi bất kỳ phép tính nào) để phân biệt chuỗi học phần lớn quan sát thuần so với chuỗi dựa
 * nhiều vào lấp kỹ thuật/nguồn dự phòng mùa vụ, theo đúng 3 trạng thái LOCKED_* của RULE-05-005.
 */
function lockedCycleQualityBreakdown(states: Record<string, SkuPipelineState>): { observed: number; adjusted: number; fallback: number } {
  let observed = 0, adjusted = 0, fallback = 0;
  for (const state of Object.values(states)) {
    for (const cycle of state.cycles) {
      if (cycle.status === 'LOCKED_OBSERVED') observed++;
      else if (cycle.status === 'LOCKED_ADJUSTED') adjusted++;
      else if (cycle.status === 'LOCKED_FALLBACK') fallback++;
    }
  }
  return { observed, adjusted, fallback };
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
    // RULE-01-003/DEC-P01 (chưa duyệt chính thức) — vùng đọc tham chiếu trước ProcessingStartDate,
    // khởi điểm dùng chung bán kính tối đa hiện có (policy.maxReferenceRadius).
    const referenceReadStart = dateAfter(fullCycleStart, -policy.maxReferenceRadius);
    for (const baseDefinition of dataset.catalog) {
      const allRows = [...(dataset.dailyBySku[baseDefinition.id] ?? [])]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({ ...row, promoCode: stripStandingPromoCodes(row.promoCode, policy.standingPromotionCodes) }));
      // RULE-01-001 — tạo lịch liên tục cho cả khung xử lý lẫn vùng đọc tham chiếu; ngày
      // không có nguồn thật giữ hasRecord=false/sales=null, KHÔNG suy diễn bán=0 [DEC-006/007].
      const scaffolded = buildCalendarScaffold(baseDefinition.id, allRows, referenceReadStart, historyEndIso, iso => iso < fullCycleStart)
        .map(resetDailyRecord);
      // RULE-01-003 — vùng tham chiếu KHÔNG được đưa vào ABC/XYZ/chuỗi học: tách khỏi `daily`
      // ngay tại đây, không chỉ lọc muộn ở Chặng 6/7. Hiện CHƯA nối vào tìm kiếm tham chiếu
      // Chặng 3–5 (thuật toán đó đã khóa theo index của `daily`) — xem giới hạn đã ghi nhận.
      const referenceOnlyDaily = scaffolded.filter(row => row.isReferenceOnly);
      const daily = scaffolded.filter(row => !row.isReferenceOnly);
      const definition = {
        ...baseDefinition,
        cycles: Math.floor(daily.length / policy.cycleLength),
        // §9 LỆNH CODEX/DEC-008/009 — phiên HISTORICAL_VALIDATION KHÔNG được dựng kế hoạch CTKM tương lai
        // từ giao dịch thực tế quan sát sau runDate (khác `actualDemand` bên dưới — đó là hậu kiểm Chặng
        // 19, không nuôi ngược vào dự báo Chặng 13). Trước bản này, `futurePromotions()` đọc promoCode từ
        // các dòng thật sau runDate rồi coi là "kế hoạch đã xác nhận" — rò rỉ dữ liệu tương lai vào chính
        // dự báo đang được tạo ra. Luôn rỗng cho dữ liệu thật; dữ liệu giả (catalog.ts) không đổi vì chỉ
        // dùng để kiểm thử luồng CTKM, không mô phỏng hành vi HISTORICAL_VALIDATION thật.
        futurePromotions: [],
        actualDemand: futureActualDemand(allRows, policy),
        actualEndingStock: allRows.filter(row => row.date >= policy.runDate).at(-1)?.closeStock ?? daily.at(-1)?.closeStock ?? 0,
        portfolioMode: dataset.portfolioMode,
        extractIsTruncated: dataset.extractIsTruncated,
      };
      states[definition.id] = createInitialState(definition, daily, referenceOnlyDaily);
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
    `[RULE-01-002] Khóa ${totalDays} ngày lịch theo chính sách ${policy.version}.`,
    `[RULE-01-002] Tạo ${cycleCount} chu kỳ cố định, không phụ thuộc số bản ghi của từng SKU.`,
    ...(dataset?.source === 'real' ? [
      `[RULE-01-001] Đã tạo lịch liên tục cho dữ liệu thật — ngày không có nguồn giữ hasRecord=false/sales=null, không suy diễn bán=0.`,
      `[RULE-01-003][DEC-P01·ĐỀ XUẤT] Đã nạp vùng đọc tham chiếu ${policy.maxReferenceRadius} ngày trước khung xử lý (isReferenceOnly=true) — CHƯA nối vào tìm kiếm tham chiếu Chặng 3–5 trong bản này; loại hoàn toàn khỏi ABC/XYZ/chuỗi học.`,
      `[RULE-01-004][DEC-010] portfolioMode=${dataset.portfolioMode}, extractIsTruncated=${dataset.extractIsTruncated} — ABC ở Chặng 6 KHÔNG được khóa là chính thức khi tập dữ liệu là SELECTED_SKU_SIMULATION.`,
    ] : ['Sinh dữ liệu giả nội bộ để mô phỏng — không áp dụng RULE-01-001 (không mô phỏng khoảng trống nguồn).']),
  ]);
}

function runStage2(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let stockoutDays = 0;
  let blockedByStockStatus = 0;
  let negativeReviewDays = 0;
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    state.daily = state.daily.map(record => {
      // RULE-02-001 — không đủ căn cứ tính tồn (ANCHOR_MISSING/UNRESOLVED) thì không được tự đánh stockout.
      if (record.stockCalculationStatus === 'ANCHOR_MISSING' || record.stockCalculationStatus === 'UNRESOLVED') {
        blockedByStockStatus++;
        exceptions.push({
          id: `${state.definition.id}:2:STOCK_ANCHOR_MISSING:${record.date}`,
          ruleId: 'RULE-02-001', code: 'STOCK_ANCHOR_MISSING', stage: 2, skuId: state.definition.id, date: record.date,
          evidence: `stockCalculationStatus=${record.stockCalculationStatus} — không đủ căn cứ để đánh giá stockout tự động.`,
          suggestedAction: 'Bổ sung mốc tồn/đối soát nguồn.', role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
        });
        return record.isStockout || record.stockoutReason !== null ? { ...record, isStockout: false, stockoutReason: null, stockoutReviewRequired: false } : record;
      }
      const flagged = isStockout(record, policy.cutoffHour, record.stockCalculationStatus);
      // RULE-02-003 — "quyết định stockout phụ thuộc tồn âm": tồn âm là dữ liệu bất thường nên MỌI
      // kết luận Chặng 2 của ngày này (dù flagged=true hay false) đều không đáng tin đầy đủ, không
      // chỉ riêng trường hợp trùng khớp đúng hai điều kiện (===0) vốn không thể xảy ra khi số âm.
      const reviewRequired = record.stockCalculationStatus === 'NEGATIVE_REVIEW';
      if (reviewRequired) {
        negativeReviewDays++;
        exceptions.push({
          id: `${state.definition.id}:2:STOCK_ANCHOR_MISSING:${record.date}:negative`,
          ruleId: 'RULE-02-003', code: 'STOCK_ANCHOR_MISSING', stage: 2, skuId: state.definition.id, date: record.date,
          evidence: `Tồn âm (openStock=${record.openStock}, closeStock=${record.closeStock}) vẫn được giữ nguyên, không tự đổi thành 0.`,
          suggestedAction: 'Bổ sung mốc tồn/đối soát nguồn.', role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
        });
      }
      if (!flagged) return record.isStockout || record.stockoutReason !== null || record.stockoutReviewRequired !== reviewRequired ? { ...record, isStockout: false, stockoutReason: null, stockoutReviewRequired: reviewRequired } : record;
      stockoutDays++;
      const reason = record.openStock === 0 && record.closeStock === 0 ? 'empty-all-day' as const : 'late-receipt' as const;
      return { ...record, isStockout: true, stockoutReason: reason, stockoutReviewRequired: reviewRequired };
    });
  }
  return createSnapshot(2, policy, states, {
    'Ngày stockout': stockoutDays, 'Điều kiện nghiệp vụ': 2,
    'Ngày chặn do thiếu căn cứ tồn': blockedByStockStatus, 'Ngày tồn âm cần xem xét': negativeReviewDays,
  }, [
    `[RULE-02-001] Áp đúng hai điều kiện stockout cho ${Object.keys(states).length} SKU; không áp heuristic theo loại SKU hoặc tần suất bán.`,
    `[RULE-02-001] ${blockedByStockStatus} ngày bị chặn đánh stockout tự động vì stockCalculationStatus=ANCHOR_MISSING/UNRESOLVED.`,
    `[RULE-02-003] ${negativeReviewDays} ngày tồn âm vẫn được đánh giá bình thường nhưng gắn stockoutReviewRequired=true, giữ nguyên số âm — không tự đổi thành 0.`,
  ], exceptions);
}

/**
 * RULE-03-003 cấp 3 — cùng vị trí mùa vụ năm trước (dịch lùi đúng một "năm" theo lịch chu kỳ cố
 * định của phiên: 24 chu kỳ). Chỉ dùng khi cấp 1 (theo thời gian, cùng SKU) đã 'insufficient'.
 * Cấp 2 (cửa hàng tương đồng) không áp dụng — app hiện chỉ có một nơi bán duy nhất. Cấp 4/5 (SKU
 * tương tự đã duyệt / nền thủ công MD) cần phê duyệt con người trước khi dùng làm nguồn chính thức
 * [DEC-016] — kiến trúc hiện tại không có danh mục SKU tương tự đã duyệt hay UI nhập nền thủ công,
 * nên khi cấp 1 và cấp 3 đều thất bại, hệ thống dừng ở BASELINE_UNRESOLVED và tạo task ngoại lệ đề
 * nghị đúng hai lựa chọn còn lại, thay vì tự suy diễn một giá trị không có căn cứ.
 */
function seasonalFallbackSelection(source: DailyRecord[], index: number, policy: SimulationPolicy, stopAtPromoBoundary: boolean): ReferenceSelection | null {
  const yearOffset = 24 * policy.cycleLength;
  const shifted = index - yearOffset;
  if (shifted < 0 || shifted >= source.length) return null;
  const selection = qualifySelection(selectReferences(source, shifted, shifted, policy, stopAtPromoBoundary), source.length, shifted, shifted);
  if (selection.status === 'insufficient') return null;
  return { ...selection, reason: `[Cấp 3 · mùa vụ năm trước, lùi ${yearOffset} ngày] ${selection.reason}` };
}

function runStage3(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let lifted = 0;
  let insufficient = 0;
  let seasonalFallback = 0;
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const source = state.daily;
    state.daily = source.map((record, index) => {
      if (record.promoCode) return { ...record, baseDemand: null, baseSource: 'promo-defer' as const };
      if (record.hasRecord && !record.isStockout) return { ...record, baseDemand: requireObservedSales(record), baseSource: 'clean' as const };
      if (!record.hasRecord) {
        // Ngày không có bản ghi nguồn: KHÔNG tự nâng nền ở Chặng 3 (không đủ căn
        // cứ để coi là stockout hay sạch) — để nguyên 'insufficient', giao cho
        // Chặng 5 lấp nền kỹ thuật với bán kính tìm rộng hơn.
        insufficient++;
        return { ...record, baseDemand: null, baseSource: 'insufficient' as const };
      }
      let selection = qualifySelection(selectReferences(source, index, index, policy), source.length, index, index);
      if (selection.status === 'insufficient') {
        const fallback = seasonalFallbackSelection(source, index, policy, false);
        if (fallback) { selection = fallback; seasonalFallback++; }
      }
      const audited = applyReferenceAudit(record, selection);
      if (selection.status === 'insufficient' || audited.referenceMedian === null) {
        insufficient++;
        exceptions.push({
          id: `${state.definition.id}:3:BASELINE_NOT_IDENTIFIABLE:${record.date}`,
          ruleId: 'RULE-03-003', code: 'BASELINE_NOT_IDENTIFIABLE', stage: 3, skuId: state.definition.id, date: record.date,
          evidence: `Cấp 1 (theo thời gian) và cấp 3 (mùa vụ năm trước) đều không đủ ${policy.minimumReferences} ngày sạch tham chiếu.`,
          suggestedAction: 'Chọn SKU tương tự đã duyệt hoặc nhập nền thủ công MD (cấp 4/5 — cần phê duyệt trước khi dùng chính thức).',
          role: 'MD/Thu mua', status: 'OPEN', decisionVersion: policy.version,
        });
        return { ...audited, baseDemand: null, baseSource: 'insufficient' as const };
      }
      lifted++;
      return { ...audited, baseDemand: Math.max(requireObservedSales(record), audited.referenceMedian), baseSource: 'stockout-lifted' as const };
    });
  }
  return createSnapshot(3, policy, states, { 'Ngày đã nâng nền': lifted, 'Ngày thiếu căn cứ': insufficient, 'k tối đa mỗi phía': policy.maxBalancedPerSide, 'Dùng cấp mùa vụ năm trước': seasonalFallback }, [
    `[RULE-03-001] Mỗi ngày nâng nền dò tuần tự ±${policy.referenceRadius}/±${policy.referenceRadiusExtended}/±${policy.maxReferenceRadius}, tối thiểu ${policy.minimumReferences} ngày sạch quan sát.`,
    'Ngày CTKM được chuyển nguyên trạng sang Chặng 4.',
    `[RULE-03-003] ${seasonalFallback} ngày dùng cấp 3 (mùa vụ năm trước) sau khi cấp 1 không đủ căn cứ.`,
    `[RULE-03-003] ${exceptions.length} ngày còn BASELINE_UNRESOLVED sau khi hết cấp 1/3 — đã tạo task ngoại lệ đề nghị cấp 4/5 (cần phê duyệt).`,
  ], exceptions);
}

function runStage4(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let normalized = 0;
  let pendingReview = 0;
  let notIdentifiable = 0;
  const promoCodes = new Set<string>();
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const source = state.daily;
    const processed = source.slice();
    for (const region of buildPromoRegions(source, policy)) {
      region.codes.forEach(code => promoCodes.add(code));
      const firstIndex = region.indexes[0];
      const lastIndex = region.indexes.at(-1)!;
      // RULE-04-001 — CTKM chưa xác định loại KHÔNG được tự chuẩn hóa; chuyển hàng đợi phê duyệt.
      const classification = classifyPromoRegionPolicy(region.codes, policy.unknownReviewPromotionCodes, policy.clearancePromotionCodes);
      if (classification === 'UNKNOWN_REVIEW') {
        pendingReview += region.indexes.length;
        exceptions.push({
          id: `${state.definition.id}:4:PROMO_TYPE_UNKNOWN:${processed[firstIndex].date}`,
          ruleId: 'RULE-04-001', code: 'PROMO_TYPE_UNKNOWN', stage: 4, skuId: state.definition.id, date: processed[firstIndex].date,
          evidence: `Mã CTKM ${region.codes.join(', ')} nằm trong danh sách chờ phân loại (policy.unknownReviewPromotionCodes).`,
          suggestedAction: 'Phân loại CTKM.', role: 'Marketing/MD', status: 'OPEN', decisionVersion: policy.version,
        });
        continue; // Giữ nguyên baseSource='promo-defer' từ Chặng 3 — không tự quyết định nền.
      }
      const selection = qualifySelection(selectReferences(source, firstIndex, lastIndex, policy, true), source.length, firstIndex, lastIndex, region.clustered);
      // RULE-04-004 — CTKM gần như liên tục không tách được nền: gắn BASELINE_NOT_IDENTIFIABLE thay vì lặng lẽ dùng chung nhãn 'insufficient' với thiếu dữ liệu thường.
      if (selection.status === 'insufficient' && region.clustered) {
        notIdentifiable += region.indexes.length;
        exceptions.push({
          id: `${state.definition.id}:4:BASELINE_NOT_IDENTIFIABLE:${processed[firstIndex].date}`,
          ruleId: 'RULE-04-004', code: 'BASELINE_NOT_IDENTIFIABLE', stage: 4, skuId: state.definition.id, date: processed[firstIndex].date,
          evidence: `Cụm CTKM ${region.codes.join(', ')} gần như liên tục, không đủ ngày sạch đối chứng: ${selection.reason}`,
          suggestedAction: 'Chọn cửa hàng/SKU đối chứng hoặc nhập nền MD.', role: 'MD/Thu mua', status: 'OPEN', decisionVersion: policy.version,
        });
      }
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
  return createSnapshot(4, policy, states, {
    'Ngày KM chuẩn hóa': normalized, 'Mã CTKM': promoCodes.size,
    'Ngày chờ phân loại CTKM': pendingReview, 'Ngày không xác định được nền': notIdentifiable,
  }, [
    'Dùng Median ngày sạch quanh vùng; không dùng max(sales, median).',
    'Giữ nguyên sales và promoCode để Chặng 12 học hệ số.',
    `[RULE-04-001] ${pendingReview} ngày CTKM chưa xác định loại (UNKNOWN_REVIEW) bị chặn chuẩn hóa, chuyển hàng đợi phê duyệt.`,
    `[RULE-04-004] ${notIdentifiable} ngày thuộc cụm CTKM gần như liên tục không xác định được nền (BASELINE_NOT_IDENTIFIABLE).`,
  ], exceptions);
}

/** RULE-05-003 Tầng 2 — mức đại diện chu kỳ = median các ngày nền hợp lệ SẴN CÓ trong chính chu kỳ trước khi lấp (không lấy từ ngày vừa lấp). */
function tier2RepresentativeFill(cycleRows: DailyRecord[]): { filled: DailyRecord[]; used: boolean } {
  const validValues = cycleRows.filter(row => row.baseDemand !== null).map(row => row.baseDemand!);
  const validCount = validValues.length;
  // RULE-05-003 ngưỡng 12-14/8-11/1-7/0 (DEC-P03/P04/P05, ĐỀ XUẤT — cổng bật/tắt ở cấp gọi hàm).
  if (validCount < 8) return { filled: cycleRows, used: false }; // 1-7: không dùng chính chu kỳ làm nguồn đại diện duy nhất; 0: không lấp toàn bộ chu kỳ.
  if (validCount <= 11) {
    // 8-11: chỉ lấp khi dữ liệu trải ít nhất 2/3 đoạn đầu-giữa-cuối.
    const segmentSize = Math.ceil(cycleRows.length / 3);
    const segments = [cycleRows.slice(0, segmentSize), cycleRows.slice(segmentSize, segmentSize * 2), cycleRows.slice(segmentSize * 2)];
    const segmentsWithData = segments.filter(segment => segment.some(row => row.baseDemand !== null)).length;
    if (segmentsWithData < 2) return { filled: cycleRows, used: false };
  }
  // 12-14 hoặc 8-11 đạt độ trải: lấp các ngày còn thiếu bằng median (RULE-05-004 — không nhân 1 ngày cho cả chu kỳ).
  const representative = median(validValues);
  const filled = cycleRows.map(row => row.baseDemand !== null ? row : {
    ...row, baseDemand: representative, baseSource: 'technical-fill' as const,
    selectionReason: `[Tầng 2 · mức đại diện chu kỳ, ${validCount}/${cycleRows.length} ngày nền] Median(${validValues.map(v => v.toLocaleString('vi-VN')).join('; ')}) = ${representative.toLocaleString('vi-VN')}.`,
  });
  return { filled, used: true };
}

function fillAndBuildCycles(records: DailyRecord[], cycleLength: number, minimumReferences: number, maxRadius: number, enableTier2CycleFallback = false): { daily: DailyRecord[]; cycles: CycleRecord[] } {
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
  const tier2UsedByCycleStart = new Set<number>();
  if (enableTier2CycleFallback) {
    for (let start = 0; start + cycleLength <= filled.length; start += cycleLength) {
      const cycleRows = filled.slice(start, start + cycleLength);
      if (!cycleRows.some(row => row.baseDemand === null)) continue; // Đã đủ 15/15 từ Tầng 1, không cần Tầng 2.
      const { filled: cycleFilled, used } = tier2RepresentativeFill(cycleRows);
      if (used) {
        for (let index = start; index < start + cycleLength; index++) filled[index] = cycleFilled[index - start];
        tier2UsedByCycleStart.add(start);
      }
    }
  }
  const cycles: CycleRecord[] = [];
  for (let start = 0; start + cycleLength <= filled.length; start += cycleLength) {
    let baseDemand = 0, unresolvedDays = 0, cleanDays = 0, stockoutLiftedDays = 0, promoNormalizedDays = 0, technicalFillDays = 0, sourceRecordDays = 0, fallbackDays = 0;
    for (let index = start; index < start + cycleLength; index++) {
      const row = filled[index];
      if (row.baseDemand === null) unresolvedDays++;
      else baseDemand += row.baseDemand;
      if (row.hasRecord) sourceRecordDays++;
      if (row.selectionReason.includes('Cấp 3 · mùa vụ năm trước')) fallbackDays++;
      if (row.baseSource === 'clean') cleanDays++;
      else if (row.baseSource === 'stockout-lifted') stockoutLiftedDays++;
      else if (row.baseSource === 'promo-normalized') promoNormalizedDays++;
      else if (row.baseSource === 'technical-fill') technicalFillDays++;
    }
    const emptyCycle = unresolvedDays === cycleLength;
    const locked = !emptyCycle && unresolvedDays === 0;
    const tier2Filled = tier2UsedByCycleStart.has(start);
    const cycleIndex = cycles.length + 1;
    cycles.push({
      cycleIndex, dateStart: filled[start].date, dateEnd: filled[start + cycleLength - 1].date, days: cycleLength,
      baseDemand: unresolvedDays ? 0 : baseDemand,
      locked, emptyCycle,
      cleanDays, stockoutLiftedDays, promoNormalizedDays, technicalFillDays,
      unresolvedDays, sourceRecordDays, fallbackDays, tier2Filled,
      status: cycleStatus(sourceRecordDays, locked, emptyCycle, cleanDays, fallbackDays, tier2Filled, cycleLength),
      seasonRound: Math.floor((cycleIndex - 1) / 24) + 1, seasonPosition: ((cycleIndex - 1) % 24) + 1,
    });
  }
  return { daily: filled, cycles };
}

/**
 * RULE-05-005 — 8 trạng thái chu kỳ. OUTSIDE_ACTIVE_PERIOD/DATA_ERROR không có nguồn dữ liệu để
 * phát hiện trong kiến trúc hiện tại (không có ngày mở/ngưng bán SKU, không có cờ lỗi dữ liệu
 * riêng) nên KHÔNG BAO GIỜ được trả về ở đây — ghi nhận tường minh thay vì giả vờ có khả năng này.
 */
function cycleStatus(sourceRecordDays: number, locked: boolean, emptyCycle: boolean, cleanDays: number, fallbackDays: number, tier2Filled: boolean, cycleLength: number): CycleStatus {
  if (sourceRecordDays === 0) return 'NO_SOURCE_RECORD';
  if (locked) {
    if (fallbackDays > 0) return 'LOCKED_FALLBACK';
    if (cleanDays === cycleLength) return 'LOCKED_OBSERVED';
    return 'LOCKED_ADJUSTED';
  }
  if (emptyCycle) return 'BASELINE_UNRESOLVED';
  return 'PARTIAL_BASELINE';
}

export function buildCycles(records: DailyRecord[], cycleLength: number, minimumReferences: number, maxRadius: number, enableTier2CycleFallback = false): CycleRecord[] {
  return fillAndBuildCycles(records, cycleLength, minimumReferences, maxRadius, enableTier2CycleFallback).cycles;
}

/**
 * §4 LỆNH CODEX — catalog phương án xử lý ngoại lệ NGOÀI mô phỏng. `executableInSimulation` luôn `false`:
 * mô phỏng chỉ đề xuất, không bao giờ tự thực hiện bất kỳ phương án nào trong danh sách này.
 */
const RESOLUTION_CATALOG: Record<ExceptionResolutionType, ExceptionResolutionOption> = {
  RESTORE_DAILY_BASELINE: {
    type: 'RESTORE_DAILY_BASELINE', title: 'Phục hồi nền theo ngày sạch lân cận',
    description: 'Tìm ngày sạch quanh (các) ngày thiếu theo đúng quy tắc tham chiếu Chặng 3–5, rồi chạy lại Chặng 3–5. Ngày vừa lấp không được dùng làm tham chiếu cho ngày khác.',
    requiredInputs: ['Ngày sạch lân cận đủ điều kiện (theo quy tắc ±7/±14/±24)'],
    requiresApproval: false, responsibleRole: 'BA/Data', applicableTo: 'HISTORICAL_BASELINE', executableInSimulation: false,
  },
  REFERENCE_STORE: {
    type: 'REFERENCE_STORE', title: 'Dùng cửa hàng tham chiếu',
    description: 'Lấy cùng SKU tại cửa hàng khác làm nền tham chiếu.',
    requiredInputs: ['StoreCode tham chiếu', 'Bằng chứng cửa hàng tương đồng', 'Hệ số quy đổi'],
    requiresApproval: true, responsibleRole: 'MD/Thu mua', applicableTo: 'HISTORICAL_BASELINE', executableInSimulation: false,
  },
  SIMILAR_SKU: {
    type: 'SIMILAR_SKU', title: 'Dùng SKU tương tự đã duyệt',
    description: 'AI/hệ thống chỉ đề xuất ứng viên; con người phê duyệt SKU tham chiếu và hệ số quy đổi trước khi dùng — không tự áp dụng.',
    requiredInputs: ['SKU tham chiếu đã duyệt', 'Hệ số quy đổi'],
    requiresApproval: true, responsibleRole: 'MD/Thu mua', applicableTo: 'HISTORICAL_BASELINE', executableInSimulation: false,
  },
  MANUAL_HISTORICAL_BASELINE: {
    type: 'MANUAL_HISTORICAL_BASELINE', title: 'Nhập nền lịch sử thủ công (ngoại lệ)',
    description: 'Chỉ dùng cho trường hợp đặc biệt để phục hồi lịch sử; không đồng nhất với kế hoạch MD tương lai.',
    requiredInputs: ['Giá trị nền', 'Lý do', 'Người duyệt', 'Phiên bản quyết định'],
    requiresApproval: true, responsibleRole: 'MD', applicableTo: 'HISTORICAL_BASELINE', executableInSimulation: false,
  },
  MD_FUTURE_PLAN: {
    type: 'MD_FUTURE_PLAN', title: 'Kế hoạch MD cho dự báo tương lai',
    description: 'Chỉ dùng cho dự báo tương lai khi lịch sử không đủ để học; không được lấp ngược chu kỳ lịch sử.',
    requiredInputs: ['Kế hoạch MD đã duyệt cho chu kỳ tương lai'],
    requiresApproval: true, responsibleRole: 'MD', applicableTo: 'FUTURE_FORECAST', executableInSimulation: false,
  },
  KEEP_UNRESOLVED: {
    type: 'KEEP_UNRESOLVED', title: 'Giữ nguyên chưa giải quyết',
    description: 'Giữ baseDemand=null, chặn các chặng phụ thuộc; không gán D hay bất kỳ giá trị nào chỉ để pipeline tiếp tục chạy.',
    requiredInputs: [],
    requiresApproval: false, responsibleRole: 'BA/Data', applicableTo: 'HISTORICAL_BASELINE', executableInSimulation: false,
  },
};

/** §5 LỆNH CODEX — mapping CycleStatus (chưa khóa) → phương án xử lý áp dụng được, theo đúng thứ tự đề nghị. */
const CYCLE_RESOLUTION_MAP: Partial<Record<CycleStatus, ExceptionResolutionType[]>> = {
  PARTIAL_BASELINE: ['RESTORE_DAILY_BASELINE', 'REFERENCE_STORE', 'SIMILAR_SKU', 'MANUAL_HISTORICAL_BASELINE', 'KEEP_UNRESOLVED'],
  BASELINE_UNRESOLVED: ['RESTORE_DAILY_BASELINE', 'REFERENCE_STORE', 'SIMILAR_SKU', 'MANUAL_HISTORICAL_BASELINE', 'KEEP_UNRESOLVED'],
  // NO_SOURCE_RECORD — trước khi đề nghị phương án, phải kiểm tra trạng thái hoạt động cửa hàng/SKU (chưa có
  // nguồn StoreDayStatus trong dữ liệu hiện tại — xem evidence); RESTORE_DAILY_BASELINE không áp dụng vì
  // không có ngày sạch NÀO trong chính chu kỳ để lấy làm tham chiếu lân cận.
  NO_SOURCE_RECORD: ['REFERENCE_STORE', 'SIMILAR_SKU', 'MANUAL_HISTORICAL_BASELINE', 'KEEP_UNRESOLVED'],
  // DATA_ERROR — đối soát nguồn trước; không đề nghị fallback demand nào cho tới khi dữ liệu được sửa.
  DATA_ERROR: ['KEEP_UNRESOLVED'],
  // OUTSIDE_ACTIVE_PERIOD — không bù; loại hợp lệ khỏi lịch sử hoạt động, không phải "chưa giải quyết".
  OUTSIDE_ACTIVE_PERIOD: [],
};

const CYCLE_EXCEPTION_BLOCKING_STAGES: StageNumber[] = [6, 7, 9, 10, 11];

/** §5 LỆNH CODEX / RULE-05-006 — MỘT task gộp theo chu kỳ (không lặp theo từng ngày unresolved bên trong). */
function buildCycleException(skuId: string, cycle: CycleRecord, policy: SimulationPolicy): ExceptionTask {
  const resolutionTypes = CYCLE_RESOLUTION_MAP[cycle.status] ?? ['KEEP_UNRESOLVED'];
  const resolutionOptions = resolutionTypes.map(type => RESOLUTION_CATALOG[type]);
  const activePeriodNote = cycle.status === 'NO_SOURCE_RECORD' ? ' Kiểm tra trạng thái hoạt động cửa hàng/SKU trước khi chọn phương án (chưa có nguồn StoreDayStatus trong dữ liệu hiện tại).' : '';
  return {
    id: `${skuId}:5:CYCLE_EXCEPTION:${cycle.cycleIndex}`,
    ruleId: 'RULE-05-006', code: 'CYCLE_EXCEPTION', stage: 5, skuId, date: cycle.dateStart,
    evidence: `[${cycle.status}] CK${cycle.cycleIndex} (${cycle.dateStart} → ${cycle.dateEnd}): sourceRecordDays=${cycle.sourceRecordDays}, observedCleanDays=${cycle.cleanDays}, stockoutAdjustedDays=${cycle.stockoutLiftedDays}, promoAdjustedDays=${cycle.promoNormalizedDays}, technicalFillDays=${cycle.technicalFillDays}, fallbackDays=${cycle.fallbackDays}, unresolvedDays=${cycle.unresolvedDays}.${activePeriodNote}`,
    suggestedAction: resolutionOptions[0]?.title ?? 'Giữ nguyên chưa giải quyết — chặn các chặng phụ thuộc.',
    role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
    cycleIndexes: [cycle.cycleIndex], affectedDateFrom: cycle.dateStart, affectedDateTo: cycle.dateEnd,
    blockingStages: CYCLE_EXCEPTION_BLOCKING_STAGES, resolutionOptions, simulationOnly: true,
  };
}

function runStage5(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const result = fillAndBuildCycles(state.daily, policy.cycleLength, policy.minimumReferences, policy.maxReferenceRadius, policy.enableTier2CycleFallback);
    state.daily = result.daily;
    state.cycles = result.cycles;
    // §5 LỆNH CODEX / RULE-05-006 — MỘT task ngoại lệ GỘP theo chu kỳ cho mỗi CK không khóa (không tạo
    // nhiều dòng lặp theo từng ngày unresolved bên trong chu kỳ đó).
    for (const cycle of result.cycles) {
      if (!cycle.locked) exceptions.push(buildCycleException(state.definition.id, cycle, policy));
    }
  }
  const cycles = Object.values(states).flatMap(state => state.cycles);
  const countByStatus = (status: CycleStatus) => cycles.filter(cycle => cycle.status === status).length;
  return createSnapshot(5, policy, states, {
    'Chu kỳ đã khóa': cycles.filter(cycle => cycle.locked).length, 'Chu kỳ 0 ngày có nền': cycles.filter(cycle => cycle.emptyCycle).length, 'Chu kỳ thiếu một phần nền': cycles.filter(cycle => !cycle.locked && !cycle.emptyCycle).length,
    'NO_SOURCE_RECORD': countByStatus('NO_SOURCE_RECORD'), 'BASELINE_UNRESOLVED': countByStatus('BASELINE_UNRESOLVED'), 'PARTIAL_BASELINE': countByStatus('PARTIAL_BASELINE'), 'LOCKED_OBSERVED': countByStatus('LOCKED_OBSERVED'),
    'LOCKED_ADJUSTED': countByStatus('LOCKED_ADJUSTED'), 'LOCKED_FALLBACK': countByStatus('LOCKED_FALLBACK'),
    'Chu kỳ lấp Tầng 2': cycles.filter(cycle => cycle.tier2Filled).length,
    'Ngoại lệ cấp chu kỳ (RULE-05-006)': exceptions.length,
  }, [
    'Chỉ chu kỳ locked=true được bàn giao cho Chặng 6–11.', 'Số bán CTKM thô không được cộng vào sức mua chu kỳ.',
    `[RULE-05-001] NO_SOURCE_RECORD chỉ gán khi sourceRecordDays=0, không dùng unresolvedDays=15 để kết luận "trống".`,
    `[RULE-05-003][DEC-P03/P04/P05·ĐỀ XUẤT] Lấp Tầng 2 (mức đại diện chu kỳ) đang ${policy.enableTier2CycleFallback ? 'BẬT' : 'TẮT MẶC ĐỊNH — chưa phê duyệt chính thức'}.`,
    `[RULE-05-005] Đã gán đủ trạng thái chu kỳ; OUTSIDE_ACTIVE_PERIOD/DATA_ERROR không có nguồn dữ liệu để phát hiện nên không bao giờ xuất hiện — không giả vờ có khả năng này.`,
    `[RULE-05-006] ${exceptions.length} ngoại lệ cấp chu kỳ được tạo (1 dòng/CK không khóa, gộp mọi ngày unresolved bên trong) — MÔ PHỎNG CHỈ ĐỀ XUẤT phương án xử lý, CHƯA THỰC HIỆN.`,
  ], exceptions);
}

const ABC_WINDOW_SIZE = 24;
const ABC_MINIMUM_LOCKED_CYCLES = 6;

function runStage6(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  const ranked = Object.values(states).map(state => {
    // RULE-05-006/RULE-06-003 — cửa sổ CỐ ĐỊNH 24 vị trí chu kỳ gần nhất theo lịch (RULE-05-006, giữ
    // nguyên mọi vị trí kể cả chưa khóa để audit), nhưng năm hóa chỉ dùng đoạn chu kỳ khóa LIÊN TIẾP
    // trong cửa sổ đó (RULE-06-003 — "không đếm các chu kỳ khóa nằm rải rác ở hai phía của một khoảng
    // unresolved như một đoạn liên tiếp"), tối thiểu 6 CK khóa liên tiếp mới được năm hóa.
    // Chu kỳ CHƯA khóa không bao giờ được cộng vào periodQuantity (calendarWindowAbcMetrics tự loại).
    const metrics = calendarWindowAbcMetrics(state.cycles, ABC_WINDOW_SIZE, ABC_MINIMUM_LOCKED_CYCLES);
    const annualizationFactor = metrics.eligible ? ABC_WINDOW_SIZE / metrics.lockedCycleCount : null;
    const annualQuantity = annualizationFactor === null ? null : metrics.periodQuantity * annualizationFactor;
    const annualValue = annualQuantity === null ? 0 : annualQuantity * state.definition.price;
    if (!metrics.eligible) {
      exceptions.push({
        id: `${state.definition.id}:6:ABC_INPUT_BLOCKED`,
        ruleId: 'RULE-06-003', code: 'ABC_INPUT_BLOCKED', stage: 6, skuId: state.definition.id, date: null,
        evidence: `Cửa sổ ${ABC_WINDOW_SIZE} vị trí chu kỳ gần nhất theo lịch chỉ có ${metrics.lockedCycleCount}/${ABC_MINIMUM_LOCKED_CYCLES} chu kỳ khóa tối thiểu (đã xét ${metrics.window.length} vị trí) — NOT_RATED, không được năm hóa.`,
        suggestedAction: 'Rà soát nguyên nhân các chu kỳ chưa khóa trong cửa sổ 24 chu kỳ gần nhất (Chặng 3–5) trước khi coi SKU là chưa đủ dữ liệu ABC.',
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
    }
    return { state, metrics, eligible: metrics.eligible, periodQuantity: metrics.periodQuantity, annualizationFactor, annualQuantity, annualValue };
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
    // RULE-06-001/DEC-010 — ABC chỉ chính thức khi chạy toàn danh mục hoặc dùng snapshot đã duyệt.
    const abcOfficial = item.state.definition.portfolioMode === 'FULL_PORTFOLIO' || item.state.definition.portfolioMode === 'USE_APPROVED_SNAPSHOT';
    item.state.classification = {
      ...item.state.classification,
      abc,
      abcOfficial,
      approvalStatus: 'PROPOSED', // RULE-06-002 — hệ thống chỉ tự sinh PROPOSED; không có quy trình duyệt bền vững trong app này.
      abcStatus: !item.eligible ? 'not-rated' : item.metrics.fullCoverage ? 'full' : 'annualized',
      lockedCycles: item.metrics.lockedCycleCount,
      periodQuantity: item.periodQuantity,
      annualizationFactor: item.annualizationFactor,
      annualQuantity: item.annualQuantity,
      annualValue: item.annualValue,
      valueShare,
      cumulativeShare,
      abcRank: item.eligible ? rank : null,
    };
  }
  const officialCount = ranked.filter(item => item.state.classification.abcOfficial).length;
  const notRatedCount = ranked.filter(item => !item.eligible).length;
  const fullCoverageCount = ranked.filter(item => item.state.classification.abcStatus === 'full').length;
  const withGapsCount = ranked.filter(item => item.state.classification.abcStatus === 'annualized').length;
  return createSnapshot(6, policy, states, {
    'Nhóm A': ranked.filter(item => item.state.classification.abc === 'A').length, 'Nhóm B': ranked.filter(item => item.state.classification.abc === 'B').length,
    'Nhóm C': ranked.filter(item => item.state.classification.abc === 'C').length, 'Chưa xếp hạng': ranked.filter(item => item.state.classification.abc === 'N/A').length,
    'SKU ABC chính thức': officialCount, 'SKU chỉ xếp hạng mô phỏng': ranked.length - officialCount,
    'FULL_COVERAGE (24/24)': fullCoverageCount, 'ANNUALIZED_WITH_GAPS': withGapsCount, 'NOT_RATED (<6 CK khóa)': notRatedCount,
  }, [
    'Điểm cắt C bắt đầu khi lũy kế đạt từ 90% trở lên.', 'Tính trên bảng xếp hạng riêng, không đổi thứ tự dữ liệu gốc.',
    `[RULE-06-001][DEC-010] ${officialCount}/${ranked.length} SKU có ABC chính thức (portfolioMode=FULL_PORTFOLIO/USE_APPROVED_SNAPSHOT); còn lại chỉ là xếp hạng trong tập mô phỏng hiện tại (SELECTED_SKU_SIMULATION), KHÔNG được dùng làm kết luận ABC vận hành thật.`,
    `[RULE-06-002] Mọi ABC ở đây đều approvalStatus='PROPOSED' — công cụ mô phỏng một lượt chạy này không có quy trình phê duyệt/lưu vết bền vững để tự chuyển EFFECTIVE.`,
    `[RULE-06-003][RULE-05-006] Cửa sổ ABC là ${ABC_WINDOW_SIZE} vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí (kể cả chưa khóa) để audit; đếm CK khóa bất kể khoảng khuyết, tối thiểu ${ABC_MINIMUM_LOCKED_CYCLES} CK khóa mới năm hóa. ${fullCoverageCount} SKU FULL_COVERAGE (24/24), ${withGapsCount} SKU ANNUALIZED_WITH_GAPS (đủ ngưỡng nhưng có khoảng khuyết), ${notRatedCount} SKU NOT_RATED (dưới ${ABC_MINIMUM_LOCKED_CYCLES} CK khóa, ABC_INPUT_BLOCKED).`,
  ], exceptions);
}

/**
 * RULE-07-001 — phân biệt lý do gộp trong nhóm D. D_MANUAL_PLAN/D_SIMILAR_SKU không có nguồn dữ
 * liệu trong app hiện tại nên không bao giờ được trả về. Hàm này chỉ được gọi SAU KHI Chặng 7
 * (fixedCalendarWindow) đã xác nhận cửa sổ đang xét không bị chặn (không còn chu kỳ
 * BASELINE_UNRESOLVED/NO_SOURCE_RECORD nào lẫn trong đó) — vì vậy không cần tự kiểm tra lại
 * unresolvedCycles ở đây; nhánh D_BASELINE_UNRESOLVED trước đây đã trở thành dead code, gỡ bỏ
 * (xem ghi chú DSubtype/ExceptionCode ở models.ts).
 */
function classifyDSubtype(state: SkuPipelineState): { dSubtype: DSubtype; reason: string } {
  if (state.cycles.length === 0) {
    return { dSubtype: 'D_NEW', reason: 'Chưa có chu kỳ nào trong khung xử lý — SKU mới hoàn toàn.' };
  }
  if (state.definition.extractIsTruncated) {
    return { dSubtype: 'D_EXTRACT_TRUNCATED', reason: `portfolioMode=${state.definition.portfolioMode}/extractIsTruncated=true — không loại trừ được khả năng tập dữ liệu bị cắt, chưa thể kết luận là chuỗi ngắn hạn thật.` };
  }
  return { dSubtype: 'D_SHORT_HISTORY', reason: `Chỉ ${state.cycles.length} chu kỳ khóa trong dữ liệu đã xác nhận đầy đủ (không bị cắt) — tương đương D_TRUE_SHORT_HISTORY của tài liệu.` };
}

function runStage7(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    // RULE-07-003 — cửa sổ CỐ ĐỊNH 24 vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí kể
    // cả chu kỳ không khóa (khác lockedValues cũ — trích chu kỳ khóa rồi nối lại). Có gap → chặn.
    const fixed = fixedCalendarWindow(state.cycles, 24);
    // §2.2 LỆNH CODEX — tỷ lệ chất lượng chuỗi PHẢI chia cho độ dài CỬA SỔ đang xét (lockedCyclesInWindow /
    // window.length), không chia cho toàn bộ lịch sử `state.cycles.length` (bản trước làm lệch tỷ lệ khi
    // lịch sử dài hơn nhiều so với cửa sổ 24 CK — ví dụ 20/24 khóa trong cửa sổ nhưng lịch sử có 75 CK sẽ ra
    // 20/75≈27% thay vì đúng 20/24≈83%). Không đổi chính sách chặn/không chặn của Chặng 7 — chỉ sửa bằng chứng.
    const seriesQualityRatio = fixed.window.length ? fixed.window.filter(cycle => cycle.locked).length / fixed.window.length : null;
    if (fixed.blocked) {
      const blockReason = fixed.blockingStatus!;
      const totalHistory = state.cycles.length;
      const usableRun = trailingLockedRun(state.cycles).length;
      const reason = `CLASSIFICATION_BLOCKED_${blockReason} — cửa sổ 24 vị trí gần nhất theo lịch có chu kỳ ${blockReason}, không được nối các chu kỳ khóa còn lại thành chuỗi liên tục giả.`
        + (totalHistory > usableRun + 1 ? ` Lịch sử dài hơn nhiều so với đoạn dùng được (INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY, ${totalHistory} chu kỳ toàn bộ, chỉ ${usableRun} chu kỳ liên tiếp gần nhất còn dùng được).` : '');
      state.classification = {
        ...state.classification, xyz: null, classificationStatus: 'CLASSIFICATION_BLOCKED', classificationBlockReason: blockReason,
        n: fixed.window.length, m: fixed.window.filter(cycle => cycle.locked && cycle.baseDemand > 0).length,
        adi: null, positiveMean: null, positiveStdev: null, cv: null, cv2: null,
        dSubtype: null, seriesQualityRatio, classificationReason: reason,
      };
      exceptions.push({
        id: `${state.definition.id}:7:CLASSIFICATION_BLOCKED`,
        ruleId: 'RULE-07-003', code: 'CLASSIFICATION_BLOCKED', stage: 7, skuId: state.definition.id, date: null,
        evidence: reason, suggestedAction: 'Rà soát nguyên nhân chu kỳ chưa khóa trong cửa sổ 24 chu kỳ gần nhất (Chặng 3–5) trước khi tin vào kết luận X/Y/Z/D.',
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
      continue;
    }
    const result = classifyXyz(fixed.window.map(cycle => cycle.baseDemand));
    if (result.xyz === 'D') {
      const { dSubtype, reason } = classifyDSubtype(state);
      state.classification = { ...state.classification, ...result, classificationStatus: 'CLASSIFIED', classificationBlockReason: null, dSubtype, seriesQualityRatio, classificationReason: reason };
    } else if (result.xyz === null) {
      // RULE-07-004 — cửa sổ liên tục và đủ dài (n≥6) nhưng không có chu kỳ dương nào.
      const reason = `NO_POSITIVE_DEMAND_REVIEW — ${result.n} chu kỳ liên tục đều khóa nhưng toàn bộ bằng 0; không gán D, không tính ADI bằng phép chia cho 0.`;
      state.classification = { ...state.classification, ...result, classificationStatus: 'NO_POSITIVE_DEMAND_REVIEW', classificationBlockReason: null, dSubtype: null, seriesQualityRatio, classificationReason: reason };
    } else {
      const reason = `${result.xyz}: ADI=${result.adi?.toFixed(2) ?? '—'}, CV²=${result.cv2?.toFixed(3) ?? '—'} trên ${result.n} chu kỳ khóa (${result.m} chu kỳ dương).`;
      state.classification = { ...state.classification, ...result, classificationStatus: 'CLASSIFIED', classificationBlockReason: null, dSubtype: null, seriesQualityRatio, classificationReason: reason };
    }
  }
  const counts = (xyz: XyzClass) => Object.values(states).filter(state => state.classification.xyz === xyz).length;
  const blockedCount = Object.values(states).filter(state => state.classification.classificationStatus === 'CLASSIFICATION_BLOCKED').length;
  const noPositiveDemandCount = Object.values(states).filter(state => state.classification.classificationStatus === 'NO_POSITIVE_DEMAND_REVIEW').length;
  return createSnapshot(7, policy, states, {
    'Nhóm X': counts('X'), 'Nhóm Y': counts('Y'), 'Nhóm Z': counts('Z'), 'Nhóm D': counts('D'),
    'Chặn phân loại (đứt quãng)': blockedCount, 'Không có nhu cầu dương': noPositiveDemandCount,
  }, [
    'ADI dùng n/m; m là số chu kỳ có nhu cầu dương.', 'CV² dùng độ lệch chuẩn quần thể, mẫu số m.',
    `[RULE-07-001] Nhóm D được tách theo dSubtype (D_NEW/D_SHORT_HISTORY/D_EXTRACT_TRUNCATED), không gộp mọi nguyên nhân.`,
    `[RULE-07-002] Đã ghi seriesQualityRatio (tỷ lệ chu kỳ khóa/tổng chu kỳ trong khung) và classificationReason cho mọi SKU.`,
    `[RULE-07-003] Cửa sổ XYZ là đúng 24 vị trí chu kỳ gần nhất theo lịch, giữ nguyên mọi vị trí; ${blockedCount} SKU bị CLASSIFICATION_BLOCKED vì cửa sổ có chu kỳ chưa khóa.`,
    `[RULE-07-004] ${noPositiveDemandCount} SKU có cửa sổ liên tục đủ dài nhưng toàn bộ bằng 0 → NO_POSITIVE_DEMAND_REVIEW, không gán D.`,
  ], exceptions);
}

function runStage8(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    const { abc, xyz } = state.classification;
    // Mở rộng gate: xyz===null gồm cả CLASSIFICATION_BLOCKED (RULE-07-003) và NO_POSITIVE_DEMAND_REVIEW
    // (RULE-07-004) — không SKU nào trong 2 nhóm này có X/Y/Z hợp lệ để tra ma trận 3×3.
    if (xyz === null || xyz === 'D' || abc === 'N/A') {
      // RULE-08-002 — thiếu phân loại dùng null + POLICY_UNRESOLVED, KHÔNG dùng serviceLevel=0 làm placeholder.
      state.serviceLevel = null;
      state.capitalPriority = 'Chính sách riêng / cần duyệt';
      exceptions.push({
        id: `${state.definition.id}:8:POLICY_UNRESOLVED`,
        ruleId: 'RULE-08-002', code: 'POLICY_UNRESOLVED', stage: 8, skuId: state.definition.id, date: null,
        evidence: `Không xếp được vào ma trận 3×3 (ABC=${abc}, XYZ/D=${xyz ?? state.classification.classificationStatus}).`,
        suggestedAction: 'Duyệt ma trận/chính sách trước chặng sau.', role: 'Chủ nghiệp vụ + Thu mua', status: 'OPEN', decisionVersion: policy.version,
      });
      continue;
    }
    const cell = `${abc}${xyz}`;
    state.serviceLevel = SERVICE_LEVELS[cell] ?? null;
    state.capitalPriority = CAPITAL_PRIORITIES[cell] ?? 'Cần duyệt';
    if (state.serviceLevel === null) {
      exceptions.push({
        id: `${state.definition.id}:8:POLICY_UNRESOLVED`,
        ruleId: 'RULE-08-002', code: 'POLICY_UNRESOLVED', stage: 8, skuId: state.definition.id, date: null,
        evidence: `Ô ma trận ${cell} chưa có mức phục vụ cấu hình.`,
        suggestedAction: 'Duyệt ma trận/chính sách trước chặng sau.', role: 'Chủ nghiệp vụ + Thu mua', status: 'OPEN', decisionVersion: policy.version,
      });
    }
  }
  return createSnapshot(8, policy, states, { 'Ô ma trận đã khóa': Object.values(states).filter(state => state.serviceLevel !== null).length, 'Chính sách D/ngoại lệ': Object.values(states).filter(state => state.serviceLevel === null).length, 'Phiên chính sách': policy.version }, [
    'D không đi vào ma trận 3×3.', 'Mức phục vụ được khóa và chỉ truyền xuôi sang Chặng 15.',
    `[RULE-08-001] Ma trận ABC×XYZ dùng phiên chính sách ${policy.version}. Ứng dụng mô phỏng một lượt chạy này không lưu lịch sử phiên bản qua nhiều lần chạy nên KHÔNG THỂ đảm bảo "không hồi tố" giữa các lần chạy khác nhau — ghi nhận tường minh, không giả vờ có cơ chế đó.`,
    `[RULE-08-002] ${exceptions.length} SKU ở trạng thái POLICY_UNRESOLVED (serviceLevel=null, không dùng 0 làm placeholder).`,
  ], exceptions);
}

function runStage9(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
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
    const repeatingPositions = Array.from({ length: 24 }, (_, position) => {
      const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
      const average = mean(ratios);
      const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
      const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
      return (average >= 1.15 && meetsSeasonRepeatThreshold(highRepeat)) || (average <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat));
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

function runStage10(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    if (state.classification.xyz !== 'Y' || state.seasonality === 'confirmed') continue;
    const result = calculateTrend(lockedValues(state));
    state.trend = result.trend;
    state.trendRates = result.rates;
  }
  const cycleQuality10 = lockedCycleQualityBreakdown(states);
  return createSnapshot(10, policy, states, {
    'Xu hướng tăng': Object.values(states).filter(state => state.trend === 'up').length,
    'Xu hướng giảm': Object.values(states).filter(state => state.trend === 'down').length,
    'Không xu hướng': Object.values(states).filter(state => state.trend === 'none').length,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality10.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality10.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality10.fallback,
  }, [
    '12 chu kỳ cuối chia đúng 3 đoạn × 4.', 'Chỉ kết luận khi cả g₁ và g₂ cùng vượt ngưỡng ±5%.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality10.observed} quan sát thuần, ${cycleQuality10.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality10.fallback} dùng nguồn dự phòng mùa vụ.`,
  ]);
}

function runStage11(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const exceptions: ExceptionTask[] = [];
  for (const state of Object.values(states)) {
    // RULE-11-001 — chuỗi học là đoạn chu kỳ khóa LIÊN TIẾP gần nhất theo lịch (trailingLockedRun),
    // không bỏ khoảng trống rồi nén chuỗi như lockedSeriesAll cũ (cycles.filter(locked), không giới
    // hạn độ dài vì Holt-Winters cần ≥2 vòng mùa vụ).
    const run = trailingLockedRun(state.cycles);
    const values = run.map(cycle => cycle.baseDemand);
    state.forecast = fitBaseForecast(values, state.classification.xyz, state.seasonality, state.trend).result;
    if (state.cycles.length > run.length) {
      // Có chu kỳ cũ hơn bị loại khỏi chuỗi học vì một khoảng đứt quãng — KHÔNG nén lại để dùng
      // chung; mô hình vẫn có thể chạy được trên phần đuôi liên tục còn lại (đúng ngưỡng riêng của
      // từng mô hình), chỉ ghi nhận để người vận hành biết lịch sử dùng được ngắn hơn thực tế.
      exceptions.push({
        id: `${state.definition.id}:11:FORECAST_INPUT_BLOCKED`,
        ruleId: 'RULE-11-001', code: 'FORECAST_INPUT_BLOCKED', stage: 11, skuId: state.definition.id, date: null,
        evidence: `Chuỗi học chỉ dùng ${run.length}/${state.cycles.length} chu kỳ (đoạn liên tiếp gần nhất theo lịch); phần còn lại bị loại vì một khoảng chu kỳ chưa khóa, không được nén lại để dùng chung.`,
        suggestedAction: 'Rà soát khoảng chu kỳ chưa khóa trước khi tin dự báo chỉ dựa trên lịch sử ngắn hơn thực tế.',
        role: 'BA/Data', status: 'OPEN', decisionVersion: policy.version,
      });
    }
  }
  const cycleQuality11 = lockedCycleQualityBreakdown(states);
  const forecastInputBlockedCount = exceptions.length;
  return createSnapshot(11, policy, states, {
    'Mô hình đã khóa': Object.values(states).filter(state => state.forecast?.lockStatus === 'locked').length,
    'Cần kiểm tra': Object.values(states).filter(state => state.forecast?.lockStatus !== 'locked').length,
    'Tầm dự báo': `${FORECAST_HORIZON} chu kỳ`,
    'CK khóa - quan sát thuần (LOCKED_OBSERVED)': cycleQuality11.observed,
    'CK khóa - đã điều chỉnh (LOCKED_ADJUSTED)': cycleQuality11.adjusted,
    'CK khóa - fallback mùa vụ (LOCKED_FALLBACK)': cycleQuality11.fallback,
    'Chuỗi học bị đứt quãng': forecastInputBlockedCount,
  }, [
    'Chia TRAIN/TEST theo thời gian; tham số Grid Search chỉ trên TRAIN.', 'C11 chỉ đọc nhãn đã khóa; không tự phân loại lại SKU.',
    `Chuỗi chu kỳ khóa toàn danh mục: ${cycleQuality11.observed} quan sát thuần, ${cycleQuality11.adjusted} đã điều chỉnh (đã lấp kỹ thuật), ${cycleQuality11.fallback} dùng nguồn dự phòng mùa vụ.`,
    `[RULE-11-001] ${forecastInputBlockedCount} SKU có chuỗi học ngắn hơn tổng lịch sử vì một khoảng chu kỳ chưa khóa (FORECAST_INPUT_BLOCKED) — không nén chuỗi, chỉ dùng đoạn liên tiếp gần nhất.`,
  ], exceptions);
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
  return createSnapshot(12, policy, states, { 'Hệ số tự khóa': Object.values(states).filter(state => state.promoConfidence === 'auto').length, 'Cần duyệt': Object.values(states).filter(state => state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only').length, 'Bị chặn': Object.values(states).filter(state => state.promoConfidence === 'blocked').length, 'Không có mẫu': Object.values(states).filter(state => state.promoConfidence === 'none').length }, [
    'K = bán ghi nhận / nền tự nhiên theo vùng CTKM.', 'K < 1 được giữ làm bằng chứng và chuyển REVIEW, không tự nâng lên 1,00.',
    '[RULE-12-001] Chỉ học K từ vùng CTKM đủ căn cứ, không bị stockout làm méo (buildPromoRegionSamples loại hasStockout/missingBase); CTKM thường trực không tạo vùng vì đã bị loại khỏi promoCode trước Chặng 2.',
  ]);
}

function runStage13(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  let kNotEvaluated = 0;
  for (const state of Object.values(states)) {
    const base = state.forecast?.baseForecast ?? [];
    const hasConfirmedFuturePromo = state.definition.futurePromotions.some(item => item.confirmed);
    // RULE-13-002 — nhánh áp K tương lai chỉ thật sự được đánh giá khi có kế hoạch CTKM tương lai
    // đã xác nhận VÀ K đã tự khóa (promoConfidence='auto'); các trường hợp khác (không có kế hoạch,
    // hoặc có kế hoạch nhưng K chưa đủ tin cậy) đều là NOT_EVALUATED — không được báo "đã khóa đầy đủ".
    if (hasConfirmedFuturePromo && state.promoConfidence !== 'auto') kNotEvaluated++;
    state.finalForecast = base.map((forecast, index) => {
      const promotion = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
      const promoDays = Math.min(policy.cycleLength, promotion?.promoDays ?? 0);
      const factor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
      return applyPromoFactor(forecast, promoDays, policy.cycleLength, factor);
    });
    state.finalForecastStatus = hasConfirmedFuturePromo && state.promoConfidence === 'auto' ? 'FUTURE_PROMO_APPLIED' : 'PASSTHROUGH_NO_FUTURE_PROMO';
  }
  const confirmedPlans = Object.values(states).reduce((sum, state) => sum + state.definition.futurePromotions.filter(item => item.confirmed).length, 0);
  const passthroughCount = Object.values(states).filter(state => state.finalForecastStatus === 'PASSTHROUGH_NO_FUTURE_PROMO').length;
  return createSnapshot(13, policy, states, {
    'Chu kỳ tương lai': FORECAST_HORIZON, 'Kế hoạch KM đã xác nhận': confirmedPlans, 'SKU cần duyệt K': Object.values(states).filter(state => state.promoFactor !== null && state.promoConfidence !== 'auto').length,
    'PASSTHROUGH_NO_FUTURE_PROMO': passthroughCount, 'Nhánh áp K NOT_EVALUATED': kNotEvaluated,
  }, [
    'Chỉ phần nền tương ứng số ngày KM được nhân K.', 'Không sao chép số bán CTKM lịch sử sang tương lai.', 'Kế hoạch KM chưa xác nhận không được áp dụng.',
    `[RULE-13-001][DEC-008/009] ${passthroughCount}/${Object.keys(states).length} SKU ở trạng thái PASSTHROUGH_NO_FUTURE_PROMO (finalForecast=baselineForecast) — đúng phiên HISTORICAL_VALIDATION hiện tại, không tự tạo kế hoạch tương lai từ CTKM lịch sử.`,
    `[RULE-13-002] ${kNotEvaluated} SKU có kế hoạch CTKM tương lai nhưng K chưa tự khóa — nhánh áp K của các SKU này ghi NOT_EVALUATED, không được báo "đã khóa đầy đủ".`,
  ]);
}

function dateAfter(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const EXCLUDED_LOT_REASON: Record<Exclude<LotReliability, 'shipped-confirmed' | 'supplier-confirmed'>, string> = {
  planned: 'Đang đàm phán/lên kế hoạch — chưa được nhà cung cấp xác nhận, không cộng vào hàng tự do.',
  overdue: 'Đã trễ so với ETA — giữ để kiểm toán nhưng không cộng vào hàng tự do.',
  cancelled: 'Đã bị hủy — loại khỏi hàng tự do.',
};

function runStage14(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const actualStock = state.daily.at(-1)?.closeStock ?? 0;
    const { availableStock, mismatch } = calculateAvailableStock(
      actualStock, state.definition.heldStock, state.definition.damagedStock, state.definition.blockedStock, state.definition.unsellableStock,
    );
    state.availableStockAudit = { actualStock, heldStock: state.definition.heldStock, damagedStock: state.definition.damagedStock, blockedStock: state.definition.blockedStock, unsellableStock: state.definition.unsellableStock, availableStock, mismatch };

    const lotIds = state.definition.inboundPlan.map(item => item.lotId);
    const duplicateLotIds = new Set(lotIds.filter((id, index) => lotIds.indexOf(id) !== index));
    const supplyReasons: string[] = [];
    if (mismatch) supplyReasons.push('Dữ liệu tồn không khớp: tồn thực tế nhỏ hơn tổng hàng giữ/hư hỏng/khóa/không bán được.');
    if (duplicateLotIds.size) supplyReasons.push(`Phát hiện ${duplicateLotIds.size} lotId trùng lặp trong kế hoạch nhập hàng — cần kiểm tra trước khi tính là nguồn độc lập.`);
    state.supplyStatus = { pendingVerification: supplyReasons.length > 0, reasons: supplyReasons };

    const excludedLots: SkuPipelineState['excludedLots'] = [];
    const countableInbound = state.definition.inboundPlan
      .filter(item => item.reliability === 'shipped-confirmed' || item.reliability === 'supplier-confirmed')
      .map(item => ({ ...item, remaining: Math.max(0, item.quantity - item.receivedQuantity - item.cancelledQuantity) }));
    for (const item of state.definition.inboundPlan) {
      if (item.reliability === 'shipped-confirmed' || item.reliability === 'supplier-confirmed') continue;
      excludedLots.push({ lotId: item.lotId, quantity: item.quantity, reliability: item.reliability, reason: EXCLUDED_LOT_REASON[item.reliability] });
    }
    state.excludedLots = excludedLots;

    const offsets = [...new Set([
      0,
      ...state.definition.inboundPlan.map(item => item.offsetDays),
      ...state.definition.commitments.map(item => item.offsetDays),
    ])].sort((a, b) => a - b);
    state.supplyMilestones = offsets.map(offset => {
      const inboundAtOffset = state.definition.inboundPlan.filter(item => item.offsetDays === offset);
      const commitmentsAtOffset = state.definition.commitments.filter(item => item.offsetDays === offset);
      const confirmedInbound = countableInbound
        .filter(item => item.offsetDays <= offset)
        .reduce((sum, item) => sum + item.remaining, 0);
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
        onHand: availableStock,
        confirmedInbound,
        committed,
        freeStock: calculateFreeStock(availableStock, confirmedInbound, committed),
      };
    });
    state.freeStock = state.supplyMilestones.at(-1)?.freeStock ?? availableStock;
  }
  const note14 = operationalStatusNote(policy, 14);
  return createSnapshot(14, policy, states, {
    'Mốc nguồn hàng': Object.values(states).reduce((sum, state) => sum + state.supplyMilestones.length, 0),
    'Lô bị loại': Object.values(states).reduce((sum, state) => sum + state.excludedLots.length, 0),
    'SKU chờ kiểm tra nguồn hàng': Object.values(states).filter(state => state.supplyStatus.pendingVerification).length,
    'SKU có vị thế tồn': Object.values(states).filter(state => state.supplyMilestones.length > 0).length,
    ...note14.summary,
  }, ['Tồn có thể sử dụng ngay đã trừ hàng giữ/hư hỏng/khóa/không bán được trước khi tính mốc nguồn hàng.', 'Chỉ cộng lô đã xác nhận (shipped-confirmed/supplier-confirmed); lô planned/overdue/cancelled bị loại kèm lý do.', 'Hàng tự do = tồn có thể sử dụng ngay + lô xác nhận lũy kế − cam kết lũy kế.', ...note14.audit]);
}

function runStage15(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
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

function runStage16(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    state.orderPlan = buildOrderPlan(state, policy);
  }
  applySupplierConsolidation(states);
  const note16 = operationalStatusNote(policy, 16);
  return createSnapshot(16, policy, states, {
    'Tổng số cần trước làm tròn': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.rawQuantity ?? 0), 0)),
    'Tổng số đặt sau MOQ': Math.round(Object.values(states).reduce((sum, state) => sum + (state.orderPlan?.orderQuantity ?? 0), 0)),
    'Dòng thiếu điều kiện': Object.values(states).filter(state => state.orderPlan?.warnings.length).length,
    'SKU có nguy cơ thiếu trước lô mới': Object.values(states).filter(state => (state.orderPlan?.shortageBeforeNewLot ?? 0) > 0).length,
    ...note16.summary,
  }, ['Vùng cần bao phủ = lead time (thật hoặc mặc định chính sách) + chu kỳ lập kế hoạch, không còn cứng toàn bộ tầm dự báo.', 'Không xét ngân sách tại Chặng 16.', 'Phần dư MOQ và thiếu hàng trước lô mới được giữ riêng để Chặng 17/18 kiểm tra ngoại lệ.', ...note16.audit]);
}

function runStage17(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  const { totalValue, funded } = allocateBudget(states, policy);
  const note17 = operationalStatusNote(policy, 17);
  return createSnapshot(17, policy, states, {
    'Tổng giá trị đề xuất': totalValue,
    'Ngân sách kỳ': policy.periodBudget,
    'Ngân sách đã cấp': funded,
    'Dòng bị cắt/hoãn': Object.values(states).filter(state => (state.budgetAllocation?.cutQuantity ?? 0) > 0).length,
    'Đề xuất vượt ngân sách': Object.values(states).filter(state => state.budgetAllocation?.status === 'over-budget-proposal').length,
    ...note17.summary,
  }, ['Không sửa dự báo, tồn kho an toàn hoặc số đặt sau MOQ.', 'Sắp xếp theo 7 tiêu chí của tài liệu — tuyệt đối không dùng giá trị đơn hàng làm tiêu chí ưu tiên.', 'Cấp hết Rổ 1 (tránh hết hàng) toàn danh mục trước khi đụng Rổ 2 (bảo vệ), rồi mới đến Rổ 3 (rủi ro MOQ).', ...note17.audit]);
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
    const orderQuantity = state.orderPlan?.orderQuantity ?? 0;
    const moqSurplus = state.orderPlan?.moqSurplus ?? 0;
    if (orderQuantity > 0 && moqSurplus > policy.moqSurplusApprovalThresholdRatio * orderQuantity) reasons.push(`MOQ tạo tồn dư lớn: ${moqSurplus.toFixed(0)} sản phẩm dư (>${(policy.moqSurplusApprovalThresholdRatio * 100).toFixed(0)}% số đặt).`);
    const trailingAvgDemand = mean(lockedValues(state));
    if (trailingAvgDemand > 0 && orderQuantity > policy.abnormalOrderMultiplier * trailingAvgDemand) reasons.push(`Số lượng đặt tăng bất thường: gấp ${(orderQuantity / trailingAvgDemand).toFixed(1)} lần nhu cầu bình quân các chu kỳ khóa gần nhất.`);
    if ((state.orderPlan?.shortageBeforeNewLot ?? 0) > 0) reasons.push(`Có nguy cơ thiếu ${(state.orderPlan!.shortageBeforeNewLot).toFixed(0)} sản phẩm trước khi lô mới về.`);
    if (state.supplyStatus.pendingVerification) reasons.push(...state.supplyStatus.reasons.map(reason => `Nguồn hàng: ${reason}`));
    // "Người dùng tự sửa số đề xuất": TODO(product) — ứng dụng chưa có state lưu chỉnh sửa thủ công của người dùng, không có input path để kiểm tra điều kiện này.
    let status: 'not-issued' | 'awaiting-info' | 'awaiting-approval' | 'issued' = 'issued';
    if (funded <= 0) status = 'not-issued';
    else if (!complete) status = 'awaiting-info';
    else if (reasons.length) status = 'awaiting-approval';
    state.releaseDecision = {
      status, releasedQuantity: status === 'issued' ? funded : 0, reasons,
      quantityBeforeApproval: funded, quantityAfterApproval: status === 'issued' ? funded : 0,
      purchaseOrderGroupKey: null, duplicateReleaseBlocked: false,
    };
  }
  applyPurchaseOrderGrouping(states);
  const note18 = operationalStatusNote(policy, 18);
  return createSnapshot(18, policy, states, {
    'Dòng phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'issued').length,
    'Dòng chờ bổ sung': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-info').length,
    'Dòng chờ duyệt': Object.values(states).filter(state => state.releaseDecision?.status === 'awaiting-approval').length,
    'Dòng không phát hành': Object.values(states).filter(state => state.releaseDecision?.status === 'not-issued').length,
    ...note18.summary,
  }, ['Chặng 18 không tính lại số đặt.', 'Dòng có ngoại lệ được giữ nguyên số trước duyệt và không tự phát hành.', 'Nhóm cùng NCC/tiền tệ/kho nhận không đạt giá trị tối thiểu bị hạ cả nhóm về chờ duyệt.', 'Không có thao tác duyệt giả lập thay cho người có thẩm quyền.', ...note18.audit,
    ...(policy.operationalDataStatus !== 'CONFIRMED' ? [`[Chặng 18][SIMULATION_ONLY] "Phát hành" (issued) ở chặng này KHÔNG phải phát hành đơn mua thật — không có tích hợp hệ thống mua hàng thật đứng sau trạng thái này.`] : []),
  ]);
}

/** Chặng 19 §8 — bảng nguyên nhân theo thứ tự ưu tiên; hàm trả về true nếu điều kiện của dòng khớp. */
interface CauseRow { id: string; label: string; proposal: string; test: (ctx: PostAuditContext) => boolean }
interface PostAuditContext {
  stockoutUnits: number; averageReceiptDelayDays: number; budgetCutUnits: number; manualReductionUnits: number;
  moqSurplusResidual: number; endingStock: number; baseUnderforecast: boolean; promoUnderlearned: boolean;
  heldOrDamagedOrBlockedOrUnsellable: boolean;
}
const CAUSE_TABLE: CauseRow[] = [
  { id: 'base-forecast', label: 'Mô hình dự báo nền chưa sát nhu cầu thực tế ngoài giai đoạn CTKM.', proposal: 'Đề xuất kiểm chứng lại mô hình dự báo nền (Chặng 9–11) ở phiên chính sách tương lai.', test: ctx => ctx.baseUnderforecast },
  { id: 'promo-factor', label: 'Hệ số học CTKM (Chặng 12) chưa phản ánh đúng mức tăng bán thực tế.', proposal: 'Đề xuất thu thập thêm vùng CTKM lịch sử hoặc duyệt lại hệ số K thủ công.', test: ctx => ctx.promoUnderlearned },
  { id: 'supplier-lead-time', label: 'Thiếu hàng đi kèm hàng về trễ; ưu tiên kiểm tra Chặng 14.', proposal: 'Đề xuất kiểm chứng lại lead time theo nhà cung cấp ở phiên chính sách tương lai.', test: ctx => ctx.stockoutUnits > 0 && ctx.averageReceiptDelayDays > 0 },
  { id: 'budget-cut', label: 'Thiếu hàng sau khi dòng bị cắt vốn tại Chặng 17.', proposal: 'Đề xuất kiểm chứng lại thứ tự ưu tiên ngân sách ở phiên tương lai.', test: ctx => ctx.stockoutUnits > 0 && ctx.budgetCutUnits > 0 },
  { id: 'manual-approval', label: 'Số lượng bị giảm do quyết định thủ công ở Chặng 18.', proposal: 'Đề xuất đo thời gian và kết quả duyệt trước khi thay đổi ngưỡng ngoại lệ.', test: ctx => ctx.stockoutUnits > 0 && ctx.manualReductionUnits > 0 },
  { id: 'moq-supplier-terms', label: 'Dư tồn do làm tròn MOQ hoặc điều kiện mua hàng của nhà cung cấp.', proposal: 'Đề xuất xem lại quy cách mua (MOQ/carton/order-step) với nhà cung cấp.', test: ctx => ctx.endingStock > 0 && ctx.moqSurplusResidual > 0 },
  { id: 'inventory-data', label: 'Dữ liệu hoặc vận hành kho (hàng giữ/hư hỏng/khóa/không bán được) ảnh hưởng đến tồn cuối.', proposal: 'Đề xuất rà soát dữ liệu tồn kho vận hành trước khi kết luận về dự báo hay nguồn hàng.', test: ctx => ctx.endingStock > 0 && ctx.heldOrDamagedOrBlockedOrUnsellable },
];

function runStage19(previous: StageSnapshot, policy: SimulationPolicy): StageSnapshot {
  const states = cloneStates(previous);
  for (const state of Object.values(states)) {
    const actual = state.definition.actualDemand;
    const finalForecastSlice = state.finalForecast.slice(0, actual.length);
    const baseForecastSlice = (state.forecast?.baseForecast ?? []).slice(0, actual.length);
    const actualDemand = actual.reduce((sum, value) => sum + value, 0);
    const forecastWape = actual.length && finalForecastSlice.length === actual.length ? calculateWape(actual, finalForecastSlice) : null;
    const finalForecastRmse = actual.length ? calculateRmse(actual, finalForecastSlice) : null;
    const finalForecastNrmse = actual.length ? calculateNrmse(actual, finalForecastSlice) : null;
    const finalForecastBias = actual.length ? calculateBias(actual, finalForecastSlice) : null;

    // §4.1 — sai số dự báo NỀN chỉ đo trên chu kỳ KHÔNG có CTKM xác nhận (tách khỏi tác động hệ số K).
    const nonPromoIndexes = actual.map((_, index) => index).filter(index => !state.definition.futurePromotions.some(item => item.confirmed && item.cycleOffset === index + 1));
    const nonPromoActual = nonPromoIndexes.map(index => actual[index]);
    const nonPromoBase = nonPromoIndexes.map(index => baseForecastSlice[index] ?? 0);
    const hasBaseSample = nonPromoActual.length > 0 && baseForecastSlice.length === actual.length;
    const baseForecastWape = hasBaseSample ? calculateWape(nonPromoActual, nonPromoBase) : null;
    const baseForecastRmse = hasBaseSample ? calculateRmse(nonPromoActual, nonPromoBase) : null;
    const baseForecastNrmse = hasBaseSample ? calculateNrmse(nonPromoActual, nonPromoBase) : null;
    const baseForecastBias = hasBaseSample ? calculateBias(nonPromoActual, nonPromoBase) : null;

    const promoIndexes = actual.map((_, index) => index).filter(index => state.definition.futurePromotions.some(item => item.confirmed && item.cycleOffset === index + 1));
    const promoActual = promoIndexes.map(index => actual[index]);
    const promoFinal = promoIndexes.map(index => finalForecastSlice[index] ?? 0);
    const promoUnderlearned = promoIndexes.length > 0 && (state.promoConfidence === 'low' || state.promoConfidence === 'suggest-only' || state.promoConfidence === 'blocked')
      && promoActual.reduce((sum, value) => sum + value, 0) > promoFinal.reduce((sum, value) => sum + value, 0);

    const released = state.releaseDecision?.releasedQuantity ?? 0;
    const available = Math.max(0, state.freeStock ?? 0) + released;
    const stockoutUnits = Math.max(0, actualDemand - available);
    const delays = state.definition.actualReceiptDelayDays;
    const averageReceiptDelayDays = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : 0;
    const budgetVariance = (state.budgetAllocation?.fundedValue ?? 0) - state.definition.actualBudgetUsed;
    const moqSurplusResidual = state.orderPlan?.moqSurplus ?? 0;
    const budgetCutUnits = state.budgetAllocation?.cutQuantity ?? 0;
    const manualReductionUnits = Math.max(0, (state.releaseDecision?.quantityBeforeApproval ?? 0) - (state.releaseDecision?.quantityAfterApproval ?? 0));
    const leadTimeActualDays = state.definition.leadTimeHistoryDays.length ? mean(state.definition.leadTimeHistoryDays) + averageReceiptDelayDays : null;
    const definition = state.definition;

    const context: PostAuditContext = {
      stockoutUnits, averageReceiptDelayDays, budgetCutUnits, manualReductionUnits, moqSurplusResidual,
      endingStock: state.definition.actualEndingStock,
      baseUnderforecast: hasBaseSample && nonPromoActual.reduce((sum, value) => sum + value, 0) > nonPromoBase.reduce((sum, value) => sum + value, 0) * 1.1,
      promoUnderlearned,
      heldOrDamagedOrBlockedOrUnsellable: definition.heldStock + definition.damagedStock + definition.blockedStock + definition.unsellableStock > 0,
    };
    const matched = CAUSE_TABLE.filter(row => row.test(context));
    const primaryCause = matched[0]?.label ?? 'Chưa đủ dấu hiệu để quy nguyên nhân; tiếp tục theo dõi.';
    const proposal = matched[0]?.proposal ?? 'Giữ chính sách hiện tại và tiếp tục thu thập kết quả thực tế.';
    // §10 — cổng mức độ nghiêm trọng thay cho phát hiện "lặp lại" thật (engine không lưu lịch sử nhiều phiên).
    const severeEnough = matched.length > 0 && (stockoutUnits > 0 || (forecastWape ?? 0) > 0.3);
    const proposalStatus: 'future-version' | 'monitor' = severeEnough ? 'future-version' : 'monitor';
    const evidence = [
      `Sai số WAPE dự báo cuối: ${forecastWape === null ? 'chưa đủ dữ liệu' : `${(forecastWape * 100).toFixed(1)}%`}.`,
      `Thiếu hàng thực tế: ${stockoutUnits.toFixed(0)} sản phẩm.`,
      `Trễ nhận hàng bình quân: ${averageReceiptDelayDays.toFixed(1)} ngày.`,
      `Ngân sách bị cắt: ${budgetCutUnits.toFixed(0)} sản phẩm · Giảm do duyệt thủ công: ${manualReductionUnits.toFixed(0)} sản phẩm.`,
    ];

    state.postAudit = {
      forecastWape, actualDemand, stockoutUnits, endingStock: state.definition.actualEndingStock,
      averageReceiptDelayDays, budgetVariance, primaryCause, proposal, proposalStatus,
      baseForecastWape, baseForecastRmse, baseForecastNrmse, baseForecastBias,
      finalForecastRmse, finalForecastNrmse, finalForecastBias,
      moqSurplusResidual, budgetCutUnits, manualReductionUnits,
      leadTimeActualDays, receiptDelayDaysVsPlan: averageReceiptDelayDays,
      contributingCauses: matched.map(row => row.label), evidence,
    };
  }
  const note19 = operationalStatusNote(policy, 19);
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
    ...note19.summary,
  }, ['Giữ nguyên toàn bộ snapshot C1–C18; không hồi tố.', 'Tách nguyên nhân theo dữ liệu, nguồn hàng, tồn an toàn, MOQ, ngân sách và duyệt ngoại lệ.', 'Mọi thay đổi chỉ là đề xuất cho phiên bản tương lai.', ...note19.audit]);
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
