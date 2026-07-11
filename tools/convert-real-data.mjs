import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Dung: node tools/convert-real-data.mjs <input.txt> <output.json>');
  process.exit(1);
}

function parseTsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const header = lines[0].split('\t').map(cell => cell.replace(/^\uFEFF/, '').trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((name, index) => [name, cells[index]?.trim() ?? '']));
  });
}

function text(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  return normalized && normalized.toUpperCase() !== 'NULL' ? normalized : null;
}

function number(value) {
  return Number(text(value)) || 0;
}

function hasRecord(value) {
  const normalized = text(value);
  return normalized === null ? true : !['0', 'FALSE', 'NO', 'N'].includes(normalized.toUpperCase());
}

const rows = parseTsv(readFileSync(inputPath, 'utf8'))
  .filter(row => hasRecord(row.HasRecord))
  .map(row => ({
    SKU: text(row.SKU),
    Date: text(row.Date),
    OpenStock: number(row.OpenStock),
    CloseStock: number(row.CloseStock),
    Sales: number(row.Sales),
    HasRecord: true,
    ReceiptHour: text(row.ReceiptHour),
    PromoCode: text(row.PromoCode),
    PromoName: text(row.PromoName),
    Price: number(row.Price),
    ProductName: text(row.ProductName),
  }))
  .filter(row => row.SKU && row.Date)
  .sort((a, b) => a.SKU.localeCompare(b.SKU) || a.Date.localeCompare(b.Date));

writeFileSync(outputPath, JSON.stringify(rows));
console.log(`Da ghi ${rows.length} dong actual-record vao ${outputPath}`);
