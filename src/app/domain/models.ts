export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19;
export type AbcClass = 'A' | 'B' | 'C' | 'N/A';
export type XyzClass = 'X' | 'Y' | 'Z' | 'D';
export type LockStatus = 'locked' | 'review' | 'temporary' | 'exception';
export type BaseSource = 'clean' | 'stockout-lifted' | 'promo-normalized' | 'technical-fill' | 'insufficient' | 'promo-defer';
export type BalanceStatus = 'balanced' | 'temporary' | 'fixed' | 'insufficient' | null;

export interface SimulationPolicy {
  runDate: string;
  historyYears: number;
  cycleLength: number;
  cutoffHour: string;
  referenceRadius: number;
  maxReferenceRadius: number;
  minimumReferences: number;
  maxBalancedPerSide: number;
  version: string;
  periodBudget: number;
}

export interface SkuDefinition {
  id: string;
  name: string;
  type: string;
  price: number;
  cycles: number;
  description: string;
  category: string;
  supplier: string;
  inboundPlan: { offsetDays: number; quantity: number; confirmed: boolean; label: string }[];
  commitments: { offsetDays: number; quantity: number; label: string }[];
  futurePromotions: { cycleOffset: number; promoDays: number; code: string; confirmed: boolean }[];
  leadTimeHistoryDays: number[];
  maxStock: number;
  warehouseCapacity: number;
  shelfLifeDays: number | null;
  purchasePrice: number;
  moq: number;
  purchaseTermsComplete: boolean;
  actualDemand: number[];
  actualEndingStock: number;
  actualReceiptDelayDays: number[];
  actualBudgetUsed: number;
}

export interface DailyRecord {
  sku: string;
  date: string;
  openStock: number;
  closeStock: number;
  sales: number;
  receiptHour: string | null;
  promoCode: string | null;
  isStockout: boolean;
  stockoutReason: 'late-receipt' | 'empty-all-day' | null;
  baseDemand: number | null;
  baseSource: BaseSource | null;
  referenceDates: string[];
  beforeReferenceDates: string[];
  afterReferenceDates: string[];
  referenceMedian: number | null;
  balanceStatus: BalanceStatus;
  selectionReason: string;
}

export interface CycleRecord {
  cycleIndex: number;
  dateStart: string;
  dateEnd: string;
  days: number;
  baseDemand: number;
  locked: boolean;
  emptyCycle: boolean;
  cleanDays: number;
  stockoutLiftedDays: number;
  promoNormalizedDays: number;
  technicalFillDays: number;
  unresolvedDays: number;
  seasonRound: number;
  seasonPosition: number;
}

export interface Classification {
  abc: AbcClass;
  abcStatus: 'full' | 'annualized' | 'not-rated';
  lockedCycles: number;
  periodQuantity: number;
  annualizationFactor: number | null;
  annualQuantity: number | null;
  annualValue: number;
  valueShare: number;
  cumulativeShare: number;
  abcRank: number | null;
  xyz: XyzClass;
  n: number;
  m: number;
  adi: number | null;
  positiveMean: number | null;
  positiveStdev: number | null;
  cv: number | null;
  cv2: number | null;
}

/** Một dòng trong danh sách r(p) đã thử khi dò chu kỳ lặp ngắn [C11 §8.8, §8.12]. */
export interface ShortCycleScanEntry {
  p: number;
  r: number | null;
  status: 'candidate' | 'below-threshold' | 'insufficient-data';
}

export type ForecastModelName = 'SES' | 'Holt' | 'Holt-Winters' | 'SeasonalNaive' | 'Croston' | 'PulseRhythm' | 'PurchasePlan';

export interface ForecastResult {
  model: ForecastModelName;
  params: Record<string, number>;
  baseForecast: number[];
  rmse: number | null;
  nrmse: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  missedPulses: number;
  falsePulses: number;
  wapePositive: number | null;
  lockStatus: LockStatus;
  reason: string;
  /** Danh sách r(p) đã thử ở cửa chu kỳ ngắn 11XY-SN; null nếu SKU không qua cửa này [C11 §8.12]. */
  rpScan: ShortCycleScanEntry[] | null;
  /** Chu kỳ lặp p* đã chọn nếu SeasonalNaive được khóa [C11 §8.8]. */
  pStar: number | null;
  /** Mô hình đối chứng đã so ở kiểm tra ngược và WAPE của nó [C11 §8.10]. */
  controlModel: ForecastModelName | null;
  controlWape: number | null;
  /** 'low' khi tập TEST < 3 chu kỳ: ĐỘ TIN CẬY THẤP — KHÔNG DÙNG ĐỂ SO MÔ HÌNH TỰ ĐỘNG [C11 §8.10]. */
  reliability: 'ok' | 'low';
  /** Chu kỳ nguồn (1-based) được sao chép cho từng F tương lai của SeasonalNaive [C11 §8.12]. */
  futureSources: number[] | null;
}

export interface SupplyMilestone {
  date: string;
  label: string;
  onHand: number;
  confirmedInbound: number;
  committed: number;
  freeStock: number;
}

export interface SafetyStockAuditState {
  z: number;
  serviceLevel: number;
  dBar: number;
  sigmaD: number;
  sigmaDSource: 'backtest' | 'cycle-std';
  sigmaDObservationCount: number;
  ltBarDays: number;
  sigmaLtDays: number;
  ltBarCycles: number;
  sigmaLtCycles: number;
  formula: 'full' | 'policy';
  warnings: string[];
}

export interface OrderPlanState {
  coverageCycles: number;
  demandCover: number;
  freeStock: number;
  rawQuantity: number;
  orderQuantity: number;
  moq: number;
  moqSurplus: number;
  warnings: string[];
}

export interface BudgetAllocationState {
  orderValue: number;
  priorityRank: number | null;
  fundedQuantity: number;
  fundedValue: number;
  cutQuantity: number;
  reason: string;
}

export interface ReleaseDecisionState {
  status: 'not-issued' | 'awaiting-info' | 'awaiting-approval' | 'issued';
  releasedQuantity: number;
  reasons: string[];
}

export interface PostAuditState {
  forecastWape: number | null;
  actualDemand: number;
  stockoutUnits: number;
  endingStock: number;
  averageReceiptDelayDays: number;
  budgetVariance: number;
  primaryCause: string;
  proposal: string;
  proposalStatus: 'future-version' | 'monitor';
}

export interface SkuPipelineState {
  definition: SkuDefinition;
  daily: DailyRecord[];
  cycles: CycleRecord[];
  classification: Classification;
  serviceLevel: number | null;
  capitalPriority: string;
  seasonality: 'confirmed' | 'no-clear-season' | 'insufficient-structure' | 'not-applicable';
  trend: 'up' | 'down' | 'none' | 'insufficient';
  trendRates: [number | null, number | null];
  forecast: ForecastResult | null;
  promoFactor: number | null;
  promoConfidence: 'auto' | 'low' | 'suggest-only' | 'none';
  finalForecast: number[];
  freeStock: number | null;
  supplyMilestones: SupplyMilestone[];
  safetyStock: number | null;
  safetyStockAudit: SafetyStockAuditState | null;
  orderPlan: OrderPlanState | null;
  budgetAllocation: BudgetAllocationState | null;
  releaseDecision: ReleaseDecisionState | null;
  postAudit: PostAuditState | null;
}

export interface StageDefinition {
  number: StageNumber;
  phase: number;
  title: string;
  shortTitle: string;
  goal: string;
  flow: string[];
  formula: string;
  variables: { symbol: string; meaning: string }[];
}

export interface FormulaBlock {
  title: string;
  expression: string;
  source: string;
}

export interface StageSnapshot {
  stage: StageNumber;
  completedAt: string;
  policyVersion: string;
  states: Readonly<Record<string, Readonly<SkuPipelineState>>>;
  summary: Readonly<Record<string, string | number>>;
  audit: readonly string[];
}

export interface StageViewModel {
  definition: StageDefinition;
  hasRun: boolean;
  state: Readonly<SkuPipelineState> | null;
  summary: Readonly<Record<string, string | number>>;
  audit: readonly string[];
  inputs: { label: string; value: string }[];
  calculations: { label: string; value: string }[];
  outputs: { label: string; value: string; tone?: 'good' | 'warn' | 'neutral' }[];
  formulas: FormulaBlock[];
}
