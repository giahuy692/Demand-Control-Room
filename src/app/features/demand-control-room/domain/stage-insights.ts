import { buildForecastLearning, ForecastFit } from './forecast-models';
import { mean, meetsSeasonRepeatThreshold, trailingLockedRun } from './math';
import { SafetyStockMethod, SafetyStockSourceTier, SimulationPolicy, SkuPipelineState } from './models';
import { DEFAULT_POLICY } from './policy';
import { buildPromoRegionSamples } from './promo-analysis';

/**
 * View-model cho panel trái (AUDIT EXPLORER) — mỗi chặng 5–19 một khối dữ liệu trọng tâm
 * theo Developer Spec §5. Các builder chỉ ĐỌC lại kết quả engine đã khóa trong snapshot
 * (hoặc gọi chung một hàm thuần với engine) để số hiển thị không bao giờ lệch số đã tính.
 */

type States = Readonly<Record<string, Readonly<SkuPipelineState>>>;

// ── Chặng 6 · bảng xếp hạng ABC toàn danh mục ──
export interface AbcBoardRow {
  id: string; name: string; lockedCycles: number;
  annualQuantity: number | null; annualValue: number;
  valueShare: number; cumulativeShare: number; rank: number | null;
  abc: SkuPipelineState['classification']['abc'];
  abcStatus: SkuPipelineState['classification']['abcStatus'];
}

export function buildAbcBoard(states: States): AbcBoardRow[] {
  return Object.values(states)
    .map(state => ({
      id: state.definition.id, name: state.definition.name,
      lockedCycles: state.classification.lockedCycles,
      annualQuantity: state.classification.annualQuantity,
      annualValue: state.classification.annualValue,
      valueShare: state.classification.valueShare,
      cumulativeShare: state.classification.cumulativeShare,
      rank: state.classification.abcRank,
      abc: state.classification.abc, abcStatus: state.classification.abcStatus,
    }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
}

// ── Chặng 7 · bảng XYZ/D với ADI, CV² và điều kiện từng nhóm ──
export interface XyzBoardRow {
  id: string; name: string; xyz: SkuPipelineState['classification']['xyz'];
  n: number; m: number; adi: number | null; positiveMean: number | null;
  positiveStdev: number | null; cv: number | null; cv2: number | null;
  rule: string;
}

const XYZ_ORDER: Record<string, number> = { X: 0, Y: 1, Z: 2, D: 3, BLOCKED: 4 };

export function buildXyzBoard(states: States, policy: SimulationPolicy = DEFAULT_POLICY): XyzBoardRow[] {
  return Object.values(states)
    .map(state => {
      const { xyz, n, m, adi, positiveMean, positiveStdev, cv, cv2, classificationStatus, classificationBlockReason } = state.classification;
      // RULE-07-003/004 — kể từ khi xyz có thể null, đọc lý do trực tiếp từ classificationStatus
      // trước tiên (n=6/m=0 không còn tự động nghĩa là D nữa).
      const rule = classificationStatus === 'CLASSIFICATION_BLOCKED' ? `CHẶN (${classificationBlockReason})`
        : classificationStatus === 'NO_POSITIVE_DEMAND_REVIEW' ? 'NO_POSITIVE_DEMAND_REVIEW (m = 0)'
        : n < 6 ? 'n < 6'
        : (adi ?? 0) > policy.xyzThresholds.zMinAdi ? `ADI > ${policy.xyzThresholds.zMinAdi}`
        : (cv2 ?? Infinity) <= policy.xyzThresholds.xMaxCv2 ? `CV² ≤ ${policy.xyzThresholds.xMaxCv2}` : `CV² > ${policy.xyzThresholds.xMaxCv2}`;
      return { id: state.definition.id, name: state.definition.name, xyz, n, m, adi, positiveMean, positiveStdev, cv, cv2, rule };
    })
    .sort((a, b) => XYZ_ORDER[a.xyz ?? 'BLOCKED'] - XYZ_ORDER[b.xyz ?? 'BLOCKED'] || (a.adi ?? 99) - (b.adi ?? 99) || a.id.localeCompare(b.id));
}

// ── Chặng 8 · ma trận 9 ô ABC×XYZ với mức phục vụ ──
export interface MatrixCell {
  cell: string; serviceLevel: number | null; capitalPriority: string; count: number; hasSelected: boolean;
}
export interface PolicyMatrix {
  rows: { abc: 'A' | 'B' | 'C'; cells: MatrixCell[] }[];
  exceptions: { count: number; hasSelected: boolean };
  totalInMatrix: number;
}

export function buildPolicyMatrix(states: States, selectedId: string, policy: SimulationPolicy = DEFAULT_POLICY): PolicyMatrix {
  const counts = new Map<string, number>();
  let exceptions = 0;
  let selectedCell = '';
  for (const state of Object.values(states)) {
    const { abc, xyz } = state.classification;
    const excluded = xyz === null || xyz === 'D' || abc === 'N/A';
    const cell = excluded ? 'D' : `${abc}${xyz}`;
    if (excluded) exceptions++;
    else counts.set(cell, (counts.get(cell) ?? 0) + 1);
    if (state.definition.id === selectedId) selectedCell = cell;
  }
  const rows = (['A', 'B', 'C'] as const).map(abc => ({
    abc,
    cells: (['X', 'Y', 'Z'] as const).map(xyz => {
      const cell = `${abc}${xyz}`;
      return { cell, serviceLevel: policy.serviceLevels[cell] ?? null, capitalPriority: policy.capitalPriorities[cell] ?? 'Cần duyệt', count: counts.get(cell) ?? 0, hasSelected: selectedCell === cell };
    }),
  }));
  return { rows, exceptions: { count: exceptions, hasSelected: selectedCell === 'D' }, totalInMatrix: [...counts.values()].reduce((sum, count) => sum + count, 0) };
}

// ── Chặng 9 · bảng 24 vị trí × vòng dạng sứcMua / tỷLệ [Spec §5.4] ──
export interface SeasonPositionRow {
  position: number;
  perRound: { value: number; ratio: number; tone: 'high' | 'low' | 'neutral' }[];
  sp: number; highRepeat: number; lowRepeat: number;
  verdict: 'LẶP CAO' | 'LẶP THẤP' | '—';
}
export interface SeasonalityAudit {
  status: SkuPipelineState['seasonality'];
  reason: string;
  roundCount: number;
  roundMeans: number[];
  rows: SeasonPositionRow[];
}

export function buildSeasonalityAudit(state: Readonly<SkuPipelineState>): SeasonalityAudit {
  if (state.classification.xyz !== 'Y') {
    return { status: state.seasonality, reason: `SKU thuộc nhóm ${state.classification.xyz ?? 'BLOCKED'}, không phải Y — chỉ nhóm Y (dao động) mới kiểm tra mùa vụ.`, roundCount: 0, roundMeans: [], rows: [] };
  }
  const values = trailingLockedRun(state.cycles).map(cycle => cycle.baseDemand);
  if (values.length < 48) {
    return { status: state.seasonality, reason: `Chỉ có ${values.length}/48 chu kỳ khóa — cần tối thiểu 2 vòng mùa vụ đầy đủ (P20) mới kết luận.`, roundCount: 0, roundMeans: [], rows: [] };
  }
  // Giống hệt engine runStage9: cắt vòng 24 từ đầu chuỗi khóa, ngưỡng kép ±15% và tỷ lệ lặp ≥ 67%.
  const rounds = Array.from({ length: Math.floor(values.length / 24) }, (_, round) => values.slice(round * 24, round * 24 + 24));
  const roundMeans = rounds.map(round => mean(round));
  const rows = Array.from({ length: 24 }, (_, position) => {
    const perRound = rounds.map((round, index) => {
      const ratio = roundMeans[index] ? round[position] / roundMeans[index] : 1;
      return { value: round[position], ratio, tone: ratio >= 1.15 ? 'high' as const : ratio <= 0.85 ? 'low' as const : 'neutral' as const };
    });
    const ratios = perRound.map(item => item.ratio);
    const sp = mean(ratios);
    const highRepeat = ratios.filter(value => value >= 1.15).length / ratios.length;
    const lowRepeat = ratios.filter(value => value <= 0.85).length / ratios.length;
    const verdict = sp >= 1.15 && meetsSeasonRepeatThreshold(highRepeat) ? 'LẶP CAO' as const : sp <= 0.85 && meetsSeasonRepeatThreshold(lowRepeat) ? 'LẶP THẤP' as const : '—' as const;
    return { position: position + 1, perRound, sp, highRepeat, lowRepeat, verdict };
  });
  const flagged = rows.filter(row => row.verdict !== '—').length;
  return {
    status: state.seasonality,
    reason: flagged
      ? `${flagged} vị trí đạt đồng thời ngưỡng hệ số (±15%) và tỷ lệ lặp ≥ 67% → mùa vụ được xác nhận.`
      : 'Không vị trí nào đạt đồng thời hai ngưỡng → không có mùa vụ rõ, chuyển Chặng 10.',
    roundCount: rounds.length, roundMeans, rows,
  };
}

// ── Chặng 10 · 12 chu kỳ cuối, 3 đoạn × 4, g₁/g₂ ──
export interface TrendAudit {
  applicable: boolean;
  reason: string;
  status: SkuPipelineState['trend'];
  segments: { label: string; values: number[]; mean: number }[];
  bars: { value: number; segment: number; heightPct: number }[];
  g1: number | null; g2: number | null;
}

export function buildTrendAudit(state: Readonly<SkuPipelineState>): TrendAudit {
  const base = { status: state.trend, segments: [], bars: [], g1: state.trendRates[0], g2: state.trendRates[1] };
  if (state.classification.xyz !== 'Y') {
    const handoff = state.classification.xyz === 'X'
      ? ' Với nhóm X, Chặng 11 sẽ tự kiểm tra xu hướng bằng đúng thuật toán này (12 CK / 3 đoạn / ±5%) và chỉ chọn Holt nếu backtest thắng SES [C11 §3].'
      : '';
    return { ...base, applicable: false, reason: `SKU thuộc nhóm ${state.classification.xyz ?? 'BLOCKED'} — công tắc xu hướng của Chặng 10 chỉ dành cho nhóm Y chưa có mùa vụ.${handoff}` };
  }
  if (state.seasonality === 'confirmed') {
    return { ...base, applicable: false, reason: 'Đã xác nhận mùa vụ ở Chặng 9 → Chặng 11 ưu tiên Holt-Winters (chỉ khóa khi thắng Holt/SES trên backtest [C11 §4.3]), không xét xu hướng.' };
  }
  const values = trailingLockedRun(state.cycles).slice(-24).map(cycle => cycle.baseDemand);
  if (values.length < 12) {
    return { ...base, applicable: false, reason: `Chỉ có ${values.length}/12 chu kỳ khóa gần nhất — không đủ chia 3 đoạn × 4.` };
  }
  const recent = values.slice(-12);
  const max = Math.max(...recent, 1);
  const segments = [0, 1, 2].map(segment => {
    const segmentValues = recent.slice(segment * 4, segment * 4 + 4);
    return { label: `Ȳ${segment + 1}`, values: segmentValues, mean: mean(segmentValues) };
  });
  const bars = recent.map((value, index) => ({ value, segment: Math.floor(index / 4), heightPct: Math.max(6, Math.round(value / max * 100)) }));
  return { ...base, applicable: true, reason: '', segments, bars };
}

// ── Chặng 11 · diễn biến mô hình học từng chu kỳ (gọi chung hàm với engine) ──
export function buildForecastAudit(state: Readonly<SkuPipelineState>): ForecastFit {
  return buildForecastLearning(state);
}

// ── Chặng 12 · bảng mẫu K từng ngày KM hợp lệ ──
export interface PromoAudit {
  rows: { date: string; dateRange: string; code: string; name: string | null; days: number; sales: number; base: number; k: number }[];
  totalPromoDays: number;
  totalRegions: number;
  rejected: number;
  rawMedian: number | null;
  factor: number | null;
  confidence: SkuPipelineState['promoConfidence'];
}

export function buildPromoAudit(state: Readonly<SkuPipelineState>): PromoAudit {
  const promoDays = state.daily.filter(record => record.promoCode);
  const regions = buildPromoRegionSamples(state.daily);
  const eligible = regions.filter(region => region.eligible);
  const rows = eligible.map(region => ({
    date: region.startDate,
    dateRange: region.startDate === region.endDate ? region.startDate : `${region.startDate} → ${region.endDate}`,
    code: region.codes.join('+'),
    // UI chỉ binding TÊN CTKM — lấy tên chương trình chính đầu tiên có trong vùng.
    name: region.rows.map(row => row.promotionName?.trim()).find(Boolean) ?? null,
    days: region.rows.length, sales: region.actualSales, base: region.naturalBase,
    k: region.factor!,
  }));
  const sorted = rows.map(row => row.k).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const rawMedian = sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null;
  return { rows, totalPromoDays: promoDays.length, totalRegions: regions.length, rejected: regions.length - eligible.length, rawMedian, factor: state.promoFactor, confidence: state.promoConfidence };
}

// ── Chặng 13 · bảng áp CTKM từng chu kỳ tương lai ──
export interface FinalForecastAudit {
  rows: { index: number; base: number; promoDays: number; factor: number; final: number }[];
  appliedFactor: number;
  confidence: SkuPipelineState['promoConfidence'];
}

export function buildFinalForecastAudit(state: Readonly<SkuPipelineState>): FinalForecastAudit {
  const base = state.forecast?.baseForecast ?? [];
  const appliedFactor = state.promoConfidence === 'auto' ? state.promoFactor ?? 1 : 1;
  const rows = base.map((value, index) => {
    const plan = state.definition.futurePromotions.find(item => item.confirmed && item.cycleOffset === index + 1);
    const promoDays = plan?.promoDays ?? 0;
    return { index: index + 1, base: value, promoDays, factor: promoDays ? appliedFactor : 1, final: state.finalForecast[index] ?? value };
  });
  return { rows, appliedFactor, confidence: state.promoConfidence };
}

// ── Chặng 14 · vị thế tồn tại mốc bảo vệ ──
export interface SupplyAudit {
  supplier: string;
  milestones: SkuPipelineState['supplyMilestones'];
  excludedInbound: { offsetDays: number; quantity: number; label: string }[];
  freeStock: number | null;
  /** Chặng 14 §8/§12 — lô bị loại kèm lý do (thay cho chỉ đếm số lượng). */
  excludedLots: SkuPipelineState['excludedLots'];
  /** Chặng 14 §5.1 — tồn có thể sử dụng ngay, đã trừ hàng giữ/hư hỏng/khóa/không bán được. */
  availableStockAudit: SkuPipelineState['availableStockAudit'];
  /** Chặng 14 §4.1/§10 — trạng thái chờ kiểm tra nguồn hàng (trùng lô, dữ liệu tồn không khớp). */
  supplyStatus: SkuPipelineState['supplyStatus'];
}

export function buildSupplyAudit(state: Readonly<SkuPipelineState>): SupplyAudit {
  return {
    supplier: state.definition.supplier,
    milestones: state.supplyMilestones,
    excludedInbound: state.definition.inboundPlan.filter(item => !item.confirmed),
    freeStock: state.freeStock,
    excludedLots: state.excludedLots,
    availableStockAudit: state.availableStockAudit,
    supplyStatus: state.supplyStatus,
  };
}

// ── Chặng 15 · bảng thế số tồn an toàn ──
export interface SafetyAudit {
  applicable: boolean;
  reason: string;
  serviceLevel: number | null;
  z: number;
  dBar: number;
  sigmaD: number;
  sigmaDSource: 'backtest' | 'cycle-std';
  sigmaDObservationCount: number;
  ltBarCycles: number;
  sigmaLtCycles: number;
  demandTerm: number;
  leadTerm: number;
  safetyStock: number | null;
  warnings: string[];
  formula: 'full' | 'policy';
  /** Chặng 15 §5/§6 — phương pháp và nguồn mẫu thật sự đã dùng. */
  method: SafetyStockMethod;
  sourceTier: SafetyStockSourceTier;
  /** Chặng 15 §7/§8 — mức cần bảo vệ và phần không thể đáp ứng. */
  protection: number;
  unmetProtection: number;
  serviceLevelSearch: { candidate: number; passed: boolean; failedConditions: string[] }[];
}

export function buildSafetyAudit(state: Readonly<SkuPipelineState>): SafetyAudit {
  const locked = state.safetyStockAudit;
  if (!locked || locked.formula === 'policy') {
    return {
      applicable: false,
      reason: locked?.warnings.join(' ') || 'Chưa có kết quả Chặng 15.',
      serviceLevel: state.serviceLevel, z: locked?.z ?? 0, dBar: locked?.dBar ?? 0, sigmaD: locked?.sigmaD ?? 0,
      sigmaDSource: locked?.sigmaDSource ?? 'cycle-std', sigmaDObservationCount: locked?.sigmaDObservationCount ?? 0,
      ltBarCycles: locked?.ltBarCycles ?? 0, sigmaLtCycles: locked?.sigmaLtCycles ?? 0,
      demandTerm: 0, leadTerm: 0, safetyStock: state.safetyStock, warnings: locked?.warnings ?? [], formula: 'policy',
      method: locked?.method ?? 'policy-buffer', sourceTier: locked?.sourceTier ?? 'policy-fallback',
      protection: locked?.protection ?? 0, unmetProtection: locked?.unmetProtection ?? 0, serviceLevelSearch: locked?.serviceLevelSearch ?? [],
    };
  }
  return {
    applicable: true, reason: '', serviceLevel: state.serviceLevel, z: locked.z,
    dBar: locked.dBar, sigmaD: locked.sigmaD, sigmaDSource: locked.sigmaDSource,
    sigmaDObservationCount: locked.sigmaDObservationCount, ltBarCycles: locked.ltBarCycles, sigmaLtCycles: locked.sigmaLtCycles,
    demandTerm: locked.ltBarCycles * locked.sigmaD ** 2,
    leadTerm: locked.dBar ** 2 * locked.sigmaLtCycles ** 2,
    safetyStock: state.safetyStock, warnings: locked.warnings, formula: locked.formula,
    method: locked.method, sourceTier: locked.sourceTier,
    protection: locked.protection, unmetProtection: locked.unmetProtection, serviceLevelSearch: locked.serviceLevelSearch,
  };
}
