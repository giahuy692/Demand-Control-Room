import { assertIsoDate } from '../date/iso-date.value-object';
import { DataContractError } from '../errors/data-contract-error.class';

/**
 * Cổng duy nhất chuyển `unknown` (JSON đã parse) thành giá trị đã validate cho DTO factory.
 * Nguyên tắc:
 * - KHÔNG coerce kiểu (chuỗi "5" không phải số 5, "0"/"1" không phải boolean) — hợp đồng
 *   DEMAND-SIMULATION-DATASET-V1 do build script sinh ra nên phải mang đúng kiểu JSON.
 * - `null` là giá trị hợp lệ CÓ NGHĨA (khác 0/khác vắng mặt) — chỉ các reader `nullable*` chấp nhận.
 * - Số phải hữu hạn: JSON.parse('1e999') cho Infinity — phải chặn tại đây.
 * - Mọi lỗi mang path chính xác tới phần tử vi phạm.
 */
export class JsonObjectReader {
  private constructor(
    private readonly value: Record<string, unknown>,
    readonly path: string,
  ) {}

  static read(value: unknown, path: string): JsonObjectReader {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new DataContractError(path, `phải là object JSON, nhận được ${describe(value)}.`);
    }
    return new JsonObjectReader(value as Record<string, unknown>, path);
  }

  private at(key: string): string {
    return `${this.path}.${key}`;
  }

  private present(key: string): unknown {
    if (!(key in this.value)) throw new DataContractError(this.at(key), 'thiếu trường bắt buộc.');
    return this.value[key];
  }

  requiredString(key: string): string {
    const raw = this.present(key);
    if (typeof raw !== 'string' || !raw.trim()) throw new DataContractError(this.at(key), `phải là chuỗi khác rỗng, nhận được ${describe(raw)}.`);
    return raw;
  }

  nullableString(key: string): string | null {
    const raw = this.present(key);
    if (raw === null) return null;
    if (typeof raw !== 'string') throw new DataContractError(this.at(key), `phải là chuỗi hoặc null, nhận được ${describe(raw)}.`);
    return raw;
  }

  requiredNumber(key: string): number {
    const raw = this.present(key);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new DataContractError(this.at(key), `phải là số hữu hạn, nhận được ${describe(raw)}.`);
    return raw;
  }

  nonNegativeNumber(key: string): number {
    const value = this.requiredNumber(key);
    if (value < 0) throw new DataContractError(this.at(key), `phải ≥ 0, nhận được ${value}.`);
    return value;
  }

  nonNegativeInteger(key: string): number {
    const value = this.nonNegativeNumber(key);
    if (!Number.isInteger(value)) throw new DataContractError(this.at(key), `phải là số nguyên, nhận được ${value}.`);
    return value;
  }

  nullableNumber(key: string): number | null {
    const raw = this.present(key);
    if (raw === null) return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new DataContractError(this.at(key), `phải là số hữu hạn hoặc null, nhận được ${describe(raw)}.`);
    return raw;
  }

  nullablePositiveNumber(key: string): number | null {
    const value = this.nullableNumber(key);
    if (value !== null && value <= 0) throw new DataContractError(this.at(key), `phải > 0 hoặc null, nhận được ${value}.`);
    return value;
  }

  requiredBoolean(key: string): boolean {
    const raw = this.present(key);
    // KHÔNG chấp nhận "0"/"1"/0/1 — hợp đồng V1 chỉ cho boolean JSON thật.
    if (typeof raw !== 'boolean') throw new DataContractError(this.at(key), `phải là boolean JSON (true/false), nhận được ${describe(raw)}.`);
    return raw;
  }

  isoDate(key: string): string {
    return assertIsoDate(this.requiredString(key), this.at(key));
  }

  nullableIsoDate(key: string): string | null {
    const raw = this.nullableString(key);
    return raw === null ? null : assertIsoDate(raw, this.at(key));
  }

  literal<T extends string>(key: string, allowed: readonly T[]): T {
    const raw = this.requiredString(key);
    if (!(allowed as readonly string[]).includes(raw)) {
      throw new DataContractError(this.at(key), `"${raw}" không thuộc tập cho phép [${allowed.join(', ')}].`);
    }
    return raw as T;
  }

  nullableLiteral<T extends string>(key: string, allowed: readonly T[]): T | null {
    const raw = this.nullableString(key);
    if (raw === null) return null;
    if (!(allowed as readonly string[]).includes(raw)) {
      throw new DataContractError(this.at(key), `"${raw}" không thuộc tập cho phép [${allowed.join(', ')}].`);
    }
    return raw as T;
  }

  array<T>(key: string, map: (item: unknown, index: number) => T): T[] {
    const raw = this.present(key);
    if (!Array.isArray(raw)) throw new DataContractError(this.at(key), `phải là mảng JSON, nhận được ${describe(raw)}.`);
    return raw.map((item, index) => map(item, index));
  }

  numberArray(key: string): number[] {
    return this.array(key, (item, index) => {
      if (typeof item !== 'number' || !Number.isFinite(item)) {
        throw new DataContractError(`${this.at(key)}[${index}]`, `phải là số hữu hạn, nhận được ${describe(item)}.`);
      }
      return item;
    });
  }

  child(key: string): JsonObjectReader {
    return JsonObjectReader.read(this.present(key), this.at(key));
  }

  /** Giá trị thô `unknown` của một trường bắt buộc — dùng để chuyển tiếp cho DTO factory con. */
  rawValue(key: string): unknown {
    return this.present(key);
  }

  /** Object tự do (vd. policyOverrides) — trả về bản sao key/unknown để caller tự validate từng khóa. */
  rawObject(key: string): Readonly<Record<string, unknown>> {
    const raw = this.present(key);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DataContractError(this.at(key), `phải là object JSON, nhận được ${describe(raw)}.`);
    }
    return { ...(raw as Record<string, unknown>) };
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'mảng';
  if (typeof value === 'string') return `chuỗi "${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (typeof value === 'number') return `số ${value}`;
  return typeof value;
}
