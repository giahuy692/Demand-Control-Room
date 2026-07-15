import { DailyRecord, DailySourceRecordV2, ExtractMetadata, HachiBusinessRole, PortfolioMode, SkuDefinition } from './models';

export type DataSourceId = 'mock' | 'real';

export interface SimulationDataset {
  readonly source: DataSourceId;
  readonly label: string;
  readonly catalog: readonly SkuDefinition[];
  readonly dailyBySku: Readonly<Record<string, readonly DailyRecord[]>>;
  readonly audit: readonly string[];
  readonly dateRange?: { min: string; max: string; recommendedRunDate: string };
  /**
   * RULE-01-004/06-001 — ngày nay `ExtractMetadata.PortfolioMode` chưa có trong
   * pipeline ingest (tools/convert-real-data.mjs không mang theo metadata này) —
   * mặc định BẢO THỦ 'SELECTED_SKU_SIMULATION'/`true`, KHÔNG tự nhận là toàn danh
   * mục khi chưa có bằng chứng, để Chặng 6 không tự khóa ABC chính thức [DEC-010].
   */
  readonly portfolioMode: PortfolioMode;
  readonly extractIsTruncated: boolean;
}

function operationalInputs(id: string, type: string, cycles: number): Pick<SkuDefinition, 'supplier' | 'inboundPlan' | 'commitments' | 'futurePromotions' | 'leadTimeHistoryDays' | 'maxStock' | 'warehouseCapacity' | 'shelfLifeDays' | 'purchasePrice' | 'moq' | 'purchaseTermsComplete' | 'actualDemand' | 'actualEndingStock' | 'actualReceiptDelayDays' | 'actualBudgetUsed' | 'heldStock' | 'damagedStock' | 'blockedStock' | 'unsellableStock' | 'displayMinimumStock' | 'unitsPerCarton' | 'orderStep' | 'supplierMinOrderValue' | 'receivingLocation' | 'currency' | 'landedCostPerUnit' | 'coreOrStrategicRole' | 'obsolescenceRiskRank' | 'portfolioMode' | 'extractIsTruncated'> {
  const ordinal = Number(id.slice(-3)) || 1;
  const leadMean = 105 + (ordinal % 3) * 15;
  const active = cycles > 0;
  // "Thực tế" C19 phải TIẾP NỐI đúng mẫu nhu cầu lịch sử của chính SKU (cùng targetForCycle),
  // cộng nhiễu nhẹ và uplift CTKM ở chu kỳ có kế hoạch KM đã xác nhận (cycleOffset 2 & 5 → index 1 & 4).
  const futureRng = random(hashSeed(`${id}:actual`));
  const promoUplift = 1 + (5 / 15) * 0.45; // 5 ngày KM ×1.45 trong chu kỳ 15 ngày
  const actualDemand = active
    ? Array.from({ length: 6 }, (_, index) => {
        const base = targetForCycle(type, cycles + index, futureRng);
        const noisy = base * (0.96 + futureRng() * 0.08);
        return Math.round(index === 1 || index === 4 ? noisy * promoUplift : noisy);
      })
    : [];
  const shelfLifeDays = ordinal % 5 === 0 ? 180 : null;
  return {
    supplier: `NCC-${String((ordinal % 7) + 1).padStart(2, '0')}`,
    inboundPlan: active ? [
      { offsetDays: 45, quantity: 80 + (ordinal % 5) * 20, confirmed: true, label: 'Lô đã xác nhận ETA', reliability: 'shipped-confirmed', receivedQuantity: 0, cancelledQuantity: 0, lotId: `${id}-LOT-1` },
      { offsetDays: 105, quantity: 60 + (ordinal % 4) * 15, confirmed: true, label: 'Lô bổ sung kế tiếp', reliability: 'supplier-confirmed', receivedQuantity: 0, cancelledQuantity: 0, lotId: `${id}-LOT-2` },
      { offsetDays: 75, quantity: 50, confirmed: false, label: 'Lô đang đàm phán — không cộng', reliability: 'planned', receivedQuantity: 0, cancelledQuantity: 0, lotId: `${id}-LOT-3` },
    ] : [],
    commitments: active ? [
      { offsetDays: 15, quantity: 12 + ordinal % 9, label: 'Đơn giữ hàng/điều chuyển' },
      { offsetDays: 60, quantity: 8 + ordinal % 6, label: 'Cam kết kênh bán' },
    ] : [],
    futurePromotions: active ? [
      { cycleOffset: 2, promoDays: 5, code: 'MEMBER', confirmed: true },
      { cycleOffset: 5, promoDays: 5, code: 'MEMBER', confirmed: true },
    ] : [],
    leadTimeHistoryDays: active ? [leadMean - 18, leadMean, leadMean + 18] : [],
    maxStock: 520 + (ordinal % 6) * 80,
    warehouseCapacity: 720 + (ordinal % 5) * 100,
    shelfLifeDays,
    purchasePrice: 28000 + (ordinal % 17) * 12000,
    moq: [12, 24, 36, 48][ordinal % 4],
    purchaseTermsComplete: active && ordinal % 13 !== 0,
    actualDemand,
    actualEndingStock: active ? 25 + ordinal % 80 : 0,
    actualReceiptDelayDays: active ? [ordinal % 4, (ordinal + 1) % 5, ordinal % 3] : [],
    actualBudgetUsed: active ? (250 + ordinal % 160) * (28000 + (ordinal % 17) * 12000) : 0,
    // Chặng 14 §5.1 — CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP cho held/damaged/blocked/unsellable;
    // giữ phần lớn = 0, chỉ đặt vài SKU khác 0 để có ví dụ kiểm toán thật trong dữ liệu giả.
    heldStock: active && ordinal % 9 === 0 ? 8 : 0,
    damagedStock: active && ordinal % 13 === 0 ? 5 : 0,
    blockedStock: 0,
    unsellableStock: 0,
    displayMinimumStock: active ? Math.round(6 + (ordinal % 3) * 4) : 0,
    unitsPerCarton: 1,
    orderStep: 1,
    supplierMinOrderValue: null,
    receivingLocation: 'KGV',
    currency: 'VND',
    landedCostPerUnit: null,
    coreOrStrategicRole: ordinal % 5 === 0 ? 'core' : ordinal % 7 === 0 ? 'strategic' : 'normal',
    obsolescenceRiskRank: shelfLifeDays ? 1 : 0,
    // RULE-01-004 — catalog demo 14 SKU cố định, không phải danh mục thật đầy đủ; không tự nhận FULL_PORTFOLIO.
    portfolioMode: 'SELECTED_SKU_SIMULATION',
    extractIsTruncated: true,
  };
}

const BASE_SKUS: readonly SkuDefinition[] = [
  ['SKU-001', 'Sữa rửa mặt Hada Labo 150ml', 'AX-stable', 189000, 83, 'Ổn định, lịch sử đủ dài', 'Chăm sóc da'],
  ['SKU-002', 'Kem chống nắng Anessa 60ml', 'AY-seasonal', 450000, 72, 'Mùa vụ 24 chu kỳ lặp 3 vòng', 'Chăm sóc da'],
  ['SKU-003', 'Dầu gội Tsubaki 500ml', 'AZ-intermittent', 320000, 24, 'Phát sinh mỗi 3 chu kỳ', 'Chăm sóc tóc'],
  ['SKU-004', 'Serum retinol The Ordinary 30ml', 'BX-trend-up', 380000, 24, 'Tăng trưởng có kiểm soát', 'Chăm sóc da'],
  ['SKU-005', 'Nước tẩy trang Bioderma 500ml', 'BY-trend-volatile', 290000, 60, 'Dao động mạnh và có xu hướng', 'Chăm sóc da'],
  ['SKU-006', 'Tinh dầu tràm Bosisto 50ml', 'BZ-sparse', 165000, 24, 'Chỉ vài chu kỳ có nhu cầu', 'Mẹ & bé'],
  ['SKU-007', 'Sáp thơm Yankee Candle', 'BY-short', 250000, 8, 'Lịch sử ngắn, cần thận trọng', 'Nhà cửa'],
  ['SKU-008', 'Bông tẩy trang Miniso 200p', 'CX-boundary', 55000, 24, 'Chuỗi nhu cầu ở vùng biên', 'Chăm sóc da'],
  ['SKU-009', 'Khẩu trang y tế Unicharm 50c', 'CY-volatile', 85000, 36, 'Dao động mạnh, không mùa vụ', 'Sức khỏe'],
  ['SKU-010', 'Kẹo dừa Bến Tre hộp 200g', 'CZ-single', 45000, 24, 'Một lần phát sinh', 'Thực phẩm'],
  ['SKU-011', 'Son môi mới ra mắt XYZ', 'NEW', 299000, 0, 'Sản phẩm mới, chưa có lịch sử', 'Trang điểm'],
  ['SKU-012', 'Kem dưỡng Laneige mini 15ml', 'ONE-CYCLE', 220000, 1, 'Một chu kỳ bán thật', 'Chăm sóc da'],
  ['SKU-013', 'Nước hoa Adopt 30ml', 'FIVE-CYCLES', 350000, 5, 'Chưa đủ sáu chu kỳ', 'Nước hoa'],
  ['SKU-014', 'Trà matcha Nhật lon 330ml', 'D-zero-stock', 42000, 6, 'Sáu chu kỳ nhu cầu bằng 0', 'Thực phẩm'],
].map(([id, name, type, price, cycles, description, category]) => ({
  id: id as string,
  name: name as string,
  type: type as string,
  price: price as number,
  cycles: cycles as number,
  description: description as string,
  category: category as string,
  ...operationalInputs(id as string, type as string, cycles as number),
}));

const NAMES = ['Sữa rửa mặt CeraVe', 'Kem chống nắng Biore', 'Nước ép Kagome', 'Cà phê Blendy', 'Snack Jagabee', 'Hộp thực phẩm', 'Bút gel cao cấp', 'Bình sữa', 'Tã dán trẻ em', 'Cáp sạc nhanh'];
const TYPES = ['AX-stable', 'AY-seasonal', 'AZ-intermittent', 'BX-trend-up', 'BY-trend-volatile', 'BZ-sparse', 'CX-boundary', 'CY-volatile', 'CZ-single'];

export function buildCatalog(): SkuDefinition[] {
  return [...BASE_SKUS];
}

function hashSeed(text: string): number {
  return [...text].reduce((seed, char) => (seed * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
}

function random(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

// Mảng rỗng dùng chung cho mọi bản ghi chưa audit; applyReferenceAudit luôn thay bằng mảng mới nên không bị ghi đè.
const EMPTY_DATES = Object.freeze([]) as unknown as string[];

/**
 * Yêu cầu cập nhật nguồn dữ liệu thật §4 — `sales` nay là `number | null`: `null` khi không có bằng
 * chứng bán POS thật trong ngày (khác `0` = có dòng bán thật với tổng Qty bằng 0). Dữ liệu giả
 * (`generateDailyRecords`) luôn truyền số cụ thể nên không đổi hành vi cũ.
 */
function dailyRecord(sku: string, date: string, openStock: number, closeStock: number, sales: number | null, receiptHour: string | null, promoCode: string | null, hasRecord = true, isZeroSaleInferred = false): DailyRecord {
  return {
    sku, date, openStock, closeStock, sales, hasRecord, isZeroSaleInferred, receiptHour, promoCode,
    salesStatus: sales === null ? 'SOURCE_UNKNOWN' : sales > 0 ? 'OBSERVED' : 'OBSERVED_ZERO', isReferenceOnly: false,
    // Dữ liệu giả/nguồn thật trước scaffold luôn coi là đã tính được (không có mốc bị thiếu);
    // buildCalendarScaffold() sẽ tính lại đúng theo bất biến RULE-02-003 khi ghép vào lịch liên tục.
    stockSource: 'OBSERVED', stockCalculationStatus: openStock < 0 || closeStock < 0 ? 'NEGATIVE_REVIEW' : 'CALCULATED',
    isStockout: false, stockoutReason: null, stockoutReviewRequired: false, baseDemand: null, baseSource: null,
    referenceDates: EMPTY_DATES, beforeReferenceDates: EMPTY_DATES, afterReferenceDates: EMPTY_DATES, referenceMedian: null,
    balanceStatus: null, selectionReason: '',
  };
}

interface CalendarDay { iso: string; month: number; dayOfMonth: number }

// Lịch dùng chung cho mọi SKU cùng runDate: index k = ngày thứ k trước runDate.
let calendarKey = '';
let calendarDays: CalendarDay[] = [];

function getCalendar(runDate: string, totalDays: number): CalendarDay[] {
  if (calendarKey !== runDate) {
    calendarKey = runDate;
    calendarDays = [{ iso: runDate, month: 0, dayOfMonth: 0 }];
  }
  const end = new Date(`${runDate}T00:00:00Z`);
  while (calendarDays.length <= totalDays) {
    const date = addDays(end, -calendarDays.length);
    calendarDays.push({ iso: date.toISOString().slice(0, 10), month: date.getUTCMonth() + 1, dayOfMonth: date.getUTCDate() });
  }
  return calendarDays;
}

function targetForCycle(type: string, cycle: number, rng: () => number): number {
  if (type === 'D-zero-stock') return 0;
  if (type === 'AZ-intermittent') return cycle % 3 === 2 ? 90 : 0;
  if (type === 'BZ-sparse') return cycle === 7 || cycle === 18 ? 42 : 0;
  if (type === 'CZ-single') return cycle === 11 ? 36 : 0;
  if (type === 'BY-short') return cycle % 2 ? 18 : 2;
  if (type === 'CX-boundary') return cycle % 2 ? 16 : 3;
  if (type === 'BX-trend-up') return Math.round(24 * 1.06 ** cycle);
  if (type === 'BY-trend-volatile') return Math.round((65 + cycle * 1.4) * [0.35, 1.85, 0.55, 1.5][cycle % 4]);
  if (type === 'CY-volatile') return Math.round(55 * [0.2, 2.5, 0.45, 1.9, 0.3, 2.8][cycle % 6]);
  if (type === 'AY-seasonal') return [20, 25, 30, 45, 65, 96, 150, 220, 170, 110, 70, 50, 30, 25, 20, 15, 20, 25, 35, 50, 65, 80, 55, 35][cycle % 24];
  return Math.round(95 + (rng() - 0.5) * 12);
}

export function generateDailyRecords(definition: SkuDefinition, runDate: string, cycleLength: number, maxCycles = definition.cycles): DailyRecord[] {
  if (!definition.cycles) return [];
  const rng = random(hashSeed(definition.id));
  const totalDays = Math.min(definition.cycles, maxCycles) * cycleLength;
  const calendar = getCalendar(runDate, totalDays);
  const records: DailyRecord[] = [];
  let stock = Math.max(80, Math.round(targetForCycle(definition.type, 0, rng) * 4));
  for (let day = 0; day < totalDays; day++) {
    const cycle = Math.floor(day / cycleLength);
    const target = targetForCycle(definition.type, cycle, rng);
    const dailyTarget = target / cycleLength;
    const { iso, month, dayOfMonth: dateOfMonth } = calendar[totalDays - day];
    const promoCode = dateOfMonth >= 5 && dateOfMonth <= 7 && [3, 6, 9, 12].includes(month) ? 'MEMBER' : null;
    const naturalSales = Math.max(0, Math.round(dailyTarget + (rng() - 0.5) * Math.max(1, dailyTarget * 0.2)));
    const sales = promoCode ? Math.round(naturalSales * 1.45) : naturalSales;
    const forcedLateReceipt = day > 0 && day % 137 === 0;
    const emptyAllDay = day > 0 && day % 223 === 0;
    const openStock = forcedLateReceipt || emptyAllDay ? 0 : stock;
    const sold = Math.min(openStock, sales);
    const receiptHour = forcedLateReceipt ? '13:00' : stock < target * 2 ? '09:00' : null;
    const receipt = receiptHour ? Math.max(30, Math.round(target * 4)) : 0;
    const closeStock = emptyAllDay ? 0 : Math.max(0, openStock - sold + receipt);
    records.push(dailyRecord(definition.id, iso, openStock, closeStock, sold, receiptHour, promoCode));
    stock = closeStock;
  }
  return records;
}

interface ProductMeta {
  readonly name: string | null;
  readonly category: string;
  readonly supplier: string;
  readonly price: number;
  readonly purchasePrice: number;
  readonly description?: string;
}

/**
 * RESULT SET 3 (`ExtractMetadata`) của `Sql/demand-planing.sql` (demand-planing-v6-pos-real-backtest),
 * đọc từ asset JSON RIÊNG, optional — xem ghi chú ở `SimulationStore.loadRealDataset`. Trả `null` khi
 * payload rỗng/không hợp lệ — caller PHẢI giữ mặc định bảo thủ hiện có, không suy diễn.
 */
export function parseExtractMetadata(payload: string): ExtractMetadata | null {
  if (!payload || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    // fetchTextOptional() trả về '[]' khi asset vắng mặt (quy ước dùng chung cho các asset optional dạng
    // mảng như List-product.json) — ExtractMetadata là MỘT object, nên mảng/giá trị không phải object đều
    // coi như "chưa có metadata", không phải "metadata rỗng".
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const portfolioModeText = textCell(raw['PortfolioMode']);
    // SINGLE_SKU_DIAGNOSTIC (02-Hop-dong-du-lieu-dau-vao.md §3.3) chưa có khái niệm tương ứng trong
    // PortfolioMode nội bộ — quy về SELECTED_SKU_SIMULATION (bảo thủ, không tự nhận FULL_PORTFOLIO).
    const portfolioMode: PortfolioMode = portfolioModeText === 'FULL_PORTFOLIO' || portfolioModeText === 'USE_APPROVED_SNAPSHOT' ? portfolioModeText : 'SELECTED_SKU_SIMULATION';
    const gateText = textCell(raw['StockReconciliationGate']);
    return {
      extractId: textCell(raw['ExtractId']) ?? '',
      queryVersion: textCell(raw['QueryVersion']) ?? '',
      dataContractVersion: textCell(raw['DataContractVersion']) ?? '',
      runMode: textCell(raw['RunMode']) ?? '',
      runDate: textCell(raw['RunDate']) ?? '',
      historyCandidateStartDate: textCell(raw['HistoryCandidateStartDate']) ?? '',
      processingStartDate: textCell(raw['ProcessingStartDate']) ?? '',
      processingEndDate: textCell(raw['ProcessingEndDate']) ?? '',
      referenceReadStartDate: textCell(raw['ReferenceReadStartDate']) ?? '',
      actualValidationEndDate: textCell(raw['ActualValidationEndDate']) ?? '',
      databaseWatermarkDate: textCell(raw['DatabaseWatermarkDate']) ?? '',
      cycleLengthDays: numberCell(raw['CycleLengthDays'], 0),
      fullCycleCount: numberCell(raw['FullCycleCount'], 0),
      droppedLeadingDays: numberCell(raw['DroppedLeadingDays'], 0),
      storeCode: textCell(raw['StoreCode']) ?? '',
      selectedSkuCount: numberCell(raw['SelectedSkuCount'], 0),
      portfolioMode,
      extractIsTruncated: booleanCell(raw['ExtractIsTruncated'], true),
      stockAnchorAssumption: textCell(raw['StockAnchorAssumption']) ?? '',
      // Gate vắng mặt/không hợp lệ được coi là FAIL — không được mặc định PASS khi chưa chắc chắn.
      stockReconciliationGate: gateText === 'PASS' ? 'PASS' : 'FAIL',
      stockMismatchSkuCount: numberCell(raw['StockMismatchSkuCount'], 0),
      dailySourceRecordCount: numberCell(raw['DailySourceRecordCount'], 0),
      promotionIntervalCount: numberCell(raw['PromotionIntervalCount'], 0),
      generatedAt: textCell(raw['GeneratedAt']) ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * §7 LỆNH CODEX — benchmark HachiBusinessRole, nạp từ asset JSON RIÊNG (`src/assets/hachi-business-roles.json`),
 * KHÔNG phải từ pipeline SQL/ingest thật. Trả map rỗng khi payload rỗng/không hợp lệ — không bao giờ suy đoán.
 */
export function parseHachiBusinessRoles(payload: string): Readonly<Record<string, HachiBusinessRole>> {
  if (!payload || !payload.trim()) return {};
  const VALID_ROLES: readonly HachiBusinessRole[] = ['CORE', 'SEASONAL', 'MARGIN', 'TRAFFIC', 'NEW', 'STANDARD'];
  try {
    const rows = JSON.parse(payload) as unknown;
    if (!Array.isArray(rows)) return {};
    const map: Record<string, HachiBusinessRole> = {};
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const sku = textCell(row['SKU'] ?? row['sku']);
      const role = textCell(row['HachiBusinessRole'] ?? row['BusinessRole']) as HachiBusinessRole | null;
      if (sku && role && VALID_ROLES.includes(role)) map[sku] = role;
    }
    return map;
  } catch {
    return {};
  }
}

export function parseRealDataset(dailyPayload: string, productPayload: string, extractMetadataPayload = ''): SimulationDataset {
  const dailySourceName = isJsonPayload(dailyPayload) ? 'demand-planning-real.json' : 'demand-planning-real.csv';
  const productById = parseProducts(productPayload);
  // §9 — đọc ExtractMetadata thật khi asset có sẵn thay vì hard-code; vắng mặt thì GIỮ mặc định
  // bảo thủ cũ (SELECTED_SKU_SIMULATION/extractIsTruncated=true), không suy diễn ngược từ dữ liệu daily.
  const extractMetadata = parseExtractMetadata(extractMetadataPayload);
  // §9 Yêu cầu cập nhật nguồn dữ liệu thật — gate đối soát tồn PHẢI PASS trước khi dữ liệu được nạp vào
  // mô phỏng; khi metadata có mặt nhưng gate FAIL, KHÔNG được fallback âm thầm sang dữ liệu giả.
  if (extractMetadata && extractMetadata.stockReconciliationGate !== 'PASS') {
    throw new Error(`ExtractMetadata.StockReconciliationGate=FAIL (${extractMetadata.stockMismatchSkuCount} SKU lệch tồn) — không nạp dữ liệu thật vào mô phỏng. Kiểm tra lại mapping/lịch sử nguồn trước khi export lại.`);
  }
  const portfolioMode: PortfolioMode = extractMetadata?.portfolioMode ?? 'SELECTED_SKU_SIMULATION';
  const extractIsTruncated = extractMetadata ? extractMetadata.portfolioMode !== 'FULL_PORTFOLIO' : true;
  const dailyBySku: Record<string, DailyRecord[]> = {};
  const dailyMeta = new Map<string, { price: number; name: string | null }>();

  for (const row of parseDailyPayload(dailyPayload, dailySourceName)) {
    const sku = row.sku;
    const date = row.date;
    if (!sku || !date) continue;
    // §4/§6 — không ép record thô vào DailyRecord quá sớm: chỉ opening-anchor bị loại hẳn (chỉ dùng để
    // thiết lập trạng thái tồn trước khung đọc, không phải ngày lịch sử); mọi ngày khác giữ nguyên, kể
    // cả `sales=null` (hasSalesRecord=false) — buildCalendarScaffold ở Chặng 1 xử lý phần còn lại.
    if (row.isOpeningAnchor) continue;
    (dailyBySku[sku] ??= []).push(dailyRecord(
      sku,
      date,
      row.openStock,
      row.closeStock,
      row.sales,
      row.receiptHour,
      row.promoCode,
      // DailyRecord.hasRecord nghĩa là "sales đã quan sát được, dùng làm nền tham chiếu" (xem
      // requireObservedSales/isObservedClean) — KHÔNG phải row.hasRecord của DailySourceRecordV2
      // (luôn = true, chỉ nghĩa là "ngày này có dòng trong RESULT SET 1"). Ngày có InventoryNetMovement/
      // ReturnQty nhưng hasSalesRecord=false vẫn phải hasRecord=false ở đây, nếu không requireObservedSales
      // sẽ throw khi Chặng 3 gom ngày sạch.
      row.hasSalesRecord,
      row.isZeroSaleInferred ?? false,
    ));
    const current = dailyMeta.get(sku);
    if (!current || (!current.name && row.productName) || (!current.price && row.price)) dailyMeta.set(sku, { price: row.price || current?.price || 0, name: row.productName ?? current?.name ?? null });
  }

  const catalog = Object.keys(dailyBySku).sort().map(id => {
    const product = productById.get(id);
    const meta = dailyMeta.get(id);
    const price = meta?.price || product?.price || 0;
    const purchasePrice = product?.purchasePrice || (price ? Math.round(price * 0.75) : 0);
    const records = dailyBySku[id].sort((a, b) => a.date.localeCompare(b.date));
    const maxStock = Math.max(1, ...records.map(row => row.closeStock));
    return {
      id,
      name: meta?.name ?? product?.name ?? `SKU ${id}`,
      type: 'REAL',
      price,
      cycles: 0,
      description: product?.description ?? `Dữ liệu thật từ ${dailySourceName}`,
      category: product?.category ?? 'ERP',
      supplier: product?.supplier ?? 'Chưa map NCC',
      inboundPlan: [],
      commitments: [],
      futurePromotions: [],
      leadTimeHistoryDays: [],
      maxStock,
      warehouseCapacity: Math.max(maxStock, Math.ceil(maxStock * 1.25)),
      shelfLifeDays: null,
      purchasePrice,
      moq: 1,
      purchaseTermsComplete: purchasePrice > 0,
      actualDemand: [],
      actualEndingStock: records.at(-1)?.closeStock ?? 0,
      actualReceiptDelayDays: [],
      actualBudgetUsed: 0,
      // Dữ liệu ERP thật hiện chưa có cột nguồn cho các trường Chặng 14–17 dưới đây
      // (Sql/demand-planing-data-source-notes.md §9.2) — giữ mặc định trung tính để
      // logic mới suy biến về đúng hành vi cũ, không tự loại bỏ SKU nào.
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
      coreOrStrategicRole: 'normal' as const,
      obsolescenceRiskRank: 0,
      // §9 LỆNH CODEX/RULE-01-004 — đọc từ ExtractMetadata khi có (xem trên); vắng mặt thì bảo thủ
      // SELECTED_SKU_SIMULATION/true như trước, không tự nhận là toàn danh mục.
      portfolioMode,
      extractIsTruncated,
    };
  });

  if (!catalog.length) throw new Error(`Không đọc được SKU nào từ ${dailySourceName}.`);
  const allDates = Object.values(dailyBySku).flatMap(rows => rows.map(row => row.date)).sort();
  const minDate = allDates[0];
  const maxDate = allDates.at(-1)!;
  // §6 — recommendedRunDate PHẢI ưu tiên ExtractMetadata.RunDate (ngày chạy chính thức của lượt trích
  // xuất); chỉ suy ra ngày đầu tháng từ maxDate khi hoàn toàn không có metadata.
  const recommendedRunDate = extractMetadata?.runDate || `${maxDate.slice(0, 8)}01`;
  return {
    source: 'real',
    label: 'Dữ liệu thật',
    catalog,
    dailyBySku,
    dateRange: { min: minDate, max: maxDate, recommendedRunDate },
    // §9 — đọc từ ExtractMetadata khi asset có sẵn; vắng mặt thì giữ mặc định bảo thủ cũ (RESULT SET 3
    // chưa được ingest — xem `parseExtractMetadata`).
    portfolioMode,
    extractIsTruncated,
    audit: [
      `Đọc ${catalog.length} SKU và ${Object.values(dailyBySku).reduce((sum, rows) => sum + rows.length, 0)} dòng daily từ ${dailySourceName}.`,
      extractMetadata
        ? `[§9][ExtractMetadata] Đã đọc extractId=${extractMetadata.extractId || '—'}, queryVersion=${extractMetadata.queryVersion || '—'}, gate=${extractMetadata.stockReconciliationGate} — portfolioMode/extractIsTruncated/recommendedRunDate lấy từ metadata thật.`
        : `[§9][ExtractMetadata] Không có asset ExtractMetadata trong pipeline ingest hiện tại — giữ mặc định bảo thủ portfolioMode=SELECTED_SKU_SIMULATION/extractIsTruncated=true, recommendedRunDate suy từ maxDate.`,
    ],
  };
}

/**
 * Yêu cầu cập nhật nguồn dữ liệu thật §4/§6 — một cặp giá trị/cờ (Sales/HasSalesRecord,
 * ReturnQty/HasReturnRecord, InventoryNetMovement/HasInventoryMovement) trong hợp đồng DAILY-SOURCE-V2.
 * Bất biến bắt buộc: `hasRecord=false ⇒ value=null` và `hasRecord=true ⇒ value là số cụ thể`. Không bao
 * giờ suy diễn 0 khi không có bằng chứng, không bao giờ giữ số khi cờ nói không có bằng chứng.
 */
function parseNullablePair(row: Record<string, unknown>, valueKey: string, flagKey: string, sourceName: string, index: number, required: boolean): { value: number | null; hasRecord: boolean } {
  if (row[flagKey] === undefined) {
    if (required) throw new Error(`${sourceName} dòng ${index + 1}: thiếu cột ${flagKey} (hợp đồng DAILY-SOURCE-V2 bắt buộc).`);
    return { value: null, hasRecord: false };
  }
  const hasRecord = booleanCell(row[flagKey], false);
  const rawValue = textCell(row[valueKey]);
  if (hasRecord && rawValue === null) throw new Error(`${sourceName} dòng ${index + 1}: ${flagKey}=true nhưng ${valueKey} rỗng.`);
  if (!hasRecord && rawValue !== null) throw new Error(`${sourceName} dòng ${index + 1}: ${flagKey}=false nhưng ${valueKey}=${rawValue} — vi phạm bất biến null/0 (không được suy diễn số khi không có bằng chứng).`);
  return { value: hasRecord ? requiredNumber(row[valueKey], `${sourceName} dòng ${index + 1}: ${valueKey}`) : null, hasRecord };
}

const RECEIPT_TIME_SOURCES: readonly string[] = ['RECEIPT_DATE', 'CREATE_TIME_FALLBACK', 'UNRESOLVED'];

/**
 * Parse MỘT dòng thô (đã ở dạng key/value — JSON row hoặc CSV row đã map theo header) thành
 * `DailySourceRecordV2`. Dùng chung cho cả JSON và CSV để không lặp logic validate hai lần.
 */
function parseDailySourceRow(row: Record<string, unknown>, sourceName: string, index: number): DailySourceRecordV2 {
  const sales = parseNullablePair(row, 'Sales', 'HasSalesRecord', sourceName, index, true);
  const returns = parseNullablePair(row, 'ReturnQty', 'HasReturnRecord', sourceName, index, false);
  const movement = parseNullablePair(row, 'InventoryNetMovement', 'HasInventoryMovement', sourceName, index, false);
  const receiptTimeSourceText = textCell(row['ReceiptTimeSource']);
  const priceText = textCell(row['Price']);
  return {
    sku: textCell(row['SKU'] ?? row['sku']) ?? '',
    date: textCell(row['Date'] ?? row['date']) ?? '',
    openStock: requiredNumber(row['OpenStock'], `${sourceName} dòng ${index + 1}: OpenStock`),
    closeStock: requiredNumber(row['CloseStock'], `${sourceName} dòng ${index + 1}: CloseStock`),
    sales: sales.value,
    hasSalesRecord: sales.hasRecord,
    isZeroSaleInferred: booleanCell(row['IsZeroSaleInferred'], false),
    returnQty: returns.value,
    hasReturnRecord: returns.hasRecord,
    inventoryNetMovement: movement.value,
    hasInventoryMovement: movement.hasRecord,
    totalStockDelta: numberCell(row['TotalStockDelta'], 0),
    receiptHour: textCell(row['ReceiptHour']),
    hasReceiptRecord: booleanCell(row['HasReceiptRecord'], false),
    receiptTimeSource: receiptTimeSourceText && RECEIPT_TIME_SOURCES.includes(receiptTimeSourceText) ? receiptTimeSourceText as DailySourceRecordV2['receiptTimeSource'] : null,
    promoCode: textCell(row['PromoCode']) ?? textCell(row['PromoName']),
    promoName: textCell(row['PromoName']),
    price: priceText === null ? null : numberCell(row['Price'], 0),
    productName: textCell(row['ProductName']),
    hasRecord: true,
    isOpeningAnchor: booleanCell(row['IsOpeningAnchor'], false),
    isReferenceOnly: booleanCell(row['IsReferenceOnly'], false),
    isHistoryRecord: booleanCell(row['IsHistoryRecord'], false),
    isValidationActual: booleanCell(row['IsValidationActual'], false),
  };
}

function parseDailyPayload(payload: string, sourceName: string): DailySourceRecordV2[] {
  if (isJsonPayload(payload)) return parseDailyJson(payload, sourceName);
  return parseCsvWithHeader(payload, sourceName).map((row, index) => parseDailySourceRow(row, sourceName, index));
}

function parseDailyJson(payload: string, sourceName: string): DailySourceRecordV2[] {
  const rows = parseJsonArray(payload, sourceName);
  return rows.map((raw, index) => parseDailySourceRow(raw as Record<string, unknown>, sourceName, index));
}

function parseProducts(payload: string): Map<string, ProductMeta> {
  const products = new Map<string, ProductMeta>();
  if (isJsonPayload(payload)) {
    for (const raw of parseJsonArray(payload, 'List-product.json')) {
      const row = raw as Record<string, unknown>;
      const id = textCell(row['Product']);
      if (!id) continue;
      const price = numberCell(row['PriceCandidate'], 0);
      const demandShape = textCell(row['ApproxDemandShape']);
      const name = textCell(row['ProductName']) ?? textCell(row['Name']) ?? textCell(row['ProductNameVi']);
      const coverageScore = numberCell(row['CoverageScore'], NaN);
      products.set(id, {
        name,
        category: demandShape ? `Dạng nhu cầu ${demandShape}` : 'ERP',
        supplier: 'Chưa map NCC',
        price,
        purchasePrice: price ? Math.round(price * 0.75) : 0,
        description: [
          'Dữ liệu thật từ demand-planning-real.json',
          demandShape ? `mẫu nhu cầu ${demandShape}` : '',
          Number.isFinite(coverageScore) ? `điểm phủ ${coverageScore}` : '',
        ].filter(Boolean).join('; '),
      });
    }
    return products;
  }
  for (const row of parseCsv(payload)) {
    const id = textCell(row[0]);
    if (!id) continue;
    products.set(id, {
      name: textCell(row[3]) ?? textCell(row[4]) ?? `SKU ${id}`,
      category: textCell(row[9]) ? `Nhóm ERP ${textCell(row[9])}` : 'ERP',
      supplier: textCell(row[38]) ?? textCell(row[39]) ?? 'Chưa map NCC',
      price: numberCell(row[17], 0),
      purchasePrice: numberCell(row[19], 0),
    });
  }
  return products;
}

/**
 * Yêu cầu cập nhật nguồn dữ liệu thật §6 — CSV giờ đọc theo TÊN HEADER (dòng đầu tiên), không còn theo
 * vị trí cột cố định, để khớp đúng tên cột của hợp đồng DAILY-SOURCE-V2 (SKU/Date/OpenStock/.../
 * IsValidationActual) bất kể thứ tự cột trong file export.
 */
function parseCsvWithHeader(payload: string, sourceName: string): Record<string, string>[] {
  const rows = parseCsv(payload);
  if (!rows.length) return [];
  const header = rows[0].map(cell => cell.trim());
  return rows.slice(1).map((row, index) => {
    if (row.length !== header.length) throw new Error(`${sourceName} dòng ${index + 2}: số cột (${row.length}) không khớp header (${header.length}).`);
    return Object.fromEntries(header.map((name, column) => [name, row[column]]));
  });
}

function isJsonPayload(payload: string): boolean {
  const first = payload.trimStart()[0];
  return first === '[' || first === '{';
}

function parseJsonArray(payload: string, sourceName: string): unknown[] {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    throw new Error(`${sourceName} không phải JSON hợp lệ.`);
  }
  throw new Error(`${sourceName} phải là mảng JSON.`);
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  row.push(field);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

function textCell(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text && text.toUpperCase() !== 'NULL' ? text : null;
}

function numberCell(value: unknown, fallback: number): number {
  const text = textCell(value);
  const number = text === null ? NaN : Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function booleanCell(value: unknown, fallback: boolean): boolean {
  const text = textCell(value);
  return text === null ? fallback : !['0', 'FALSE', 'NO', 'N'].includes(text.toUpperCase());
}

function requiredNumber(value: unknown, label: string): number {
  const number = numberCell(value, NaN);
  if (!Number.isFinite(number)) throw new Error(`${label} không hợp lệ.`);
  return number;
}
