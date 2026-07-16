import { buildCalendarScaffold } from '../domain/calendar-scaffold';
import { SimulationDataset } from '../domain/catalog';
import { FORECAST_HORIZON, fitBaseForecast } from '../domain/forecast-models';
import { applyPromoFactor, calculateAvailableStock, calculateBias, calendarWindowAbcMetrics, calculateFreeStock, calculateNrmse, calculateRmse, calculateTrend, calculateWape, classifyPromoRegionPolicy, classifyXyz, fixedCalendarWindow, isStockout, mean, median, meetsSeasonRepeatThreshold, requireObservedSales, stripStandingPromoCodes, trailingLockedRun } from '../domain/math';
import { AbcClass, BalanceStatus, Classification, CycleRecord, CycleStatus, DailyRecord, DSubtype, ExceptionResolutionOption, ExceptionResolutionType, ExceptionTask, LotReliability, SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot, XyzClass } from '../domain/models';
import { chooseSafetyStock } from '../domain/safety-stock';
import { applySupplierConsolidation, buildOrderPlan } from '../domain/order-plan';
import { allocateBudget } from '../domain/budget-allocation';
import { applyPurchaseOrderGrouping } from '../domain/purchase-orders';
import { CAPITAL_PRIORITIES, DEFAULT_POLICY, SERVICE_LEVELS } from '../domain/policy';
import { buildPromoRegionSamples } from '../domain/promo-analysis';
import { demandRiskInputs } from '../domain/demand-risk';


export function emptyClassification(): Classification {
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
export function cloneStates(snapshot: StageSnapshot): Record<string, SkuPipelineState> {
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
export function operationalStatusNote(policy: SimulationPolicy, stage: StageNumber): { summary: Record<string, string | number>; audit: string[] } {
  const evaluationStatus = policy.operationalDataStatus === 'CONFIRMED' ? 'OPERATIONAL' : 'SIMULATION_ONLY';
  return {
    summary: { 'Trạng thái vận hành': evaluationStatus },
    audit: [`[Chặng ${stage}][04 §14/DEC-W05] operationalDataStatus=${policy.operationalDataStatus} → đầu ra là ${evaluationStatus}${evaluationStatus === 'SIMULATION_ONLY' ? ' — KHÔNG dùng để ra quyết định vận hành thật; ngân sách/MOQ/nhà cung cấp/ETA thật chưa sẵn sàng.' : '.'}`],
  };
}

export function createSnapshot(stage: StageNumber, policy: SimulationPolicy, states: Record<string, SkuPipelineState>, summary: Record<string, string | number>, audit: string[], exceptions: ExceptionTask[] = []): StageSnapshot {
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

export function isObservedClean(record: DailyRecord): boolean {
  // Ngày không có bản ghi (hasRecord=false) không được dùng làm nền tham chiếu
  // cho ngày khác — chưa xác nhận nó thật sự "sạch" [nguyên tắc bất biến #2, C1 §3].
  return record.hasRecord && !record.promoCode && !record.isStockout && (record.baseSource === null || record.baseSource === 'clean');
}

export function collectCleanSide(records: DailyRecord[], fromIndex: number, direction: -1 | 1, radius: number, stopAtPromoBoundary: boolean): ReferenceItem[] {
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

export function applyReferenceAudit(record: DailyRecord, selection: ReferenceSelection): DailyRecord {
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

export function buildPromoRegions(records: DailyRecord[], policy: SimulationPolicy): { indexes: number[]; codes: string[]; clustered: boolean }[] {
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

export function resetDailyRecord(record: DailyRecord): DailyRecord {
  return {
    ...record,
    isStockout: false, stockoutReason: null, stockoutReviewRequired: false, baseDemand: null, baseSource: null,
    referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '',
  };
}

export function createInitialState(definition: SkuPipelineState['definition'], daily: DailyRecord[], referenceOnlyDaily: DailyRecord[] = []): SkuPipelineState {
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

export function futureActualDemand(rows: readonly DailyRecord[], policy: SimulationPolicy): number[] {
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
export function lockedValues(state: SkuPipelineState): number[] {
  return trailingLockedRun(state.cycles).slice(-24).map(cycle => cycle.baseDemand);
}

/**
 * Chặng 9–11 dùng chung chuỗi chu kỳ đã khóa (`lockedValues`/`cycles.filter(locked)`) nhưng tới
 * trước bản này chỉ log tổng số "đã khóa", không tách theo chất lượng nguồn — bổ sung log tổng hợp
 * (không đổi bất kỳ phép tính nào) để phân biệt chuỗi học phần lớn quan sát thuần so với chuỗi dựa
 * nhiều vào lấp kỹ thuật/nguồn dự phòng mùa vụ, theo đúng 3 trạng thái LOCKED_* của RULE-05-005.
 */
export function lockedCycleQualityBreakdown(states: Record<string, SkuPipelineState>): { observed: number; adjusted: number; fallback: number } {
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





/**
 * RULE-03-003 cấp 3 — cùng vị trí mùa vụ năm trước (dịch lùi đúng một "năm" theo lịch chu kỳ cố
 * định của phiên: 24 chu kỳ). Chỉ dùng khi cấp 1 (theo thời gian, cùng SKU) đã 'insufficient'.
 * Cấp 2 (cửa hàng tương đồng) không áp dụng — app hiện chỉ có một nơi bán duy nhất. Cấp 4/5 (SKU
 * tương tự đã duyệt / nền thủ công MD) cần phê duyệt con người trước khi dùng làm nguồn chính thức
 * [DEC-016] — kiến trúc hiện tại không có danh mục SKU tương tự đã duyệt hay UI nhập nền thủ công,
 * nên khi cấp 1 và cấp 3 đều thất bại, hệ thống dừng ở BASELINE_UNRESOLVED và tạo task ngoại lệ đề
 * nghị đúng hai lựa chọn còn lại, thay vì tự suy diễn một giá trị không có căn cứ.
 */
export function seasonalFallbackSelection(source: DailyRecord[], index: number, policy: SimulationPolicy, stopAtPromoBoundary: boolean): ReferenceSelection | null {
  const yearOffset = 24 * policy.cycleLength;
  const shifted = index - yearOffset;
  if (shifted < 0 || shifted >= source.length) return null;
  const selection = qualifySelection(selectReferences(source, shifted, shifted, policy, stopAtPromoBoundary), source.length, shifted, shifted);
  if (selection.status === 'insufficient') return null;
  return { ...selection, reason: `[Cấp 3 · mùa vụ năm trước, lùi ${yearOffset} ngày] ${selection.reason}` };
}





/** RULE-05-003 Tầng 2 — mức đại diện chu kỳ = median các ngày nền hợp lệ SẴN CÓ trong chính chu kỳ trước khi lấp (không lấy từ ngày vừa lấp). */
export function tier2RepresentativeFill(cycleRows: DailyRecord[]): { filled: DailyRecord[]; used: boolean } {
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

export function fillAndBuildCycles(records: DailyRecord[], cycleLength: number, minimumReferences: number, maxRadius: number, enableTier2CycleFallback = false): { daily: DailyRecord[]; cycles: CycleRecord[] } {
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
export function cycleStatus(sourceRecordDays: number, locked: boolean, emptyCycle: boolean, cleanDays: number, fallbackDays: number, tier2Filled: boolean, cycleLength: number): CycleStatus {
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
export function buildCycleException(skuId: string, cycle: CycleRecord, policy: SimulationPolicy): ExceptionTask {
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



export const ABC_WINDOW_SIZE = 24;
export const ABC_MINIMUM_LOCKED_CYCLES = 6;



/**
 * RULE-07-001 — phân biệt lý do gộp trong nhóm D. D_MANUAL_PLAN/D_SIMILAR_SKU không có nguồn dữ
 * liệu trong app hiện tại nên không bao giờ được trả về. Hàm này chỉ được gọi SAU KHI Chặng 7
 * (fixedCalendarWindow) đã xác nhận cửa sổ đang xét không bị chặn (không còn chu kỳ
 * BASELINE_UNRESOLVED/NO_SOURCE_RECORD nào lẫn trong đó) — vì vậy không cần tự kiểm tra lại
 * unresolvedCycles ở đây; nhánh D_BASELINE_UNRESOLVED trước đây đã trở thành dead code, gỡ bỏ
 * (xem ghi chú DSubtype/ExceptionCode ở models.ts).
 */
export function classifyDSubtype(state: SkuPipelineState): { dSubtype: DSubtype; reason: string } {
  if (state.cycles.length === 0) {
    return { dSubtype: 'D_NEW', reason: 'Chưa có chu kỳ nào trong khung xử lý — SKU mới hoàn toàn.' };
  }
  if (state.definition.extractIsTruncated) {
    return { dSubtype: 'D_EXTRACT_TRUNCATED', reason: `portfolioMode=${state.definition.portfolioMode}/extractIsTruncated=true — không loại trừ được khả năng tập dữ liệu bị cắt, chưa thể kết luận là chuỗi ngắn hạn thật.` };
  }
  return { dSubtype: 'D_SHORT_HISTORY', reason: `Chỉ ${state.cycles.length} chu kỳ khóa trong dữ liệu đã xác nhận đầy đủ (không bị cắt) — tương đương D_TRUE_SHORT_HISTORY của tài liệu.` };
}















export function dateAfter(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export const EXCLUDED_LOT_REASON: Record<Exclude<LotReliability, 'shipped-confirmed' | 'supplier-confirmed'>, string> = {
  planned: 'Đang đàm phán/lên kế hoạch — chưa được nhà cung cấp xác nhận, không cộng vào hàng tự do.',
  overdue: 'Đã trễ so với ETA — giữ để kiểm toán nhưng không cộng vào hàng tự do.',
  cancelled: 'Đã bị hủy — loại khỏi hàng tự do.',
};











/** Chặng 19 §8 — bảng nguyên nhân theo thứ tự ưu tiên; hàm trả về true nếu điều kiện của dòng khớp. */
interface CauseRow { id: string; label: string; proposal: string; test: (ctx: PostAuditContext) => boolean }
export interface PostAuditContext {
  stockoutUnits: number; averageReceiptDelayDays: number; budgetCutUnits: number; manualReductionUnits: number;
  moqSurplusResidual: number; endingStock: number; baseUnderforecast: boolean; promoUnderlearned: boolean;
  heldOrDamagedOrBlockedOrUnsellable: boolean;
}
export const CAUSE_TABLE: CauseRow[] = [
  { id: 'base-forecast', label: 'Mô hình dự báo nền chưa sát nhu cầu thực tế ngoài giai đoạn CTKM.', proposal: 'Đề xuất kiểm chứng lại mô hình dự báo nền (Chặng 9–11) ở phiên chính sách tương lai.', test: ctx => ctx.baseUnderforecast },
  { id: 'promo-factor', label: 'Hệ số học CTKM (Chặng 12) chưa phản ánh đúng mức tăng bán thực tế.', proposal: 'Đề xuất thu thập thêm vùng CTKM lịch sử hoặc duyệt lại hệ số K thủ công.', test: ctx => ctx.promoUnderlearned },
  { id: 'supplier-lead-time', label: 'Thiếu hàng đi kèm hàng về trễ; ưu tiên kiểm tra Chặng 14.', proposal: 'Đề xuất kiểm chứng lại lead time theo nhà cung cấp ở phiên chính sách tương lai.', test: ctx => ctx.stockoutUnits > 0 && ctx.averageReceiptDelayDays > 0 },
  { id: 'budget-cut', label: 'Thiếu hàng sau khi dòng bị cắt vốn tại Chặng 17.', proposal: 'Đề xuất kiểm chứng lại thứ tự ưu tiên ngân sách ở phiên tương lai.', test: ctx => ctx.stockoutUnits > 0 && ctx.budgetCutUnits > 0 },
  { id: 'manual-approval', label: 'Số lượng bị giảm do quyết định thủ công ở Chặng 18.', proposal: 'Đề xuất đo thời gian và kết quả duyệt trước khi thay đổi ngưỡng ngoại lệ.', test: ctx => ctx.stockoutUnits > 0 && ctx.manualReductionUnits > 0 },
  { id: 'moq-supplier-terms', label: 'Dư tồn do làm tròn MOQ hoặc điều kiện mua hàng của nhà cung cấp.', proposal: 'Đề xuất xem lại quy cách mua (MOQ/carton/order-step) với nhà cung cấp.', test: ctx => ctx.endingStock > 0 && ctx.moqSurplusResidual > 0 },
  { id: 'inventory-data', label: 'Dữ liệu hoặc vận hành kho (hàng giữ/hư hỏng/khóa/không bán được) ảnh hưởng đến tồn cuối.', proposal: 'Đề xuất rà soát dữ liệu tồn kho vận hành trước khi kết luận về dự báo hay nguồn hàng.', test: ctx => ctx.endingStock > 0 && ctx.heldOrDamagedOrBlockedOrUnsellable },
];
