import { DataContractError } from '../errors/data-contract-error.class';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` đúng định dạng VÀ là ngày lịch có thật (chặn 2026-02-30, 2026-6-1, chuỗi datetime). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function assertIsoDate(value: string, path: string): string {
  if (!isIsoDate(value)) throw new DataContractError(path, `"${value}" không phải ngày ISO hợp lệ dạng YYYY-MM-DD.`);
  return value;
}

/** Cộng/trừ ngày trên chuỗi ISO (UTC, không lệch múi giờ). */
export function addDaysIso(iso: string, amount: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
