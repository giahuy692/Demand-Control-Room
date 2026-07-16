import { KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { STAGES } from './features/demand-control-room/domain/policy';
import { DataSourceId } from './features/demand-control-room/domain/catalog';
import { CycleRecord, DailyRecord, ExceptionTask, SkuDefinition, SkuPipelineState, StageNumber } from './features/demand-control-room/domain/models';
import { buildStageTrace } from './features/demand-control-room/domain/stage-trace';
import {
  buildAbcBoard, buildForecastAudit, buildFinalForecastAudit, buildPolicyMatrix, buildPromoAudit,
  buildSafetyAudit, buildSeasonalityAudit, buildSupplyAudit, buildTrendAudit, buildXyzBoard,
} from './features/demand-control-room/domain/stage-insights';
import { explainLearningCell, LearningColumn } from './features/demand-control-room/domain/forecast-models';
import { exceptionSeverity, SimulationStore, viNumberFormat } from './features/demand-control-room/application/state/simulation.store';
import { JourneyMapComponent } from './features/demand-control-room/ui/components/journey-map.component';
import { MathFormulaComponent } from './features/demand-control-room/ui/components/math-formula.component';
import { ComparisonReportComponent } from './features/demand-control-room/ui/components/comparison-report.component';
import { SimulationReportComponent } from './features/demand-control-room/ui/components/simulation-report.component';
import { buildStageTableExport, encodeStageTableCsv } from './features/demand-control-room/domain/stage-table-export';

const AUDIT_ROW_LIMIT = 300;

type DemandChartBarKind = 'observed' | 'adjusted' | 'missing' | 'forecast' | 'inferred';

interface DemandChartBar {
  key: string;
  label: string;
  value: number | null;
  height: number;
  kind: DemandChartBarKind;
  tooltip: string;
}

interface DemandStructureChart {
  subtitle: string;
  unit: string;
  bars: DemandChartBar[];
  firstLabel: string;
  lastLabel: string;
  missingCount: number;
  ariaLabel: string;
}

function normalizeDemandBars(
  bars: Omit<DemandChartBar, 'height'>[],
  subtitle: string,
  unit: string,
): DemandStructureChart {
  const max = Math.max(1, ...bars.map(bar => bar.value ?? 0));
  const normalized = bars.map(bar => ({
    ...bar,
    height: bar.value === null ? 9 : bar.value === 0 ? 3 : Math.max(5, (bar.value / max) * 100),
  }));
  const missingCount = normalized.filter(bar => bar.kind === 'missing').length;
  return {
    subtitle,
    unit,
    bars: normalized,
    firstLabel: normalized[0]?.label ?? '—',
    lastLabel: normalized.at(-1)?.label ?? '—',
    missingCount,
    ariaLabel: `Cấu trúc nhu cầu gồm ${normalized.length} điểm; ${missingCount} điểm thiếu dữ liệu.`,
  };
}

function buildDemandStructureChart(stage: StageNumber, state: Readonly<SkuPipelineState>): DemandStructureChart | null {
  // Chặng 1–4 làm việc ở cấp NGÀY — hiển thị 60 ngày; từ Chặng 3–4 ngày đã chuẩn hóa nền
  // (baseSource stockout-lifted/promo-normalized) hiện dạng "đã chỉnh nền" thay vì thiếu.
  if (stage <= 4) {
    const bars = state.daily.slice(-60).map(row => {
      const adjusted = row.baseDemand !== null && row.baseSource !== null && row.baseSource !== 'clean';
      const value = row.baseDemand ?? (row.hasRecord && row.sales !== null ? row.sales : null);
      return {
        key: row.date,
        label: row.date.slice(5),
        value,
        kind: value === null ? 'missing' as const : adjusted ? 'adjusted' as const : row.isZeroSaleInferred ? 'inferred' as const : 'observed' as const,
        tooltip: value !== null
          ? `${row.date} · ${adjusted ? `Nền đã chỉnh (${row.baseSource}): ` : row.isZeroSaleInferred ? 'Bán = 0 (Không lịch sử): ' : 'Bán xác nhận: '}${value.toLocaleString('vi-VN')}`
          : `${row.date} · ${row.hasRecord ? row.salesStatus : 'Không có bản ghi nguồn'} · không được coi là bán 0`,
      };
    });
    const observedCount = bars.filter(bar => bar.kind !== 'missing').length;
    const subtitle = observedCount
      ? '60 ngày lịch gần nhất · dữ liệu bán xác nhận'
      : '60 ngày lịch gần nhất · KHÔNG có ngày bán xác nhận nào trong cửa sổ này — kiểm tra phạm vi dữ liệu nguồn';
    return normalizeDemandBars(bars, subtitle, 'đơn vị/ngày');
  }

  // Chặng 14–19 mang finalForecast của Chặng 13 đi tiếp — vẫn hiển thị cấu trúc nền + dự báo cuối.
  const future = stage >= 13
    ? state.finalForecast.slice(0, 6)
    : stage >= 11
      ? (state.forecast?.baseForecast ?? []).slice(0, 6)
      : [];
  const historyLimit = stage === 9 ? 48 : stage === 10 ? 12 : 24;
  const history = state.cycles.slice(-historyLimit).map(cycle => ({
    key: `CK-${cycle.cycleIndex}`,
    label: `CK${cycle.cycleIndex}`,
    value: cycle.locked ? cycle.baseDemand : null,
    kind: !cycle.locked
      ? 'missing' as const
      : cycle.status === 'LOCKED_OBSERVED'
        ? 'observed' as const
        : 'adjusted' as const,
    tooltip: `CK ${cycle.cycleIndex} · ${cycle.dateStart} → ${cycle.dateEnd} · ${cycle.locked ? `Yⱼ=${cycle.baseDemand.toLocaleString('vi-VN')}` : cycle.status} · nguồn ${cycle.sourceRecordDays}/${cycle.days} ngày · chưa nền ${cycle.unresolvedDays}`,
  }));
  const forecast = future.map((value, index) => ({
    key: `F-${index + 1}`,
    label: `F+${index + 1}`,
    value,
    kind: 'forecast' as const,
    tooltip: `Dự báo ${index + 1}/${future.length}: ${value.toLocaleString('vi-VN')} đơn vị/chu kỳ${stage >= 13 ? ' · sau điều chỉnh CTKM tương lai' : ' · dự báo nền'}`,
  }));
  const forecastLabel = stage >= 13 ? 'dự báo cuối' : 'dự báo nền';
  const subtitle = future.length
    ? `${history.length} chu kỳ nền + ${future.length} kỳ ${forecastLabel}`
    : `${history.length} chu kỳ nền gần nhất · chu kỳ chưa khóa không bị coi là 0`;
  return normalizeDemandBars([...history, ...forecast], subtitle, 'đơn vị/chu kỳ');
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, KeyValuePipe, JourneyMapComponent, MathFormulaComponent, ComparisonReportComponent, SimulationReportComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly Math = Math;
  readonly stages = STAGES;
  readonly searchQuery = signal('');
  readonly leftMode = signal<'data' | 'catalog'>('data');
  readonly rightMode = signal<'catalog' | 'context'>('catalog');
  readonly auditDate = signal<string | null>(null);
  readonly auditRowsExpanded = signal(false);
  readonly journeyOpen = signal(false);
  readonly contextCollapsed = signal(false);
  readonly exceptionQueueOpen = signal(false);
  readonly currentView = signal<'simulation' | 'report' | 'simulation-report'>('simulation');

  setView(view: 'simulation' | 'report' | 'simulation-report'): void {
    this.currentView.set(view);
    if (view === 'report') {
      void this.store.generateReportData();
    }
  }
  readonly auditCollapsed = signal(false);
  readonly processCollapsed = signal(false);
  readonly processPanelWidth = signal<number | null>(650);
  readonly traceStepOverrides = signal<Record<number, boolean>>({});
  private processResize: { pointerId: number; startX: number; startWidth: number } | null = null;
  readonly phases = [
    { number: 1, label: 'Clean data', range: '01—05' },
    { number: 2, label: 'Phân loại', range: '06—08' },
    { number: 3, label: 'Dự báo & KM', range: '09—13' },
    { number: 4, label: 'Nguồn hàng', range: '14' },
    { number: 5, label: 'Dự trữ & số mua', range: '15—16' },
    { number: 6, label: 'Vốn & hậu kiểm', range: '17—19' },
  ];

  readonly visibleCatalog = computed(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase('vi');
    const filtered = query
      ? this.store.catalog.filter(sku => `${sku.id} ${sku.name} ${sku.category}`.toLocaleLowerCase('vi').includes(query))
      : [...this.store.catalog];

    const states = this.currentStageStates();
    if (!states) {
      return filtered.sort((a, b) => a.id.localeCompare(b.id));
    }

    const stage = this.store.activeStage();
    return filtered.sort((a, b) => {
      const aState = states[a.id] ?? null;
      const bState = states[b.id] ?? null;
      return compareSkus(a, b, aState, bState, stage);
    });
  });
  readonly summaryEntries = computed(() => Object.entries(this.store.view().summary));
  readonly selectedDefinition = computed(() => this.store.catalog.find(sku => sku.id === this.store.selectedSkuId())!);
  readonly currentStageStates = computed(() => this.store.currentSnapshot()?.states ?? null);
  readonly currentTableExport = computed(() => buildStageTableExport(this.store.currentSnapshot(), this.store.selectedSkuId(), this.store.policy()));
  readonly auditState = computed(() => this.store.view().state ?? this.store.inputState());
  readonly auditDailyRows = computed(() => this.auditState()?.daily ?? []);
  readonly renderedAuditDailyRows = computed(() => this.auditRowsExpanded() ? this.auditDailyRows() : this.auditDailyRows().slice(-AUDIT_ROW_LIMIT));
  readonly hiddenAuditRowCount = computed(() => this.auditDailyRows().length - this.renderedAuditDailyRows().length);
  readonly auditCycles = computed(() => this.auditState()?.cycles ?? []);
  readonly demandStructureChart = computed(() => {
    const state = this.store.view().state;
    return state ? buildDemandStructureChart(this.store.activeStage(), state) : null;
  });
  readonly selectedAuditRow = computed(() => this.auditDailyRows().find(row => row.date === this.auditDate()) ?? null);
  readonly currentAnomalyIndex = signal<{ type: string; index: number }>({ type: '', index: -1 });
  
  readonly anomalyText = computed(() => {
    const stockouts = this.stockouts();
    const promos = this.promos();
    const current = this.currentAnomalyIndex();
    
    let textParts = [];
    if (stockouts.length > 0) {
      if (current.type === 'stockout' && current.index >= 0) {
        textParts.push(`Đang xem: SO ${current.index + 1}/${stockouts.length}`);
      } else {
        textParts.push(`${stockouts.length} SO`);
      }
    }
    if (promos.length > 0) {
      if (current.type === 'promo' && current.index >= 0) {
        textParts.push(`Đang xem: KM ${current.index + 1}/${promos.length}`);
      } else {
        textParts.push(`${promos.length} KM`);
      }
    }
    return textParts.length ? textParts.join(' · ') : '0 điểm cần soi';
  });

  readonly stockouts = computed(() => this.auditDailyRows().filter(row => row.isStockout));
  readonly temporaryBases = computed(() => this.auditDailyRows().filter(row => ['unbalanced', 'fixed', 'insufficient'].includes(row.balanceStatus!)));
  readonly promos = computed(() => this.auditDailyRows().filter(row => !!row.promoCode));
  readonly unlockedCycles = computed(() => this.auditCycles().filter(c => !c.locked));
  readonly selectedStage5Cycle = computed(() => {
    const cycleIndex = this.highlightedCycleIndex();
    return (cycleIndex === null ? null : this.auditCycles().find(cycle => cycle.cycleIndex === cycleIndex))
      ?? this.unlockedCycles()[0]
      ?? null;
  });
  readonly selectedCycleProblemDays = computed(() => {
    const cycle = this.selectedStage5Cycle();
    if (!cycle) return [];
    return this.auditDailyRows().filter(row =>
      row.date >= cycle.dateStart && row.date <= cycle.dateEnd && row.baseDemand === null,
    );
  });

  readonly stageTrace = computed(() => {
    const view = this.store.view();
    if (!view.hasRun || !view.state) return null;
    return buildStageTrace(this.store.activeStage(), view.state, this.store.policy(), this.auditDate());
  });

  // ── Dữ liệu panel trái đối ứng từng chặng (Developer Spec §5) ──
  readonly abcBoard = computed(() => {
    const states = this.currentStageStates();
    return states ? buildAbcBoard(states) : [];
  });
  readonly xyzBoard = computed(() => {
    const states = this.currentStageStates();
    return states ? buildXyzBoard(states, this.store.policy()) : [];
  });
  readonly policyMatrix = computed(() => {
    const states = this.currentStageStates();
    return states ? buildPolicyMatrix(states, this.store.selectedSkuId(), this.store.policy()) : null;
  });
  readonly seasonalityAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildSeasonalityAudit(state) : null;
  });
  readonly trendAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildTrendAudit(state) : null;
  });
  readonly forecastAudit = computed(() => {
    const state = this.store.selectedState();
    return state && this.store.activeStage() >= 11 ? buildForecastAudit(state) : null;
  });

  // ── Hover giải thích cách tính từng ô của bảng học C11 ──
  readonly hoveredLearnCell = signal<{ index: number; column: LearningColumn } | null>(null);
  readonly learnCellExplanation = computed(() => {
    const hover = this.hoveredLearnCell();
    const learning = this.forecastAudit()?.learning;
    if (!hover || !learning) return null;
    return explainLearningCell(learning, hover.index, hover.column);
  });
  private readonly learnSourceSet = computed(() => new Set(
    this.learnCellExplanation()?.sources.map(source => `${source.index}:${source.column}`) ?? [],
  ));
  hoverLearnCell(index: number, column: LearningColumn): void {
    const current = this.hoveredLearnCell();
    if (current?.index !== index || current.column !== column) this.hoveredLearnCell.set({ index, column });
  }
  clearLearnHover(): void { this.hoveredLearnCell.set(null); }
  isLearnSource(index: number, column: LearningColumn): boolean { return this.learnSourceSet().has(`${index}:${column}`); }
  isLearnTarget(index: number, column: LearningColumn): boolean {
    const hover = this.hoveredLearnCell();
    return !!hover && hover.index === index && hover.column === column;
  }

  /** Tooltip sai số dùng position:fixed render ở gốc app — không bị panel overflow:hidden che. */
  readonly metricTip = signal<{ text: string; x: number; y: number } | null>(null);
  showMetricTip(event: Event, key: string): void {
    const text = this.metricTips[key];
    const host = event.currentTarget as HTMLElement | null;
    if (!text || !host) return;
    const rect = host.getBoundingClientRect();
    const width = 264;
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    this.metricTip.set({ text, x, y: rect.top - 8 });
  }
  hideMetricTip(): void { this.metricTip.set(null); }

  /** Ý nghĩa các chỉ tiêu sai số backtest C11 — hiện khi hover chân bảng. */
  readonly metricTips: Record<string, string> = {
    rmse: 'Root Mean Squared Error — căn bậc hai của trung bình bình phương sai số trên pha TEST. Đơn vị trùng đơn vị bán; phạt rất nặng những cú trượt lớn. RMSE càng nhỏ mô hình càng bám sát.',
    nrmse: 'RMSE chia cho sức mua thực trung bình của pha TEST — đưa về % để so sánh công bằng giữa SKU bán nhiều và SKU bán ít.',
    wape: 'Weighted Absolute Percentage Error = Σ|Y − F| / ΣY trên pha TEST — trung bình mỗi 100 đơn vị bán thực thì dự báo lệch bao nhiêu đơn vị. Đây là thước đo chính để so hai mô hình.',
    bias: 'Bias = (ΣF − ΣY) / ΣY trên pha TEST — đo độ lệch HỆ THỐNG. Dương: mô hình dự báo cao hơn thực (nguy cơ thừa hàng); âm: thấp hơn thực (nguy cơ thiếu hàng). Gần 0 là cân.',
    lock: 'REVIEW: tài liệu chưa ban hành ngưỡng P25 chính thức nên không mô hình nào được tự khóa — kết quả cần người duyệt. EXCEPTION: không đo được sai số (thiếu TEST).',
    future: 'Dự báo NỀN cho 6 chu kỳ tới, sinh từ trạng thái L/T/S cuối cùng (chưa áp hệ số CTKM — việc đó thuộc Chặng 13). Xu hướng khi dự phóng bị chặn ±15%.',
  };
  readonly promoAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildPromoAudit(state) : null;
  });
  readonly finalForecastAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildFinalForecastAudit(state) : null;
  });
  readonly supplyAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildSupplyAudit(state) : null;
  });
  readonly safetyAudit = computed(() => {
    const state = this.store.selectedState();
    return state ? buildSafetyAudit(state) : null;
  });

  // ── §6 LỆNH CODEX — hàng đợi ngoại lệ: banner tổng, panel theo SKU, jump-to ──
  readonly exceptionSeverity = exceptionSeverity;
  readonly exceptionFilter = signal<'all' | 'selected-sku' | 'active-stage' | 'blocking' | 'review'>('all');
  readonly expandedExceptionIds = signal<Set<string>>(new Set());
  readonly highlightedCycleIndex = signal<number | null>(null);

  readonly filteredExceptions = computed<ExceptionTask[]>(() => {
    const filter = this.exceptionFilter();
    if (filter === 'selected-sku') return this.store.selectedSkuExceptions();
    if (filter === 'active-stage') return this.store.activeStageExceptions();
    const all = this.store.allExceptions();
    if (filter === 'blocking') return all.filter(task => exceptionSeverity(task.code) === 'BLOCKING');
    if (filter === 'review') return all.filter(task => exceptionSeverity(task.code) === 'REVIEW');
    return all;
  });

  readonly exceptionBannerSummary = computed(() => {
    const all = this.store.allExceptions();
    const skuCount = new Set(all.map(task => task.skuId)).size;
    const cycleCount = new Set(all.flatMap(task => task.cycleIndexes?.map(index => `${task.skuId}:${index}`) ?? [])).size;
    return { total: all.length, skuCount, cycleCount };
  });

  toggleExceptionExpanded(id: string): void {
    this.expandedExceptionIds.update(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  isExceptionExpanded(id: string): boolean { return this.expandedExceptionIds().has(id); }

  jumpToExceptionSku(task: ExceptionTask): void { this.selectSkuId(task.skuId); }
  jumpToExceptionStage(task: ExceptionTask): void { void this.store.jumpToException(task); }
  jumpToExceptionCycle(task: ExceptionTask): void {
    const cycleIndex = task.cycleIndexes?.[0] ?? null;
    void this.store.jumpToException(task).then(() => {
      this.highlightedCycleIndex.set(cycleIndex);
      if (task.affectedDateFrom) this.auditDate.set(task.affectedDateFrom);
      setTimeout(() => document.getElementById(`cycle-${cycleIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    });
  }
  async copyResolutionDirection(task: ExceptionTask): Promise<void> {
    const lines = [
      `SKU ${task.skuId} · Chặng ${task.stage} · ${task.code}${task.cycleIndexes?.length ? ` · CK${task.cycleIndexes.join(',')}` : ''}`,
      `Bằng chứng: ${task.evidence}`,
      ...(task.resolutionOptions ?? []).map(option => `- [${option.type}] ${option.title}: ${option.description}`),
      'MÔ PHỎNG CHỈ ĐỀ XUẤT — CHƯA THỰC HIỆN.',
    ];
    try { await navigator.clipboard.writeText(lines.join('\n')); } catch { /* clipboard không khả dụng — bỏ qua yên lặng, không chặn UI */ }
  }

  constructor(readonly store: SimulationStore) {}

  ngOnInit() {
    void this.store.selectDataSource('real', 19);
  }

  get runDate(): string { return this.store.policy().runDate; }
  set runDate(value: string) { void this.store.updatePolicy({ runDate: value }); }
  get historyYears(): number { return this.store.policy().historyYears; }
  set historyYears(value: number) { void this.store.updatePolicy({ historyYears: Number(value) }); }
  get cycleLength(): number { return this.store.policy().cycleLength; }
  set cycleLength(value: number) { void this.store.updatePolicy({ cycleLength: Number(value) }); }
  get cutoffHour(): string { return this.store.policy().cutoffHour; }
  set cutoffHour(value: string) { void this.store.updatePolicy({ cutoffHour: value }); }
  get periodBudget(): number { return this.store.policy().periodBudget; }
  set periodBudget(value: number) { void this.store.updatePolicy({ periodBudget: Math.max(0, Number(value)) }); }

  selectStage(stage: number): void {
    this.auditRowsExpanded.set(false);
    this.traceStepOverrides.set({});
    void this.store.selectStage(stage as StageNumber);
  }
  selectDataSource(source: DataSourceId): void {
    const target = Math.max(1, this.store.activeStage(), this.store.completedStage()) as StageNumber;
    this.auditDate.set(null);
    this.auditRowsExpanded.set(false);
    this.traceStepOverrides.set({});
    void this.store.selectDataSource(source, target);
  }
  resetSession(): void { this.store.reset(); this.selectStage(1); }
  startProcessResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const currentWidth = this.processPanelWidth() ?? handle.parentElement!.getBoundingClientRect().width;
    this.processResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: currentWidth };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  resizeProcessPanel(event: PointerEvent): void {
    if (!this.processResize || this.processResize.pointerId !== event.pointerId) return;
    this.processPanelWidth.set(Math.max(300, Math.min(1180, this.processResize.startWidth + (this.processResize.startX - event.clientX))));
  }
  endProcessResize(event: PointerEvent): void {
    if (this.processResize?.pointerId === event.pointerId) this.processResize = null;
  }
  resizeProcessPanelByKeyboard(event: KeyboardEvent): void {
    const increments: Record<string, number> = { ArrowLeft: 24, ArrowRight: -24 };
    if (event.key === 'Home') this.processPanelWidth.set(300);
    else if (event.key === 'End') this.processPanelWidth.set(1180);
    else if (event.key in increments) {
      const currentWidth = this.processPanelWidth() ?? 650;
      this.processPanelWidth.set(Math.max(300, Math.min(1180, currentWidth + increments[event.key])));
    }
    else return;
    event.preventDefault();
  }
  toggleMergedContext(event: Event): void {
    this.contextCollapsed.set(!(event.target as HTMLDetailsElement).open);
  }
  selectSku(sku: SkuDefinition): void { this.store.selectSku(sku.id); this.auditDate.set(null); this.auditRowsExpanded.set(false); this.traceStepOverrides.set({}); this.highlightedCycleIndex.set(null); }
  selectSkuId(skuId: string): void { this.store.selectSku(skuId); this.auditDate.set(null); this.auditRowsExpanded.set(false); this.traceStepOverrides.set({}); this.highlightedCycleIndex.set(null); }
  downloadCurrentStageTable(): void {
    const exportData = this.currentTableExport();
    if (!exportData || !exportData.rows.length) return;
    const blob = new Blob([`\ufeff${encodeStageTableCsv(exportData)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportData.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  isTraceStepOpen(index: number, total: number, tone: string | undefined): boolean {
    const overrides = this.traceStepOverrides();
    return Object.prototype.hasOwnProperty.call(overrides, index)
      ? overrides[index]
      : index === 0 || index === total - 1 || tone === 'warn';
  }
  onTraceStepToggle(index: number, event: Event): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if (this.traceStepOverrides()[index] === open) return;
    this.traceStepOverrides.update(current => ({ ...current, [index]: open }));
  }
  setAllTraceSteps(open: boolean, total: number): void {
    this.traceStepOverrides.set(Object.fromEntries(Array.from({ length: total }, (_, index) => [index, open])));
  }
  stateFor(skuId: string): Readonly<SkuPipelineState> | null { return this.currentStageStates()?.[skuId] ?? null; }
  stageStatus(stage: StageNumber): 'locked' | 'active' | 'available' {
    if (stage <= this.store.completedStage()) return stage === this.store.activeStage() ? 'active' : 'locked';
    return stage === this.store.activeStage() ? 'active' : 'available';
  }
  format(value: number | null | undefined, digits = 0): string {
    if (value === null || value === undefined) return '—';
    return viNumberFormat(digits).format(value);
  }
  formatCurrency(value: number): string { return `${viNumberFormat(0).format(value)} ₫`; }
  formatSeries(values: readonly number[]): string { return values.map(value => this.format(value, 1)).join(' · '); }
  selectAuditRow(row: DailyRecord): void {
    if (!this.auditRowsExpanded() && !this.renderedAuditDailyRows().includes(row)) this.auditRowsExpanded.set(true);
    this.auditDate.set(row.date);
    setTimeout(() => document.getElementById(`audit-${row.date}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  selectCycle(cycle: CycleRecord): void {
    this.highlightedCycleIndex.set(cycle.cycleIndex);
    this.auditDate.set(cycle.dateStart);
    setTimeout(() => document.getElementById(`cycle-${cycle.cycleIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  isSelectedCycle(cycle: CycleRecord): boolean { return this.selectedStage5Cycle()?.cycleIndex === cycle.cycleIndex; }

  cycleStatusLabel(cycle: CycleRecord): string {
    switch (cycle.status) {
      case 'NO_SOURCE_RECORD': return 'KHÔNG CÓ NGUỒN';
      case 'BASELINE_UNRESOLVED': return 'CHƯA CÓ NỀN';
      case 'PARTIAL_BASELINE': return `THIẾU NỀN ${cycle.unresolvedDays}/${cycle.days}`;
      case 'LOCKED_OBSERVED': return 'KHÓA · QUAN SÁT';
      case 'LOCKED_ADJUSTED': return 'KHÓA · ĐÃ ĐIỀU CHỈNH';
      case 'LOCKED_FALLBACK': return 'KHÓA · NGUỒN DỰ PHÒNG';
      case 'OUTSIDE_ACTIVE_PERIOD': return 'NGOÀI KỲ HOẠT ĐỘNG';
      case 'DATA_ERROR': return 'LỖI DỮ LIỆU';
    }
  }

  cycleStatusExplanation(cycle: CycleRecord): string {
    if (cycle.status === 'NO_SOURCE_RECORD') {
      return `0/${cycle.days} ngày có bản ghi POS nguồn. Đây là thiếu nguồn; chưa thể kết luận SKU không bán, cửa hàng đóng hay nhu cầu bằng 0.`;
    }
    if (cycle.status === 'BASELINE_UNRESOLVED') {
      return `${cycle.sourceRecordDays}/${cycle.days} ngày có bản ghi nguồn nhưng 0/${cycle.days} ngày xác định được Bₜ. Có nguồn không đồng nghĩa đã đủ ngày sạch đối chứng để tạo nền.`;
    }
    if (cycle.status === 'PARTIAL_BASELINE') {
      return `${cycle.days - cycle.unresolvedDays}/${cycle.days} ngày đã có Bₜ; còn ${cycle.unresolvedDays} ngày thiếu căn cứ nên Yⱼ chưa được khóa.`;
    }
    return `Đủ ${cycle.days}/${cycle.days} ngày có Bₜ; Yⱼ=${this.format(cycle.baseDemand, 1)} được phép đi tiếp.`;
  }

  cycleDayIssue(row: DailyRecord): string {
    const auditReason = row.selectionReason ? ` ${row.selectionReason}` : '';
    if (!row.hasRecord) return `Không có bản ghi POS nguồn; sales là chưa biết, không phải 0.${auditReason}`;
    if (row.promoCode) return `Ngày CTKM chưa tìm đủ ngày sạch đối chứng để chuẩn hóa.${auditReason}`;
    if (row.isStockout) return `Ngày stockout chưa tìm đủ ngày sạch đối chứng để nâng nền.${auditReason}`;
    if (row.baseSource === 'insufficient') return `Có bản ghi nguồn nhưng chưa đủ căn cứ tạo Bₜ.${auditReason}`;
    return row.selectionReason || 'Chưa tìm được sức mua nền Bₜ cho ngày này.';
  }

  jumpToAnomaly(type: 'stockout' | 'promo'): void {
    const rows = this.auditDailyRows().filter(item => type === 'stockout' ? item.isStockout : !!item.promoCode);
    if (!rows.length) return;
    
    let current = this.currentAnomalyIndex();
    let nextIdx = (current.type === type) ? current.index + 1 : 0;
    if (nextIdx >= rows.length) nextIdx = 0;
    
    this.currentAnomalyIndex.set({ type, index: nextIdx });
    this.selectAuditRow(rows[nextIdx]);
  }

  clearAuditSelection(): void {
    this.auditDate.set(null);
    this.currentAnomalyIndex.set({ type: '', index: -1 });
  }

  focusTracePoint(date: string): void {
    if (this.auditDate() === date) {
      this.auditDate.set(null);
      return;
    }
    const row = this.auditDailyRows().find(item => item.date === date);
    if (row) this.selectAuditRow(row);
    else this.auditDate.set(date);
  }

  private readonly beforeReferenceSet = computed(() => new Set(this.selectedAuditRow()?.beforeReferenceDates));
  private readonly afterReferenceSet = computed(() => new Set(this.selectedAuditRow()?.afterReferenceDates));
  isReferenceBefore(row: DailyRecord): boolean { return this.beforeReferenceSet().has(row.date); }
  isReferenceAfter(row: DailyRecord): boolean { return this.afterReferenceSet().has(row.date); }

  statusLabel(row: DailyRecord): string {
    if (row.baseSource === 'technical-fill') return 'LẤP NỀN C5';
    if (row.baseSource === 'promo-defer') return 'CHỜ C4';
    if (row.balanceStatus === 'balanced') return 'CÂN BẰNG';
    if (row.balanceStatus === 'temporary') return 'TẠM · KIỂM TRA';
    if (row.balanceStatus === 'fixed') return 'KHÔNG CÂN BẰNG CỐ ĐỊNH';
    if (row.balanceStatus === 'insufficient' || row.baseSource === 'insufficient') return 'THIẾU CĂN CỨ';
    if (row.baseSource === 'clean') return 'DỮ LIỆU GỐC';
    return 'CHƯA XỬ LÝ';
  }

  statusClass(row: DailyRecord): string {
    if (row.baseSource === 'technical-fill') return 'fixed';
    return row.balanceStatus ?? (row.baseSource === 'promo-defer' ? 'promo' : row.baseSource === 'clean' ? 'clean' : 'pending');
  }

  // promoCode thật có thể là nhiều mã CTKM chồng ngày ghép bằng "|" (ví dụ
  // "38216|38231|...|48729" khi 10 chương trình cùng hiệu lực một ngày) — hiện
  // hết cả chuỗi trong ô nhỏ của bảng audit làm mất khả năng đọc; chỉ hiện mã
  // đầu + số mã còn lại, để đầy đủ trong title (hover) cho ai cần đối chiếu.
  promoChipLabel(promoCode: string): string {
    const codes = promoCode.split('|');
    return codes.length > 1 ? `${codes[0]} +${codes.length - 1}` : codes[0];
  }

  getSkuSortValueLabel(sku: SkuDefinition): string {
    const state = this.stateFor(sku.id);
    const stage = this.store.activeStage();
    if (!state) return '';
    switch (stage) {
      case 1: {
        const count = state.daily.filter(day => day.hasRecord).length;
        return `${count} ngày ghi nhận bán`;
      }
      case 2: {
        const count = state.daily?.filter(d => d.isStockout).length ?? 0;
        return `${count} SO`;
      }
      case 3: {
        const count = state.daily?.filter(d => d.baseSource === 'stockout-lifted').length ?? 0;
        return `${count} nâng nền`;
      }
      case 4: {
        const count = state.daily?.filter(d => d.baseSource === 'promo-normalized').length ?? 0;
        return `${count} chuẩn hóa`;
      }
      case 5: {
        const locked = state.cycles?.filter(c => c.locked).length ?? 0;
        const total = state.cycles?.length ?? 0;
        return `${locked}/${total} CK`;
      }
      case 6: {
        const val = state.classification?.annualValue ?? 0;
        return this.formatCurrency(val);
      }
      case 7: {
        const adi = state.classification?.adi;
        const cv2 = state.classification?.cv2;
        return `ADI: ${this.format(adi, 2)} · CV²: ${this.format(cv2, 2)}`;
      }
      case 8: {
        const sl = state.serviceLevel;
        return sl !== null ? `SL: ${sl}%` : 'Chính sách riêng';
      }
      case 9: {
        const mapping: Record<string, string> = {
          'confirmed': 'Mùa vụ',
          'no-clear-season': 'Không rõ',
          'insufficient-structure': 'Thiếu chu kỳ',
          'not-applicable': 'Không áp dụng'
        };
        return mapping[state.seasonality] ?? state.seasonality;
      }
      case 10: {
        const g1 = state.trendRates?.[0];
        const g2 = state.trendRates?.[1];
        if (g1 === null || g1 === undefined || g2 === null || g2 === undefined) return 'Không có xu hướng';
        return `g₁: ${g1 > 0 ? '+' : ''}${this.format(g1 * 100, 1)}% · g₂: ${g2 > 0 ? '+' : ''}${this.format(g2 * 100, 1)}%`;
      }
      case 11: {
        const wape = state.forecast?.wape;
        return wape != null ? `WAPE: ${this.format(wape * 100, 1)}%` : 'Không có WAPE';
      }
      case 12: {
        const k = state.promoFactor;
        return k != null ? `K: ${this.format(k, 2)}` : 'K: —';
      }
      case 13: {
        const sum = (state.finalForecast ?? []).reduce((a, b) => a + b, 0);
        return `F: ${this.format(sum, 1)}`;
      }
      case 14: {
        const free = state.freeStock;
        return `Free: ${this.format(free)}`;
      }
      case 15: {
        const ss = state.safetyStock;
        return `SS: ${this.format(ss)}`;
      }
      case 16: {
        const qty = state.orderPlan?.orderQuantity;
        return `Đặt: ${this.format(qty)}`;
      }
      case 17: {
        const cut = state.budgetAllocation?.cutQuantity ?? 0;
        if (cut > 0) return `Cắt: ${this.format(cut)}`;
        const funded = state.budgetAllocation?.fundedQuantity ?? 0;
        return `Cấp: ${this.format(funded)}`;
      }
      case 18: {
        const count = state.releaseDecision?.reasons?.length ?? 0;
        return `${count} ngoại lệ`;
      }
      case 19: {
        const wape = state.postAudit?.forecastWape;
        if (wape != null) return `Audit WAPE: ${this.format(wape * 100, 1)}%`;
        const so = state.postAudit?.stockoutUnits;
        return so != null ? `Thiếu: ${this.format(so)}` : '';
      }
      default:
        return '';
    }
  }

}

function compareSkus(
  a: SkuDefinition,
  b: SkuDefinition,
  aState: Readonly<SkuPipelineState> | null,
  bState: Readonly<SkuPipelineState> | null,
  stage: StageNumber
): number {
  if (!aState && !bState) return a.id.localeCompare(b.id);
  if (!aState) return 1;
  if (!bState) return -1;

  let valA = 0;
  let valB = 0;

  switch (stage) {
    case 1:
      valA = aState.daily.filter(day => day.hasRecord).length;
      valB = bState.daily.filter(day => day.hasRecord).length;
      break;
    case 2:
      valA = aState.daily?.filter(d => d.isStockout).length ?? 0;
      valB = bState.daily?.filter(d => d.isStockout).length ?? 0;
      break;
    case 3:
      valA = aState.daily?.filter(d => d.baseSource === 'stockout-lifted').length ?? 0;
      valB = bState.daily?.filter(d => d.baseSource === 'stockout-lifted').length ?? 0;
      break;
    case 4:
      valA = aState.daily?.filter(d => d.baseSource === 'promo-normalized').length ?? 0;
      valB = bState.daily?.filter(d => d.baseSource === 'promo-normalized').length ?? 0;
      break;
    case 5:
      valA = aState.cycles?.filter(c => c.locked).length ?? 0;
      valB = bState.cycles?.filter(c => c.locked).length ?? 0;
      break;
    case 6:
      valA = aState.classification?.annualValue ?? 0;
      valB = bState.classification?.annualValue ?? 0;
      break;
    case 7: {
      const order: Record<string, number> = { X: 4, Y: 3, Z: 2, D: 1, BLOCKED: 0 };
      valA = order[aState.classification?.xyz ?? 'BLOCKED'] ?? 0;
      valB = order[bState.classification?.xyz ?? 'BLOCKED'] ?? 0;
      break;
    }
    case 8:
      valA = aState.serviceLevel ?? 0;
      valB = bState.serviceLevel ?? 0;
      break;
    case 9: {
      const order: Record<string, number> = { 'confirmed': 4, 'no-clear-season': 3, 'insufficient-structure': 2, 'not-applicable': 1 };
      valA = order[aState.seasonality] ?? 0;
      valB = order[bState.seasonality] ?? 0;
      break;
    }
    case 10: {
      const g1A = aState.trendRates?.[0] ?? 0;
      const g2A = aState.trendRates?.[1] ?? 0;
      const g1B = bState.trendRates?.[0] ?? 0;
      const g2B = bState.trendRates?.[1] ?? 0;
      valA = (Math.abs(g1A) + Math.abs(g2A)) / 2;
      valB = (Math.abs(g1B) + Math.abs(g2B)) / 2;
      break;
    }
    case 11:
      valA = aState.forecast?.wape ?? 0;
      valB = bState.forecast?.wape ?? 0;
      break;
    case 12:
      valA = aState.promoFactor ?? 1;
      valB = bState.promoFactor ?? 1;
      break;
    case 13:
      valA = (aState.finalForecast ?? []).reduce((sum, v) => sum + v, 0);
      valB = (bState.finalForecast ?? []).reduce((sum, v) => sum + v, 0);
      break;
    case 14:
      valA = aState.freeStock ?? 0;
      valB = bState.freeStock ?? 0;
      break;
    case 15:
      valA = aState.safetyStock ?? 0;
      valB = bState.safetyStock ?? 0;
      break;
    case 16:
      valA = aState.orderPlan?.orderQuantity ?? 0;
      valB = bState.orderPlan?.orderQuantity ?? 0;
      break;
    case 17: {
      const cutA = aState.budgetAllocation?.cutQuantity ?? 0;
      const cutB = bState.budgetAllocation?.cutQuantity ?? 0;
      if (cutA !== cutB) {
        return cutB - cutA;
      }
      valA = aState.budgetAllocation?.orderValue ?? 0;
      valB = bState.budgetAllocation?.orderValue ?? 0;
      break;
    }
    case 18:
      valA = aState.releaseDecision?.reasons?.length ?? 0;
      valB = bState.releaseDecision?.reasons?.length ?? 0;
      break;
    case 19: {
      const wapeA = aState.postAudit?.forecastWape ?? 0;
      const wapeB = bState.postAudit?.forecastWape ?? 0;
      if (wapeA !== wapeB) {
        return wapeB - wapeA;
      }
      valA = aState.postAudit?.stockoutUnits ?? 0;
      valB = bState.postAudit?.stockoutUnits ?? 0;
      break;
    }
  }

  if (valA !== valB) {
    return valB - valA;
  }

  return a.id.localeCompare(b.id);
}
