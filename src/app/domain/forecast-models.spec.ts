import { describe, expect, it } from 'vitest';
import { fitBaseForecast } from './forecast-models';

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
