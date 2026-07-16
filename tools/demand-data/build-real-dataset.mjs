/**
 * Build real.dataset.json từ 2 CSV export của Sql/sales-history.sql (schema 2026-07):
 * - stock-history.csv: ProductCode, Barcode, ProductName, Date, OpenStock, CloseStock,
 *   FirstReceiptCode, ReceiptHour, ReceiptTime, IsReferenceOnly — lịch LIÊN TỤC mỗi SKU
 *   trong [ReferenceReadStart .. ProcessingEndDate], mỗi (ProductCode, Date) đúng 1 dòng
 *   (PRIMARY KEY phía SQL).
 * - sales-history.csv: Product, Barcode, VName, TotalQty, AvgPrice, EffDate, Discount,
 *   Promotion — KHÔNG lọc ngày, một (Product, ngày) có thể nhiều dòng theo Promotion.
 *
 * Ghép theo (ProductCode, Date). Ngày có stock nhưng không có dòng bán: GIỮ QUYẾT ĐỊNH
 * NGHIỆP VỤ hiện hành sales=0 + isZeroSaleInferred=true (lấp nền Tầng 2 — xem
 * tools/convert-real-data.mjs cũ). Dòng bán SAU ngày cắt stock → isValidationActual,
 * openStock/closeStock=null (không bịa tồn). Dòng bán TRƯỚC cửa sổ stock → loại, đếm log.
 */
import { readDelimitedFile } from './csv-reader.mjs';
import { bit, isoDateFrom, nullableNumber, requiredNumber, text, addDaysIso } from './normalizers.mjs';
import { CONTRACT_VERSION, sha256File, validateDataset, writeDatasetAtomic } from './data-contract.mjs';

const [salesPath = 'Sql/sales-history.csv', stockPath = 'Sql/stock-history.csv', outputPath = 'src/assets/demand-planning/datasets/real.dataset.json'] = process.argv.slice(2);

// ── 1. Stock: lịch liên tục + cờ vùng tham chiếu ─────────────────────────────
const stockRows = readDelimitedFile(stockPath, ['ProductCode', 'Barcode', 'ProductName', 'Date', 'OpenStock', 'CloseStock', 'FirstReceiptCode', 'ReceiptHour', 'ReceiptTime', 'IsReferenceOnly']);
if (!stockRows.length) { console.error('stock-history rỗng.'); process.exit(1); }

const stockBySkuDate = new Map();
let minStockDate = '9999-99-99';
let maxStockDate = '';
let minProcessingDate = '9999-99-99';
for (const row of stockRows) {
  const sku = text(row.ProductCode);
  const date = isoDateFrom(row.Date);
  if (!sku || !date) continue;
  const key = `${sku}|${date}`;
  if (stockBySkuDate.has(key)) { console.error(`Trùng khóa stock (ProductCode=${sku}, Date=${date}) — nguồn vi phạm PRIMARY KEY, export lại.`); process.exit(1); }
  stockBySkuDate.set(key, row);
  if (date < minStockDate) minStockDate = date;
  if (date > maxStockDate) maxStockDate = date;
  if (!bit(row.IsReferenceOnly, false) && date < minProcessingDate) minProcessingDate = date;
}

// runDate = ProcessingEndDate + 1 theo đúng cấu trúc SQL (@ProcessingEndDate = runDate − 1).
const runDate = addDaysIso(maxStockDate, 1);
const fullCycleDays = Math.round((new Date(`${maxStockDate}T00:00:00Z`) - new Date(`${minProcessingDate}T00:00:00Z`)) / 86_400_000) + 1;
const cycleLengthDays = 15;
if (fullCycleDays % cycleLengthDays !== 0) {
  console.error(`Khung xử lý ${minProcessingDate}..${maxStockDate} = ${fullCycleDays} ngày, không chia hết chu kỳ ${cycleLengthDays} — export sai khung.`);
  process.exit(1);
}
const historyYears = new Date(`${runDate}T00:00:00Z`).getUTCFullYear() - new Date(`${minProcessingDate}T00:00:00Z`).getUTCFullYear();

// ── 2. Sales: gộp theo (Product, ngày) — nhiều dòng Promotion trên cùng ngày ──
const salesRows = readDelimitedFile(salesPath, ['Product', 'Barcode', 'VName', 'TotalQty', 'AvgPrice', 'EffDate', 'Discount', 'Promotion']);
if (!salesRows.length) { console.error('sales-history rỗng.'); process.exit(1); }

const salesBySkuDate = new Map();
let maxSalesDate = '';
for (const row of salesRows) {
  const sku = text(row.Product);
  const date = isoDateFrom(row.EffDate);
  if (!sku || !date) continue;
  if (date > maxSalesDate) maxSalesDate = date;
  const key = `${sku}|${date}`;
  const qty = requiredNumber(row.TotalQty, `sales ${key} TotalQty`);
  const avgPrice = nullableNumber(row.AvgPrice);
  const promo = text(row.Promotion) ?? text(row.Discount);
  const entry = salesBySkuDate.get(key) ?? { qty: 0, amount: 0, pricedQty: 0, promoCodes: new Set(), promoNames: new Set(), name: text(row.VName) };
  entry.qty += qty;
  if (avgPrice !== null) { entry.amount += avgPrice * qty; entry.pricedQty += qty; }
  if (promo) entry.promoCodes.add(promo);
  if (text(row.Promotion)) entry.promoNames.add(text(row.Promotion));
  salesBySkuDate.set(key, entry);
}

// ── 3. Ghép: stock là lịch nền; sales ngoài cửa sổ stock tách luồng ───────────
const skuMeta = new Map(); // sku -> { name, firstPrice, maxClose, lastClose }
const dailyRecords = [];
let inferredZeroDays = 0;

for (const row of stockRows) {
  const sku = text(row.ProductCode);
  const date = isoDateFrom(row.Date);
  if (!sku || !date) continue;
  const sale = salesBySkuDate.get(`${sku}|${date}`) ?? null;
  const openStock = requiredNumber(row.OpenStock, `stock ${sku} ${date} OpenStock`);
  const closeStock = requiredNumber(row.CloseStock, `stock ${sku} ${date} CloseStock`);
  const receiptTime = text(row.ReceiptTime);
  const receiptHourNumber = nullableNumber(row.ReceiptHour);
  const receiptHour = receiptTime ? receiptTime.slice(0, 5) : receiptHourNumber === null ? null : `${String(receiptHourNumber).padStart(2, '0')}:00`;
  const price = sale && sale.pricedQty > 0 ? sale.amount / sale.pricedQty : null;
  if (!sale) inferredZeroDays++;
  dailyRecords.push({
    sku,
    date,
    openStock,
    closeStock,
    sales: sale ? sale.qty : 0,
    hasSalesRecord: true,
    isZeroSaleInferred: !sale,
    returnQty: null,
    hasReturnRecord: false,
    inventoryNetMovement: null,
    hasInventoryMovement: false,
    totalStockDelta: closeStock - openStock,
    receiptHour,
    hasReceiptRecord: text(row.FirstReceiptCode) !== null,
    receiptTimeSource: receiptHour === null ? null : 'CREATE_TIME_FALLBACK',
    promoCode: sale && sale.promoCodes.size ? [...sale.promoCodes].join('|') : null,
    promoName: sale && sale.promoNames.size ? [...sale.promoNames].join('|') : null,
    price,
    productName: text(row.ProductName),
    isOpeningAnchor: false,
    isReferenceOnly: bit(row.IsReferenceOnly, false),
    isHistoryRecord: !bit(row.IsReferenceOnly, false),
    isValidationActual: false,
  });
  const meta = skuMeta.get(sku) ?? { name: text(row.ProductName), firstPrice: null, maxClose: 1, lastClose: 0, lastDate: '' };
  if (meta.firstPrice === null && price) meta.firstPrice = price;
  if (closeStock > meta.maxClose) meta.maxClose = closeStock;
  if (date >= meta.lastDate) { meta.lastDate = date; meta.lastClose = closeStock; }
  skuMeta.set(sku, meta);
}

// Dòng bán sau ngày cắt stock → validation actual (không bịa tồn); trước cửa sổ → loại.
let droppedPreWindowSales = 0;
let validationRows = 0;
for (const [key, sale] of salesBySkuDate) {
  const [sku, date] = key.split('|');
  if (stockBySkuDate.has(key)) continue;
  if (!skuMeta.has(sku)) { droppedPreWindowSales++; continue; } // barcode/mã ngoài tập stock
  if (date <= maxStockDate) { droppedPreWindowSales++; continue; }
  validationRows++;
  dailyRecords.push({
    sku,
    date,
    openStock: null,
    closeStock: null,
    sales: sale.qty,
    hasSalesRecord: true,
    isZeroSaleInferred: false,
    returnQty: null,
    hasReturnRecord: false,
    inventoryNetMovement: null,
    hasInventoryMovement: false,
    totalStockDelta: 0,
    receiptHour: null,
    hasReceiptRecord: false,
    receiptTimeSource: null,
    promoCode: sale.promoCodes.size ? [...sale.promoCodes].join('|') : null,
    promoName: sale.promoNames.size ? [...sale.promoNames].join('|') : null,
    price: sale.pricedQty > 0 ? sale.amount / sale.pricedQty : null,
    productName: sale.name,
    isOpeningAnchor: false,
    isReferenceOnly: false,
    isHistoryRecord: false,
    isValidationActual: true,
  });
}
if (droppedPreWindowSales) console.error(`Cảnh báo: ${droppedPreWindowSales} dòng bán ngoài cửa sổ stock (trước ${minStockDate} hoặc SKU không có stock) — bị loại.`);
console.error(`${inferredZeroDays} ngày có stock nhưng không có dòng bán → sales=0 + isZeroSaleInferred (quyết định nghiệp vụ hiện hành).`);
console.error(`${validationRows} dòng bán sau ${maxStockDate} → isValidationActual (tồn=null, không bịa).`);

dailyRecords.sort((a, b) => a.sku.localeCompare(b.sku) || a.date.localeCompare(b.date));

// ── 4. Gate đối soát tồn: OpenStock hôm nay = CloseStock hôm trước (chuỗi liên tục) ──
const mismatchSkus = new Set();
let previous = null;
for (const row of dailyRecords) {
  if (row.openStock === null) { previous = null; continue; }
  if (previous && previous.sku === row.sku && addDaysIso(previous.date, 1) === row.date && previous.closeStock !== row.openStock) {
    mismatchSkus.add(row.sku);
  }
  previous = row;
}
const stockReconciliation = mismatchSkus.size === 0 ? 'PASS' : 'FAIL';

// ── 5. Products: giữ nguyên các default bucket-(c) của parseRealDataset cũ ────
const products = [...skuMeta.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sku, meta]) => {
  const price = meta.firstPrice ?? 0;
  const purchasePrice = price ? Math.round(price * 0.75) : 0;
  return {
    id: sku,
    name: meta.name ?? `SKU ${sku}`,
    type: 'REAL',
    price,
    cycles: 0,
    description: 'Dữ liệu thật từ real.dataset.json',
    category: 'ERP',
    supplier: 'Chưa map NCC',
    inboundPlan: [],
    commitments: [],
    futurePromotions: [],
    leadTimeHistoryDays: [],
    maxStock: Math.max(1, meta.maxClose),
    warehouseCapacity: Math.max(Math.max(1, meta.maxClose), Math.ceil(Math.max(1, meta.maxClose) * 1.25)),
    shelfLifeDays: null,
    purchasePrice,
    moq: 1,
    purchaseTermsComplete: purchasePrice > 0,
    actualDemand: [],
    actualEndingStock: meta.lastClose,
    actualReceiptDelayDays: [],
    actualBudgetUsed: 0,
    heldStock: 0,
    damagedStock: 0,
    blockedStock: 0,
    unsellableStock: 0,
    displayMinimumStock: 0,
    unitsPerCarton: 1,
    orderStep: 1,
    supplierMinOrderValue: null,
    receivingLocation: 'KGV',
    currency: 'VND',
    landedCostPerUnit: null,
    coreOrStrategicRole: 'normal',
    obsolescenceRiskRank: 0,
  };
});

const dataset = {
  contractVersion: CONTRACT_VERSION,
  datasetId: `real-pos-${runDate}`,
  datasetKind: 'REAL',
  generatedAt: new Date().toISOString(),
  metadata: {
    runMode: 'HISTORICAL_VALIDATION',
    runDate,
    calendarScaffold: 'GLOBAL_WINDOW',
    historyYears,
    cycleLengthDays,
    storeCode: 'GLOBAL_POS',
    storeScopeStatus: 'GLOBAL_POS_AGGREGATE',
    portfolioMode: 'SELECTED_SKU_SIMULATION',
    extractIsTruncated: true,
    sourceWatermarks: { sales: maxSalesDate, stock: maxStockDate },
    qualityGates: { stockReconciliation, stockMismatchSkuCount: mismatchSkus.size },
    rowCounts: { dailyRecords: dailyRecords.length, products: products.length },
    policyOverrides: {},
    sourceFiles: [
      { name: salesPath, sha256: sha256File(salesPath) },
      { name: stockPath, sha256: sha256File(stockPath) },
    ],
    warnings: {
      droppedPreWindowSalesRows: droppedPreWindowSales,
      inferredZeroSaleDays: inferredZeroDays,
      validationSalesRows: validationRows,
    },
  },
  products,
  dailyRecords,
  promotionIntervals: [],
};

const errors = validateDataset(dataset);
if (errors.length) {
  console.error(`real.dataset.json KHÔNG đạt hợp đồng (${errors.length} lỗi):`);
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
  if (mismatchSkus.size) console.error(`  SKU lệch tồn: ${[...mismatchSkus].slice(0, 10).join(', ')}${mismatchSkus.size > 10 ? '…' : ''}`);
  process.exit(1);
}

writeDatasetAtomic(outputPath, dataset);
console.log(`Đã ghi ${dailyRecords.length} dòng ngày, ${products.length} SKU (runDate=${runDate}, watermark sales=${maxSalesDate}) vào ${outputPath}`);
