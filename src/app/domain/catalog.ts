import { DailyRecord, SkuDefinition } from './models';

export type DataSourceId = 'mock' | 'real';

export interface SimulationDataset {
  readonly source: DataSourceId;
  readonly label: string;
  readonly catalog: readonly SkuDefinition[];
  readonly dailyBySku: Readonly<Record<string, readonly DailyRecord[]>>;
  readonly audit: readonly string[];
  readonly dateRange?: { min: string; max: string; recommendedRunDate: string };
}

function operationalInputs(id: string, type: string, cycles: number): Pick<SkuDefinition, 'supplier' | 'inboundPlan' | 'commitments' | 'futurePromotions' | 'leadTimeHistoryDays' | 'maxStock' | 'warehouseCapacity' | 'shelfLifeDays' | 'purchasePrice' | 'moq' | 'purchaseTermsComplete' | 'actualDemand' | 'actualEndingStock' | 'actualReceiptDelayDays' | 'actualBudgetUsed'> {
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
  return {
    supplier: `NCC-${String((ordinal % 7) + 1).padStart(2, '0')}`,
    inboundPlan: active ? [
      { offsetDays: 45, quantity: 80 + (ordinal % 5) * 20, confirmed: true, label: 'Lô đã xác nhận ETA' },
      { offsetDays: 105, quantity: 60 + (ordinal % 4) * 15, confirmed: true, label: 'Lô bổ sung kế tiếp' },
      { offsetDays: 75, quantity: 50, confirmed: false, label: 'Lô đang đàm phán — không cộng' },
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
    shelfLifeDays: ordinal % 5 === 0 ? 180 : null,
    purchasePrice: 28000 + (ordinal % 17) * 12000,
    moq: [12, 24, 36, 48][ordinal % 4],
    purchaseTermsComplete: active && ordinal % 13 !== 0,
    actualDemand,
    actualEndingStock: active ? 25 + ordinal % 80 : 0,
    actualReceiptDelayDays: active ? [ordinal % 4, (ordinal + 1) % 5, ordinal % 3] : [],
    actualBudgetUsed: active ? (250 + ordinal % 160) * (28000 + (ordinal % 17) * 12000) : 0,
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

function dailyRecord(sku: string, date: string, openStock: number, closeStock: number, sales: number, receiptHour: string | null, promoCode: string | null): DailyRecord {
  return {
    sku, date, openStock, closeStock, sales, receiptHour, promoCode,
    isStockout: false, stockoutReason: null, baseDemand: null, baseSource: null,
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

interface ParsedDailyRow {
  readonly sku: string | null;
  readonly date: string | null;
  readonly openStock: number;
  readonly closeStock: number;
  readonly sales: number;
  readonly receiptHour: string | null;
  readonly promoCode: string | null;
  readonly price: number;
  readonly name: string | null;
}

interface ProductMeta {
  readonly name: string | null;
  readonly category: string;
  readonly supplier: string;
  readonly price: number;
  readonly purchasePrice: number;
  readonly description?: string;
}

export function parseRealDataset(dailyPayload: string, productPayload: string): SimulationDataset {
  const dailySourceName = isJsonPayload(dailyPayload) ? 'demand-planning-real.json' : 'demand-planning-real.csv';
  const productById = parseProducts(productPayload);
  const dailyBySku: Record<string, DailyRecord[]> = {};
  const dailyMeta = new Map<string, { price: number; name: string | null }>();

  for (const row of parseDailyPayload(dailyPayload, dailySourceName)) {
    const sku = row.sku;
    const date = row.date;
    if (!sku || !date) continue;
    (dailyBySku[sku] ??= []).push(dailyRecord(
      sku,
      date,
      row.openStock,
      row.closeStock,
      row.sales,
      row.receiptHour,
      row.promoCode,
    ));
    const current = dailyMeta.get(sku);
    if (!current || (!current.name && row.name) || (!current.price && row.price)) dailyMeta.set(sku, { price: row.price || current?.price || 0, name: row.name ?? current?.name ?? null });
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
    };
  });

  if (!catalog.length) throw new Error(`Không đọc được SKU nào từ ${dailySourceName}.`);
  const allDates = Object.values(dailyBySku).flatMap(rows => rows.map(row => row.date)).sort();
  const minDate = allDates[0];
  const maxDate = allDates.at(-1)!;
  const recommendedRunDate = `${maxDate.slice(0, 8)}01`;
  return {
    source: 'real',
    label: 'Dữ liệu thật',
    catalog,
    dailyBySku,
    dateRange: { min: minDate, max: maxDate, recommendedRunDate },
    audit: [`Đọc ${catalog.length} SKU và ${Object.values(dailyBySku).reduce((sum, rows) => sum + rows.length, 0)} dòng daily từ ${dailySourceName}.`],
  };
}

function parseDailyPayload(payload: string, sourceName: string): ParsedDailyRow[] {
  if (isJsonPayload(payload)) return parseDailyJson(payload, sourceName);
  return parseCsv(payload).map((row, index) => {
    if (row.length < 9) throw new Error(`${sourceName} thiếu cột bắt buộc SKU, Date, OpenStock, CloseStock, Sales, ReceiptHour, PromoCode, PromoName, Price.`);
    return {
      sku: textCell(row[0]),
      date: textCell(row[1]),
      openStock: requiredNumber(row[2], `${sourceName} dòng ${index + 1}: OpenStock`),
      closeStock: requiredNumber(row[3], `${sourceName} dòng ${index + 1}: CloseStock`),
      sales: requiredNumber(row[4], `${sourceName} dòng ${index + 1}: Sales`),
      receiptHour: textCell(row[5]),
      promoCode: textCell(row[6]) ?? textCell(row[7]),
      price: numberCell(row[8], 0),
      name: textCell(row[9]),
    };
  });
}

function parseDailyJson(payload: string, sourceName: string): ParsedDailyRow[] {
  const rows = parseJsonArray(payload, sourceName);
  return rows.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    return {
      sku: textCell(row['SKU'] ?? row['sku']),
      date: textCell(row['Date'] ?? row['date']),
      openStock: requiredNumber(row['OpenStock'], `${sourceName} dòng ${index + 1}: OpenStock`),
      closeStock: requiredNumber(row['CloseStock'], `${sourceName} dòng ${index + 1}: CloseStock`),
      sales: requiredNumber(row['Sales'], `${sourceName} dòng ${index + 1}: Sales`),
      receiptHour: textCell(row['ReceiptHour']),
      promoCode: textCell(row['PromoCode']) ?? textCell(row['PromoName']),
      price: numberCell(row['Price'], 0),
      name: textCell(row['ProductName']),
    };
  });
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

function requiredNumber(value: unknown, label: string): number {
  const number = numberCell(value, NaN);
  if (!Number.isFinite(number)) throw new Error(`${label} không hợp lệ.`);
  return number;
}
