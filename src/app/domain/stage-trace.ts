import { DailyRecord, SimulationPolicy, SkuPipelineState, StageNumber } from './models';
import { calculateTrend, mean, median, meetsSeasonRepeatThreshold, populationStdev } from './math';
import { CAPITAL_PRIORITIES, SERVICE_LEVELS } from './policy';
import { buildPromoRegionSamples } from './promo-analysis';

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

function lockedSeries(state: Readonly<SkuPipelineState>): number[] {
  return state.cycles.filter(cycle => cycle.locked).slice(-24).map(cycle => cycle.baseDemand);
}

function referenceValues(state: Readonly<SkuPipelineState>, dates: readonly string[]): number[] {
  const byDate = new Map(state.daily.map(record => [record.date, record]));
  return dates.map(date => {
    const record = byDate.get(date);
    return record ? record.baseDemand ?? record.sales : 0;
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
  const stockouts = state.daily.filter(record => record.isStockout);
  const points: TracePoint[] = stockouts.slice(0, 14).map(record => ({ date: record.date, label: record.date, kind: 'so' }));
  if (focus) {
    const lateReceipt = focus.openStock === 0 && focus.closeStock > 0 && !!focus.receiptHour && focus.receiptHour > policy.cutoffHour;
    const emptyAllDay = focus.openStock === 0 && focus.closeStock === 0 && focus.sales === 0;
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
            { label: 'Giờ nhập h', value: focus.receiptHour ?? 'Không có' },
            { label: 'Số bán Q', value: fmt(focus.sales, 0) },
          ],
        },
        {
          title: 'Điều kiện 1 — nhập hàng trễ hơn giờ quy định',
          detail: 'Hệ thống kiểm tra lần lượt ba dấu hiệu dưới đây. Chỉ khi cả ba đều đạt, ngày này mới được xem là nhập hàng trễ.',
          checks: [
            { label: 'Đầu ngày không còn hàng', actual: `Tồn đầu ngày: ${fmt(focus.openStock, 0)}`, passed: focus.openStock === 0 },
            { label: 'Trong ngày có hàng về', actual: `Tồn cuối ngày: ${fmt(focus.closeStock, 0)}`, passed: focus.closeStock > 0 },
            { label: `Hàng về sau ${policy.cutoffHour}`, actual: `Giờ hàng về: ${focus.receiptHour ?? 'Không có'}`, passed: !!focus.receiptHour && focus.receiptHour > policy.cutoffHour },
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
          detail: focus.isStockout
            ? `Ít nhất một điều kiện đúng → ngày được gắn cờ stockout (${focus.stockoutReason === 'late-receipt' ? 'nhập trễ' : 'trống cả ngày'}) và chuyển sang Chặng 3.`
            : 'Cả hai điều kiện đều sai → ngày được xem là ngày bán bình thường.',
          substitution: `SO(${focus.date}) = ${focus.isStockout ? 'TRUE' : 'FALSE'}`,
          tone: focus.isStockout ? 'warn' : 'good',
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
      { title: 'Áp điều kiện 1 — nhập trễ', detail: `Tồn đầu bằng 0, có hàng về trong ngày nhưng sau giờ quy định ${policy.cutoffHour}.`, values: [{ label: 'Ngày nhập trễ', value: fmt(state.daily.filter(record => record.stockoutReason === 'late-receipt').length, 0) }] },
      { title: 'Áp điều kiện 2 — trống cả ngày', detail: 'Tồn đầu và tồn cuối đều bằng 0, không ghi nhận số bán.', values: [{ label: 'Ngày trống cả ngày', value: fmt(state.daily.filter(record => record.stockoutReason === 'empty-all-day').length, 0) }] },
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
  const distorted = state.daily.filter(record => record.isStockout && !record.promoCode);
  const points: TracePoint[] = distorted.slice(0, 14).map(record => ({
    date: record.date,
    label: record.date,
    kind: record.baseSource === 'insufficient' ? 'warn' : 'so',
  }));
  const valid = focus && focus.isStockout && !focus.promoCode ? focus : null;
  if (valid) {
    const steps: TraceStep[] = [
      {
        title: 'Nhận diện điểm méo',
        detail: `Ngày ${valid.date} không thuộc CTKM nhưng bị stockout (${valid.stockoutReason === 'late-receipt' ? 'nhập trễ' : 'trống cả ngày'}) — số bán ghi nhận có thể thấp giả, chưa được dùng làm nền.`,
        values: [
          { label: 'Số bán ghi nhận Q', value: fmt(valid.sales, 0) },
          { label: 'Tồn đầu / cuối', value: `${fmt(valid.openStock, 0)} / ${fmt(valid.closeStock, 0)}` },
        ],
        tone: 'warn',
      },
      ...referenceSteps(state, valid, policy),
    ];
    if (valid.baseSource === 'insufficient') {
      steps.push({
        title: 'Khóa trạng thái, không nâng nền',
        detail: 'Ngày được ghi THIẾU CĂN CỨ; Chặng 5 sẽ quyết định có lấp nền kỹ thuật hay không.',
        substitution: `B(${valid.date}) = null · baseSource = insufficient`,
        tone: 'warn',
      });
    } else {
      steps.push({
        title: 'Khóa sức mua cơ bản của ngày',
        detail: 'Lấy max giữa số bán ghi nhận và mức nền tham chiếu — Chặng 3 không bao giờ làm giảm số bán thật.',
        substitution: `Bₜ = max(Qₜ; R) = max(${fmt(valid.sales, 0)}; ${fmt(valid.referenceMedian)}) = ${fmt(valid.baseDemand)}`,
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
      { title: 'B2 · Kiểm tra ngày có thuộc CTKM', detail: 'Ngày CTKM không xử lý ở Chặng 3 mà bàn giao nguyên trạng sang Chặng 4.', values: [{ label: 'Chờ Chặng 4', value: fmt(state.daily.filter(record => record.baseSource === 'promo-defer').length, 0) }] },
      { title: 'B3 · Kiểm tra stockout', detail: 'Ngày không CTKM, không stockout dùng số bán ghi nhận làm sức mua cơ bản; chỉ ngày có stockout mới tìm nền.', values: [{ label: 'Ngày sạch dùng Q', value: fmt(state.daily.filter(record => record.baseSource === 'clean').length, 0) }, { label: 'Ngày cần nâng nền', value: fmt(distorted.length, 0) }] },
      { title: 'B4 · Tìm ngày sạch trong ±7 ngày', detail: `Quét lớp đầu ±${policy.referenceRadius} ngày; ngày CTKM, stockout, lấp kỹ thuật và ngày thiếu bản ghi không được làm tham chiếu.` },
      { title: 'B5 · Cân bằng; nếu cần mở rộng tối đa ±24 ngày', detail: `k=min(n₋,n₊,${policy.maxBalancedPerSide}); ưu tiên 2+2 cân bằng, cắt phía dư trước khi dùng nền tạm. Dữ liệu ngoài khung chỉ được dùng nếu nguồn đệm thực sự tồn tại.` },
      { title: 'B6 · Tính trung vị hoặc ghi thiếu căn cứ', detail: `Có tập cân bằng ≥4 ngày → nền tốt; không tạo được 2+2 nhưng có ≥${policy.minimumReferences} ngày → nền tạm; dưới ${policy.minimumReferences} ngày → không tự tạo nền.` },
      { title: 'B7 · Tính sức mua cơ bản ngày stockout', detail: 'Bₜ=max(Qₜ,Median(Rₜ)); Chặng 3 không bao giờ làm giảm số bán thật.', values: [{ label: 'Đã nâng nền', value: fmt(state.daily.filter(record => record.baseSource === 'stockout-lifted').length, 0) }, { label: 'Thiếu căn cứ', value: fmt(state.daily.filter(record => record.baseSource === 'insufficient').length, 0) }] },
      { title: 'B8 · Bàn giao nền và trạng thái tin cậy', detail: 'Lưu Q gốc, mức nền, ngày tham chiếu, trạng thái cân bằng và cờ kiểm tra lại cho Chặng 5/19.', tone: 'good' },
    ],
  };
}

function stage4(state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focus: DailyRecord | null): StageTrace {
  const regions = promoRegions(state.daily);
  const points: TracePoint[] = regions.slice(0, 14).map(region => ({
    date: region.rows[0].date,
    label: `${region.codes.join('+')} · ${region.rows[0].date}`,
    kind: region.rows[0].baseSource === 'insufficient' ? 'warn' : 'km',
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
          { label: 'Bán ghi nhận trong vùng', value: fmt(region.rows.reduce((sum, row) => sum + row.sales, 0), 0) },
        ],
        tone: 'warn',
      },
      {
        title: 'Chặn ranh giới bối cảnh',
        detail: 'Không lấy ngày bên trong CTKM làm tham chiếu cho chính nó và không đi xuyên qua CTKM liền kề để lấy ngày sạch xa hơn — nền phải lấy từ bối cảnh sát vùng méo.',
      },
      ...referenceSteps(state, focus, policy),
    ];
    if (focus.baseSource === 'insufficient') {
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
      { title: 'B7 · Gán cùng mức nền cho mọi ngày trong vùng', detail: 'Bₜ=Median(Rᵣ) cho mọi t thuộc vùng/cụm; giữ Q và mã CTKM riêng.', values: [{ label: 'Ngày đã chuẩn hóa', value: fmt(state.daily.filter(record => record.baseSource === 'promo-normalized').length, 0) }, { label: 'Thiếu căn cứ', value: fmt(state.daily.filter(record => record.promoCode && record.baseSource === 'insufficient').length, 0) }] },
      { title: 'B8 · Bàn giao dữ liệu kiểm toán và nguồn học K', detail: 'Lưu vùng, tập tham chiếu, trạng thái nền, Q gốc và promoCode cho Chặng 5/12/19.', tone: 'good' },
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
        title: 'B3 · Kiểm tra nhánh chu kỳ trống',
        detail: sufficientDays === 0 ? 'Không có ngày nào đủ nền → chu kỳ trống; không được lấp toàn bộ chu kỳ.' : 'Có ít nhất một ngày đủ nền → được phép xét lấp từng ngày còn thiếu.',
        substitution: `sufficientDays = ${sufficientDays} → ${cycle.emptyCycle ? 'EMPTY · KHÔNG LẤP' : 'TIẾP TỤC'}`,
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
            ? 'Chu kỳ trống hoàn toàn → không lấp, không dùng trong phiên học.'
            : 'Vẫn còn ngày chưa đủ căn cứ nền → chu kỳ không được khóa, không đi vào chuỗi học.',
        substitution: `locked ⇔ unresolved = 0 ∧ ¬empty → (${fmt(cycle.unresolvedDays, 0)} = 0 ∧ ${cycle.emptyCycle ? 'empty' : '¬empty'}) → ${cycle.locked ? 'LOCKED' : 'KHÔNG DÙNG'}`,
        tone: cycle.locked ? 'good' : 'warn',
      },
      {
        title: 'B7 · Ghi thành phần kiểm toán của chu kỳ',
        detail: 'Giữ số ngày CTKM đã đưa về nền, ngày stockout nâng nền, ngày lấp kỹ thuật và nền chưa cân bằng; ngày CTKM/lấp kỹ thuật không biến thành nguồn sạch.',
        substitution: `clean=${cycle.cleanDays} · stockout=${cycle.stockoutLiftedDays} · promo=${cycle.promoNormalizedDays} · fill=${cycle.technicalFillDays} · unresolved=${cycle.unresolvedDays}`,
      },
      {
        title: 'B8 · Tổng hợp Yⱼ và bàn giao trạng thái',
        detail: 'Chỉ cộng cột sức mua cơ bản; số bán CTKM thô không bao giờ đi vào tổng chu kỳ. Chỉ LOCKED được bàn giao cho Chặng 6–11.',
        substitution: cycle.locked ? `Y(${cycle.cycleIndex}) = ΣBₜ (${cycle.days} ngày) = ${fmt(cycle.baseDemand)}` : `Y(${cycle.cycleIndex}) không được bàn giao`,
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

function stage6(state: Readonly<SkuPipelineState>): StageTrace {
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
          ? `hạng #${c.abcRank} · ${pct(c.cumulativeShare)} ${c.abcRank === 1 && c.cumulativeShare > 0.8 ? '> 80% nhưng SKU đầu → A (ngoại lệ tập trung)' : c.cumulativeShare <= 0.8 ? '≤ 80% → A' : c.cumulativeShare < 0.9 ? '< 90% → B' : '≥ 90% → C'} → ABC = ${c.abc}`
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

function stage7(state: Readonly<SkuPipelineState>): StageTrace {
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
        substitution: !enoughData ? 'Chưa xét Z vì dữ liệu thuộc nhánh D' : `${fmt(adi, 3)} ${(adi ?? 0) > 1.32 ? '> 1,32 → ứng viên Z' : '≤ 1,32 → tiếp tục xét X/Y'}`,
        tone: enoughData && (adi ?? 0) > 1.32 ? 'warn' : 'info',
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
          : (adi ?? 0) > 1.32
            ? `ADI = ${fmt(adi, 3)} > 1,32 → Z`
            : `ADI = ${fmt(adi, 3)} ≤ 1,32 · CV² = ${fmt(cv2, 4)} ${(cv2 ?? Infinity) <= 0.49 ? '≤ 0,49 → X' : '> 0,49 → Y'}`,
        result: `XYZ/D = ${xyz} · khóa và truyền sang Chặng 8–11`,
        tone: xyz === 'D' ? 'warn' : 'good',
      },
    ],
  };
}

function stage8(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const { abc, xyz } = state.classification;
  const excluded = xyz === 'D' || abc === 'N/A';
  const cell = `${abc}${xyz}`;
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
        substitution: excluded ? 'ServiceLevel = null' : `${cell}: ưu tiên ${CAPITAL_PRIORITIES[cell]} · ServiceLevel = ${SERVICE_LEVELS[cell]}%`,
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
        detail: `SKU thuộc nhóm ${state.classification.xyz}, không phải Y → bỏ qua kiểm tra mùa vụ, kết luận NOT-APPLICABLE. Nhóm X đi thẳng SES/Holt, nhóm Z đi Croston/nhịp phát sinh, nhóm D dùng kế hoạch riêng.`,
        substitution: `XYZ = ${state.classification.xyz} ≠ Y → seasonality = not-applicable`,
        tone: 'info',
      }],
    };
  }
  const values = state.cycles.filter(cycle => cycle.locked).map(cycle => cycle.baseDemand);
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
  const positions = Array.from({ length: 24 }, (_, position) => {
    const ratios = rounds.map(round => mean(round) ? round[position] / mean(round) : 1);
    const average = mean(ratios);
    const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
    const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
    return { position: position + 1, average, highRepeat, lowRepeat, high: average >= 1.15 && meetsSeasonRepeatThreshold(highRepeat), low: average <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat) };
  });
  const flagged = positions.filter(item => item.high || item.low);
  const strongest = [...positions].sort((a, b) => Math.abs(b.average - 1) - Math.abs(a.average - 1))[0];
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
        detail: 'S_p là trung bình các tỷ lệ R của cùng vị trí qua q vòng.',
        substitution: `S_${strongest.position} = ${fmt(strongest.average, 3)}`,
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
      ? `SKU thuộc nhóm ${state.classification.xyz}, không phải Y → không kiểm tra xu hướng tại chặng này.`
      : 'SKU đã xác nhận mùa vụ ở Chặng 9 → đi thẳng nhánh Holt-Winters, không cần công tắc xu hướng.';
    return {
      heading: 'Kiểm tra xu hướng — không áp dụng',
      context: 'Công tắc xu hướng chỉ dành cho nhóm Y chưa có mùa vụ.',
      steps: [{ title: 'Lọc điều kiện áp dụng', detail: reason, substitution: `XYZ = ${state.classification.xyz} · seasonality = ${state.seasonality}`, tone: 'info' }],
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

function stage11(state: Readonly<SkuPipelineState>): StageTrace {
  const forecast = state.forecast;
  if (!forecast) {
    return { heading: 'Chưa có dự báo nền', context: 'Chặng 11 chưa tạo kết quả cho SKU này.', steps: [] };
  }
  const values = state.cycles.filter(cycle => cycle.locked).map(cycle => cycle.baseDemand);
  const branch = state.classification.xyz === 'D'
    ? 'Nhóm D → không dự báo thống kê, dùng kế hoạch Thu mua / mượn mã tương tự.'
    : state.classification.xyz === 'Y' && state.seasonality === 'confirmed'
      ? 'Nhóm Y + mùa vụ xác nhận (C9) → Holt-Winters.'
      : state.classification.xyz === 'Y' && (state.trend === 'up' || state.trend === 'down')
        ? `Nhóm Y + xu hướng ${state.trend === 'up' ? 'tăng' : 'giảm'} (C10) → Holt.`
        : state.classification.xyz === 'Z'
          ? 'Nhóm Z (thưa) → nhịp phát sinh đều thì PulseRhythm, ngược lại Croston.'
          : forecast.model === 'Holt'
            ? 'Nhóm X có tín hiệu xu hướng cục bộ → Holt.'
            : forecast.model === 'SeasonalNaive'
              ? `Không mùa vụ năm, không xu hướng nhưng phát hiện chu kỳ lặp ngắn p = ${forecast.params['p']} (tự tương quan r = ${forecast.params['r']}) thắng SES trên backtest → seasonal-naïve [D.4-1].`
              : 'Không mùa vụ, không xu hướng → SES giữ nền ổn định.';
  const steps: TraceStep[] = [
    {
      title: 'B1 · Chọn nhánh mô hình từ nhãn đã khóa',
      detail: `Đầu vào: XYZ = ${state.classification.xyz}, mùa vụ = ${state.seasonality}, xu hướng = ${state.trend}. ${branch} C11 không tự phân loại lại SKU.`,
      substitution: `Model = ${forecast.model}`,
      tone: 'info',
    },
  ];
  if (forecast.model === 'PurchasePlan') {
    steps.push(
      { title: 'B2 · Kiểm tra SKU tương tự đủ tin cậy và đã duyệt', detail: 'Dữ liệu mô phỏng không có quyết định duyệt SKU tương tự; không được tự mượn nền bằng AI.', substitution: 'SimilarSkuApproved = FALSE', tone: 'warn' },
      { title: 'B3 · Kiểm tra kế hoạch/hệ số kỳ vọng từ Thu mua', detail: 'Dữ liệu mô phỏng không có kế hoạch Thu mua được duyệt cho SKU nhóm D.', substitution: 'PurchasePlanApproved = FALSE', tone: 'warn' },
      { title: 'B4 · Chuyển ngoại lệ, không tự phát hành dự báo', detail: forecast.reason, substitution: 'F_base = [] · lockStatus = EXCEPTION', tone: 'warn' },
    );
  } else {
    const testSize = Math.max(1, Math.floor(values.length * 0.2));
    const params = Object.entries(forecast.params).map(([key, value]) => `${key} = ${fmt(value, 2)}`).join(' · ');
    steps.push(
      {
        title: 'B2 · Chia TRAIN/TEST theo thời gian',
        detail: '20% chu kỳ cuối chuỗi để làm TEST; tuyệt đối không trộn ngẫu nhiên vì sẽ làm lộ tương lai vào tập huấn luyện.',
        substitution: `n = ${values.length} → TRAIN = ${values.length - testSize} CK đầu · TEST = ${testSize} CK cuối`,
      },
      {
        title: 'B3 · Chạy mô hình và tối ưu tham số chỉ trên TRAIN',
        detail: 'Quét thô 0,1 → 0,9 rồi tinh chỉnh quanh điểm tốt nhất; tham số khóa xong không được chỉnh tiếp bằng tập kiểm tra. Bảng học từng chu kỳ nằm ở panel Dữ liệu bên trái.',
        substitution: params ? `Tham số khóa: ${params}` : 'Mô hình không có tham số học',
      },
      {
        title: 'B4 · Dự báo các chu kỳ TEST bằng tham số đã chốt',
        detail: 'Giữ nguyên tham số TRAIN, dự báo one-step-ahead; không dùng TEST để tinh chỉnh ngược tham số.',
        substitution: `TEST = ${testSize} chu kỳ cuối`,
      },
      {
        title: 'B5 · Tính đủ bộ sai số bắt buộc',
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
        title: 'B6 · Đối chiếu ngưỡng của đúng nhóm ABC×XYZ',
        detail: 'Tài liệu chưa ban hành giá trị ngưỡng P25 chính thức. Vì vậy hệ thống không được dùng 35%/20% hay bất kỳ ngưỡng tự đặt nào để khóa tự động.',
        substitution: `Threshold(${state.classification.abc}${state.classification.xyz}) = CHƯA PHÊ DUYỆT → REVIEW`,
        tone: 'warn',
      },
      {
        title: 'B7 · Mô phỏng tác động vận hành trước khi khóa',
        detail: 'Tác động thiếu hàng, dư tồn, vốn khóa và số SKU cần duyệt được mô phỏng ở Chặng 16–19; trạng thái C11 vẫn REVIEW cho đến khi ngưỡng P25 chính thức được ban hành và kiểm chứng.',
        substitution: 'OperationalImpact = CHƯA ĐỦ DỮ LIỆU → không khóa tự động',
        tone: 'warn',
      },
      {
        title: 'B8 · Quyết định trạng thái mô hình',
        detail: 'Chỉ LOCKED khi vừa đạt ngưỡng đã phê duyệt vừa qua mô phỏng tác động. Hai điều kiện này chưa đủ nên kết quả là REVIEW.',
        substitution: `lockStatus = ${forecast.lockStatus.toUpperCase()}`,
        tone: 'warn',
      },
      {
        title: 'B9 · Bàn giao dự báo nền chưa áp CTKM',
        detail: 'Chuỗi vẫn được hiển thị như dự báo cần xem xét; không được mô tả là dự báo đã khóa chính thức.',
        substitution: `F_base(review) = [${list(forecast.baseForecast, 1)}]`,
        tone: 'warn',
      },
    );
  }
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
  const points: TracePoint[] = eligible.slice(0, 14).map(region => ({ date: region.startDate, label: `${region.codes.join('+')} · ${region.startDate}`, kind: 'km' }));
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
      detail: 'Nhóm mô phỏng đang xét cùng SKU/nơi bán/loại MEMBER; không gom K của chương trình khác cơ chế.',
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
        detail: 'Mã/loại CTKM tương lai phải cùng nhóm áp dụng với hệ số lịch sử. Dữ liệu mô phỏng dùng nhóm MEMBER cho cả lịch sử và tương lai.',
        substitution: samplePlan ? `${samplePlan.code} ↔ nhóm hệ số MEMBER → ${samplePlan.code === 'MEMBER' ? 'KHỚP' : 'CẦN DUYỆT'}` : 'Không có CTKM xác nhận → không cần ghép',
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
  const onHand = state.daily.at(-1)?.closeStock ?? 0;
  const finalMilestone = state.supplyMilestones.at(-1);
  const milestoneValues: TraceValue[] = state.supplyMilestones.map(item => ({
    label: `${item.date} · ${item.label}`,
    value: `${fmt(item.onHand, 0)} + ${fmt(item.confirmedInbound, 0)} − ${fmt(item.committed, 0)} = ${fmt(item.freeStock, 0)}`,
  }));
  return {
    heading: 'Dựng lịch nguồn hàng và thế số I_free tại từng mốc',
    context: 'Chặng 14 tính theo trục thời gian thật của nguồn hàng; không suy ra inbound hoặc cam kết từ forecast.',
    steps: [
      {
        title: 'Chọn mã hàng và nhà cung cấp',
        detail: 'Khóa đúng cấp SKU — nhà cung cấp trước khi dựng lịch nguồn hàng.',
        values: [{ label: 'SKU', value: state.definition.id }, { label: 'Nhà cung cấp', value: state.definition.supplier }, { label: 'Tồn hiện có', value: fmt(onHand, 0) }],
      },
      {
        title: 'Sắp xếp các mốc nguồn hàng theo thời gian',
        detail: 'Dùng ngày chạy, ngày cam kết và ngày ETA của từng lô. Lô chưa xác nhận vẫn hiện trong kiểm toán nhưng không được cộng.',
        values: state.definition.inboundPlan.map(item => ({ label: `+${item.offsetDays} ngày · ${item.label}`, value: `${fmt(item.quantity, 0)} · ${item.confirmed ? 'ĐÃ XÁC NHẬN' : 'KHÔNG CỘNG'}` })),
      },
      {
        title: 'Cộng lô xác nhận về trước từng mốc',
        detail: 'Tại mỗi mốc t, cộng lũy kế duy nhất các lô confirmed=true có ETA ≤ t.',
        substitution: `Q_confirmed(≤t_cuối) = ${fmt(finalMilestone?.confirmedInbound, 0)}`,
      },
      {
        title: 'Trừ cam kết trước từng mốc',
        detail: 'Đơn giữ hàng, điều chuyển và cam kết kênh bán có ngày ≤ t được trừ lũy kế.',
        substitution: `Q_committed(≤t_cuối) = ${fmt(finalMilestone?.committed, 0)}`,
      },
      {
        title: 'Tính hàng tự do tại từng mốc',
        detail: 'Không chặn I_free về 0: giá trị âm phải được giữ để thể hiện thiếu hàng theo thời điểm.',
        substitution: finalMilestone ? `I_free(t_cuối) = ${fmt(onHand, 0)} + ${fmt(finalMilestone.confirmedInbound, 0)} − ${fmt(finalMilestone.committed, 0)} = ${fmt(finalMilestone.freeStock, 0)}` : 'Chưa có mốc nguồn hàng',
        values: milestoneValues,
        tone: 'good',
      },
    ],
  };
}

function stage15(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const audit = state.safetyStockAudit;
  const z = audit?.z ?? 0;
  const demandTerm = audit ? audit.ltBarCycles * audit.sigmaD ** 2 : 0;
  const leadTerm = audit ? audit.dBar ** 2 * audit.sigmaLtCycles ** 2 : 0;
  const sufficient = audit?.formula === 'full';
  return {
    heading: sufficient ? 'Thế số tồn kho an toàn đầy đủ' : 'Kiểm tra dữ liệu và chuyển luồng chính sách',
    context: 'Thực hiện đúng thứ tự Chặng 15: chọn SKU → đồng nhất đơn vị → D̄ → σd → Z → kiểm tra đủ dữ liệu → tính SS → cảnh báo ràng buộc.',
    steps: [
      {
        title: 'Chọn SKU và đọc đủ năm nhóm đầu vào',
        detail: 'Đọc dự báo cuối C13, sai số dự báo/dao động nhu cầu C11, mức phục vụ C8, lịch sử lead time C14/Mua hàng và các ràng buộc tồn/kho/hạn dùng.',
        values: [
          { label: 'SKU', value: state.definition.id },
          { label: 'Dự báo cuối', value: state.finalForecast.length ? `${state.finalForecast.length} chu kỳ` : 'THIẾU' },
          { label: 'Mức phục vụ', value: state.serviceLevel ? `${state.serviceLevel}%` : 'THIẾU' },
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
        title: 'Tính độ lệch chuẩn σd theo chu kỳ',
        detail: audit?.sigmaDSource === 'backtest'
          ? `Ưu tiên ${audit.sigmaDObservationCount} sai số TEST e=Y−F từ Chặng 11.`
          : `Chưa đủ backtest; dùng ${audit?.sigmaDObservationCount ?? 0} sức mua cơ bản chu kỳ C5 và phải ghi độ tin cậy thấp.`,
        substitution: audit ? `σd = ${fmt(audit.sigmaD, 2)} sản phẩm/chu kỳ · nguồn = ${audit.sigmaDSource}` : 'σd chưa xác định',
        tone: audit?.sigmaDSource === 'backtest' ? 'good' : 'warn',
      },
      {
        title: 'Chọn hệ số Z từ mức phục vụ mục tiêu đã khóa',
        detail: 'Không tự chọn Z khi thiếu mức phục vụ hoặc mức phục vụ chưa có trong bảng chính sách.',
        substitution: state.serviceLevel && z ? `ServiceLevel = ${state.serviceLevel}% → Z = ${fmt(z, 2)}` : 'Không có Z hợp lệ',
        tone: z ? 'good' : 'warn',
      },
      {
        title: 'Kiểm tra đủ dữ liệu và áp công thức phù hợp',
        detail: sufficient
          ? 'Đủ D̄, σd, LT̄, σLT và Z → dùng công thức đầy đủ; không dùng công thức rút gọn vì σLT có dữ liệu.'
          : 'Thiếu dữ liệu bắt buộc → không tự bịa số; chuyển công thức/mức đệm chính sách và ghi cảnh báo.',
        substitution: sufficient
          ? `SS = ⌈${fmt(z, 2)}×√(${fmt(audit!.ltBarCycles, 2)}×${fmt(audit!.sigmaD, 2)}² + ${fmt(audit!.dBar, 2)}²×${fmt(audit!.sigmaLtCycles, 2)}²)⌉ = ⌈${fmt(z * Math.sqrt(demandTerm + leadTerm), 2)}⌉ = ${fmt(state.safetyStock, 0)}`
          : 'SS = null · formula = policy · cần duyệt ngoại lệ',
        tone: sufficient ? 'good' : 'warn',
      },
      {
        title: 'Kiểm tra trần tồn, hạn dùng, vốn và sức chứa',
        detail: 'Chặng 15 chỉ gắn cảnh báo, tuyệt đối không âm thầm cắt kết quả SS để vừa ràng buộc.',
        values: audit?.warnings.length ? audit.warnings.map((warning, index) => ({ label: `Cảnh báo ${index + 1}`, value: warning })) : [{ label: 'Kết quả', value: 'Không phát sinh cảnh báo ràng buộc' }],
        tone: audit?.warnings.length ? 'warn' : 'good',
      },
      {
        title: 'Khóa đầu ra Chặng 15',
        detail: 'Bàn giao SS, Z, D̄, σd, LT̄, σLT, công thức đã dùng, nguồn dữ liệu và cảnh báo cho các chặng sau.',
        substitution: `SS = ${fmt(state.safetyStock, 0)} · formula = ${audit?.formula ?? '—'} · warnings = ${audit?.warnings.length ?? 0}`,
        tone: sufficient ? 'good' : 'warn',
      },
    ],
  };
}

function stage16(state: Readonly<SkuPipelineState>): StageTrace {
  const p = state.orderPlan;
  return {
    heading: 'Tính số đặt trước ngân sách và làm tròn MOQ',
    context: 'Chặng 16 chỉ tính nhu cầu mua và quy cách; tuyệt đối chưa cắt theo ngân sách.',
    steps: [
      { title: 'Đọc dự báo cuối từ Chặng 13', detail: 'Giữ nguyên dãy dự báo cuối đã khóa.', substitution: `F_final = [${list(state.finalForecast, 1)}]` },
      { title: 'Đọc vị thế tồn từ Chặng 14', detail: 'Dùng hàng tự do tại mốc cuối vùng bao phủ.', substitution: `I_free = ${fmt(p?.freeStock, 1)}` },
      { title: 'Đọc tồn kho an toàn từ Chặng 15', detail: 'Không tự giảm SS để vừa số đặt.', substitution: `SS = ${fmt(state.safetyStock, 1)}` },
      { title: 'Đọc MOQ và quy cách mua', detail: 'MOQ là dữ kiện mua hàng, không phải ngưỡng tự đặt.', substitution: `MOQ = ${fmt(p?.moq, 0)}` },
      { title: 'Xác định vùng thời gian cần bao phủ', detail: 'Vùng bao phủ bằng chân trời dự báo cuối của phiên.', substitution: `${p?.coverageCycles ?? 0} chu kỳ` },
      { title: 'Tính nhu cầu trong vùng bao phủ', detail: 'Cộng dự báo cuối trong vùng bảo vệ.', substitution: `D_cover = ${fmt(p?.demandCover, 1)}` },
      { title: 'Tính hàng tự do dự kiến trong vùng', detail: 'Nhận I_free đã tính theo mốc, không dùng tồn hiện tại đơn lẻ.', substitution: `I_free = ${fmt(p?.freeStock, 1)}` },
      { title: 'Tính số cần trước làm tròn', detail: 'Chặn dưới tại 0.', substitution: `Q_raw = max(0, ${fmt(p?.demandCover, 1)} + ${fmt(state.safetyStock, 1)} − ${fmt(p?.freeStock, 1)}) = ${fmt(p?.rawQuantity, 1)}` },
      { title: 'Kiểm tra Q_raw > 0', detail: (p?.rawQuantity ?? 0) > 0 ? 'Có nhu cầu đặt, chuyển bước làm tròn.' : 'Không có nhu cầu đặt; số đề xuất bằng 0.', tone: (p?.rawQuantity ?? 0) > 0 ? 'good' : 'warn' },
      { title: 'Làm tròn theo MOQ', detail: 'Làm tròn lên, không cắt sai quy cách.', substitution: `Q_order = ceil(${fmt(p?.rawQuantity, 1)}/${fmt(p?.moq, 0)})×${fmt(p?.moq, 0)} = ${fmt(p?.orderQuantity, 0)}` },
      { title: 'Tính phần dư do MOQ', detail: 'Giữ riêng phần dư để kiểm tra ngoại lệ ở Chặng 18.', substitution: `Surplus = ${fmt(p?.orderQuantity, 1)} − ${fmt(p?.rawQuantity, 1)} = ${fmt(p?.moqSurplus, 1)}` },
      { title: 'Khóa đầu ra Chặng 16', detail: 'Bàn giao Q_raw, Q_order, phần dư MOQ, vùng bao phủ và cảnh báo.', values: (p?.warnings ?? []).map((value, i) => ({ label: `Cảnh báo ${i + 1}`, value })), tone: p?.warnings.length ? 'warn' : 'good' },
    ],
  };
}

function stage17(state: Readonly<SkuPipelineState>, policy: SimulationPolicy): StageTrace {
  const a = state.budgetAllocation;
  return {
    heading: 'Phân bổ vốn theo ưu tiên đã khóa',
    context: 'Chặng 17 không sửa dự báo, SS hoặc Q_order; chỉ cấp vốn theo thứ tự và bội số MOQ.',
    steps: [
      { title: 'Đọc số đặt sau MOQ', detail: 'Nhận nguyên trạng từ Chặng 16.', substitution: `Q_order = ${fmt(state.orderPlan?.orderQuantity, 0)}` },
      { title: 'Đọc giá mua và giá trị đặt', detail: 'Dùng giá mua, không dùng giá bán/giá khuyến mãi.', substitution: `V = ${fmt(state.orderPlan?.orderQuantity, 0)}×${fmt(state.definition.purchasePrice, 0)} = ${fmt(a?.orderValue, 0)} ₫` },
      { title: 'Đọc ngân sách kỳ', detail: 'Ngân sách là đầu vào phiên đã khóa.', substitution: `B = ${fmt(policy.periodBudget, 0)} ₫` },
      { title: 'Đọc chính sách ưu tiên từ Chặng 8', detail: 'Không tự đặt trọng số w₁…w₄ khi tài liệu chưa ban hành.', substitution: `${state.capitalPriority} · hạng ${a?.priorityRank ?? 'chưa khóa'}` },
      { title: 'Tính tổng giá trị đề xuất', detail: 'Engine tính trên toàn danh mục trước khi cấp từng dòng.', substitution: `V_i = ${fmt(a?.orderValue, 0)} ₫` },
      { title: 'Kiểm tra ngân sách đủ hay thiếu', detail: a?.cutQuantity ? 'Dòng không được cấp toàn bộ.' : 'Dòng được cấp đủ hoặc không phát sinh nhu cầu.', tone: a?.cutQuantity ? 'warn' : 'good' },
      { title: 'Sắp xếp ưu tiên giảm dần', detail: 'Thứ tự: Rất cao → Cao → Trung bình → Trung bình thấp → Thấp → Rất thấp.' },
      { title: 'Cấp vốn theo thứ tự đến khi hết ngân sách', detail: 'Chỉ cấp số lượng là bội số MOQ.', substitution: `Q_funded = ${fmt(a?.fundedQuantity, 0)} · V_funded = ${fmt(a?.fundedValue, 0)} ₫` },
      { title: 'Ghi dòng bị cắt/hoãn', detail: a?.reason ?? 'Chưa có kết quả.', substitution: `Q_cut = ${fmt(a?.cutQuantity, 0)}`, tone: a?.cutQuantity ? 'warn' : 'good' },
      { title: 'Khóa đầu ra Chặng 17', detail: 'Bàn giao số được cấp vốn, lý do cắt, hạng ưu tiên và ngân sách đã dùng.' },
    ],
  };
}

function stage18(state: Readonly<SkuPipelineState>): StageTrace {
  const d = state.releaseDecision;
  return {
    heading: 'Cổng ngoại lệ trước khi phát hành',
    context: 'Chặng 18 chỉ quyết định phát hành, giữ lại hoặc chờ bổ sung; không tính lại số đặt.',
    steps: [
      { title: 'Đọc số được cấp vốn', detail: 'Nhận từ Chặng 17.', substitution: `Q_funded = ${fmt(state.budgetAllocation?.fundedQuantity, 0)}` },
      { title: 'Đọc điều kiện mua hàng', detail: 'ETA, MOQ, giá mua, nhà cung cấp và điều kiện đơn mua phải đầy đủ.' },
      { title: 'Đọc danh sách ngoại lệ Chặng 8–16', detail: 'Giữ nguyên mọi cảnh báo, không xóa để phát hành.' },
      { title: 'Chọn dòng SKU − nhà cung cấp', detail: 'Đánh giá đúng một dòng mua.', substitution: `${state.definition.id} − ${state.definition.supplier}` },
      { title: 'Kiểm tra số được cấp vốn > 0', detail: (state.budgetAllocation?.fundedQuantity ?? 0) > 0 ? 'Có số được cấp vốn.' : 'Không phát hành.', tone: (state.budgetAllocation?.fundedQuantity ?? 0) > 0 ? 'good' : 'warn' },
      { title: 'Kiểm tra đủ thông tin mua hàng', detail: state.definition.purchaseTermsComplete ? 'Điều kiện đơn mua đã đủ.' : 'Chuyển chờ bổ sung thông tin.', tone: state.definition.purchaseTermsComplete ? 'good' : 'warn' },
      { title: 'Kiểm tra ngoại lệ cần duyệt', detail: d?.reasons.length ? 'Có ngoại lệ; không tự phát hành.' : 'Không có ngoại lệ được xác định.', values: (d?.reasons ?? []).map((value, i) => ({ label: `Lý do ${i + 1}`, value })), tone: d?.reasons.length ? 'warn' : 'good' },
      { title: 'Phân luồng phát hành/chờ duyệt', detail: `Trạng thái = ${d?.status ?? '—'}`, substitution: `Q_release = ${fmt(d?.releasedQuantity, 0)}` },
      { title: 'Khóa đầu ra Chặng 18', detail: 'Lưu số phát hành, trạng thái, lý do ngoại lệ; không giả lập quyết định của người duyệt.' },
    ],
  };
}

function stage19(state: Readonly<SkuPipelineState>): StageTrace {
  const a = state.postAudit;
  return {
    heading: 'Hậu kiểm và đề xuất cho phiên tương lai',
    context: 'Kết quả cũ được giữ nguyên; Chặng 19 chỉ đo, tách nguyên nhân và tạo đề xuất.',
    steps: [
      { title: 'Đọc dự báo cuối và số đặt phát hành', detail: 'Đọc snapshot đã khóa, không hồi tố.', substitution: `ΣF = ${fmt(state.finalForecast.reduce((s, v) => s + v, 0), 1)} · Q_release = ${fmt(state.releaseDecision?.releasedQuantity, 0)}` },
      { title: 'Đọc bán, tồn, thiếu hàng và hàng nhận thực tế', detail: 'Dùng dữ liệu actual riêng biệt với dữ liệu dự báo.', substitution: `ΣA = ${fmt(a?.actualDemand, 1)} · Ending stock = ${fmt(a?.endingStock, 0)}` },
      { title: 'Đọc ngân sách thực tế và quyết định duyệt', detail: 'Đối chiếu vốn cấp, vốn dùng và trạng thái phát hành.' },
      { title: 'Đo sai số dự báo nền và dự báo cuối', detail: 'WAPE dùng mẫu số tổng thực tế.', substitution: `WAPE = ${a?.forecastWape === null || a?.forecastWape === undefined ? '—' : fmt(a.forecastWape * 100, 2) + '%'}` },
      { title: 'Đo mức phục vụ, thiếu hàng và dư tồn', detail: 'Không quy lỗi chỉ từ một chỉ tiêu.', substitution: `Thiếu = ${fmt(a?.stockoutUnits, 0)} · Tồn cuối = ${fmt(a?.endingStock, 0)}` },
      { title: 'Đo hàng về đúng hoặc trễ kế hoạch', detail: 'Đo trực tiếp lịch sử nhận hàng.', substitution: `Trễ TB = ${fmt(a?.averageReceiptDelayDays, 2)} ngày` },
      { title: 'Đo tác động ngân sách và ngoại lệ duyệt', detail: 'Giữ dấu chênh lệch để truy vết.', substitution: `Vốn cấp − vốn thực dùng = ${fmt(a?.budgetVariance, 0)} ₫` },
      { title: 'Tách nguyên nhân theo chặng phát sinh', detail: a?.primaryCause ?? 'Chưa có kết luận.' },
      { title: 'Kiểm tra dấu hiệu cần thay đổi', detail: a?.proposalStatus === 'future-version' ? 'Có dấu hiệu cần kiểm chứng thay đổi.' : 'Chưa đủ dấu hiệu; tiếp tục theo dõi.', tone: a?.proposalStatus === 'future-version' ? 'warn' : 'good' },
      { title: 'Tạo đề xuất hoặc giữ chính sách', detail: a?.proposal ?? 'Chưa có đề xuất.' },
      { title: 'Khóa báo cáo Chặng 19', detail: 'Đề xuất chỉ áp dụng cho phiên bản tương lai, không sửa ngược C1–C18.' },
    ],
  };
}

export function buildStageTrace(stage: StageNumber, state: Readonly<SkuPipelineState>, policy: SimulationPolicy, focusDate: string | null): StageTrace {
  const focus = focusDate ? state.daily.find(record => record.date === focusDate) ?? null : null;
  switch (stage) {
    case 1: return stage1(state, policy);
    case 2: return stage2(state, policy, focus);
    case 3: return stage3(state, policy, focus);
    case 4: return stage4(state, policy, focus);
    case 5: return stage5(state, policy, focusDate);
    case 6: return stage6(state);
    case 7: return stage7(state);
    case 8: return stage8(state, policy);
    case 9: return stage9(state);
    case 10: return stage10(state);
    case 11: return stage11(state);
    case 12: return stage12(state, focus);
    case 13: return stage13(state, policy);
    case 14: return stage14(state);
    case 15: return stage15(state, policy);
    case 16: return stage16(state);
    case 17: return stage17(state, policy);
    case 18: return stage18(state);
    case 19: return stage19(state);
  }
}
