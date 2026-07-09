import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AbcClass, LockStatus, SkuPipelineState, StageNumber, XyzClass } from '../domain/models';
import { SimulationStore, viNumberFormat } from '../state/simulation.store';

type DemandPattern = 'seasonal' | 'trend' | 'short-cycle' | 'intermittent' | 'stable' | 'insufficient';

interface SampleSeries {
  id: string; name: string; abc: AbcClass; xyz: XyzClass; model: string; values: number[];
}

interface PatternRow {
  key: DemandPattern; label: string; hint: string; color: string; count: number; pct: number; sample: SampleSeries | null;
}

const PATTERN_META: Record<DemandPattern, { label: string; hint: string; color: string }> = {
  seasonal: { label: 'Mùa vụ theo năm', hint: 'Lặp lại theo 24 vị trí mỗi vòng năm — mở Holt-Winters', color: 'var(--s1)' },
  trend: { label: 'Xu hướng tăng / giảm', hint: 'Tăng hoặc giảm liên tục qua 3 đoạn gần nhất — mở Holt', color: 'var(--s2)' },
  'short-cycle': { label: 'Lặp chu kỳ ngắn', hint: 'Lặp theo nhịp 2–12 chu kỳ, ví dụ theo kỳ lương — Seasonal-naïve', color: 'var(--s3)' },
  intermittent: { label: 'Bán thưa / theo nhịp', hint: 'Nhóm Z — nhu cầu không liên tục, cần Croston hoặc nhịp phát sinh', color: 'var(--s4)' },
  stable: { label: 'Ổn định', hint: 'Không mùa vụ, không xu hướng rõ — san mũ đơn (SES)', color: 'var(--s5)' },
  insufficient: { label: 'Thiếu căn cứ (D)', hint: 'Chưa đủ chu kỳ khóa để tự học — cần kế hoạch thủ công', color: 'var(--s6)' },
};

const PATTERN_KEYS = Object.keys(PATTERN_META) as DemandPattern[];
const ABC_ORDER: readonly AbcClass[] = ['A', 'B', 'C', 'N/A'];
const XYZ_ORDER: readonly XyzClass[] = ['X', 'Y', 'Z', 'D'];
const LOCK_STATUS_META: Record<LockStatus, { label: string; color: string }> = {
  locked: { label: 'Đã khóa', color: 'var(--green)' },
  review: { label: 'Cần người duyệt', color: 'var(--amber)' },
  temporary: { label: 'Tạm thời', color: 'var(--cyan)' },
  exception: { label: 'Ngoại lệ', color: 'var(--danger)' },
};

function classifyPattern(state: Readonly<SkuPipelineState>): DemandPattern {
  if (state.classification.xyz === 'D') return 'insufficient';
  if (state.forecast?.model === 'SeasonalNaive') return 'short-cycle';
  if (state.seasonality === 'confirmed') return 'seasonal';
  if (state.trend === 'up' || state.trend === 'down') return 'trend';
  if (state.classification.xyz === 'Z') return 'intermittent';
  return 'stable';
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

@Component({
  selector: 'app-executive-dashboard',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
<div class="exec">
  @if (!hasData()) {
    <div class="exec-empty">
      <p class="eyebrow">BÁO CÁO BAN GIÁM ĐỐC</p>
      <h2>Chưa có kết quả mô phỏng để báo cáo</h2>
      <p>Chạy đủ pipeline (Chặng 1–19) để tổng hợp cấu trúc nhu cầu, phân nhóm ABC/XYZ, dự báo và ngân sách.</p>
      <button type="button" class="btn primary" (click)="store.runAll()" [disabled]="store.isRunning()">
        {{ store.isRunning() ? 'Đang chạy…' : 'Chạy toàn bộ 19 chặng' }}
      </button>
    </div>
  } @else {

  <header class="exec-head">
    <div>
      <p class="eyebrow">BÁO CÁO BAN GIÁM ĐỐC · {{ store.catalog.length }} SKU trong danh mục mô phỏng</p>
      <h2>Kết quả mô phỏng Demand Planning &amp; Replenishment</h2>
    </div>
    @if (store.completedStage() < 19) {
      <div class="partial-note">Pipeline mới chạy đến Chặng {{ store.completedStage() }}/19 — một số khối (dự báo, ngân sách) có thể chưa đầy đủ.
        <button type="button" class="btn ghost" (click)="store.runAll()" [disabled]="store.isRunning()">Chạy tiếp đến Chặng 19</button>
      </div>
    }
  </header>

  <section class="kpi-strip" aria-label="Chỉ số tổng quan">
    <div class="kpi-tile">
      <span>SKU trong danh mục</span><b>{{ format(kpis().total) }}</b>
      <small>{{ format(kpis().lockedForecast) }} dự báo đã khóa · {{ format(kpis().reviewForecast) }} chờ duyệt</small>
    </div>
    <div class="kpi-tile">
      <span>Ngân sách kỳ</span><b>{{ formatCurrency(store.policy().periodBudget) }}</b>
      <small>Chu kỳ {{ store.policy().cycleLength }} ngày · chạy {{ store.policy().runDate }}</small>
    </div>
    <div class="kpi-tile">
      <span>Giá trị đề xuất mua</span><b>{{ formatCurrency(kpis().orderValue) }}</b>
      <small>Trước khi xét ràng buộc vốn (Chặng 16)</small>
    </div>
    <div class="kpi-tile">
      <span>Giá trị được cấp vốn</span><b class="good">{{ formatCurrency(kpis().fundedValue) }}</b>
      <small>{{ formatPercent(kpis().utilization) }} so với đề xuất</small>
    </div>
    <div class="kpi-tile">
      <span>Giá trị bị cắt / hoãn</span><b class="warn">{{ formatCurrency(kpis().cutValue) }}</b>
      <small>Do vượt ngân sách kỳ (Chặng 17)</small>
    </div>
    <div class="kpi-tile">
      <span>WAPE danh mục (backtest)</span><b>{{ formatPercent(kpis().avgWape) }}</b>
      <small>Trung bình các mô hình đã học — chưa có ngưỡng ban hành để tự khóa</small>
    </div>
  </section>

  <section class="exec-grid">

    <!-- 1. Cấu trúc nhu cầu -->
    <article class="exec-card span-2" aria-labelledby="structure-title">
      <div class="card-head"><h3 id="structure-title">Cấu trúc nhu cầu của các SKU</h3><p>Mỗi SKU được phân vào đúng một dạng cấu trúc trước khi chọn mô hình dự báo nền (Chặng 9–11).</p></div>
      <div class="structure-body">
        <div class="stacked-bar" role="img" aria-label="Tỷ trọng các dạng cấu trúc nhu cầu">
          @for (row of patternBoard(); track row.key) {
            @if (row.pct > 0) { <span [style.width.%]="row.pct * 100" [style.background]="row.color" [title]="row.label + ': ' + format(row.count) + ' SKU'"></span> }
          }
        </div>
        <ul class="pattern-legend">
          @for (row of patternBoard(); track row.key) {
            <li>
              <i [style.background]="row.color"></i>
              <div><b>{{ row.label }}</b><small>{{ row.hint }}</small></div>
              <div class="pattern-count"><b>{{ format(row.count) }}</b><small>{{ formatPercent(row.pct) }}</small></div>
            </li>
          }
        </ul>
        <div class="pattern-gallery">
          @for (row of patternBoard(); track row.key) {
            @if (row.sample) {
              <div class="gallery-card">
                <header><i [style.background]="row.color"></i><b>{{ row.label }}</b></header>
                <svg [attr.viewBox]="'0 0 160 48'" preserveAspectRatio="none" class="sparkline" role="img" [attr.aria-label]="'Chuỗi sức mua nền của ' + row.sample!.name">
                  <polyline [attr.points]="sparklinePoints(row.sample!.values)" [attr.stroke]="row.color" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <footer>
                  <span>{{ row.sample!.id }} · {{ row.sample!.name }}</span>
                  <span class="tag-chip">{{ row.sample!.abc }}{{ row.sample!.xyz }} · {{ row.sample!.model }}</span>
                </footer>
              </div>
            }
          }
        </div>
      </div>
    </article>

    <!-- 2. ABC x XYZ -->
    <article class="exec-card span-2" aria-labelledby="abcxyz-title">
      <div class="card-head"><h3 id="abcxyz-title">Kết quả phân nhóm ABC × XYZ</h3><p>ABC theo giá trị tiêu thụ năm hóa (Chặng 6) · XYZ/D theo độ đều và độ thưa của nhu cầu (Chặng 7).</p></div>
      <div class="matrix-body">
        <table class="abc-xyz-matrix">
          <thead><tr><th></th>@for (xyz of xyzOrder; track xyz) { <th>{{ xyz }}</th> }</tr></thead>
          <tbody>
            @for (row of abcXyzMatrix().rows; track row.abc) {
              <tr>
                <th>{{ row.abc }}</th>
                @for (cell of row.cells; track cell.xyz) {
                  <td class="matrix-cell" [style.background]="cellBackground(cell.intensity)" [title]="row.abc + cell.xyz + ': ' + format(cell.count) + ' SKU · ' + formatCurrency(cell.value)">
                    <b>{{ cell.count ? format(cell.count) : '—' }}</b>
                    @if (cell.count) { <small>{{ formatPercent(cell.share) }}</small> }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
        <div class="matrix-side">
          <h4>Tỷ trọng giá trị theo ABC</h4>
          @for (row of abcTotals(); track row.abc) {
            <div class="mini-bar-row">
              <span>{{ row.abc }}</span>
              <div class="mini-bar"><i [style.width.%]="abcSharePct(row.value)" [style.background]="abcColor(row.abc)"></i></div>
              <b>{{ formatCurrency(row.value) }}</b>
            </div>
          }
          <h4>Số SKU theo XYZ/D</h4>
          @for (row of xyzTotals(); track row.xyz) {
            <div class="mini-bar-row">
              <span>{{ row.xyz }}</span>
              <div class="mini-bar"><i [style.width.%]="xyzSharePct(row.count)" [style.background]="xyzColor(row.xyz)"></i></div>
              <b>{{ format(row.count) }} SKU</b>
            </div>
          }
        </div>
      </div>
    </article>

    <!-- 3. Mùa vụ & xu hướng -->
    <article class="exec-card" aria-labelledby="season-trend-title">
      <div class="card-head"><h3 id="season-trend-title">SKU có mùa vụ, xu hướng</h3><p>Nhóm Y được kiểm tra mùa vụ (Chặng 9); nếu không có mùa vụ mới xét xu hướng (Chặng 10).</p></div>
      <div class="stat-tile-row">
        <div class="stat-tile"><b>{{ format(seasonTrend().seasonal) }}</b><span>SKU có mùa vụ xác nhận</span></div>
        <div class="stat-tile"><b>{{ format(seasonTrend().trendUp) }}</b><span>SKU xu hướng tăng</span></div>
        <div class="stat-tile"><b>{{ format(seasonTrend().trendDown) }}</b><span>SKU xu hướng giảm</span></div>
        <div class="stat-tile"><b>{{ format(seasonTrend().other) }}</b><span>Ổn định / chưa đủ căn cứ</span></div>
      </div>
    </article>

    <!-- 4. Dự báo -->
    <article class="exec-card" aria-labelledby="forecast-title">
      <div class="card-head">
        <div><h3 id="forecast-title">Đồ thị dự báo theo SKU</h3><p>Sức mua nền lịch sử (khóa) nối tiếp dự báo nền cho các chu kỳ tới.</p></div>
        <select [ngModel]="effectiveForecastSkuId()" (ngModelChange)="selectedForecastSkuId.set($event)" aria-label="Chọn SKU xem dự báo">
          @for (option of forecastSkuOptions(); track option.id) { <option [value]="option.id">{{ option.id }} · {{ option.name }} ({{ option.abc }}{{ option.xyz }})</option> }
        </select>
      </div>
      @if (forecastSeries(); as series) {
        <svg [attr.viewBox]="'0 0 ' + series.width + ' ' + series.height" class="forecast-chart" role="img" aria-label="Đồ thị sức mua nền và dự báo">
          <line [attr.x1]="series.dividerX" [attr.x2]="series.dividerX" [attr.y1]="series.padding" [attr.y2]="series.height - series.padding" class="divider"/>
          <polyline [attr.points]="series.historyPoints" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <polyline [attr.points]="series.futurePoints" fill="none" stroke="var(--amber)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="forecast-legend">
          <span><i class="dot" style="background:var(--cyan)"></i>Thực tế đã khóa (12 CK gần nhất)</span>
          <span><i class="dot" style="background:var(--amber)"></i>Dự báo nền tương lai</span>
          @if (forecastSkuState()?.forecast; as forecast) {
            <span class="lock-chip" [style.color]="lockMeta(forecast.lockStatus).color">{{ forecast.model }} · {{ lockMeta(forecast.lockStatus).label }}</span>
            <span>WAPE {{ formatPercent(forecast.wape) }} · Bias {{ formatPercent(forecast.bias) }}</span>
          }
        </div>
      } @else {
        <p class="empty-note">SKU này chưa có dữ liệu dự báo.</p>
      }
      <h4>Trạng thái khóa dự báo toàn danh mục</h4>
      <div class="stacked-bar" role="img" aria-label="Tỷ trọng trạng thái khóa dự báo">
        @for (row of lockStatusBoard(); track row.status) {
          @if (row.pct > 0) { <span [style.width.%]="row.pct * 100" [style.background]="row.color" [title]="row.label + ': ' + format(row.count) + ' SKU'"></span> }
        }
      </div>
      <ul class="inline-legend">
        @for (row of lockStatusBoard(); track row.status) { <li><i [style.background]="row.color"></i>{{ row.label }} — {{ format(row.count) }}</li> }
      </ul>
      <p class="governance-note">Tài liệu giải pháp chưa ban hành ngưỡng WAPE/Bias chính thức theo ô ABC×XYZ (Chặng 11 §10.5) — mọi dự báo hiện ở trạng thái <b>chờ người duyệt</b>, không tự động phát hành.</p>
    </article>

    <!-- 5. Ngân sách -->
    <article class="exec-card span-2" aria-labelledby="budget-title">
      <div class="card-head"><h3 id="budget-title">Ngân sách</h3><p>So sánh ngân sách kỳ với giá trị đề xuất, giá trị được cấp và giá trị bị cắt/hoãn (Chặng 17).</p></div>
      <div class="budget-body">
        <div class="budget-bars">
          @for (bar of budgetBars(); track bar.label) {
            <div class="budget-bar-row">
              <span>{{ bar.label }}</span>
              <div class="mini-bar wide"><i [style.width.%]="bar.pct * 100" [style.background]="bar.color"></i></div>
              <b>{{ formatCurrency(bar.value) }}</b>
            </div>
          }
        </div>
        <div class="budget-table-wrap">
          <h4>SKU bị cắt / hoãn vốn nhiều nhất</h4>
          <table class="budget-table">
            <thead><tr><th>SKU</th><th>ABC×XYZ</th><th>SL bị cắt</th><th>Giá trị</th><th>Lý do</th></tr></thead>
            <tbody>
              @for (row of topCutSkus(); track row.id) {
                <tr><td>{{ row.id }} · {{ row.name }}</td><td>{{ row.abc }}{{ row.xyz }}</td><td>{{ format(row.cutQuantity, 1) }}</td><td>{{ formatCurrency(row.cutValue) }}</td><td>{{ row.reason }}</td></tr>
              } @empty { <tr><td colspan="5" class="table-empty">Không có SKU nào bị cắt vốn trong phiên này.</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    </article>

  </section>
  }
</div>
`,
  styles: `
:host { display: block; }
.exec { --s1: #3987e5; --s2: #9085e9; --s3: #d95926; --s4: #d55181; --s5: #199e70; --s6: #7f8798; display: flex; flex-direction: column; gap: 14px; }
.exec-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 48px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
.exec-empty h2 { margin: 0; font: 650 20px "Bahnschrift Condensed", sans-serif; }
.exec-empty p { margin: 0; max-width: 520px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.exec-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.exec-head h2 { margin: 4px 0 0; font: 650 22px "Bahnschrift Condensed", sans-serif; }
.eyebrow { margin: 0; color: var(--muted); font: 700 10px/1.2 "Bahnschrift", sans-serif; letter-spacing: .14em; text-transform: uppercase; }
.partial-note { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid rgba(255,171,46,.35); border-radius: 8px; background: var(--amber-soft); color: var(--amber); font-size: 11px; }
.kpi-strip { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.kpi-tile { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); min-width: 0; }
.kpi-tile span { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.kpi-tile b { font: 650 19px "Bahnschrift Condensed", sans-serif; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi-tile b.good { color: var(--green); } .kpi-tile b.warn { color: var(--danger); }
.kpi-tile small { color: var(--faint); font-size: 10px; }
.exec-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.exec-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); min-width: 0; }
.exec-card.span-2 { grid-column: span 2; }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card-head h3 { margin: 0; font: 650 15px "Bahnschrift Condensed", sans-serif; }
.card-head p { margin: 3px 0 0; color: var(--muted); font-size: 11px; line-height: 1.4; max-width: 480px; }
.card-head select { height: 30px; padding: 0 8px; color: var(--text); background: #0c0f15; border: 1px solid var(--line); border-radius: 6px; font-size: 11px; color-scheme: dark; }
.stacked-bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: #0c0f15; }
.stacked-bar span { display: block; height: 100%; }
.stacked-bar span + span { border-left: 2px solid var(--panel); }
.pattern-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.pattern-legend li { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 8px; }
.pattern-legend i { width: 10px; height: 10px; border-radius: 3px; }
.pattern-legend b { display: block; font-size: 12px; }
.pattern-legend small { display: block; color: var(--faint); font-size: 10px; }
.pattern-count { text-align: right; } .pattern-count b { font-size: 13px; } .pattern-count small { display: block; color: var(--muted); }
.pattern-gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.gallery-card { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--line-soft); border-radius: 8px; background: #0e1119; }
.gallery-card header { display: flex; align-items: center; gap: 6px; font-size: 10px; }
.gallery-card header i { width: 8px; height: 8px; border-radius: 2px; }
.gallery-card .sparkline { width: 100%; height: 36px; }
.gallery-card footer { display: flex; flex-direction: column; gap: 2px; color: var(--faint); font-size: 9px; }
.tag-chip { color: var(--muted); }
.abc-xyz-matrix { border-collapse: collapse; font-size: 11px; }
.abc-xyz-matrix th, .abc-xyz-matrix td { padding: 6px 10px; text-align: center; border: 1px solid var(--line-soft); }
.abc-xyz-matrix th { color: var(--muted); font-weight: 700; }
.matrix-cell b { display: block; font-size: 12px; color: var(--text); }
.matrix-cell small { display: block; color: var(--faint); font-size: 9px; }
.matrix-body { display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: start; }
.matrix-side h4 { margin: 0 0 6px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
.matrix-side h4 + .mini-bar-row { margin-top: 0; }
.mini-bar-row { display: grid; grid-template-columns: 26px 1fr auto; align-items: center; gap: 8px; margin-bottom: 6px; }
.mini-bar-row span { color: var(--muted); font-size: 11px; font-weight: 700; }
.mini-bar-row b { font-size: 11px; white-space: nowrap; }
.mini-bar { height: 8px; border-radius: 4px; overflow: hidden; background: #0c0f15; }
.mini-bar.wide { height: 10px; }
.mini-bar i { display: block; height: 100%; }
.stat-tile-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.stat-tile { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: #0e1119; text-align: center; }
.stat-tile b { font: 650 20px "Bahnschrift Condensed", sans-serif; }
.stat-tile span { color: var(--muted); font-size: 10px; }
.forecast-chart { width: 100%; height: 180px; }
.divider { stroke: var(--line); stroke-width: 1; stroke-dasharray: 3 3; }
.forecast-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 10px; color: var(--muted); }
.forecast-legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.lock-chip { font-weight: 700; }
.inline-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; font-size: 10px; color: var(--muted); }
.inline-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.governance-note { margin: 0; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: 8px; background: #0e1119; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.empty-note { color: var(--faint); font-size: 11px; }
.budget-body { display: grid; grid-template-columns: 1fr 1.4fr; gap: 18px; }
.budget-bar-row { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 10px; margin-bottom: 10px; }
.budget-bar-row span { color: var(--muted); font-size: 11px; }
.budget-bar-row b { font-size: 11px; white-space: nowrap; }
.budget-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.budget-table th, .budget-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--line-soft); }
.budget-table th { color: var(--muted); font-weight: 700; }
.table-empty { text-align: center; color: var(--faint); padding: 16px; }
.btn { min-height: 34px; padding: 0 14px; border: 1px solid var(--line); border-radius: 7px; background: transparent; font-weight: 700; font-size: 12px; cursor: pointer; color: var(--text); }
.btn.primary { color: #15100a; border-color: var(--amber); background: var(--amber); }
.btn.ghost { color: var(--muted); background: #1b202a; }
@media (max-width: 1180px) {
  .kpi-strip { grid-template-columns: repeat(3, 1fr); }
  .exec-grid { grid-template-columns: 1fr; }
  .exec-card.span-2 { grid-column: span 1; }
  .pattern-gallery { grid-template-columns: repeat(2, 1fr); }
  .matrix-body, .budget-body { grid-template-columns: 1fr; }
}
`,
})
export class ExecutiveDashboardComponent {
  readonly store = inject(SimulationStore);
  readonly xyzOrder = XYZ_ORDER;
  readonly selectedForecastSkuId = signal<string | null>(null);

  readonly snapshot = computed(() => {
    const stage = this.store.completedStage();
    return stage ? this.store.snapshots()[stage as StageNumber] ?? null : null;
  });
  readonly states = computed<Readonly<SkuPipelineState>[]>(() => {
    const snapshot = this.snapshot();
    return snapshot ? Object.values(snapshot.states) : [];
  });
  readonly hasData = computed(() => this.states().length > 0);

  readonly kpis = computed(() => {
    const states = this.states();
    const orderValue = sum(states, s => s.budgetAllocation?.orderValue ?? 0);
    const fundedValue = sum(states, s => s.budgetAllocation?.fundedValue ?? 0);
    const cutValue = Math.max(0, orderValue - fundedValue);
    const utilization = orderValue > 0 ? fundedValue / orderValue : null;
    const lockedForecast = states.filter(s => s.forecast?.lockStatus === 'locked').length;
    const reviewForecast = states.filter(s => s.forecast?.lockStatus === 'review').length;
    const wapeValues = states.map(s => s.forecast?.wape).filter((v): v is number => v !== null && v !== undefined);
    const avgWape = wapeValues.length ? wapeValues.reduce((a, b) => a + b, 0) / wapeValues.length : null;
    return { total: states.length, orderValue, fundedValue, cutValue, utilization, lockedForecast, reviewForecast, avgWape };
  });

  readonly patternBoard = computed<PatternRow[]>(() => {
    const states = this.states();
    const total = states.length || 1;
    const buckets = new Map<DemandPattern, Readonly<SkuPipelineState>[]>();
    for (const state of states) {
      const key = classifyPattern(state);
      const list = buckets.get(key) ?? [];
      list.push(state);
      buckets.set(key, list);
    }
    return PATTERN_KEYS.map(key => {
      const list = (buckets.get(key) ?? []).slice().sort((a, b) => b.classification.annualValue - a.classification.annualValue);
      const top = list[0] ?? null;
      const sample: SampleSeries | null = top ? {
        id: top.definition.id, name: top.definition.name, abc: top.classification.abc, xyz: top.classification.xyz,
        model: top.forecast?.model ?? '—',
        values: top.cycles.filter(c => c.locked).slice(-16).map(c => c.baseDemand),
      } : null;
      const meta = PATTERN_META[key];
      return { key, label: meta.label, hint: meta.hint, color: meta.color, count: list.length, pct: list.length / total, sample };
    });
  });

  readonly abcXyzMatrix = computed(() => {
    const states = this.states();
    const grid = new Map<string, { count: number; value: number }>();
    let totalValue = 0;
    for (const state of states) {
      const key = `${state.classification.abc}|${state.classification.xyz}`;
      const cell = grid.get(key) ?? { count: 0, value: 0 };
      cell.count++; cell.value += state.classification.annualValue;
      grid.set(key, cell);
      totalValue += state.classification.annualValue;
    }
    const maxValue = Math.max(1, ...[...grid.values()].map(c => c.value));
    return {
      rows: ABC_ORDER.map(abc => ({
        abc,
        cells: XYZ_ORDER.map(xyz => {
          const cell = grid.get(`${abc}|${xyz}`) ?? { count: 0, value: 0 };
          return { xyz, count: cell.count, value: cell.value, intensity: cell.value / maxValue, share: totalValue ? cell.value / totalValue : 0 };
        }),
      })),
      totalValue,
    };
  });

  readonly abcTotals = computed(() => ABC_ORDER.map(abc => {
    const list = this.states().filter(s => s.classification.abc === abc);
    return { abc, count: list.length, value: sum(list, s => s.classification.annualValue) };
  }));
  private readonly maxAbcValue = computed(() => Math.max(1, ...this.abcTotals().map(row => row.value)));
  abcSharePct(value: number): number { return (value / this.maxAbcValue()) * 100; }
  abcColor(abc: AbcClass): string { return { A: 'var(--s1)', B: 'var(--s2)', C: 'var(--s3)', 'N/A': 'var(--s6)' }[abc]; }

  readonly xyzTotals = computed(() => XYZ_ORDER.map(xyz => ({ xyz, count: this.states().filter(s => s.classification.xyz === xyz).length })));
  private readonly maxXyzCount = computed(() => Math.max(1, ...this.xyzTotals().map(row => row.count)));
  xyzSharePct(count: number): number { return (count / this.maxXyzCount()) * 100; }
  xyzColor(xyz: XyzClass): string { return { X: 'var(--s1)', Y: 'var(--s2)', Z: 'var(--s4)', D: 'var(--s6)' }[xyz]; }

  cellBackground(intensity: number): string { return `rgba(57, 135, 229, ${0.08 + intensity * 0.45})`; }

  readonly seasonTrend = computed(() => {
    const states = this.states();
    const seasonal = states.filter(s => s.seasonality === 'confirmed').length;
    const trendUp = states.filter(s => s.trend === 'up').length;
    const trendDown = states.filter(s => s.trend === 'down').length;
    return { seasonal, trendUp, trendDown, other: states.length - seasonal - trendUp - trendDown };
  });

  readonly forecastSkuOptions = computed(() => this.states()
    .slice()
    .sort((a, b) => b.classification.annualValue - a.classification.annualValue)
    .map(s => ({ id: s.definition.id, name: s.definition.name, abc: s.classification.abc, xyz: s.classification.xyz })));
  readonly effectiveForecastSkuId = computed(() => this.selectedForecastSkuId() ?? this.forecastSkuOptions()[0]?.id ?? null);
  readonly forecastSkuState = computed(() => this.states().find(s => s.definition.id === this.effectiveForecastSkuId()) ?? null);

  readonly forecastSeries = computed(() => {
    const state = this.forecastSkuState();
    if (!state) return null;
    const history = state.cycles.filter(c => c.locked).slice(-12).map(c => c.baseDemand);
    const future = state.finalForecast.length ? state.finalForecast : (state.forecast?.baseForecast ?? []);
    if (!history.length && !future.length) return null;
    const width = 560, height = 180, padding = 20;
    const combined = [...history, ...future];
    const max = Math.max(1, ...combined);
    const stepX = combined.length > 1 ? (width - padding * 2) / (combined.length - 1) : 0;
    const toY = (value: number) => height - padding - (value / max) * (height - padding * 2);
    const points = combined.map((value, index) => ({ x: padding + index * stepX, y: toY(value) }));
    const historyPoints = points.slice(0, history.length).map(p => `${p.x},${p.y}`).join(' ');
    const futurePoints = points.slice(Math.max(0, history.length - 1)).map(p => `${p.x},${p.y}`).join(' ');
    const dividerX = points[Math.max(0, history.length - 1)]?.x ?? padding;
    return { width, height, padding, historyPoints, futurePoints, dividerX };
  });

  readonly lockStatusBoard = computed(() => {
    const states = this.states();
    const total = states.filter(s => s.forecast).length || 1;
    return (['locked', 'review', 'temporary', 'exception'] as LockStatus[]).map(status => {
      const count = states.filter(s => s.forecast?.lockStatus === status).length;
      return { status, count, pct: count / total, ...LOCK_STATUS_META[status] };
    });
  });
  lockMeta(status: LockStatus) { return LOCK_STATUS_META[status]; }

  readonly budgetBars = computed(() => {
    const periodBudget = this.store.policy().periodBudget;
    const k = this.kpis();
    const values = [
      { label: 'Ngân sách kỳ', value: periodBudget, color: 'var(--cyan)' },
      { label: 'Tổng đề xuất mua', value: k.orderValue, color: 'var(--s1)' },
      { label: 'Đã được cấp vốn', value: k.fundedValue, color: 'var(--green)' },
      { label: 'Bị cắt / hoãn', value: k.cutValue, color: 'var(--danger)' },
    ];
    const max = Math.max(1, periodBudget, ...values.map(v => v.value));
    return values.map(v => ({ ...v, pct: v.value / max }));
  });

  readonly topCutSkus = computed(() => this.states()
    .filter(s => (s.budgetAllocation?.cutQuantity ?? 0) > 0)
    .map(s => ({
      id: s.definition.id, name: s.definition.name, abc: s.classification.abc, xyz: s.classification.xyz,
      cutQuantity: s.budgetAllocation!.cutQuantity,
      cutValue: s.budgetAllocation!.cutQuantity * s.definition.purchasePrice,
      reason: s.budgetAllocation!.reason,
    }))
    .sort((a, b) => b.cutValue - a.cutValue)
    .slice(0, 8));

  sparklinePoints(values: readonly number[]): string {
    if (!values.length) return '';
    const width = 160, height = 48, padding = 4;
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const range = Math.max(1e-6, max - min);
    const stepX = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
    return values.map((value, index) => {
      const x = padding + index * stepX;
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    }).join(' ');
  }

  format(value: number | null | undefined, digits = 0): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return viNumberFormat(digits).format(value);
  }
  formatCurrency(value: number | null | undefined): string { return `${this.format(value)} ₫`; }
  formatPercent(value: number | null | undefined): string { return value === null || value === undefined ? '—' : `${this.format(value * 100, 1)}%`; }
}
