import { computed, Injectable, signal } from '@angular/core';
import { buildCatalog, DataSourceId, parseHachiBusinessRoles, parseRealDataset, SimulationDataset } from '../domain/catalog';
import { SimulationEngine } from '../domain/simulation-engine';
import { DEFAULT_POLICY, STAGES } from '../domain/policy';
import { getStageFormulas } from '../domain/formula-registry';
import { BusinessRoleComparisonConclusion, BusinessRoleComparisonRow, ExceptionCode, ExceptionTask, HachiBusinessRole, SimulationPolicy, SkuPipelineState, StageNumber, StageSnapshot, StageViewModel } from '../domain/models';

/** §6.2 LỆNH CODEX — hai nhóm mức độ nghiêm trọng để lọc hàng đợi ngoại lệ trong UI. */
const BLOCKING_EXCEPTION_CODES: readonly ExceptionCode[] = ['ABC_INPUT_BLOCKED', 'CLASSIFICATION_BLOCKED', 'FORECAST_INPUT_BLOCKED', 'CYCLE_EXCEPTION'];
export function exceptionSeverity(code: ExceptionCode): 'BLOCKING' | 'REVIEW' {
  return BLOCKING_EXCEPTION_CODES.includes(code) ? 'BLOCKING' : 'REVIEW';
}

/**
 * §7.1 LỆNH CODEX — quy tắc đối chiếu HachiBusinessRole (benchmark, KHÔNG dùng làm đầu vào tính toán) với kết
 * quả hệ thống tính ĐỘC LẬP. CORE/MARGIN/TRAFFIC/STANDARD không thể suy ra trực tiếp từ demand đơn lẻ — chỉ
 * đối chiếu tham khảo hoặc báo NOT_COMPARABLE_WITH_CURRENT_DATA khi thiếu dữ liệu cần thiết (giá vốn/biên lợi
 * nhuận cho MARGIN, giỏ hàng/lượt khách cho TRAFFIC).
 */
function compareBusinessRole(role: HachiBusinessRole, state: Readonly<SkuPipelineState>): { conclusion: BusinessRoleComparisonConclusion; comparableLevel: string; systemResult: string; reason: string } {
  const { abc, xyz, classificationStatus } = state.classification;
  const systemResult = `ABC=${abc} · XYZ/D=${xyz ?? classificationStatus} · Mùa vụ=${state.seasonality} · Mô hình=${state.forecast?.model ?? 'Chưa có'}`;
  if (role === 'SEASONAL') {
    const level = 'Đối chiếu được với kết quả mùa vụ Chặng 9';
    if (state.seasonality === 'confirmed') return { conclusion: 'ALIGNED', comparableLevel: level, systemResult, reason: 'Hệ thống xác nhận mùa vụ (Chặng 9) khớp benchmark SEASONAL.' };
    if (state.seasonality === 'no-clear-season') return { conclusion: 'POSSIBLE_DIFFERENCE', comparableLevel: level, systemResult, reason: 'Hệ thống không thấy mùa vụ rõ dù benchmark gắn SEASONAL — cần rà soát thêm, không kết luận benchmark sai.' };
    return { conclusion: 'INVESTIGATION_REQUIRED', comparableLevel: level, systemResult, reason: 'Chưa đủ cấu trúc/chuỗi để hệ thống kết luận mùa vụ (insufficient-structure/not-applicable).' };
  }
  if (role === 'NEW') {
    const level = 'Chỉ đối chiếu được khi có ProductLifecycleRecord (hiện chưa nạp cho SKU này)';
    return { conclusion: 'NOT_COMPARABLE_WITH_CURRENT_DATA', comparableLevel: level, systemResult, reason: 'Chưa có ProductLifecycleRecord chính thức — không được suy ra vòng đời chỉ từ HachiBusinessRole=NEW.' };
  }
  if (role === 'CORE') {
    const level = 'Không suy ra trực tiếp từ demand — chỉ đối chiếu tham khảo với ABC, mức phục vụ và độ ổn định';
    if (classificationStatus === 'CLASSIFICATION_BLOCKED' || abc === 'N/A') return { conclusion: 'INVESTIGATION_REQUIRED', comparableLevel: level, systemResult, reason: 'Hệ thống chưa xếp hạng được ABC/XYZ cho SKU này (đứt quãng hoặc thiếu dữ liệu).' };
    if (abc === 'A') return { conclusion: 'ALIGNED', comparableLevel: level, systemResult, reason: 'ABC=A tham khảo phù hợp với vai trò CORE (chỉ mang tính tham khảo, không phải bằng chứng đầy đủ).' };
    return { conclusion: 'POSSIBLE_DIFFERENCE', comparableLevel: level, systemResult, reason: `ABC=${abc} không nằm ở nhóm giá trị cao nhất — khác trục phân loại với CORE, không kết luận "sai".` };
  }
  if (role === 'MARGIN') {
    const level = 'Cần giá vốn/biên lợi nhuận (landedCostPerUnit)';
    if (state.definition.landedCostPerUnit === null) return { conclusion: 'NOT_COMPARABLE_WITH_CURRENT_DATA', comparableLevel: level, systemResult, reason: 'Thiếu landedCostPerUnit — không nhận diện được vai trò MARGIN chỉ từ dữ liệu demand.' };
    return { conclusion: 'INVESTIGATION_REQUIRED', comparableLevel: level, systemResult, reason: 'Có landedCostPerUnit nhưng hệ thống chưa có ngưỡng biên lợi nhuận chính thức để tự kết luận.' };
  }
  if (role === 'TRAFFIC') {
    return { conclusion: 'NOT_COMPARABLE_WITH_CURRENT_DATA', comparableLevel: 'Cần dữ liệu giỏ hàng/lượt khách (chưa có nguồn nào trong app)', systemResult, reason: 'Không có dữ liệu giỏ hàng/lượt khách — không thể nhận diện vai trò TRAFFIC từ demand SKU đơn lẻ.' };
  }
  // STANDARD — vai trò vận hành mặc định, không phải lớp demand pattern nên không đối chiếu.
  return { conclusion: 'NOT_EVALUATED', comparableLevel: 'Vai trò vận hành mặc định, không phải lớp demand pattern', systemResult, reason: 'STANDARD không mang tín hiệu demand pattern để đối chiếu.' };
}

// toLocaleString tạo Intl.NumberFormat mới mỗi lần gọi — cache theo số chữ số để tránh chi phí đó trên đường render.
const NUMBER_FORMATS = new Map<number, Intl.NumberFormat>();
export function viNumberFormat(digits: number): Intl.NumberFormat {
  let format = NUMBER_FORMATS.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
    NUMBER_FORMATS.set(digits, format);
  }
  return format;
}

function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Chưa có';
  return viNumberFormat(digits).format(value);
}

function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Chưa có' : `${formatNumber(value * 100, 1)}%`;
}

function createInputs(stage: StageNumber, state: Readonly<SkuPipelineState> | null, policy: SimulationPolicy): StageViewModel['inputs'] {
  if (!state) return stage === 1 ? [
    { label: 'Ngày chạy', value: policy.runDate },
    { label: 'Lịch sử chuẩn', value: `${policy.historyYears} năm` },
    { label: 'Chu kỳ M', value: `${policy.cycleLength} ngày` },
  ] : [];
  const locked = state.cycles.filter(cycle => cycle.locked);
  switch (stage) {
    case 2: return [{ label: 'Bản ghi ngày', value: formatNumber(state.daily.length) }, { label: 'Giờ quy định', value: policy.cutoffHour }];
    case 3: return [{ label: 'Ngày stockout', value: formatNumber(state.daily.filter(row => row.isStockout).length) }, { label: 'Bán kính tối đa', value: `±${policy.maxReferenceRadius} ngày` }];
    case 4: return [{ label: 'Ngày CTKM', value: formatNumber(state.daily.filter(row => row.promoCode).length) }, { label: 'Nguồn nền', value: 'Ngày sạch quan sát' }];
    case 5: return [{ label: 'Ngày có nền', value: formatNumber(state.daily.filter(row => row.baseDemand !== null).length) }, { label: 'Độ dài M', value: `${policy.cycleLength} ngày` }];
    case 6: return [{ label: 'Chu kỳ khóa', value: formatNumber(locked.length) }, { label: 'Đơn giá chuẩn', value: `${formatNumber(state.definition.price)} ₫` }];
    case 7: return [{ label: 'Chuỗi khóa n', value: formatNumber(locked.length) }, { label: 'Chu kỳ dương m', value: formatNumber(locked.filter(cycle => cycle.baseDemand > 0).length) }];
    case 8: return [{ label: 'ABC đã khóa', value: state.classification.abc }, { label: 'XYZ/D đã khóa', value: state.classification.xyz ?? 'BLOCKED' }];
    case 9: return [{ label: 'Nhóm nhu cầu', value: state.classification.xyz ?? 'BLOCKED' }, { label: 'Số vòng đủ', value: formatNumber(Math.floor(locked.length / 24)) }];
    case 10: return [{ label: '12 CK gần nhất', value: locked.length >= 12 ? 'Đủ' : 'Thiếu' }, { label: 'Mùa vụ', value: state.seasonality }];
    case 11: return [{ label: 'ABC × XYZ', value: `${state.classification.abc}${state.classification.xyz}` }, { label: 'Mùa vụ / xu hướng', value: `${state.seasonality} / ${state.trend}` }];
    case 12: return [{ label: 'Ngày KM đủ nền', value: formatNumber(state.daily.filter(row => row.promoCode && row.baseDemand !== null).length) }, { label: 'Nguồn bán', value: 'sales gốc' }];
    case 13: return [{ label: 'Dự báo nền', value: state.forecast ? `${state.forecast.baseForecast.length} CK` : 'Chưa có' }, { label: 'Hệ số K', value: formatNumber(state.promoFactor, 2) }];
    case 14: return [{ label: 'Tồn hiện có', value: formatNumber(state.daily.at(-1)?.closeStock ?? 0) }, { label: 'Dự báo cuối TB', value: formatNumber(state.finalForecast.length ? state.finalForecast.reduce((sum, value) => sum + value, 0) / state.finalForecast.length : 0, 1) }];
    case 15: return [{ label: 'Mức phục vụ', value: state.serviceLevel ? `${state.serviceLevel}%` : 'Chính sách riêng' }, { label: 'Mẫu lead time', value: `${state.definition.leadTimeHistoryDays.length} lần nhận` }];
    case 16: return [{ label: 'Dự báo cuối', value: `${state.finalForecast.length} CK` }, { label: 'MOQ', value: formatNumber(state.definition.moq) }];
    case 17: return [{ label: 'Ngân sách kỳ', value: `${formatNumber(policy.periodBudget)} ₫` }, { label: 'Ưu tiên C8', value: state.capitalPriority }];
    case 18: return [{ label: 'Số được cấp vốn', value: formatNumber(state.budgetAllocation?.fundedQuantity) }, { label: 'Điều kiện mua', value: state.definition.purchaseTermsComplete ? 'Đủ' : 'Thiếu' }];
    case 19: return [{ label: 'Nhu cầu thực tế', value: formatNumber(state.definition.actualDemand.reduce((sum, value) => sum + value, 0)) }, { label: 'Trạng thái phát hành', value: state.releaseDecision?.status ?? 'Chưa có' }];
    default: return [{ label: 'Bản ghi', value: formatNumber(state.daily.length) }];
  }
}

function createCalculations(stage: StageNumber, state: Readonly<SkuPipelineState> | null): StageViewModel['calculations'] {
  if (!state) return [];
  const locked = state.cycles.filter(cycle => cycle.locked);
  const lastCycle = locked.at(-1);
  switch (stage) {
    case 2: return [{ label: 'Stockout đã đánh dấu', value: formatNumber(state.daily.filter(row => row.isStockout).length) }];
    case 3: return [{ label: 'Nâng nền stockout', value: formatNumber(state.daily.filter(row => row.baseSource === 'stockout-lifted').length) }, { label: 'Thiếu căn cứ', value: formatNumber(state.daily.filter(row => row.baseSource === 'insufficient').length) }];
    case 4: return [{ label: 'Ngày KM chuẩn hóa', value: formatNumber(state.daily.filter(row => row.baseSource === 'promo-normalized').length) }];
    case 5: return [{ label: 'Chu kỳ gần nhất', value: lastCycle ? `ΣBₜ = ${formatNumber(lastCycle.baseDemand, 1)}` : 'Chưa có' }, { label: 'Ngày chưa giải quyết', value: formatNumber(state.cycles.reduce((sum, cycle) => sum + cycle.unresolvedDays, 0)) }];
    case 6: return [
      { label: 'Tổng SL trong kỳ', value: formatNumber(state.classification.periodQuantity, 1) },
      { label: 'Hệ số chuẩn hóa năm', value: formatNumber(state.classification.annualizationFactor, 2) },
      { label: 'Tổng SL năm', value: formatNumber(state.classification.annualQuantity, 1) },
      { label: 'Giá trị năm hóa', value: `${formatNumber(state.classification.annualValue)} ₫` },
      { label: 'Tỷ trọng giá trị', value: formatPercent(state.classification.valueShare) },
      { label: 'Hạng / lũy kế', value: state.classification.abcRank ? `#${state.classification.abcRank} · ${formatPercent(state.classification.cumulativeShare)}` : 'Không xếp' },
    ];
    case 7: return [
      { label: 'n / m', value: `${state.classification.n} / ${state.classification.m}` },
      { label: 'ADI = n/m', value: formatNumber(state.classification.adi, 2) },
      { label: 'μ chu kỳ dương', value: formatNumber(state.classification.positiveMean, 2) },
      { label: 'σ quần thể', value: formatNumber(state.classification.positiveStdev, 2) },
      { label: 'CV', value: formatNumber(state.classification.cv, 3) },
      { label: 'CV²', value: formatNumber(state.classification.cv2, 3) },
    ];
    case 9: return [{ label: 'Cấu trúc mùa vụ', value: state.seasonality }, { label: 'Chu kỳ dùng', value: formatNumber(locked.length) }];
    case 10: return [{ label: 'g₁', value: formatPercent(state.trendRates[0]) }, { label: 'g₂', value: formatPercent(state.trendRates[1]) }];
    case 11: return [
      { label: 'WAPE', value: formatPercent(state.forecast?.wape) },
      { label: 'Bias', value: formatPercent(state.forecast?.bias) },
      ...(state.forecast?.pStar != null ? [{ label: 'p* chu kỳ ngắn', value: `${state.forecast.pStar} CK` }] : []),
      ...(state.forecast?.controlModel ? [{ label: 'Đối chứng [C11 §8.10]', value: `${state.forecast.controlModel} · WAPE ${formatPercent(state.forecast.controlWape)}` }] : []),
      ...(state.forecast?.reliability === 'low' ? [{ label: 'Độ tin cậy', value: 'THẤP — TEST < 3 CK' }] : []),
    ];
    case 12: return [{ label: 'K khóa', value: formatNumber(state.promoFactor, 2) }, { label: 'Độ tin cậy', value: state.promoConfidence }];
    case 13: return state.finalForecast.map((value, index) => ({ label: `CK +${index + 1}`, value: formatNumber(value, 1) }));
    case 14: return [{ label: 'I_free(t)', value: formatNumber(state.freeStock) }, { label: 'Mốc bảo vệ', value: 'Hàng về kho' }];
    case 15: return [{ label: 'D̄', value: formatNumber(state.finalForecast.length ? state.finalForecast.reduce((sum, value) => sum + value, 0) / state.finalForecast.length : 0, 1) }, { label: 'SS đầy đủ', value: formatNumber(state.safetyStock) }];
    case 16: return [{ label: 'Qraw', value: formatNumber(state.orderPlan?.rawQuantity, 1) }, { label: 'Dư MOQ', value: formatNumber(state.orderPlan?.moqSurplus, 1) }];
    case 17: return [{ label: 'Giá trị đề xuất', value: `${formatNumber(state.budgetAllocation?.orderValue)} ₫` }, { label: 'Số bị cắt', value: formatNumber(state.budgetAllocation?.cutQuantity) }];
    case 18: return [{ label: 'Số ngoại lệ', value: formatNumber(state.releaseDecision?.reasons.length) }, { label: 'Số phát hành', value: formatNumber(state.releaseDecision?.releasedQuantity) }];
    case 19: return [{ label: 'WAPE', value: formatPercent(state.postAudit?.forecastWape) }, { label: 'Thiếu hàng', value: formatNumber(state.postAudit?.stockoutUnits) }];
    default: return [];
  }
}

function createOutputs(stage: StageNumber, state: Readonly<SkuPipelineState> | null): StageViewModel['outputs'] {
  if (!state) return [];
  switch (stage) {
    case 1: return [{ label: 'Ngày có ghi nhận bán', value: formatNumber(state.daily.filter(day => day.hasRecord).length), tone: 'good' }];
    case 2: return [{ label: 'Trạng thái', value: 'Đã khóa cờ stockout', tone: 'good' }];
    case 3: return [{ label: 'Cột bàn giao', value: 'baseDemand ngày không KM', tone: 'good' }];
    case 4: return [{ label: 'Cột bàn giao', value: 'baseDemand ngày CTKM', tone: 'good' }];
    case 5: return [{ label: 'Chu kỳ locked', value: formatNumber(state.cycles.filter(cycle => cycle.locked).length), tone: 'good' }, { label: 'Chu kỳ không dùng', value: formatNumber(state.cycles.filter(cycle => !cycle.locked).length), tone: 'warn' }];
    case 6: return [{ label: 'Nhóm ABC', value: state.classification.abc, tone: state.classification.abc === 'N/A' ? 'warn' : 'good' }];
    case 7: return [{ label: 'Nhóm XYZ/D', value: state.classification.xyz ?? 'BLOCKED', tone: state.classification.xyz === 'D' || state.classification.xyz === null ? 'warn' : 'good' }];
    case 8: return [{ label: 'Ô chính sách', value: state.serviceLevel ? `${state.classification.abc}${state.classification.xyz}` : 'D / ngoại lệ', tone: state.serviceLevel ? 'good' : 'warn' }, { label: 'Mức phục vụ', value: state.serviceLevel ? `${state.serviceLevel}%` : 'Duyệt riêng' }];
    case 9: return [{ label: 'Kết luận', value: state.seasonality, tone: state.seasonality === 'insufficient-structure' ? 'warn' : 'good' }];
    case 10: return [{ label: 'Công tắc', value: state.trend === 'up' || state.trend === 'down' ? 'Holt' : 'SES', tone: 'good' }];
    case 11: return [{ label: 'Mô hình', value: state.forecast?.model ?? 'Chưa có', tone: 'good' }, { label: 'Khóa', value: state.forecast?.lockStatus ?? 'Chưa có', tone: state.forecast?.lockStatus === 'locked' ? 'good' : 'warn' }];
    case 12: return [{ label: 'Hệ số CTKM', value: formatNumber(state.promoFactor, 2), tone: state.promoConfidence === 'auto' ? 'good' : 'warn' }];
    case 13: return [{ label: 'Dự báo cuối', value: `${state.finalForecast.length} chu kỳ`, tone: 'good' }];
    case 14: return [{ label: 'Hàng tự do', value: formatNumber(state.freeStock), tone: 'good' }];
    case 15: return [{ label: 'Tồn an toàn', value: state.safetyStock === null ? 'Chính sách riêng' : formatNumber(state.safetyStock), tone: state.safetyStock === null ? 'warn' : 'good' }];
    case 16: return [{ label: 'Số đặt sau MOQ', value: formatNumber(state.orderPlan?.orderQuantity), tone: state.orderPlan?.warnings.length ? 'warn' : 'good' }];
    case 17: return [{ label: 'Số được cấp vốn', value: formatNumber(state.budgetAllocation?.fundedQuantity), tone: state.budgetAllocation?.cutQuantity ? 'warn' : 'good' }];
    case 18: return [{ label: 'Trạng thái', value: state.releaseDecision?.status ?? 'Chưa có', tone: state.releaseDecision?.status === 'issued' ? 'good' : 'warn' }];
    case 19: return [{ label: 'Hậu kiểm', value: state.postAudit?.proposalStatus === 'future-version' ? 'Đề xuất phiên sau' : 'Tiếp tục theo dõi', tone: state.postAudit?.proposalStatus === 'future-version' ? 'warn' : 'good' }];
  }
}

@Injectable({ providedIn: 'root' })
export class SimulationStore {
  private readonly catalogSignal = signal(buildCatalog());
  private realDataset: SimulationDataset | null = null;

  get catalog(): readonly SkuPipelineState['definition'][] { return this.catalogSignal(); }

  readonly policy = signal<SimulationPolicy>({ ...DEFAULT_POLICY });
  readonly dataSource = signal<DataSourceId>('mock');
  readonly dataSourceError = signal<string | null>(null);
  readonly isLoadingDataSource = signal(false);
  readonly dataSourceLabel = computed(() => this.dataSource() === 'real' ? 'Dữ liệu thật' : 'Dữ liệu giả');
  readonly activeStage = signal<StageNumber>(1);
  readonly completedStage = signal(0);
  readonly selectedSkuId = signal('SKU-001');
  readonly snapshots = signal<Partial<Record<StageNumber, StageSnapshot>>>({});
  readonly error = signal<string | null>(null);
  readonly isRunning = signal(false);

  readonly realFinalState = signal<Record<string, SkuPipelineState> | null>(null);
  readonly mockFinalState = signal<Record<string, SkuPipelineState> | null>(null);
  readonly isGeneratingReportData = signal(false);

  readonly currentSnapshot = computed(() => this.snapshots()[this.activeStage()] ?? null);
  readonly inputSnapshot = computed(() => {
    const stage = this.activeStage();
    return stage === 1 ? null : this.snapshots()[(stage - 1) as StageNumber] ?? null;
  });
  readonly selectedState = computed(() => this.currentSnapshot()?.states[this.selectedSkuId()] ?? null);
  readonly inputState = computed(() => this.inputSnapshot()?.states[this.selectedSkuId()] ?? null);
  readonly view = computed<StageViewModel>(() => {
    const stage = this.activeStage();
    const snapshot = this.currentSnapshot();
    const outputState = this.selectedState();
    const inputState = this.inputState();
    return {
      definition: STAGES[stage - 1],
      hasRun: !!snapshot,
      state: outputState,
      summary: snapshot?.summary ?? {},
      audit: snapshot?.audit ?? [],
      exceptions: snapshot?.exceptions ?? [],
      inputs: createInputs(stage, stage === 1 ? outputState : inputState, this.policy()),
      calculations: createCalculations(stage, outputState),
      outputs: createOutputs(stage, outputState),
      formulas: getStageFormulas(stage, outputState, this.policy()),
    };
  });

  // ── §6.1 LỆNH CODEX — hàng đợi ngoại lệ gộp từ mọi chặng đã chạy, dedupe theo id (mỗi StageSnapshot.exceptions
  // chỉ chứa ngoại lệ MỚI của riêng chặng đó — xem models.ts) ──
  readonly allExceptions = computed<ExceptionTask[]>(() => {
    const byId = new Map<string, ExceptionTask>();
    for (const snapshot of Object.values(this.snapshots())) {
      for (const task of snapshot!.exceptions) byId.set(task.id, task);
    }
    return [...byId.values()];
  });
  readonly selectedSkuExceptions = computed(() => this.allExceptions().filter(task => task.skuId === this.selectedSkuId()));
  readonly activeStageExceptions = computed(() => this.allExceptions().filter(task => task.stage === this.activeStage()));
  readonly selectedSkuCycleExceptions = computed(() => this.selectedSkuExceptions().filter(task => (task.cycleIndexes?.length ?? 0) > 0));

  // ── §7 LỆNH CODEX — benchmark HachiBusinessRole, nạp riêng khỏi pipeline SQL; chỉ dùng để đối chiếu ──
  private hachiBusinessRoles: Readonly<Record<string, HachiBusinessRole>> = {};
  readonly businessRoleComparison = computed<BusinessRoleComparisonRow[]>(() => {
    const states = this.currentSnapshot()?.states ?? null;
    if (!states) return [];
    return Object.values(states).map(state => {
      const role = this.hachiBusinessRoles[state.definition.id] ?? null;
      if (!role) return { skuId: state.definition.id, skuName: state.definition.name, hachiRole: null, systemResult: '—', comparableLevel: 'Không có benchmark cho SKU này', conclusion: 'NOT_EVALUATED' as BusinessRoleComparisonConclusion, reason: 'SKU không có trong benchmark HachiBusinessRole.' };
      const comparison = compareBusinessRole(role, state);
      return { skuId: state.definition.id, skuName: state.definition.name, hachiRole: role, ...comparison };
    });
  });

  constructor(private readonly engine: SimulationEngine) {}

  /** §6.3 LỆNH CODEX — "Đi tới Chặng" + "Xem SKU" của một ngoại lệ; điều hướng, không tự thực hiện phương án. */
  async jumpToException(task: ExceptionTask): Promise<void> {
    await this.selectStage(task.stage);
    this.selectSku(task.skuId);
  }

  selectStage(stage: StageNumber): Promise<void> {
    if (this.isRunning() || this.isLoadingDataSource()) return Promise.resolve();
    this.activeStage.set(stage);
    this.error.set(null);
    if (stage > this.completedStage()) return this.runThrough(stage);
    return Promise.resolve();
  }

  selectSku(skuId: string): void {
    if (this.catalog.some(sku => sku.id === skuId)) this.selectedSkuId.set(skuId);
  }

  updatePolicy(patch: Partial<SimulationPolicy>): Promise<void> {
    if (this.isRunning() || this.isLoadingDataSource()) return Promise.resolve();

    const currentPolicy = this.policy();
    const changed = (Object.keys(patch) as (keyof SimulationPolicy)[])
      .some(key => patch[key] !== currentPolicy[key]);
    if (!changed) return Promise.resolve();

    // Đổi tham số phiên làm mọi snapshot cũ hết hiệu lực, nhưng KHÔNG được cắt bỏ tiến độ
    // các chặng đã hoàn thành trước đó chỉ vì người dùng đang xem lại một chặng sớm hơn —
    // nếu không, dữ liệu Chặng {viewedStage+1}..{completedStage cũ} biến mất khỏi mọi panel
    // ("Dữ liệu qua từng chặng") cho đến khi bấm lại từng tab một.
    const viewedStage = this.activeStage();
    const recomputeTarget = Math.max(viewedStage, this.completedStage()) as StageNumber;
    this.policy.update(policy => ({ ...policy, ...patch }));
    this.snapshots.set({});
    this.completedStage.set(0);
    this.error.set(null);
    this.realFinalState.set(null);
    this.mockFinalState.set(null);

    return this.runThrough(recomputeTarget).then(() => this.activeStage.set(viewedStage));
  }

  runActive(): void {
    const stage = this.activeStage();
    if (stage !== this.completedStage() + 1 || this.isRunning() || this.isLoadingDataSource()) return;
    this.isRunning.set(true);
    this.error.set(null);
    try {
      const previous = stage === 1 ? null : this.snapshots()[(stage - 1) as StageNumber] ?? null;
      const snapshot = this.engine.run(stage, previous, this.policy());
      this.snapshots.update(snapshots => ({ ...snapshots, [stage]: snapshot }));
      this.completedStage.set(stage);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Không thể chạy chặng.');
    } finally {
      this.isRunning.set(false);
    }
  }

  runAll(): void {
    if (this.isLoadingDataSource()) return;
    void this.runThrough(19);
  }

  async selectDataSource(source: DataSourceId, targetStage: StageNumber = Math.max(1, this.activeStage(), this.completedStage()) as StageNumber): Promise<void> {
    if (this.isRunning() || this.isLoadingDataSource()) return;
    if (source === this.dataSource()) {
      if (targetStage > this.completedStage()) await this.runThrough(targetStage);
      return;
    }

    const viewedStage = this.activeStage();
    this.isLoadingDataSource.set(true);
    this.error.set(null);
    this.dataSourceError.set(null);
    try {
      const dataset = source === 'real' ? await this.loadRealDataset() : null;
      if (dataset?.dateRange && this.policy().runDate > dataset.dateRange.max) {
        this.policy.update(policy => ({ ...policy, runDate: dataset.dateRange!.recommendedRunDate }));
      }
      this.engine.setDataset(dataset);
      const catalog = dataset?.catalog ?? buildCatalog();
      this.catalogSignal.set([...catalog]);
      this.selectedSkuId.set(catalog[0]?.id ?? '');
      this.dataSource.set(source);
      this.snapshots.set({});
      this.completedStage.set(0);
      this.isLoadingDataSource.set(false);
      await this.runThrough(targetStage);
      this.activeStage.set(viewedStage);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể nạp nguồn dữ liệu mô phỏng.';
      this.error.set(message);
      this.dataSourceError.set(message);
    } finally {
      this.isLoadingDataSource.set(false);
    }
  }

  private async runThrough(targetStage: StageNumber): Promise<void> {
    if (this.isRunning() || this.isLoadingDataSource() || targetStage <= this.completedStage()) return;
    this.activeStage.set(targetStage);
    this.isRunning.set(true);
    this.error.set(null);
    try {
      const nextSnapshots = { ...this.snapshots() };
      for (let number = this.completedStage() + 1; number <= targetStage; number++) {
        await new Promise<void>(resolve => setTimeout(resolve));
        const stage = number as StageNumber;
        const previous = stage === 1 ? null : nextSnapshots[(stage - 1) as StageNumber] ?? null;
        nextSnapshots[stage] = this.engine.run(stage, previous, this.policy());
        this.completedStage.set(stage);
        this.snapshots.set({ ...nextSnapshots });
      }
      if (targetStage >= 13) {
        if (this.dataSource() === 'real') {
          this.realFinalState.set(nextSnapshots[13]?.states ?? null);
        } else {
          this.mockFinalState.set(nextSnapshots[13]?.states ?? null);
        }
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Pipeline đã dừng vì lỗi hợp đồng dữ liệu.');
    } finally {
      this.isRunning.set(false);
    }
  }

  async generateReportData(): Promise<void> {
    if (this.realFinalState() && this.mockFinalState()) return;
    if (this.isGeneratingReportData()) return;
    this.isGeneratingReportData.set(true);
    try {
      const originalSource = this.dataSource();
      
      // 1. Run for 'real' if missing
      if (!this.realFinalState()) {
        const dataset = await this.loadRealDataset();
        this.engine.setDataset(dataset);
        const nextSnapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
        for (let number = 1; number <= 13; number++) {
          const stage = number as StageNumber;
          const previous = stage === 1 ? null : nextSnapshots[(stage - 1) as StageNumber] ?? null;
          nextSnapshots[stage] = this.engine.run(stage, previous, this.policy());
        }
        this.realFinalState.set(nextSnapshots[13]?.states ?? null);
      }

      // 2. Run for 'mock' if missing
      if (!this.mockFinalState()) {
        this.engine.setDataset(null);
        const nextSnapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
        for (let number = 1; number <= 13; number++) {
          const stage = number as StageNumber;
          const previous = stage === 1 ? null : nextSnapshots[(stage - 1) as StageNumber] ?? null;
          nextSnapshots[stage] = this.engine.run(stage, previous, this.policy());
        }
        this.mockFinalState.set(nextSnapshots[13]?.states ?? null);
      }

      // 3. Restore dataset in engine
      if (originalSource === 'real') {
        const dataset = await this.loadRealDataset();
        this.engine.setDataset(dataset);
      } else {
        this.engine.setDataset(null);
      }
    } catch (error) {
      console.error('Error generating report data:', error);
    } finally {
      this.isGeneratingReportData.set(false);
    }
  }

  goNext(): void {
    if (this.activeStage() < 19) void this.selectStage((this.activeStage() + 1) as StageNumber);
  }

  goPrevious(): void {
    if (this.activeStage() > 1) this.activeStage.update(stage => (stage - 1) as StageNumber);
  }

  reset(): void {
    this.snapshots.set({});
    this.completedStage.set(0);
    this.activeStage.set(1);
    this.error.set(null);
  }

  private async loadRealDataset(): Promise<SimulationDataset> {
    if (this.realDataset) return this.realDataset;
    const [daily, products, extractMetadata, businessRoles] = await Promise.all([
      this.fetchText('assets/demand-planning-real.json'),
      // List-product.json là metadata bổ sung không bắt buộc (Price/ProductName giờ
      // đã nằm sẵn trong từng dòng daily) — thiếu file này không được chặn nạp dữ liệu thật.
      this.fetchTextOptional('assets/List-product.json'),
      // §9 LỆNH CODEX — ExtractMetadata thật (RESULT SET 3 demand-planing-v3.sql), optional: pipeline
      // ingest hiện tại (tools/convert-real-data.mjs) chưa sinh file này nên mặc định vắng mặt.
      this.fetchTextOptional('assets/extract-metadata.json'),
      // §7 LỆNH CODEX — benchmark HachiBusinessRole, optional, KHÔNG thuộc pipeline SQL.
      this.fetchTextOptional('assets/hachi-business-roles.json'),
    ]);
    this.hachiBusinessRoles = parseHachiBusinessRoles(businessRoles);
    this.realDataset = parseRealDataset(daily, products, extractMetadata);
    return this.realDataset;
  }

  private async fetchText(path: string): Promise<string> {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Không đọc được ${path} (${response.status}).`);
    return response.text();
  }

  private async fetchTextOptional(path: string): Promise<string> {
    try {
      return await this.fetchText(path);
    } catch {
      return '[]';
    }
  }

  /**
   * §8 LỆNH CODEX — trước đây `stage>=8: serviceLevel===null ? 'D' : ...` gộp NHẦM mọi lý do serviceLevel=null
   * (CLASSIFICATION_BLOCKED, ABC=N/A, ô ma trận chưa cấu hình) thành nhãn 'D', dù SKU đó không hề ở nhóm D.
   * Phân nhánh đúng thứ tự: chặn phân loại → chưa xếp ABC → thật sự là nhóm D (kèm subtype) → còn thiếu
   * chính sách (POLICY_PENDING, không phải D) → nhãn lớp bình thường.
   */
  stageLabel(state: Readonly<SkuPipelineState> | null, stage = this.activeStage()): string {
    if (!state || stage < 6) return '—';
    if (stage === 6) return state.classification.abc;
    if (stage === 7) return state.classification.xyz === 'D' ? 'D' : state.classification.xyz === null ? 'BLOCKED' : `${state.classification.abc}${state.classification.xyz}`;
    const { classification } = state;
    if (classification.classificationStatus === 'CLASSIFICATION_BLOCKED') return 'BLOCKED';
    if (classification.abc === 'N/A') return 'N/A';
    if (classification.xyz === 'D') return classification.dSubtype ?? 'D';
    if (state.serviceLevel === null) return 'POLICY_PENDING';
    return `${classification.abc}${classification.xyz ?? 'BLOCKED'}`;
  }
}
