import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SimulationStore } from '../state/simulation.store';
import { SkuPipelineState } from '../domain/models';
import { MathFormulaComponent } from './math-formula.component';

@Component({
  selector: 'app-comparison-report',
  standalone: true,
  imports: [FormsModule, MathFormulaComponent],
  templateUrl: './comparison-report.component.html',
  styleUrl: './comparison-report.component.css',
})
export class ComparisonReportComponent {
  readonly Math = Math;
  readonly store = inject(SimulationStore);
  readonly activeTab = signal<'kpis' | 'sku' | 'guide'>('kpis');
  readonly selectedSkuId = signal<string>('SKU-001');

  readonly realStates = computed(() => this.store.realFinalState() ?? {});
  readonly mockStates = computed(() => this.store.mockFinalState() ?? {});
  readonly catalog = computed(() => this.store.catalog);

  // Dynamic calculations for Overview KPIs
  readonly kpis = computed(() => {
    const realList = Object.values(this.realStates());
    const mockList = Object.values(this.mockStates());

    // 1. SKU Count
    const realSkuCount = realList.length;
    const mockSkuCount = mockList.length;

    // 2. Average WAPE (Backtest error from Chặng 11)
    const getAvgWape = (list: SkuPipelineState[]) => {
      const wapes = list.map(s => s.forecast?.wape).filter(w => w != null) as number[];
      return wapes.length ? wapes.reduce((sum, w) => sum + w, 0) / wapes.length : 0;
    };
    const realAvgWape = getAvgWape(realList);
    const mockAvgWape = getAvgWape(mockList);

    // 3. Average Bias (Backtest bias from Chặng 11)
    const getAvgBias = (list: SkuPipelineState[]) => {
      const biases = list.map(s => s.forecast?.bias).filter(b => b != null) as number[];
      return biases.length ? biases.reduce((sum, b) => sum + b, 0) / biases.length : 0;
    };
    const realAvgBias = getAvgBias(realList);
    const mockAvgBias = getAvgBias(mockList);

    // 4. Average RMSE (Backtest RMSE from Chặng 11)
    const getAvgRmse = (list: SkuPipelineState[]) => {
      const rmses = list.map(s => s.forecast?.rmse).filter(r => r != null) as number[];
      return rmses.length ? rmses.reduce((sum, r) => sum + r, 0) / rmses.length : 0;
    };
    const realAvgRmse = getAvgRmse(realList);
    const mockAvgRmse = getAvgRmse(mockList);

    // 5. Total Forecast Quantity (Sum of 6 cycles of finalForecast in Chặng 13)
    const getForecastQty = (list: SkuPipelineState[]) => {
      return list.reduce((sum, s) => sum + (s.finalForecast || []).reduce((a, b) => a + b, 0), 0);
    };
    const realForecastQty = getForecastQty(realList);
    const mockForecastQty = getForecastQty(mockList);

    // 6. Total Forecast Value (Forecast Qty * price)
    const getForecastVal = (list: SkuPipelineState[]) => {
      return list.reduce((sum, s) => {
        const qty = (s.finalForecast || []).reduce((a, b) => a + b, 0);
        return sum + (qty * s.definition.price);
      }, 0);
    };
    const realForecastVal = getForecastVal(realList);
    const mockForecastVal = getForecastVal(mockList);

    // 7. Average Service Level % (Chặng 8)
    const getAvgSL = (list: SkuPipelineState[]) => {
      const sls = list.map(s => s.serviceLevel).filter(s => s != null) as number[];
      return sls.length ? sls.reduce((sum, s) => sum + s, 0) / sls.length : 0;
    };
    const realAvgSL = getAvgSL(realList);
    const mockAvgSL = getAvgSL(mockList);

    return {
      realSkuCount, mockSkuCount,
      realAvgWape, mockAvgWape,
      realAvgBias, mockAvgBias,
      realAvgRmse, mockAvgRmse,
      realForecastQty, mockForecastQty,
      realForecastVal, mockForecastVal,
      realAvgSL, mockAvgSL,
    };
  });

  readonly selectedSkuDetail = computed(() => {
    const skuId = this.selectedSkuId();
    const realState = this.realStates()[skuId] ?? null;
    const mockState = this.mockStates()[skuId] ?? null;
    const definition = this.catalog().find(s => s.id === skuId) ?? null;

    const getWapeStr = (state: SkuPipelineState | null) => {
      const wape = state?.forecast?.wape;
      return wape != null ? `${this.format(wape * 100, 1)}%` : '—';
    };

    const getPostWapeStr = (state: SkuPipelineState | null) => {
      const wape = state?.postAudit?.forecastWape;
      return wape != null ? `${this.format(wape * 100, 1)}%` : '—';
    };

    const getBiasStr = (state: SkuPipelineState | null) => {
      const bias = state?.forecast?.bias;
      return bias != null ? `${this.format(bias * 100, 1)}%` : '—';
    };

    const getRmseStr = (state: SkuPipelineState | null) => {
      const rmse = state?.forecast?.rmse;
      return rmse != null ? `${this.format(rmse, 1)} sp` : '—';
    };

    return {
      definition,
      real: realState,
      mock: mockState,
      realWapeStr: getWapeStr(realState),
      mockWapeStr: getWapeStr(mockState),
      realPostWapeStr: getPostWapeStr(realState),
      mockPostWapeStr: getPostWapeStr(mockState),
      realBiasStr: getBiasStr(realState),
      mockBiasStr: getBiasStr(mockState),
      realRmseStr: getRmseStr(realState),
      mockRmseStr: getRmseStr(mockState),
    };
  });

  /**
   * Trục x = 12 chu kỳ lịch sử gần nhất (tiêu thụ QUAN SÁT tổng theo chu kỳ, luôn có với mọi nguồn
   * dữ liệu) nối tiếp 6 chu kỳ tương lai (dự báo + thực tế kiểm chứng nếu có). Trước đây chart chỉ
   * vẽ 3 chuỗi tương lai — với dữ liệu thật cả 3 đều rỗng (actualDemand là bucket-(c), forecast bị
   * chặn chờ duyệt CTKM thường trực) nên chart không bao giờ hiện.
   */
  readonly selectedSkuChartPaths = computed(() => {
    const detail = this.selectedSkuDetail();
    if (!detail.definition) return null;

    const HISTORY_CYCLES = 12;
    const FUTURE_CYCLES = 6;
    // Lịch sử tiêu thụ lấy từ state nguồn nào có dữ liệu (ưu tiên real).
    const historyState = detail.real ?? detail.mock ?? null;
    const cycles = (historyState?.cycles ?? []).slice(-HISTORY_CYCLES);
    const daily = historyState?.daily ?? [];
    const history = cycles.map(cycle => ({
      label: `CK${cycle.cycleIndex}`,
      val: Math.round(daily.reduce((sum, row) => row.date >= cycle.dateStart && row.date <= cycle.dateEnd && row.hasRecord && row.sales !== null ? sum + row.sales : sum, 0)),
    }));

    const actual = detail.definition.actualDemand || [];
    const realFc = detail.real?.finalForecast || [];
    const mockFc = detail.mock?.finalForecast || [];

    const allValues = [...history.map(h => h.val), ...actual, ...realFc, ...mockFc].filter(v => v != null);
    if (!allValues.length) return null;

    const maxVal = Math.max(...allValues, 10);
    const range = maxVal;

    const width = 480;
    const height = 180;
    const paddingLeft = 40;
    const paddingRight = 20;
    const paddingBottom = 30;
    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - 20 - paddingBottom;

    const slots = history.length + FUTURE_CYCLES;
    const getX = (index: number) => paddingLeft + (slots > 1 ? index / (slots - 1) : 0) * plotWidth;
    const getY = (val: number) => height - paddingBottom - (val / range) * plotHeight;

    const historyPoints = history.map((h, idx) => ({ x: getX(idx), y: getY(h.val), val: h.val, label: h.label }));
    const futureX = (idx: number) => getX(history.length + idx);
    const actualPoints = actual.map((val, idx) => ({ x: futureX(idx), y: getY(val), val: Math.round(val), label: `CK+${idx + 1}` }));
    const realPoints = realFc.map((val, idx) => ({ x: futureX(idx), y: getY(val), val: Math.round(val), label: `CK+${idx + 1}` }));
    const mockPoints = mockFc.map((val, idx) => ({ x: futureX(idx), y: getY(val), val: Math.round(val), label: `CK+${idx + 1}` }));

    const makePath = (points: { x: number; y: number }[]) => {
      if (!points.length) return '';
      return `M ${points[0].x} ${points[0].y} ` + points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
    };

    const ticks = [0, 0.25, 0.5, 0.75, 1].map(pct => ({ y: getY(pct * range), label: Math.round(pct * range) }));
    // Nhãn trục x chọn lọc để không đè nhau: mỗi 3 chu kỳ lịch sử + mốc tương lai đầu/cuối.
    const xLabels = [
      ...historyPoints.filter((_, idx) => idx % 3 === 0 || idx === historyPoints.length - 1).map(p => ({ x: p.x, label: p.label })),
      ...(realPoints.length || mockPoints.length || actualPoints.length ? [{ x: futureX(0), label: 'CK+1' }, { x: futureX(FUTURE_CYCLES - 1), label: `CK+${FUTURE_CYCLES}` }] : []),
    ];
    // Vạch phân vùng lịch sử | tương lai.
    const dividerX = history.length ? (getX(history.length - 1) + futureX(0)) / 2 : null;

    return {
      width,
      height,
      historyPoints,
      actualPoints,
      realPoints,
      mockPoints,
      historyPath: makePath(historyPoints),
      actualPath: makePath(actualPoints),
      realPath: makePath(realPoints),
      mockPath: makePath(mockPoints),
      ticks,
      xLabels,
      dividerX,
    };
  });

  format(value: number | null | undefined, digits = 0): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  }

  formatCurrency(value: number): string {
    return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value)} ₫`;
  }
}
