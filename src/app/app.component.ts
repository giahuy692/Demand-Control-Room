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
import { MathFormulaComponent } from './features/demand-control-room/ui/components/math-formula.component';
import { buildStageTableExport, encodeStageTableCsv } from './features/demand-control-room/domain/stage-table-export';

const AUDIT_ROW_LIMIT = 300;

type DemandChartBarKind = 'observed' | 'adjusted' | 'missing' | 'forecast' | 'inferred' | 'promo' | 'stockout';

interface DemandChartBar {
  key: string;
  label: string;
  value: number | null;
  height: number;
  kind: DemandChartBarKind;
  tooltip: string;
  /** Giá trị trước xử lý (vd: sales gốc trước khi Chặng 3-5 nâng nền/chuẩn hóa/lấp) — null khi trùng giá trị đã xử lý hoặc chặng không có khái niệm "trước/sau". */
  rawValue: number | null;
  rawHeight: number | null;
  rawTooltip: string | null;
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
  bars: Omit<DemandChartBar, 'height' | 'rawHeight'>[],
  subtitle: string,
  unit: string,
): DemandStructureChart {
  const max = Math.max(1, ...bars.map(bar => bar.value ?? 0), ...bars.map(bar => bar.rawValue ?? 0));
  const normalized = bars.map(bar => ({
    ...bar,
    height: bar.value === null ? 9 : bar.value === 0 ? 3 : Math.max(5, (bar.value / max) * 100),
    rawHeight: bar.rawValue === null ? null : bar.rawValue === 0 ? 0 : (bar.rawValue / max) * 100,
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

/** Cộng sales gốc (bucket-b, suy ra từ state.daily đã sắp xếp theo ngày) trong [startIso, endIso] — null nếu không ngày nào có bản ghi bán. */
function sumRawSalesInRange(daily: readonly DailyRecord[], startIso: string, endIso: string): number | null {
  let sum = 0;
  let any = false;
  for (const row of daily) {
    if (row.date < startIso) continue;
    if (row.date > endIso) break;
    if (row.sales !== null) { sum += row.sales; any = true; }
  }
  return any ? sum : null;
}

export function buildDemandStructureChart(stage: StageNumber, state: Readonly<SkuPipelineState>): DemandStructureChart | null {
  // Chặng 1–2 hiển thị sales quan sát; Chặng 3–4 phải hiển thị baseDemand do chặng tạo ra.
  // Không fallback về sales ở Chặng 3–4 vì sẽ che khuất ngày chưa xử lý được.
  if (stage <= 5) {
    const bars = state.daily.slice(-60).map(row => {
      const rawSales = row.sales;
      // Chặng 1-2 chưa từng tính baseDemand (Bₜ) — không đọc trước dữ liệu của chặng chưa chạy.
      const processed = stage <= 2 ? null : row.baseDemand;
      // Ngày stockout/CTKM phải LUÔN lên đúng màu trạng thái của nó (đỏ/vàng) ngay cả khi
      // chặng tương ứng CHƯA xử lý xong (processed=null, vd CTKM ở Chặng 3 hay stockout ở
      // Chặng 2) — hiện tạm bằng sales gốc thay vì rơi về "missing", để luôn thấy được NGÀY
      // NÀO cần xử lý; một khi Bₜ khác sales gốc mới là cặp "trước/sau" đáng vẽ vạch so sánh.
      const displayValue = processed ?? rawSales;
      const wasAdjusted = processed !== null && rawSales !== null && processed !== rawSales;
      const isStockout = row.stockoutStatus !== 'NONE' && row.promotionClass !== 'DEEP_PROMO';
      const isPromo = row.promotionClass === 'DEEP_PROMO';
      const kind: DemandChartBarKind = displayValue === null
        ? 'missing'
        : isPromo ? 'promo'
        : isStockout ? 'stockout'
        : wasAdjusted ? 'adjusted'
        : row.salesObservationStatus === 'CONFIRMED_ZERO' ? 'inferred'
        : 'observed';
      return {
        key: row.date,
        label: row.date.slice(5),
        value: displayValue,
        kind,
        tooltip: displayValue !== null
          ? `${row.date} · ${isPromo ? `CTKM (${row.promotionName?.trim() || 'chưa có tên'}): ` : isStockout ? 'STOCKOUT: ' : wasAdjusted ? `Nền đã chỉnh (${row.baseDemandSource}): ` : row.salesObservationStatus === 'CONFIRMED_ZERO' ? 'Bán xác nhận bằng 0: ' : 'Bán ghi nhận: '}${displayValue.toLocaleString('vi-VN')}${wasAdjusted ? ` (gốc trước xử lý: ${rawSales!.toLocaleString('vi-VN')})` : ''}`
          : `${row.date} · ${row.salesObservationStatus} · không được coi là bán 0`,
        rawValue: wasAdjusted ? rawSales : null,
        rawTooltip: wasAdjusted ? `${row.date} · Bán gốc trước xử lý: ${rawSales!.toLocaleString('vi-VN')}` : null,
      };
    });
    const observedCount = bars.filter(bar => bar.kind !== 'missing').length;
    const stageSubtitle = stage === 1
      ? 'sales quan sát và độ phủ nguồn'
      : stage === 2
        ? 'sales quan sát và trạng thái stockout'
        : stage === 3
          ? 'nhu cầu nền sau xử lý stockout'
          : stage === 4
            ? 'nhu cầu nền sau xử lý CTKM'
            : 'nhu cầu nền sau lấp các ngày còn thiếu';
    const subtitle = observedCount
      ? `60 ngày lịch gần nhất · ${stageSubtitle}`
      : `60 ngày lịch gần nhất · KHÔNG có ${stage <= 2 ? 'ngày bán xác nhận' : 'nhu cầu nền đã xử lý'} trong cửa sổ này`;
    return normalizeDemandBars(bars, subtitle, 'đơn vị/ngày');
  }

  // Chặng 15–20 mang finalForecast của Chặng 14 đi tiếp — vẫn hiển thị cấu trúc nền + dự báo cuối.
  const future = stage >= 14
    ? state.finalForecast.slice(0, 6)
    : stage >= 12
      ? (state.forecast?.baseForecast ?? []).slice(0, 6)
      : [];
  const historyLimit = stage === 10 ? 48 : stage === 11 ? 12 : 24;
  const history = state.cycles.slice(-historyLimit).map(cycle => {
    const value = cycle.locked ? cycle.baseDemand : null;
    // Chu kỳ không có trường "sức mua gốc" riêng — cộng lại sales gốc từng ngày trong khoảng
    // chu kỳ để có Σ trước xử lý, nối tiếp đúng khái niệm "trước/sau" từ view theo ngày.
    const rawSum = sumRawSalesInRange(state.daily, cycle.dateStart, cycle.dateEnd);
    const showsRawMark = cycle.locked && rawSum !== null && rawSum !== value;
    return {
      key: `CK-${cycle.cycleIndex}`,
      label: `CK${cycle.cycleIndex}`,
      value,
      kind: !cycle.locked
        ? 'missing' as const
        : cycle.status === 'LOCKED_OBSERVED'
          ? 'observed' as const
          : 'adjusted' as const,
      tooltip: `CK ${cycle.cycleIndex} · ${cycle.dateStart} → ${cycle.dateEnd} · ${cycle.locked ? `Yⱼ=${cycle.baseDemand.toLocaleString('vi-VN')}` : cycle.status} · nguồn ${cycle.sourceRecordDays}/${cycle.days} ngày · chưa nền ${cycle.unresolvedDays}${showsRawMark ? ` (Σ bán gốc trước xử lý: ${rawSum!.toLocaleString('vi-VN')})` : ''}`,
      rawValue: showsRawMark ? rawSum : null,
      rawTooltip: showsRawMark ? `CK ${cycle.cycleIndex} · Σ bán gốc trước xử lý: ${rawSum!.toLocaleString('vi-VN')}` : null,
    };
  });
  const forecast = future.map((value, index) => ({
    key: `F-${index + 1}`,
    label: `F+${index + 1}`,
    value,
    kind: 'forecast' as const,
    tooltip: `Dự báo ${index + 1}/${future.length}: ${value.toLocaleString('vi-VN')} đơn vị/chu kỳ${stage >= 14 ? ' · sau điều chỉnh CTKM tương lai' : ' · dự báo nền'}`,
    rawValue: null, rawTooltip: null,
  }));
  const forecastLabel = stage >= 14 ? 'dự báo cuối' : 'dự báo nền';
  const subtitle = future.length
    ? `${history.length} chu kỳ nền + ${future.length} kỳ ${forecastLabel}`
    : `${history.length} chu kỳ nền gần nhất · chu kỳ chưa khóa không bị coi là 0`;
  return normalizeDemandBars([...history, ...forecast], subtitle, 'đơn vị/chu kỳ');
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, KeyValuePipe, MathFormulaComponent],
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
  readonly contextCollapsed = signal(false);
  readonly exceptionQueueOpen = signal(false);

  readonly auditCollapsed = signal(false);
  readonly processCollapsed = signal(true);
  readonly headerCollapsed = signal(false);
  readonly processPanelWidth = signal<number | null>(650);
  readonly traceStepOverrides = signal<Record<number, boolean>>({});
  private processResize: { pointerId: number; startX: number; startWidth: number } | null = null;
  readonly phases = [
    { number: 1, label: 'Làm sạch', range: '01—06' },
    { number: 2, label: 'Phân loại', range: '07—09' },
    { number: 3, label: 'Dự báo & KM', range: '10—14' },
    { number: 4, label: 'Nguồn hàng', range: '15' },
    { number: 5, label: 'Dự trữ & số mua', range: '16—17' },
    { number: 6, label: 'Vốn & hậu kiểm', range: '18—20' },
  ];

  /**
   * Sort key + nhãn hiển thị của từng SKU được tính MỘT lần cho mỗi (snapshot, chặng) —
   * trước đây comparator và template filter lại mảng daily (~1800 ngày/SKU) trong từng lần
   * so sánh/render, khiến mọi chu kỳ change detection (kể cả hover) quét lại hàng trăm nghìn phần tử.
   */
  private readonly skuSortMeta = computed(() => {
    const meta = new Map<string, { key: readonly [number, number]; label: string }>();
    const states = this.currentStageStates();
    if (!states) return meta;
    const stage = this.store.activeStage();
    for (const [id, state] of Object.entries(states)) meta.set(id, buildSkuSortMeta(state, stage));
    return meta;
  });

  readonly visibleCatalog = computed(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase('vi');
    const filtered = query
      ? this.store.catalog.filter(sku => `${sku.id} ${sku.name} ${sku.category}`.toLocaleLowerCase('vi').includes(query))
      : [...this.store.catalog];

    const meta = this.skuSortMeta();
    if (!meta.size) {
      return filtered.sort((a, b) => a.id.localeCompare(b.id));
    }

    return filtered.sort((a, b) => {
      const metaA = meta.get(a.id) ?? null;
      const metaB = meta.get(b.id) ?? null;
      if (!metaA && !metaB) return a.id.localeCompare(b.id);
      if (!metaA) return 1;
      if (!metaB) return -1;
      return metaB.key[0] - metaA.key[0] || metaB.key[1] - metaA.key[1] || a.id.localeCompare(b.id);
    });
  });
  readonly summaryEntries = computed(() => Object.entries(this.store.view().summary));
  // Không "!" ép kiểu: catalog/selectedSkuId khởi tạo rỗng trước khi dataset async nạp xong —
  // tick đầu tiên find() thật sự trả undefined, template phải đọc qua "?." để không vỡ console.
  readonly selectedDefinition = computed(() => this.store.catalog.find(sku => sku.id === this.store.selectedSkuId()));
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

  /**
   * Mỗi chặng 2-5 chỉ soi đúng một loại bất thường: Chặng 2/3 xử lý stockout, Chặng 4 xử lý
   * CTKM, Chặng 5 xử lý ngày còn thiếu nền chung (lấp kỹ thuật/chưa đủ căn cứ — stage5FillDays).
   * Chặng 1 (khung lịch) không có trọng tâm riêng nên KHÔNG highlight loại nào — tránh gây hiểu
   * nhầm là chặng đang xử lý bất thường không liên quan.
   */
  readonly stageAnomalyFocus = computed<'stockout' | 'promo' | 'gap' | null>(() => {
    const stage = this.store.activeStage();
    if (stage === 2 || stage === 3) return 'stockout';
    if (stage === 4) return 'promo';
    if (stage === 5) return 'gap';
    return null;
  });

  readonly anomalyText = computed(() => {
    const focus = this.stageAnomalyFocus();
    const stockouts = this.stockouts();
    const promos = this.promos();
    const gaps = this.stage5FillDays();
    const current = this.currentAnomalyIndex();

    let textParts = [];
    if (focus === 'stockout' && stockouts.length > 0) {
      if (current.type === 'stockout' && current.index >= 0) {
        textParts.push(`Đang xem: SO ${current.index + 1}/${stockouts.length}`);
      } else {
        textParts.push(`${stockouts.length} SO`);
      }
    }
    if (focus === 'promo' && promos.length > 0) {
      if (current.type === 'promo' && current.index >= 0) {
        textParts.push(`Đang xem: KM ${current.index + 1}/${promos.length}`);
      } else {
        textParts.push(`${promos.length} KM`);
      }
    }
    if (focus === 'gap' && gaps.length > 0) {
      if (current.type === 'gap' && current.index >= 0) {
        textParts.push(`Đang xem: Thiếu nền ${current.index + 1}/${gaps.length}`);
      } else {
        textParts.push(`${gaps.length} thiếu nền`);
      }
    }
    return textParts.length ? textParts.join(' · ') : '0 điểm cần soi';
  });

  readonly stockouts = computed(() => this.auditDailyRows().filter(row => row.stockoutStatus !== 'NONE' && row.promotionClass !== 'DEEP_PROMO'));
  readonly temporaryBases = computed(() => this.auditDailyRows().filter(row => ['unbalanced', 'fixed', 'insufficient'].includes(row.balanceStatus!)));
  readonly promos = computed(() => this.auditDailyRows().filter(row => row.promotionClass === 'DEEP_PROMO'));
  readonly unlockedCycles = computed(() => this.auditCycles().filter(c => !c.locked));
  /** Chặng 5 — ngày được lấp kỹ thuật hoặc vẫn chưa đủ căn cứ sau khi lấp. */
  readonly stage5FillDays = computed(() => this.auditDailyRows().filter(row => row.technicalFillStatus === 'FILLED' || row.technicalFillStatus === 'UNRESOLVED'));
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
    return state && this.store.activeStage() >= 12 ? buildForecastAudit(state) : null;
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

  /**
   * Tooltip sai số dùng position:fixed render ở gốc app — không bị panel overflow:hidden che.
   * Trước đây signal này được set khi hover nhưng KHÔNG có phần tử nào trong template đọc lại
   * `metricTip()` — tooltip không bao giờ thật sự hiện. Nay render kèm cả công thức LaTeX
   * (cùng nguồn với formula-registry.ts) khi metric đó có công thức xác định.
   */
  readonly metricTip = signal<{ text: string; formula: string | null; x: number; y: number } | null>(null);
  showMetricTip(event: Event, key: string): void {
    const text = this.metricTips[key];
    const host = event.currentTarget as HTMLElement | null;
    if (!text || !host) return;
    const rect = host.getBoundingClientRect();
    const width = 264;
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    this.metricTip.set({ text, formula: this.metricFormulas[key] ?? null, x, y: rect.top - 8 });
  }
  hideMetricTip(): void { this.metricTip.set(null); }

  /**
   * Ý nghĩa các chỉ tiêu sai số backtest C11 §11.3-11.7 — hiện khi hover chân bảng. Mỗi chỉ tiêu
   * đo trên tập TEST của ĐÚNG SKU đang xem (không phải so sánh chéo SKU ngay tại UI này — nRMSE
   * trước đây mô tả nhầm thành "so sánh SKU bán nhiều/bán ít" trong khi đây là view một SKU).
   * Tài liệu §11.5 cấm dùng MỘT ngưỡng chung cho mọi SKU (ngưỡng phải backtest + duyệt theo từng
   * nhóm ABC/XYZ) nên không có số cố định "tốt/xấu" để in cứng — thay vào đó mỗi dòng có hành
   * động cụ thể người vận hành nên làm, lấy từ bảng quyết định C11 §12.
   */
  readonly metricTips: Record<string, string> = {
    rmse: 'RMSE — căn bậc hai trung bình bình phương lệch Yₜ−Fₜ trên tập TEST của SKU này; cùng đơn vị bán, phạt rất nặng những chu kỳ lệch đột biến. Hành động: nếu RMSE cao bất thường so với WAPE%, mở từng chu kỳ TEST xem có 1-2 cú lệch đơn lẻ làm méo số hay sai đều khắp.',
    nrmse: 'nRMSE = RMSE chia cho sức mua trung bình của CHÍNH SKU này trong tập TEST — quy về % để dễ đọc hơn số tuyệt đối. Không phải phép so sánh với SKU khác ngay tại đây; % này chỉ có ý nghĩa so sánh khi đặt cạnh SKU có quy mô bán khác. Hành động: không kết luận một mình — luôn đọc cùng WAPE và Bias.',
    wape: 'WAPE = Σ|Y − F| / ΣY trên TEST của SKU này — trung bình mỗi 100 đơn vị bán thực thì dự báo lệch bao nhiêu đơn vị. Là chỉ tiêu chính để chốt cách dự báo, nhưng ngưỡng đạt/không đạt do nhóm ABC/XYZ của SKU quyết định (backtest + phê duyệt riêng), không phải một số cố định cho mọi SKU. Hành động: WAPE thấp vẫn phải đối chiếu Bias trước khi chốt.',
    bias: 'Bias = (ΣF − ΣY) / ΣY trên TEST — đo LỆCH MỘT CHIỀU có hệ thống, khác RMSE/WAPE (đo độ lớn sai số nói chung). Dương kéo dài: dự báo cao hơn thực nhiều kỳ liên tiếp → dễ chốt vốn vào tồn kho chậm quay vòng. Âm kéo dài: dự báo thấp hơn thực → dễ thiếu hàng trước khi lô nhập về. Hành động: dù RMSE/WAPE đạt, Bias lệch một chiều vẫn phải chuyển xem xét thủ công, không tự chốt.',
    lock: 'REVIEW: tài liệu chưa ban hành ngưỡng sai số chính thức theo từng nhóm ABC/XYZ (phải backtest + phê duyệt riêng, không dùng một ngưỡng chung) nên không mô hình nào được tự khóa. EXCEPTION: không đủ chu kỳ TEST để đo sai số. Hành động: người vận hành đọc cả 4 chỉ tiêu — đặc biệt Bias — trước khi quyết định dùng tạm dự báo này hay chuyển ngoại lệ chờ duyệt.',
    future: 'Dự báo NỀN cho 6 chu kỳ tới, sinh từ trạng thái L/T/S cuối cùng (chưa áp hệ số khuyến mãi — việc đó thuộc Chặng 14). Xu hướng khi dự phóng bị chặn ±15%.',
  };

  /** Công thức LaTeX — cùng nguồn với METRICS trong formula-registry.ts (C11 §11.3). */
  readonly metricFormulas: Record<string, string> = {
    rmse: String.raw`\operatorname{RMSE}=\sqrt{\frac{1}{n}\sum_{t=1}^{n}(Y_t-F_t)^2}`,
    nrmse: String.raw`\operatorname{nRMSE}=\frac{\operatorname{RMSE}}{\overline{Y}},\qquad \overline{Y}>0`,
    wape: String.raw`\operatorname{WAPE}=\frac{\sum_{t=1}^{n}|Y_t-F_t|}{\sum_{t=1}^{n}Y_t}`,
    bias: String.raw`\operatorname{Bias}=\frac{\sum_{t=1}^{n}(F_t-Y_t)}{\sum_{t=1}^{n}Y_t}`,
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
    void this.store.selectDataSource('real', 20);
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
    const enteringStage2 = stage === 2 && this.store.activeStage() !== 2;
    this.auditDate.set(null);
    this.auditRowsExpanded.set(false);
    this.traceStepOverrides.set({});
    this.highlightedCycleIndex.set(null);
    this.currentAnomalyIndex.set({ type: '', index: -1 });
    const navigation = this.store.selectStage(stage as StageNumber);
    if (enteringStage2) {
      // Chặng 1 chỉ khóa khung lịch, chưa có nội dung theo SKU — vào Chặng 2 luôn mở SKU đầu
      // danh sách để người dùng không phải tự tìm, thay vì giữ lựa chọn rời rạc từ trước đó.
      void navigation.then(() => {
        const first = this.visibleCatalog()[0];
        if (first) this.selectSku(first);
      });
    } else {
      void navigation;
    }
  }
  goPrevious(): void {
    if (this.store.activeStage() > 1) this.selectStage(this.store.activeStage() - 1);
  }
  goNext(): void {
    if (this.store.activeStage() < 20) this.selectStage(this.store.activeStage() + 1);
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
    // Nền trước xa nhất có thể vượt ra ngoài cửa sổ 300 ngày mặc định dù chính dòng bấm vẫn
    // hiện — không mở rộng thì highlight "nền trước" biến mất trong im lặng, tưởng là lỗi.
    if (!this.auditRowsExpanded()) {
      const rendered = this.renderedAuditDailyRows();
      const renderedStart = rendered[0]?.date;
      const earliestReferenceNeeded = row.beforeReferenceDates.at(-1) ?? row.date;
      if (!rendered.includes(row) || (renderedStart !== undefined && earliestReferenceNeeded < renderedStart)) {
        this.auditRowsExpanded.set(true);
      }
    }
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
      case 'BLOCKED_NO_VALID_BASELINE': return 'CHẶN · KHÔNG CÓ NỀN HỢP LỆ';
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
    if (cycle.status === 'BLOCKED_NO_VALID_BASELINE') {
      return `0/${cycle.days} ngày có baseDemand hợp lệ; chu kỳ bị chặn và không được tạo ${cycle.days} ngày giả để đi tiếp.`;
    }
    if (cycle.status === 'PARTIAL_BASELINE') {
      return `${cycle.days - cycle.unresolvedDays}/${cycle.days} ngày đã có Bₜ; còn ${cycle.unresolvedDays} ngày thiếu căn cứ nên Yⱼ chưa được khóa.`;
    }
    return `Đủ ${cycle.days}/${cycle.days} ngày có Bₜ; Yⱼ=${this.format(cycle.baseDemand, 1)} được phép đi tiếp.`;
  }

  cycleDayIssue(row: DailyRecord): string {
    const auditReason = row.selectionReason ? ` ${row.selectionReason}` : '';
    if (row.salesObservationStatus === 'SOURCE_DATA_GAP') return `Nguồn sales chưa đủ; sales=null, không phải 0.${auditReason}`;
    if (row.promoCode) return `Ngày CTKM chưa tìm đủ ngày sạch đối chứng để chuẩn hóa.${auditReason}`;
    if (row.stockoutStatus !== 'NONE') return `Ngày stockout/review chưa tìm đủ ngày sạch đối chứng để nâng nền.${auditReason}`;
    if (['STOCKOUT_UNRESOLVED', 'PROMOTION_UNRESOLVED', 'SOURCE_DATA_GAP'].includes(row.baseDemandSource)) return `Chưa đủ căn cứ tạo Bₜ.${auditReason}`;
    return row.selectionReason || 'Chưa tìm được sức mua nền Bₜ cho ngày này.';
  }

  jumpToAnomaly(type: 'stockout' | 'promo' | 'gap'): void {
    const rows = type === 'gap' ? this.stage5FillDays()
      : this.auditDailyRows().filter(item => type === 'stockout' ? item.stockoutStatus !== 'NONE' && item.promotionClass !== 'DEEP_PROMO' : item.promotionClass === 'DEEP_PROMO');
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

  // Chặng 2 chỉ đánh dấu stockout; nền bù (trước/sau) chỉ tồn tại từ Chặng 3 trở đi — không
  // đọc trước dữ liệu của chặng chưa chạy, chỉ nói rõ lý do để không tưởng nhầm là lỗi.
  auditContextNote(row: DailyRecord): string {
    if (row.selectionReason) return row.selectionReason;
    if (this.store.activeStage() === 2 && row.stockoutStatus !== 'NONE') {
      return 'Chặng 2 chỉ đánh dấu stockout — nền bù (nền trước/sau) sẽ được tính ở Chặng 3.';
    }
    return 'Bản ghi đang được kiểm tra.';
  }

  private readonly beforeReferenceSet = computed(() => new Set(this.selectedAuditRow()?.beforeReferenceDates));
  private readonly afterReferenceSet = computed(() => new Set(this.selectedAuditRow()?.afterReferenceDates));
  isReferenceBefore(row: DailyRecord): boolean { return this.beforeReferenceSet().has(row.date); }
  isReferenceAfter(row: DailyRecord): boolean { return this.afterReferenceSet().has(row.date); }

  statusLabel(row: DailyRecord): string {
    if (row.baseDemandSource === 'TECHNICAL_FILL') return 'LẤP NỀN C5';
    if (row.baseDemandSource === 'PROMOTION_UNRESOLVED') return 'CHỜ/THIẾU NỀN C4';
    if (row.balanceStatus === 'balanced') return 'CÂN BẰNG';
    if (row.balanceStatus === 'temporary') return 'TẠM · KIỂM TRA';
    if (row.balanceStatus === 'fixed') return 'KHÔNG CÂN BẰNG CỐ ĐỊNH';
    if (row.balanceStatus === 'insufficient' || row.baseDemand === null) return 'THIẾU CĂN CỨ';
    if (row.isCleanObservedReference) return 'DỮ LIỆU GỐC';
    return 'CHƯA XỬ LÝ';
  }

  statusClass(row: DailyRecord): string {
    if (row.baseDemandSource === 'TECHNICAL_FILL') return 'fixed';
    return row.balanceStatus ?? (row.promotionStatus === 'PROMOTION' ? 'promo' : row.isCleanObservedReference ? 'clean' : 'pending');
  }

  // Giao diện CHỈ binding TÊN CTKM, không binding mã (quyết định 2026-07-17). Một ngày có
  // thể dính nhiều chương trình chồng nhau (promoCode ghép "|") nhưng nguồn chỉ mang tên
  // của CTKM chính — hiện tên chính + số chương trình còn lại.
  promoLabel(row: Pick<DailyRecord, 'promotionName' | 'promoCode'>): string {
    const overlapCount = (row.promoCode ?? '').split('|').filter(Boolean).length;
    const name = row.promotionName?.trim() || 'CTKM chưa có tên';
    return overlapCount > 1 ? `${name} +${overlapCount - 1}` : name;
  }

  hasBarKind(chart: DemandStructureChart, kind: DemandChartBarKind): boolean {
    return chart.bars.some(bar => bar.kind === kind);
  }

  // Chặng 10 — ô màu cam/xanh (season-cell) chỉ có legend chung ở đầu bảng, phải kéo mắt lên mới
  // đối chiếu được; giờ mỗi ô tự giải thích đúng số liệu và ngưỡng của chính nó khi hover.
  seasonCellTooltip(item: { value: number; ratio: number; tone: 'high' | 'low' | 'neutral' }, position: number, roundIndex: number): string {
    const pct = (item.ratio - 1) * 100;
    const sign = pct >= 0 ? '+' : '';
    const verdict = item.tone === 'high'
      ? 'ĐỈNH MÙA VỤ (Rᵣ,ₚ ≥ 1,15)'
      : item.tone === 'low'
        ? 'ĐÁY MÙA VỤ (Rᵣ,ₚ ≤ 0,85)'
        : 'Trong ngưỡng bình thường (0,85 < Rᵣ,ₚ < 1,15)';
    return `Vị trí ${position.toString().padStart(2, '0')} · Vòng ${roundIndex + 1}: Y=${this.format(item.value, 0)} · Rᵣ,ₚ=Y/Ȳ vòng=${this.format(item.ratio, 2)} (${sign}${this.format(pct, 0)}% so Ȳ vòng) → ${verdict}`;
  }

  hasRawMarks(chart: DemandStructureChart): boolean {
    return chart.bars.some(bar => bar.rawHeight !== null);
  }

  getSkuSortValueLabel(sku: SkuDefinition): string {
    return this.skuSortMeta().get(sku.id)?.label ?? '';
  }

}

/** Tính một lần cho mỗi (snapshot, chặng): [khóa sort chính, khóa phụ] giảm dần + nhãn hiển thị. */
function buildSkuSortMeta(state: Readonly<SkuPipelineState>, stage: StageNumber): { key: readonly [number, number]; label: string } {
  const format = (value: number | null | undefined, digits = 0): string =>
    value === null || value === undefined ? '—' : viNumberFormat(digits).format(value);
  // visibleCatalog() sort key[0] descending mọi chặng — Chặng 2-5 âm hoá count điểm méo
  // (SO/nâng nền/chuẩn hóa/chưa đủ nền) để danh sách ra đúng thứ tự ít méo trước, nhiều méo sau.
  if (stage === 5) {
    const unresolved = state.daily.filter(day => day.baseDemand === null).length;
    return { key: [-unresolved, 0], label: `${unresolved} ngày chưa đủ nền` };
  }
  switch ((stage > 5 ? stage - 1 : stage) as Exclude<StageNumber, 20>) {
    case 1: {
      const count = state.daily.filter(day => day.hasSalesRecord).length;
      return { key: [count, 0], label: `${count} ngày ghi nhận bán` };
    }
    case 2: {
      const count = state.daily.filter(d => d.stockoutStatus !== 'NONE').length;
      return { key: [-count, 0], label: `${count} SO` };
    }
    case 3: {
      const count = state.daily.filter(d => d.baseDemandSource === 'STOCKOUT_BASELINE').length;
      return { key: [-count, 0], label: `${count} nâng nền` };
    }
    case 4: {
      const count = state.daily.filter(d => d.baseDemandSource === 'PROMOTION_BASELINE').length;
      return { key: [-count, 0], label: `${count} chuẩn hóa` };
    }
    case 5: {
      const locked = state.cycles.filter(c => c.locked).length;
      return { key: [locked, 0], label: `${locked}/${state.cycles.length} CK` };
    }
    case 6: {
      const val = state.classification.annualValue ?? 0;
      return { key: [val, 0], label: `${viNumberFormat(0).format(val)} ₫` };
    }
    case 7: {
      const order: Record<string, number> = { X: 4, Y: 3, Z: 2, D: 1, BLOCKED: 0 };
      return {
        key: [order[state.classification.xyz ?? 'BLOCKED'] ?? 0, 0],
        label: `ADI: ${format(state.classification.adi, 2)} · CV²: ${format(state.classification.cv2, 2)}`,
      };
    }
    case 8:
      return { key: [state.serviceLevel ?? 0, 0], label: state.serviceLevel !== null ? `SL: ${state.serviceLevel}%` : 'Chính sách riêng' };
    case 9: {
      const order: Record<string, number> = { 'confirmed': 4, 'no-clear-season': 3, 'insufficient-structure': 2, 'not-applicable': 1 };
      const mapping: Record<string, string> = {
        'confirmed': 'Mùa vụ', 'no-clear-season': 'Không rõ', 'insufficient-structure': 'Thiếu chu kỳ', 'not-applicable': 'Không áp dụng',
      };
      return { key: [order[state.seasonality] ?? 0, 0], label: mapping[state.seasonality] ?? state.seasonality };
    }
    case 10: {
      const [g1, g2] = state.trendRates;
      const key: [number, number] = [(Math.abs(g1 ?? 0) + Math.abs(g2 ?? 0)) / 2, 0];
      if (g1 === null || g1 === undefined || g2 === null || g2 === undefined) return { key, label: 'Không có xu hướng' };
      return { key, label: `g₁: ${g1 > 0 ? '+' : ''}${format(g1 * 100, 1)}% · g₂: ${g2 > 0 ? '+' : ''}${format(g2 * 100, 1)}%` };
    }
    case 11: {
      const wape = state.forecast?.wape;
      return { key: [wape ?? 0, 0], label: wape != null ? `WAPE: ${format(wape * 100, 1)}%` : 'Không có WAPE' };
    }
    case 12:
      return { key: [state.promoFactor ?? 1, 0], label: state.promoFactor != null ? `K: ${format(state.promoFactor, 2)}` : 'K: —' };
    case 13: {
      const sum = state.finalForecast.reduce((a, b) => a + b, 0);
      return { key: [sum, 0], label: `F: ${format(sum, 1)}` };
    }
    case 14:
      return { key: [state.freeStock ?? 0, 0], label: `Free: ${format(state.freeStock)}` };
    case 15:
      return { key: [state.safetyStock ?? 0, 0], label: `SS: ${format(state.safetyStock)}` };
    case 16:
      return { key: [state.orderPlan?.orderQuantity ?? 0, 0], label: `Đặt: ${format(state.orderPlan?.orderQuantity)}` };
    case 17: {
      const cut = state.budgetAllocation?.cutQuantity ?? 0;
      const label = cut > 0 ? `Cắt: ${format(cut)}` : `Cấp: ${format(state.budgetAllocation?.fundedQuantity ?? 0)}`;
      return { key: [cut, state.budgetAllocation?.orderValue ?? 0], label };
    }
    case 18: {
      const count = state.releaseDecision?.reasons.length ?? 0;
      return { key: [count, 0], label: `${count} ngoại lệ` };
    }
    case 19: {
      const wape = state.postAudit?.forecastWape;
      const so = state.postAudit?.stockoutUnits;
      const label = wape != null ? `Audit WAPE: ${format(wape * 100, 1)}%` : so != null ? `Thiếu: ${format(so)}` : '';
      return { key: [wape ?? 0, so ?? 0], label };
    }
    default:
      return { key: [0, 0], label: '' };
  }
}


