import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CONTRACT_VERSION = 'DEMAND-SIMULATION-DATASET-V1';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** §8.13 — ghi file tạm rồi atomic rename, không bao giờ để lại file đứt giữa chừng. */
export function writeDatasetAtomic(outputPath, dataset) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(dataset));
  try {
    renameSync(tempPath, outputPath);
  } catch (error) {
    if (process.platform !== 'win32' || !existsSync(outputPath)) throw error;
    const backupPath = `${outputPath}.bak`;
    rmSync(backupPath, { force: true });
    renameSync(outputPath, backupPath);
    try {
      renameSync(tempPath, outputPath);
      rmSync(backupPath, { force: true });
    } catch (replaceError) {
      if (existsSync(outputPath)) rmSync(outputPath);
      renameSync(backupPath, outputPath);
      throw replaceError;
    }
  }
}

/**
 * Validator phía CLI cho hợp đồng V1 — bản JS đối chiếu của DemandSimulationDatasetDto
 * (app validate lại lần nữa lúc nạp; đây là gate §8.14 để build fail sớm với exit≠0).
 * Trả mảng lỗi; rỗng = PASS.
 */
export function validateDataset(dataset) {
  const errors = [];
  const push = (gate, message) => errors.push(`[${gate}] ${message}`);

  if (dataset === null || typeof dataset !== 'object' || Array.isArray(dataset)) {
    return ['[SHAPE] payload không phải object JSON.'];
  }
  if (dataset.contractVersion !== CONTRACT_VERSION) push('CONTRACT', `contractVersion=${dataset.contractVersion} — cần ${CONTRACT_VERSION}.`);
  if (!['MOCK', 'REAL'].includes(dataset.datasetKind)) push('CONTRACT', `datasetKind=${dataset.datasetKind} không hợp lệ.`);
  if (typeof dataset.datasetId !== 'string' || !dataset.datasetId) push('CONTRACT', 'thiếu datasetId.');
  if (Number.isNaN(new Date(dataset.generatedAt ?? '').getTime())) push('CONTRACT', 'generatedAt không hợp lệ.');

  const metadata = dataset.metadata;
  if (!metadata || typeof metadata !== 'object') {
    push('CONTRACT', 'thiếu metadata.');
    return errors;
  }
  const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!isoDate(metadata.runDate)) push('CONTRACT', `metadata.runDate=${metadata.runDate} không hợp lệ.`);
  if (typeof metadata.extractionCompleted !== 'boolean') push('CONTRACT', 'metadata.extractionCompleted phải là boolean.');
  const { sales, stock } = metadata.sourceWatermarks ?? {};
  if (!isoDate(sales) || !isoDate(stock)) push('SOURCE_WATERMARK', 'Phải khai sales/stock watermark dạng ISO date.');
  if (metadata.qualityGates?.stockReconciliation !== 'PASS') {
    push('STOCK_RECONCILIATION', `gate=${metadata.qualityGates?.stockReconciliation} (${metadata.qualityGates?.stockMismatchSkuCount ?? '?'} SKU lệch tồn) — Critical, không xuất dataset.`);
  }
  if (dataset.datasetKind === 'REAL') {
    if (metadata.calendarScaffold !== 'GLOBAL_WINDOW') push('CALENDAR_SCAFFOLD', 'REAL yêu cầu GLOBAL_WINDOW.');
    if (metadata.runMode !== 'HISTORICAL_VALIDATION') push('RUN_MODE', 'REAL yêu cầu HISTORICAL_VALIDATION.');
    if (!isoDate(sales) || !isoDate(stock)) push('SOURCE_WATERMARK', 'REAL phải khai watermark sales và stock.');
    else {
      // Lịch sử phải phủ tới runDate−1 (stock backtest cố ý dừng đúng ProcessingEndDate = runDate−1).
      const watermark = sales < stock ? sales : stock;
      const nextDay = new Date(`${watermark}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      if (metadata.runDate > nextDay.toISOString().slice(0, 10)) push('RUN_DATE_WATERMARK', `runDate=${metadata.runDate} vượt watermark ${watermark} (lịch sử phải phủ tới runDate−1).`);
    }
  }

  const products = Array.isArray(dataset.products) ? dataset.products : [];
  const dailyRecords = Array.isArray(dataset.dailyRecords) ? dataset.dailyRecords : [];
  if (!Array.isArray(dataset.products)) push('CONTRACT', 'products phải là mảng.');
  if (!Array.isArray(dataset.dailyRecords)) push('CONTRACT', 'dailyRecords phải là mảng.');
  if (!Array.isArray(dataset.promotionIntervals)) push('CONTRACT', 'promotionIntervals phải là mảng.');

  if (metadata.rowCounts?.dailyRecords !== dailyRecords.length) {
    push('ROW_COUNT', `metadata khai ${metadata.rowCounts?.dailyRecords} dòng, thực tế ${dailyRecords.length}.`);
  }
  if (metadata.rowCounts?.products !== products.length) {
    push('ROW_COUNT', `metadata khai ${metadata.rowCounts?.products} sản phẩm, thực tế ${products.length}.`);
  }

  const productIds = new Set();
  for (const product of products) {
    if (productIds.has(product.id)) push('DUPLICATE_PRODUCT', `sản phẩm ${product.id} lặp lại.`);
    productIds.add(product.id);
  }

  const seen = new Set();
  for (let index = 0; index < dailyRecords.length; index++) {
    const row = dailyRecords[index];
    const skuStr = row.productCode.toString();
    const label = `dailyRecords[${index}] (${skuStr} ${row.date})`;
    const mappedSku = dataset.datasetKind === 'MOCK' ? `SKU-${skuStr.padStart(3, '0')}` : skuStr;
    if (!productIds.has(mappedSku)) push('UNKNOWN_SKU', `${label}: sku không có trong products.`);
    if (row.barcode !== null && (typeof row.barcode !== 'string' || !row.barcode.trim())) push('CONTRACT', `${label}: barcode phải là chuỗi khác rỗng.`);
    if (!isoDate(row.date)) push('DATE', `${label}: date không hợp lệ.`);
    const key = `${skuStr}|${row.date}`;
    if (seen.has(key)) push('DUPLICATE_DAILY_KEY', `${label}: trùng khóa sku+date.`);
    seen.add(key);

    // Bất biến null/0 cho hasSalesRecord / sales
    if (typeof row.hasSalesRecord !== 'boolean') push('PAIR', `${label}: hasSalesRecord phải là boolean.`);
    else if (row.hasSalesRecord && (typeof row.sales !== 'number' || !Number.isFinite(row.sales))) push('PAIR', `${label}: hasSalesRecord=true nhưng sales không phải số hữu hạn.`);
    else if (!row.hasSalesRecord && row.sales !== null) push('PAIR', `${label}: hasSalesRecord=false nhưng sales=${row.sales} — vi phạm null/0.`);

    if (row.sales !== null && row.sales < 0) push('SALES', `${label}: sales phải >= 0.`);
    const stockNull = row.openStock === null;
    if (stockNull !== (row.closeStock === null)) push('STOCK_PAIR', `${label}: openStock/closeStock phải cùng null hoặc cùng số.`);
    
    const isValidationActual = row.date >= metadata.runDate;
    if (stockNull && !isValidationActual && row.stockStatus !== 'ANCHOR_MISSING') {
      push('STOCK_PAIR', `${label}: dòng lịch sử bắt buộc có bằng chứng tồn.`);
    }
    if (!stockNull && (!Number.isFinite(row.openStock) || !Number.isFinite(row.closeStock))) push('STOCK_PAIR', `${label}: tồn phải là số hữu hạn.`);
    if (isValidationActual && isoDate(metadata.runDate) && row.date < metadata.runDate) push('VALIDATION_WINDOW', `${label}: isValidationActual trước runDate.`);

    if (!['CALCULATED', 'NEGATIVE_STOCK', 'ANCHOR_MISSING'].includes(row.stockStatus)) {
      push('STOCK_STATUS', `${label}: stockStatus=${row.stockStatus} không hợp lệ.`);
    }
    if (!['NO_PROMOTION', 'ALWAYS_ON', 'DEEP_PROMO', 'PROMOTION_UNRESOLVED'].includes(row.promotionClass)) {
      push('PROMOTION_CLASS', `${label}: promotionClass=${row.promotionClass} không hợp lệ.`);
    }

    // DTO rule: promotionMechanismType 2 hoặc 7 → bắt buộc DEEP_PROMO
    if ((row.promotionMechanismType === 2 || row.promotionMechanismType === 7) && row.promotionClass !== 'DEEP_PROMO') {
      push('PROMOTION_CLASS', `${label}: promotionMechanismType=${row.promotionMechanismType} yêu cầu promotionClass=DEEP_PROMO.`);
    }

    // DTO rule chiều nghịch: DEEP_PROMO chỉ hợp lệ khi mechanismType ∈ {2, 7}
    if (row.promotionClass === 'DEEP_PROMO' && row.promotionMechanismType !== 2 && row.promotionMechanismType !== 7) {
      push('PROMOTION_CLASS', `${label}: promotionClass=DEEP_PROMO nhưng promotionMechanismType=${row.promotionMechanismType} ∉ {2, 7}.`);
    }

    // DTO rule: NO_PROMOTION không được kèm promotionCode
    if (row.promotionClass === 'NO_PROMOTION' && row.promotionCode !== null) {
      push('PROMOTION_CLASS', `${label}: promotionClass=NO_PROMOTION nhưng có promotionCode=${row.promotionCode}.`);
    }

    // DTO rule: receiptHour phải trong khoảng 0–23
    if (row.receiptHour !== null && (typeof row.receiptHour !== 'number' || !Number.isInteger(row.receiptHour) || row.receiptHour < 0 || row.receiptHour > 23)) {
      push('RECEIPT_HOUR', `${label}: receiptHour=${row.receiptHour} phải là số nguyên trong khoảng 0–23.`);
    }
  }

  for (const interval of Array.isArray(dataset.promotionIntervals) ? dataset.promotionIntervals : []) {
    if (interval.startDate > interval.endDate) push('PROMO_INTERVAL', `khoảng CTKM ${interval.code}: startDate > endDate.`);
    if (interval.sku !== null && !productIds.has(interval.sku)) push('UNKNOWN_SKU', `promotionIntervals: sku=${interval.sku} không có trong products.`);
    // promotionClass vắng mặt được DTO runtime mặc định DEEP_PROMO (tương thích ngược);
    // nhưng nếu có mặt thì phải hợp lệ.
    if (interval.promotionClass !== undefined && !['NO_PROMOTION', 'ALWAYS_ON', 'DEEP_PROMO', 'PROMOTION_UNRESOLVED'].includes(interval.promotionClass)) {
      push('PROMO_INTERVAL', `khoảng CTKM ${interval.code}: promotionClass=${interval.promotionClass} không hợp lệ.`);
    }
  }

  return errors;
}
