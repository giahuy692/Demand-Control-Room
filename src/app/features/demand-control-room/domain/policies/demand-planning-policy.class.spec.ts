import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../policy';
import { DemandPlanningPolicy } from './demand-planning-policy.class';

const metadata = (policyOverrides: Readonly<Record<string, unknown>> = {}) => ({
  runDate: '2026-07-01', historyYears: 2, cycleLengthDays: 14, policyOverrides,
});

describe('DemandPlanningPolicy', () => {
  it('hợp nhất default + metadata + override whitelist và giữ metadata phiên làm nguồn chuẩn', () => {
    const policy = DemandPlanningPolicy.fromMetadata(metadata({
      referenceRadius: 9,
      referenceRadiusExtended: 16,
      maxReferenceRadius: 28,
      abcThresholds: { aMaxCumulativeShare: 0.75, cMinCumulativeShare: 0.92 },
      xyzThresholds: { zMinAdi: 1.5, xMaxCv2: 0.4 },
      standingPromotionCodes: ['LOYALTY'],
      serviceLevels: { AX: 98 },
    }), DEFAULT_POLICY);

    expect(policy.runDate).toBe('2026-07-01');
    expect(policy.historyYears).toBe(2);
    expect(policy.cycleLength).toBe(14);
    expect(policy.referenceRadius).toBe(9);
    expect(policy.abcThresholds).toEqual({ aMaxCumulativeShare: 0.75, cMinCumulativeShare: 0.92 });
    expect(policy.serviceLevels['AX']).toBe(98);
    expect(policy.serviceLevels['BY']).toBe(DEFAULT_POLICY.serviceLevels['BY']);
  });

  it('chặn key ngoài whitelist để dataset không tắt quality gate hoặc thay công thức', () => {
    expect(() => DemandPlanningPolicy.fromMetadata(metadata({ qualityGates: { stockReconciliation: 'PASS' } }), DEFAULT_POLICY))
      .toThrow('POLICY_OVERRIDE_FORBIDDEN: qualityGates');
    expect(() => DemandPlanningPolicy.fromMetadata(metadata({ disableClassificationGate: true }), DEFAULT_POLICY))
      .toThrow('POLICY_OVERRIDE_FORBIDDEN: disableClassificationGate');
  });

  it('chặn threshold, radius và minimum cycle không hợp lệ', () => {
    expect(() => DemandPlanningPolicy.fromMetadata(metadata({ abcThresholds: { aMaxCumulativeShare: 0.95, cMinCumulativeShare: 0.9 } }), DEFAULT_POLICY)).toThrow('abcThresholds');
    expect(() => DemandPlanningPolicy.fromMetadata(metadata({ referenceRadius: 20, referenceRadiusExtended: 10 }), DEFAULT_POLICY)).toThrow('referenceRadius');
    expect(() => DemandPlanningPolicy.fromMetadata(metadata({ abcWindowCycles: 5, minimumAbcLockedCycles: 6 }), DEFAULT_POLICY)).toThrow('minimumAbcLockedCycles');
  });
});
