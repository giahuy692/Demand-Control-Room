import { DailyRecord, ForecastResult, SimulationPolicy, SkuPipelineState, StageNumber } from './models';
import { calculateTrend, mean, median, meetsSeasonRepeatThreshold, populationStdev, trailingLockedRun } from './math';
import { buildPromoRegionSamples } from './promo-analysis';
import { buildForecastLearning, ModelLearning, SEASON_LENGTH, fitSes, fitHolt, fitHoltWinters, runSeasonalNaive, splitSizes, testMetrics, lockedSeriesAll } from './forecast-models';
import { STAGE_TRACE_CONTRACTS, StageTraceContract } from './stage-trace-contracts';
export interface TraceValue { label: string; value: string }
export interface TraceCheck { label: string; actual: string; passed: boolean }
export interface TraceStep {
  title: string;
  detail: string;
  values?: TraceValue[];
  checks?: TraceCheck[];
  result?: string;
  substitution?: string;
  expression?: string;
  tone?: 'info' | 'good' | 'warn';
}
export interface TracePoint { date: string; label: string; kind: 'so' | 'km' | 'warn' }
export interface StageTrace {
  heading: string;
  context: string;
  pickLabel?: string;
  points?: TracePoint[];
  steps: TraceStep[];
  contract?: StageTraceContract;
}

const BALANCE_LABEL: Record<string, string> = {
  balanced: 'NỀN CÂN BẰNG TỐT',
  temporary: 'TẠM · KIỂM TRA',
  fixed: 'KHÔNG CÂN BẰNG CỐ ĐỊNH',
  insufficient: 'THIẾU CĂN CỨ',
};

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('vi-VN', { maximumFractionDigits: digits });
}

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${fmt(value * 100, digits)}%`;
}

function list(values: readonly number[], digits = 1): string {
  return values.map(value => fmt(value, digits)).join('; ');
}

export function shiftLegacyTraceText(text: string): string {
  return text
    .replace(/Chặng (\d+)(?:–(\d+))?/g, (_, startText: string, endText?: string) => {
      const start = Number(startText);
      const shiftedStart = start >= 5 ? start + 1 : start;
      if (!endText) return `Chặng ${shiftedStart}`;
      const end = Number(endText);
      return `Chặng ${shiftedStart}–${end >= 5 ? end + 1 : end}`;
    })
    .replace(/\bC(\d+)\b/g, (_, stageText: string) => {
      const stage = Number(stageText);
      return `C${stage >= 5 ? stage + 1 : stage}`;
    })
    .replace(/\bRULE-(\d{2})/g, (_, stageText: string) => {
      const stage = Number(stageText);
      return `RULE-${String(stage >= 5 ? stage + 1 : stage).padStart(2, '0')}`;
    });
}

function shiftLegacyTrace(trace: StageTrace): StageTrace {
  const shiftValue = (value: TraceValue): TraceValue => ({ label: shiftLegacyTraceText(value.label), value: shiftLegacyTraceText(value.value) });
  const shiftCheck = (check: TraceCheck): TraceCheck => ({ ...check, label: shiftLegacyTraceText(check.label), actual: shiftLegacyTraceText(check.actual) });
  return {
    heading: shiftLegacyTraceText(trace.heading),
    context: shiftLegacyTraceText(trace.context),
    pickLabel: trace.pickLabel ? shiftLegacyTraceText(trace.pickLabel) : undefined,
    points: trace.points?.map(point => ({ ...point, label: shiftLegacyTraceText(point.label) })),
    steps: trace.steps.map(step => ({
      ...step,
      title: shiftLegacyTraceText(step.title),
      detail: shiftLegacyTraceText(step.detail),
      values: step.values?.map(shiftValue),
      checks: step.checks?.map(shiftCheck),
      result: step.result ? shiftLegacyTraceText(step.result) : undefined,
      substitution: step.substitution ? shiftLegacyTraceText(step.substitution) : undefined,
      expression: step.expression ? shiftLegacyTraceText(step.expression) : undefined,
    })),
  };
}

function lockedSeries(state: Readonly<SkuPipelineState>): number[] {
  return trailingLockedRun(state.cycles).slice(-24).map(cycle => cycle.baseDemand);
}

function referenceValues(state: Readonly<SkuPipelineState>, dates: readonly string[]): number[] {
  const byDate = new Map(state.daily.map(record => [record.date, record]));
  return dates.map(date => {
    const record = byDate.get(date);
    // Chỉ dựng lại TRACE hiển thị cho các ngày đã được chọn làm tham chiếu (luôn hasRecord=true
    // theo isObservedClean), nên sales không thể null trên thực tế — `?? 0` chỉ là chốt hiển thị.
    return record ? record.baseDemand ?? record.sales ?? 0 : 0;
  });
}

/** Tái dựng vùng/cụm CTKM từ chính tập tham chiếu mà Chặng 4 đã khóa; không dùng ngưỡng ngày tự đặt. */
function promoRegions(daily: readonly DailyRecord[]): { rows: DailyRecord[]; codes: string[]; clustered: boolean }[] {
  const regions: { rows: DailyRecord[]; codes: string[]; clustered: boolean }[] = [];
  for (let index = 0; index < daily.length; index++) {
    if (!daily[index].promoCode) continue;
    const code = daily[index].promoCode!;
    const rows = [daily[index]];
    while (index + 1 < daily.length && daily[index + 1].promoCode === code) rows.push(daily[++index]);
    const previous = regions.at(-1);
    if (previous) {
      const previousReferences = previous.rows[0].referenceDates.join('|');
      const currentReferences = rows[0].referenceDates.join('|');
      if (previousReferences && previousReferences === currentReferences) {
        previous.rows.push(...rows);
        previous.codes = [...new Set([...previous.codes, code])];
        previous.clustered = true;
        continue;
      }
    }
    regions.push({ rows, codes: [code], clustered: false });
  }
  return regions;
}

/** Rút gọn nhãn điểm mốc CTKM về dạng "Tên CTKM[từ ngày - đến ngày]" để không tràn dòng khi mã chương trình dài hoặc bị gộp nhiều mã. */
function formatPromoPointLabel(codes: readonly string[], startDate: string, endDate: string, maxNameLen = 22): string {
  const primary = codes[0] ?? '';
  const truncated = primary.length > maxNameLen ? `${primary.slice(0, maxNameLen)}…` : primary;
  const extra = codes.length > 1 ? ` +${codes.length - 1} mã` : '';
  const range = startDate === endDate ? startDate : `${startDate} - ${endDate}`;
  return `${truncated}${extra}[${range}]`;
}

function stage1(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const runDate = new Date(`${policy.runDate}T00:00:00Z`);
  const historyStart = new Date(Date.UTC(runDate.getUTCFullYear() - policy.historyYears, 0, 1));
  const historyEnd = new Date(runDate);
  historyEnd.setUTCDate(historyEnd.getUTCDate() - 1);
  const totalDays = Math.round((historyEnd.getTime() - historyStart.getTime()) / 86_400_000) + 1;
  const cycles = Math.floor(totalDays / policy.cycleLength);
  return {
    heading: 'Dựng khung lịch ngày cố định của phiên',
    context: 'Chặng 1 khóa phạm vi lịch sử và lịch chu kỳ trước, sau đó mới lấy và gắn dữ liệu bán/tồn đã chốt vào đúng ngày lịch.',
    steps: [
      {
        title: 'B1 · Đọc tham số phiên',
        detail: 'Đọc ngày chạy kế hoạch, số năm lịch sử chuẩn và độ dài chu kỳ; không dùng ngày dữ liệu đầu tiên của từng SKU để thay biên phiên.',
        values: [{ label: 'Ngày chạy', value: policy.runDate }, { label: 'Số năm chuẩn', value: `${policy.historyYears}` }, { label: 'M · Độ dài chu kỳ', value: `${policy.cycleLength} ngày` }],
      },
      {
        title: 'B2 · Xác định năm lập kế hoạch',
        detail: 'Năm lập kế hoạch bằng năm của ngày chạy kế hoạch.',
        substitution: `YEAR(${policy.runDate}) = ${runDate.getUTCFullYear()}`,
      },
      {
        title: 'B3 · Xác định ngày đầu khoảng lịch sử',
        detail: `Lấy 01/01 của năm lập kế hoạch trừ ${policy.historyYears} năm.`,
        substitution: `D_start = 01/01/${runDate.getUTCFullYear()}−${policy.historyYears} = ${historyStart.toISOString().slice(0, 10)}`,
      },
      {
        title: 'B4 · Xác định ngày cuối khoảng lịch sử',
        detail: 'Ngày cuối là ngày ngay trước ngày chạy kế hoạch.',
        substitution: `D_end = ${policy.runDate} − 1 ngày = ${historyEnd.toISOString().slice(0, 10)}`,
      },
      {
        title: 'B5 · Tính số ngày lịch sử được phép đọc',
        detail: 'Đếm theo lịch ngày, không đếm theo số bản ghi của từng SKU.',
        substitution: `D = ${historyEnd.toISOString().slice(0, 10)} − ${historyStart.toISOString().slice(0, 10)} + 1 = ${fmt(totalDays, 0)} ngày`,
      },
      {
        title: 'B6 · Tạo khung lịch ngày cố định',
        detail: 'Tạo đầy đủ từng ngày từ D_start đến D_end. Giá trị 0 là dữ liệu thật; ngày thiếu bản ghi không được tự biến thành bán=0.',
        substitution: `Calendar = [${historyStart.toISOString().slice(0, 10)} … ${historyEnd.toISOString().slice(0, 10)}]`,
      },
      {
        title: 'B7 · Chia khung lịch thành chu kỳ cố định',
        detail: `Mỗi chu kỳ có đúng M=${policy.cycleLength} ngày lịch; không phụ thuộc mật độ bản ghi SKU.`,
        substitution: `N = ⌊${fmt(totalDays, 0)}/${policy.cycleLength}⌋ = ${fmt(cycles, 0)}`,
      },
      {
        title: 'B8 · Xác định chu kỳ đủ ngày và ngày dư',
        detail: 'Ngày dư ở biên giữ để kiểm toán nhưng không tạo chu kỳ học riêng.',
        substitution: `N = ⌊${fmt(totalDays, 0)} / ${policy.cycleLength}⌋ = ${fmt(cycles, 0)} · r = ${fmt(totalDays, 0)} − ${fmt(cycles, 0)}×${policy.cycleLength} = ${fmt(totalDays - cycles * policy.cycleLength, 0)}`,
        tone: 'good',
      },
      {
        title: 'B9 · Lấy bản ghi bán và tồn đã chốt trong khoảng',
        detail: 'Chỉ lấy dữ liệu nằm trong biên phiên; SKU có lịch sử ngắn vẫn được giữ với số bản ghi thật.',
        values: [{ label: 'SKU đang soi', value: state.definition.id }, { label: 'Bản ghi hợp lệ', value: fmt(state.daily.length, 0) }],
      },
      {
        title: 'B10 · Gắn bản ghi vào ngày và chu kỳ lịch, rồi bàn giao',
        detail: 'Bàn giao khoảng lịch sử, lịch chu kỳ cố định, ngày dư và dữ liệu ngày cho Chặng 2; chưa làm sạch stockout hay CTKM tại đây.',
        substitution: `${fmt(state.daily.length, 0)} bản ghi → đúng ngày lịch → ${Math.floor(state.daily.length / policy.cycleLength)} chu kỳ dữ liệu SKU`,
        tone: 'good',
      },
    ],
  };
}

function stage2(state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focus: DailyRecord | null): StageTrace {
  const stockouts = state.daily.filter(record => record.stockoutStatus !== 'NONE');
  const points: TracePoint[] = stockouts.slice(0, 14).map(record => ({ date: record.date, label: record.date, kind: 'so' }));
  if (focus) {
    const [cutoffHours, cutoffMinutes] = policy.cutoffHour.split(':').map(Number);
    const cutoffHour = cutoffHours + cutoffMinutes / 60;
    const lateReceipt = focus.openStock === 0 && focus.closeStock !== null && focus.closeStock > 0 && focus.receiptHour !== null && focus.receiptHour > cutoffHour;
    const emptyAllDay = focus.openStock === 0 && focus.closeStock === 0;
    return {
      heading: `Thế số hai điều kiện stockout cho ngày ${focus.date}`,
      context: 'Hệ thống chỉ dùng đúng hai điều kiện nghiệp vụ, không thêm heuristic theo loại SKU.',
      pickLabel: `Ngày stockout đã gắn cờ (${stockouts.length})`,
      points,
      steps: [
        {
          title: 'Đọc dữ liệu tồn và phiếu nhập của ngày',
          detail: 'Tồn đầu O, tồn cuối C, giờ nhập đầu tiên h và số bán ghi nhận Q là đầu vào duy nhất.',
          values: [
            { label: 'Tồn đầu O', value: fmt(focus.openStock, 0) },
            { label: 'Tồn cuối C', value: fmt(focus.closeStock, 0) },
            { label: 'Giờ nhập h', value: focus.receiptHour === null ? 'Không có' : String(focus.receiptHour) },
            { label: 'Số bán Q', value: fmt(focus.sales, 0) },
          ],
        },
        {
          title: 'Điều kiện 1 — nhập hàng trễ hơn giờ quy định',
          detail: 'Hệ thống kiểm tra lần lượt ba dấu hiệu dưới đây. Chỉ khi cả ba đều đạt, ngày này mới được xem là nhập hàng trễ.',
          checks: [
            { label: 'Đầu ngày không còn hàng', actual: `Tồn đầu ngày: ${fmt(focus.openStock, 0)}`, passed: focus.openStock === 0 },
            { label: 'Trong ngày có hàng về', actual: `Tồn cuối ngày: ${fmt(focus.closeStock, 0)}`, passed: focus.closeStock !== null && focus.closeStock > 0 },
            { label: `Hàng về sau ${policy.cutoffHour}`, actual: `Giờ hàng về: ${focus.receiptHour ?? 'Không có'}`, passed: focus.receiptHour !== null && focus.receiptHour > cutoffHour },
          ],
          result: lateReceipt ? 'Có nhập hàng trễ — khách đến sớm có thể không mua được' : 'Không thuộc trường hợp nhập hàng trễ',
          expression: String.raw`\underbrace{${focus.openStock}=0}_{\text{đầu ngày hết hàng}}\;\land\;\underbrace{${focus.closeStock}>0}_{\text{cuối ngày có hàng}}\;\land\;\underbrace{\mathtt{${focus.receiptHour ?? '—'}}>\mathtt{${policy.cutoffHour}}}_{\text{hàng về trễ}}\;\Longrightarrow\;\mathbf{${lateReceipt ? 'ĐÚNG' : 'SAI'}}`,
          substitution: `(O=0 ∧ C>0 ∧ h>h₀) = (${focus.openStock}=0 ∧ ${focus.closeStock}>0 ∧ ${focus.receiptHour ?? '—'}>${policy.cutoffHour}) → ${lateReceipt ? 'ĐÚNG' : 'SAI'}`,
          tone: lateReceipt ? 'warn' : 'info',
        },
        {
          title: 'Điều kiện 2 — trống hàng cả ngày',
          detail: 'Hệ thống kiểm tra ba dấu hiệu để xác định cửa hàng có trống hàng suốt cả ngày hay không.',
          checks: [
            { label: 'Đầu ngày không còn hàng', actual: `Tồn đầu ngày: ${fmt(focus.openStock, 0)}`, passed: focus.openStock === 0 },
            { label: 'Cuối ngày vẫn không có hàng', actual: `Tồn cuối ngày: ${fmt(focus.closeStock, 0)}`, passed: focus.closeStock === 0 },
            { label: 'Không bán được sản phẩm nào', actual: `Số lượng bán: ${fmt(focus.sales, 0)}`, passed: focus.sales === 0 },
          ],
          result: emptyAllDay ? 'Trống hàng cả ngày' : 'Không thuộc trường hợp trống hàng cả ngày',
          expression: String.raw`\underbrace{${focus.openStock}=0}_{\text{đầu ngày hết hàng}}\;\land\;\underbrace{${focus.closeStock}=0}_{\text{cuối ngày hết hàng}}\;\land\;\underbrace{${focus.sales}=0}_{\text{không bán được}}\;\Longrightarrow\;\mathbf{${emptyAllDay ? 'ĐÚNG' : 'SAI'}}`,
          substitution: `(O=0 ∧ C=0 ∧ Q=0) = (${focus.openStock}=0 ∧ ${focus.closeStock}=0 ∧ ${focus.sales}=0) → ${emptyAllDay ? 'ĐÚNG' : 'SAI'}`,
          tone: emptyAllDay ? 'warn' : 'info',
        },
        {
          title: 'Gắn cờ và khóa kết quả',
          detail: focus.stockoutStatus !== 'NONE'
            ? `Ngày được phân loại ${focus.stockoutStatus} và chuyển sang Chặng 3.`
            : 'Cả hai điều kiện đều sai → ngày được xem là ngày bán bình thường.',
          substitution: `SO(${focus.date}) = ${focus.stockoutStatus}`,
          tone: focus.stockoutStatus !== 'NONE' ? 'warn' : 'good',
        },
      ],
    };
  }
  return {
    heading: 'Quét hai điều kiện stockout trên toàn chuỗi ngày',
    context: 'Bấm một ngày stockout bên dưới (hoặc một dòng trong bảng dữ liệu) để xem hệ thống thế số cho đúng ngày đó.',
    pickLabel: `Ngày stockout đã gắn cờ (${stockouts.length})`,
    points,
    steps: [
      { title: 'Đọc chuỗi tồn đầu / tồn cuối / phiếu nhập', detail: 'Duyệt lần lượt từng ngày trong khung lịch của phiên.', values: [{ label: 'Bản ghi được quét', value: fmt(state.daily.length, 0) }] },
      { title: 'Áp điều kiện 1 — nhập trễ', detail: `Tồn đầu bằng 0, có hàng về trong ngày nhưng sau giờ quy định ${policy.cutoffHour}.`, values: [{ label: 'Ngày nhập trễ', value: fmt(state.daily.filter(record => record.stockoutStatus === 'LATE_RECEIPT_STOCKOUT').length, 0) }] },
      { title: 'Áp điều kiện 2 — trống cả ngày', detail: 'Tồn đầu và tồn cuối đều bằng 0.', values: [{ label: 'Ngày trống cả ngày', value: fmt(state.daily.filter(record => record.stockoutStatus === 'ALL_DAY_STOCKOUT_CANDIDATE').length, 0) }] },
      { title: 'Gắn cờ và khóa', detail: 'Ngày thỏa một trong hai điều kiện được gắn cờ; cờ này là đầu vào duy nhất cho Chặng 3.', substitution: `Tổng ngày gắn cờ stockout = ${stockouts.length}`, tone: 'good' },
    ],
  };
}

function referenceSteps(state: Readonly<SkuPipelineState>, row: DailyRecord, policy: SimulationPolicy): TraceStep[] {
  const nBefore = row.beforeReferenceDates.length;
  const nAfter = row.afterReferenceDates.length;
  const k = Math.min(nBefore, nAfter, policy.maxBalancedPerSide);
  const values = referenceValues(state, row.referenceDates);
  const sorted = [...values].sort((a, b) => a - b);
  const steps: TraceStep[] = [
    {
      title: 'Quét ngày sạch quan sát hai phía',
      detail: `Lớp 1 tìm trong ±${policy.referenceRadius} ngày; nếu chưa đủ hoặc lệch phía thì mở rộng dần nhưng không quá ±${policy.maxReferenceRadius} ngày. Ngày sạch = không CTKM, không stockout, không phải nền lấp kỹ thuật.`,
      values: [
        { label: 'Ngày sạch phía trước n₋', value: fmt(nBefore, 0) },
        { label: 'Ngày sạch phía sau n₊', value: fmt(nAfter, 0) },
      ],
    },
    {
      title: 'Cân bằng tập tham chiếu',
      detail: row.selectionReason || 'Chọn số ngày bằng nhau lớn nhất ở mỗi phía, ưu tiên ngày gần nhất.',
      substitution: `k = min(n₋; n₊; ${policy.maxBalancedPerSide}) = min(${nBefore}; ${nAfter}; ${policy.maxBalancedPerSide}) = ${k} → trạng thái ${BALANCE_LABEL[row.balanceStatus ?? 'insufficient']}`,
      values: [
        { label: 'Chọn phía trước', value: row.beforeReferenceDates.join(', ') || 'Không có' },
        { label: 'Chọn phía sau', value: row.afterReferenceDates.join(', ') || 'Không có' },
      ],
      tone: row.balanceStatus === 'balanced' ? 'good' : 'warn',
    },
  ];
  if (row.referenceMedian === null) {
    steps.push({
      title: 'Không đủ căn cứ tính nền',
      detail: `Chỉ có ${values.length} ngày sạch, dưới mức tối thiểu ${policy.minimumReferences} ngày — hệ thống không tự bịa nền, giữ nguyên số bán để kiểm toán.`,
      substitution: `${values.length} < ${policy.minimumReferences} → THIẾU CĂN CỨ`,
      tone: 'warn',
    });
  } else {
    steps.push({
      title: 'Tính trung vị mức nền tham chiếu',
      detail: 'Sắp xếp sức mua cơ bản của các ngày tham chiếu sạch rồi lấy trung vị — không dùng trung bình để tránh bị giá trị lệch kéo méo.',
      substitution: `R = Median(${list(sorted)}) = ${fmt(row.referenceMedian)}`,
      tone: 'good',
    });
  }
  return steps;
}

function stage3(state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focus: DailyRecord | null): StageTrace {
  const distorted = state.daily.filter(record => record.stockoutStatus !== 'NONE' && !record.promoCode);
  const points: TracePoint[] = distorted.slice(0, 14).map(record => ({
    date: record.date,
    label: record.date,
    kind: record.baseDemandSource === 'STOCKOUT_UNRESOLVED' ? 'warn' : 'so',
  }));
  const valid = focus && focus.stockoutStatus !== 'NONE' && !focus.promoCode ? focus : null;
  if (valid) {
    const steps: TraceStep[] = [
      {
        title: 'Nhận diện điểm méo',
        detail: `Ngày ${valid.date} không thuộc CTKM và có trạng thái ${valid.stockoutStatus} — không dùng làm ngày sạch.`,
        values: [
          { label: 'Số bán ghi nhận Q', value: fmt(valid.sales, 0) },
          { label: 'Tồn đầu / cuối', value: `${fmt(valid.openStock, 0)} / ${fmt(valid.closeStock, 0)}` },
        ],
        tone: 'warn',
      },
      ...referenceSteps(state, valid, policy),
    ];
    if (valid.baseDemandSource === 'STOCKOUT_UNRESOLVED') {
      steps.push({
        title: 'Khóa trạng thái, không nâng nền',
        detail: 'Ngày được ghi THIẾU CĂN CỨ; Chặng 5 sẽ quyết định có lấp nền kỹ thuật hay không.',
        substitution: `B(${valid.date}) = null · baseDemandSource = STOCKOUT_UNRESOLVED`,
        tone: 'warn',
      });
    } else {
      steps.push({
        title: 'Khóa sức mua cơ bản của ngày',
        detail: 'Lấy trung vị ngày sạch quan sát; sales gốc vẫn giữ riêng để kiểm toán.',
        substitution: `Bₜ = Median(R) = ${fmt(valid.baseDemand)}`,
        tone: 'good',
      });
    }
    return {
      heading: `Thế số nâng nền cho ngày ${valid.date}`,
      context: 'Toàn bộ các bước dưới đây là đúng chuỗi xử lý hệ thống đã chạy cho điểm méo này.',
      pickLabel: `Điểm méo do stockout (${distorted.length})`,
      points,
      steps,
    };
  }
  return {
    heading: 'Thuật toán nâng nền ngày stockout',
    context: 'Bấm một điểm méo bên dưới (hoặc dòng đỏ trong bảng dữ liệu) để xem hệ thống thế số từng bước cho đúng ngày đó.',
    pickLabel: `Điểm méo do stockout (${distorted.length})`,
    points,
    steps: [
      { title: 'B1 · Chọn SKU — nơi bán — ngày', detail: 'Duyệt từng ngày trong dữ liệu Chặng 1.', values: [{ label: 'Số ngày', value: fmt(state.daily.length, 0) }] },
      { title: 'B2 · Kiểm tra ngày có thuộc CTKM', detail: 'Ngày CTKM bàn giao Chặng 4.', values: [{ label: 'Chờ Chặng 4', value: fmt(state.daily.filter(record => record.baseDemandSource === 'PROMOTION_UNRESOLVED').length, 0) }] },
      { title: 'B3 · Kiểm tra stockout', detail: 'Ngày sạch quan sát giữ sales/zero thật.', values: [{ label: 'Ngày sạch', value: fmt(state.daily.filter(record => record.isCleanObservedReference).length, 0) }, { label: 'Ngày cần nền', value: fmt(distorted.length, 0) }] },
      { title: 'B4 · Tìm ngày sạch trong ±7 ngày', detail: `Quét lớp đầu ±${policy.referenceRadius} ngày; ngày CTKM, stockout, lấp kỹ thuật và ngày thiếu bản ghi không được làm tham chiếu.` },
      { title: 'B5 · Cân bằng; nếu cần mở rộng tối đa ±24 ngày', detail: `k=min(n₋,n₊,${policy.maxBalancedPerSide}); ưu tiên 2+2 cân bằng, cắt phía dư trước khi dùng nền tạm. Dữ liệu ngoài khung chỉ được dùng nếu nguồn đệm thực sự tồn tại.` },
      { title: 'B6 · Tính trung vị hoặc ghi thiếu căn cứ', detail: `Có tập cân bằng ≥4 ngày → nền tốt; không tạo được 2+2 nhưng có ≥${policy.minimumReferences} ngày → nền tạm; dưới ${policy.minimumReferences} ngày → không tự tạo nền.` },
      { title: 'B7 · Tính sức mua cơ bản ngày stockout', detail: 'Bₜ=Median(Rₜ).', values: [{ label: 'Đã có nền', value: fmt(state.daily.filter(record => record.baseDemandSource === 'STOCKOUT_BASELINE').length, 0) }, { label: 'Thiếu căn cứ', value: fmt(state.daily.filter(record => record.baseDemandSource === 'STOCKOUT_UNRESOLVED').length, 0) }] },
      { title: 'B8 · Bàn giao nền và trạng thái tin cậy', detail: 'Lưu Q gốc, mức nền, ngày tham chiếu, trạng thái cân bằng và cờ kiểm tra lại cho Chặng 5/20.', tone: 'good' },
    ],
  };
}

function stage4(state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focus: DailyRecord | null): StageTrace {
  const regions = promoRegions(state.daily);
  const points: TracePoint[] = regions.slice(0, 14).map(region => ({
    date: region.rows[0].date,
    label: formatPromoPointLabel(region.codes, region.rows[0].date, region.rows.at(-1)!.date),
    kind: region.rows[0].baseDemandSource === 'PROMOTION_UNRESOLVED' ? 'warn' : 'km',
  }));
  const totalPromoDays = state.daily.filter(record => record.promoCode).length;
  const region = focus?.promoCode ? regions.find(item => item.rows.some(row => row.date === focus.date)) ?? null : null;
  if (region && focus) {
    const first = region.rows[0];
    const last = region.rows.at(-1)!;
    const steps: TraceStep[] = [
      {
        title: 'Dựng vùng bán bị CTKM làm méo',
        detail: region.clustered
          ? 'Nhiều CTKM chạy sát nhau và không thể tạo tập nền riêng hợp lệ nên được gộp thành một cụm — không dùng ngưỡng số ngày tự đặt.'
          : 'Toàn bộ ngày từ ngày bắt đầu đến ngày kết thúc chương trình được xem là một vùng méo duy nhất.',
        values: [
          { label: 'Mã chương trình', value: region.codes.join(', ') },
          { label: 'Vùng méo', value: `${first.date} → ${last.date} (${region.rows.length} ngày)` },
          { label: 'Bán ghi nhận trong vùng', value: fmt(region.rows.reduce((sum, row) => sum + (row.sales ?? 0), 0), 0) },
        ],
        tone: 'warn',
      },
      {
        title: 'Chặn ranh giới bối cảnh',
        detail: 'Không lấy ngày bên trong CTKM làm tham chiếu cho chính nó và không đi xuyên qua CTKM liền kề để lấy ngày sạch xa hơn — nền phải lấy từ bối cảnh sát vùng méo.',
      },
      ...referenceSteps(state, focus, policy),
    ];
    if (focus.baseDemandSource === 'PROMOTION_UNRESOLVED') {
      steps.push({
        title: 'Không tự tạo nền CTKM',
        detail: 'Cả hai phía đều không đủ căn cứ trong ranh giới cho phép — vùng được ghi THIẾU CĂN CỨ và bàn giao Chặng 5 xử lý.',
        substitution: `B(vùng ${region.codes.join('+')}) = null`,
        tone: 'warn',
      });
    } else {
      steps.push({
        title: 'Chuẩn hóa mọi ngày trong vùng về mức bán tự nhiên',
        detail: `Khác Chặng 3: KHÔNG dùng max(Q; R) vì số bán CTKM đã bị chương trình làm cao giả. Ngày ${focus.date} bán ${fmt(focus.sales, 0)} nhưng nền được khóa ở ${fmt(focus.baseDemand)} — phần chênh giữ riêng cho Chặng 12 học hệ số K.`,
        substitution: `Bₜ = Median(tham chiếu) = ${fmt(focus.referenceMedian)} · ∀t ∈ [${first.date} → ${last.date}]`,
        tone: 'good',
      });
    }
    return {
      heading: `Thế số chuẩn hóa vùng CTKM chứa ngày ${focus.date}`,
      context: 'Mọi ngày trong cùng vùng méo dùng chung một tập tham chiếu và một mức bán tự nhiên.',
      pickLabel: `Vùng CTKM đã xác định (${regions.length})`,
      points,
      steps,
    };
  }
  return {
    heading: 'Thuật toán đưa CTKM về mức bán tự nhiên',
    context: 'Bấm một vùng CTKM bên dưới (hoặc dòng vàng trong bảng dữ liệu) để xem hệ thống thế số cho đúng vùng đó.',
    pickLabel: `Vùng CTKM đã xác định (${regions.length})`,
    points,
    steps: [
      { title: 'B1 · Xác định vùng CTKM đúng SKU — nơi bán — mã — thời gian', detail: 'Ngày liên tục cùng mã tạo một vùng; không bù từng ngày CTKM độc lập.', values: [{ label: 'Ngày CTKM', value: fmt(totalPromoDays, 0) }, { label: 'Vùng/cụm', value: fmt(regions.length, 0) }] },
      { title: 'B2 · Xác định cụm CTKM khi không thể tạo nền riêng hợp lệ', detail: 'Chỉ gộp các CTKM sát nhau khi quy tắc tìm nền không đủ nguồn cho từng vùng; không dùng ngưỡng ngày tự đặt.', values: [{ label: 'Cụm gộp', value: fmt(regions.filter(item => item.clustered).length, 0) }] },
      { title: 'B3 · Tìm ngày sạch trước/sau và chặn ranh giới CTKM liền kề', detail: 'Không lấy ngày trong CTKM, không xuyên qua CTKM khác; lớp đầu ±7 ngày, có thể dùng vùng đệm ngoài khung nếu dữ liệu thật tồn tại.' },
      { title: 'B4 · Mở rộng tối đa ±24 ngày và cân bằng hai phía', detail: `Chọn k=min(n₋,n₊,${policy.maxBalancedPerSide}) ngày gần vùng nhất mỗi phía; cắt phía dư trước khi kết luận chưa cân bằng.` },
      { title: 'B5 · Áp nhánh nền cân bằng/tạm/cố định/thiếu căn cứ', detail: `2+2 trở lên → cân bằng tốt; không đạt 2+2 nhưng có ≥${policy.minimumReferences} ngày → tạm; cụm sát cận lịch sử có đủ nguồn một phía → cố định; dưới ngưỡng → thiếu căn cứ.` },
      { title: 'B6 · Tính mức bán tự nhiên bằng Median', detail: 'Mức bán tự nhiên của vùng bằng trung vị tập ngày sạch đã chọn; tuyệt đối không dùng max(Q,Median).' },
      { title: 'B7 · Gán cùng mức nền cho mọi ngày trong vùng', detail: 'Bₜ=Median(Rᵣ) cho mọi t thuộc vùng/cụm; giữ Q và mã CTKM riêng.', values: [{ label: 'Ngày đã chuẩn hóa', value: fmt(state.daily.filter(record => record.baseDemandSource === 'PROMOTION_BASELINE').length, 0) }, { label: 'Thiếu căn cứ', value: fmt(state.daily.filter(record => record.promoCode && record.baseDemandSource === 'PROMOTION_UNRESOLVED').length, 0) }] },
      { title: 'B8 · Bàn giao dữ liệu kiểm toán và nguồn học K', detail: 'Lưu vùng, tập tham chiếu, trạng thái nền, Q gốc và promoCode cho Chặng 5/13/20.', tone: 'good' },
    ],
  };
}

function stage5(state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focusDate: string | null): StageTrace {
  const cycle = (focusDate ? state.cycles.find(item => item.dateStart <= focusDate && focusDate <= item.dateEnd) : null)
    ?? state.cycles.filter(item => item.locked).at(-1)
    ?? state.cycles.at(-1)
    ?? null;
  const steps: TraceStep[] = [];
  if (cycle) {
    const sufficientDays = cycle.days - cycle.unresolvedDays;
    steps.push(
      {
        title: `B1 · Chọn SKU — nơi bán — chu kỳ ${cycle.cycleIndex.toString().padStart(2, '0')}`,
        detail: `Chu kỳ lịch cố định từ ${cycle.dateStart} đến ${cycle.dateEnd}.`,
      },
      {
        title: 'B2 · Đếm số ngày có sức mua cơ bản đủ căn cứ',
        detail: 'Đếm trên cột sức mua cơ bản cấp ngày sau Chặng 4; không đếm trực tiếp sales.',
        substitution: `Số ngày đủ nền = ${cycle.days} − ${cycle.unresolvedDays} = ${sufficientDays}`,
      },
      {
        title: 'B3 · Kiểm tra nhánh 0 ngày có nền',
        detail: sufficientDays === 0 ? 'Không có ngày nào đủ nền; không được lấp toàn bộ chu kỳ. Đây chưa phải kết luận không có bản ghi nguồn.' : 'Có ít nhất một ngày đủ nền → được phép xét lấp từng ngày còn thiếu.',
        substitution: cycle.emptyCycle
          ? `0/${cycle.days} ngày có nền; ${cycle.sourceRecordDays}/${cycle.days} ngày có bản ghi nguồn → không lấp toàn bộ chu kỳ`
          : `Chu kỳ này có ${sufficientDays}/${cycle.days} ngày đã có nền → được phép xét lấp từng ngày còn thiếu`,
        tone: cycle.emptyCycle ? 'warn' : 'info',
      },
      {
        title: 'B4 · Xác định ngày thiếu hoặc chưa đủ căn cứ',
        detail: cycle.unresolvedDays ? `Còn ${cycle.unresolvedDays} ngày chưa có nền sau bước lấp; chu kỳ không được học.` : 'Không còn ngày thiếu nền.',
        values: [
          { label: 'Ngày sạch', value: fmt(cycle.cleanDays, 0) },
          { label: 'Nâng nền SO', value: fmt(cycle.stockoutLiftedDays, 0) },
          { label: 'Chuẩn hóa KM', value: fmt(cycle.promoNormalizedDays, 0) },
          { label: 'Lấp kỹ thuật', value: fmt(cycle.technicalFillDays, 0) },
          { label: 'Chưa có nền', value: fmt(cycle.unresolvedDays, 0) },
        ],
      },
      {
        title: 'B5 · Tìm nguồn và lấp từng ngày thiếu',
        detail: `Tìm ngày sạch quan sát ±${policy.referenceRadius}, mở rộng tối đa ±${policy.maxReferenceRadius}, lấy tối đa 14 ngày; loại CTKM, stockout, lấp kỹ thuật và ngày thiếu bản ghi. Có ≥${policy.minimumReferences} ngày thì lấp bằng Median.`,
        values: [{ label: 'Ngày lấp kỹ thuật trong chu kỳ', value: fmt(cycle.technicalFillDays, 0) }],
      },
      {
        title: 'B6 · Kiểm tra có lấp được tất cả ngày còn thiếu',
        detail: cycle.locked
          ? 'Tất cả ngày đã có nền và chu kỳ không trống → đủ điều kiện gom.'
          : cycle.emptyCycle
            ? `0/${cycle.days} ngày có nền (${cycle.sourceRecordDays}/${cycle.days} ngày có bản ghi nguồn) → không lấp, không dùng trong phiên học.`
            : 'Vẫn còn ngày chưa đủ căn cứ nền → chu kỳ không được khóa, không đi vào chuỗi học.',
        substitution: cycle.locked
          ? `Tất cả ${cycle.days} ngày đã có sức mua cơ bản → chu kỳ này được khóa để dùng trong phiên học`
          : cycle.emptyCycle
            ? `Cả ${cycle.days} ngày đều chưa có Bₜ; có ${cycle.sourceRecordDays}/${cycle.days} ngày có bản ghi nguồn → không dùng`
            : `Còn ${cycle.unresolvedDays}/${cycle.days} ngày chưa có nền → chu kỳ này chưa được khóa, không đưa vào phiên học`,
        tone: cycle.locked ? 'good' : 'warn',
      },
      {
        title: 'B7 · Ghi thành phần kiểm toán của chu kỳ',
        detail: 'Giữ số ngày CTKM đã đưa về nền, ngày stockout nâng nền, ngày lấp kỹ thuật và nền chưa cân bằng; ngày CTKM/lấp kỹ thuật không biến thành nguồn sạch.',
        substitution: `Trong ${cycle.days} ngày: ${cycle.cleanDays} ngày sạch, ${cycle.stockoutLiftedDays} ngày đã nâng nền SO, ${cycle.promoNormalizedDays} ngày KM đã chuẩn hóa, ${cycle.technicalFillDays} ngày lấp kỹ thuật, ${cycle.unresolvedDays} ngày chưa có nền`,
      },
      {
        title: 'B8 · Tổng hợp Yⱼ và bàn giao trạng thái',
        detail: 'Chỉ cộng cột sức mua cơ bản; số bán CTKM thô không bao giờ đi vào tổng chu kỳ. Chỉ LOCKED được bàn giao cho Chặng 6–11.',
        substitution: cycle.locked
          ? `Tổng sức mua cơ bản CK${cycle.cycleIndex.toString().padStart(2, '0')} = ${list(state.daily.filter(row => row.date >= cycle.dateStart && row.date <= cycle.dateEnd).map(row => row.baseDemand ?? 0), 0).replaceAll('; ', ' + ')} = ${fmt(cycle.baseDemand)} sản phẩm → được bàn giao cho chặng sau`
          : `Chu kỳ CK${cycle.cycleIndex.toString().padStart(2, '0')} chưa khóa → không có tổng Yⱼ để bàn giao`,
        tone: cycle.locked ? 'good' : 'warn',
      },
    );
  } else {
    steps.push({ title: 'Chưa có chu kỳ để xử lý', detail: 'SKU không có dữ liệu ngày đủ để tạo một chu kỳ lịch đầy đủ.', tone: 'warn' });
  }
  return {
    heading: cycle ? `Tổng hợp chu kỳ — soi CK ${cycle.cycleIndex.toString().padStart(2, '0')}` : 'Tổng hợp chu kỳ',
    context: 'Bấm một chu kỳ chưa khóa ở cột phải (hoặc một ngày trong bảng) để soi đúng chu kỳ chứa ngày đó.',
    steps,
  };
}

function stage6(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const values = lockedSeries(state);
  const c = state.classification;
  const eligible = values.length >= 6;
  const estimatedPortfolioValue = c.valueShare > 0 ? c.annualValue / c.valueShare : 0;
  return {
    heading: 'Thế số xếp hạng ABC của SKU này',
    context: 'Đủ 8 bước theo Chặng 6 §6. “Hệ số chuẩn hóa năm” đưa lịch sử ngắn về cùng thang 24 chu kỳ; a_N chỉ là ký hiệu kỹ thuật.',
    steps: [
      {
        title: 'B1 · Liệt kê SKU đủ điều kiện',
        detail: 'Nguồn: danh mục SKU và snapshot Chặng 5. Điều kiện tự động là có ít nhất 6 chu kỳ đã khóa trong cửa sổ 24 chu kỳ gần nhất.',
        values: [{ label: 'SKU', value: state.definition.id }, { label: 'N chu kỳ khóa', value: String(c.lockedCycles) }, { label: 'Điều kiện', value: eligible ? 'Đủ điều kiện tự động' : 'Dưới 6 CK · duyệt riêng' }],
        tone: eligible ? 'good' : 'warn',
      },
      {
        title: 'B2 · Chuẩn bị N, tổng sản lượng và đơn giá',
        detail: 'Yⱼ là sức mua cơ bản của chu kỳ j đã làm sạch và khóa ở Chặng 5. P là đơn giá chuẩn trong danh mục, không phải giá khuyến mãi.',
        values: [{ label: 'N', value: `${c.lockedCycles} chu kỳ` }, { label: 'ΣYⱼ · Tổng SL kỳ', value: fmt(c.periodQuantity) }, { label: 'P · Đơn giá chuẩn', value: `${fmt(state.definition.price, 0)} ₫` }],
        substitution: `ΣYⱼ = ${values.length ? list(values) : 'không có chu kỳ khóa'} = ${fmt(c.periodQuantity)}`,
      },
      {
        title: 'B3 · Chuẩn hóa sản lượng về năm và quy đổi thành tiền',
        detail: 'Hệ số chuẩn hóa năm bằng 1 khi đủ 24 CK; bằng 24/N khi có 6–23 CK. Q_năm = ΣY × a_N và V_năm = Q_năm × P; đây là chuẩn hóa so sánh ABC, không phải dự báo.',
        values: [{ label: 'Hệ số chuẩn hóa năm (a_N)', value: c.annualizationFactor === null ? 'Không áp dụng' : fmt(c.annualizationFactor, 2) }, { label: 'Q_năm · Tổng SL năm', value: fmt(c.annualQuantity) }, { label: 'V_năm', value: eligible ? `${fmt(c.annualValue, 0)} ₫` : 'Không xếp tự động' }],
        substitution: eligible
          ? `Hệ số chuẩn hóa năm = ${c.lockedCycles >= 24 ? '1 vì N ≥ 24' : `24/${c.lockedCycles} = ${fmt(c.annualizationFactor, 2)}`} | Q_năm = ${fmt(c.periodQuantity)} × ${fmt(c.annualizationFactor, 2)} = ${fmt(c.annualQuantity)} | V_năm = ${fmt(c.annualQuantity)} × ${fmt(state.definition.price, 0)} = ${fmt(c.annualValue, 0)} ₫`
          : `N = ${c.lockedCycles} < 6 → không năm hóa, không đưa V vào tổng danh mục`,
        tone: eligible ? 'info' : 'warn',
      },
      {
        title: 'B4 · Tính tỷ trọng giá trị',
        detail: 'Tỷ trọng cho biết SKU đóng góp bao nhiêu trong tổng giá trị năm hóa của tất cả SKU đủ điều kiện; SKU N/A không tham gia mẫu số.',
        substitution: eligible ? `%V = V_SKU / V_danh_mục = ${fmt(c.annualValue, 0)} / ${fmt(estimatedPortfolioValue, 0)} = ${pct(c.valueShare)}` : '%V = 0% vì SKU không đủ điều kiện',
      },
      {
        title: 'B5 · Sắp xếp giảm dần theo giá trị',
        detail: 'Xếp trên bảng ABC riêng để không phá thứ tự dữ liệu gốc. Hạng 1 là SKU có giá trị năm hóa lớn nhất.',
        substitution: eligible ? `V_năm = ${fmt(c.annualValue, 0)} ₫ → hạng #${c.abcRank}` : 'Không có hạng tự động',
      },
      {
        title: 'B6 · Tính tỷ trọng lũy kế',
        detail: 'Dòng đầu lấy chính tỷ trọng của nó; mỗi dòng sau cộng tỷ trọng lũy kế trước với tỷ trọng SKU hiện tại.',
        substitution: eligible ? `Lũy kế tại hạng #${c.abcRank} = ${pct(c.cumulativeShare)}` : 'Không tính lũy kế cho SKU N/A',
      },
      {
        title: 'B7 · Xác định điểm cắt A/C/B',
        detail: eligible ? 'Chọn A trước theo vùng 70–80%; nếu SKU đứng đầu tự vượt 80% vẫn giữ A và ghi ngoại lệ tập trung. Chọn C từ 90% lũy kế, phần giữa là B.' : 'Dưới 6 chu kỳ khóa → N/A và chuyển chính sách mã mới/duyệt riêng.',
        substitution: eligible
          ? `hạng #${c.abcRank} · ${pct(c.cumulativeShare)} ${c.abcRank === 1 && c.cumulativeShare > policy.abcThresholds.aMaxCumulativeShare ? 'vượt ngưỡng A nhưng SKU đầu → A (ngoại lệ tập trung)' : c.cumulativeShare <= policy.abcThresholds.aMaxCumulativeShare ? 'trong ngưỡng A' : c.cumulativeShare < policy.abcThresholds.cMinCumulativeShare ? 'trong ngưỡng B' : 'đạt ngưỡng C'} → ABC = ${c.abc}`
          : `N = ${c.lockedCycles} < 6 → ABC = N/A`,
        tone: c.abc === 'N/A' ? 'warn' : 'good',
      },
      {
        title: 'B8 · Kiểm tra và bàn giao',
        detail: 'Khóa căn cứ gồm N, tổng SL kỳ, hệ số chuẩn hóa năm, tổng SL năm, giá trị, tỷ trọng, hạng, lũy kế và nhãn ABC để Chặng 8/11/15 sử dụng.',
        checks: [
          { label: 'Điều kiện dữ liệu được xử lý đúng', actual: eligible ? `${c.lockedCycles} CK · ${c.abcStatus}` : `${c.lockedCycles} CK · not-rated`, passed: eligible ? c.abc !== 'N/A' : c.abc === 'N/A' },
          { label: 'Tỷ trọng nằm trong miền 0–100%', actual: pct(c.valueShare), passed: c.valueShare >= 0 && c.valueShare <= 1 },
          { label: 'Hạng và nhãn đồng bộ', actual: c.abcRank ? `#${c.abcRank} · ${c.abc}` : 'Không xếp · N/A', passed: eligible ? c.abcRank !== null : c.abcRank === null },
        ],
        result: eligible ? `Bàn giao nhóm ${c.abc}` : 'Bàn giao ngoại lệ N/A',
        tone: eligible ? 'good' : 'warn',
      },
    ],
  };
}

function stage7(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const { classificationStatus, classificationBlockReason } = state.classification;
  if (classificationStatus === 'CLASSIFICATION_BLOCKED') {
    return {
      heading: 'Thế số phân loại XYZ/D của SKU này',
      context: 'RULE-07-003 — cửa sổ 24 vị trí chu kỳ gần nhất theo lịch có ít nhất một chu kỳ chưa khóa; không được nối các chu kỳ khóa còn lại thành chuỗi liên tục giả.',
      steps: [{
        title: 'Chặn phân loại (CLASSIFICATION_BLOCKED)',
        detail: `Cửa sổ 24 vị trí gần nhất có chu kỳ ở trạng thái ${classificationBlockReason} — không phân loại được X/Y/Z/D cho tới khi khoảng này được xử lý ở Chặng 3–5.`,
        substitution: `classificationBlockReason = ${classificationBlockReason}`,
        result: 'XYZ/D = CHẶN — không truyền X/Y/Z/D hợp lệ sang Chặng 8–11',
        tone: 'warn',
      }],
    };
  }
  if (classificationStatus === 'NO_POSITIVE_DEMAND_REVIEW') {
    return {
      heading: 'Thế số phân loại XYZ/D của SKU này',
      context: 'RULE-07-004 — cửa sổ liên tục và đủ dài (n ≥ 6) nhưng toàn bộ chu kỳ bằng 0.',
      steps: [{
        title: 'Không có nhu cầu dương (NO_POSITIVE_DEMAND_REVIEW)',
        detail: `${state.classification.n} chu kỳ liên tục đều khóa nhưng bằng 0 — không gán D (D dành cho lịch sử thật sự ngắn), không tính ADI bằng phép chia cho 0.`,
        substitution: `n = ${state.classification.n} ≥ 6 · m = 0`,
        result: 'XYZ/D = NO_POSITIVE_DEMAND_REVIEW',
        tone: 'warn',
      }],
    };
  }
  const values = lockedSeries(state);
  const positive = values.filter(value => value > 0);
  const { n, m, adi, positiveMean, positiveStdev, cv, cv2, xyz } = state.classification;
  const mu = positiveMean ?? (positive.length ? mean(positive) : 0);
  const sigma = positiveStdev ?? (positive.length ? populationStdev(positive) : 0);
  const squaredDeviationSum = positive.reduce((sum, value) => sum + (value - mu) ** 2, 0);
  const enoughData = n >= 6 && m > 0;
  return {
    heading: 'Thế số phân loại XYZ/D của SKU này',
    context: 'Đủ 9 mục từ §4.4.1–§4.4.9: kiểm tra độ dài, đo độ thưa bằng ADI, rồi mới đo dao động trên các chu kỳ dương bằng CV².',
    steps: [
      {
        title: '4.4.1 · Đọc dữ liệu đầu vào',
        detail: 'xᵢ là sức mua cơ bản tại chu kỳ khóa thứ i từ Chặng 5; n là số chu kỳ khóa trong cửa sổ tối đa 24.',
        values: [{ label: 'n', value: String(n) }, { label: 'Chuỗi x₁…xₙ', value: values.length ? list(values) : 'Rỗng' }],
        substitution: `x = [${values.length ? list(values) : '∅'}] · n = ${n}`,
      },
      {
        title: '4.4.2 · Đếm số chu kỳ có nhu cầu',
        detail: 'Mỗi chu kỳ có xᵢ > 0 đóng góp 1 qua hàm chỉ báo I; chu kỳ bằng 0 đóng góp 0.',
        substitution: `m = ΣI(xᵢ > 0) = ${m}/${n} chu kỳ có nhu cầu`,
      },
      {
        title: '4.4.3 · Tính khoảng cách phát sinh bình quân ADI',
        detail: 'ADI trả lời trung bình bao nhiêu chu kỳ mới có một lần phát sinh nhu cầu. Giá trị gần 1 là thường xuyên; càng lớn càng thưa.',
        substitution: enoughData ? `ADI = n/m = ${n}/${m} = ${fmt(adi, 3)}` : `Không tính ADI vì ${n < 6 ? `n = ${n} < 6` : 'm = 0'}`,
        tone: enoughData ? 'info' : 'warn',
      },
      {
        title: '4.4.4 · Kiểm tra nhánh bán thưa Z',
        detail: 'Nếu ADI > 1,32 thì nhu cầu đã đủ thưa để gán Z; CV² vẫn được hiển thị để kiểm toán nhưng không thay đổi nhánh Z.',
        substitution: !enoughData ? 'Chưa xét Z vì dữ liệu thuộc nhánh D' : `${fmt(adi, 3)} ${(adi ?? 0) > policy.xyzThresholds.zMinAdi ? `> ${policy.xyzThresholds.zMinAdi} → ứng viên Z` : `≤ ${policy.xyzThresholds.zMinAdi} → tiếp tục xét X/Y`}`,
        tone: enoughData && (adi ?? 0) > policy.xyzThresholds.zMinAdi ? 'warn' : 'info',
      },
      {
        title: '4.4.5 · Lọc các chu kỳ có nhu cầu',
        detail: 'Bỏ các giá trị 0 trước khi đo mức bán và dao động, vì X/Y mô tả độ ổn định của lượng bán khi nhu cầu thực sự xuất hiện.',
        substitution: `x⁺ = [${positive.length ? list(positive) : '∅'}] · m = ${m}`,
      },
      {
        title: '4.4.6 · Tính mức bán bình quân khi có nhu cầu',
        detail: 'μ là tổng sức mua của các chu kỳ dương chia cho m; không chia cho toàn bộ n chu kỳ.',
        substitution: m ? `μ = Σx⁺/m = ${fmt(positive.reduce((sum, value) => sum + value, 0))}/${m} = ${fmt(mu, 3)}` : 'm = 0 → μ không xác định',
      },
      {
        title: '4.4.7 · Tính độ lệch chuẩn khi có nhu cầu',
        detail: 'Dùng độ lệch chuẩn quần thể trên chính m chu kỳ dương. Bình phương sai lệch để phần âm và dương không triệt tiêu nhau.',
        substitution: m ? `Σ(xᵢ−μ)² = ${fmt(squaredDeviationSum, 3)} · σ = √(${fmt(squaredDeviationSum, 3)}/${m}) = ${fmt(sigma, 3)}` : 'm = 0 → σ không xác định',
      },
      {
        title: '4.4.8 · Tính CV và CV²',
        detail: 'CV chuẩn hóa độ lệch theo quy mô bán; CV² là chỉ số dùng tại ngưỡng 0,49 để tách X/Y.',
        substitution: m ? `CV = σ/μ = ${fmt(sigma, 3)}/${fmt(mu, 3)} = ${fmt(cv, 4)} · CV² = ${fmt(cv, 4)}² = ${fmt(cv2, 4)}` : 'Không đủ dữ liệu để tính CV/CV²',
      },
      {
        title: '4.4.9 · Gán nhóm X/Y/Z/D và khóa nhãn',
        detail: 'Thứ tự ưu tiên: n < 6 hoặc m = 0 → D; ADI > 1,32 → Z; còn lại CV² ≤ 0,49 → X, CV² > 0,49 → Y.',
        substitution: n < 6 || !m
          ? `${n < 6 ? `n = ${n} < 6` : 'm = 0'} → D`
          : (adi ?? 0) > policy.xyzThresholds.zMinAdi
            ? `ADI = ${fmt(adi, 3)} > 1,32 → Z`
            : `ADI = ${fmt(adi, 3)} ≤ ${policy.xyzThresholds.zMinAdi} · CV² = ${fmt(cv2, 4)} ${(cv2 ?? Infinity) <= policy.xyzThresholds.xMaxCv2 ? `≤ ${policy.xyzThresholds.xMaxCv2} → X` : `> ${policy.xyzThresholds.xMaxCv2} → Y`}`,
        result: `XYZ/D = ${xyz} · khóa và truyền sang Chặng 8–11`,
        tone: xyz === 'D' ? 'warn' : 'good',
      },
    ],
  };
}

function stage8(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const { abc, xyz } = state.classification;
  const excluded = xyz === null || xyz === 'D' || abc === 'N/A';
  const cell = `${abc}${xyz ?? state.classification.classificationStatus}`;
  return {
    heading: 'Tra ma trận chính sách cho SKU này',
    context: 'Chặng 8 chỉ tra bảng từ hai nhãn đã khóa — không tính toán lại bất kỳ số liệu nào.',
    steps: [
      { title: 'B1 · Lấy nhóm ABC từ Chặng 6', detail: 'Không tự tính lại ABC trong Chặng 8.', substitution: `ABC = ${abc}` },
      { title: 'B2 · Lấy nhóm XYZ/D từ Chặng 7', detail: 'Không tự tính lại ADI hoặc CV² trong Chặng 8.', substitution: `XYZ/D = ${xyz}` },
      {
        title: 'B3 · Ghép X/Y/Z vào ma trận 9 ô',
        detail: excluded ? 'SKU không thuộc nhánh X/Y/Z đủ điều kiện.' : `Ghép ABC=${abc} với XYZ=${xyz} thành ô ${cell}.`,
        substitution: excluded ? `${cell} ∉ Matrix₃ₓ₃ → ngoại lệ` : `${cell} ∈ Matrix₃ₓ₃`,
        tone: excluded ? 'warn' : 'good',
      },
      {
        title: 'B4 · Chuyển nhóm D sang chính sách riêng',
        detail: excluded ? 'Nhóm D/N-A chưa đủ dữ liệu nên không được gán mạnh chính sách từ ma trận.' : 'Không thuộc nhóm D → tiếp tục tra chính sách ô.',
        substitution: excluded ? 'Policy = chính sách riêng / cần duyệt' : 'Nhánh D = không áp dụng',
        tone: excluded ? 'warn' : 'info',
      },
      {
        title: 'B5 · Gán ưu tiên vốn và mức phục vụ theo đúng ô',
        detail: excluded ? 'Không tự gán mức phục vụ hoặc ưu tiên vốn mạnh cho ngoại lệ.' : 'Ưu tiên vốn thay đổi theo từng ô AX…CZ, không chỉ theo chữ A/B/C.',
        substitution: excluded ? 'ServiceLevel = null' : `${cell}: ưu tiên ${policy.capitalPriorities[cell]} · ServiceLevel = ${policy.serviceLevels[cell]}%`,
        tone: excluded ? 'warn' : 'good',
      },
      {
        title: 'B6 · Xem vai trò danh mục nếu có',
        detail: 'Dữ liệu mô phỏng chưa cấu hình vai trò danh mục/điều chỉnh được duyệt, nên giữ nguyên chính sách ma trận và ghi rõ không điều chỉnh.',
        substitution: 'CategoryRoleAdjustment = NONE',
      },
      {
        title: 'B7 · Ghi chính sách vận hành cuối cùng',
        detail: 'Lưu ô chính sách, mức phục vụ, ưu tiên vốn, lý do điều chỉnh và phiên bản chính sách.',
        values: [{ label: 'Ô chính sách', value: excluded ? 'Ngoài ma trận' : cell }, { label: 'Mức phục vụ', value: state.serviceLevel ? `${state.serviceLevel}%` : 'Duyệt riêng' }, { label: 'Ưu tiên vốn', value: state.capitalPriority }, { label: 'Phiên bản', value: policy.version }],
        tone: 'good',
      },
      { title: 'B8 · Bàn giao chính sách', detail: 'Mức phục vụ sang Chặng 15; ưu tiên vốn và ngoại lệ sang Chặng 17–18; không hồi tố phiên đã khóa.', substitution: 'C8 → C15/C16/C17/C18', tone: 'good' },
    ],
  };
}

function stage9(state: Readonly<SkuPipelineState>): StageTrace {
  if (state.classification.xyz !== 'Y') {
    return {
      heading: 'Kiểm tra mùa vụ — không áp dụng',
      context: 'Chỉ nhóm Y (dao động) mới được kiểm tra mùa vụ.',
      steps: [{
        title: 'Lọc điều kiện áp dụng',
        detail: `SKU thuộc nhóm ${state.classification.xyz ?? 'BLOCKED'}, không phải Y → bỏ qua kiểm tra mùa vụ, kết luận NOT-APPLICABLE. Nhóm X đi thẳng SES/Holt, nhóm Z đi Croston/nhịp phát sinh, nhóm D dùng kế hoạch riêng.`,
        substitution: `XYZ = ${state.classification.xyz ?? 'BLOCKED'} ≠ Y → seasonality = not-applicable`,
        tone: 'info',
      }],
    };
  }
  const values = trailingLockedRun(state.cycles).map(cycle => cycle.baseDemand);
  if (values.length < 48) {
    return {
      heading: 'Kiểm tra mùa vụ nhóm Y — thiếu cấu trúc',
      context: 'Cần tối thiểu 2 vòng mùa vụ đầy đủ (48 chu kỳ khóa) mới được kết luận.',
      steps: [
        { title: 'Lọc điều kiện áp dụng', detail: 'SKU thuộc nhóm Y → được kiểm tra mùa vụ.', substitution: 'XYZ = Y ✓' },
        {
          title: 'Kiểm tra độ dài chuỗi',
          detail: 'Một vòng mùa vụ gồm 24 chu kỳ (≈ 1 năm). Tín hiệu chỉ đáng tin khi lặp được ít nhất 2 vòng.',
          substitution: `n = ${values.length} < 48 → INSUFFICIENT-STRUCTURE, không kết luận mùa vụ`,
          tone: 'warn',
        },
      ],
    };
  }
  const rounds = Array.from({ length: Math.floor(values.length / 24) }, (_, round) => values.slice(round * 24, round * 24 + 24));
  // Tài liệu giải pháp §Chặng 10: Sₚ = Rᵣ*,ₚ (vòng GẦN NHẤT đủ căn cứ), không lấy trung bình các vòng.
  const positions = Array.from({ length: 24 }, (_, position) => {
    const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
    const sp = ratios[ratios.length - 1];
    const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
    const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
    return { position: position + 1, sp, highRepeat, lowRepeat, high: sp >= 1.15 && meetsSeasonRepeatThreshold(highRepeat), low: sp <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat) };
  });
  const flagged = positions.filter(item => item.high || item.low);
  const strongest = [...positions].sort((a, b) => Math.abs(b.sp - 1) - Math.abs(a.sp - 1))[0];
  return {
    heading: 'Thế số kiểm tra mùa vụ nhóm Y',
    context: 'Mùa vụ chỉ được xác nhận khi cùng một vị trí trong năm lặp tín hiệu ở ≥ 67% số vòng.',
    steps: [
      {
        title: 'B1 · Kiểm tra SKU thuộc nhóm Y',
        detail: 'Chỉ nhóm Y đi vào nhận diện mùa vụ.',
        substitution: 'XYZ = Y ✓',
      },
      {
        title: 'B2 · Lấy chuỗi sức mua cơ bản chu kỳ đã khóa',
        detail: 'Không dùng sales ngày thô, CTKM thô hoặc chi tiết stockout.',
        substitution: `n = ${values.length} chu kỳ khóa`,
      },
      {
        title: 'B3 · Gắn chu kỳ vào vòng và vị trí mùa vụ',
        detail: 'Mỗi vòng có 24 vị trí; chỉ dùng các vòng đầy đủ, phần lẻ cuối chuỗi không tự tạo vòng.',
        substitution: `q = ⌊${values.length}/24⌋ = ${rounds.length} vòng × 24 vị trí`,
      },
      {
        title: 'B4 · Đối chiếu cùng vị trí qua từng vòng',
        detail: 'Lập bảng sức mua/tỷ lệ cho cùng p qua các vòng r; đây là bảng kiểm toán bắt buộc.',
        substitution: `R(r,p) = Y(r,p)/Ȳ(r) · vị trí nổi bật p=${strongest.position}`,
      },
      {
        title: 'B5 · Tính hệ số mùa vụ từng vị trí',
        detail: 'S_p là tỷ lệ R của VÒNG GẦN NHẤT đủ căn cứ tại cùng vị trí — không lấy trung bình hay trung vị các vòng.',
        substitution: `S_${strongest.position} = R(vòng gần nhất, ${strongest.position}) = ${fmt(strongest.sp, 3)}`,
      },
      {
        title: 'B6 · Tính tỷ lệ lặp tín hiệu cao/thấp/trung tính',
        detail: 'Tỷ lệ 2/3 được trình bày và so như 67%; không để sai số 66,666… làm loại nhầm.',
        substitution: `p=${strongest.position}: high=${pct(strongest.highRepeat, 0)} · low=${pct(strongest.lowRepeat, 0)}`,
      },
      {
        title: 'B7 · Kết luận từng vị trí bằng ngưỡng kép',
        detail: 'LẶP CAO khi S_p≥1,15 và lặp cao≥67%; LẶP THẤP khi S_p≤0,85 và lặp thấp≥67%; còn lại CHƯA RÕ.',
        values: [{ label: 'Vị trí lặp cao', value: fmt(positions.filter(item => item.high).length, 0) }, { label: 'Vị trí lặp thấp', value: fmt(positions.filter(item => item.low).length, 0) }],
      },
      {
        title: 'B8 · Kết luận cấp SKU và bàn giao công tắc Holt-Winters',
        detail: flagged.length
          ? 'Có vị trí đạt cả hai ngưỡng → mùa vụ được XÁC NHẬN; Chặng 11 sẽ đi nhánh Holt-Winters.'
          : 'Không vị trí nào đạt đồng thời hai ngưỡng → không có mùa vụ rõ; Chặng 10 sẽ kiểm tra xu hướng.',
        substitution: `seasonality = ${state.seasonality}`,
        tone: flagged.length ? 'good' : 'info',
      },
    ],
  };
}

function stage10(state: Readonly<SkuPipelineState>): StageTrace {
  if (state.classification.xyz !== 'Y' || state.seasonality === 'confirmed') {
    const reason = state.classification.xyz !== 'Y'
      ? `SKU thuộc nhóm ${state.classification.xyz ?? 'BLOCKED'}, không phải Y → không kiểm tra xu hướng tại chặng này.`
      : 'SKU đã xác nhận mùa vụ ở Chặng 9 → đi thẳng nhánh Holt-Winters, không cần công tắc xu hướng.';
    return {
      heading: 'Kiểm tra xu hướng — không áp dụng',
      context: 'Công tắc xu hướng chỉ dành cho nhóm Y chưa có mùa vụ.',
      steps: [{ title: 'Lọc điều kiện áp dụng', detail: reason, substitution: `XYZ = ${state.classification.xyz ?? 'BLOCKED'} · seasonality = ${state.seasonality}`, tone: 'info' }],
    };
  }
  const values = lockedSeries(state);
  if (values.length < 12) {
    return {
      heading: 'Kiểm tra xu hướng — thiếu chuỗi',
      context: 'Cần đủ 12 chu kỳ khóa gần nhất để chia 3 đoạn × 4.',
      steps: [
        { title: 'Lọc điều kiện áp dụng', detail: 'Nhóm Y chưa có mùa vụ → vào kiểm tra xu hướng.', substitution: 'XYZ = Y · seasonality ≠ confirmed ✓' },
        { title: 'Kiểm tra độ dài chuỗi', detail: 'Không đủ 12 chu kỳ khóa → không kết luận xu hướng.', substitution: `n = ${values.length} < 12 → trend = insufficient`, tone: 'warn' },
      ],
    };
  }
  const recent = values.slice(-12);
  const groups = [mean(recent.slice(0, 4)), mean(recent.slice(4, 8)), mean(recent.slice(8, 12))];
  const [g1, g2] = state.trendRates;
  const trendResult = calculateTrend(values);
  const conclusion = state.trend === 'up' ? 'XU HƯỚNG TĂNG' : state.trend === 'down' ? 'XU HƯỚNG GIẢM' : 'KHÔNG CÓ XU HƯỚNG BỀN VỮNG';
  return {
    heading: 'Thế số công tắc xu hướng nhóm Y',
    context: 'Chỉ kết luận xu hướng khi cả hai mức đổi g₁ và g₂ cùng vượt ngưỡng ±5% về cùng một phía.',
    steps: [
      {
        title: 'B1 · Nhận SKU nhóm Y và trạng thái mùa vụ C9',
        detail: 'Chỉ nhóm Y chưa xác nhận mùa vụ mới chạy kiểm tra xu hướng.',
        substitution: `XYZ=Y · seasonality=${state.seasonality}`,
      },
      {
        title: 'B2 · Kiểm tra đủ 12 chu kỳ khóa gần nhất',
        detail: 'Đủ 12 chu kỳ nên được phép chia đoạn và tính xu hướng.',
        substitution: `n=${values.length} ≥ 12 ✓`,
      },
      {
        title: 'B3 · Lấy đúng 12 chu kỳ khóa gần nhất',
        detail: 'Chuỗi dùng để đo là 12 chu kỳ cuối của chuỗi khóa, theo đúng thứ tự thời gian.',
        substitution: `[${list(recent, 0)}]`,
      },
      {
        title: 'B4 · Chia đúng 3 đoạn × 4 chu kỳ',
        detail: 'Trung bình từng đoạn tạo ba mốc so sánh liên tiếp.',
        substitution: `Ȳ₁ = ${fmt(groups[0])} · Ȳ₂ = ${fmt(groups[1])} · Ȳ₃ = ${fmt(groups[2])}`,
      },
      {
        title: 'B5 · Tính g₁ và g₂ giữa các đoạn',
        detail: 'g₁ đo đoạn 1→2, g₂ đo đoạn 2→3.',
        substitution: `g₁ = (${fmt(groups[1])} − ${fmt(groups[0])}) / ${fmt(groups[0])} = ${pct(g1)} · g₂ = (${fmt(groups[2])} − ${fmt(groups[1])}) / ${fmt(groups[1])} = ${pct(g2)}`,
      },
      {
        title: 'B6 · Kiểm tra hai mức đổi cùng chiều đủ ±5%',
        detail: state.trend === 'up' || state.trend === 'down'
          ? `Cả g₁ và g₂ cùng vượt ngưỡng về một phía → ${conclusion}; Chặng 11 sẽ dùng Holt (có thành phần xu hướng).`
          : 'Hai mức đổi không cùng vượt ngưỡng về một phía → không có xu hướng bền vững; Chặng 11 sẽ dùng SES (nền ổn định).',
        substitution: `${pct(g1)} và ${pct(g2)} so với ±5% → ${conclusion}`,
        tone: 'good',
      },
      {
        title: 'B7 · Áp giới hạn an toàn xu hướng',
        detail: trendResult.needsReview ? 'Mức đổi vượt 25%: giới hạn tốc độ dự phóng về 15% và chuyển cần xem xét.' : Math.max(Math.abs(g1 ?? 0), Math.abs(g2 ?? 0)) > 0.15 ? 'Mức đổi trên 15%: giới hạn tốc độ dự phóng về 15% và ghi cảnh báo.' : 'Mức đổi nằm trong phạm vi 15%; không cần cắt.',
        substitution: `cappedRate = ${pct(trendResult.cappedRate)} · needsReview = ${trendResult.needsReview ? 'TRUE' : 'FALSE'}`,
        tone: Math.max(Math.abs(g1 ?? 0), Math.abs(g2 ?? 0)) > 0.15 ? 'warn' : 'good',
      },
      {
        title: 'B8 · Bàn giao công tắc mô hình và lý do',
        detail: state.trend === 'up' || state.trend === 'down' ? 'Có xu hướng đủ căn cứ → cho phép Chặng 11 thử Holt.' : 'Không có xu hướng đủ căn cứ → cho phép SES hoặc nền ổn định.',
        substitution: `trend=${state.trend} → modelSwitch=${state.trend === 'up' || state.trend === 'down' ? 'HOLT' : 'SES'}`,
        tone: 'good',
      },
    ],
  };
}

type RawStep = { title: string; detail: string; substitution?: string; values?: TraceValue[]; tone?: TraceStep['tone'] };

function shortCycleGateStep(forecast: ForecastResult): RawStep {
  const scan = forecast.rpScan ?? [];
  const candidates = scan.filter(entry => entry.status === 'candidate');
  const chosenEntry = forecast.pStar !== null ? scan.find(entry => entry.p === forecast.pStar) ?? null : null;

  // Bảng kết quả quét Pearson r(p) trên TRAIN
  const values: TraceValue[] = scan.map(entry => {
    if (entry.r === null) {
      return { label: `p = ${entry.p} chu kỳ`, value: 'Không tính được r (cần ≥ 2×p bản ghi trong TRAIN)' };
    }
    const isChosen = forecast.pStar === entry.p;
    const pass = entry.status === 'candidate';
    return {
      label: `p = ${entry.p} chu kỳ${isChosen ? '  ★ Được chọn làm p*' : ''}`,
      value: `r = ${fmt(entry.r, 2)} ${pass ? '≥ 0,60 → Ứng viên' : '< 0,60 → Loại'}`,
    };
  });

  // Giải thích lý do chọn p* khi có nhiều ứng viên gần hòa
  let tieExplanation = '';
  if (candidates.length >= 2 && forecast.pStar !== null) {
    const highestR = Math.max(...candidates.map(c => c.r ?? -1));
    const chosenR = chosenEntry?.r ?? 0;
    if (highestR - chosenR <= 0.05) {
      const tied = candidates.filter(c => (c.r ?? 0) >= highestR - 0.05).map(c => `p=${c.p}(r=${fmt(c.r, 2)})`);
      tieExplanation = ` Có ${tied.length} ứng viên r xấp xỉ nhau trong ngưỡng hòa 0,05: ${tied.join(', ')}. Quy tắc: chọn p nhỏ nhất để tránh mô hình phức tạp thừa [C11 §8.8] → p* = ${forecast.pStar}.`;
    }
  }

  let verdict: string;
  if (forecast.pStar === null) {
    verdict = `Không có p nào trong tập quét p=2…12 đạt r ≥ 0,60 trên TRAIN → Không mở Seasonal-naïve; giữ nguyên ${forecast.model} từ Bước 1.`;
  } else if (forecast.model === 'SeasonalNaive') {
    verdict = `p* = ${forecast.pStar} (r = ${fmt(chosenEntry?.r, 2)}).${tieExplanation} Seasonal-naïve với p* này THẮNG ${forecast.controlModel} trên TEST (WAPE ${pct(forecast.wape)} < ${pct(forecast.controlWape)}) → Seasonal-naïve được chọn [C11 §8.10].`;
  } else {
    verdict = `p* = ${forecast.pStar} (r = ${fmt(chosenEntry?.r, 2)}).${tieExplanation} Seasonal-naïve với p* này chạy thử trên TEST nhưng KHÔNG THẮNG ${forecast.controlModel} (WAPE Seasonal-naïve = ${pct(forecast.wape)}, ${forecast.controlModel} = ${pct(forecast.controlWape)}) → Giữ nguyên ${forecast.model} [C11 §8.11].`;
  }

  return {
    title: 'Cửa chu kỳ ngắn 11XY-SN — kiểm tra chu kỳ lặp ngắn',
    detail: [
      'Mục tiêu: tìm chu kỳ lặp p* (bội số 15 ngày) bằng cách quét p = 2…12 trên TRAIN.',
      `Cách tính r(p): Pearson giữa dãy hiện tại [Y₁…Yₙ₋ₚ] và dãy lùi p chu kỳ [Yₚ₊₁…Yₙ]. r gần 1 nghĩa là mẫu bán p chu kỳ trước lặp lại gần đúng p chu kỳ sau.`,
      'Tiêu chuẩn ứng viên: r ≥ 0,60 và đủ dữ liệu (≥ 2×p bản ghi trong TRAIN).',
      'Seasonal-naïve chỉ được chọn nếu WAPE trên TEST thấp hơn mô hình mặc định ở Bước 1.',
    ].join(' '),
    substitution: verdict,
    values,
    tone: forecast.model === 'SeasonalNaive' ? 'good' : 'info',
  };
}

function modelFormulaStep(forecast: ForecastResult, learning: ModelLearning | null): RawStep {
  const rows = learning?.rows ?? [];
  const row = (index: number) => rows.find(item => item.index === index) ?? null;
  const alpha = forecast.params['alpha'];
  const beta = forecast.params['beta'];
  const gamma = forecast.params['gamma'];
  switch (forecast.model) {
    case 'SES': {
      const sample = row(2);
      return {
        title: 'Tối ưu và chạy San bằng mũ đơn (SES) trên TRAIN [C11 §5]',
        detail: `Khởi tạo L₁ = Y₁. Mỗi chu kỳ t: dự báo Fₜ = Lₜ₋₁, sau đó cập nhật nền Lₜ = α·Yₜ + (1−α)·Lₜ₋₁. α tối ưu bằng Grid Search trên TRAIN, giới hạn 0,05–0,5 theo chính sách. Tham số khóa: α = ${fmt(alpha, 2)}.`,
        substitution: sample
          ? `Ví dụ chu kỳ 02: Mức nền L = ${fmt(alpha, 2)} × Y(CK02: ${fmt(sample.actual, 1)}) + ${fmt(1 - alpha, 2)} × L(CK01: ${fmt(row(1)?.actual, 1)}) = ${fmt(sample.level, 2)}`
          : `α đã khóa = ${fmt(alpha, 2)}`,
      };
    }
    case 'Holt': {
      const sample = row(3);
      return {
        title: 'Holt — mức nền và xu hướng — tối ưu và chạy trên TRAIN [C11 §6]',
        detail: `Khởi tạo L₂ = Y₂, T₂ = Y₂−Y₁. Mỗi chu kỳ t: dự báo Fₜ = Lₜ₋₁ + Tₜ₋₁, cập nhật nền Lₜ = α·Yₜ + (1−α)·(Lₜ₋₁+Tₜ₋₁), cập nhật xu hướng Tₜ = β·(Lₜ−Lₜ₋₁) + (1−β)·Tₜ₋₁. α,β tối ưu trên TRAIN (β≤α). Khi dự phóng, xu hướng bị chặn ±15% mức nền. Tham số khóa: α = ${fmt(alpha, 2)}, β = ${fmt(beta, 2)}.`,
        substitution: sample
          ? `Ví dụ chu kỳ 03: Mức nền L = ${fmt(alpha, 2)} × Y(CK03: ${fmt(sample.actual, 1)}) + ${fmt(1 - alpha, 2)} × (L(CK02: ${fmt(row(2)?.level, 1)}) + T(CK02: ${fmt(row(2)?.trend, 1)})) = ${fmt(sample.level, 2)}`
          : `α = ${fmt(alpha, 2)} · β = ${fmt(beta, 2)}`,
      };
    }
    case 'Holt-Winters': {
      const m = SEASON_LENGTH;
      const initRow = row(m + 1);
      return {
        title: `Tối ưu và chạy Holt-Winters nhân tính (m = ${m} chu kỳ/vòng) trên TRAIN [C11 §7]`,
        detail: `Khởi tạo S_i = Y_i/trungBình(vòng 1) cho i=1..${m}; L₂₅ = Y₂₅/S₁; T₂₅ = L₂₅−L₂₄. Mỗi chu kỳ t: Lₜ = α·(Yₜ/Sₜ₋ₘ)+(1−α)·(Lₜ₋₁+Tₜ₋₁); Tₜ = β·(Lₜ−Lₜ₋₁)+(1−β)·Tₜ₋₁; Sₜ = γ·(Yₜ/Lₜ)+(1−γ)·Sₜ₋ₘ. Hệ số mùa kế thừa từ vòng 24 chu kỳ trước [§7.4]. Tham số khóa: α = ${fmt(alpha, 2)}, β = ${fmt(beta, 2)}, γ = ${fmt(gamma, 2)}.`,
        substitution: initRow
          ? `Khởi tạo chu kỳ 25: Mức nền L = Y(CK25: ${fmt(initRow.actual, 1)}) / S(CK01: ${fmt(row(1)?.season, 3)}) = ${fmt(initRow.level, 2)}`
          : `α = ${fmt(alpha, 2)} · β = ${fmt(beta, 2)} · γ = ${fmt(gamma, 2)} · m = ${m}`,
      };
    }
    case 'SeasonalNaive': {
      const period = forecast.params['p'];
      const sample = rows.find(item => item.forecast !== null) ?? null;
      return {
        title: 'Seasonal-naïve — sao chép đúng vị trí vòng lặp trước [C11 §8.2, §8.9]',
        detail: `Dự báo dựa trên chu kỳ lặp ngắn p* = ${fmt(period, 0)} chu kỳ đã chọn từ Pearson correlation. Công thức dự báo sao chép nguyên trạng không qua làm mượt: Fₜ = Yₜ₋ₚ*. Khi dự phóng tương lai, hệ thống lặp lại tuần hoàn mẫu của ${fmt(period, 0)} chu kỳ cuối của lịch sử để làm dự báo nền cho đến hết chân trời dự báo [§8.9]. Cột "Nguồn F · CK" ở bảng học bên panel Dữ liệu bên trái chỉ thẳng chu kỳ nguồn của từng dòng.`,
        substitution: sample
          ? `Ví dụ chu kỳ ${String(sample.index).padStart(2, '0')}: Dự báo F = Lượng bán thực tại CK ${String(sample.index - period).padStart(2, '0')} = ${fmt(sample.forecast, 1)}`
          : `p* = ${fmt(period, 0)}`,
      };
    }
    case 'Croston': {
      const firstEvent = rows.find(item => item.actual > 0) ?? null;
      const secondEvent = firstEvent ? rows.find(item => item.index > firstEvent.index && item.actual > 0) ?? null : null;
      return {
        title: 'Croston bình quân — quy mô Z và khoảng cách P trên TRAIN [C11 §9.4–§9.5]',
        detail: `Dành riêng cho hàng bán thưa nhóm Z. Khởi tạo tại giao dịch đầu: quy mô Z = Y. P₁ chỉ được tính khi có giao dịch phát sinh thứ hai, bằng khoảng cách giữa hai chu kỳ giao dịch này (nghiêm cấm dùng khoảng cách từ đầu chuỗi) [§9.4]. Mỗi khi chu kỳ có bán Yₜ > 0: cập nhật quy mô Zₜ = α × Yₜ + (1 − α) × Zₜ₋₁ và khoảng cách trung bình Pₜ = α × Iₜ + (1 − α) × Pₜ₋₁ (với Iₜ là số chu kỳ trôi qua từ lần bán trước). Dự báo Fₜ = Zₜ / Pₜ; chu kỳ trống giữ nguyên tham số cũ [§9.5]. Bảng học (cột Z/P) nằm ở panel Dữ liệu bên trái.`,
        substitution: secondEvent
          ? `Lần phát sinh 2 (CK ${secondEvent.index}): Khoảng cách P₁ = ${secondEvent.index} − ${firstEvent!.index} = ${fmt(secondEvent.trend, 0)} · Quy mô Z = ${fmt(secondEvent.level, 2)} · Dự báo F = ${fmt(secondEvent.forecast, 2)}`
          : `α = ${fmt(alpha, 2)} · Chưa đủ 2 chu kỳ phát sinh nhu cầu để minh họa thế số`,
      };
    }
    case 'PulseRhythm': {
      const interval = forecast.params['D'];
      const quantity = forecast.params['Q'];
      return {
        title: 'Mô hình nhịp phát sinh — D và Q trên TRAIN [C11 §9.6]',
        detail: 'Áp dụng cho nhóm Z bán thưa nhưng có nhịp phát sinh đều đặn. Khoảng cách nhịp D = Median(các khoảng cách phát sinh liên tiếp trong lịch sử); quy mô Q = Median(lượng bán tại các chu kỳ phát sinh). Dự báo: F = Q tại chu kỳ rơi đúng nhịp D kể từ chu kỳ phát sinh nhu cầu gần nhất, các chu kỳ khác F = 0. Chỉ được sử dụng khi nhịp đủ ổn định (≥ 3 lần phát sinh, khoảng cách đều đặn đạt chính sách đã phê duyệt) [§9.2, §9.6].',
        substitution: `Nhịp bán D = ${fmt(interval, 0)} chu kỳ/lần · Quy mô trung vị Q = ${fmt(quantity, 1)} sản phẩm/lần`,
      };
    }
    default:
      return {
        title: 'Chạy mô hình và tối ưu tham số chỉ trên tập TRAIN',
        detail: 'Quét thô 0,1 → 0,9 rồi tinh chỉnh quanh điểm tốt nhất; tham số khóa xong không được chỉnh tiếp bằng tập kiểm tra.',
        substitution: Object.keys(forecast.params).length
          ? Object.entries(forecast.params).map(([key, value]) => `${key} = ${fmt(value as number, 2)}`).join(' · ')
          : 'Mô hình không có tham số học',
      };
  }
}

function stage11(state: Readonly<SkuPipelineState>): StageTrace {
  const forecast = state.forecast;
  if (!forecast) {
    return { heading: 'Chưa có dự báo nền', context: 'Chặng 11 chưa tạo kết quả cho SKU này.', steps: [] };
  }
  const values = lockedSeriesAll(state);

  // ── Tính toán WAPE của các mô hình ứng viên để hiển thị so sánh chéo trực quan ──
  const { trainSize: cTrain, testSize: cTest } = splitSizes(values.length);
  const candidatesList: { name: string; wape: number | null }[] = [];
  
  if (state.classification.xyz === 'X' || state.classification.xyz === 'Y') {
    // 1. SES
    try {
      const sesFit = fitSes(values, cTrain);
      const sesW = testMetrics(sesFit.run.rows).wape;
      candidatesList.push({ name: 'San bằng mũ đơn (SES)', wape: sesW });
    } catch (e) {}

    // 2. Holt
    if (values.length >= 3) {
      try {
        const holtFit = fitHolt(values, cTrain);
        const holtW = testMetrics(holtFit.run.rows).wape;
        candidatesList.push({ name: 'Holt (Có xu hướng)', wape: holtW });
      } catch (e) {}
    }

    // 3. Holt-Winters
    if (state.classification.xyz === 'Y' && state.seasonality === 'confirmed' && values.length >= SEASON_LENGTH + 2) {
      try {
        const hwFit = fitHoltWinters(values, cTrain);
        if (hwFit) {
          const hwW = testMetrics(hwFit.run.rows).wape;
          candidatesList.push({ name: 'Holt-Winters (Có mùa vụ)', wape: hwW });
        }
      } catch (e) {}
    }

    // 4. Seasonal Naive (nếu có pStar)
    if (forecast.pStar !== null) {
      try {
        const naive = runSeasonalNaive(values, forecast.pStar, cTrain);
        const naiveW = testMetrics(naive.rows).wape;
        candidatesList.push({ name: `Ngây thơ theo mùa (Seasonal-naïve, p*=${forecast.pStar})`, wape: naiveW });
      } catch (e) {}
    }
  } else if (state.classification.xyz === 'Z') {
    candidatesList.push({ name: 'Croston bình quan (Bán thưa không đều)', wape: forecast.model === 'Croston' ? forecast.wape : null });
    candidatesList.push({ name: 'Nhịp phát sinh (Bán thưa có nhịp đều)', wape: forecast.model === 'PulseRhythm' ? forecast.wape : null });
  }

  let decisionPath = '';
  if (state.classification.xyz === null) {
    // RULE-11-001 — phân loại đã bị chặn ở Chặng 7 (CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW);
    // dự báo cũng bị chặn theo, KHÔNG tự chuyển thành nhóm D.
    decisionPath = `Phân loại đã bị chặn ở Chặng 7 (${state.classification.classificationStatus}): không có nhãn X/Y/Z/D hợp lệ để chọn nhánh mô hình. Chặng 11 không tự suy diễn thành nhóm D — dự báo giữ nguyên trạng thái FORECAST_INPUT_BLOCKED cho tới khi Chặng 7 được xử lý xong.`;
  } else if (state.classification.xyz === 'D') {
    decisionPath = 'Nhóm D (Bán thưa đặc biệt hoặc Thiếu chuỗi): Do tính chất đặc thù hoặc thiếu dữ liệu lịch sử chuẩn, hệ thống KHÔNG thực hiện dự báo thống kê tự động. Kết quả được chuyển luồng ngoại lệ để chờ kế hoạch mua hàng thủ công từ Thu mua hoặc mượn nền từ một mã hàng tương tự đã duyệt [C11 §10].';
  } else if (state.classification.xyz === 'Z') {
    decisionPath = `Nhóm Z (Bán thưa): Do chuỗi bán thưa có nhiều chu kỳ trống, các mô hình SES/Holt/Holt-Winters thông thường sẽ bị nhiễu nặng và không hiệu quả. Quy tắc chọn mô hình của hệ thống như sau:\n` +
      `1. Kiểm tra nhịp phát sinh: Nếu chuỗi có ≥ 3 giao dịch bán và khoảng cách giữa các giao dịch bán hoàn toàn đều đặn bằng nhau, hệ thống tự động chọn Mô hình Nhịp Phát Sinh (PulseRhythm).\n` +
      `2. Nếu khoảng cách không đều, hệ thống chọn Croston bình quan (dự báo bằng tỷ số giữa Quy mô bán trung bình Z và Khoảng cách trung bình P) [C11 §9.2, §9.6].`;
  } else {
    // Nhóm X hoặc Y
    const isY = state.classification.xyz === 'Y';
    const hasSeason = state.seasonality === 'confirmed';
    const hasTrend = state.trend === 'up' || state.trend === 'down';
    
    decisionPath = `Nhóm ${state.classification.xyz} (Có sức mua ổn định/trung bình): Hệ thống chạy song song và đối chiếu các mô hình trên tập TEST để chọn ra mô hình tối ưu nhất (có WAPE thấp nhất). Quy tắc chọn mô hình mặc định ban đầu (Incumbent):\n`;
    if (isY && hasSeason) {
      decisionPath += `• Bước 1 (Có Mùa vụ): SKU nhóm Y có Mùa vụ được xác nhận ở Chặng 9 → Cho phép chạy Holt-Winters (HW), Holt và SES. HW là ưu tiên số 1, nhưng chỉ được chọn nếu WAPE của HW thắng tuyệt đối cả Holt và SES trên tập TEST. Nếu HW không thắng, hệ thống sẽ rơi về (fallback) Holt (nếu Holt thắng SES) hoặc SES (nếu cả hai đều thua SES) [C11 §4.3, §4.5].\n`;
    } else if (isY && hasTrend) {
      decisionPath += `• Bước 1 (Có Xu hướng): SKU nhóm Y không mùa vụ nhưng có Xu hướng ở Chặng 10 → Cho phép chạy Holt và SES. Holt được chọn nếu WAPE của nó thấp hơn SES trên tập TEST; ngược lại fallback về SES [C11 §6.6].\n`;
    } else if (isY) {
      decisionPath += `• Bước 1 (Không Mùa vụ, Không Xu hướng): SKU nhóm Y không phát hiện tín hiệu xu hướng/mùa vụ bền vững → Chọn thẳng SES để giữ nền ổn định, giảm nhiễu [C11 §4.5].\n`;
    } else {
      // Nhóm X
      decisionPath += `• Bước 1 (Nhóm X): SKU nhóm X → Dò tìm xu hướng cục bộ. Nếu phát hiện xu hướng tăng/giảm, hệ thống chạy Holt và SES, chọn Holt nếu thắng SES trên tập TEST; ngược lại chọn SES [C11 §3, nhánh 11X].\n`;
    }
    decisionPath += `• Bước 2 (Dò chu kỳ ngắn 11XY-SN): Chạy kiểm tra độc lập tương quan Pearson r(p) cho các chu kỳ lùi p = 2..12 trên tập TRAIN để tìm chu kỳ lặp ngắn p*. Nếu tìm được p* đạt r(p) ≥ 0,60 và mô hình Seasonal-naïve chạy thử với p* này THẮNG mô hình mặc định ở Bước 1 trên tập TEST (có WAPE thấp hơn), hệ thống sẽ chọn Seasonal-naïve làm dự báo nền cuối cùng. Ngược lại, giữ nguyên mô hình gốc [C11 §8.3, §8.11].`;
  }

  const rawSteps: RawStep[] = [
    {
      title: 'Chọn nhánh mô hình từ nhãn đã khóa',
      detail: `Đầu vào: XYZ = ${state.classification.xyz ?? 'BLOCKED'}, mùa vụ = ${state.seasonality}, xu hướng = ${state.trend}. C11 không tự phân loại lại SKU.\n\n${decisionPath}\n\nKết quả phân luồng thực tế của SKU này: ${forecast.reason}`,
      substitution: `Model = ${forecast.model}`,
      tone: 'info',
    },
  ];

  if (forecast.model === 'PurchasePlan') {
    rawSteps.push(
      { title: 'Kiểm tra SKU tương tự đủ tin cậy và đã duyệt', detail: 'Dữ liệu mô phỏng không có quyết định duyệt SKU tương tự; không được tự mượn nền bằng AI.', substitution: 'SimilarSkuApproved = FALSE', tone: 'warn' },
      { title: 'Kiểm tra kế hoạch/hệ số kỳ vọng từ Thu mua', detail: 'Dữ liệu mô phỏng không có kế hoạch Thu mua được duyệt cho SKU nhóm D.', substitution: 'PurchasePlanApproved = FALSE', tone: 'warn' },
      { title: 'Chuyển ngoại lệ, không tự phát hành dự báo', detail: forecast.reason, substitution: 'F_base = [] · lockStatus = EXCEPTION', tone: 'warn' },
    );
  } else {
    const testSize = cTest;
    const learning = buildForecastLearning(state).learning;
    rawSteps.push({
      title: 'Chia TRAIN/TEST theo thời gian',
      detail: '20% chu kỳ cuối chuỗi để làm TEST; tuyệt đối không trộn ngẫu nhiên vì sẽ làm lộ tương lai vào tập huấn luyện.',
      substitution: `n = ${values.length} → TRAIN = ${values.length - testSize} CK đầu · TEST = ${testSize} CK cuối`,
    });
    
    if (state.classification.xyz === 'X' || state.classification.xyz === 'Y') {
      rawSteps.push(shortCycleGateStep(forecast));
    }
    
    rawSteps.push(
      modelFormulaStep(forecast, learning),
      {
        title: 'Dự báo các chu kỳ TEST bằng tham số đã chốt',
        detail: 'Giữ nguyên tham số TRAIN, dự báo one-step-ahead; không dùng TEST để tinh chỉnh ngược tham số. Dưới đây là kết quả sai số WAPE đo lường thực tế của các mô hình ứng viên được thử nghiệm:',
        substitution: `TEST = ${testSize} chu kỳ cuối`,
        values: candidatesList.map(cand => ({
          label: `Mô hình: ${cand.name}`,
          value: cand.wape === null ? 'Không khả dụng' : `WAPE (TEST) = ${pct(cand.wape)}`
        })),
      },
      {
        title: 'Tính đủ bộ sai số bắt buộc',
        detail: 'Tính RMSE, nRMSE, WAPE và Bias. Với nhóm Z còn phải đo đúng thời điểm phát sinh và WAPE riêng chu kỳ có nhu cầu.',
        substitution: `RMSE = ${fmt(forecast.rmse, 2)} · nRMSE = ${pct(forecast.nrmse)} · WAPE = ${pct(forecast.wape)} · Bias = ${pct(forecast.bias)}`,
        values: state.classification.xyz === 'Z' ? [
          { label: 'Hit rate chu kỳ phát sinh', value: pct(forecast.hitRate) },
          { label: 'Bỏ lỡ phát sinh', value: fmt(forecast.missedPulses, 0) },
          { label: 'Phát sinh giả', value: fmt(forecast.falsePulses, 0) },
          { label: 'WAPE khi Y>0', value: pct(forecast.wapePositive) },
        ] : undefined,
      },
      {
        title: 'Đối chiếu ngưỡng của đúng nhóm ABC×XYZ',
        detail: 'Tài liệu chưa ban hành giá trị ngưỡng P25 chính thức. Vì vậy hệ thống không được dùng 35%/20% hay bất kỳ ngưỡng tự đặt nào để khóa tự động.',
        substitution: `Threshold(${state.classification.abc}${state.classification.xyz}) = CHƯA PHÊ DUYỆT → REVIEW`,
        tone: 'warn',
      },
      {
        title: 'Mô phỏng tác động vận hành trước khi khóa',
        detail: 'Tác động thiếu hàng, dư tồn, vốn khóa và số SKU cần duyệt được mô phỏng ở Chặng 16–19; trạng thái C11 vẫn REVIEW cho đến khi ngưỡng P25 chính thức được ban hành và kiểm chứng.',
        substitution: 'OperationalImpact = CHƯA ĐỦ DỮ LIỆU → không khóa tự động',
        tone: 'warn',
      },
      {
        title: 'Quyết định trạng thái mô hình',
        detail: 'Chỉ LOCKED khi vừa đạt ngưỡng đã phê duyệt vừa qua mô phỏng tác động. Hai điều kiện này chưa đủ nên kết quả là REVIEW.',
        substitution: `lockStatus = ${forecast.lockStatus.toUpperCase()}`,
        tone: 'warn',
      },
      {
        title: 'Bàn giao dự báo nền chưa áp CTKM',
        detail: 'Chuỗi vẫn được hiển thị như dự báo cần xem xét; không được mô tả là dự báo đã khóa chính thức.',
        substitution: `F_base(review) = [${list(forecast.baseForecast, 1)}]`,
        tone: 'warn',
      },
    );
  }
  const steps: TraceStep[] = rawSteps.map((step, index) => ({ ...step, title: `B${index + 1} · ${step.title}` }));
  return {
    heading: `Thế số chọn và khóa mô hình ${forecast.model}`,
    context: 'Toàn bộ quyết định nhánh lấy từ đầu ra đã khóa của Chặng 7, 9, 10.',
    steps,
  };
}

function stage12(state: Readonly<SkuPipelineState>, focus: DailyRecord | null): StageTrace {
  const regions = buildPromoRegionSamples(state.daily);
  const eligible = regions.filter(region => region.eligible);
  const rejected = regions.length - eligible.length;
  const points: TracePoint[] = eligible.slice(0, 14).map(region => ({ date: region.startDate, label: formatPromoPointLabel(region.codes, region.startDate, region.endDate), kind: 'km' }));
  const focused = focus ? eligible.find(region => region.rows.some(record => record.date === focus.date)) ?? null : null;
  const sortedK = eligible.map(region => region.factor!).sort((a, b) => a - b);
  const rawMedian = sortedK.length ? median(sortedK) : null;
  const sampleValues: TraceValue[] = eligible.slice(0, 8).map(region => ({
    label: region.startDate === region.endDate ? region.startDate : `${region.startDate} → ${region.endDate}`,
    value: `${fmt(region.actualSales, 0)} / ${fmt(region.naturalBase)} = ${fmt(region.factor, 2)}`,
  }));
  const steps: TraceStep[] = [
    {
      title: 'B1 · Nhóm CTKM lịch sử theo SKU — nơi bán — loại CTKM',
      detail: 'Mỗi mẫu là một vùng/cụm CTKM lịch sử cùng loại; không lấy từng ngày làm một mẫu và không trộn loại chương trình khác cơ chế.',
      values: [
        { label: 'Ngày CTKM lịch sử', value: fmt(state.daily.filter(record => record.promoCode).length, 0) },
        { label: 'Vùng CTKM', value: fmt(regions.length, 0) },
        { label: 'Vùng hợp lệ', value: fmt(eligible.length, 0) },
        { label: 'Vùng bị loại', value: fmt(rejected, 0) },
      ],
    },
    {
      title: 'B2 · Kiểm tra đủ nền tự nhiên và số bán ghi nhận',
      detail: 'Vùng có ngày chưa khóa nền hoặc tổng nền N≤0 bị loại và phải ghi lý do.',
      values: regions.filter(region => !region.eligible && region.rejectionReason?.includes('nền')).map(region => ({ label: `${region.startDate} → ${region.endDate}`, value: region.rejectionReason! })),
      tone: regions.some(region => !region.eligible && region.rejectionReason?.includes('nền')) ? 'warn' : 'good',
    },
    {
      title: 'B3 · Loại vùng có stockout làm méo số bán',
      detail: 'Vùng CTKM có stockout bị loại khỏi mẫu học tự động; dữ liệu vẫn được giữ cho kiểm toán.',
      values: regions.filter(region => region.rejectionReason?.includes('stockout')).map(region => ({ label: `${region.startDate} → ${region.endDate}`, value: region.rejectionReason! })),
      tone: regions.some(region => region.rejectionReason?.includes('stockout')) ? 'warn' : 'good',
    },
    {
      title: focused ? `B4 · Thế số K cho vùng ${focused.startDate} → ${focused.endDate}` : 'B4 · Tính K lịch sử cho từng vùng hợp lệ',
      detail: focused
        ? `Cộng toàn bộ số bán và nền tự nhiên của vùng ${focused.codes.join('+')}, sau đó mới chia Qᵣ/Nᵣ.`
        : 'Mỗi vùng cho đúng một hệ số Kᵣ = tổng bán ghi nhận / tổng nền tự nhiên. Bấm một vùng bên dưới để soi riêng.',
      substitution: focused
        ? `Kᵣ = Qᵣ/Nᵣ = ΣQ_d/ΣB_d = ${fmt(focused.actualSales, 0)} / ${fmt(focused.naturalBase)} = ${fmt(focused.factor, 2)}`
        : undefined,
      values: focused ? undefined : sampleValues,
      tone: focused ? 'good' : 'info',
    },
    {
      title: 'B5 · Gom các K hợp lệ của cùng nhóm CTKM',
      detail: 'Chỉ gom các vùng cùng SKU/nơi bán; mã CTKM là bằng chứng để người vận hành xác nhận cùng cơ chế, không tự đồng nhất mọi chương trình.',
      substitution: `K_history = [${list(sortedK, 2)}]`,
    },
    {
      title: 'B6 · Kiểm tra số lần lịch sử theo chính sách',
      detail: 'Ít nhất 3 vùng hợp lệ mới AUTO; 2 vùng tin cậy thấp; 1 vùng chỉ gợi ý; 0 vùng không có hệ số.',
      substitution: `r = ${eligible.length} → confidence = ${state.promoConfidence.toUpperCase()}`,
      tone: state.promoConfidence === 'auto' ? 'good' : 'warn',
    },
  ];
  if (eligible.length) {
    steps.push(
      {
        title: 'B7 · Chốt K bằng Median và áp giới hạn an toàn',
        detail: 'Trung vị chống mẫu lệch; K < 1 bị chặn về 1,00 vì CTKM không được phép "giảm" sức mua theo chính sách.',
        substitution: `K = max(1; Median(${list(sortedK, 2)})) = max(1; ${fmt(rawMedian, 2)}) = ${fmt(state.promoFactor, 2)}`,
        tone: 'good',
      },
    );
  } else {
    steps.push({
      title: 'B7 · Không có mẫu để chốt hệ số',
      detail: 'SKU không có vùng CTKM đủ căn cứ → không tạo hệ số K; Chặng 13 sẽ dùng K = 1.',
      substitution: 'K = null · confidence = NONE',
      tone: 'warn',
    });
  }
  return {
    heading: focused ? `Thế số hệ số KM — vùng ${focused.startDate}` : 'Học hệ số KM từ lịch sử',
    context: 'K đo mức tăng bán khi có chương trình; hoàn toàn khác k cân bằng của Chặng 3.',
    pickLabel: `Vùng KM hợp lệ (${eligible.length})`,
    points,
    steps,
  };
}

function stage13(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const base = state.forecast?.baseForecast ?? [];
  const factor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
  const cycleValues: TraceValue[] = base.map((value, index) => {
    const promotion = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
    const promoDays = Math.min(policy.cycleLength, promotion?.promoDays ?? 0);
    return {
      label: `CK +${index + 1}${promoDays ? ` · ${promotion!.code} · ${promoDays} ngày` : ''}`,
      value: promoDays ? `${fmt(value)} → ${fmt(state.finalForecast[index])}` : `${fmt(value)} (giữ nguyên)`,
    };
  });
  const promoIndex = base.findIndex((_, index) => state.definition.futurePromotions.some(item => item.confirmed && item.cycleOffset === index + 1));
  const samplePlan = promoIndex >= 0 ? state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === promoIndex + 1)! : null;
  const sample = promoIndex >= 0 ? base[promoIndex] : 0;
  return {
    heading: 'Thế số áp CTKM tương lai vào dự báo nền',
    context: 'Chỉ phần nền rơi vào ngày KM được nhân K — không sao chép số bán CTKM lịch sử sang tương lai.',
    steps: [
      {
        title: 'Đọc dự báo nền từ Chặng 11',
        detail: 'Dự báo nền chỉ phản ánh sức mua bình thường, chưa chứa tác động CTKM tương lai.',
        substitution: `F_base = [${list(base, 1)}]`,
      },
      {
        title: 'Kiểm tra kế hoạch CTKM tương lai đã xác nhận',
        detail: 'Chỉ kế hoạch có trạng thái xác nhận mới được ghép vào chu kỳ; kế hoạch chưa xác nhận không làm thay đổi dự báo nền.',
        values: state.definition.futurePromotions.map(item => ({ label: `CK +${item.cycleOffset} · ${item.code}`, value: `${item.promoDays}/${policy.cycleLength} ngày · ${item.confirmed ? 'ĐÃ XÁC NHẬN' : 'CHƯA XÁC NHẬN'}` })),
      },
      {
        title: 'Kiểm tra hệ số KM đủ tin cậy hoặc đã được duyệt',
        detail: state.promoConfidence === 'auto'
          ? 'Hệ số đạt AUTO từ ít nhất 3 vùng CTKM lịch sử hợp lệ nên được phép áp tự động.'
          : `Hệ số đang ở trạng thái ${state.promoConfidence.toUpperCase()}; chưa có hệ số thủ công được duyệt nên giữ K = 1 và chuyển cần duyệt.`,
        substitution: `K_applied = ${fmt(factor, 2)}`,
        tone: state.promoConfidence === 'auto' ? 'good' : 'warn',
      },
      {
        title: 'Ghép kế hoạch với đúng nhóm CTKM tương tự',
        detail: 'Mã/loại CTKM tương lai phải cùng cơ chế với các vùng lịch sử dùng để học K; hệ thống không suy diễn quan hệ tương đương chỉ từ tên mã.',
        substitution: samplePlan ? `${samplePlan.code} → cần bằng chứng cùng cơ chế trước khi coi hệ số lịch sử là tương thích` : 'Không có CTKM xác nhận → không cần ghép',
      },
      {
        title: 'Tách phần nền CTKM và tính dự báo cuối từng chu kỳ',
        detail: 'Nếu CTKM chỉ chạy một phần chu kỳ, chỉ phần nền tỷ lệ n/M được nhân K; phần ngoài CTKM giữ nguyên.',
        substitution: promoIndex >= 0 && samplePlan
          ? `F_final = ${fmt(sample)}×(1−${samplePlan.promoDays}/${policy.cycleLength}) + ${fmt(sample)}×(${samplePlan.promoDays}/${policy.cycleLength})×${fmt(factor, 2)} = ${fmt(state.finalForecast[promoIndex])}`
          : 'Không có chu kỳ CTKM xác nhận → F_final = F_base',
        values: cycleValues,
      },
      {
        title: 'Chốt dự báo cuối và lý do điều chỉnh',
        detail: 'Lưu chuỗi dự báo cuối, kế hoạch CTKM, K đã dùng và trạng thái tin cậy; không hồi tố dự báo nền Chặng 11.',
        substitution: `F_final = [${list(state.finalForecast, 1)}]`,
        tone: 'good',
      },
    ],
  };
}

function stage14(state: Readonly<SkuPipelineState>): StageTrace {
  const finalMilestone = state.supplyMilestones.at(-1);
  const audit = state.availableStockAudit;
  const milestoneValues: TraceValue[] = state.supplyMilestones.map(item => ({
    label: `${item.date} · ${item.label}`,
    value: `${fmt(item.onHand, 0)} + ${fmt(item.confirmedInbound, 0)} − ${fmt(item.committed, 0)} = ${fmt(item.freeStock, 0)}`,
  }));
  return {
    heading: 'Dựng lịch nguồn hàng và thế số hàng tự do tại từng mốc',
    context: 'Chặng 14 tính theo trục thời gian thật của nguồn hàng; không suy ra hàng về hoặc cam kết từ dự báo.',
    steps: [
      {
        title: 'Mục đích chặng · Chọn SKU và tính tồn có thể sử dụng ngay',
        detail: '"Chuẩn hóa nguồn hàng và tính vị thế tồn khả dụng" — Chặng này trước hết trừ khỏi tồn thực tế mọi phần đang giữ/hư hỏng/khóa/không bán được để ra tồn có thể sử dụng ngay (luôn ≥ 0), sau đó dùng con số này làm gốc để tính hàng tự do tại mọi mốc thời gian. Kết quả là đầu vào bắt buộc để Chặng 15–16 tính tồn kho an toàn và số cần đặt thêm.',
        substitution: audit
          ? `Tồn có thể sử dụng ngay = Tồn thực tế ${fmt(audit.actualStock, 0)} − Đang giữ ${fmt(audit.heldStock, 0)} − Hư hỏng ${fmt(audit.damagedStock, 0)} − Đang khóa ${fmt(audit.blockedStock, 0)} − Không bán được ${fmt(audit.unsellableStock, 0)} = ${fmt(audit.availableStock, 0)} sản phẩm${audit.mismatch ? ' → DỮ LIỆU TỒN KHÔNG KHỚP, cần kiểm tra lại' : ''}`
          : 'Chưa có dữ liệu tồn',
        values: [{ label: 'SKU', value: state.definition.id }, { label: 'Nhà cung cấp', value: state.definition.supplier }],
        tone: audit?.mismatch ? 'warn' : 'info',
      },
      {
        title: 'Sắp xếp mốc nguồn hàng và phân loại độ tin cậy từng lô',
        detail: 'Dùng ngày chạy, ngày cam kết và ngày dự kiến về hàng (ETA) của từng lô. CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP cho hàng giữ/hư hỏng/khóa/không bán được nên các giá trị trên mặc định 0 trừ khi được nhập tay trong dữ liệu mô phỏng; chỉ lô đã xác nhận (đã giao hoặc nhà cung cấp xác nhận) được cộng vào hàng tự do, các lô khác giữ trong kiểm toán kèm lý do loại.',
        values: [
          ...state.definition.inboundPlan.map(item => ({ label: `+${item.offsetDays} ngày · ${item.label}`, value: `${fmt(item.quantity, 0)} · ${item.reliability}` })),
          ...state.excludedLots.map(item => ({ label: `Lô bị loại · ${item.lotId}`, value: `${fmt(item.quantity, 0)} · ${item.reason}` })),
        ],
        tone: state.supplyStatus.pendingVerification ? 'warn' : 'info',
      },
      {
        title: 'Cộng lô xác nhận về trước từng mốc',
        detail: 'Tại mỗi mốc thời gian, cộng dồn số lượng còn lại (đã trừ phần thực nhận/đã hủy) của mọi lô đã xác nhận có ngày về không muộn hơn mốc đó.',
        substitution: `Tổng lô đã xác nhận đến mốc cuối = ${fmt(finalMilestone?.confirmedInbound, 0)} sản phẩm`,
      },
      {
        title: 'Trừ cam kết trước từng mốc',
        detail: 'Đơn giữ hàng, điều chuyển nội bộ và cam kết kênh bán có ngày không muộn hơn mốc đang xét đều bị trừ khỏi tổng lũy kế.',
        substitution: `Tổng đã cam kết đến mốc cuối = ${fmt(finalMilestone?.committed, 0)} sản phẩm`,
      },
      {
        title: 'Tính hàng tự do tại từng mốc',
        detail: 'Hàng tự do có thể âm — hệ thống không chặn về 0 vì giá trị âm chính là tín hiệu cho biết SKU sẽ thiếu hàng vào đúng thời điểm đó. Khác với tồn có thể sử dụng ngay ở bước đầu (luôn ≥ 0), hàng tự do phản ánh cả những cam kết chưa đến hạn.',
        substitution: finalMilestone ? `Hàng tự do tại mốc cuối = Tồn có thể sử dụng ngay ${fmt(finalMilestone.onHand, 0)} + Lô đã xác nhận ${fmt(finalMilestone.confirmedInbound, 0)} − Đã cam kết ${fmt(finalMilestone.committed, 0)} = ${fmt(finalMilestone.freeStock, 0)} sản phẩm` : 'Chưa có mốc nguồn hàng',
        values: milestoneValues,
        tone: 'good',
      },
    ],
  };
}

function stage15(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const audit = state.safetyStockAudit;
  const z = audit?.z ?? 0;
  const sufficient = audit ? audit.method !== 'policy-buffer' : false;
  const methodLabel = audit?.method === 'percentile' ? 'phân vị độ lệch actual−forecast trong lead time' : audit?.method === 'z-formula' ? 'công thức Z×√(LT×σd²+D̄²×σLT²)' : 'mức đệm chính sách';
  return {
    heading: sufficient ? 'Thế số dò mức phục vụ và tồn kho an toàn' : 'Kiểm tra dữ liệu và chuyển luồng chính sách',
    context: 'Thực hiện đúng thứ tự Chặng 15: chọn SKU → đồng nhất đơn vị → nhu cầu bình quân → độ lệch nhu cầu → dò mức phục vụ → tính tồn an toàn → mức cần bảo vệ → cảnh báo ràng buộc.',
    steps: [
      {
        title: 'Mục đích chặng',
        detail: '"Tính tồn kho an toàn và mức cần bảo vệ" — Chặng này ưu tiên đo trực tiếp độ lệch giữa thực tế và dự báo trong khoảng thời gian chờ hàng (phương pháp phân vị), chỉ dùng công thức Z×√(...) làm phương án dự phòng khi thiếu dữ liệu. Kết quả là đầu vào bắt buộc cho Chặng 16 khi tính số lượng cần đặt thêm.',
        tone: 'info',
      },
      {
        title: 'Chọn SKU và đọc đủ các nhóm đầu vào',
        detail: 'Đọc dự báo cuối C13, sai số dự báo/dao động nhu cầu C11, mức phục vụ sàn C8, lịch sử lead time C14/Mua hàng và các ràng buộc tồn/kho/hạn dùng.',
        values: [
          { label: 'SKU', value: state.definition.id },
          { label: 'Dự báo cuối', value: state.finalForecast.length ? `${state.finalForecast.length} chu kỳ` : 'THIẾU' },
          { label: 'Mức phục vụ sàn (C8)', value: state.serviceLevel ? `${state.serviceLevel}%` : 'THIẾU' },
          { label: 'Mẫu lead time', value: `${state.definition.leadTimeHistoryDays.length}` },
          { label: 'Trần tồn / sức chứa', value: `${state.definition.maxStock} / ${state.definition.warehouseCapacity}` },
        ],
      },
      {
        title: 'Quy đổi lead time và độ lệch lead time về cùng đơn vị chu kỳ',
        detail: `Chu kỳ phiên M = ${policy.cycleLength} ngày. Không trộn nhu cầu/chu kỳ với lead time/ngày.`,
        substitution: audit ? `LT̄ = ${fmt(audit.ltBarDays, 2)}/${policy.cycleLength} = ${fmt(audit.ltBarCycles, 2)} chu kỳ · σLT = ${fmt(audit.sigmaLtDays, 2)}/${policy.cycleLength} = ${fmt(audit.sigmaLtCycles, 2)} chu kỳ` : 'Chưa có dữ liệu lead time',
      },
      {
        title: 'Tính nhu cầu bình quân D̄ trong vùng cần bảo vệ',
        detail: 'Lấy trung bình dự báo cuối đã phản ánh CTKM của đúng các chu kỳ trong vùng bảo vệ.',
        substitution: audit ? `D̄ = ΣF_final/|C| = mean([${list(state.finalForecast, 1)}]) = ${fmt(audit.dBar, 2)}` : 'D̄ chưa xác định',
      },
      {
        title: 'Lấy mẫu độ lệch trong lead time theo đúng thứ bậc nguồn',
        detail: audit?.sourceTier === 'sku-history'
          ? `Đủ ${audit.percentileSample?.length ?? 0} cửa sổ độ lệch riêng của SKU này (gộp từ sai số TEST Chặng 11) → dùng ngay, không cần fallback.`
          : audit?.sourceTier === 'abc-xyz-group'
            ? 'SKU chưa đủ cửa sổ độ lệch riêng → mượn tạm độ lệch của các SKU cùng ô ABC×XYZ; độ tin cậy thấp hơn.'
            : 'Không đủ dữ liệu SKU lẫn nhóm ABC×XYZ → chuyển sang công thức Z×√(...) làm phương án dự phòng.',
        substitution: audit ? `Nguồn mẫu = ${audit.sourceTier} · σd = ${fmt(audit.sigmaD, 2)} sản phẩm/chu kỳ (${audit.sigmaDSource})` : 'σd chưa xác định',
        tone: audit?.sourceTier === 'sku-history' ? 'good' : 'warn',
      },
      {
        title: 'Dò mức phục vụ thấp nhất đạt đủ 4 điều kiện chính sách',
        detail: audit?.unfeasiblePolicy
          ? 'Không mức phục vụ nào trong danh sách dò đạt đủ cả 4 điều kiện (thiếu hụt, tỷ lệ vượt, dư thừa, vốn khóa) → giữ nguyên mức sàn đã khóa ở Chặng 8 và cần duyệt ngoại lệ.'
          : `Mức ${audit?.serviceLevel ?? state.serviceLevel}% là mức thấp nhất (từ sàn Chặng 8 trở lên) đạt đủ cả 4 điều kiện mô phỏng.`,
        values: (audit?.serviceLevelSearch ?? []).map(entry => ({ label: `Mức ${entry.candidate}%`, value: entry.passed ? 'ĐẠT — dừng dò tại đây' : entry.failedConditions.join('; ') || 'Chưa đạt' })),
        tone: audit?.unfeasiblePolicy ? 'warn' : 'good',
      },
      {
        title: 'Tính tồn kho an toàn theo phương pháp đã chọn',
        detail: sufficient
          ? `Dùng phương pháp ${methodLabel} tại mức phục vụ ${audit?.serviceLevel}% (Z=${fmt(z, 2)}).`
          : 'Thiếu dữ liệu bắt buộc → không tự bịa số; chuyển mức đệm chính sách và ghi cảnh báo.',
        substitution: sufficient
          ? `Tồn kho an toàn = ${fmt(state.safetyStock, 0)} sản phẩm (phương pháp ${methodLabel})`
          : 'Không đủ dữ liệu bắt buộc → không tính được tồn kho an toàn, chuyển sang mức đệm chính sách và cần duyệt ngoại lệ',
        tone: sufficient ? 'good' : 'warn',
      },
      {
        title: 'Tính mức cần bảo vệ và phần không thể đáp ứng',
        detail: 'Mức cần bảo vệ luôn lấy giá trị lớn hơn giữa tồn kho an toàn tính được và tồn trưng bày tối thiểu (DisplayMin — CHƯA CÓ TRƯỜNG RIÊNG, mặc định 0 khi ERP chưa cung cấp). Nếu vượt trần tồn/sức chứa/hạn dùng, phần vượt được ghi lại chứ không tự bị cắt.',
        substitution: audit ? `Mức cần bảo vệ = max(SS ${fmt(state.safetyStock, 0)}; DisplayMin ${fmt(state.definition.displayMinimumStock, 0)}) = ${fmt(audit.protection, 0)} sản phẩm${audit.unmetProtection > 0 ? ` · Không thể đáp ứng ${fmt(audit.unmetProtection, 0)} sản phẩm` : ''}` : 'Chưa xác định',
        tone: audit && audit.unmetProtection > 0 ? 'warn' : 'good',
      },
      {
        title: 'Kiểm tra trần tồn, hạn dùng, vốn và sức chứa',
        detail: 'Chặng 15 chỉ gắn cảnh báo, tuyệt đối không âm thầm cắt kết quả SS để vừa ràng buộc.',
        values: audit?.warnings.length ? audit.warnings.map((warning, index) => ({ label: `Cảnh báo ${index + 1}`, value: warning })) : [{ label: 'Kết quả', value: 'Không phát sinh cảnh báo ràng buộc' }],
        tone: audit?.warnings.length ? 'warn' : 'good',
      },
      {
        title: 'Khóa đầu ra Chặng 15',
        detail: 'Bàn giao mức tồn kho an toàn cùng toàn bộ căn cứ tính (nhu cầu bình quân, độ lệch, thời gian chờ, phương pháp đã dùng, nguồn dữ liệu và cảnh báo) cho các chặng sau.',
        substitution: `Tồn kho an toàn = ${fmt(state.safetyStock, 0)} sản phẩm · phương pháp = ${audit?.method ?? '—'} · số cảnh báo = ${audit?.warnings.length ?? 0}`,
        tone: sufficient ? 'good' : 'warn',
      },
    ],
  };
}

function stage16(state: Readonly<SkuPipelineState>): StageTrace {
  const p = state.orderPlan;
  return {
    heading: 'Tính số đặt trước ngân sách và làm tròn theo quy cách mua',
    context: 'Chặng 16 chỉ tính nhu cầu mua và quy cách; tuyệt đối chưa cắt theo ngân sách.',
    steps: [
      {
        title: 'Mục đích chặng',
        detail: '"Tính số cần đặt trước ngân sách" — Chặng này lấy dự báo cần bán cộng tồn kho an toàn, trừ đi hàng đang tự do, rồi làm tròn theo quy cách mua tối thiểu (MOQ) để ra số đề xuất đặt hàng. Ngân sách thực tế chưa được xét ở đây — việc cấp vốn thuộc về Chặng 17.',
        tone: 'info',
      },
      { title: 'Đọc dự báo cuối từ Chặng 13', detail: 'Giữ nguyên dãy dự báo cuối đã khóa, không tính lại.', substitution: `Dự báo cuối = [${list(state.finalForecast, 1)}]` },
      { title: 'Đọc vị thế tồn từ Chặng 14', detail: 'Dùng đúng hàng tự do đã tính tại mốc cuối vùng cần bao phủ.', substitution: `Hàng tự do = ${fmt(p?.freeStock, 1)} sản phẩm` },
      { title: 'Đọc mức cần bảo vệ từ Chặng 15', detail: 'Nhận nguyên trạng, không tự giảm mức cần bảo vệ để vừa số đặt mong muốn.', substitution: `Mức cần bảo vệ = ${fmt(state.safetyStockAudit?.protection ?? state.safetyStock, 1)} sản phẩm` },
      { title: 'Đọc quy cách mua (MOQ / carton / order-step)', detail: 'MOQ, số đơn vị mỗi carton và bước làm tròn đơn hàng đều là dữ kiện mua hàng từ nhà cung cấp, không phải ngưỡng hệ thống tự đặt ra.', substitution: `MOQ = ${fmt(p?.moq, 0)} · Đơn vị/carton = ${fmt(state.definition.unitsPerCarton, 0)} · Order-step = ${fmt(state.definition.orderStep, 0)} carton` },
      { title: 'Xác định vùng thời gian cần bao phủ (CoverWindow)', detail: 'Vùng cần bao phủ (CoverWindow) bằng lead time thật của SKU (hoặc mặc định chính sách nếu SKU chưa có lịch sử) cộng với chu kỳ lập kế hoạch — đây là khoảng thời gian mà số hàng đặt lần này phải đủ dùng.', substitution: `CoverWindow = ${fmt(p?.coverageDays, 0)} ngày ≈ ${p?.coverageCycles ?? 0} chu kỳ` },
      { title: 'Tính nhu cầu trong vùng bao phủ', detail: 'Cộng đủ dự báo các chu kỳ nằm trọn trong vùng cần bao phủ; phần lẻ chu kỳ cuối được tính theo tỷ lệ ngày dư (không làm tròn cả chu kỳ).', substitution: `Nhu cầu cần bao phủ = ${fmt(p?.demandCover, 1)} sản phẩm` },
      { title: 'Mô phỏng tồn từng chu kỳ để phát hiện thiếu hàng trước lô mới', detail: 'Cộng lô đang về, trừ dự báo bán từng chu kỳ để dự đoán tồn — nếu tồn dự kiến xuống âm trước khi lô mới kịp về, đây là tín hiệu cần xử lý sớm hơn số đặt thông thường.', substitution: p?.daysToStockout !== null && p?.daysToStockout !== undefined ? `Dự kiến hết hàng vào ngày +${p.daysToStockout} · Thiếu trước lô mới = ${fmt(p.shortageBeforeNewLot, 0)} sản phẩm` : 'Không phát hiện chu kỳ nào dự kiến âm trong tầm dự báo', tone: (p?.shortageBeforeNewLot ?? 0) > 0 ? 'warn' : 'good' },
      { title: 'Tính số cần đặt trước khi làm tròn', detail: 'Số cần đặt không được âm — nếu hàng tự do và mức cần bảo vệ đã đủ, số cần đặt trước làm tròn sẽ bằng 0.', substitution: `Số cần đặt (trước làm tròn) = max(0; Nhu cầu ${fmt(p?.demandCover, 1)} + Mức cần bảo vệ ${fmt(state.safetyStockAudit?.protection ?? state.safetyStock, 1)} − Hàng tự do ${fmt(p?.freeStock, 1)}) = ${fmt(p?.rawQuantity, 1)} sản phẩm` },
      { title: 'Kiểm tra có thực sự cần đặt hàng', detail: (p?.rawQuantity ?? 0) > 0 ? 'Có nhu cầu đặt hàng thật sự → chuyển sang bước làm tròn theo quy cách mua.' : 'Không có nhu cầu đặt hàng ở chu kỳ này; số đề xuất giữ nguyên bằng 0.', tone: (p?.rawQuantity ?? 0) > 0 ? 'good' : 'warn' },
      { title: 'Làm tròn theo quy cách mua: carton → MOQ → order-step → đơn vị', detail: 'Quy đổi ra carton, làm tròn lên bội số MOQ (tính theo carton), rồi làm tròn tiếp theo bước order-step, cuối cùng đổi ngược ra đơn vị — tuyệt đối không làm tròn xuống để tránh mua sai quy cách của nhà cung cấp.', substitution: `Số đặt sau làm tròn = ${fmt(p?.cartonsOrdered, 0)} carton × ${fmt(state.definition.unitsPerCarton, 0)} đơn vị/carton = ${fmt(p?.orderQuantity, 0)} sản phẩm` },
      { title: 'Tính phần dư MOQ và cờ rủi ro hạn dùng/sức chứa/gộp đơn', detail: 'Phần chênh lệch giữa số đặt sau làm tròn và số cần đặt thực tế được giữ lại riêng để Chặng 17/18 kiểm tra; đồng thời gắn cờ nếu số đặt vượt nhu cầu bán được trước hạn dùng, vượt sức chứa kho còn trống, hoặc chưa đạt giá trị đơn tối thiểu khi gộp theo nhà cung cấp.', substitution: `Phần dư do làm tròn = ${fmt(p?.orderQuantity, 1)} − ${fmt(p?.rawQuantity, 1)} = ${fmt(p?.moqSurplus, 1)} sản phẩm · Rủi ro hạn dùng: ${p?.expiryRisk ? 'CÓ' : 'không'} · Rủi ro sức chứa: ${p?.capacityRisk ? 'CÓ' : 'không'} · Gộp đơn NCC: ${p?.consolidationStatus ?? 'not-applicable'}`, tone: p?.expiryRisk || p?.capacityRisk || p?.consolidationStatus === 'below-supplier-minimum' ? 'warn' : 'good' },
      { title: 'Khóa đầu ra Chặng 16', detail: 'Bàn giao số cần đặt trước làm tròn, số đặt sau làm tròn, phần dư MOQ, vùng cần bao phủ, thiếu hàng trước lô mới và mọi cảnh báo phát sinh cho Chặng 17.', values: (p?.warnings ?? []).map((value, i) => ({ label: `Cảnh báo ${i + 1}`, value })), tone: p?.warnings.length ? 'warn' : 'good' },
    ],
  };
}

function stage17(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const a = state.budgetAllocation;
  return {
    heading: 'Phân bổ vốn theo ưu tiên đã khóa',
    context: 'Chặng 17 không sửa dự báo, tồn kho an toàn hay số đặt từ Chặng 16; chỉ cấp vốn theo thứ tự ưu tiên và theo đúng bội số quy cách mua.',
    steps: [
      {
        title: 'Mục đích chặng',
        detail: '"Chọn dòng được cấp tiền khi ngân sách không đủ" — Chặng này sắp xếp toàn bộ các dòng đặt hàng trong kỳ theo mức độ ưu tiên vốn, rồi cấp tiền lần lượt từ ưu tiên cao nhất cho đến khi hết ngân sách kỳ. Những dòng không còn đủ ngân sách sẽ bị cắt hoặc hoãn và được ghi rõ lý do để Chặng 18 xem xét.',
        tone: 'info',
      },
      { title: 'Đọc số đặt sau khi làm tròn MOQ', detail: 'Nhận nguyên trạng số lượng đề xuất đặt hàng từ Chặng 16, không tính lại.', substitution: `Số đặt = ${fmt(state.orderPlan?.orderQuantity, 0)} sản phẩm` },
      { title: 'Đọc giá vốn kế hoạch và tính giá trị đơn đặt', detail: 'Ưu tiên giá vốn kế hoạch đã gồm cước/thuế nhập khẩu; nếu chưa có, tạm dùng giá mua và đánh dấu là ước tính (chưa gồm đầy đủ chi phí).', substitution: a?.landedCostIsEstimate ? `Giá vốn kế hoạch: bucket = CHƯA CẤU HÌNH → tạm dùng giá mua ${fmt(state.definition.purchasePrice, 0)} ₫ · Giá trị đặt = ${fmt(a?.orderValue, 0)} ₫ (ước tính)` : `Giá trị đặt = ${fmt(state.orderPlan?.orderQuantity, 0)} × giá vốn kế hoạch = ${fmt(a?.orderValue, 0)} ₫`, tone: a?.landedCostIsEstimate ? 'warn' : 'info' },
      { title: 'Đọc ngân sách của kỳ', detail: 'Ngân sách là con số đã được khóa sẵn từ đầu phiên, không thay đổi trong lúc phân bổ.', substitution: `Ngân sách kỳ = ${fmt(policy.periodBudget, 0)} ₫` },
      { title: 'Đọc chính sách ưu tiên vốn và vai trò danh mục', detail: 'Mỗi SKU đã được gán một mức ưu tiên vốn cố định từ Chặng 8; vai trò danh mục (cốt lõi/chiến lược/thường) chỉ ảnh hưởng thứ tự sắp xếp, không tự đổi mức ưu tiên.', substitution: `Mức ưu tiên = ${state.capitalPriority} · hạng ${a?.priorityRank ?? 'chưa khóa'} · Vai trò = ${state.definition.coreOrStrategicRole}` },
      { title: 'Chia số đặt thành 3 rổ theo mục đích', detail: 'Rổ 1 là phần tối thiểu để tránh hết hàng, Rổ 2 là phần bổ sung để đạt đầy đủ mức bảo vệ, Rổ 3 là phần rủi ro phát sinh do làm tròn MOQ/hạn dùng/sức chứa — một SKU có thể có số lượng ở nhiều rổ cùng lúc.', substitution: `Rổ 1 (tránh hết hàng) = ${fmt(a?.minimumToAvoidShortage, 0)} · Rổ 2 (bảo vệ) = ${fmt(a?.additionalForProtection, 0)} · Rổ 3 (rủi ro MOQ) = ${fmt(a?.atRiskQuantity, 0)} sản phẩm` },
      { title: 'Sắp xếp theo đúng 7 tiêu chí của tài liệu', detail: 'Thứ tự: số ngày đến khi hết hàng → mức thiếu hụt → hạng ưu tiên vốn → vai trò cốt lõi/chiến lược → lead time dài hơn → rủi ro lỗi thời thấp hơn → mã SKU. Tuyệt đối KHÔNG dùng giá trị đơn hàng làm tiêu chí ưu tiên như trước đây.' },
      { title: 'Cấp vốn lần lượt Rổ 1 → Rổ 2 → Rổ 3 đến khi hết ngân sách', detail: 'Cấp hết Rổ 1 cho toàn danh mục theo đúng thứ tự trước, rồi mới đến Rổ 2, cuối cùng là Rổ 3; mỗi lần cấp chỉ được một số lượng là bội số hợp lệ của quy cách mua.', substitution: `Số lượng được cấp vốn = ${fmt(a?.fundedQuantity, 0)} sản phẩm (rổ đại diện: Rổ ${a?.basket ?? '—'}) · Giá trị được cấp vốn = ${fmt(a?.fundedValue, 0)} ₫` },
      { title: 'Ghi lại phần bị cắt/hoãn hoặc đề xuất duyệt vượt ngân sách', detail: a?.overBudgetProposal ? `SKU vai trò ${state.definition.coreOrStrategicRole} sắp hết hàng → tạo đề xuất duyệt vượt ngân sách thay vì chỉ ghi hoãn.` : (a?.reason ?? 'Dòng này chưa có kết quả phân bổ.'), substitution: a?.overBudgetProposal ? `Đề xuất vượt ngân sách: cần thêm ${fmt(a.overBudgetProposal.shortfallValue, 0)} ₫ cho ${fmt(a.overBudgetProposal.requiredQuantity, 0)} sản phẩm, dự kiến hết hàng ${a.overBudgetProposal.stockoutDate ?? 'chưa xác định'}` : `Số lượng bị cắt = ${fmt(a?.cutQuantity, 0)} sản phẩm`, tone: a?.overBudgetProposal ? 'warn' : a?.cutQuantity ? 'warn' : 'good' },
      { title: 'Khóa đầu ra Chặng 17', detail: 'Bàn giao số lượng được cấp vốn theo từng rổ, trạng thái cấp vốn, lý do bị cắt hoặc đề xuất vượt ngân sách, hạng ưu tiên và phần ngân sách đã dùng cho Chặng 18 quyết định phát hành.', substitution: `Trạng thái = ${a?.status ?? '—'}` },
    ],
  };
}

function stage18(state: Readonly<SkuPipelineState>): StageTrace {
  const d = state.releaseDecision;
  return {
    heading: 'Cổng ngoại lệ trước khi phát hành',
    context: 'Chặng 18 chỉ quyết định phát hành, giữ lại hoặc chờ bổ sung; không tính lại số đặt.',
    steps: [
      {
        title: 'Mục đích chặng',
        detail: '"Chốt số lượng đặt cuối cùng và phát hành hoặc chờ duyệt" — Chặng này là cửa kiểm tra ngoại lệ cuối cùng trước khi đơn mua hàng thực sự được tạo ra. Nếu còn thiếu thông tin mua hàng hoặc có cảnh báo chưa xử lý từ các chặng trước, đơn sẽ không được tự động phát hành mà chuyển sang chờ người duyệt xem xét.',
        tone: 'info',
      },
      { title: 'Đọc số lượng được cấp vốn cho đúng dòng SKU — nhà cung cấp', detail: 'Nhận nguyên trạng số lượng đã được cấp vốn từ Chặng 17, dùng làm số lượng trước khi qua cổng duyệt.', substitution: `${state.definition.id} − ${state.definition.supplier} · Số lượng trước duyệt = ${fmt(d?.quantityBeforeApproval, 0)} sản phẩm · Q_approved_over=0 (ứng dụng chưa có kênh ghi nhận người dùng tự sửa số đề xuất)` },
      { title: 'Đọc điều kiện mua hàng', detail: 'Ngày dự kiến về hàng, quy cách mua, giá mua, nhà cung cấp và điều kiện đơn mua đều phải có đầy đủ mới được phát hành.' },
      { title: 'Đọc danh sách ngoại lệ và các điều kiện bắt buộc chuyển duyệt', detail: 'Ngoài cảnh báo giữ nguyên từ Chặng 8–16, Chặng 18 tự kiểm tra thêm: MOQ tạo tồn dư quá lớn so với số đặt, số lượng đặt tăng bất thường so với nhu cầu bình quân gần đây, có nguy cơ thiếu hàng trước khi lô mới về, và nguồn hàng có dấu hiệu tính trùng chưa được xác minh.', values: (d?.reasons ?? []).map((value, i) => ({ label: `Lý do ${i + 1}`, value })), tone: d?.reasons.length ? 'warn' : 'good' },
      { title: 'Kiểm tra đã đủ thông tin mua hàng', detail: state.definition.purchaseTermsComplete ? 'Điều kiện đơn mua đã đầy đủ, đủ điều kiện để phát hành.' : 'Còn thiếu điều kiện đơn mua → chuyển sang trạng thái chờ bổ sung thông tin.', tone: state.definition.purchaseTermsComplete ? 'good' : 'warn' },
      { title: 'Kiểm tra có ngoại lệ cần người duyệt hay không', detail: d?.reasons.length ? 'Có ít nhất một ngoại lệ đang mở → hệ thống không tự phát hành, phải chờ người duyệt.' : 'Không phát hiện ngoại lệ nào cần duyệt.', tone: d?.reasons.length ? 'warn' : 'good' },
      { title: 'Gộp đơn theo nhà cung cấp/tiền tệ/kho nhận và kiểm tra lại giá trị tối thiểu', detail: 'Các dòng đủ điều kiện phát hành được gộp thành một đơn mua theo nhà cung cấp; nếu tổng giá trị của cả nhóm chưa đạt mức tối thiểu của nhà cung cấp, toàn bộ nhóm bị hạ về chờ duyệt — không phát hành riêng lẻ từng dòng để né điều kiện gộp.', substitution: d?.purchaseOrderGroupKey ? `Nhóm PO: ${d.purchaseOrderGroupKey}` : 'Chưa gộp nhóm (dòng không đủ điều kiện phát hành)' },
      { title: 'Quyết định phát hành hoặc chuyển chờ duyệt', detail: `Trạng thái cuối cùng của dòng này là: ${d?.status ?? '—'}.`, substitution: `Số lượng sau duyệt = ${fmt(d?.quantityAfterApproval, 0)} sản phẩm · Số lượng được phát hành = ${fmt(d?.releasedQuantity, 0)} sản phẩm` },
      { title: 'Khóa đầu ra Chặng 18', detail: 'Lưu lại số lượng trước/sau duyệt, trạng thái, nhóm đơn mua và lý do ngoại lệ (nếu có); hệ thống không tự giả lập quyết định thay cho người duyệt.' },
    ],
  };
}

function stage19(state: Readonly<SkuPipelineState>): StageTrace {
  const a = state.postAudit;
  return {
    heading: 'Hậu kiểm và đề xuất cho phiên tương lai',
    context: 'Kết quả cũ được giữ nguyên; Chặng 19 chỉ đo, tách nguyên nhân và tạo đề xuất.',
    steps: [
      {
        title: 'Mục đích chặng',
        detail: '"Hậu kiểm kết quả và tạo đề xuất kỳ sau" — Chặng này so sánh những gì hệ thống đã dự báo/đặt hàng với những gì thực tế xảy ra, đo các loại sai số, tách xem sai số phát sinh từ chặng nào (dự báo sai, tồn kho an toàn chưa đủ, hàng về trễ, hay thiếu ngân sách…), rồi đề xuất cải tiến áp dụng cho phiên chạy trong tương lai. Chặng 19 không sửa ngược bất kỳ kết quả nào của Chặng 1–18.',
        tone: 'info',
      },
      { title: 'Đọc dự báo cuối và số lượng đã phát hành', detail: 'Đọc đúng số liệu đã khóa (snapshot) tại thời điểm phát hành, không tính lại bằng thông tin mới hơn.', substitution: `Tổng dự báo cuối = ${fmt(state.finalForecast.reduce((s, v) => s + v, 0), 1)} sản phẩm · Số lượng đã phát hành = ${fmt(state.releaseDecision?.releasedQuantity, 0)} sản phẩm` },
      { title: 'Đọc số bán, tồn, thiếu hàng và hàng nhận thực tế', detail: 'Dùng dữ liệu thực tế sau khi phiên đã chạy, tách biệt hoàn toàn với số liệu dự báo.', substitution: `Tổng bán thực tế = ${fmt(a?.actualDemand, 1)} sản phẩm · Tồn cuối kỳ = ${fmt(a?.endingStock, 0)} sản phẩm` },
      { title: 'Đọc ngân sách thực tế và quyết định duyệt', detail: 'Đối chiếu vốn đã cấp ở Chặng 17, vốn thực sự đã dùng và trạng thái phát hành ở Chặng 18.' },
      {
        title: 'Đo sai số TÁCH RIÊNG dự báo nền và dự báo cuối',
        detail: 'Dự báo nền (WAPE_base) chỉ đo trên các chu kỳ KHÔNG có CTKM xác nhận, để không lẫn sai số mô hình với sai số học hệ số CTKM; dự báo cuối (WAPE_final) đo trên toàn bộ chu kỳ đã phát hành. Cả hai đều tính đủ RMSE/nRMSE/WAPE/Bias.',
        substitution: `WAPE_base = ${a?.baseForecastWape === null || a?.baseForecastWape === undefined ? 'CHƯA LƯU (không có chu kỳ nào ngoài CTKM để đo)' : fmt(a.baseForecastWape * 100, 2) + '%'} · WAPE_final = ${a?.forecastWape === null || a?.forecastWape === undefined ? '—' : fmt(a.forecastWape * 100, 2) + '%'}`,
      },
      { title: 'Đo mức phục vụ, thiếu hàng và dư tồn', detail: 'Không quy kết lỗi chỉ dựa vào một chỉ tiêu duy nhất — cần nhìn đồng thời cả thiếu hàng lẫn dư tồn.', substitution: `Số lượng thiếu hàng = ${fmt(a?.stockoutUnits, 0)} sản phẩm · Tồn cuối kỳ = ${fmt(a?.endingStock, 0)} sản phẩm` },
      { title: 'Đo hàng về đúng hẹn hay trễ so với kế hoạch', detail: 'Đo trực tiếp trên lịch sử nhận hàng thực tế, không suy diễn từ kế hoạch.', substitution: `Trễ trung bình = ${fmt(a?.averageReceiptDelayDays, 2)} ngày · MOQ dư còn lại = ${fmt(a?.moqSurplusResidual, 0)} sản phẩm · Giảm do duyệt thủ công = ${fmt(a?.manualReductionUnits, 0)} sản phẩm` },
      { title: 'Đo tác động ngân sách và ngoại lệ đã duyệt', detail: 'Giữ nguyên dấu dương/âm của chênh lệch để truy vết được là cấp thiếu hay cấp thừa so với thực tế đã dùng.', substitution: `Vốn đã cấp − vốn thực dùng = ${fmt(a?.budgetVariance, 0)} ₫ · Ngân sách bị cắt = ${fmt(a?.budgetCutUnits, 0)} sản phẩm` },
      { title: 'Tách nguyên nhân chính và nguyên nhân góp phần theo bảng tra', detail: a?.contributingCauses.length ? `Nguyên nhân chính: ${a.primaryCause}${a.contributingCauses.length > 1 ? ` · Còn ${a.contributingCauses.length - 1} nguyên nhân góp phần khác — xem chi tiết bên dưới.` : ''}` : (a?.primaryCause ?? 'Chưa có đủ dữ liệu để kết luận nguyên nhân.'), values: (a?.evidence ?? []).map((value, i) => ({ label: `Bằng chứng ${i + 1}`, value })) },
      { title: 'Kiểm tra mức độ nghiêm trọng để cân nhắc thay đổi chính sách', detail: a?.proposalStatus === 'future-version' ? 'Mức thiếu hàng hoặc sai số đủ lớn để đề xuất kiểm chứng một thay đổi chính sách. Lưu ý: bộ mô phỏng chỉ chạy một phiên nên đây là cổng mức độ nghiêm trọng, chưa phải phát hiện lặp lại thật qua nhiều kỳ.' : 'Chưa đủ dấu hiệu để thay đổi; tiếp tục theo dõi thêm ở các phiên sau.', tone: a?.proposalStatus === 'future-version' ? 'warn' : 'good' },
      { title: 'Tạo đề xuất hoặc giữ nguyên chính sách hiện tại', detail: a?.proposal ?? 'Chưa có đề xuất nào được tạo cho SKU này.' },
      { title: 'Khóa báo cáo Chặng 19', detail: 'Mọi đề xuất chỉ được áp dụng cho phiên chạy trong tương lai, tuyệt đối không sửa ngược kết quả đã khóa của Chặng 1–18.' },
    ],
  };
}

export function buildStageTrace(stage: StageNumber, state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focusDate: string | null): StageTrace {
  const focus = focusDate ? state.daily.find(record => record.date === focusDate) ?? null : null;
  if (stage === 5) {
    const selected = focus ?? state.daily.find(record => record.baseDemandSource === 'TECHNICAL_FILL' || record.baseDemand === null) ?? state.daily.at(-1) ?? null;
    const filledCount = state.daily.filter(record => record.baseDemandSource === 'TECHNICAL_FILL').length;
    const unresolvedCount = state.daily.filter(record => record.baseDemand === null).length;
    return {
      heading: selected ? `Bổ sung mức bán nền — soi ngày ${selected.date}` : 'Bổ sung mức bán nền còn thiếu',
      context: 'Chặng 5 chỉ xử lý cấp ngày; không cộng chu kỳ và không dùng ngày đã ước lượng làm nguồn cho ngày khác.',
      points: state.daily.filter(record => record.baseDemandSource === 'TECHNICAL_FILL' || record.baseDemand === null).slice(-40).map(record => ({ date: record.date, label: record.baseDemand === null ? 'Chưa đủ căn cứ' : 'Đã bổ sung', kind: record.baseDemand === null ? 'warn' : 'so' })),
      steps: [
        { title: 'B1 · Xác định ngày thật sự thiếu nền', detail: selected ? `Ngày ${selected.date}: nguồn ${selected.baseDemandSource}, số bán ghi nhận ${fmt(selected.sales)}.` : 'Không có ngày dữ liệu để kiểm tra.' },
        { title: 'B2 · Giữ nguyên số 0 thật', detail: 'Ngày có bằng chứng nguồn và bán bằng 0 không được đổi thành số dương.' },
        { title: 'B3 · Tìm ngày sạch quan sát', detail: `Tìm ±${policy.referenceRadius}, mở tối đa ±${policy.maxReferenceRadius}; cần tối thiểu ${policy.minimumReferences} nguồn và lấy tối đa 14 ngày gần nhất.` },
        { title: 'B4 · Loại nguồn không hợp lệ', detail: 'Loại ngày khuyến mãi, thiếu hàng, mất nguồn và mọi ngày đã được ước lượng.' },
        { title: 'B5 · Tính trung vị', detail: selected?.referenceDates.length ? `Median từ ${selected.referenceDates.length} ngày: ${selected.referenceDates.join(', ')}.` : 'Không có tập tham chiếu đã chọn cho ngày đang soi.', substitution: selected?.referenceMedian === null || selected?.referenceMedian === undefined ? undefined : `B_fill = ${fmt(selected.referenceMedian)}` },
        { title: 'B6 · Bàn giao dữ liệu ngày', detail: `${filledCount} ngày đã được bổ sung; ${unresolvedCount} ngày vẫn chưa đủ căn cứ và được giữ nguyên vị trí thời gian.`, tone: unresolvedCount ? 'warn' : 'good' },
      ],
      contract: STAGE_TRACE_CONTRACTS[stage],
    };
  }
  let trace: StageTrace;
  const traceStage = (stage > 5 ? stage - 1 : stage) as Exclude<StageNumber, 20>;
  switch (traceStage) {
    case 1: trace = stage1(state, policy); break;
    case 2: trace = stage2(state, policy, focus); break;
    case 3: trace = stage3(state, policy, focus); break;
    case 4: trace = stage4(state, policy, focus); break;
    case 5: trace = stage5(state, policy, focusDate); break;
    case 6: trace = stage6(state, policy); break;
    case 7: trace = stage7(state, policy); break;
    case 8: trace = stage8(state, policy); break;
    case 9: trace = stage9(state); break;
    case 10: trace = stage10(state); break;
    case 11: trace = stage11(state); break;
    case 12: trace = stage12(state, focus); break;
    case 13: trace = stage13(state, policy); break;
    case 14: trace = stage14(state); break;
    case 15: trace = stage15(state, policy); break;
    case 16: trace = stage16(state); break;
    case 17: trace = stage17(state, policy); break;
    case 18: trace = stage18(state); break;
    case 19: trace = stage19(state); break;
  }
  const mappedTrace = stage > 5 ? shiftLegacyTrace(trace) : trace;
  return { ...mappedTrace, contract: STAGE_TRACE_CONTRACTS[stage] };
}
