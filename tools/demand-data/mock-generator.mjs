/**
 * Sinh dữ liệu GIẢ cho mock.dataset.json — PORT NGUYÊN VĂN từ src/app/domain/catalog.ts
 * (BASE_SKUS, operationalInputs, targetForCycle, generateDailyRecords, LCG seeded).
 * Mọi phép toán phải giữ đúng thứ tự gọi rng() — golden-regression.spec.ts là lưới
 * kiểm chứng: một số lệch là snapshot fail.
 *
 * Pattern kiểm thử của từng SKU (metadata.description bên build-mock-dataset.mjs):
 * AX ổn định, AY mùa vụ 24CK, AZ thưa nhịp 3CK, BX tăng trưởng, BY dao động có xu hướng,
 * BZ thưa 2 lần, BY-short lịch sử ngắn, CX biên, CY dao động, CZ một lần, NEW chưa bán,
 * ONE-CYCLE 1 chu kỳ, FIVE-CYCLES 5 chu kỳ, D-zero-stock 6 chu kỳ bằng 0.
 */

export const MOCK_RUN_DATE = '2026-06-01';
export const MOCK_CYCLE_LENGTH = 15;
export const MOCK_HISTORY_YEARS = 3;

function hashSeed(textValue) {
  return [...textValue].reduce((seed, char) => (seed * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
}

function random(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function targetForCycle(type, cycle, rng) {
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

function operationalInputs(id, type, cycles) {
  const ordinal = Number(id.slice(-3)) || 1;
  const leadMean = 105 + (ordinal % 3) * 15;
  const active = cycles > 0;
  const futureRng = random(hashSeed(`${id}:actual`));
  const promoUplift = 1 + (5 / 15) * 0.45;
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
  };
}

const BASE_SKUS = [
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
];

export function buildMockProducts() {
  return BASE_SKUS.map(([id, name, type, price, cycles, description, category]) => ({
    id, name, type, price, cycles, description, category,
    ...operationalInputs(id, type, cycles),
  }));
}

function buildCalendar(runDate, totalDays) {
  const days = [{ iso: runDate, month: 0, dayOfMonth: 0 }];
  const end = new Date(`${runDate}T00:00:00Z`);
  while (days.length <= totalDays) {
    const date = addDays(end, -days.length);
    days.push({ iso: date.toISOString().slice(0, 10), month: date.getUTCMonth() + 1, dayOfMonth: date.getUTCDate() });
  }
  return days;
}

/** Số chu kỳ đầy đủ của cửa sổ lịch sử — trùng công thức runStage1 (T01: 2026-06-01 → 83). */
export function fullCycleCount(runDate, historyYears, cycleLength) {
  const run = new Date(`${runDate}T00:00:00Z`);
  const historyStart = new Date(Date.UTC(run.getUTCFullYear() - historyYears, 0, 1));
  const historyEnd = addDays(run, -1);
  const totalDays = Math.round((historyEnd.getTime() - historyStart.getTime()) / 86_400_000) + 1;
  return Math.floor(totalDays / cycleLength);
}

/** Port generateDailyRecords — trả dòng hợp đồng V1 (camelCase, cặp cờ null/0 đầy đủ). */
export function generateDailyRows(definition, runDate, cycleLength, maxCycles) {
  if (!definition.cycles) return [];
  const rng = random(hashSeed(definition.id));
  const totalDays = Math.min(definition.cycles, maxCycles) * cycleLength;
  const calendar = buildCalendar(runDate, totalDays);
  const rows = [];
  let stock = Math.max(80, Math.round(targetForCycle(definition.type, 0, rng) * 4));
  for (let day = 0; day < totalDays; day++) {
    const cycle = Math.floor(day / cycleLength);
    const target = targetForCycle(definition.type, cycle, rng);
    const dailyTarget = target / cycleLength;
    const { iso, month, dayOfMonth } = calendar[totalDays - day];
    const promoCode = dayOfMonth >= 5 && dayOfMonth <= 7 && [3, 6, 9, 12].includes(month) ? 'MEMBER' : null;
    const naturalSales = Math.max(0, Math.round(dailyTarget + (rng() - 0.5) * Math.max(1, dailyTarget * 0.2)));
    const sales = promoCode ? Math.round(naturalSales * 1.45) : naturalSales;
    const forcedLateReceipt = day > 0 && day % 137 === 0;
    const emptyAllDay = day > 0 && day % 223 === 0;
    const openStock = forcedLateReceipt || emptyAllDay ? 0 : stock;
    const sold = Math.min(openStock, sales);
    const receiptHour = forcedLateReceipt ? '13:00' : stock < target * 2 ? '09:00' : null;
    const receipt = receiptHour ? Math.max(30, Math.round(target * 4)) : 0;
    const closeStock = emptyAllDay ? 0 : Math.max(0, openStock - sold + receipt);
    rows.push({
      sku: definition.id,
      date: iso,
      openStock,
      closeStock,
      sales: sold,
      hasSalesRecord: true,
      isZeroSaleInferred: false,
      returnQty: null,
      hasReturnRecord: false,
      inventoryNetMovement: null,
      hasInventoryMovement: false,
      totalStockDelta: closeStock - openStock,
      receiptHour,
      hasReceiptRecord: receiptHour !== null,
      receiptTimeSource: null,
      promoCode,
      promoName: null,
      price: definition.price,
      productName: definition.name,
      isOpeningAnchor: false,
      isReferenceOnly: false,
      isHistoryRecord: true,
      isValidationActual: false,
    });
    stock = closeStock;
  }
  return rows;
}

export function buildMockDailyRows() {
  const maxCycles = fullCycleCount(MOCK_RUN_DATE, MOCK_HISTORY_YEARS, MOCK_CYCLE_LENGTH);
  return buildMockProducts().flatMap(definition => generateDailyRows(definition, MOCK_RUN_DATE, MOCK_CYCLE_LENGTH, maxCycles));
}
