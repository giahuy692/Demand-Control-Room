import { describe, it, expect } from 'vitest';
import { classifyPromoPolicy, classifyPromoRegionPolicy, classifyXyz, isStockout, stripStandingPromoCodes } from './math';

describe('classifyXyz — RULE-07-004 không gán D cho cửa sổ đủ dài nhưng toàn bộ bằng 0', () => {
  it('n≥6, m=0 (toàn bộ chu kỳ bằng 0) → xyz=null, KHÔNG phải D, không tính ADI', () => {
    const result = classifyXyz([0, 0, 0, 0, 0, 0, 0]);
    expect(result.xyz).toBeNull();
    expect(result.n).toBe(7);
    expect(result.m).toBe(0);
    expect(result.adi).toBeNull();
  });

  it('n<6 (kể cả toàn 0) vẫn là D — lịch sử thật sự ngắn, không lẫn với RULE-07-004', () => {
    const result = classifyXyz([0, 0, 0]);
    expect(result.xyz).toBe('D');
    expect(result.n).toBe(3);
  });

  it('n≥6, m>0 — không đổi hành vi cũ', () => {
    const result = classifyXyz([0, 0, 30, 0, 0, 25]);
    expect(result.xyz).toBe('Z');
    expect(result.m).toBe(2);
  });
});

describe('isStockout — ngày không có bản ghi không được suy diễn thành bán=0 [C1 §3]', () => {
  it('hasRecord=false: KHÔNG gắn stockout dù tồn/bán trông giống "trống cả ngày"', () => {
    expect(isStockout({ openStock: 0, closeStock: 0, sales: 0, receiptHour: null, hasRecord: false })).toBe(false);
  });

  it('hasRecord=true: vẫn gắn stockout bình thường (không đổi hành vi cũ)', () => {
    expect(isStockout({ openStock: 0, closeStock: 0, sales: 0, receiptHour: null, hasRecord: true })).toBe(true);
  });

  it('lateReceipt không cần hasRecord (tồn/giờ nhập tin được dù chưa xác nhận bán)', () => {
    expect(isStockout({ openStock: 0, closeStock: 20, sales: 0, receiptHour: '13:00', hasRecord: false }, '10:00')).toBe(true);
  });
});

describe('stripStandingPromoCodes — loại mã CTKM thường trực khỏi promoCode ghép', () => {
  it('trả về null khi ngày chỉ dính mã thường trực', () => {
    expect(stripStandingPromoCodes('38216', ['38216'])).toBeNull();
    expect(stripStandingPromoCodes('38216|38231', ['38216', '38231'])).toBeNull();
  });

  it('giữ lại mã chiến dịch còn sót sau khi loại mã thường trực', () => {
    expect(stripStandingPromoCodes('38216|49026', ['38216'])).toBe('49026');
  });

  it('không đổi gì khi promoCode null hoặc danh sách thường trực rỗng', () => {
    expect(stripStandingPromoCodes(null, ['38216'])).toBeNull();
    expect(stripStandingPromoCodes('49026', [])).toBe('49026');
  });

  it('giữ nguyên promoCode khi không có mã nào trùng danh sách thường trực', () => {
    expect(stripStandingPromoCodes('49026|49080', ['38216'])).toBe('49026|49080');
  });
});

describe('classifyPromoPolicy/classifyPromoRegionPolicy — RULE-04-001 phân loại CTKM trước chuẩn hóa', () => {
  it('mặc định CAMPAIGN khi mã không nằm trong danh sách nào — giữ nguyên hành vi hiện có', () => {
    expect(classifyPromoPolicy('49026', [], [])).toBe('CAMPAIGN');
  });

  it('UNKNOWN_REVIEW khi mã nằm trong danh sách chờ duyệt', () => {
    expect(classifyPromoPolicy('UNK01', ['UNK01'], [])).toBe('UNKNOWN_REVIEW');
  });

  it('CLEARANCE khi mã nằm trong danh sách thanh lý đã duyệt', () => {
    expect(classifyPromoPolicy('CLR01', [], ['CLR01'])).toBe('CLEARANCE');
  });

  it('UNKNOWN_REVIEW ưu tiên hơn CLEARANCE nếu một mã lỡ nằm ở cả hai danh sách (an toàn, không tự quyết)', () => {
    expect(classifyPromoPolicy('X', ['X'], ['X'])).toBe('UNKNOWN_REVIEW');
  });

  it('vùng nhiều mã: chỉ cần một mã UNKNOWN_REVIEW là cả vùng UNKNOWN_REVIEW', () => {
    expect(classifyPromoRegionPolicy(['CAMP1', 'UNK01'], ['UNK01'], [])).toBe('UNKNOWN_REVIEW');
  });
});
