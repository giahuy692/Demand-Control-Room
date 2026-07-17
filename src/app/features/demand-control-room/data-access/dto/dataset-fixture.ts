/**
 * Fixture builder DÙNG CHO TEST — tạo payload JSON-thuần (plain object, không class)
 * hợp lệ tối thiểu theo DEMAND-SIMULATION-DATASET-V1 rồi cho từng test bẻ gãy đúng
 * một điều kiện. Không dùng trong production code.
 */

export function fixtureProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    name: 'Sản phẩm kiểm thử',
    type: 'AX-stable',
    price: 100000,
    cycles: 2,
    description: 'fixture',
    category: 'Test',
    supplier: 'NCC-01',
    inboundPlan: [],
    commitments: [],
    futurePromotions: [],
    leadTimeHistoryDays: [],
    maxStock: 100,
    warehouseCapacity: 120,
    shelfLifeDays: null,
    purchasePrice: 75000,
    moq: 1,
    purchaseTermsComplete: true,
    actualDemand: [],
    actualEndingStock: 0,
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
    ...overrides,
  };
}

export function fixtureDailyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeCode: 11,
    productCode: 1,
    barcode: '1',
    productName: 'Sản phẩm kiểm thử',
    date: '2026-05-01',
    hasSalesRecord: true,
    sales: 2,
    price: 100000,
    promotionCode: null,
    promotionName: null,
    promotionStartDate: null,
    promotionEndDate: null,
    promotionType: null,
    promotionMechanismType: null,
    promotionClass: 'NO_PROMOTION',
    openStock: 10,
    closeStock: 8,
    receiptHour: null,
    stockStatus: 'CALCULATED',
    ...overrides,
  };
}

export function fixtureDataset(overrides: {
  datasetKind?: 'MOCK' | 'REAL';
  metadata?: Record<string, unknown>;
  products?: Record<string, unknown>[];
  dailyRecords?: Record<string, unknown>[];
  promotionIntervals?: Record<string, unknown>[];
  root?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const datasetKind = overrides.datasetKind ?? 'MOCK';
  const defaultId = datasetKind === 'MOCK' ? 'SKU-001' : '1';
  const products = overrides.products ?? [fixtureProduct({ id: defaultId })];
  const dailyRecords = overrides.dailyRecords ?? [
    fixtureDailyRecord({ barcode: defaultId, date: '2026-05-01' }),
    fixtureDailyRecord({ barcode: defaultId, date: '2026-05-02', sales: 0, openStock: 8, closeStock: 8 }),
  ];
  return {
    contractVersion: 'DEMAND-SIMULATION-DATASET-V1',
    datasetId: 'fixture-2026-06-01',
    datasetKind,
    generatedAt: '2026-07-16T00:00:00+07:00',
    metadata: {
      runMode: datasetKind === 'REAL' ? 'HISTORICAL_VALIDATION' : 'PLANNING_SIMULATION',
      runDate: '2026-06-01',
      calendarScaffold: datasetKind === 'REAL' ? 'GLOBAL_WINDOW' : 'PRESCAFFOLDED',
      historyYears: 3,
      cycleLengthDays: 15,
      storeCode: 'GLOBAL_POS',
      storeScopeStatus: 'GLOBAL_POS_AGGREGATE',
      portfolioMode: 'SELECTED_SKU_SIMULATION',
      extractIsTruncated: true,
      sourceWatermarks: { sales: '2026-06-15', stock: '2026-06-15' },
      extractionCompleted: true,
      qualityGates: { stockReconciliation: 'PASS', stockMismatchSkuCount: 0 },
      rowCounts: { dailyRecords: dailyRecords.length, products: products.length },
      policyOverrides: {},
      ...overrides.metadata,
    },
    products,
    dailyRecords,
    promotionIntervals: overrides.promotionIntervals ?? [],
    ...overrides.root,
  };
}
