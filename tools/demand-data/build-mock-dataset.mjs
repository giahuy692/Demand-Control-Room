import { CONTRACT_VERSION, validateDataset, writeDatasetAtomic } from './data-contract.mjs';
import { buildMockDailyRows, buildMockProducts, MOCK_CYCLE_LENGTH, MOCK_HISTORY_YEARS, MOCK_RUN_DATE } from './mock-generator.mjs';

const OUTPUT = process.argv[2] ?? 'src/assets/demand-planning/datasets/mock.dataset.json';

const products = buildMockProducts();
const dailyRecords = buildMockDailyRows();

const dataset = {
  contractVersion: CONTRACT_VERSION,
  datasetId: `mock-14sku-${MOCK_RUN_DATE}`,
  datasetKind: 'MOCK',
  generatedAt: new Date().toISOString(),
  metadata: {
    runMode: 'PLANNING_SIMULATION',
    runDate: MOCK_RUN_DATE,
    // Chuỗi ngày mỗi SKU đã liên tục đúng khoảng hoạt động của nó (pattern kiểm thử) —
    // Chặng 1 KHÔNG được scaffold lùi về đầu cửa sổ, nếu không SKU lịch sử ngắn đổi nghĩa.
    calendarScaffold: 'PRESCAFFOLDED',
    historyYears: MOCK_HISTORY_YEARS,
    cycleLengthDays: MOCK_CYCLE_LENGTH,
    storeCode: 'MOCK-STORE',
    storeScopeStatus: 'SYNTHETIC_FIXTURE',
    portfolioMode: 'SELECTED_SKU_SIMULATION',
    extractIsTruncated: true,
    sourceWatermarks: { sales: '2026-05-31', stock: '2026-05-31' },
    extractionCompleted: true,
    qualityGates: { stockReconciliation: 'PASS', stockMismatchSkuCount: 0 },
    rowCounts: { dailyRecords: dailyRecords.length, products: products.length },
    policyOverrides: {},
    description: '14 SKU pattern kiểm thử (AX ổn định, AY mùa vụ, AZ/BZ/CZ thưa, BX/BY xu hướng, CX biên, CY dao động, NEW/ONE-CYCLE/FIVE-CYCLES/D-zero lịch sử ngắn), CTKM MEMBER ngày 5–7 tháng 3/6/9/12, LCG seeded — deterministic.',
  },
  products,
  dailyRecords,
  promotionIntervals: [],
};

const errors = validateDataset(dataset);
if (errors.length) {
  console.error(`mock.dataset.json KHÔNG đạt hợp đồng (${errors.length} lỗi):`);
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
  process.exit(1);
}

writeDatasetAtomic(OUTPUT, dataset);
console.log(`Đã ghi ${dailyRecords.length} dòng ngày, ${products.length} SKU vào ${OUTPUT}`);
