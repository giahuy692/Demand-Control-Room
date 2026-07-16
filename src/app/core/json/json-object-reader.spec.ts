import { describe, expect, it } from 'vitest';
import { JsonObjectReader } from './json-object-reader.class';
import { DataContractError } from '../errors/data-contract-error.class';
import { isIsoDate } from '../date/iso-date.value-object';

describe('JsonObjectReader — cổng unknown → giá trị đã validate', () => {
  it('từ chối giá trị không phải object, path chính xác', () => {
    for (const bad of [null, [], 'text', 5, undefined]) {
      expect(() => JsonObjectReader.read(bad, 'root.x')).toThrowError(DataContractError);
      expect(() => JsonObjectReader.read(bad, 'root.x')).toThrowError(/root\.x/);
    }
  });

  it('thiếu trường bắt buộc → lỗi mang path tới đúng trường', () => {
    const row = JsonObjectReader.read({ a: 1 }, 'rows[3]');
    expect(() => row.requiredString('sku')).toThrowError(/rows\[3\]\.sku.*thiếu trường/);
  });

  it('KHÔNG coerce kiểu: "5" không phải số, "true"/1 không phải boolean', () => {
    const row = JsonObjectReader.read({ n: '5', b1: 'true', b2: 1 }, 'r');
    expect(() => row.requiredNumber('n')).toThrowError(DataContractError);
    expect(() => row.requiredBoolean('b1')).toThrowError(DataContractError);
    expect(() => row.requiredBoolean('b2')).toThrowError(DataContractError);
  });

  it('null khác 0: nullableNumber giữ null, nonNegativeNumber từ chối null', () => {
    const row = JsonObjectReader.read({ v: null, z: 0 }, 'r');
    expect(row.nullableNumber('v')).toBeNull();
    expect(row.nullableNumber('z')).toBe(0);
    expect(() => row.nonNegativeNumber('v')).toThrowError(DataContractError);
  });

  it('số không hữu hạn bị chặn (JSON.parse("[1e999]") cho Infinity)', () => {
    const parsed = JSON.parse('{"v": 1e999}') as unknown;
    const row = JsonObjectReader.read(parsed, 'r');
    expect(() => row.requiredNumber('v')).toThrowError(/hữu hạn/);
    expect(() => JsonObjectReader.read({ v: Number.NaN }, 'r').requiredNumber('v')).toThrowError(DataContractError);
  });

  it('isoDate: đúng YYYY-MM-DD và là ngày lịch có thật', () => {
    const row = JsonObjectReader.read({ ok: '2026-06-01', feb30: '2026-02-30', short: '2026-6-1', datetime: '2026-06-01T00:00:00Z' }, 'r');
    expect(row.isoDate('ok')).toBe('2026-06-01');
    for (const key of ['feb30', 'short', 'datetime']) {
      expect(() => row.isoDate(key)).toThrowError(DataContractError);
    }
  });

  it('literal: giá trị ngoài tập cho phép bị từ chối kèm tập hợp lệ', () => {
    const row = JsonObjectReader.read({ kind: 'FAKE' }, 'dataset');
    expect(() => row.literal('kind', ['MOCK', 'REAL'])).toThrowError(/MOCK, REAL/);
    expect(JsonObjectReader.read({ kind: 'REAL' }, 'd').literal('kind', ['MOCK', 'REAL'])).toBe('REAL');
  });

  it('array: phần tử lỗi mang path kèm chỉ số', () => {
    const row = JsonObjectReader.read({ list: [1, 'x', 3] }, 'r');
    expect(() => row.numberArray('list')).toThrowError(/r\.list\[1\]/);
  });

  it('nullablePositiveNumber: 0 và số âm bị từ chối, null hợp lệ', () => {
    const row = JsonObjectReader.read({ zero: 0, neg: -2, none: null, ok: 3.5 }, 'r');
    expect(() => row.nullablePositiveNumber('zero')).toThrowError(DataContractError);
    expect(() => row.nullablePositiveNumber('neg')).toThrowError(DataContractError);
    expect(row.nullablePositiveNumber('none')).toBeNull();
    expect(row.nullablePositiveNumber('ok')).toBe(3.5);
  });

  it('isIsoDate là hàm thuần dùng lại được ngoài reader', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);   // năm nhuận
    expect(isIsoDate('2023-02-29')).toBe(false);  // không nhuận
  });
});
