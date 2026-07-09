import { KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { STAGES } from './domain/policy';
import { DailyRecord, SkuDefinition, SkuPipelineState, StageNumber } from './domain/models';
import { buildStageTrace } from './domain/stage-trace';
import {
  buildAbcBoard, buildForecastAudit, buildFinalForecastAudit, buildPolicyMatrix, buildPromoAudit,
  buildSafetyAudit, buildSeasonalityAudit, buildSupplyAudit, buildTrendAudit, buildXyzBoard,
} from './domain/stage-insights';
import { explainLearningCell, LearningColumn } from './domain/forecast-models';
import { SimulationStore, viNumberFormat } from './state/simulation.store';
import { JourneyMapComponent } from './ui/journey-map.component';
import { MathFormulaComponent } from './ui/math-formula.component';
import { ExecutiveDashboardComponent } from './ui/executive-dashboard.component';

type MonitorTone = 'critical' | 'warn' | 'watch' | 'good';
type MonitorView = 'overview' | 'reviews' | 'stages' | 'outcomes';

interface MonitorDecision {
  readonly id: string;
  readonly sku: SkuDefinition;
  readonly state: Readonly<SkuPipelineState>;
  readonly tone: MonitorTone;
  readonly title: string;
  readonly evidence: string;
  readonly impact: string;
  readonly owner: string;
  readonly stage: number;
  readonly score: number;
}

interface StageControl {
  readonly number: number;
  readonly title: string;
  readonly question: string;
  readonly owner: string;
  readonly processed: number;
  readonly reviews: number;
  readonly exceptions: number;
  readonly result: string;
  readonly status: 'pending' | 'locked' | 'review' | 'critical';
}

const STAGE_MONITOR_META: readonly { question: string; owner: string }[] = [
  { question: 'Khung lịch sử và chu kỳ có đủ điều kiện chạy?', owner: 'Data Steward' },
  { question: 'Ngày nào mất bán do stockout?', owner: 'Data Steward' },
  { question: 'Nền ngày thường có đủ căn cứ?', owner: 'Data Steward' },
  { question: 'CTKM đã được trả về sức mua tự nhiên?', owner: 'Data Steward' },
  { question: 'Chu kỳ nào đủ dữ liệu để khóa?', owner: 'Demand Planner' },
  { question: 'ABC có phản ánh đúng giá trị tiêu thụ?', owner: 'Category Finance' },
  { question: 'SKU là X, Y, Z hay chưa đủ căn cứ D?', owner: 'Demand Planner' },
  { question: 'Mức phục vụ và ưu tiên vốn có được duyệt?', owner: 'Planning Governance' },
  { question: 'Nhóm Y có mùa vụ đủ bằng chứng?', owner: 'Demand Planner' },
  { question: 'Xu hướng có thật và nằm trong giới hạn?', owner: 'Demand Planner' },
  { question: 'Mô hình thắng có đủ điều kiện khóa?', owner: 'Demand Lead' },
  { question: 'Hệ số CTKM có đủ mẫu và độ tin cậy?', owner: 'Category / Marketing' },
  { question: 'Kế hoạch CTKM tương lai đã được xác nhận?', owner: 'Category / Marketing' },
  { question: 'Tồn, inbound, cam kết và ETA có tin cậy?', owner: 'Supply Planner' },
  { question: 'Safety stock có đúng rủi ro và service level?', owner: 'Inventory Planner' },
  { question: 'Số mua và phần dư MOQ có chấp nhận được?', owner: 'Procurement Planner' },
  { question: 'Vốn có bảo vệ đúng SKU ưu tiên?', owner: 'Finance Controller' },
  { question: 'Dòng nào phát hành, chờ duyệt hoặc bị chặn?', owner: 'Approval Board' },
  { question: 'Sai lệch đến từ lớp nguyên nhân nào?', owner: 'Planning Governance' },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, KeyValuePipe, JourneyMapComponent, MathFormulaComponent, ExecutiveDashboardComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly Math = Math;
  readonly stages = STAGES;
  readonly appMode = signal<'monitor' | 'simulation' | 'report'>('monitor');
  readonly monitorView = signal<MonitorView>('overview');
  readonly monitorQuery = signal('');
  readonly monitorFilter = signal<'all' | MonitorTone>('all');
  readonly monitorStageFilter = signal<'all' | number>('all');
  readonly monitorStageScope = signal<readonly number[] | null>(null);
  readonly searchQuery = signal('');
  readonly leftMode = signal<'data' | 'catalog'>('data');
  readonly rightMode = signal<'catalog' | 'context'>('catalog');
  readonly auditDate = signal<string | null>(null);
  readonly journeyOpen = signal(false);
  readonly contextCollapsed = signal(false);
  readonly auditCollapsed = signal(false);
  readonly processCollapsed = signal(false);
  readonly processPanelWidth = signal(760);
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

  readonly monitorSnapshot = computed(() => {
    const completed = this.store.completedStage();
    return completed ? this.store.snapshots()[completed as StageNumber] ?? null : null;
  });

  readonly monitorDecisions = computed<MonitorDecision[]>(() => {
    const snapshot = this.monitorSnapshot();
    if (!snapshot) return [];
    return this.buildMonitorDecisions().sort((a, b) => b.score - a.score || a.stage - b.stage || a.sku.id.localeCompare(b.sku.id));
  });

  readonly monitorRows = computed(() => {
    const query = this.monitorQuery().trim().toLocaleLowerCase('vi');
    const filter = this.monitorFilter();
    const stageFilter = this.monitorStageFilter();
    const stageScope = this.monitorStageScope();
    return this.monitorDecisions().filter(row => {
      const matchesFilter = filter === 'all' || row.tone === filter;
      const matchesStage = stageFilter === 'all' || row.stage === stageFilter;
      const matchesScope = !stageScope || stageScope.includes(row.stage);
      const haystack = `${row.sku.id} ${row.sku.name} ${row.sku.category} ${row.title} ${row.evidence} ${row.owner}`.toLocaleLowerCase('vi');
      return matchesFilter && matchesStage && matchesScope && (!query || haystack.includes(query));
    });
  });

  readonly monitorStats = computed(() => {
    const snapshot = this.monitorSnapshot();
    const states = snapshot ? Object.values(snapshot.states) : [];
    const decisions = this.monitorDecisions();
    const completed = this.store.completedStage();
    const issued = states.filter(state => state.releaseDecision?.status === 'issued').length;
    const affectedSkus = new Set(decisions.map(item => item.sku.id)).size;
    const critical = decisions.filter(row => row.tone === 'critical').length;
    const fundedValue = states.reduce((sum, state) => sum + (state.budgetAllocation?.fundedValue ?? 0), 0);
    const proposedValue = states.reduce((sum, state) => sum + (state.budgetAllocation?.orderValue ?? 0), 0);
    const atRiskValue = states
      .filter(state => state.releaseDecision && state.releaseDecision.status !== 'issued')
      .reduce((sum, state) => sum + (state.budgetAllocation?.fundedValue ?? state.budgetAllocation?.orderValue ?? 0), 0);
    const forecastLocked = states.filter(state => state.forecast?.lockStatus === 'locked').length;
    const policyLocked = states.filter(state => state.serviceLevel !== null).length;
    const zCount = states.filter(state => state.classification.xyz === 'Z').length;
    const dCount = states.filter(state => state.classification.xyz === 'D').length;
    const wape = typeof snapshot?.summary['WAPE danh mục'] === 'number' ? snapshot.summary['WAPE danh mục'] as number : null;
    return {
      total: states.length, issued, decisions: decisions.length, affectedSkus, critical, fundedValue,
      proposedValue, atRiskValue, forecastLocked, policyLocked, zCount, dCount, wape, completed,
    };
  });

  readonly monitorStageControls = computed<StageControl[]>(() => this.stages.map(stage => {
    const snapshot = this.store.snapshots()[stage.number];
    const decisions = this.monitorDecisions().filter(item => item.stage === stage.number);
    const exceptions = decisions.filter(item => item.tone === 'critical').length;
    const reviews = decisions.length - exceptions;
    const result = snapshot
      ? Object.entries(snapshot.summary).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === 'number' ? this.format(value, value < 1 && value > 0 ? 2 : 0) : value}`).join(' · ')
      : 'Chưa có snapshot';
    return {
      number: stage.number,
      title: stage.shortTitle,
      question: STAGE_MONITOR_META[stage.number - 1].question,
      owner: STAGE_MONITOR_META[stage.number - 1].owner,
      processed: snapshot ? Object.keys(snapshot.states).length : 0,
      reviews,
      exceptions,
      result,
      status: !snapshot ? 'pending' : exceptions ? 'critical' : reviews ? 'review' : 'locked',
    };
  }));

  readonly monitorDomains = computed(() => [
    { id: 'data', label: 'Dữ liệu nền', range: 'C01–C05', stages: [1, 2, 3, 4, 5], owner: 'Data Steward' },
    { id: 'policy', label: 'Phân nhóm & chính sách', range: 'C06–C10', stages: [6, 7, 8, 9, 10], owner: 'Demand Lead' },
    { id: 'forecast', label: 'Dự báo & CTKM', range: 'C11–C13', stages: [11, 12, 13], owner: 'Demand / Category' },
    { id: 'supply', label: 'Nguồn hàng & tồn', range: 'C14–C16', stages: [14, 15, 16], owner: 'Supply Planner' },
    { id: 'release', label: 'Vốn & phát hành', range: 'C17–C18', stages: [17, 18], owner: 'Finance / Approval' },
    { id: 'learning', label: 'Hậu kiểm', range: 'C19', stages: [19], owner: 'Governance' },
  ].map(domain => {
    const controls = this.monitorStageControls().filter(stage => domain.stages.includes(stage.number));
    const decisions = this.monitorDecisions().filter(item => domain.stages.includes(item.stage));
    return {
      ...domain,
      completed: controls.filter(control => control.status !== 'pending').length,
      total: controls.length,
      decisions: decisions.length,
      critical: decisions.filter(item => item.tone === 'critical').length,
    };
  }));

  readonly monitorOutcomes = computed(() => {
    const snapshot = this.monitorSnapshot();
    if (!snapshot) return [];
    return Object.values(snapshot.states)
      .filter(state => !!state.postAudit)
      .sort((a, b) => (b.postAudit?.stockoutUnits ?? 0) - (a.postAudit?.stockoutUnits ?? 0)
        || (b.postAudit?.forecastWape ?? -1) - (a.postAudit?.forecastWape ?? -1));
  });

  readonly monitorCauses = computed(() => {
    const counts = new Map<string, number>();
    for (const state of this.monitorOutcomes()) {
      const cause = state.postAudit?.primaryCause ?? 'Chưa xác định';
      counts.set(cause, (counts.get(cause) ?? 0) + 1);
    }
    return [...counts.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count);
  });

  readonly visibleCatalog = computed(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase('vi');
    if (!query) return this.store.catalog;
    return this.store.catalog.filter(sku => `${sku.id} ${sku.name} ${sku.category}`.toLocaleLowerCase('vi').includes(query));
  });
  readonly summaryEntries = computed(() => Object.entries(this.store.view().summary));
  readonly selectedDefinition = computed(() => this.store.catalog.find(sku => sku.id === this.store.selectedSkuId())!);
  readonly currentStageStates = computed(() => this.store.currentSnapshot()?.states ?? null);
  readonly auditState = computed(() => this.store.view().state ?? this.store.inputState());
  readonly auditDailyRows = computed(() => this.auditState()?.daily ?? []);
  readonly auditCycles = computed(() => this.auditState()?.cycles ?? []);
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
    return states ? buildXyzBoard(states) : [];
  });
  readonly policyMatrix = computed(() => {
    const states = this.currentStageStates();
    return states ? buildPolicyMatrix(states, this.store.selectedSkuId()) : null;
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

  constructor(readonly store: SimulationStore) {}

  ngOnInit() {
    this.resetSession();
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
    this.traceStepOverrides.set({});
    void this.store.selectStage(stage as StageNumber);
  }
  openMonitorSku(row: MonitorDecision): void {
    this.store.selectSku(row.sku.id);
    this.appMode.set('simulation');
    this.selectStage(row.stage);
  }
  openMonitorOutcome(state: Readonly<SkuPipelineState>): void {
    this.store.selectSku(state.definition.id);
    this.appMode.set('simulation');
    this.selectStage(19);
  }
  openMonitorStage(stage: number): void {
    this.appMode.set('simulation');
    this.selectStage(stage);
  }
  showMonitorReviews(stage: number | 'all' = 'all'): void {
    this.monitorStageScope.set(null);
    this.monitorStageFilter.set(stage);
    this.monitorView.set('reviews');
  }
  showMonitorDomain(stages: readonly number[]): void {
    this.monitorStageFilter.set('all');
    this.monitorStageScope.set(stages);
    this.monitorView.set('reviews');
  }
  selectMonitorStageFilter(stage: number | 'all'): void {
    this.monitorStageScope.set(null);
    this.monitorStageFilter.set(stage);
  }
  clearMonitorFilters(): void {
    this.monitorQuery.set('');
    this.monitorFilter.set('all');
    this.monitorStageFilter.set('all');
    this.monitorStageScope.set(null);
  }
  runMonitorPipeline(): void { this.store.runAll(); }
  resetSession(): void { this.store.reset(); this.selectStage(1); }
  startProcessResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    this.processResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: this.processPanelWidth() };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  resizeProcessPanel(event: PointerEvent): void {
    if (!this.processResize || this.processResize.pointerId !== event.pointerId) return;
    this.processPanelWidth.set(Math.max(580, Math.min(1180, this.processResize.startWidth + event.clientX - this.processResize.startX)));
  }
  endProcessResize(event: PointerEvent): void {
    if (this.processResize?.pointerId === event.pointerId) this.processResize = null;
  }
  resizeProcessPanelByKeyboard(event: KeyboardEvent): void {
    const increments: Record<string, number> = { ArrowLeft: -24, ArrowRight: 24 };
    if (event.key === 'Home') this.processPanelWidth.set(580);
    else if (event.key === 'End') this.processPanelWidth.set(1180);
    else if (event.key in increments) this.processPanelWidth.update(width => Math.max(580, Math.min(1180, width + increments[event.key])));
    else return;
    event.preventDefault();
  }
  selectSku(sku: SkuDefinition): void { this.store.selectSku(sku.id); this.auditDate.set(null); this.traceStepOverrides.set({}); }
  selectSkuId(skuId: string): void { this.store.selectSku(skuId); this.auditDate.set(null); this.traceStepOverrides.set({}); }
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
  monitorToneLabel(tone: MonitorTone): string {
    return { critical: 'Khẩn cấp', warn: 'Cần duyệt', watch: 'Theo dõi', good: 'Ổn định' }[tone];
  }
  monitorStatusLabel(status: StageControl['status']): string {
    return { pending: 'Chưa chạy', locked: 'Đã khóa', review: 'Cần xem', critical: 'Có chặn' }[status];
  }
  monitorSyncLabel(): string {
    const snapshot = this.monitorSnapshot();
    if (!snapshot) return 'Chưa có snapshot vận hành';
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(snapshot.completedAt));
  }

  private buildMonitorDecisions(): MonitorDecision[] {
    const snapshots = this.store.snapshots();
    const latest = this.monitorSnapshot();
    if (!latest) return [];
    const decisions: MonitorDecision[] = [];
    const add = (
      sku: SkuDefinition,
      state: Readonly<SkuPipelineState>,
      stage: number,
      tone: MonitorTone,
      key: string,
      title: string,
      evidence: string,
      impact: string,
      owner: string,
      score: number,
    ) => decisions.push({ id: `${stage}-${sku.id}-${key}`, sku, state, stage, tone, title, evidence, impact, owner, score });

    for (const sku of this.store.catalog) {
      const state = latest.states[sku.id];
      if (!state) continue;
      const at = (stage: StageNumber) => snapshots[stage]?.states[sku.id];

      const stage3 = at(3);
      if (stage3) {
        const insufficient = stage3.daily.filter(row => row.balanceStatus === 'insufficient').length;
        const temporary = stage3.daily.filter(row => row.balanceStatus === 'temporary').length;
        if (insufficient) add(sku, state, 3, 'critical', 'base-insufficient', 'Nền ngày chưa đủ căn cứ', `${insufficient} ngày stockout không đủ ngày sạch tham chiếu.`, 'Rủi ro đánh giá thấp nhu cầu thật', 'Data Steward', 96);
        if (temporary) add(sku, state, 3, 'watch', 'base-temporary', 'Nền tạm cần kiểm tra', `${temporary} ngày chỉ có tham chiếu một phía trong vùng tìm kiếm.`, 'Độ tin cậy chu kỳ bị giảm', 'Data Steward', 62);
      }

      const stage4 = at(4);
      if (stage4) {
        const blockedPromoDays = stage4.daily.filter(row => !!row.promoCode && row.baseDemand === null).length;
        if (blockedPromoDays) add(sku, state, 4, 'critical', 'promo-base-blocked', 'CTKM chưa có nền tự nhiên', `${blockedPromoDays} ngày CTKM chưa đủ căn cứ chuẩn hóa.`, 'Không được học hệ số CTKM tự động', 'Data Steward', 94);
      }

      const stage5 = at(5);
      if (stage5) {
        const unlocked = stage5.cycles.filter(cycle => !cycle.locked).length;
        if (unlocked) add(sku, state, 5, 'critical', 'cycle-unlocked', 'Chu kỳ chưa được khóa', `${unlocked}/${stage5.cycles.length} chu kỳ trống hoặc chưa đủ nền.`, 'Không được đưa vào phân nhóm và học mô hình', 'Demand Planner', 93);
      }

      const stage6 = at(6);
      if (stage6?.classification.abc === 'N/A') {
        add(sku, state, 6, 'critical', 'abc-na', 'Không đủ căn cứ xếp ABC', `${stage6.classification.lockedCycles} chu kỳ khóa; yêu cầu tối thiểu 6.`, 'Chuyển chính sách SKU mới / mã tương tự', 'Category Finance', 91);
      } else if (stage6 && stage6.classification.lockedCycles < 24) {
        add(sku, state, 6, 'watch', 'abc-annualized', 'Xác nhận ABC năm hóa', `${stage6.classification.lockedCycles}/24 chu kỳ; kết quả ${stage6.classification.abc} dùng hệ số năm hóa ${this.format(stage6.classification.annualizationFactor, 2)}.`, 'Có thể đổi ưu tiên tài chính khi đủ năm', 'Category Finance', 58);
      }

      const stage7 = at(7);
      if (stage7?.classification.xyz === 'D') {
        add(sku, state, 7, 'critical', 'xyz-d', 'Nhóm D — chưa đủ căn cứ tự học', `${stage7.classification.n} chu kỳ, ${stage7.classification.m} chu kỳ có nhu cầu.`, 'Cần kế hoạch Thu mua hoặc SKU tương tự được duyệt', 'Demand Lead', 92);
      } else if (stage7?.classification.xyz === 'Z') {
        add(sku, state, 7, 'warn', 'xyz-z', 'Nhóm Z — xác nhận chiến lược bán thưa', `ADI ${this.format(stage7.classification.adi, 2)} · ${stage7.classification.m}/${stage7.classification.n} chu kỳ có nhu cầu.`, 'Không được đặt đều máy móc; mở nhánh Croston/nhịp', 'Demand Lead', 78);
      }

      const stage8 = at(8);
      if (stage8 && stage8.serviceLevel === null) {
        add(sku, state, 8, 'critical', 'policy-outside-matrix', 'Chính sách ngoài ma trận chưa khóa', 'Nhóm D/N-A không đi vào ma trận ABC × XYZ.', 'Thiếu service level và ưu tiên vốn chính thức', 'Planning Governance', 90);
      }

      const stage9 = at(9);
      if (stage9?.classification.xyz === 'Y' && stage9.seasonality === 'insufficient-structure') {
        add(sku, state, 9, 'watch', 'season-insufficient', 'Mùa vụ chưa đủ cấu trúc', 'Nhóm Y có dưới 2 vòng mùa vụ khóa để kiểm chứng.', 'Không được mở Holt-Winters tự động', 'Demand Planner', 60);
      }

      const stage10 = at(10);
      if (stage10) {
        const maxTrend = Math.max(...stage10.trendRates.map(rate => Math.abs(rate ?? 0)));
        if (maxTrend > .25) add(sku, state, 10, 'warn', 'trend-review', 'Xu hướng vượt ngưỡng xem xét', `Biến động đoạn lớn nhất ${this.format(maxTrend * 100, 1)}%; dự phóng bị giới hạn 15%.`, 'Cần xác nhận tín hiệu kinh doanh trước khi học mô hình', 'Demand Lead', 76);
        else if (maxTrend > .15) add(sku, state, 10, 'watch', 'trend-capped', 'Xu hướng đã bị giới hạn an toàn', `Biến động đoạn lớn nhất ${this.format(maxTrend * 100, 1)}%; hệ thống giới hạn 15%.`, 'Theo dõi sai lệch sau phát hành', 'Demand Planner', 56);
      }

      const stage11 = at(11);
      if (stage11?.forecast && stage11.forecast.lockStatus !== 'locked') {
        const tone: MonitorTone = stage11.forecast.lockStatus === 'exception' ? 'critical' : 'warn';
        add(sku, state, 11, tone, `forecast-${stage11.forecast.lockStatus}`, `Dự báo ${stage11.forecast.lockStatus.toUpperCase()} · ${stage11.forecast.model}`, `${stage11.forecast.reason} WAPE ${stage11.forecast.wape === null ? '—' : this.format(stage11.forecast.wape * 100, 1) + '%'} · Bias ${stage11.forecast.bias === null ? '—' : this.format(stage11.forecast.bias * 100, 1) + '%'}.`, 'Không được coi là forecast đã khóa để tự động phát hành', 'Demand Lead', tone === 'critical' ? 98 : 84);
      }

      const stage12 = at(12);
      if (stage12 && ['low', 'suggest-only', 'blocked'].includes(stage12.promoConfidence)) {
        const blocked = stage12.promoConfidence === 'blocked';
        add(sku, state, 12, blocked ? 'critical' : 'warn', 'promo-confidence', blocked ? 'Hệ số CTKM bị chặn' : 'Hệ số CTKM cần duyệt', `K=${this.format(stage12.promoFactor, 2)} · trạng thái ${stage12.promoConfidence}.`, 'Không tự áp vào dự báo cuối nếu chưa duyệt', 'Category / Marketing', blocked ? 90 : 74);
      }

      const stage13 = at(13);
      if (stage13 && sku.futurePromotions.some(promo => promo.confirmed) && stage13.promoConfidence !== 'auto') {
        add(sku, state, 13, 'warn', 'future-promo', 'Kế hoạch CTKM chưa có hệ số tự khóa', `${sku.futurePromotions.filter(promo => promo.confirmed).length} kế hoạch đã xác nhận; confidence ${stage13.promoConfidence}.`, 'Dự báo cuối đang giữ nền hoặc cần hệ số thủ công duyệt', 'Category / Marketing', 73);
      }

      const stage14 = at(14);
      if (stage14 && (stage14.freeStock ?? 0) < 0) {
        add(sku, state, 14, 'critical', 'negative-free-stock', 'Vị thế tồn khả dụng âm', `Hàng tự do tại mốc cuối ${this.format(stage14.freeStock)} đơn vị.`, 'Rủi ro thiếu hàng trong vùng lead time', 'Supply Planner', 95);
      }

      const stage15 = at(15);
      if (stage15?.safetyStock === null) {
        add(sku, state, 15, 'critical', 'ss-missing', 'Không khóa được tồn an toàn', stage15.safetyStockAudit?.warnings.join(' ') || 'Thiếu service level hoặc dữ liệu rủi ro bắt buộc.', 'Số mua không có mức bảo vệ được kiểm chứng', 'Inventory Planner', 94);
      } else if (stage15?.safetyStockAudit?.warnings.length) {
        add(sku, state, 15, 'warn', 'ss-warning', 'Tồn an toàn có cảnh báo ràng buộc', stage15.safetyStockAudit.warnings.join(' '), `SS ${this.format(stage15.safetyStock)} đơn vị cần được đánh giá`, 'Inventory Planner', 77);
      }

      const stage16 = at(16);
      if (stage16?.orderPlan?.warnings.length) {
        add(sku, state, 16, 'critical', 'order-input', 'Số mua thiếu điều kiện đầu vào', stage16.orderPlan.warnings.join(' '), 'Không được chuyển thẳng sang phát hành', 'Procurement Planner', 92);
      } else if ((stage16?.orderPlan?.moqSurplus ?? 0) > 0) {
        add(sku, state, 16, 'watch', 'moq-surplus', 'Theo dõi phần dư MOQ', `Qraw ${this.format(stage16!.orderPlan!.rawQuantity)} → Qorder ${this.format(stage16!.orderPlan!.orderQuantity)}; dư ${this.format(stage16!.orderPlan!.moqSurplus)}.`, `Giá trị dư ${this.formatCurrency(stage16!.orderPlan!.moqSurplus * sku.purchasePrice)}`, 'Procurement Planner', 54);
      }

      const stage17 = at(17);
      if ((stage17?.budgetAllocation?.cutQuantity ?? 0) > 0) {
        add(sku, state, 17, 'critical', 'budget-cut', 'Số mua bị cắt/hoãn vốn', `Đề xuất ${this.format(stage17!.orderPlan?.orderQuantity)}; cấp ${this.format(stage17!.budgetAllocation!.fundedQuantity)}; cắt ${this.format(stage17!.budgetAllocation!.cutQuantity)}.`, `Giá trị chưa cấp ${this.formatCurrency(stage17!.budgetAllocation!.cutQuantity * sku.purchasePrice)}`, 'Finance Controller', 97);
      }

      const stage18 = at(18);
      if (stage18?.releaseDecision?.status === 'awaiting-info') {
        add(sku, state, 18, 'critical', 'release-info', 'Chờ bổ sung hồ sơ mua', stage18.releaseDecision.reasons.join(' ') || 'Thiếu NCC, giá, MOQ, ETA hoặc trạng thái mua.', `Đang giữ ${this.format(stage18.budgetAllocation?.fundedQuantity)} đơn vị chưa phát hành`, 'Procurement Lead', 100);
      } else if (stage18?.releaseDecision?.status === 'awaiting-approval') {
        add(sku, state, 18, 'warn', 'release-approval', 'Chờ duyệt ngoại lệ phát hành', stage18.releaseDecision.reasons.join(' ') || 'Có ngoại lệ cần người có thẩm quyền quyết định.', `Giá trị chờ duyệt ${this.formatCurrency(stage18.budgetAllocation?.fundedValue ?? 0)}`, 'Approval Board', 99);
      } else if (stage18?.releaseDecision?.status === 'not-issued' && (stage18.orderPlan?.orderQuantity ?? 0) > 0) {
        add(sku, state, 18, 'critical', 'release-blocked', 'Không phát hành dù có nhu cầu mua', stage18.budgetAllocation?.reason ?? 'Số được cấp vốn bằng 0 hoặc dòng bị chặn.', `Giá trị đề xuất ${this.formatCurrency(stage18.budgetAllocation?.orderValue ?? 0)}`, 'Approval Board', 99);
      }

      const stage19 = at(19);
      if ((stage19?.postAudit?.stockoutUnits ?? 0) > 0) {
        add(sku, state, 19, 'critical', 'outcome-stockout', 'Hậu kiểm phát sinh thiếu hàng', `${this.format(stage19!.postAudit!.stockoutUnits)} đơn vị thiếu; nguyên nhân chính: ${stage19!.postAudit!.primaryCause}.`, 'Cần điều chỉnh đúng lớp nguyên nhân ở phiên sau', 'Planning Governance', 96);
      }
      if (stage19?.postAudit?.proposalStatus === 'future-version') {
        add(sku, state, 19, 'watch', 'future-proposal', 'Đề xuất thay đổi phiên sau', stage19.postAudit.proposal, 'Không hồi tố snapshot hoặc đơn đã phát hành', 'Planning Governance', 68);
      }
    }
    return decisions;
  }

  selectAuditRow(row: DailyRecord): void {
    this.auditDate.set(row.date);
    setTimeout(() => document.getElementById(`audit-${row.date}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
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

}
