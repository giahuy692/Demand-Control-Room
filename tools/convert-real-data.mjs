import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Ghep sales-history (thua, chi ngay co giao dich) voi stock-history (lich lien tuc tai dung tu
// ton hien tai) thanh payload DAILY-SOURCE-V2 cho app. Nguon: Sql/sales-history.sql + Sql/stock-history.sql.
// Stock-history export toan danh muc ~2.2GB/18.8 trieu dong nen PHAI doc streaming (readline),
// khong duoc readFileSync ca file (vo gioi han string ~512MB cua Node).
const args = process.argv.slice(2);
if (args.length < 3 || args.length > 4) {
  console.error('Dung: node tools/convert-real-data.mjs <sales-history.csv> <stock-history.csv> <output.json> [topSku]');
  console.error('  [topSku]: chi giu N barcode co tong luong ban lon nhat. Bat buoc khi stock qua lon —');
  console.error('  app (browser) chua nap noi toan danh muc; xem memory scale-goal (Web Worker/nap theo lo).');
  process.exit(1);
}
const topSku = args[3] ? Number(args[3]) : null;
if (args[3] && (!Number.isInteger(topSku) || topSku <= 0)) {
  console.error(`topSku phai la so nguyen duong, nhan duoc: ${args[3]}`);
  process.exit(1);
}

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

// Tach 1 dong du lieu: tab (SSMS Copy with Headers, khong quote) / comma co quote (Save Results As)
// / comma tron.
function splitDataLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes('"')) return parseCsvLine(line);
  return line.split(',');
}

function text(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  return normalized && normalized.toUpperCase() !== 'NULL' ? normalized : null;
}

// Sales=0 (co dong ban that, tong Qty=0) khac Sales=NULL (khong co dong ban that trong ngay) — KHONG
// duoc coerce ve 0; giu nguyen null khi cot nguon la NULL/rong.
function nullableNumber(value) {
  const normalized = text(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNumber(value, fallback = 0) {
  const parsed = nullableNumber(value);
  return parsed === null ? fallback : parsed;
}

// Cot theo dung thu tu SELECT cuoi trong Sql/sales-history.sql va Sql/stock-history.sql.
const SALES_HISTORY_COLUMNS = ['Barcode', 'ProductName', 'Date', 'Sales', 'Amount', 'Price', 'PromoCode'];
const STOCK_HISTORY_COLUMNS = ['ProductCode', 'Barcode', 'ProductName', 'Date', 'OpenStock', 'CloseStock', 'FirstReceiptCode', 'ReceiptHour', 'FirstReceiptQty'];

// Sales-history (~125MB) van doc ca file duoc — chi stock moi can streaming.
function parseSalesCsv(path) {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  // Header co the co (Copy with Headers) hoac khong (Save Results As) — bo neu trung ten cot dau.
  if (lines.length && /^"?Barcode\b/i.test(lines[0])) lines.shift();
  return lines.map(line => {
    const cells = splitDataLine(line);
    return Object.fromEntries(SALES_HISTORY_COLUMNS.map((name, index) => [name, cells[index]?.trim() ?? '']));
  });
}

const salesRows = parseSalesCsv(args[0]);
if (!salesRows.length) {
  console.error('sales-history rong.');
  process.exit(1);
}

// DB nguon co the la ban sao cu (ngung cap nhat giua chung — vd POS dung 2026-02-14) trong khi
// stock-history.sql van dung lich den GETDATE(): phan sau ngay ban cuoi cung chi la padding "ton
// dung im" khong co can cu giao dich. Cat lich mo phong tai ngay ban that cuoi cung de khong bom
// hang tram ngay ban=0 suy dien gia vao app (pha nat du bao gan hien tai).
let maxSalesDate = '';
for (const row of salesRows) {
  const date = text(row.Date);
  if (date && date > maxSalesDate) maxSalesDate = date;
}
console.error(`Ngay ban that cuoi cung: ${maxSalesDate} — bo qua moi dong stock sau ngay nay.`);

// Tong luong ban + ten theo barcode — dung de chon top N va bao cao barcode thieu stock.
const salesTotals = new Map();
const salesNames = new Map();
for (const row of salesRows) {
  const barcode = text(row.Barcode);
  if (!barcode) continue;
  salesTotals.set(barcode, (salesTotals.get(barcode) ?? 0) + requiredNumber(row.Sales));
  if (!salesNames.has(barcode)) salesNames.set(barcode, text(row.ProductName) ?? '');
}

// Chon top N barcode theo tong luong ban — tap SKU dua vao mo phong.
let selectedBarcodes = null;
if (topSku !== null) {
  selectedBarcodes = new Set([...salesTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topSku).map(([barcode]) => barcode));
  console.error(`Chon top ${selectedBarcodes.size}/${salesTotals.size} barcode theo tong luong ban.`);
}

// ponytail: gioi han cung 3 trieu dong stock giu lai — vuot nghia la dang merge toan danh muc,
// output JSON se qua lon cho browser; nang cap app nap theo lo truoc khi go gioi han nay.
const MAX_STOCK_ROWS = 3_000_000;

const stockRows = [];
const stockBarcodes = new Set(); // moi barcode xuat hien trong stock-history, ke ca ngoai tap chon
let stockLineCount = 0;
let stockBadLines = 0;
await new Promise((resolve, reject) => {
  const rl = createInterface({ input: createReadStream(args[1]), crlfDelay: Infinity });
  rl.on('line', rawLine => {
    const line = stockLineCount === 0 ? rawLine.replace(/^﻿/, '') : rawLine;
    stockLineCount++;
    if (!line.trim()) return;
    if (stockLineCount === 1) {
      if (/^"?Barcode\b/i.test(line)) { rl.close(); reject(new Error(`${args[1]}: header bat dau bang "Barcode" — day la ket qua query BAN HANG, khong phai stock-history.sql (can cot dau ProductCode).`)); return; }
      if (/^"?ProductCode\b/i.test(line)) return; // header — bo
    }
    const cells = splitDataLine(line);
    if (cells.length !== STOCK_HISTORY_COLUMNS.length) {
      if (stockBadLines++ < 5) console.error(`Canh bao: stock dong ${stockLineCount} co ${cells.length} cot (can 9) — bo qua.`);
      return;
    }
    if ((cells[3]?.trim() ?? '') > maxSalesDate) return; // padding sau ngay ban that cuoi cung — xem comment maxSalesDate
    stockBarcodes.add(cells[1].trim());
    if (selectedBarcodes && !selectedBarcodes.has(cells[1].trim())) return;
    if (stockRows.length >= MAX_STOCK_ROWS) { rl.close(); reject(new Error(`Qua ${MAX_STOCK_ROWS} dong stock duoc giu lai — output se qua lon cho app. Truyen tham so [topSku] de gioi han so SKU.`)); return; }
    stockRows.push(Object.fromEntries(STOCK_HISTORY_COLUMNS.map((name, index) => [name, cells[index]?.trim() ?? ''])));
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});
if (stockBadLines > 5) console.error(`... tong cong ${stockBadLines} dong stock sai so cot bi bo qua.`);
if (!stockRows.length) {
  console.error('stock-history rong (hoac khong barcode nao trung tap da chon).');
  process.exit(1);
}

// Bao cao doi soat: barcode co ban nhung KHONG co dong nao trong stock-history (query stock khong
// phu / file export bi dut) — cac SKU nay bi loai khoi mo phong, ghi ra CSV de nghiep vu ra soat.
const missingStock = [...salesTotals.entries()]
  .filter(([barcode]) => !stockBarcodes.has(barcode))
  .sort((a, b) => b[1] - a[1]);
if (missingStock.length) {
  const missingReport = 'Sql/barcode-thieu-stock.csv';
  const csvCell = value => /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  writeFileSync(missingReport, `Barcode,ProductName,TongBan,TrongTop${topSku ?? ''}\n${missingStock
    .map(([barcode, total]) => `${csvCell(barcode)},${csvCell(salesNames.get(barcode) ?? '')},${total},${selectedBarcodes?.has(barcode) ? 'x' : ''}`)
    .join('\n')}\n`);
  const inTop = selectedBarcodes ? missingStock.filter(([barcode]) => selectedBarcodes.has(barcode)).length : 0;
  console.error(`Canh bao: ${missingStock.length} barcode co ban nhung khong co stock-history${selectedBarcodes ? ` (${inTop} thuoc top ${topSku})` : ''} — chi tiet: ${missingReport}`);
}

const inScope = row => !selectedBarcodes || selectedBarcodes.has(text(row.Barcode) ?? '');
const salesByBarcodeDate = new Map();
for (const row of salesRows) {
  if (inScope(row)) salesByBarcodeDate.set(`${text(row.Barcode)}|${text(row.Date)}`, row);
}

const stockKeys = new Set(stockRows.map(row => `${text(row.Barcode)}|${text(row.Date)}`));
const orphanSales = [...salesByBarcodeDate.keys()].filter(key => !stockKeys.has(key));
if (orphanSales.length) console.error(`Canh bao: ${orphanSales.length} dong ban khong khop ngay/barcode nao trong stock-history (ngoai khoang lich hoac barcode chua map) — bi bo qua.`);

const converted = stockRows.map(row => {
  const sale = salesByBarcodeDate.get(`${text(row.Barcode)}|${text(row.Date)}`) ?? null;
  // PromoCode la mang JSON [{PromoCode,PromoName},...] tu SQL — ghep ve chuoi 'code|code'.
  let promos = [];
  if (sale) {
    try { promos = JSON.parse(sale.PromoCode || '[]'); } catch { console.error(`Canh bao: PromoCode JSON hong o ${row.Barcode} ${row.Date} — coi nhu khong co CTKM.`); }
  }
  const openStock = requiredNumber(row.OpenStock);
  const closeStock = requiredNumber(row.CloseStock);
  const receiptHour = nullableNumber(row.ReceiptHour);
  return {
    SKU: text(row.ProductCode),
    Date: text(row.Date),
    // Nếu không có dòng bán thật nhưng có lịch sử kho -> suy diễn bán 0 (theo yêu cầu lấp nền Tầng 2)
    // Thêm cờ IsZeroSaleInferred=true để giao diện Demand Control Room nhận biết và minh bạch.
    Sales: sale ? requiredNumber(sale.Sales) : 0,
    HasSalesRecord: true,
    IsZeroSaleInferred: !sale,
    ReturnQty: null,
    HasReturnRecord: false,
    // Contract moi khong tach rieng phat sinh kho — de null/false, app khong dung truong nay.
    InventoryNetMovement: null,
    HasInventoryMovement: false,
    TotalStockDelta: closeStock - openStock,
    OpenStock: openStock,
    CloseStock: closeStock,
    ReceiptHour: receiptHour === null ? null : `${String(receiptHour).padStart(2, '0')}:00`,
    HasReceiptRecord: text(row.FirstReceiptCode) !== null,
    ReceiptTimeSource: receiptHour === null ? null : 'CREATE_TIME_FALLBACK',
    PromoCode: promos.map(p => p.PromoCode).filter(Boolean).join('|') || null,
    PromoName: promos.map(p => p.PromoName).filter(Boolean).join('|') || null,
    Price: sale ? nullableNumber(sale.Price) : null,
    ProductName: text(row.ProductName),
    IsOpeningAnchor: false,
    IsReferenceOnly: false,
    IsHistoryRecord: true,
    IsValidationActual: false,
  };
}).filter(row => row.SKU && row.Date)
  .sort((a, b) => a.SKU.localeCompare(b.SKU) || a.Date.localeCompare(b.Date));

writeFileSync(args[2], JSON.stringify(converted));
const skuCount = new Set(converted.map(row => row.SKU)).size;
console.log(`Da ghi ${converted.length} dong DailySourceRecord (${skuCount} SKU, sales+stock merge) vao ${args[2]}`);
