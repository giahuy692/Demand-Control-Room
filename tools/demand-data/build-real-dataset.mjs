/**
 * Build real.dataset.json từ CSV export của Sql/sales-history.csv
 * theo Bảng giải thích trường dữ liệu mới (schema 2026-07).
 */
import { readDelimitedFile } from './csv-reader.mjs';
import { isoDateFrom, nullableNumber, requiredNumber, text } from './normalizers.mjs';
import { CONTRACT_VERSION, sha256File, validateDataset, writeDatasetAtomic } from './data-contract.mjs';

const [salesPath = 'Sql/sales-history.csv', outputPath = 'src/assets/demand-planning/datasets/real.dataset.json', runDate = '2026-02-01'] = process.argv.slice(2);

const REQUIRED_COLUMNS = [
  'StoreCode', 'ProductCode', 'Barcode', 'ProductName', 'Date', 'HasSalesRecord',
  'Sales', 'Price', 'PromotionCode', 'PromotionName', 'PromotionStartDate', 'PromotionEndDate',
  'PromotionType', 'PromotionMechanismType', 'PromotionClass', 'OpenStock', 'CloseStock',
  'ReceiptHour', 'StockStatus'
];

const rows = readDelimitedFile(salesPath, REQUIRED_COLUMNS);
if (!rows.length) { console.error('sales-history rỗng.'); process.exit(1); }

// ── 1. Gộp theo (sku, ngày) ───────────
const bySkuDate = new Map();
const promotionIntervalsByKey = new Map();
const statusCounts = {};

for (const row of rows) {
  const skuNum = requiredNumber(row.ProductCode, 'ProductCode');
  const sku = skuNum.toString();
  const date = isoDateFrom(row.Date);
  if (!sku || !date) continue;
  
  const key = `${sku}|${date}`;
  const status = text(row.StockStatus) ?? 'CALCULATED';
  statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  
  const hasSalesRecord = row.HasSalesRecord === '1';
  const salesRaw = text(row.Sales);
  const qty = hasSalesRecord && salesRaw !== 'NULL' && salesRaw !== '' ? requiredNumber(row.Sales, `sales ${key} Sales`) : null;
  const price = nullableNumber(row.Price);
  const openStock = nullableNumber(row.OpenStock);
  const closeStock = nullableNumber(row.CloseStock);
  const promoClass = text(row.PromotionClass) ?? 'NO_PROMOTION';
  
  const promoCodeStr = text(row.PromotionCode);
  const promotionCode = promoCodeStr === 'NULL' || !promoCodeStr ? null : requiredNumber(row.PromotionCode, `PromotionCode ${key}`);
  const promotionName = text(row.PromotionName) === 'NULL' ? null : text(row.PromotionName);
  const promotionStartDate = isoDateFrom(row.PromotionStartDate);
  const promotionEndDate = isoDateFrom(row.PromotionEndDate);
  
  if (promotionCode !== null && promotionStartDate && promotionEndDate) {
    const intervalKey = `${sku}|${promotionCode}|${promotionStartDate}|${promotionEndDate}`;
    promotionIntervalsByKey.set(intervalKey, {
      sku,
      code: promotionCode.toString(),
      name: promotionName,
      startDate: promotionStartDate,
      endDate: promotionEndDate,
      // Class của CTKM (từ tbl_POLPromotion.[Type] IN (2,7) → DEEP_PROMO) — để scaffold
      // phân loại đúng ngày trong khoảng KM không có dòng nguồn, thay vì ép DEEP_PROMO.
      promotionClass: promoClass,
    });
  }
  
  const entry = bySkuDate.get(key) ?? {
    storeCode: requiredNumber(row.StoreCode, 'StoreCode'),
    productCode: skuNum,
    barcode: text(row.Barcode) === 'NULL' ? null : text(row.Barcode),
    productName: text(row.ProductName) === 'NULL' ? null : text(row.ProductName),
    date,
    hasSalesRecord,
    sales: hasSalesRecord ? 0 : null,
    price,
    promotionCode,
    promotionName,
    promotionStartDate,
    promotionEndDate,
    promotionType: nullableNumber(row.PromotionType),
    promotionMechanismType: nullableNumber(row.PromotionMechanismType),
    promotionClass: promoClass,
    openStock,
    closeStock,
    receiptHour: nullableNumber(row.ReceiptHour),
    stockStatus: status,
  };
  
  // Stock là thuộc tính ngày: các dòng cùng SKU-ngày phải mang cùng Open/Close.
  if (entry.openStock !== openStock || entry.closeStock !== closeStock) {
    console.error(`Stock lệch giữa các dòng cùng khóa (${sku}, ${date}): ${entry.openStock}/${entry.closeStock} vs ${openStock}/${closeStock} — export vi phạm PK #StockDaily, export lại.`);
    process.exit(1);
  }
  
  if (hasSalesRecord && qty !== null) {
    entry.sales = (entry.sales ?? 0) + qty;
  }
  bySkuDate.set(key, entry);
}

// ── 2. Daily records ──
const dailyRecords = [];
const skuMeta = new Map(); // sku -> { name, firstPrice, maxClose, lastClose, lastDate }
let maxSalesDate = '';
let maxStockDate = '';
let minDate = '9999-99-99';
let validationRows = 0;

for (const entry of [...bySkuDate.values()].sort((a, b) => a.productCode - b.productCode || a.date.localeCompare(b.date))) {
  const sku = entry.productCode.toString();
  const date = entry.date;
  if (date > maxSalesDate) maxSalesDate = date;
  if (date < minDate) minDate = date;
  const isValidationActual = date >= runDate;
  const stockNull = entry.openStock === null || entry.closeStock === null;
  if (stockNull && !isValidationActual && entry.stockStatus !== 'ANCHOR_MISSING') {
    console.error(`(${sku}, ${date}) là dòng lịch sử nhưng StockStatus=${entry.stockStatus}, tồn=null — hợp đồng bắt buộc dòng lịch sử có bằng chứng tồn.`);
    process.exit(1);
  }
  if (!stockNull && date > maxStockDate) maxStockDate = date;
  if (isValidationActual) validationRows++;
  
  dailyRecords.push(entry);
  
  const price = entry.price;
  const meta = skuMeta.get(sku) ?? { name: entry.productName, firstPrice: null, maxClose: 1, lastClose: 0, lastDate: '' };
  if (meta.firstPrice === null && price) meta.firstPrice = price;
  if (entry.closeStock !== null && entry.closeStock > meta.maxClose) meta.maxClose = entry.closeStock;
  if (entry.closeStock !== null && date >= meta.lastDate) { meta.lastDate = date; meta.lastClose = entry.closeStock; }
  skuMeta.set(sku, meta);
}

console.error(`StockStatus: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.error(`${dailyRecords.length} daily records (dense/scaffolded từ SQL), ${validationRows} dòng >= runDate ${runDate} → isValidationActual.`);

// ── 3. Gate đối soát tồn: chỉ kiểm được cặp ngày LIỀN KỀ cùng có dữ liệu ──────
const mismatchSkus = new Set();
let previous = null;
for (const row of dailyRecords) {
  if (row.openStock === null) { previous = null; continue; }
  if (previous && previous.productCode === row.productCode) {
    const nextDay = new Date(`${previous.date}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (nextDay.toISOString().slice(0, 10) === row.date && previous.closeStock !== row.openStock) {
      mismatchSkus.add(row.productCode.toString());
    }
  }
  previous = row;
}
const stockReconciliation = mismatchSkus.size === 0 ? 'PASS' : 'FAIL';

// ── 4. Products ────
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

const historyYears = new Date(`${runDate}T00:00:00Z`).getUTCFullYear() - new Date(`${minDate}T00:00:00Z`).getUTCFullYear();

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
    cycleLengthDays: 15,
    storeCode: 'GLOBAL_POS',
    storeScopeStatus: 'GLOBAL_POS_AGGREGATE',
    portfolioMode: 'SELECTED_SKU_SIMULATION',
    extractIsTruncated: true,
    sourceWatermarks: { sales: maxSalesDate, stock: maxStockDate },
    extractionCompleted: true,
    qualityGates: { stockReconciliation, stockMismatchSkuCount: mismatchSkus.size },
    rowCounts: { dailyRecords: dailyRecords.length, products: products.length },
    policyOverrides: {},
    sourceFiles: [
      { name: salesPath, sha256: sha256File(salesPath) },
    ],
    warnings: {
      stockJoinStatusCounts: statusCounts,
      inferredZeroSaleDays: 0,
      validationSalesRows: validationRows,
    },
  },
  products,
  dailyRecords,
  promotionIntervals: [...promotionIntervalsByKey.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.startDate.localeCompare(b.startDate) || a.code.localeCompare(b.code)),
};

const errors = validateDataset(dataset);
if (errors.length) {
  console.error(`real.dataset.json KHÔNG đạt hợp đồng (${errors.length} lỗi):`);
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
  if (mismatchSkus.size) console.error(`  SKU lệch tồn: ${[...mismatchSkus].slice(0, 10).join(', ')}${mismatchSkus.size > 10 ? '…' : ''}`);
  process.exit(1);
}

writeDatasetAtomic(outputPath, dataset);
console.log(`Đã ghi ${dailyRecords.length} dòng ngày, ${products.length} SKU (runDate=${runDate}, watermark sales=${maxSalesDate}, stock=${maxStockDate}) vào ${outputPath}`);
