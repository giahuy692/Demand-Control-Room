import { describe, it, expect } from 'vitest';
import { isStockout, stripStandingPromoCodes } from './math';

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
