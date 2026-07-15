import { readFileSync, writeFileSync } from 'node:fs';

// Chuyen 2 file export SQL Server (cot theo dung thu tu SELECT cuoi trong Sql/sales-history.sql
// va Sql/stock-history.sql) sang JSON mang object co ten cot (Sql/*.json) de doi soat/dan tay.
// LUU Y: app KHONG doc 2 file nay truc tiep — Demand Control Room doc src/assets/demand-planning-real.json,
// sinh bang `npm run convert:real-data` (tools/convert-real-data.mjs merge sales+stock).
// Moi dong 1 object tren 1 line de co the dan them data moi bang tay.
// Dung: node tools/csv-to-json.mjs   (chay tu goc repo; doc Sql/*.csv, ghi Sql/*.json)

// RFC4180 comma line (quoted fields, "" escapes an embedded quote) — dinh dang SQL Server export.
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

function text(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  return normalized && normalized.toUpperCase() !== 'NULL' ? normalized : null;
}

// Sales=0 (co dong ban that) khac NULL (khong co dong ban) — giu null, khong coerce ve 0.
function nullableNumber(value) {
  const normalized = text(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderlessCsv(path, columns) {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  // SSMS "Copy with Headers" luon chen dong header (tab hoac phay) — header sai ten cot dau
  // = export nham query (vd stock-history.csv chua ket qua sales): DUNG han, khong parse thanh rac.
  if (!lines.length || !new RegExp(`^"?(${columns[0]})\\b`, 'i').test(lines[0])) {
    throw new Error(`${path}: header khong bat dau bang cot "${columns[0]}" — file co the export nham query. Can cot: ${columns.join(', ')}`);
  }
  lines.shift();
  return lines.map(line => {
    // Export SSMS "Copy with Headers" la tab-delimited (khong quote); export .csv cu la comma RFC4180.
    const cells = line.includes('\t') ? line.split('\t') : parseCsvLine(line);
    return Object.fromEntries(columns.map((name, index) => [name, cells[index]?.trim() ?? '']));
  });
}

function writeJsonRows(path, rows) {
  // 1 object / 1 dong — de dan them data moi vao cuoi mang bang tay.
  writeFileSync(path, `[\n${rows.map(row => JSON.stringify(row)).join(',\n')}\n]\n`);
  console.log(`Da ghi ${rows.length} dong vao ${path}`);
}

const salesRows = parseHeaderlessCsv('Sql/sales-history.csv', ['Barcode', 'ProductName', 'Date', 'Sales', 'Amount', 'Price', 'PromoJson']).map(row => {
  let promoJson = [];
  try {
    const parsed = JSON.parse(row.PromoJson || '[]');
    if (Array.isArray(parsed)) promoJson = parsed;
  } catch {
    console.error(`Canh bao: PromoJson hong o ${row.Barcode} ${row.Date} — coi nhu khong co CTKM.`);
  }
  return {
    Barcode: text(row.Barcode),
    ProductName: text(row.ProductName),
    Date: text(row.Date),
    Sales: nullableNumber(row.Sales),
    Amount: nullableNumber(row.Amount),
    Price: nullableNumber(row.Price),
    PromoJson: promoJson,
  };
});

// Ghi sales truoc khi parse stock — stock export loi khong duoc chan file sales hop le.
writeJsonRows('Sql/sales-history.json', salesRows);

const stockRows = parseHeaderlessCsv('Sql/stock-history.csv', ['ProductCode', 'Barcode', 'ProductName', 'Date', 'OpenStock', 'CloseStock', 'FirstReceiptCode', 'ReceiptHour', 'FirstReceiptQty']).map(row => ({
  ProductCode: text(row.ProductCode),
  Barcode: text(row.Barcode),
  ProductName: text(row.ProductName),
  Date: text(row.Date),
  OpenStock: nullableNumber(row.OpenStock),
  CloseStock: nullableNumber(row.CloseStock),
  FirstReceiptCode: text(row.FirstReceiptCode),
  ReceiptHour: nullableNumber(row.ReceiptHour),
  FirstReceiptQty: nullableNumber(row.FirstReceiptQty),
}));

writeJsonRows('Sql/stock-history.json', stockRows);
