import { readFileSync, writeFileSync } from 'node:fs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Dung: node tools/convert-real-data.mjs <input.txt> <output.json>');
  console.error('Input la TSV xuat tu MOT trong ba RESULT SET cua Sql/demand-planing.sql:');
  console.error('  RESULT SET 1 (DailySourceRecord)  -> tu dong nhan dien qua cot HasSalesRecord');
  console.error('  RESULT SET 2 (PromotionInterval)  -> tu dong nhan dien qua cot PromoTypeSource');
  console.error('  RESULT SET 3 (ExtractMetadata)    -> tu dong nhan dien qua cot StockReconciliationGate');
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

// Sales=0 (co dong ban that, tong Qty=0) khac Sales=NULL (khong co dong ban that trong ngay) — KHONG
// duoc coerce ve 0 bang `Number(...) || 0` nhu ban cu; giu nguyen null khi cot nguon la NULL/rong.
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

function bit(value) {
  const normalized = text(value);
  if (normalized === null) return false;
  return ['1', 'TRUE', 'YES', 'Y'].includes(normalized.toUpperCase());
}

function convertDailySourceRecord(rows) {
  const converted = rows
    .map(row => ({
      ExtractId: text(row.ExtractId),
      DataContractVersion: text(row.DataContractVersion),
      StoreCode: text(row.StoreCode),
      SKU: text(row.SKU),
      Date: text(row.Date),
      OpenStock: requiredNumber(row.OpenStock),
      CloseStock: requiredNumber(row.CloseStock),
      Sales: nullableNumber(row.Sales),
      HasSalesRecord: bit(row.HasSalesRecord),
      ReturnQty: nullableNumber(row.ReturnQty),
      HasReturnRecord: bit(row.HasReturnRecord),
      InventoryNetMovement: nullableNumber(row.InventoryNetMovement),
      HasInventoryMovement: bit(row.HasInventoryMovement),
      TotalStockDelta: requiredNumber(row.TotalStockDelta),
      ReceiptHour: text(row.ReceiptHour),
      HasReceiptRecord: bit(row.HasReceiptRecord),
      ReceiptTimeSource: text(row.ReceiptTimeSource),
      PromoCode: text(row.PromoCode),
      PromoName: text(row.PromoName),
      Price: nullableNumber(row.Price),
      ProductName: text(row.ProductName),
      IsOpeningAnchor: bit(row.IsOpeningAnchor),
      IsReferenceOnly: bit(row.IsReferenceOnly),
      IsHistoryRecord: bit(row.IsHistoryRecord),
      IsValidationActual: bit(row.IsValidationActual),
    }))
    .filter(row => row.SKU && row.Date)
    .sort((a, b) => a.SKU.localeCompare(b.SKU) || a.Date.localeCompare(b.Date));
  return { payload: converted, label: 'DailySourceRecord' };
}

function convertPromotionInterval(rows) {
  const converted = rows
    .map(row => ({
      ExtractId: text(row.ExtractId),
      StoreCode: text(row.StoreCode),
      SKU: text(row.SKU),
      PromoCode: text(row.PromoCode),
      PromoName: text(row.PromoName),
      StartDate: text(row.StartDate),
      EndDate: text(row.EndDate),
      PromoTypeSource: text(row.PromoTypeSource),
      IsPOS: bit(row.IsPOS),
      SourceRole: text(row.SourceRole),
    }))
    .filter(row => row.SKU && row.PromoCode);
  return { payload: converted, label: 'PromotionInterval' };
}

function convertExtractMetadata(rows) {
  if (rows.length !== 1) {
    console.error(`Canh bao: ExtractMetadata thuong chi co DUNG 1 dong, nhung doc duoc ${rows.length} dong. Dung dong dau tien.`);
  }
  const row = rows[0] ?? {};
  const payload = {
    ExtractId: text(row.ExtractId),
    QueryVersion: text(row.QueryVersion),
    DataContractVersion: text(row.DataContractVersion),
    DatabaseName: text(row.DatabaseName),
    RunMode: text(row.RunMode),
    RunDate: text(row.RunDate),
    HistoryCandidateStartDate: text(row.HistoryCandidateStartDate),
    ProcessingStartDate: text(row.ProcessingStartDate),
    ProcessingEndDate: text(row.ProcessingEndDate),
    ReferenceReadStartDate: text(row.ReferenceReadStartDate),
    ActualValidationEndDate: text(row.ActualValidationEndDate),
    DatabaseWatermarkDate: text(row.DatabaseWatermarkDate),
    SelectedSkuLastSourceDate: text(row.SelectedSkuLastSourceDate),
    CycleLengthDays: requiredNumber(row.CycleLengthDays),
    FullCycleCount: requiredNumber(row.FullCycleCount),
    DroppedLeadingDays: requiredNumber(row.DroppedLeadingDays),
    AdditionalDaysAfterRunDate: requiredNumber(row.AdditionalDaysAfterRunDate),
    ReferenceDaysBefore: requiredNumber(row.ReferenceDaysBefore),
    StoreCode: text(row.StoreCode),
    StoreScopeStatus: text(row.StoreScopeStatus),
    SelectedSkuCount: requiredNumber(row.SelectedSkuCount),
    PortfolioMode: text(row.PortfolioMode),
    ExtractIsTruncated: bit(row.ExtractIsTruncated),
    StockAnchorAssumption: text(row.StockAnchorAssumption),
    StockReconciliationGate: text(row.StockReconciliationGate),
    StockMismatchSkuCount: requiredNumber(row.StockMismatchSkuCount),
    DailySourceRecordCount: requiredNumber(row.DailySourceRecordCount),
    PromotionIntervalCount: requiredNumber(row.PromotionIntervalCount),
    GeneratedAt: text(row.GeneratedAt),
  };
  return { payload, label: 'ExtractMetadata' };
}

const rows = parseTsv(readFileSync(inputPath, 'utf8'));
if (!rows.length) {
  console.error('Input rong hoac khong doc duoc dong du lieu nao.');
  process.exit(1);
}

const header = new Set(Object.keys(rows[0]));
const { payload, label } = header.has('StockReconciliationGate')
  ? convertExtractMetadata(rows)
  : header.has('HasSalesRecord')
    ? convertDailySourceRecord(rows)
    : header.has('PromoTypeSource')
      ? convertPromotionInterval(rows)
      : (() => {
          console.error('Khong nhan dien duoc loai RESULT SET tu header TSV (thieu HasSalesRecord/PromoTypeSource/StockReconciliationGate).');
          process.exit(1);
        })();

writeFileSync(outputPath, JSON.stringify(payload));
console.log(`Da ghi ${Array.isArray(payload) ? payload.length : 1} dong ${label} vao ${outputPath}`);
