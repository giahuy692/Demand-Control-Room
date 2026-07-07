import { describe, expect, it } from 'vitest';
import { explainLearningCell, fitBaseForecast } from './forecast-models';
import { detectShortCycle } from './math';

describe('Chặng 11 — mô hình dự báo theo Developer Spec', () => {
  it('SES: chuỗi phẳng cho L = mức nền, sai số TEST = 0 nhưng REVIEW khi P25 chưa được phê duyệt', () => {
    const values = Array(20).fill(50);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SES');
    expect(fit.result.baseForecast).toEqual(Array(6).fill(50));
    expect(fit.result.wape).toBe(0);
    expect(fit.result.lockStatus).toBe('review');
    const rows = fit.learning!.rows;
    expect(rows[0].phase).toBe('init');
    expect(rows[0].level).toBe(50);           // L₁ = Y₁
    expect(rows.at(-1)!.forecast).toBe(50);   // F_t = L_{t−1}
  });

  it('Holt: khởi tạo đúng L₂ = Y₂ và T₂ = Y₂ − Y₁ [C11 §6]', () => {
    const values = Array.from({ length: 20 }, (_, index) => 10 + index * 5);
    const fit = fitBaseForecast(values, 'Y', 'no-clear-season', 'up');
    expect(fit.result.model).toBe('Holt');
    const rows = fit.learning!.rows;
    expect(rows[1].level).toBe(values[1]);
    expect(rows[1].trend).toBe(values[1] - values[0]);
    // Chuỗi tuyến tính hoàn hảo: dự báo one-step phải bám sát thực tế
    expect(fit.result.wape).not.toBeNull();
    expect(fit.result.wape!).toBeLessThan(0.05);
    // Dự phóng bị chặn xu hướng 15%/chu kỳ so với mức nền
    const future = fit.result.baseForecast;
    expect(future[1]).toBeGreaterThan(future[0]);
  });

  it('Holt-Winters: Sᵢ = Yᵢ/mean(mùa 1) và L_{m+1} = Y_{m+1}/S₁ [C11 §7]', () => {
    const season = Array.from({ length: 24 }, (_, position) => 40 + 30 * Math.sin((position / 24) * 2 * Math.PI) + 10);
    const values = [...season, ...season, ...season]; // 72 CK, 3 vòng lặp hoàn hảo
    const fit = fitBaseForecast(values, 'Y', 'confirmed', 'none');
    expect(fit.result.model).toBe('Holt-Winters');
    const rows = fit.learning!.rows;
    const seasonBase = season.reduce((sum, value) => sum + value, 0) / 24;
    expect(rows[0].season).toBeCloseTo(season[0] / seasonBase, 10);
    expect(rows[24].level).toBeCloseTo(values[24] / (season[0] / seasonBase), 10);
    // Mùa vụ lặp hoàn hảo → backtest phải rất sát
    expect(fit.result.wape!).toBeLessThan(0.1);
    expect(fit.result.baseForecast).toHaveLength(6);
  });

  it('Croston: F = null trước lần phát sinh thứ hai; P₁ = t₂ − t₁ [C11 §8.5, T16]', () => {
    const values = [0, 0, 30, 0, 0, 25, 0, 0, 28, 0, 31, 0, 0, 26, 0, 0];
    const fit = fitBaseForecast(values, 'Z', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('Croston');
    const rows = fit.learning!.rows;
    for (let index = 0; index <= 5; index++) expect(rows[index].forecast).toBeNull();
    expect(rows[5].trend).toBe(3); // P₁ = 5 − 2
    expect(rows[6].forecast).not.toBeNull();
    expect(fit.result.baseForecast.every(value => value >= 0)).toBe(true);
  });

  it('PulseRhythm: nhịp 93 mỗi 3 chu kỳ dự báo đúng CK21 = 93, CK19–20 = 0 [T17]', () => {
    const values = Array.from({ length: 18 }, (_, index) => index >= 2 && (index - 2) % 3 === 0 ? 93 : 0);
    const fit = fitBaseForecast(values, 'Z', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('PulseRhythm');
    expect(fit.result.params).toEqual({ D: 3, Q: 93 });
    expect(fit.result.baseForecast).toEqual([0, 0, 93, 0, 0, 93]);
    expect(fit.result.wape).toBe(0); // nhịp hoàn hảo → backtest trúng tuyệt đối
  });

  it('Nhóm D đi luồng kế hoạch Thu mua, không backtest thống kê', () => {
    const fit = fitBaseForecast([0, 0, 0], 'D', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('PurchasePlan');
    expect(fit.result.lockStatus).toBe('exception');
    expect(fit.learning).toBeNull();
  });

  it('Nhóm X có xu hướng: chỉ chọn Holt khi backtest thắng SES [C11 §3]', () => {
    const values = Array.from({ length: 24 }, (_, index) => 100 + index * 8);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(['SES', 'Holt']).toContain(fit.result.model);
    if (fit.result.model === 'Holt') expect(fit.result.reason).toContain('tốt hơn SES');
  });

  it('không bao giờ trả dự báo âm', () => {
    const values = Array.from({ length: 20 }, (_, index) => Math.max(0, 100 - index * 12));
    const fit = fitBaseForecast(values, 'Y', 'no-clear-season', 'down');
    expect(fit.result.baseForecast.every(value => value >= 0)).toBe(true);
  });
});

describe('Chặng 11 — giải thích ô bảng học (explainLearningCell)', () => {
  it('SES: ô L trỏ đúng nguồn Y cùng CK + L chu kỳ trước và thay số tái tạo đúng giá trị', () => {
    const values = [50, 62, 48, 71, 55, 60, 52, 66, 58, 63];
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    const learning = fit.learning!;
    const alpha = learning.params['alpha'];
    const explanation = explainLearningCell(learning, 4, 'level')!;
    expect(explanation.sources).toEqual([
      { index: 4, column: 'actual' },
      { index: 3, column: 'level' },
    ]);
    const row = learning.rows[3];
    const prev = learning.rows[2];
    expect(alpha * row.actual + (1 - alpha) * prev.level!).toBeCloseTo(row.level!, 10);
    const forecastExplanation = explainLearningCell(learning, 4, 'forecast')!;
    expect(forecastExplanation.sources).toEqual([{ index: 3, column: 'level' }]);
    expect(prev.level).toBeCloseTo(row.forecast!, 10);
  });

  it('Holt: F trỏ về L/T chu kỳ trước; T trỏ về L cùng CK + L/T trước; sai số trỏ Y và F cùng CK', () => {
    const values = Array.from({ length: 20 }, (_, index) => 10 + index * 5);
    const fit = fitBaseForecast(values, 'Y', 'no-clear-season', 'up');
    const learning = fit.learning!;
    expect(explainLearningCell(learning, 5, 'forecast')!.sources).toEqual([
      { index: 4, column: 'level' }, { index: 4, column: 'trend' },
    ]);
    expect(explainLearningCell(learning, 5, 'trend')!.sources).toEqual([
      { index: 5, column: 'level' }, { index: 4, column: 'level' }, { index: 4, column: 'trend' },
    ]);
    expect(explainLearningCell(learning, 5, 'error')!.sources).toEqual([
      { index: 5, column: 'actual' }, { index: 5, column: 'forecast' },
    ]);
    const row = learning.rows[4];
    const prev = learning.rows[3];
    expect(prev.level! + prev.trend!).toBeCloseTo(row.forecast!, 10);
  });

  it('Holt-Winters: S dùng tại CK t được cập nhật đúng từ Y/L/S của CK t−24', () => {
    const season = Array.from({ length: 24 }, (_, position) => 40 + 30 * Math.sin((position / 24) * 2 * Math.PI) + 10);
    const values = [...season, ...season, ...season];
    const fit = fitBaseForecast(values, 'Y', 'confirmed', 'none');
    const learning = fit.learning!;
    const gamma = learning.params['gamma'];
    const index = 55; // t − 24 = 31 > m + 1 → nhánh cập nhật γ
    const explanation = explainLearningCell(learning, index, 'season')!;
    expect(explanation.sources).toEqual([
      { index: 31, column: 'actual' }, { index: 31, column: 'level' }, { index: 31, column: 'season' },
    ]);
    const source = learning.rows[30];
    const target = learning.rows[index - 1];
    expect(gamma * (source.actual / source.level!) + (1 - gamma) * source.season!).toBeCloseTo(target.season!, 10);
  });

  it('Croston: F trỏ về Z/P chu kỳ trước và Z/P tái tạo đúng F; ô Y luôn là đầu vào không nguồn', () => {
    const values = [0, 0, 30, 0, 0, 25, 0, 0, 28, 0, 31, 0, 0, 26, 0, 0];
    const fit = fitBaseForecast(values, 'Z', 'not-applicable', 'insufficient');
    const learning = fit.learning!;
    const withForecast = learning.rows.find(row => row.forecast !== null)!;
    const explanation = explainLearningCell(learning, withForecast.index, 'forecast')!;
    expect(explanation.sources).toEqual([
      { index: withForecast.index - 1, column: 'level' }, { index: withForecast.index - 1, column: 'trend' },
    ]);
    const prev = learning.rows[withForecast.index - 2];
    expect(prev.level! / prev.trend!).toBeCloseTo(withForecast.forecast!, 10);
    expect(explainLearningCell(learning, 3, 'actual')!.sources).toEqual([]);
  });
});

describe('Chặng 11 — sai số backtest không phạt oan F = null', () => {
  it('Croston: chu kỳ TEST chưa đủ căn cứ dự báo (F=null) bị loại khỏi WAPE nhưng vẫn đếm missed pulse', () => {
    // n=10 → TEST 2 CK cuối. Lần phát sinh thứ 2 rơi vào TEST (idx 8): F tại đó vẫn null.
    const values = [0, 0, 0, 30, 0, 0, 0, 0, 28, 26];
    const fit = fitBaseForecast(values, 'Z', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('Croston');
    const learning = fit.learning!;
    const rows = learning.rows;
    expect(rows[8].forecast).toBeNull();   // trước lần phát sinh 2 → cấm dự báo
    expect(rows[9].forecast).not.toBeNull();
    // WAPE chỉ đo trên CK 10 (chu kỳ duy nhất có F), không coi F=null là "dự báo 0"
    const expectedWape = Math.abs(rows[9].actual - rows[9].forecast!) / rows[9].actual;
    expect(learning.wape).toBeCloseTo(expectedWape, 10);
    // Nhưng nhu cầu tại CK 9 không có dự báo dương vẫn phải bị đếm là missed pulse
    expect(learning.missedPulses).toBe(1);
  });
});

describe('Chặng 11 — chu kỳ lặp ngắn (SeasonalNaive) [D.4-1]', () => {
  it('chuỗi răng cưa chu kỳ 2 → chọn SeasonalNaive khi thắng SES, F_t = Y_{t−p}', () => {
    const values = [2, 16, 1, 16, 4, 15, 7, 16, 1, 16, 3, 15, 0, 16, 5, 16, 2, 16, 5, 15, 4, 15, 1, 18];
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SeasonalNaive');
    expect(fit.result.params['p']).toBe(2);
    const rows = fit.learning!.rows;
    expect(rows[0].forecast).toBeNull();          // p chu kỳ đầu chưa được dự báo
    expect(rows[1].forecast).toBeNull();
    expect(rows[5].forecast).toBe(values[3]);     // F_t = Y_{t−2}
    // Tương lai tiếp nối đúng nhịp răng cưa, không phải đường phẳng
    expect(fit.result.baseForecast[0]).toBe(values[22]);
    expect(fit.result.baseForecast[1]).toBe(values[23]);
    // Phải thắng mô hình đối chứng trên TEST (điều kiện chọn [C11 §8.10])
    expect(fit.result.reason).toContain('thắng mô hình đối chứng SES');
    expect(fit.result.controlModel).toBe('SES');
    expect(fit.result.pStar).toBe(2);
  });

  it('chuỗi phẳng không có chu kỳ lặp → vẫn SES (SeasonalNaive không được chọn bừa)', () => {
    const values = Array.from({ length: 24 }, (_, index) => 95 + (index % 2 === 0 ? 1 : -1));
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    // dao động ±1 quanh 96: nếu naive thắng SES thì cũng hợp lệ, nhưng chuỗi hằng tuyệt đối phải là SES
    const flat = fitBaseForecast(Array(24).fill(95), 'X', 'not-applicable', 'insufficient');
    expect(flat.result.model).toBe('SES');
    expect(['SES', 'SeasonalNaive']).toContain(fit.result.model);
  });

  it('explainLearningCell: ô F trỏ đúng về ô Y cách p chu kỳ', () => {
    const values = [2, 16, 1, 16, 4, 15, 7, 16, 1, 16, 3, 15, 0, 16, 5, 16, 2, 16, 5, 15, 4, 15, 1, 18];
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    const learning = fit.learning!;
    const p = learning.params['p'];
    const explanation = explainLearningCell(learning, 10, 'forecast')!;
    expect(explanation.sources).toEqual([{ index: 10 - p, column: 'actual' }]);
    expect(learning.rows[9].forecast).toBe(learning.rows[9 - p].actual);
  });
});

// ── Bộ ca kiểm thử tối thiểu Seasonal-naïve trước nghiệm thu [C11 §8.13] ──
describe('Chặng 11 — ca kiểm thử SN-01..SN-10 [C11 §8.13]', () => {
  // Chuỗi ví dụ của tài liệu [C11 §8.1/§8.6]: lặp sau 4 chu kỳ.
  const DOC_SERIES = [100, 20, 25, 30, 105, 22, 24, 31, 98, 21, 26, 29];

  it('SN-01: chuỗi lặp hoàn hảo 100,20,100,20,… → p* = 2 và dự báo tiếp 100,20', () => {
    const values = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? 100 : 20));
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SeasonalNaive');
    expect(fit.result.pStar).toBe(2); // hòa r giữa p=2/4/6… → ưu tiên p nhỏ [C11 §8.8]
    expect(fit.result.baseForecast).toEqual([100, 20, 100, 20, 100, 20]);
    // Chu kỳ nguồn được sao chép [C11 §8.12]: F₊₁ ← CK 23, F₊₂ ← CK 24, rồi lặp lại mẫu.
    expect(fit.result.futureSources).toEqual([23, 24, 23, 24, 23, 24]);
  });

  it('SN-02: công thức Pearson dãy A/B [C11 §8.5] tái tạo đúng r(4) ≈ 0,995 của ví dụ §8.6', () => {
    const detection = detectShortCycle(DOC_SERIES);
    expect(detection.ready).toBe(true);
    expect(detection.period).toBe(4);
    expect(detection.correlation!).toBeCloseTo(0.995, 2);
    const entry4 = detection.scan.find(entry => entry.p === 4)!;
    expect(entry4.status).toBe('candidate');
    // p không đủ 2 vòng dữ liệu bị loại có bằng chứng, không bị bỏ im lặng [C11 §8.8 bước 5].
    expect(detection.scan.find(entry => entry.p === 12)!.status).toBe('insufficient-data');
  });

  it('SN-02 (mức chọn mô hình): chuỗi lặp p = 4 có nhiễu nhẹ → ứng viên p* = 4 và chỉ khóa vì thắng đối chứng', () => {
    // 8 vòng lặp mẫu [100,20,25,30] nhiễu ±2 tất định → n = 32, TEST = 6 ≥ 3.
    const noise = [0, 1, -1, 2, -2, 1, 0, -1];
    const values = Array.from({ length: 32 }, (_, index) => [100, 20, 25, 30][index % 4] + noise[Math.floor(index / 4) % 8]);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SeasonalNaive');
    expect(fit.result.pStar).toBe(4);
    expect(fit.result.controlModel).toBe('SES');
    expect(fit.result.wape!).toBeLessThan(fit.result.controlWape!);
  });

  it('SN-03: chuỗi không có nhịp lặp rõ → không mở Seasonal-naïve, danh sách r(p) vẫn được lưu làm bằng chứng', () => {
    const values = Array(24).fill(60);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SES');
    expect(fit.result.pStar).toBeNull();
    expect(fit.result.rpScan).not.toBeNull();
    expect(fit.result.rpScan!.every(entry => entry.status !== 'candidate')).toBe(true);
  });

  it('SN-04: tập TEST dưới 3 chu kỳ → gắn cờ độ tin cậy thấp, SN không được tự thắng bằng so sánh', () => {
    // n = 10 → TEST = 2 CK. Nhịp p = 2 rất rõ nhưng không đủ điều kiện so mô hình tự động.
    const values = [100, 20, 100, 20, 100, 20, 100, 20, 100, 20];
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.reliability).toBe('low');
    expect(fit.result.model).toBe('SES'); // giữ mô hình đối chứng [C11 §8.10 bước 6, mục 12]
    expect(fit.result.pStar).toBe(2);     // ứng viên vẫn được ghi nhận để kiểm toán
    expect(fit.result.reason).toContain('ĐỘ TIN CẬY THẤP — KHÔNG DÙNG ĐỂ SO MÔ HÌNH TỰ ĐỘNG');
    expect(fit.result.lockStatus).not.toBe('locked');
  });

  it('SN-05: chuỗi chỉ có xu hướng tăng → không chọn chu kỳ giả do xu hướng', () => {
    // Chuỗi trend làm r(p) cao ở mọi p, nhưng SN phải thua Holt/SES trên TEST nên không được chọn [C11 §8.3].
    const values = Array.from({ length: 24 }, (_, index) => 100 + index * 8);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).not.toBe('SeasonalNaive');
  });

  it.skip('SN-06: chuỗi còn cờ CTKM/stockout chưa sạch → chặn mô hình. Ngoài phạm vi mô phỏng: chuỗi vào C11 là chu kỳ locked đã qua Chặng 1–5.', () => {});

  it.skip('SN-07: thiếu chu kỳ trong mẫu cuối → lỗi dữ liệu không liền mạch. Ngoài phạm vi mô phỏng: Chặng 5 bàn giao chuỗi chu kỳ liền mạch, không có khoảng trống.', () => {});

  it('SN-08: Seasonal-naïve không thắng CHẶT mô hình đối chứng (kể cả hòa) → giữ mô hình đang dùng', () => {
    // TRAIN có nhịp p = 2 rõ (r ≥ 0,60) nhưng nhịp tắt ở TEST (đuôi phẳng 20) → SN thua SES
    // trên kiểm tra ngược. So sánh dùng dấu < chặt nên trường hợp hòa cũng giữ đối chứng.
    const train = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 10 : 30));
    const values = [...train, 20, 20, 20, 20];
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.pStar).toBe(2);
    expect(fit.result.model).toBe('SES');
    expect(fit.result.reason).toContain('không thắng');
  });

  it('SN-09: ngưỡng sai số nhóm chưa ban hành → không bao giờ tự khóa, kể cả khi SN thắng rõ', () => {
    const values = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? 100 : 20));
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SeasonalNaive');
    expect(fit.result.lockStatus).toBe('review'); // nguyên tắc P25: không dùng ngưỡng tự đặt để khóa
  });

  it('SN-10: chân trời dự báo 6 > p* = 4 → mẫu p* giá trị cuối được lặp lại đến đủ chân trời', () => {
    const values = Array.from({ length: 32 }, (_, index) => [100, 20, 25, 30][index % 4]);
    const fit = fitBaseForecast(values, 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SeasonalNaive');
    expect(fit.result.pStar).toBe(4);
    const future = fit.result.baseForecast;
    expect(future.slice(0, 4)).toEqual([100, 20, 25, 30]);
    expect(future[4]).toBe(future[0]); // lặp mẫu khi vượt quá p* [C11 §8.9]
    expect(future[5]).toBe(future[1]);
  });
});

// ── Quy tắc thắng mô hình [C11 §4.3 bước 7, §4.5] ──
describe('Chặng 11 — quy tắc thắng và fallback theo §4.3/§4.5', () => {
  it('Y có xu hướng (C10) nhưng Holt không thắng CHẶT SES trên TEST → dùng SES [C11 §4.5]', () => {
    // Chuỗi hằng: Holt và SES đều dự báo đúng tuyệt đối (WAPE = 0) → hòa → giữ mô hình đơn giản hơn.
    const values = Array(24).fill(80);
    const fit = fitBaseForecast(values, 'Y', 'no-clear-season', 'up');
    expect(fit.result.model).toBe('SES');
    expect(fit.result.reason).toContain('không thắng SES');
  });

  it('Y có mùa vụ (C9) nhưng Holt-Winters không thắng Holt/SES → fallback SES [C11 §4.5]', () => {
    // Chuỗi hằng đủ 3 vòng: HW/Holt/SES đều WAPE = 0 → không ai thắng chặt → về SES.
    const values = Array(72).fill(40);
    const fit = fitBaseForecast(values, 'Y', 'confirmed', 'none');
    expect(fit.result.model).toBe('SES');
  });

  it('Y có mùa vụ thật sự lặp hoàn hảo → Holt-Winters vẫn thắng Holt/SES và được chọn [C11 §4.3 bước 7]', () => {
    const season = Array.from({ length: 24 }, (_, position) => 40 + 30 * Math.sin((position / 24) * 2 * Math.PI) + 10);
    const values = [...season, ...season, ...season];
    const fit = fitBaseForecast(values, 'Y', 'confirmed', 'none');
    expect(fit.result.model).toBe('Holt-Winters');
    expect(fit.result.reason).toContain('thắng Holt/SES');
  });

  it('SES: α tối ưu nằm trong miền ràng buộc 0,05 ≤ α ≤ 0,5 [C11 §5.5]', () => {
    // Chuỗi có nhịp trong TRAIN nhưng nhịp tắt ở TEST (như SN-08) → mô hình chốt là SES.
    const train = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? 10 : 30));
    const fit = fitBaseForecast([...train, 20, 20, 20, 20], 'X', 'not-applicable', 'insufficient');
    expect(fit.result.model).toBe('SES');
    expect(fit.result.params['alpha']).toBeGreaterThanOrEqual(0.05);
    expect(fit.result.params['alpha']).toBeLessThanOrEqual(0.5);
  });
});
