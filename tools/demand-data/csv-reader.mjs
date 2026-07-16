import { readFileSync, statSync } from 'node:fs';

// ponytail: export hiện tại (sales 4MB, stock 9MB) đọc cả file được; vượt trần này
// nghĩa là đang export toàn danh mục — quay lại streaming (readline) trước khi gỡ trần.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Tách 1 dòng: tab (SSMS Copy with Headers) / comma có quote RFC4180 / comma trơn. */
export function splitDataLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes('"')) return parseCsvLine(line);
  return line.split(',');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * §8.1 — đọc theo TÊN header (dòng đầu), không theo vị trí cột. `requiredColumns`
 * phải có đủ trong header, thiếu là lỗi hợp đồng nguồn — không đoán cột theo thứ tự.
 * Trả mảng object key = tên cột. Nhận cả TSV lẫn CSV (§8.2).
 */
export function readDelimitedFile(path, requiredColumns) {
  if (statSync(path).size > MAX_FILE_BYTES) {
    throw new Error(`${path} vượt ${MAX_FILE_BYTES / 1024 / 1024}MB — export quá lớn cho bộ đọc cả-file, cần chuyển sang streaming.`);
  }
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error(`${path} rỗng.`);
  const header = splitDataLine(lines[0]).map(cell => cell.trim());
  const missing = requiredColumns.filter(name => !header.includes(name));
  if (missing.length) {
    throw new Error(`${path}: thiếu cột bắt buộc [${missing.join(', ')}] — header thực tế: [${header.join(', ')}].`);
  }
  return lines.slice(1).map((line, index) => {
    const cells = splitDataLine(line);
    if (cells.length !== header.length) {
      throw new Error(`${path} dòng ${index + 2}: có ${cells.length} cột, header có ${header.length}.`);
    }
    return Object.fromEntries(header.map((name, column) => [name, cells[column]?.trim() ?? '']));
  });
}
