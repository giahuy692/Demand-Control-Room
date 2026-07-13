import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './simulation-engine';
import { DEFAULT_POLICY } from './policy';
import { StageNumber, StageSnapshot } from './models';
import { buildStageTrace } from './stage-trace';

describe('stage-trace sanity', () => {
  const engine = new SimulationEngine();
  const snapshots: Partial<Record<StageNumber, StageSnapshot>> = {};
  let previous: StageSnapshot | null = null;
  for (let stage = 1; stage <= 19; stage++) {
    previous = engine.run(stage as StageNumber, previous, DEFAULT_POLICY);
    snapshots[stage as StageNumber] = previous;
  }

  it('tạo trace không lỗi cho mọi chặng × mọi SKU × mọi điểm méo', { timeout: 120_000 }, () => {
    for (let stage = 1 as StageNumber; stage <= 19; stage++) {
      const snapshot = snapshots[stage as StageNumber]!;
      for (const state of Object.values(snapshot.states)) {
        const general = buildStageTrace(stage as StageNumber, state, DEFAULT_POLICY, null);
        expect(general.heading.length).toBeGreaterThan(0);
        expect(general.steps.length).toBeGreaterThan(0);
        expect(general.contract, `Chặng ${stage} phải có hợp đồng nội dung`).toBeDefined();
        expect(general.contract!.inputs.length).toBeGreaterThan(0);
        expect(general.contract!.rules.length).toBeGreaterThan(0);
        expect(general.contract!.outputs.length).toBeGreaterThan(0);
        expect(general.contract!.controls.length).toBeGreaterThan(0);
        for (const point of general.points ?? []) {
          const focused = buildStageTrace(stage as StageNumber, state, DEFAULT_POLICY, point.date);
          expect(focused.steps.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('trace chặng 3 thế số đúng bằng kết quả engine đã khóa', () => {
    const snapshot = snapshots[3]!;
    for (const state of Object.values(snapshot.states)) {
      const lifted = state.daily.find(record => record.baseSource === 'stockout-lifted');
      if (!lifted) continue;
      const trace = buildStageTrace(3, state, DEFAULT_POLICY, lifted.date);
      const final = trace.steps.at(-1)!;
      // baseSource='stockout-lifted' chỉ được gán qua requireObservedSales() (Chặng 3) nên sales luôn khác null ở đây.
      expect(final.substitution).toContain(`max(${lifted.sales!.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}`);
      expect(final.tone).toBe('good');
    }
  });

  it('trace chặng 4 dùng median, không dùng max', () => {
    const snapshot = snapshots[4]!;
    for (const state of Object.values(snapshot.states)) {
      const normalized = state.daily.find(record => record.baseSource === 'promo-normalized');
      if (!normalized) continue;
      const trace = buildStageTrace(4, state, DEFAULT_POLICY, normalized.date);
      const final = trace.steps.at(-1)!;
      expect(final.substitution).toContain('Median');
      expect(final.substitution).not.toContain('max(');
    }
  });

  it('trace Chặng 6 đủ 8 bước ABC và giải thích a_N', () => {
    for (const state of Object.values(snapshots[6]!.states)) {
      const trace = buildStageTrace(6, state, DEFAULT_POLICY, null);
      expect(trace.steps).toHaveLength(8);
      expect(trace.context).toContain('a_N');
      expect(trace.steps[2].detail).toContain('Q_năm');
      expect(trace.steps[3].title).toContain('tỷ trọng giá trị');
    }
  });

  it('trace Chặng 7 đủ các mục 4.4.1–4.4.9 và khớp μ/σ/CV² engine', () => {
    // RULE-07-003/004 — SKU bị CLASSIFICATION_BLOCKED/NO_POSITIVE_DEMAND_REVIEW có trace 1 bước
    // riêng (không phải 9 bước 4.4.1–4.4.9, vốn chỉ áp dụng khi đã CLASSIFIED thành X/Y/Z/D).
    for (const state of Object.values(snapshots[7]!.states)) {
      if (state.classification.classificationStatus !== 'CLASSIFIED') continue;
      const trace = buildStageTrace(7, state, DEFAULT_POLICY, null);
      expect(trace.steps).toHaveLength(9);
      expect(trace.steps.map(step => step.title)).toEqual(expect.arrayContaining([
        expect.stringContaining('4.4.1'), expect.stringContaining('4.4.9'),
      ]));
      if (state.classification.m) {
        expect(trace.steps[5].substitution).toContain('μ');
        expect(trace.steps[6].substitution).toContain('σ');
        expect(trace.steps[7].substitution).toContain('CV²');
      }
    }
  });

  it('process-panel giữ đủ số bước chuẩn của tài liệu cho các chặng có quy trình cố định', () => {
    const firstState = (stage: StageNumber) => Object.values(snapshots[stage]!.states)[0];
    const expected: Partial<Record<StageNumber, number>> = {
      1: 10, 2: 4, 3: 8, 4: 8, 5: 8, 6: 8, 7: 9, 8: 8, 12: 7, 13: 6, 14: 5, 15: 10,
      16: 13, 17: 10, 18: 9, 19: 12,
    };
    for (const [stageText, count] of Object.entries(expected)) {
      const stage = Number(stageText) as StageNumber;
      expect(buildStageTrace(stage, firstState(stage), DEFAULT_POLICY, null).steps, `Chặng ${stage}`).toHaveLength(count);
    }

    const stage9State = Object.values(snapshots[9]!.states).find(state => state.classification.xyz === 'Y' && state.cycles.filter(cycle => cycle.locked).length >= 48)!;
    expect(buildStageTrace(9, stage9State, DEFAULT_POLICY, null).steps).toHaveLength(8);
    const stage10State = Object.values(snapshots[10]!.states).find(state => state.classification.xyz === 'Y' && state.seasonality !== 'confirmed' && state.cycles.filter(cycle => cycle.locked).length >= 12)!;
    expect(buildStageTrace(10, stage10State, DEFAULT_POLICY, null).steps).toHaveLength(8);
    // Chặng 11 có 3 hình dạng khác nhau: X/Y đi qua cửa chu kỳ ngắn 11XY-SN (thêm 1 bước so với Z),
    // Z chạy thẳng Croston/nhịp phát sinh (không có cửa này), D không backtest thống kê [C11 §3, §8.3, §9].
    const stage11XY = Object.values(snapshots[11]!.states).find(state => state.classification.xyz === 'X' || state.classification.xyz === 'Y')!;
    expect(buildStageTrace(11, stage11XY, DEFAULT_POLICY, null).steps, 'Chặng 11 · nhóm X/Y').toHaveLength(10);
    const stage11Z = Object.values(snapshots[11]!.states).find(state => state.classification.xyz === 'Z')!;
    expect(buildStageTrace(11, stage11Z, DEFAULT_POLICY, null).steps, 'Chặng 11 · nhóm Z').toHaveLength(9);
    const stage11D = Object.values(snapshots[11]!.states).find(state => state.classification.xyz === 'D')!;
    expect(buildStageTrace(11, stage11D, DEFAULT_POLICY, null).steps, 'Chặng 11 · nhóm D').toHaveLength(4);
  });

  it('trace B1 Chặng 11 dùng đúng forecast.reason, không tự suy diễn nhãn model rồi lệch với model thực khóa', () => {
    for (const state of Object.values(snapshots[11]!.states)) {
      if (!state.forecast || state.classification.xyz === 'D') continue;
      const trace = buildStageTrace(11, state, DEFAULT_POLICY, null);
      expect(trace.steps[0].detail).toContain(state.forecast.reason);
      expect(trace.steps[0].substitution).toBe(`Model = ${state.forecast.model}`);
    }
  });

  it('cửa chu kỳ ngắn 11XY-SN trong process-panel chỉ xuất hiện cho nhóm X/Y và khớp đúng rpScan/pStar đã khóa', () => {
    for (const state of Object.values(snapshots[11]!.states)) {
      if (!state.forecast) continue;
      const trace = buildStageTrace(11, state, DEFAULT_POLICY, null);
      const gateStep = trace.steps.find(step => step.title.includes('Cửa chu kỳ ngắn 11XY-SN'));
      if (state.classification.xyz === 'X' || state.classification.xyz === 'Y') {
        expect(gateStep, `SKU ${state.definition.id} thuộc nhóm ${state.classification.xyz} phải có bước cửa chu kỳ ngắn`).toBeDefined();
        expect(gateStep!.values).toHaveLength(state.forecast.rpScan!.length);
        if (state.forecast.pStar === null) expect(gateStep!.substitution).toContain('Không có p nào');
        else expect(gateStep!.substitution).toContain(`p* = ${state.forecast.pStar}`);
      } else {
        expect(gateStep, `SKU ${state.definition.id} thuộc nhóm ${state.classification.xyz} không được có bước cửa chu kỳ ngắn`).toBeUndefined();
      }
    }
  });

  it('bước công thức mô hình trong process-panel khớp đúng model đã khóa, không rơi về nhánh mặc định', () => {
    const titleFragment: Record<string, string> = {
      SES: 'San bằng mũ đơn',
      Holt: 'Holt — mức nền',
      'Holt-Winters': 'Holt-Winters nhân tính',
      SeasonalNaive: 'Seasonal-naïve — sao chép',
      Croston: 'Croston bình quân',
      PulseRhythm: 'Mô hình nhịp phát sinh',
    };
    for (const state of Object.values(snapshots[11]!.states)) {
      if (!state.forecast || state.forecast.model === 'PurchasePlan') continue;
      const trace = buildStageTrace(11, state, DEFAULT_POLICY, null);
      const formulaStep = trace.steps.find(step => step.title.includes(titleFragment[state.forecast!.model]));
      expect(formulaStep, `SKU ${state.definition.id} model=${state.forecast.model} phải có bước công thức đúng model`).toBeDefined();
    }
  });

  it('trace chặng 15 khớp safety stock engine', () => {
    const snapshot = snapshots[15]!;
    for (const state of Object.values(snapshot.states)) {
      const trace = buildStageTrace(15, state, DEFAULT_POLICY, null);
      const final = trace.steps.at(-1)!;
      if (state.safetyStock === null) {
        expect(final.tone).toBe('warn');
      } else {
        expect(final.substitution).toContain(`= ${state.safetyStock.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}`);
      }
    }
  });

  it('panel Chặng 14–19 nêu rõ khi một trường dùng giá trị mặc định vì ERP chưa có cột nguồn, và hiển thị đủ các trường mới đã triển khai', () => {
    const firstState = (stage: StageNumber) => Object.values(snapshots[stage]!.states)[0];
    const text = (stage: StageNumber) => {
      const trace = buildStageTrace(stage, firstState(stage), DEFAULT_POLICY, null);
      return trace.steps.flatMap(step => [step.title, step.detail, step.substitution ?? '', ...(step.values ?? []).flatMap(value => [value.label, value.value])]).join(' ');
    };
    // Chặng 14: hàng giữ/hư hỏng/khóa/không bán được nay là trường thật, nhưng ERP chưa có cột nguồn nên vẫn mặc định 0 — panel phải nói rõ điều này, không im lặng suy diễn là đã đủ.
    expect(text(14)).toContain('CHƯA CÓ TRƯỜNG RIÊNG');
    // Chặng 15: mức cần bảo vệ = max(SS, DisplayMin) phải hiển thị rõ cả hai vế.
    expect(text(15)).toContain('DisplayMin');
    // Chặng 16: vùng cần bao phủ (CoverWindow) nay tính theo lead time thật của SKU, không còn cứng toàn bộ tầm dự báo.
    expect(text(16)).toContain('CoverWindow');
    // Chặng 17: giá vốn kế hoạch (landed cost) chưa có cấu hình nguồn nên tạm dùng giá mua và phải cảnh báo là ước tính.
    expect(text(17)).toContain('bucket = CHƯA CẤU HÌNH');
    // Chặng 18: chưa có kênh ghi nhận người dùng tự sửa số đề xuất nên Q_approved_over luôn bằng 0, panel phải nêu rõ lý do thay vì suy diễn là đã kiểm tra đủ.
    expect(text(18)).toContain('Q_approved_over=0');
    // Chặng 19: sai số dự báo NỀN và dự báo CUỐI nay được tách riêng và tính đủ — cả hai nhãn phải xuất hiện.
    expect(text(19)).toContain('WAPE_base');
    expect(text(19)).toContain('WAPE_final');
  });
});
