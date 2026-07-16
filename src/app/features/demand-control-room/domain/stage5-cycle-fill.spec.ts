import { describe, expect, it } from 'vitest';
import { buildCycles } from './simulation-engine';
import { DailyRecord } from './models';

// baseSource='stockout-lifted' cho ngày "có nền" (không dùng 'clean') để KHÔNG thể bị Tầng 1
// (selectReferences tìm ngày sạch lân cận) mượn làm tham chiếu lấp — cô lập đúng hành vi Tầng 2.
function dailyRecord(index: number, baseDemand: number | null, baseSource: DailyRecord['baseSource']): DailyRecord {
  return {
    sku: 'TEST', date: `2026-01-${String(index + 1).padStart(2, '0')}`, openStock: 10, closeStock: 9, sales: baseDemand ?? 5,
    salesStatus: 'OBSERVED', isReferenceOnly: false, stockSource: 'OBSERVED', stockCalculationStatus: 'CALCULATED',
    hasRecord: true, receiptHour: null, promoCode: null, isStockout: false, stockoutReviewRequired: false, stockoutReason: null,
    baseDemand, baseSource, referenceDates: [], beforeReferenceDates: [], afterReferenceDates: [], referenceMedian: null,
    balanceStatus: null, selectionReason: '',
  };
}

describe('RULE-05-003 Tầng 2 (mức đại diện chu kỳ) — TẮT theo mặc định (DEC-P03/P04/P05 chưa duyệt)', () => {
  it('enableTier2CycleFallback=false (mặc định): 14/15 ngày nền KHÔNG được tự lấp, chu kỳ vẫn chưa khóa', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, index === 5 ? null : 10, index === 5 ? 'insufficient' : 'stockout-lifted'));
    const cycle = buildCycles(records, 15, 3, 7)[0];

    expect(cycle.locked).toBe(false);
    expect(cycle.tier2Filled).toBe(false);
  });
});

describe('RULE-05-003 Tầng 2 khi BẬT (backtest/duyệt) — ngưỡng 12-14/8-11/1-7/0', () => {
  it('GT-18: 14/15 ngày nền → lấp 1 ngày bằng median snapshot, khóa, LOCKED_ADJUSTED', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, index === 5 ? null : 10, index === 5 ? 'insufficient' : 'stockout-lifted'));
    const cycle = buildCycles(records, 15, 3, 7, true)[0];

    expect(cycle.tier2Filled).toBe(true);
    expect(cycle.locked).toBe(true);
    expect(cycle.baseDemand).toBe(150); // 14×10 + median(10)=10
    expect(cycle.status).toBe('LOCKED_ADJUSTED');
  });

  it('GT-19: 8/15 ngày nền trải đủ 3 đoạn đầu-giữa-cuối → được lấp theo cấu hình', () => {
    const validIndexes = new Set([0, 1, 5, 6, 7, 10, 11, 12]);
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, validIndexes.has(index) ? 20 : null, validIndexes.has(index) ? 'stockout-lifted' : 'insufficient'));
    const cycle = buildCycles(records, 15, 3, 7, true)[0];

    expect(cycle.tier2Filled).toBe(true);
    expect(cycle.locked).toBe(true);
  });

  it('8-11 ngày nền nhưng dồn hết vào một đoạn (không trải đủ 2/3) → KHÔNG lấp, chu kỳ chưa khóa', () => {
    // cycleLength=30, đoạn = 10 ngày/đoạn: dồn cả 8 ngày nền vào đúng đoạn đầu tiên.
    const validIndexes = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    const records = Array.from({ length: 30 }, (_, index) => dailyRecord(index, validIndexes.has(index) ? 20 : null, validIndexes.has(index) ? 'stockout-lifted' : 'insufficient'));
    const cycle = buildCycles(records, 30, 3, 7, true)[0];

    expect(cycle.tier2Filled).toBe(false);
    expect(cycle.locked).toBe(false);
  });

  it('GT-20: 1/15 ngày nền → KHÔNG được nhân 1 ngày cho cả chu kỳ, chu kỳ chưa khóa', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, index === 0 ? 50 : null, index === 0 ? 'stockout-lifted' : 'insufficient'));
    const cycle = buildCycles(records, 15, 3, 7, true)[0];

    expect(cycle.tier2Filled).toBe(false);
    expect(cycle.locked).toBe(false);
    expect(cycle.unresolvedDays).toBe(14);
  });

  it('có bản ghi nguồn nhưng 0/15 ngày có nền → không lấp toàn bộ chu kỳ dù bật Tầng 2, giữ BASELINE_UNRESOLVED', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, null, 'insufficient'));
    const cycle = buildCycles(records, 15, 3, 7, true)[0];

    expect(cycle.tier2Filled).toBe(false);
    expect(cycle.emptyCycle).toBe(true);
    expect(cycle.status).toBe('BASELINE_UNRESOLVED');
  });
});

describe('RULE-05-002 — ngày vừa lấp kỹ thuật (technical-fill) KHÔNG được dùng làm tham chiếu cho ngày khác', () => {
  it('ngày chỉ còn láng giềng technical-fill trong bán kính hiệu lực, cụm sạch gốc đã ngoài tầm → vẫn insufficient, không lan truyền lấp dây chuyền', () => {
    // Bố cục 12 ngày, bán kính hiệu lực=7 (radii=[7,14,7] — tầng cuối luôn recompute lại đúng
    // maxRadius truyền vào nên bán kính THẬT SỰ đạt được là 7, không phải 14):
    // - index0-2: cụm sạch gốc (3 ngày).
    // - index3-7 (5 ngày): còn đủ khoảng cách (≤7) tới CẢ 3 ngày cụm gốc → được lấp kỹ thuật.
    // - index8: khoảng cách tới index0 là 8 (>7) nên cụm gốc chỉ còn thấy được 2/3 ngày (index1,2)
    //   — KHÔNG đủ minimumReferences=3 nếu láng giềng technical-fill (index3-7, đều trong bán kính 7
    //   của index8) bị loại đúng luật. Nếu RULE-05-002 bị vi phạm (technical-fill bị tính là "sạch"),
    //   index8 sẽ có ≥3 láng giềng hợp lệ (2 sạch gốc + 5 technical-fill) và bị lấp sai.
    // - index9-11: không có láng giềng sạch nào trong tầm ở phía sau, giữ insufficient.
    const records = Array.from({ length: 12 }, (_, index) => {
      if (index <= 2) return dailyRecord(index, 100, 'clean');
      return dailyRecord(index, null, 'insufficient');
    });
    const cycle = buildCycles(records, 12, 3, 7)[0];

    expect(cycle.cleanDays).toBe(3);
    // index3-7 (5 ngày) lấp được trực tiếp từ cụm sạch gốc.
    expect(cycle.technicalFillDays).toBe(5);
    // index8-11 (4 ngày) KHÔNG được lấp: index8 chỉ còn đủ 2/3 ngày sạch gốc trong bán kính hiệu
    // lực — nếu tính thêm láng giềng technical-fill (sai luật) sẽ đủ 3 và bị lấp; đúng luật thì
    // không đủ nên vẫn insufficient. index9-11 không còn ngày sạch nào trong tầm.
    expect(cycle.unresolvedDays).toBe(4);
    expect(cycle.locked).toBe(false);
  });
});

describe('RULE-05-001 — sourceRecordDays, không dùng unresolvedDays=15 để kết luận "trống"', () => {
  it('sourceRecordDays=0 (không hasRecord ngày nào) → NO_SOURCE_RECORD', () => {
    const records = Array.from({ length: 15 }, (_, index) => ({ ...dailyRecord(index, null, null), hasRecord: false }));
    const cycle = buildCycles(records, 15, 3, 7)[0];

    expect(cycle.sourceRecordDays).toBe(0);
    expect(cycle.status).toBe('NO_SOURCE_RECORD');
  });

  it('có bản ghi nguồn nhưng không đủ căn cứ nền (unresolvedDays=15) → BASELINE_UNRESOLVED, không phải NO_SOURCE_RECORD', () => {
    const records = Array.from({ length: 15 }, (_, index) => dailyRecord(index, null, 'insufficient'));
    const cycle = buildCycles(records, 15, 3, 7)[0];

    expect(cycle.sourceRecordDays).toBe(15);
    expect(cycle.status).toBe('BASELINE_UNRESOLVED');
    expect(cycle.status).not.toBe('NO_SOURCE_RECORD');
  });
});
