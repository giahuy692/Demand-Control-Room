import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from './policy';
import { SimulationEngine } from './simulation-engine';
import { SkuPipelineState, StageNumber, StageSnapshot } from './models';

/**
 * GOLDEN REGRESSION — Commit 1 (Baseline characterization) của kế hoạch refactor.
 *
 * Chốt lại hành vi hiện tại của pipeline 19 chặng trên dữ liệu giả (seeded, deterministic)
 * TRƯỚC khi di chuyển file/tách stage/đổi kiến trúc. Mọi diff snapshot sau này phải được
 * giải thích là "chủ đích đổi nghiệp vụ" hoặc coi là regression — không được cập nhật
 * snapshot mà không đối chiếu (Nguyên tắc §11 Commit 1 / §12.36 của handoff).
 *
 * 3 SKU đại diện: SKU-001 (AX ổn định), SKU-002 (AY mùa vụ), SKU-003 (AZ thưa/Croston).
 * SKU-002 cũng là SKU có CTKM dày qua mock promo tháng 3/6/9/12 (§12.38).
 */

const GOLDEN_SKUS = ['SKU-001', 'SKU-002', 'SKU-003'] as const;
const ALL_STAGES = Array.from({ length: 19 }, (_, index) => (index + 1) as StageNumber);

function runAllStages(): ReadonlyMap<StageNumber, StageSnapshot> {
  const engine = new SimulationEngine();
  const snapshots = new Map<StageNumber, StageSnapshot>();
  let previous: StageSnapshot | null = null;
  for (const stage of ALL_STAGES) {
    previous = engine.run(stage, previous, DEFAULT_POLICY);
    snapshots.set(stage, previous);
  }
  return snapshots;
}

function countBy(values: readonly (string | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? '(null)';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sumBaseDemand(state: SkuPipelineState): number {
  return state.daily.reduce((sum, row) => sum + (row.baseDemand ?? 0), 0);
}

/** Chuỗi chu kỳ nén — đủ nhạy để bắt đổi khóa/lấp/nền, đủ gọn để đọc diff. */
function cycleSeries(state: SkuPipelineState): string[] {
  return state.cycles.map(cycle =>
    `#${cycle.cycleIndex} ${cycle.status}${cycle.locked ? ' L' : ''}${cycle.tier2Filled ? ' T2' : ''}` +
    ` B=${cycle.baseDemand} clean=${cycle.cleanDays} lift=${cycle.stockoutLiftedDays}` +
    ` promo=${cycle.promoNormalizedDays} fill=${cycle.technicalFillDays} fb=${cycle.fallbackDays}` +
    ` unres=${cycle.unresolvedDays} src=${cycle.sourceRecordDays} season=${cycle.seasonRound}/${cycle.seasonPosition}`,
  );
}

/** Đầu ra mà TỪNG chặng ghi vào state — fingerprint theo chặng để khoanh vùng regression. */
function stageFingerprint(stage: StageNumber, state: SkuPipelineState): unknown {
  switch (stage) {
    case 1: return {
      days: state.daily.length,
      referenceOnlyDays: state.referenceOnlyDaily.length,
      cycles: state.cycles.length,
      firstDate: state.daily[0]?.date ?? null,
      lastDate: state.daily.at(-1)?.date ?? null,
    };
    case 2: return {
      stockouts: state.daily.filter(row => row.isStockout).length,
      stockoutReasons: countBy(state.daily.filter(row => row.isStockout).map(row => row.stockoutReason)),
      reviewRequired: state.daily.filter(row => row.stockoutReviewRequired).length,
    };
    case 3:
    case 4: return {
      baseSources: countBy(state.daily.map(row => row.baseSource)),
      baseDemandSum: sumBaseDemand(state),
    };
    case 5: return { cycles: cycleSeries(state) };
    case 6: return {
      abc: state.classification.abc,
      abcOfficial: state.classification.abcOfficial,
      abcStatus: state.classification.abcStatus,
      abcRank: state.classification.abcRank,
      lockedCycles: state.classification.lockedCycles,
      periodQuantity: state.classification.periodQuantity,
      annualizationFactor: state.classification.annualizationFactor,
      annualQuantity: state.classification.annualQuantity,
      annualValue: state.classification.annualValue,
      valueShare: state.classification.valueShare,
      cumulativeShare: state.classification.cumulativeShare,
    };
    case 7: return {
      xyz: state.classification.xyz,
      dSubtype: state.classification.dSubtype,
      classificationStatus: state.classification.classificationStatus,
      classificationBlockReason: state.classification.classificationBlockReason,
      n: state.classification.n,
      m: state.classification.m,
      adi: state.classification.adi,
      cv2: state.classification.cv2,
    };
    case 8: return { serviceLevel: state.serviceLevel, capitalPriority: state.capitalPriority };
    case 9: return { seasonality: state.seasonality };
    case 10: return { trend: state.trend, trendRates: state.trendRates };
    case 11: return state.forecast;
    case 12: return { promoFactor: state.promoFactor, promoConfidence: state.promoConfidence };
    case 13: return { finalForecast: state.finalForecast, finalForecastStatus: state.finalForecastStatus };
    case 14: return {
      freeStock: state.freeStock,
      supplyMilestones: state.supplyMilestones,
      availableStockAudit: state.availableStockAudit,
      excludedLots: state.excludedLots,
      supplyStatus: state.supplyStatus,
    };
    case 15: return { safetyStock: state.safetyStock, safetyStockAudit: state.safetyStockAudit };
    case 16: return state.orderPlan;
    case 17: return state.budgetAllocation;
    case 18: return state.releaseDecision;
    case 19: return state.postAudit;
  }
}

describe('Golden regression — baseline 19 chặng trước refactor (mock, deterministic)', () => {
  const snapshots = runAllStages();

  it('summary toàn danh mục của từng chặng khớp baseline', () => {
    const summaries: Record<string, Record<string, unknown>> = {};
    for (const stage of ALL_STAGES) summaries[`Chặng ${String(stage).padStart(2, '0')}`] = snapshots.get(stage)!.summary;
    expect(summaries).toMatchSnapshot();
  });

  for (const sku of GOLDEN_SKUS) {
    it(`fingerprint 19 chặng của ${sku} khớp baseline`, () => {
      const fingerprints: Record<string, unknown> = {};
      for (const stage of ALL_STAGES) {
        const state = snapshots.get(stage)!.states[sku];
        expect(state, `${sku} phải tồn tại ở Chặng ${stage}`).toBeDefined();
        fingerprints[`Chặng ${String(stage).padStart(2, '0')}`] = stageFingerprint(stage, state);
      }
      expect(fingerprints).toMatchSnapshot();
    });
  }

  it('phân loại + phát hành của TOÀN danh mục mock khớp baseline', () => {
    const stage8 = snapshots.get(8)!;
    const stage18 = snapshots.get(18)!;
    const table = Object.keys(stage8.states).sort().map(sku => {
      const { classification, serviceLevel } = stage8.states[sku];
      const release = stage18.states[sku].releaseDecision;
      return `${sku} ${classification.abc}/${classification.xyz ?? classification.classificationStatus}` +
        `${classification.dSubtype ? `(${classification.dSubtype})` : ''} SL=${serviceLevel ?? '—'} release=${release?.status ?? '—'}`;
    });
    expect(table).toMatchSnapshot();
  });
});
