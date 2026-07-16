import { describe, expect, it } from 'vitest';
import { StageNumber } from './models';
import { STAGE_TRACE_CONTRACTS } from './stage-trace-contracts';

const REQUIRED_TERMS: Readonly<Record<StageNumber, readonly string[]>> = {
  1: ['D_start', '15 ngày', '3 năm'],
  2: ['O=0', 'C>0', 'trống cả ngày'],
  3: ['±7', '±24', 'trung vị', 'max(Q,R)'],
  4: ['vùng CTKM', 'trung vị', 'Không dùng max'],
  5: ['Chu kỳ trống', 'Y_j', 'locked'],
  6: ['24/N', 'V_năm', '80%', '90%'],
  7: ['ADI', '1,32', 'CV²', '0,49'],
  8: ['ma trận 9 ô', 'Nhóm D', 'mức phục vụ'],
  9: ['48 chu kỳ', '24 vị trí', '67%', '1,15'],
  10: ['3 đoạn', '±5%', '15%', '25%'],
  11: ['TRAIN/TEST', 'p=2…12', 'Pearson', 'WAPE'],
  12: ['K=ΣQ_actual/ΣY_base', '1–2', 'từ 3', 'AUTO_OK'],
  13: ['F_final=F_base', 'n/15', 'BLOCKED'],
  14: ['I_available', 'Inbound≤c', 'Commitment≤c'],
  15: ['SS=Z', 'Protection=max', 'DisplayMin'],
  16: ['CoverWindow', 'Q_raw', 'Q_order', 'Excess_MOQ'],
  17: ['Rổ 1', 'Rổ 2', 'Rổ 3', 'MOQ'],
  18: ['Q_final', 'release/review/no-release', 'trước/sau'],
  19: ['WAPE nền/cuối', 'Bias', 'không sửa snapshot'],
};

describe('hợp đồng nội dung MÔ PHỎNG & KIỂM TOÁN 1–1', () => {
  it('có đúng một hợp đồng cho đủ 19 chặng', () => {
    expect(Object.keys(STAGE_TRACE_CONTRACTS).map(Number)).toEqual(Array.from({ length: 19 }, (_, index) => index + 1));
  });

  it('mỗi chặng có đủ vai trò, đầu vào, quy tắc, đầu ra, kiểm soát và đối chiếu tài liệu', () => {
    for (let stage = 1 as StageNumber; stage <= 19; stage++) {
      const contract = STAGE_TRACE_CONTRACTS[stage];
      expect(contract.purpose.length, `Chặng ${stage} · purpose`).toBeGreaterThan(20);
      expect(contract.inputs.length, `Chặng ${stage} · inputs`).toBeGreaterThanOrEqual(2);
      expect(contract.rules.length, `Chặng ${stage} · rules`).toBeGreaterThanOrEqual(3);
      expect(contract.outputs.length, `Chặng ${stage} · outputs`).toBeGreaterThanOrEqual(3);
      expect(contract.controls.length, `Chặng ${stage} · controls`).toBeGreaterThanOrEqual(2);
      expect(contract.documentCoverage.length, `Chặng ${stage} · documentCoverage`).toBeGreaterThanOrEqual(3);
      expect(contract.documentCoverage.join(' '), `Chặng ${stage} · ký hiệu tiểu mục`).toContain('§');
    }
  });

  it('giữ đủ các khái niệm khóa bắt buộc của tài liệu cho từng chặng', () => {
    for (let stage = 1 as StageNumber; stage <= 19; stage++) {
      const contract = STAGE_TRACE_CONTRACTS[stage];
      const searchable = [contract.purpose, ...contract.inputs, ...contract.rules, ...contract.outputs, ...contract.controls, ...contract.documentCoverage].join(' ');
      for (const term of REQUIRED_TERMS[stage]) {
        expect(searchable, `Chặng ${stage} phải có “${term}”`).toContain(term);
      }
    }
  });
});
