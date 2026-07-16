// Chuẩn hóa cell thô từ SSMS export — invariant culture, 'NULL' literal, BOM.

export function text(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  return normalized && normalized.toUpperCase() !== 'NULL' ? normalized : null;
}

export function nullableNumber(value) {
  const normalized = text(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function requiredNumber(value, label) {
  const parsed = nullableNumber(value);
  if (parsed === null) throw new Error(`${label}: "${value}" không phải số hợp lệ.`);
  return parsed;
}

/** '2026-02-04 00:00:00.000' | '2026-02-04' → '2026-02-04'; null giữ null. */
export function isoDateFrom(value) {
  const normalized = text(value);
  if (normalized === null) return null;
  const candidate = normalized.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) throw new Error(`Ngày "${normalized}" không đúng dạng YYYY-MM-DD.`);
  return candidate;
}

/** SQL bit: '1'/'0'/'true'/'false' → boolean; null → fallback. */
export function bit(value, fallback) {
  const normalized = text(value);
  if (normalized === null) return fallback;
  return !['0', 'FALSE', 'NO', 'N'].includes(normalized.toUpperCase());
}

export function addDaysIso(iso, amount) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
