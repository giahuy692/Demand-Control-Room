import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
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
  renameSync(tempPath, outputPath);
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
  if (metadata.qualityGates?.stockReconciliation !== 'PASS') {
    push('STOCK_RECONCILIATION', `gate=${metadata.qualityGates?.stockReconciliation} (${metadata.qualityGates?.stockMismatchSkuCount ?? '?'} SKU lệch tồn) — Critical, không xuất dataset.`);
  }
  if (dataset.datasetKind === 'REAL') {
    if (metadata.calendarScaffold !== 'GLOBAL_WINDOW') push('CALENDAR_SCAFFOLD', 'REAL yêu cầu GLOBAL_WINDOW.');
    if (metadata.runMode !== 'HISTORICAL_VALIDATION') push('RUN_MODE', 'REAL yêu cầu HISTORICAL_VALIDATION.');
    const { sales, stock } = metadata.sourceWatermarks ?? {};
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
    const label = `dailyRecords[${index}] (${row.sku} ${row.date})`;
    if (!productIds.has(row.sku)) push('UNKNOWN_SKU', `${label}: sku không có trong products.`);
    if (!isoDate(row.date)) push('DATE', `${label}: date không hợp lệ.`);
    const key = `${row.sku}|${row.date}`;
    if (seen.has(key)) push('DUPLICATE_DAILY_KEY', `${label}: trùng khóa sku+date.`);
    seen.add(key);
    // Bất biến null/0 cho 3 cặp giá trị/cờ — không suy diễn số khi không có bằng chứng.
    for (const [flag, valueKey] of [['hasSalesRecord', 'sales'], ['hasReturnRecord', 'returnQty'], ['hasInventoryMovement', 'inventoryNetMovement']]) {
      if (typeof row[flag] !== 'boolean') push('PAIR', `${label}: ${flag} phải là boolean.`);
      else if (row[flag] && (typeof row[valueKey] !== 'number' || !Number.isFinite(row[valueKey]))) push('PAIR', `${label}: ${flag}=true nhưng ${valueKey} không phải số hữu hạn.`);
      else if (!row[flag] && row[valueKey] !== null) push('PAIR', `${label}: ${flag}=false nhưng ${valueKey}=${row[valueKey]} — vi phạm null/0.`);
    }
    const stockNull = row.openStock === null;
    if (stockNull !== (row.closeStock === null)) push('STOCK_PAIR', `${label}: openStock/closeStock phải cùng null hoặc cùng số.`);
    if (stockNull && !row.isValidationActual) push('STOCK_PAIR', `${label}: dòng lịch sử bắt buộc có bằng chứng tồn.`);
    if (!stockNull && (!Number.isFinite(row.openStock) || !Number.isFinite(row.closeStock))) push('STOCK_PAIR', `${label}: tồn phải là số hữu hạn.`);
    if (row.isHistoryRecord && row.isValidationActual) push('FLAGS', `${label}: vừa history vừa validation.`);
    if (row.isValidationActual && isoDate(metadata.runDate) && row.date < metadata.runDate) push('VALIDATION_WINDOW', `${label}: isValidationActual trước runDate.`);
  }

  for (const interval of Array.isArray(dataset.promotionIntervals) ? dataset.promotionIntervals : []) {
    if (interval.startDate > interval.endDate) push('PROMO_INTERVAL', `khoảng CTKM ${interval.code}: startDate > endDate.`);
    if (interval.sku !== null && !productIds.has(interval.sku)) push('UNKNOWN_SKU', `promotionIntervals: sku=${interval.sku} không có trong products.`);
  }

  return errors;
}
