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
import { SimulationStore, viNumberFormat } from './state/simulation.store';
import { JourneyMapComponent } from './ui/journey-map.component';
import { MathFormulaComponent } from './ui/math-formula.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, KeyValuePipe, JourneyMapComponent, MathFormulaComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  readonly Math = Math;
  readonly stages = STAGES;
  readonly searchQuery = signal('');
  readonly leftMode = signal<'data' | 'catalog'>('data');
  readonly auditDate = signal<string | null>(null);
  readonly journeyOpen = signal(false);
  readonly contextCollapsed = signal(false);
  readonly auditCollapsed = signal(false);
  readonly processCollapsed = signal(false);
  readonly processPanelWidth = signal(760);
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

  readonly lineage = computed(() => this.buildLineage());

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

  selectStage(stage: number): void { void this.store.selectStage(stage as StageNumber); }
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
  selectSku(sku: SkuDefinition): void { this.store.selectSku(sku.id); this.auditDate.set(null); }
  selectSkuId(skuId: string): void { this.store.selectSku(skuId); this.auditDate.set(null); }
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

  private buildLineage(): { stage: number; label: string; value: string; detail: string }[] {
    const maxStage = Math.min(this.store.activeStage(), this.store.completedStage());
    const skuId = this.store.selectedSkuId();
    const date = this.auditDate();
    const items: { stage: number; label: string; value: string; detail: string }[] = [];
    for (let stage = 1; stage <= maxStage; stage++) {
      const state = this.store.snapshots()[stage as StageNumber]?.states[skuId];
      if (!state) continue;
      const row = date ? state.daily.find(item => item.date === date) : null;
      if (stage <= 4 && row) items.push({ stage, label: STAGES[stage - 1].shortTitle, value: stage === 1 ? `Bán ${this.format(row.sales)}` : stage === 2 ? (row.isStockout ? 'STOCKOUT' : 'Ngày sạch') : `Nền ${this.format(row.baseDemand, 1)}`, detail: stage >= 3 ? this.statusLabel(row) : row.stockoutReason ?? 'Bản ghi gốc' });
      if (stage === 5) items.push({ stage, label: 'Khóa chu kỳ', value: `${state.cycles.filter(cycle => cycle.locked).length} CK khóa`, detail: `${state.cycles.filter(cycle => !cycle.locked).length} CK không dùng` });
      if (stage === 6) items.push({ stage, label: 'ABC', value: state.classification.abc, detail: `Lũy kế ${this.format(state.classification.cumulativeShare * 100, 1)}%` });
      if (stage === 7) items.push({ stage, label: 'XYZ/D', value: state.classification.xyz, detail: `ADI ${this.format(state.classification.adi, 2)} · CV² ${this.format(state.classification.cv2, 3)}` });
      if (stage === 8) items.push({ stage, label: 'Chính sách', value: state.serviceLevel ? `${state.serviceLevel}%` : 'Duyệt riêng', detail: state.capitalPriority });
      if (stage === 9) items.push({ stage, label: 'Mùa vụ', value: state.seasonality, detail: 'Đầu ra khóa C9' });
      if (stage === 10) items.push({ stage, label: 'Xu hướng', value: state.trend, detail: `g₁ ${this.format((state.trendRates[0] ?? 0) * 100, 1)}% · g₂ ${this.format((state.trendRates[1] ?? 0) * 100, 1)}%` });
      if (stage === 11) items.push({ stage, label: 'Mô hình', value: state.forecast?.model ?? 'Ngoại lệ', detail: state.forecast?.lockStatus ?? 'Chưa khóa' });
      if (stage === 12) items.push({ stage, label: 'Hệ số KM', value: this.format(state.promoFactor, 2), detail: state.promoConfidence });
      if (stage === 13) items.push({ stage, label: 'Dự báo cuối', value: `${state.finalForecast.length} CK`, detail: state.finalForecast.map(value => this.format(value, 0)).join(' · ') });
      if (stage === 14) items.push({ stage, label: 'Hàng tự do', value: this.format(state.freeStock), detail: 'Tại mốc bảo vệ' });
      if (stage === 15) items.push({ stage, label: 'Tồn an toàn', value: this.format(state.safetyStock), detail: state.safetyStockAudit?.formula === 'full' ? 'Công thức đầy đủ' : 'Chính sách/thiếu dữ liệu' });
      if (stage === 16) items.push({ stage, label: 'Số đặt/MOQ', value: this.format(state.orderPlan?.orderQuantity), detail: `Dư MOQ ${this.format(state.orderPlan?.moqSurplus, 1)}` });
      if (stage === 17) items.push({ stage, label: 'Được cấp vốn', value: this.format(state.budgetAllocation?.fundedQuantity), detail: state.budgetAllocation?.reason ?? '—' });
      if (stage === 18) items.push({ stage, label: 'Phát hành', value: state.releaseDecision?.status ?? '—', detail: `SL ${this.format(state.releaseDecision?.releasedQuantity)}` });
      if (stage === 19) items.push({ stage, label: 'Hậu kiểm', value: state.postAudit?.forecastWape === null ? '—' : `${this.format((state.postAudit?.forecastWape ?? 0) * 100, 1)}% WAPE`, detail: state.postAudit?.primaryCause ?? '—' });
    }
    return items;
  }
}
