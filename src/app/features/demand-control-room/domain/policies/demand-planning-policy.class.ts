import { SimulationPolicy } from '../models';

interface PolicyMetadata {
  readonly runDate: string;
  readonly historyYears: number;
  readonly cycleLengthDays: number;
  readonly policyOverrides: Readonly<Record<string, unknown>>;
}

const OVERRIDABLE_KEYS = new Set<keyof SimulationPolicy>([
  'cutoffHour', 'referenceRadius', 'referenceRadiusExtended', 'maxReferenceRadius',
  'minimumReferences', 'maxBalancedPerSide', 'abcThresholds', 'xyzThresholds',
  'abcWindowCycles', 'minimumAbcLockedCycles', 'serviceLevels', 'capitalPriorities',
  'version', 'periodBudget', 'standingPromotionCodes', 'clearancePromotionCodes',
  'unknownReviewPromotionCodes', 'enableTier2CycleFallback', 'operationalDataStatus',
  'serviceLevelCandidates', 'minimumLeadTimeWindows', 'maxLeadTimeBreachRate',
  'safetyStockSurplusCapMultiplier', 'safetyStockCapitalCapPerSku', 'defaultLeadTimeDays',
  'overBudgetProposalWindowCycles', 'moqSurplusApprovalThresholdRatio', 'abnormalOrderMultiplier',
]);

const INTEGER_FIELDS = new Set<keyof SimulationPolicy>([
  'referenceRadius', 'referenceRadiusExtended', 'maxReferenceRadius', 'minimumReferences',
  'maxBalancedPerSide', 'abcWindowCycles', 'minimumAbcLockedCycles', 'minimumLeadTimeWindows',
  'defaultLeadTimeDays', 'overBudgetProposalWindowCycles',
]);

const NUMBER_FIELDS = new Set<keyof SimulationPolicy>([
  ...INTEGER_FIELDS, 'periodBudget', 'maxLeadTimeBreachRate', 'safetyStockSurplusCapMultiplier',
  'safetyStockCapitalCapPerSku', 'moqSurplusApprovalThresholdRatio', 'abnormalOrderMultiplier',
]);

function assertNumber(key: string, value: unknown, integer: boolean): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`POLICY_OVERRIDE_INVALID: ${key} phải là ${integer ? 'số nguyên' : 'số'} không âm hữu hạn.`);
  }
}

function assertStringArray(key: string, value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`POLICY_OVERRIDE_INVALID: ${key} phải là mảng chuỗi không rỗng.`);
  }
}

function numericRecord(value: unknown, key: string): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`POLICY_OVERRIDE_INVALID: ${key} phải là object.`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error(`POLICY_OVERRIDE_INVALID: ${key} chỉ nhận giá trị số hữu hạn.`);
  return Object.fromEntries(entries) as Readonly<Record<string, number>>;
}

function stringRecord(value: unknown, key: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`POLICY_OVERRIDE_INVALID: ${key} phải là object.`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string' || !item.trim())) throw new Error(`POLICY_OVERRIDE_INVALID: ${key} chỉ nhận chuỗi không rỗng.`);
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

/** Hợp nhất default policy với metadata dataset mà không cho override thay công thức hay tắt quality gate. */
export class DemandPlanningPolicy {
  static fromMetadata(metadata: PolicyMetadata, defaults: SimulationPolicy): SimulationPolicy {
    const overrides = metadata.policyOverrides;
    for (const key of Object.keys(overrides)) {
      if (!OVERRIDABLE_KEYS.has(key as keyof SimulationPolicy)) {
        throw new Error(`POLICY_OVERRIDE_FORBIDDEN: ${key} không thuộc whitelist; dataset không được thay công thức hoặc quality gate.`);
      }
    }
    for (const key of NUMBER_FIELDS) {
      if (overrides[key] !== undefined) assertNumber(key, overrides[key], INTEGER_FIELDS.has(key));
    }
    for (const key of ['standingPromotionCodes', 'clearancePromotionCodes', 'unknownReviewPromotionCodes'] as const) {
      if (overrides[key] !== undefined) assertStringArray(key, overrides[key]);
    }
    if (overrides['serviceLevelCandidates'] !== undefined) {
      const candidates = overrides['serviceLevelCandidates'];
      if (!Array.isArray(candidates) || candidates.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 100)) {
        throw new Error('POLICY_OVERRIDE_INVALID: serviceLevelCandidates phải là mảng số trong khoảng (0, 100).');
      }
    }
    if (overrides['cutoffHour'] !== undefined && (typeof overrides['cutoffHour'] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(overrides['cutoffHour']))) {
      throw new Error('POLICY_OVERRIDE_INVALID: cutoffHour phải có dạng HH:mm.');
    }
    if (overrides['version'] !== undefined && (typeof overrides['version'] !== 'string' || !overrides['version'].trim())) throw new Error('POLICY_OVERRIDE_INVALID: version phải là chuỗi không rỗng.');
    if (overrides['enableTier2CycleFallback'] !== undefined && typeof overrides['enableTier2CycleFallback'] !== 'boolean') throw new Error('POLICY_OVERRIDE_INVALID: enableTier2CycleFallback phải là boolean.');
    if (overrides['operationalDataStatus'] !== undefined && overrides['operationalDataStatus'] !== 'NOT_APPLICABLE' && overrides['operationalDataStatus'] !== 'CONFIRMED') throw new Error('POLICY_OVERRIDE_INVALID: operationalDataStatus không hợp lệ.');

    const abc = overrides['abcThresholds'] === undefined ? defaults.abcThresholds : numericRecord(overrides['abcThresholds'], 'abcThresholds');
    const xyz = overrides['xyzThresholds'] === undefined ? defaults.xyzThresholds : numericRecord(overrides['xyzThresholds'], 'xyzThresholds');
    const serviceLevels = overrides['serviceLevels'] === undefined ? defaults.serviceLevels : { ...defaults.serviceLevels, ...numericRecord(overrides['serviceLevels'], 'serviceLevels') };
    const capitalPriorities = overrides['capitalPriorities'] === undefined ? defaults.capitalPriorities : { ...defaults.capitalPriorities, ...stringRecord(overrides['capitalPriorities'], 'capitalPriorities') };
    const aMax = abc['aMaxCumulativeShare'];
    const cMin = abc['cMinCumulativeShare'];
    const zAdi = xyz['zMinAdi'];
    const xCv2 = xyz['xMaxCv2'];
    if (aMax === undefined || cMin === undefined || !(0 < aMax && aMax < cMin && cMin <= 1)) throw new Error('POLICY_OVERRIDE_INVALID: abcThresholds yêu cầu 0 < A < C ≤ 1.');
    if (zAdi === undefined || xCv2 === undefined || zAdi <= 0 || xCv2 < 0) throw new Error('POLICY_OVERRIDE_INVALID: xyzThresholds phải không âm và zMinAdi > 0.');

    const merged = { ...defaults, ...overrides } as SimulationPolicy;
    if (!(merged.referenceRadius <= merged.referenceRadiusExtended && merged.referenceRadiusExtended <= merged.maxReferenceRadius)) {
      throw new Error('POLICY_OVERRIDE_INVALID: referenceRadius phải tăng dần từ chuẩn → mở rộng → tối đa.');
    }
    if (merged.minimumAbcLockedCycles > merged.abcWindowCycles) throw new Error('POLICY_OVERRIDE_INVALID: minimumAbcLockedCycles không được vượt abcWindowCycles.');
    return Object.freeze({
      ...merged,
      runDate: metadata.runDate,
      historyYears: metadata.historyYears,
      cycleLength: metadata.cycleLengthDays,
      abcThresholds: Object.freeze({ aMaxCumulativeShare: aMax, cMinCumulativeShare: cMin }),
      xyzThresholds: Object.freeze({ zMinAdi: zAdi, xMaxCv2: xCv2 }),
      serviceLevels: Object.freeze({ ...serviceLevels }),
      capitalPriorities: Object.freeze({ ...capitalPriorities }),
      standingPromotionCodes: Object.freeze([...merged.standingPromotionCodes]),
      clearancePromotionCodes: Object.freeze([...merged.clearancePromotionCodes]),
      unknownReviewPromotionCodes: Object.freeze([...merged.unknownReviewPromotionCodes]),
      serviceLevelCandidates: Object.freeze([...merged.serviceLevelCandidates]),
    });
  }
}
