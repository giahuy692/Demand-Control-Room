import { buildCalendarScaffold } from '../../domain/calendar-scaffold';
import { SimulationDataset } from '../../domain/catalog';
import { stripStandingPromoCodes } from '../../domain/math';
import { DailyRecord, SalesObservationStatus, SimulationPolicy, SkuPipelineState, StageSnapshot } from '../../domain/models';

import { createInitialState, createSnapshot, dateAfter, futureActualDemand, resetDailyRecord } from '../stage-support';

export function runStage1(policy: SimulationPolicy, dataset: SimulationDataset | null): StageSnapshot {
  if (!dataset) {
    // DoD refactor — engine KHÔNG còn tự sinh dữ liệu giả: mock cũng phải đi qua
    // mock.dataset.json → DTO → mapper như dữ liệu thật, không có fallback nội bộ.
    throw new Error('Chưa nạp dataset vào engine — gọi setDataset() với dataset đã qua DTO/mapper trước khi chạy Chặng 1.');
  }
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
  // RULE-01-003/DEC-P01 (chưa duyệt chính thức) — vùng đọc tham chiếu trước ProcessingStartDate,
  // khởi điểm dùng chung bán kính tối đa hiện có (policy.maxReferenceRadius).
  const referenceReadStart = dateAfter(fullCycleStart, -policy.maxReferenceRadius);
  // CTKM thường trực phải bị loại ở CẢ HAI nguồn token: row.promoCode (strip bên dưới) VÀ
  // promotionIntervals (scaffold bơm interval.code — thường là mã số — vào từng ngày trong khoảng
  // KM; nếu không lọc ở đây, mã số đó vẫn giữ ngày là ngày CTKM dù tên đã bị strip).
  const standingCodes = new Set(policy.standingPromotionCodes);
  for (const baseDefinition of dataset.catalog) {
    const promotionIntervals = dataset.promotionIntervals.filter(interval =>
      (interval.sku === null || interval.sku === baseDefinition.id)
      && !standingCodes.has(interval.code)
      && (interval.name === null || !standingCodes.has(interval.name)));
    const allRows = [...(dataset.dailyBySku[baseDefinition.id] ?? [])]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(row => ({ ...row, promoCode: stripStandingPromoCodes(row.promoCode, policy.standingPromotionCodes) }));
    let daily: DailyRecord[];
    let referenceOnlyDaily: DailyRecord[];
    if (dataset.calendarScaffold === 'GLOBAL_WINDOW') {
      // RULE-01-001 — nguồn thưa: tạo lịch liên tục cho cả khung xử lý lẫn vùng đọc tham chiếu;
      // ngày không có nguồn thật giữ hasRecord=false/sales=null, KHÔNG suy diễn bán=0 [DEC-006/007].
      const scaffolded = buildCalendarScaffold(baseDefinition.id, allRows, referenceReadStart, historyEndIso, iso => iso < fullCycleStart, dataset.extractMetadata, promotionIntervals)
        .map(resetDailyRecord);
      // RULE-01-003 — vùng tham chiếu KHÔNG được đưa vào ABC/XYZ/chuỗi học: tách khỏi `daily`
      // ngay tại đây, không chỉ lọc muộn ở Chặng 6/7. Hiện CHƯA nối vào tìm kiếm tham chiếu
      // Chặng 3–5 (thuật toán đó đã khóa theo index của `daily`) — xem giới hạn đã ghi nhận.
      referenceOnlyDaily = scaffolded.filter(row => row.isReferenceOnly);
      daily = scaffolded.filter(row => !row.isReferenceOnly);
    } else {
      // PRESCAFFOLDED — dataset khai báo mỗi SKU đã là chuỗi ngày liên tục đúng khoảng hoạt
      // động của nó (pattern kiểm thử); KHÔNG scaffold lùi về đầu cửa sổ, nếu không SKU lịch
      // sử ngắn (BY-short, ONE-CYCLE…) bị bơm ngày SOURCE_UNKNOWN và đổi ngữ nghĩa kiểm thử.
      referenceOnlyDaily = [];
      const rows = allRows.filter(row => row.date >= fullCycleStart && row.date <= historyEndIso);
      daily = rows.length
        ? buildCalendarScaffold(baseDefinition.id, rows, rows[0].date, rows.at(-1)!.date, () => false, dataset.extractMetadata, promotionIntervals).map(resetDailyRecord)
        : [];
    }
    const definition = dataset.runMode === 'HISTORICAL_VALIDATION'
      ? {
          ...baseDefinition,
          cycles: Math.floor(daily.length / policy.cycleLength),
          // §9 LỆNH CODEX/DEC-008/009 — phiên HISTORICAL_VALIDATION KHÔNG được dựng kế hoạch CTKM
          // tương lai từ giao dịch thực tế quan sát sau runDate (khác `actualDemand` bên dưới — đó
          // là hậu kiểm Chặng 19, không nuôi ngược vào dự báo Chặng 13).
          futurePromotions: [],
          actualDemand: futureActualDemand(allRows, policy),
          // Dòng validation từ nguồn mới có thể KHÔNG mang bằng chứng tồn (UNRESOLVED) — không
          // dùng số 0 trình bày của chúng làm tồn cuối; lùi về tồn cuối lịch sử đã đối soát.
          actualEndingStock: allRows.filter(row => row.date >= policy.runDate && row.stockCalculationStatus !== 'UNRESOLVED').at(-1)?.closeStock ?? daily.at(-1)?.closeStock ?? 0,
          portfolioMode: dataset.portfolioMode,
          extractIsTruncated: dataset.extractIsTruncated,
        }
      // PLANNING_SIMULATION — dataset tự mang đầu vào vận hành đã xác nhận (futurePromotions,
      // actualDemand…) trên từng product; nhận nguyên trạng, giữ cycles gốc của định nghĩa.
      : baseDefinition;
    states[definition.id] = createInitialState(definition, daily, referenceOnlyDaily);
  }
  const processingDays = Object.values(states).flatMap(state => state.daily);
  const statusCount = (status: DailyRecord['salesObservationStatus']) => processingDays.filter(row => row.salesObservationStatus === status).length;
  return createSnapshot(1, policy, states, {
    'Nguồn dữ liệu': dataset.label,
    'SKU': Object.keys(states).length,
    'Bắt đầu lịch sử': historyStart.toISOString().slice(0, 10),
    'Kết thúc lịch sử': historyEnd.toISOString().slice(0, 10),
    'Tổng ngày D': totalDays,
    'Chu kỳ đầy đủ N': cycleCount,
    'Ngày dư r': totalDays - cycleCount * policy.cycleLength,
    'RECORDED_SALE': statusCount(SalesObservationStatus.RECORDED_SALE),
    'CONFIRMED_ZERO': statusCount(SalesObservationStatus.CONFIRMED_ZERO),
    'SOURCE_DATA_GAP': statusCount(SalesObservationStatus.SOURCE_DATA_GAP),
  }, [
    `[RULE-01-002] Khóa ${totalDays} ngày lịch theo chính sách ${policy.version}.`,
    `[RULE-01-002] Tạo ${cycleCount} chu kỳ cố định, không phụ thuộc số bản ghi của từng SKU.`,
    ...(dataset.calendarScaffold === 'GLOBAL_WINDOW' ? [
      `[RULE-01-001] Đã tạo lịch liên tục — ngày không có sales row được phân loại RECORDED_SALE/CONFIRMED_ZERO/SOURCE_DATA_GAP bằng sales watermark; stock row không phải bằng chứng duy nhất.`,
      `[RULE-01-003][DEC-P01·ĐỀ XUẤT] Đã nạp vùng đọc tham chiếu ${policy.maxReferenceRadius} ngày trước khung xử lý (isReferenceOnly=true) — CHƯA nối vào tìm kiếm tham chiếu Chặng 3–5 trong bản này; loại hoàn toàn khỏi ABC/XYZ/chuỗi học.`,
      `[RULE-01-004][DEC-010] portfolioMode=${dataset.portfolioMode}, extractIsTruncated=${dataset.extractIsTruncated} — ABC ở Chặng 6 KHÔNG được khóa là chính thức khi tập dữ liệu là SELECTED_SKU_SIMULATION.`,
    ] : ['Dataset khai báo PRESCAFFOLDED (dữ liệu giả sinh sẵn theo pattern) — không áp dụng RULE-01-001 (không mô phỏng khoảng trống nguồn).']),
  ]);
}
