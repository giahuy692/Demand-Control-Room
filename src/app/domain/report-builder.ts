import { STAGE_TRACE_CONTRACTS } from './stage-trace-contracts';
import { STAGES } from './policy';
import { SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot } from './models';

export type IssueSeverity = 'info' | 'warn' | 'critical';

export interface ReportIssueDetail {
  skuId: string;
  skuName: string;
  point: string;
  reason: string;
  systemAction: string;
  evidence?: string;
}

export interface ReportIssue {
  severity: IssueSeverity;
  title: string;
  skuIds: string[];
  description: string;
  docReference?: string;
  proposal?: string;
  details: ReportIssueDetail[];
}

export interface StageReportSection {
  stage: StageNumber;
  title: string;
  totalSkus: number;
  normalCount: number;
  issues: ReportIssue[];
}

export interface SimulationReport {
  runDate: string;
  totalSkus: number;
  stagesRun: number;
  totalIssues: number;
  sections: StageReportSection[];
  recommendations: string[];
}

function issue(
  severity: IssueSeverity,
  title: string,
  skuIds: string[],
  description: string,
  docReference?: string,
  proposal?: string,
  details: ReportIssueDetail[] = [],
): ReportIssue | null {
  if (!skuIds.length) return null;
  return { severity, title, skuIds, description, docReference, proposal, details };
}

function purposeRef(stage: StageNumber): string {
  return STAGE_TRACE_CONTRACTS[stage].purpose;
}

function years(daily: SkuPipelineState['daily']): number {
  if (daily.length < 2) return 0;
  const first = new Date(`${daily[0].date}T00:00:00Z`).getTime();
  const last = new Date(`${daily[daily.length - 1].date}T00:00:00Z`).getTime();
  return (last - first) / (365 * 86_400_000);
}

type States = Readonly<Record<string, Readonly<SkuPipelineState>>>;
type StageChecker = (states: States, operationalDataStatus: SimulationPolicy['operationalDataStatus']) => ReportIssue[];

/**
 * 04 §14/DEC-W05 — nhãn hóa TOÀN CỤC cho Chặng 14–19 khi operationalDataStatus khác CONFIRMED:
 * mọi số liệu của các chặng này chỉ là SIMULATION_ONLY, không phải kết luận vận hành thật. Engine
 * (`operationalStatusNote`) đã ghi nhãn này vào summary/audit của snapshot; hàm này đưa cùng nhãn
 * vào báo cáo mô phỏng để không bị lọt khỏi tầm nhìn khi người dùng chỉ đọc báo cáo tổng hợp.
 */
function simulationOnlyIssue(states: States, operationalDataStatus: SimulationPolicy['operationalDataStatus'], stage: StageNumber): ReportIssue | null {
  if (operationalDataStatus === 'CONFIRMED') return null;
  const allIds = Object.values(states).map(state => state.definition.id);
  return issue(
    'info',
    'Toàn bộ đầu ra chặng này là SIMULATION_ONLY (chưa xác nhận dữ liệu vận hành thật)',
    allIds,
    'Ngân sách/MOQ/nhà cung cấp/ETA thật hiện "KHÔNG ÁP DỤNG HIỆN TẠI" (operationalDataStatus khác CONFIRMED) nên toàn bộ số liệu của chặng này chỉ phục vụ kiểm tra thuật toán mô phỏng, KHÔNG được dùng làm kết luận vận hành thật.',
    purposeRef(stage),
    'Chỉ chuyển operationalDataStatus sang CONFIRMED khi dữ liệu vận hành thật (ngân sách/MOQ/nhà cung cấp/ETA) đã sẵn sàng và được xác nhận.',
  );
}

function detail(
  state: Readonly<SkuPipelineState>,
  point: string,
  reason: string,
  systemAction: string,
  evidence?: string,
): ReportIssueDetail {
  return { skuId: state.definition.id, skuName: state.definition.name, point, reason, systemAction, evidence };
}

function ids(details: readonly ReportIssueDetail[]): string[] {
  return [...new Set(details.map(item => item.skuId))];
}

function fmt(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'không có';
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

const STAGE_CHECKERS: Partial<Record<StageNumber, StageChecker>> = {
  1: states => {
    const short: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      const historyYears = years(state.daily);
      if (historyYears < 3) short.push(detail(
        state,
        'Lịch sử quan sát ngắn hơn 3 năm',
        `Chuỗi dữ liệu chỉ dài khoảng ${fmt(historyYears, 1)} năm, thấp hơn mốc khuyến nghị để đọc mùa vụ dài hạn.`,
        'Hệ thống vẫn cho SKU đi tiếp, nhưng các chặng mùa vụ/dự báo phía sau sẽ tự hạ độ tin cậy nếu không đủ cấu trúc.',
        `${state.daily.at(0)?.date ?? 'không rõ'} → ${state.daily.at(-1)?.date ?? 'không rõ'} · ${state.daily.length} ngày`,
      ));
    }
    return [
      issue(
        'warn',
        'SKU có dưới 3 năm lịch sử',
        ids(short),
        'Các SKU này chưa đủ mốc lịch sử khuyến nghị để đánh giá mùa vụ đáng tin cậy. Hệ thống vẫn xử lý bình thường qua các chặng sau, nhưng Chặng 9 sẽ đánh giá mức tin cậy thấp hơn khi kết luận mùa vụ.',
        purposeRef(1),
        undefined,
        short,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  2: states => {
    const heavy: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      const total = state.daily.length;
      const stockoutDays = state.daily.filter(row => row.isStockout).length;
      if (total > 0 && stockoutDays / total > 0.3) heavy.push(detail(
        state,
        'Tỷ lệ ngày stockout vượt 30%',
        `${stockoutDays}/${total} ngày bị gắn cờ stockout, cao hơn mức cảnh báo của báo cáo.`,
        'Hệ thống không xóa ngày stockout; các ngày này được chuyển sang Chặng 3 để tìm nền tự nhiên bằng ngày sạch xung quanh.',
        `Tỷ lệ ${fmt(stockoutDays / total * 100, 1)}%`,
      ));
    }
    return [
      issue(
        'warn',
        'SKU có trên 30% số ngày bị gắn cờ stockout',
        ids(heavy),
        'Tỷ lệ ngày thiếu hàng quá cao so với tổng số ngày quan sát — đây là dấu hiệu cảnh báo chất lượng chuỗi cung ứng thực tế, không chỉ là vấn đề kỹ thuật của mô hình.',
        purposeRef(2),
        'Ưu tiên rà soát nguồn hàng/lead time cho các SKU này trước khi tin tưởng tuyệt đối vào nền đã nâng ở Chặng 3.',
        heavy,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  3: states => {
    const insufficient: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      for (const row of state.daily.filter(item => !item.promoCode && item.baseSource === 'insufficient')) {
        insufficient.push(detail(
          state,
          `Ngày stockout ${row.date} thiếu căn cứ tính nền`,
          'Không tìm đủ ngày sạch quanh ngày stockout để tính trung vị nền.',
          'Hệ thống giữ `baseDemand=null`, không tự bịa số; ngày này có thể làm chu kỳ chứa nó không được khóa ở Chặng 5.',
          row.selectionReason || `Tham chiếu tìm được: ${row.referenceDates.length}`,
        ));
      }
    }
    return [
      issue(
        'warn',
        'SKU còn ngày stockout thiếu căn cứ tính nền',
        ids(insufficient),
        'Không đủ ngày sạch quan sát quanh ngày stockout để tính trung vị nền — hệ thống không tự bịa số nên các ngày này vẫn giữ trạng thái thiếu căn cứ, có thể khiến chu kỳ chứa nó không được khóa ở Chặng 5.',
        purposeRef(3),
        undefined,
        insufficient,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  4: states => {
    const insufficient: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      for (const row of state.daily.filter(item => !!item.promoCode && item.baseSource === 'insufficient')) {
        insufficient.push(detail(
          state,
          `Vùng CTKM tại ngày ${row.date} thiếu căn cứ chuẩn hóa`,
          `Ngày thuộc CTKM ${row.promoCode}, nhưng không đủ ngày sạch hai bên để quy về nền tự nhiên.`,
          'Hệ thống giữ `baseDemand=null`; Chặng 5 chỉ lấp kỹ thuật nếu tìm được tham chiếu hợp lệ, nếu không chu kỳ sẽ không khóa.',
          row.selectionReason || `Tham chiếu tìm được: ${row.referenceDates.length}`,
        ));
      }
    }
    return [
      issue(
        'warn',
        'SKU có vùng CTKM thiếu căn cứ chuẩn hóa',
        ids(insufficient),
        'Vùng CTKM không tìm đủ ngày sạch trong ranh giới cho phép hai bên nên chưa thể quy về mức bán tự nhiên; vùng này chờ Chặng 5 xử lý tiếp.',
        purposeRef(4),
        undefined,
        insufficient,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  5: states => {
    const empty: ReportIssueDetail[] = [];
    const unresolved: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      for (const cycle of state.cycles.filter(item => item.emptyCycle)) {
        empty.push(detail(
          state,
          `CK ${cycle.cycleIndex} (${cycle.dateStart} → ${cycle.dateEnd}) trống hoàn toàn`,
          `Toàn bộ ${cycle.days} ngày trong chu kỳ không có nền bán hợp lệ.`,
          'Hệ thống bỏ qua hoàn toàn chu kỳ này: không khóa, không cộng Yj, không đưa vào Chặng 6–11.',
          `clean=${cycle.cleanDays}, technicalFill=${cycle.technicalFillDays}, unresolved=${cycle.unresolvedDays}`,
        ));
      }
      for (const cycle of state.cycles.filter(item => !item.locked && !item.emptyCycle)) {
        unresolved.push(detail(
          state,
          `CK ${cycle.cycleIndex} (${cycle.dateStart} → ${cycle.dateEnd}) chưa đủ nền`,
          `Còn ${cycle.unresolvedDays}/${cycle.days} ngày chưa có baseDemand sau bước lấp kỹ thuật.`,
          'Hệ thống không tự lấp tiếp nếu thiếu tham chiếu hợp lệ; chu kỳ bị giữ `locked=false`, `baseDemand=0` chỉ là placeholder và không được dùng cho phân loại/dự báo.',
          `clean=${cycle.cleanDays}, stockoutLifted=${cycle.stockoutLiftedDays}, promoNormalized=${cycle.promoNormalizedDays}, technicalFill=${cycle.technicalFillDays}, unresolved=${cycle.unresolvedDays}`,
        ));
      }
    }
    return [
      issue(
        'warn',
        'SKU có chu kỳ trống hoàn toàn',
        ids(empty),
        'Không có ngày nào trong chu kỳ có dữ liệu bán — hệ thống bỏ qua hoàn toàn các chu kỳ này khi tổng hợp Yⱼ cho các chặng phân loại/dự báo sau.',
        purposeRef(5),
        undefined,
        empty,
      ),
      issue(
        'warn',
        'SKU có chu kỳ chưa đủ nền nên chưa được khóa',
        ids(unresolved),
        'Còn ngày trong chu kỳ chưa tìm được sức mua cơ bản sau bước lấp kỹ thuật — chu kỳ này không được đưa vào chuỗi học của Chặng 6 trở đi.',
        purposeRef(5),
        undefined,
        unresolved,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  6: states => {
    const notRated: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.classification.abc === 'N/A') notRated.push(detail(
        state,
        'Không xếp hạng ABC tự động',
        `SKU chỉ có ${state.classification.lockedCycles} chu kỳ khóa, thấp hơn mốc tối thiểu 6 chu kỳ.`,
        'Hệ thống gắn ABC=N/A, không đưa SKU vào xếp hạng giá trị tự động; các chặng chính sách phía sau xử lý như ngoại lệ/mã mới.',
        `N=${state.classification.lockedCycles}, V_năm=${fmt(state.classification.annualValue)}`,
      ));
    }
    return [
      issue(
        'info',
        'SKU chưa đủ điều kiện xếp hạng ABC tự động',
        ids(notRated),
        'Dưới 6 chu kỳ khóa trong cửa sổ 24 chu kỳ gần nhất — SKU chuyển chính sách mã mới/duyệt riêng thay vì được xếp hạng tự động.',
        purposeRef(6),
        undefined,
        notRated,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  7: states => {
    const groupD: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.classification.xyz === 'D') groupD.push(detail(
        state,
        'SKU rơi vào nhóm D',
        `Chuỗi không đủ ổn định hoặc không đủ chu kỳ để đo dao động tự động. N=${state.classification.n}, m=${state.classification.m}, ADI=${fmt(state.classification.adi, 2)}.`,
        'Hệ thống không ép vào X/Y/Z; SKU đi theo chính sách riêng ở Chặng 8 và luồng dự báo ngoại lệ ở Chặng 11.',
        `CV2=${fmt(state.classification.cv2, 2)}, lockedCycles=${state.classification.lockedCycles}`,
      ));
      // RULE-07-003/004 — gộp SKU bị CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW vào cùng mục
      // báo cáo với nhóm D (cùng ý nghĩa "không có X/Y/Z hợp lệ, cần xem riêng"), mô tả rõ lý do khác
      // D thật (D = lịch sử ngắn thật sự; đây là chuỗi bị chặn/toàn 0, không phải lịch sử ngắn).
      else if (state.classification.classificationStatus === 'CLASSIFICATION_BLOCKED') groupD.push(detail(
        state,
        'SKU bị chặn phân loại (không phải nhóm D thật)',
        `Cửa sổ 24 vị trí chu kỳ gần nhất theo lịch có chu kỳ ở trạng thái ${state.classification.classificationBlockReason} — không được nối các chu kỳ khóa còn lại thành chuỗi liên tục giả.`,
        'Hệ thống không gán D và không phân loại X/Y/Z; SKU cần xử lý khoảng chu kỳ chưa khóa ở Chặng 3–5 trước khi phân loại lại.',
        `lockedCycles=${state.classification.lockedCycles}`,
      ));
      else if (state.classification.classificationStatus === 'NO_POSITIVE_DEMAND_REVIEW') groupD.push(detail(
        state,
        'SKU không có nhu cầu dương (không phải nhóm D thật)',
        `${state.classification.n} chu kỳ liên tục đều khóa nhưng toàn bộ bằng 0.`,
        'Hệ thống không gán D (D dành cho lịch sử thật sự ngắn); cần chính sách Z-zero-demand đã duyệt hoặc xem xét riêng.',
        `lockedCycles=${state.classification.lockedCycles}`,
      ));
    }
    return [
      issue(
        'info',
        'SKU thuộc nhóm D hoặc bị chặn phân loại (bán thưa đặc biệt, thiếu chuỗi, đứt quãng, hoặc toàn 0)',
        ids(groupD),
        'Chuỗi quá thưa/chưa đủ chu kỳ khóa (D thật), hoặc cửa sổ phân loại bị đứt quãng/toàn 0 (CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW) — không SKU nào trong nhóm này có X/Y/Z hợp lệ; xem chi tiết từng dòng để phân biệt đúng lý do trước khi xử lý.',
        purposeRef(7),
        undefined,
        groupD,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  8: states => {
    const noServiceLevel: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.serviceLevel === null) noServiceLevel.push(detail(
        state,
        'Không có mức phục vụ tự động',
        `SKU nằm ngoài ma trận ABC×XYZ do ABC=${state.classification.abc}, XYZ=${state.classification.xyz ?? state.classification.classificationStatus}.`,
        'Hệ thống không tự gán service level; SKU cần chính sách riêng hoặc người duyệt trước khi tính tồn kho an toàn đầy đủ.',
        `capitalPriority=${state.capitalPriority}`,
      ));
    }
    return [
      issue(
        'info',
        'SKU ngoài ma trận chính sách (không có mức phục vụ tự động)',
        ids(noServiceLevel),
        'SKU thuộc nhóm D hoặc chưa xếp ABC nên không được gán mức phục vụ/ưu tiên vốn từ ma trận 9 ô — cần chính sách hoặc duyệt riêng.',
        purposeRef(8),
        undefined,
        noServiceLevel,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  9: states => {
    const insufficientStructure: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.seasonality === 'insufficient-structure') insufficientStructure.push(detail(
        state,
        'Không đủ vòng dữ liệu để kết luận mùa vụ',
        `SKU nhóm Y nhưng chưa đủ 2 vòng mùa vụ đầy đủ từ chuỗi chu kỳ khóa.`,
        'Hệ thống không kết luận mùa vụ; SKU được chuyển sang kiểm tra xu hướng ở Chặng 10.',
        `lockedCycles=${state.classification.lockedCycles}, seasonality=${state.seasonality}`,
      ));
    }
    return [
      issue(
        'info',
        'SKU nhóm Y chưa đủ vòng dữ liệu để kết luận mùa vụ',
        ids(insufficientStructure),
        'Cần tối thiểu 2 vòng mùa vụ đầy đủ (48 chu kỳ khóa) mới được kết luận; SKU này chưa đủ nên chuyển sang kiểm tra xu hướng ở Chặng 10.',
        purposeRef(9),
        undefined,
        insufficientStructure,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  10: states => {
    const needsReview: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      const [g1, g2] = state.trendRates;
      if (Math.max(Math.abs(g1 ?? 0), Math.abs(g2 ?? 0)) > 0.15) needsReview.push(detail(
        state,
        'Tốc độ đổi xu hướng vượt 15%',
        `Một trong hai đoạn xu hướng vượt ngưỡng an toàn: g1=${fmt((g1 ?? 0) * 100, 1)}%, g2=${fmt((g2 ?? 0) * 100, 1)}%.`,
        'Hệ thống chặn tốc độ dự phóng để tránh dự báo tăng/giảm quá đà.',
        `trend=${state.trend}`,
      ));
    }
    return [
      issue(
        'warn',
        'SKU có mức đổi xu hướng vượt 15%, đã bị giới hạn tốc độ',
        ids(needsReview),
        'Mức thay đổi giữa các đoạn vượt ngưỡng an toàn 15% nên tốc độ dự phóng xu hướng bị chặn lại để tránh dự báo tăng/giảm quá đà.',
        purposeRef(10),
        undefined,
        needsReview,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  11: states => {
    const notLocked: ReportIssueDetail[] = [];
    const lowReliability: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.forecast && state.forecast.lockStatus !== 'locked') notLocked.push(detail(
        state,
        `Mô hình ${state.forecast.model} ở trạng thái ${state.forecast.lockStatus.toUpperCase()}`,
        state.forecast.reason,
        'Hệ thống không tự khóa mô hình; kết quả dự báo chỉ là đầu ra cần người có thẩm quyền xem xét trước khi dùng chính thức.',
        `WAPE=${fmt((state.forecast.wape ?? 0) * 100, 1)}%, reliability=${state.forecast.reliability}`,
      ));
      if (state.forecast?.reliability === 'low') lowReliability.push(detail(
        state,
        'Tập TEST dưới 3 chu kỳ',
        'Số chu kỳ kiểm tra quá ít nên so sánh sai số giữa các mô hình không đủ chắc.',
        'Hệ thống hạ độ tin cậy, không dùng kết quả này để tự động chọn mô hình tốt nhất.',
        `model=${state.forecast.model}, WAPE=${fmt((state.forecast.wape ?? 0) * 100, 1)}%`,
      ));
    }
    return [
      issue(
        'critical',
        'Mô hình dự báo chưa được khóa (đang REVIEW/EXCEPTION)',
        ids(notLocked),
        'Ngưỡng P25 chính thức theo ABC×XYZ chưa được ban hành nên hệ thống không tự khóa mô hình dự báo — dự báo hiển thị vẫn cần người có thẩm quyền xem xét trước khi dùng chính thức.',
        purposeRef(11),
        'Đề xuất: ưu tiên ban hành ngưỡng P25 chính thức để giảm số SKU tồn đọng ở trạng thái REVIEW.',
        notLocked,
      ),
      issue(
        'info',
        'SKU có độ tin cậy so sánh mô hình thấp (TEST dưới 3 chu kỳ)',
        ids(lowReliability),
        'Tập kiểm tra quá ngắn nên kết quả so sánh WAPE giữa các mô hình không đủ tin cậy để tự động chọn mô hình tốt nhất.',
        purposeRef(11),
        undefined,
        lowReliability,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  12: states => {
    const notAuto: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.promoConfidence !== 'auto' && state.promoConfidence !== 'none') notAuto.push(detail(
        state,
        `Hệ số CTKM ở trạng thái ${state.promoConfidence}`,
        'Chưa có đủ mẫu CTKM lịch sử hợp lệ hoặc hệ số học được chưa đủ chắc để tự khóa.',
        'Hệ thống giữ hệ số ở mức cần duyệt, không tự nâng thành hệ số tự động.',
        `K=${fmt(state.promoFactor, 2)}`,
      ));
    }
    return [
      issue(
        'warn',
        'Hệ số CTKM chưa đạt độ tin cậy tự động',
        ids(notAuto),
        'Chưa có đủ tối thiểu 3 vùng CTKM lịch sử hợp lệ cùng nhóm nên hệ số K chỉ ở mức gợi ý/thấp/thủ công, cần duyệt trước khi áp cho dự báo tương lai.',
        purposeRef(12),
        undefined,
        notAuto,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  13: states => {
    const blocked: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      const hasConfirmedFuturePromo = state.definition.futurePromotions.some(item => item.confirmed);
      if (hasConfirmedFuturePromo && (state.promoConfidence === 'blocked' || state.promoConfidence === 'none')) blocked.push(detail(
        state,
        'Có CTKM tương lai nhưng hệ số K bị chặn/không có',
        `Kế hoạch CTKM đã xác nhận, nhưng promoConfidence=${state.promoConfidence}.`,
        'Hệ thống giữ nguyên dự báo nền cho phần CTKM này, chưa tự cộng tác động tăng bán.',
        `Số kế hoạch CTKM xác nhận=${state.definition.futurePromotions.filter(item => item.confirmed).length}`,
      ));
    }
    return [
      issue(
        'critical',
        'Có kế hoạch CTKM tương lai đã xác nhận nhưng hệ số K bị chặn',
        ids(blocked),
        'Kế hoạch CTKM sắp diễn ra đã được xác nhận, nhưng hệ số tăng bán K đang ở trạng thái BLOCKED/KHÔNG CÓ nên dự báo cuối tạm giữ nguyên dự báo nền, chưa phản ánh tác động CTKM.',
        purposeRef(13),
        'Đề xuất: bổ sung/duyệt hệ số K thủ công cho nhóm CTKM này trước khi phiên đặt hàng chạy tới hạn.',
        blocked,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  14: (states, operationalDataStatus) => {
    const negative: ReportIssueDetail[] = [];
    const mismatch: ReportIssueDetail[] = [];
    const pendingVerification: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if ((state.freeStock ?? 0) < 0) negative.push(detail(
        state,
        'Hàng tự do âm tại mốc cuối',
        `Sau khi cộng lô xác nhận và trừ cam kết, freeStock=${fmt(state.freeStock)}.`,
        'Hệ thống giữ dấu âm làm tín hiệu thiếu hàng sớm để Chặng 16/18 xử lý, không tự sửa tồn.',
        `Số mốc nguồn hàng=${state.supplyMilestones.length}`,
      ));
      if (state.availableStockAudit?.mismatch) mismatch.push(detail(
        state,
        'Tồn thực tế nhỏ hơn phần tồn bị giữ/khóa/hư hỏng/không bán được',
        `Actual=${fmt(state.availableStockAudit.actualStock)}, loại trừ=${fmt(state.availableStockAudit.heldStock + state.availableStockAudit.damagedStock + state.availableStockAudit.blockedStock + state.availableStockAudit.unsellableStock)}.`,
        'Hệ thống đánh dấu chờ kiểm tra nguồn tồn; kết quả này không được coi là dữ liệu sạch để tự phát hành đơn.',
        `availableStock=${fmt(state.availableStockAudit.availableStock)}`,
      ));
      if (state.supplyStatus.pendingVerification) {
        for (const reason of state.supplyStatus.reasons) {
          pendingVerification.push(detail(
            state,
            'Nguồn hàng đang chờ kiểm tra',
            reason,
            'Hệ thống chuyển cờ này sang Chặng 18; dòng liên quan sẽ không tự phát hành nếu chưa được xác minh.',
            state.excludedLots.length ? `Lô bị loại=${state.excludedLots.length}` : undefined,
          ));
        }
      }
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 14),
      issue(
        'critical',
        'Dữ liệu tồn không khớp khi tính tồn có thể sử dụng ngay',
        ids(mismatch),
        'Tồn thực tế nhỏ hơn tổng hàng đang giữ/hư hỏng/khóa/không bán được — cần đối chiếu lại số liệu tồn kho vận hành trước khi tin vào hàng tự do tính ra ở chặng này.',
        purposeRef(14),
        undefined,
        mismatch,
      ),
      issue(
        'critical',
        'Nguồn hàng có dấu hiệu tính trùng, đang chờ kiểm tra',
        ids(pendingVerification),
        'Phát hiện lô hàng trùng định danh hoặc dữ liệu nguồn hàng chưa rõ ràng — Chặng 18 sẽ không tự phát hành đơn mua cho các SKU này cho đến khi được xác minh.',
        purposeRef(14),
        undefined,
        pendingVerification,
      ),
      issue(
        'critical',
        'SKU có hàng tự do âm tại mốc gần nhất',
        ids(negative),
        'Tồn có thể sử dụng ngay cộng lô đang về đã xác nhận vẫn không đủ bù phần đã cam kết — đây là tín hiệu sớm cho biết SKU sẽ thiếu hàng nếu không đặt bổ sung kịp thời.',
        purposeRef(14),
        undefined,
        negative,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  15: (states, operationalDataStatus) => {
    const policyFallback: ReportIssueDetail[] = [];
    const groupFallback: ReportIssueDetail[] = [];
    const unmet: ReportIssueDetail[] = [];
    const unfeasible: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if (state.safetyStockAudit?.method === 'policy-buffer') policyFallback.push(detail(
        state,
        'Dùng đệm chính sách thay vì công thức đầy đủ',
        state.safetyStockAudit.warnings.join(' ') || 'Thiếu dữ liệu đầu vào để tính tồn kho an toàn đầy đủ.',
        'Hệ thống không tự suy diễn đủ biến; chuyển sang policy-buffer và ghi cảnh báo cần duyệt.',
        `SS=${fmt(state.safetyStock)}, serviceLevel=${state.safetyStockAudit.serviceLevel}%`,
      ));
      if (state.safetyStockAudit?.sourceTier === 'abc-xyz-group') groupFallback.push(detail(
        state,
        'Mượn độ lệch lead time từ nhóm ABC×XYZ',
        'SKU chưa đủ lịch sử lead time riêng để tính độ lệch đáng tin cậy.',
        'Hệ thống dùng nguồn nhóm thay thế và gắn cảnh báo độ tin cậy thấp hơn.',
        `LT̄=${fmt(state.safetyStockAudit.ltBarDays, 1)} ngày, σLT=${fmt(state.safetyStockAudit.sigmaLtDays, 1)} ngày`,
      ));
      if ((state.safetyStockAudit?.unmetProtection ?? 0) > 0) unmet.push(detail(
        state,
        'Mức cần bảo vệ vượt trần thực tế',
        `Cần bảo vệ ${fmt(state.safetyStockAudit?.protection)}, nhưng không đáp ứng được ${fmt(state.safetyStockAudit?.unmetProtection)} sản phẩm.`,
        'Hệ thống ghi lại phần vượt, không tự hạ mức bảo vệ; ngoại lệ này được chuyển sang bước duyệt.',
        `maxProtectable=${fmt(state.safetyStockAudit?.maxProtectable)}`,
      ));
      if (state.safetyStockAudit?.unfeasiblePolicy) unfeasible.push(detail(
        state,
        'Không mức phục vụ ứng viên nào đạt đủ điều kiện',
        'Danh sách dò mức phục vụ không có phương án đạt đủ 4 điều kiện chính sách.',
        'Hệ thống giữ mức sàn đã khóa ở Chặng 8, không tự hạ xuống để làm đẹp kết quả.',
        `candidateCount=${state.safetyStockAudit.serviceLevelSearch.length}`,
      ));
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 15),
      issue(
        'critical',
        'Phần mức cần bảo vệ không thể đáp ứng do vượt trần tồn/sức chứa/hạn dùng',
        ids(unmet),
        'Mức cần bảo vệ (max của tồn kho an toàn và tồn trưng bày tối thiểu) vượt quá trần tồn, sức chứa kho hoặc nhu cầu bán được trong hạn dùng — hệ thống ghi lại phần vượt chứ không tự cắt, cần quyết định của người có thẩm quyền.',
        purposeRef(15),
        undefined,
        unmet,
      ),
      issue(
        'warn',
        'SKU dùng mức đệm chính sách thay vì công thức tồn kho an toàn đầy đủ',
        ids(policyFallback),
        'Thiếu ít nhất một trong các dữ liệu bắt buộc (nhu cầu bình quân, độ lệch nhu cầu, thời gian chờ, độ lệch thời gian chờ, hệ số phục vụ) nên hệ thống không tự tính tồn kho an toàn mà chuyển sang mức đệm chính sách và cần duyệt ngoại lệ.',
        purposeRef(15),
        undefined,
        policyFallback,
      ),
      issue(
        'warn',
        'Không mức phục vụ nào trong danh sách dò đạt đủ 4 điều kiện chính sách',
        ids(unfeasible),
        'Hệ thống giữ nguyên mức sàn đã khóa ở Chặng 8 thay vì tự hạ xuống, và cần duyệt ngoại lệ trước khi dùng cho các chặng sau.',
        purposeRef(15),
        undefined,
        unfeasible,
      ),
      issue(
        'info',
        'SKU dùng độ lệch lead time mượn từ nhóm ABC×XYZ (chưa đủ lịch sử riêng)',
        ids(groupFallback),
        'SKU chưa đủ cửa sổ độ lệch riêng để dùng phương pháp phân vị nên tạm mượn độ lệch của các SKU cùng ô ABC×XYZ — độ tin cậy thấp hơn so với dùng lịch sử của chính SKU.',
        purposeRef(15),
        undefined,
        groupFallback,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  16: (states, operationalDataStatus) => {
    const shortage: ReportIssueDetail[] = [];
    const expiry: ReportIssueDetail[] = [];
    const capacity: ReportIssueDetail[] = [];
    const consolidation: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if ((state.orderPlan?.shortageBeforeNewLot ?? 0) > 0) shortage.push(detail(
        state,
        'Dự kiến thiếu trước khi lô mới về',
        `Mô phỏng tồn cho thấy thiếu ${fmt(state.orderPlan?.shortageBeforeNewLot)} sản phẩm trước mốc nhận hàng.`,
        'Hệ thống giữ cảnh báo này để Chặng 17/18 ưu tiên hoặc chuyển duyệt, không tự giả lập nhập hàng sớm.',
        `orderQuantity=${fmt(state.orderPlan?.orderQuantity)}, daysToStockout=${state.orderPlan?.daysToStockout ?? 'không rõ'}`,
      ));
      if (state.orderPlan?.expiryRisk) expiry.push(detail(
        state,
        'Số đặt vượt nhu cầu bán được trong hạn dùng',
        'SKU có hạn dùng, nhưng số đặt sau làm tròn có nguy cơ lớn hơn lượng bán được trước khi hết hạn.',
        'Hệ thống không tự cắt số đặt; cảnh báo được giữ để người duyệt xem xét ở Chặng 18.',
        `shelfLifeDays=${state.definition.shelfLifeDays ?? 'không có'}, orderQuantity=${fmt(state.orderPlan.orderQuantity)}`,
      ));
      if (state.orderPlan?.capacityRisk) capacity.push(detail(
        state,
        'Số đặt vượt sức chứa kho',
        `Số đặt cộng tồn hiện có vượt sức chứa ${fmt(state.definition.warehouseCapacity)}.`,
        'Hệ thống không tự đổi lịch nhận hoặc giảm số đặt; chuyển cảnh báo sang bước duyệt.',
        `orderQuantity=${fmt(state.orderPlan.orderQuantity)}, freeStock=${fmt(state.orderPlan.freeStock)}`,
      ));
      if (state.orderPlan?.consolidationStatus === 'below-supplier-minimum') consolidation.push(detail(
        state,
        'Nhóm nhà cung cấp chưa đạt giá trị đơn tối thiểu',
        'Sau khi gộp theo nhà cung cấp/tiền tệ/kho nhận, giá trị nhóm chưa đạt ngưỡng tối thiểu.',
        'Hệ thống không tự đôn số lượng riêng một SKU; trạng thái này được chuyển sang Chặng 18 để chờ duyệt/gộp thêm.',
        `supplier=${state.definition.supplier}, orderValue≈${fmt(state.orderPlan.orderQuantity * state.definition.purchasePrice)}`,
      ));
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 16),
      issue(
        'critical',
        'Dự kiến thiếu hàng trước khi lô mới về, theo mô phỏng tồn từng chu kỳ',
        ids(shortage),
        'Mô phỏng tồn từng chu kỳ cho thấy SKU sẽ hết hàng trước khi lô nhập tiếp theo kịp về — cần xử lý sớm hơn số đặt thông thường (đẩy nhanh lô hoặc đặt bổ sung).',
        purposeRef(16),
        undefined,
        shortage,
      ),
      issue(
        'warn',
        'Số đặt vượt sức chứa kho còn trống',
        ids(capacity),
        'Số lượng đề xuất đặt cộng tồn hiện có vượt sức chứa kho — cần xem lại lịch nhận hàng hoặc quy cách mua trước khi phát hành.',
        purposeRef(16),
        undefined,
        capacity,
      ),
      issue(
        'warn',
        'Số đặt vượt nhu cầu ước tính trong hạn dùng còn lại',
        ids(expiry),
        'SKU có hạn dùng nhưng số lượng đề xuất lớn hơn nhu cầu bán được trước khi hết hạn — rủi ro tồn kho hết hạn nếu đặt đúng số này.',
        purposeRef(16),
        undefined,
        expiry,
      ),
      issue(
        'warn',
        'Chưa đạt giá trị đơn hàng tối thiểu khi gộp theo nhà cung cấp',
        ids(consolidation),
        'Tổng giá trị các dòng cùng nhà cung cấp/tiền tệ/kho nhận chưa đạt mức tối thiểu của nhà cung cấp — cần gộp thêm đơn hoặc chờ chu kỳ đặt hàng sau, không tự đôn số lượng của riêng một SKU.',
        purposeRef(16),
        undefined,
        consolidation,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  17: (states, operationalDataStatus) => {
    const cut: ReportIssueDetail[] = [];
    const overBudget: ReportIssueDetail[] = [];
    const landedCostEstimate: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if ((state.budgetAllocation?.cutQuantity ?? 0) > 0 && state.budgetAllocation?.status !== 'over-budget-proposal') cut.push(detail(
        state,
        'Số lượng bị cắt/hoãn do thiếu ngân sách',
        state.budgetAllocation?.reason ?? 'Ngân sách không đủ cấp toàn bộ số lượng đề xuất.',
        'Hệ thống cấp vốn theo rổ ưu tiên và ghi phần bị cắt; không tự sửa lại dự báo hoặc tồn kho an toàn.',
        `funded=${fmt(state.budgetAllocation?.fundedQuantity)}, cut=${fmt(state.budgetAllocation?.cutQuantity)}, status=${state.budgetAllocation?.status}`,
      ));
      if (state.budgetAllocation?.status === 'over-budget-proposal') overBudget.push(detail(
        state,
        'Tạo đề xuất duyệt vượt ngân sách',
        state.budgetAllocation.reason,
        'Hệ thống không chỉ hoãn dòng này; tạo đề xuất vượt ngân sách để người có thẩm quyền xem xét.',
        `shortfall=${fmt(state.budgetAllocation.overBudgetProposal?.shortfallValue)}, requiredQty=${fmt(state.budgetAllocation.overBudgetProposal?.requiredQuantity)}`,
      ));
      if (state.budgetAllocation?.landedCostIsEstimate) landedCostEstimate.push(detail(
        state,
        'Giá vốn kế hoạch chưa có',
        'Thiếu landed cost đã gồm cước/thuế nhập khẩu.',
        'Hệ thống tạm dùng giá mua để tính ngân sách và ghi rõ đây là ước tính.',
        `purchasePrice=${fmt(state.definition.purchasePrice)}, orderValue=${fmt(state.budgetAllocation.orderValue)}`,
      ));
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 17),
      issue(
        'critical',
        'SKU vai trò cốt lõi/chiến lược sắp hết hàng có đề xuất duyệt vượt ngân sách',
        ids(overBudget),
        'SKU thuộc vai trò cốt lõi hoặc chiến lược, sắp hết hàng trong cửa sổ đề xuất, và ngân sách kỳ không đủ để cấp — hệ thống tạo đề xuất duyệt vượt ngân sách thay vì chỉ ghi hoãn.',
        purposeRef(17),
        'Đề xuất: người có thẩm quyền xem xét duyệt bổ sung ngân sách cho các dòng này trước ngày dự kiến hết hàng.',
        overBudget,
      ),
      issue(
        'warn',
        'SKU bị cắt hoặc hoãn một phần số lượng vì thiếu ngân sách',
        ids(cut),
        'Ngân sách kỳ không đủ để cấp toàn bộ số lượng đề xuất cho mọi SKU theo đúng 7 tiêu chí ưu tiên; các dòng ưu tiên thấp hơn bị cắt hoặc hoãn trước.',
        purposeRef(17),
        'Đề xuất: xem lại ngân sách kỳ hoặc thứ tự ưu tiên vốn nếu số SKU bị cắt tăng liên tục qua nhiều phiên.',
        cut,
      ),
      issue(
        'info',
        'Giá trị đơn đặt dùng giá mua tạm thay cho giá vốn kế hoạch (chưa gồm đầy đủ chi phí nhập khẩu)',
        ids(landedCostEstimate),
        'Chưa có giá vốn kế hoạch (đã gồm cước/thuế nhập khẩu) cho các SKU này nên ngân sách đang tính trên giá mua thuần — giá trị thực tế cần cấp có thể cao hơn.',
        purposeRef(17),
        undefined,
        landedCostEstimate,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  18: (states, operationalDataStatus) => {
    const pending: ReportIssueDetail[] = [];
    const moqSurplusTrigger: ReportIssueDetail[] = [];
    const abnormalTrigger: ReportIssueDetail[] = [];
    const consolidationTrigger: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      const reasons = state.releaseDecision?.reasons ?? [];
      if (state.releaseDecision && state.releaseDecision.status !== 'issued' && state.releaseDecision.status !== 'not-issued') pending.push(detail(
        state,
        `Trạng thái phát hành: ${state.releaseDecision.status}`,
        reasons[0] ?? 'Dòng chưa đủ điều kiện phát hành tự động.',
        'Hệ thống giữ số lượng trước duyệt, không tự phát hành PO cho đến khi bổ sung thông tin hoặc được duyệt.',
        `beforeApproval=${fmt(state.releaseDecision.quantityBeforeApproval)}, released=${fmt(state.releaseDecision.releasedQuantity)}, reasons=${reasons.length}`,
      ));
      for (const reason of reasons.filter(item => item.includes('MOQ tạo tồn dư lớn'))) {
        moqSurplusTrigger.push(detail(
          state,
          'MOQ tạo tồn dư lớn',
          reason,
          'Hệ thống chuyển dòng sang chờ duyệt, không tự phát hành với phần dư này.',
          `moqSurplus=${fmt(state.orderPlan?.moqSurplus)}, orderQuantity=${fmt(state.orderPlan?.orderQuantity)}`,
        ));
      }
      for (const reason of reasons.filter(item => item.includes('tăng bất thường'))) {
        abnormalTrigger.push(detail(
          state,
          'Số lượng đặt tăng bất thường',
          reason,
          'Hệ thống chuyển dòng sang chờ duyệt để kiểm tra dự báo, dữ liệu hoặc quy cách mua.',
          `orderQuantity=${fmt(state.orderPlan?.orderQuantity)}`,
        ));
      }
      for (const reason of reasons.filter(item => item.includes('giá trị đơn hàng tối thiểu'))) {
        consolidationTrigger.push(detail(
          state,
          'Nhóm PO chưa đạt giá trị tối thiểu',
          reason,
          'Hệ thống hạ cả nhóm về chờ duyệt; không phát hành riêng lẻ từng dòng để né điều kiện gộp.',
          state.releaseDecision?.purchaseOrderGroupKey ? `PO group=${state.releaseDecision.purchaseOrderGroupKey}` : undefined,
        ));
      }
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 18),
      issue(
        'warn',
        'SKU đang chờ bổ sung thông tin hoặc chờ duyệt trước khi phát hành',
        ids(pending),
        'Có ngoại lệ đang mở hoặc còn thiếu điều kiện mua hàng (ETA, quy cách, giá mua, nhà cung cấp…) nên đơn mua chưa được tự động phát hành.',
        purposeRef(18),
        undefined,
        pending,
      ),
      issue(
        'warn',
        'MOQ tạo tồn dư lớn so với số đặt',
        ids(moqSurplusTrigger),
        'Phần dư phát sinh do làm tròn MOQ vượt tỷ lệ cho phép so với số đặt — cần người duyệt xem xét trước khi phát hành.',
        purposeRef(18),
        undefined,
        moqSurplusTrigger,
      ),
      issue(
        'warn',
        'Số lượng đặt tăng bất thường so với nhu cầu bình quân gần đây',
        ids(abnormalTrigger),
        'Số đặt vượt xa nhu cầu bình quân các chu kỳ khóa gần nhất — có thể do dự báo đột biến hoặc lỗi dữ liệu, cần kiểm tra trước khi phát hành.',
        purposeRef(18),
        undefined,
        abnormalTrigger,
      ),
      issue(
        'critical',
        'Nhóm chưa đạt giá trị đơn hàng tối thiểu sau khi gộp theo nhà cung cấp',
        ids(consolidationTrigger),
        'Sau khi gộp các dòng đủ điều kiện phát hành theo nhà cung cấp/tiền tệ/kho nhận, tổng giá trị nhóm chưa đạt mức tối thiểu — toàn bộ nhóm bị hạ về chờ duyệt, không phát hành riêng lẻ để né điều kiện gộp.',
        purposeRef(18),
        undefined,
        consolidationTrigger,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
  19: (states, operationalDataStatus) => {
    const highBaseError: ReportIssueDetail[] = [];
    const highFinalError: ReportIssueDetail[] = [];
    const futureProposal: ReportIssueDetail[] = [];
    const multiCause: ReportIssueDetail[] = [];
    for (const [id, state] of Object.entries(states)) {
      if ((state.postAudit?.baseForecastWape ?? 0) > 0.3) highBaseError.push(detail(
        state,
        'Sai số dự báo nền trên 30%',
        `WAPE_base=${fmt((state.postAudit?.baseForecastWape ?? 0) * 100, 1)}%.`,
        'Hệ thống ghi nguyên nhân vào hậu kiểm, không sửa ngược dự báo đã khóa của phiên hiện tại.',
        `primaryCause=${state.postAudit?.primaryCause ?? 'không rõ'}`,
      ));
      if ((state.postAudit?.forecastWape ?? 0) > 0.3) highFinalError.push(detail(
        state,
        'Sai số dự báo cuối trên 30%',
        `WAPE_final=${fmt((state.postAudit?.forecastWape ?? 0) * 100, 1)}%.`,
        'Hệ thống tách nguyên nhân theo chặng phát sinh để dùng cho phiên sau, không hồi tố kết quả đã phát hành.',
        `actualDemand=${fmt(state.postAudit?.actualDemand)}, stockoutUnits=${fmt(state.postAudit?.stockoutUnits)}`,
      ));
      if (state.postAudit?.proposalStatus === 'future-version') futureProposal.push(detail(
        state,
        'Có đề xuất kiểm chứng cho phiên tương lai',
        state.postAudit.proposal,
        'Hệ thống chỉ tạo đề xuất phiên sau, không thay đổi kết quả Chặng 1–18 của phiên hiện tại.',
        `primaryCause=${state.postAudit.primaryCause}`,
      ));
      if ((state.postAudit?.contributingCauses.length ?? 0) > 1) multiCause.push(detail(
        state,
        'Có nhiều nguyên nhân góp phần',
        `Phát hiện ${state.postAudit?.contributingCauses.length} nguyên nhân cùng lúc.`,
        'Hệ thống giữ đủ danh sách nguyên nhân để người vận hành không sửa nhầm một điểm duy nhất.',
        state.postAudit?.contributingCauses.join(' | '),
      ));
    }
    return [
      simulationOnlyIssue(states, operationalDataStatus, 19),
      issue(
        'warn',
        'Sai số dự báo NỀN (ngoài giai đoạn CTKM) trên 30%',
        ids(highBaseError),
        'Mô hình dự báo nền (Chặng 9–11) lệch khá xa thực tế ngay ở các chu kỳ không có CTKM — nên ưu tiên xem lại mô hình trước khi nghi ngờ hệ số CTKM hay nguồn hàng.',
        purposeRef(19),
        undefined,
        highBaseError,
      ),
      issue(
        'warn',
        'Sai số dự báo CUỐI (đã áp CTKM) trên 30%',
        ids(highFinalError),
        'Chênh lệch giữa dự báo cuối và nhu cầu thực tế khá lớn — nên tách nguyên nhân theo đúng chặng phát sinh (dự báo, CTKM, tồn kho an toàn, hay nguồn hàng trễ) trước khi kết luận mô hình sai.',
        purposeRef(19),
        undefined,
        highFinalError,
      ),
      issue(
        'info',
        'SKU có nhiều hơn một nguyên nhân góp phần vào sai lệch hậu kiểm',
        ids(multiCause),
        'Bảng tra 10 nguyên nhân phát hiện nhiều hơn một dấu hiệu cùng lúc — cần đọc kỹ từng nguyên nhân góp phần trước khi chỉ sửa một chỗ.',
        purposeRef(19),
        undefined,
        multiCause,
      ),
      issue(
        'info',
        'SKU có đề xuất kiểm chứng thay đổi cho phiên tương lai',
        ids(futureProposal),
        'Hệ thống phát hiện đủ dấu hiệu để đề xuất một thay đổi chính sách/tham số, áp dụng thử nghiệm cho phiên chạy sau — không hồi tố kết quả đã khóa của phiên hiện tại.',
        purposeRef(19),
        undefined,
        futureProposal,
      ),
    ].filter((item): item is ReportIssue => item !== null);
  },
};

export function buildSimulationReport(
  snapshots: Partial<Record<StageNumber, StageSnapshot>>,
  completedStage: number,
  runDate: string,
  operationalDataStatus: SimulationPolicy['operationalDataStatus'],
): SimulationReport {
  const sections: StageReportSection[] = [];
  let totalIssues = 0;
  let totalSkus = 0;

  for (let stageNumber = 1; stageNumber <= completedStage; stageNumber++) {
    const stage = stageNumber as StageNumber;
    const snapshot = snapshots[stage];
    if (!snapshot) continue;
    const states = snapshot.states;
    const skuIds = Object.keys(states);
    totalSkus = Math.max(totalSkus, skuIds.length);
    const checker = STAGE_CHECKERS[stage];
    const issues = checker ? checker(states, operationalDataStatus) : [];
    const flaggedSkuIds = new Set(issues.flatMap(item => item.skuIds));
    totalIssues += issues.length;
    sections.push({
      stage,
      title: `Chặng ${stage.toString().padStart(2, '0')} · ${STAGES[stage - 1]?.shortTitle ?? ''}`,
      totalSkus: skuIds.length,
      normalCount: skuIds.length - flaggedSkuIds.size,
      issues,
    });
  }

  const recommendations: string[] = [];
  const stage11 = sections.find(section => section.stage === 11);
  if (stage11?.issues.some(item => item.title.includes('chưa được khóa'))) {
    recommendations.push('Ưu tiên ban hành ngưỡng P25 chính thức theo từng ô ABC×XYZ để giảm số mô hình dự báo còn ở trạng thái REVIEW.');
  }
  const stage17 = sections.find(section => section.stage === 17);
  if (stage17?.issues.some(item => item.skuIds.length > 0)) {
    recommendations.push('Rà soát ngân sách kỳ hoặc thứ tự ưu tiên vốn nếu số SKU bị cắt/hoãn ở Chặng 17 tăng liên tục qua nhiều phiên.');
  }
  const stage14 = sections.find(section => section.stage === 14);
  if (stage14?.issues.some(item => item.skuIds.length > 0)) {
    recommendations.push('Xử lý sớm các SKU có hàng tự do âm ở Chặng 14 — đây là tín hiệu thiếu hàng sớm nhất trong toàn chuỗi 19 chặng.');
  }

  return {
    runDate,
    totalSkus,
    stagesRun: completedStage,
    totalIssues,
    sections,
    recommendations,
  };
}
