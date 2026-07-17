import { Injectable } from '@angular/core';
import { SimulationDataset } from '../../domain/catalog';
import { BaseDemandSource, DailyRecord, isBaselineExcludedPromo, PromotionStatus, SalesObservationStatus, SkuDefinition, StockCalculationStatus, StockoutStatus, TechnicalFillStatus } from '../../domain/models';
import { SessionMetadata, SimulationSession } from '../../domain/models/simulation-session.class';
import { DailyHistoryRecordDto } from '../dto/daily-history-record.dto';
import { DemandSimulationDatasetDto } from '../dto/demand-simulation-dataset.dto';
import { ProductDto } from '../dto/product.dto';
import { DEFAULT_POLICY } from '../../domain/policy';
import { DemandPlanningPolicy } from '../../domain/policies/demand-planning-policy.class';

/**
 * Cầu DUY NHẤT từ cây DTO (đã validate) sang domain model của engine. Mock và real
 * đi qua đúng một mapper này — không có luồng "mock → domain trực tiếp" thứ hai.
 * Mapper KHÔNG validate lại (DTO đã làm), KHÔNG mutate DTO (tạo mảng/object mới).
 */
@Injectable({ providedIn: 'root' })
export class DatasetDomainMapper {
  toDomain(dto: DemandSimulationDatasetDto): SimulationSession {
    const kind = dto.datasetKind === 'REAL' ? 'real' as const : 'mock' as const;
    const dailyBySku: Record<string, DailyRecord[]> = {};
    let minDate = '';
    let maxDate = '';
    for (const record of dto.dailyRecords) {
      const skuStr = kind === 'mock'
        ? `SKU-${record.productCode.toString().padStart(3, '0')}`
        : record.productCode.toString();
      (dailyBySku[skuStr] ??= []).push(toDailyRecord(record, kind));
      if (!minDate || record.date < minDate) minDate = record.date;
      if (!maxDate || record.date > maxDate) maxDate = record.date;
    }
    for (const records of Object.values(dailyBySku)) records.sort((a, b) => a.date.localeCompare(b.date));

    const catalog = dto.products.map(product => toSkuDefinition(product, dto));
    const metadata = toSessionMetadata(dto);
    const totalRows = Object.values(dailyBySku).reduce((sum, rows) => sum + rows.length, 0);
    const dataset: SimulationDataset = {
      source: kind,
      label: kind === 'real' ? 'Dữ liệu thật' : 'Dữ liệu giả',
      catalog,
      dailyBySku,
      promotionIntervals: dto.promotionIntervals.map(interval => ({
        sku: interval.sku, code: interval.code, name: interval.name,
        startDate: interval.startDate, endDate: interval.endDate,
        promotionClass: interval.promotionClass,
      })),
      extractMetadata: { ...metadata.extractMetadata },
      dateRange: minDate ? { min: minDate, max: maxDate, recommendedRunDate: metadata.runDate } : undefined,
      runMode: metadata.runMode,
      calendarScaffold: metadata.calendarScaffold,
      portfolioMode: metadata.portfolioMode,
      extractIsTruncated: metadata.extractIsTruncated,
      audit: [
        `Đọc ${catalog.length} SKU và ${totalRows} dòng daily từ ${dto.datasetId} (${dto.contractVersion}).`,
        `[metadata] runMode=${metadata.runMode}, runDate=${metadata.runDate}, scaffold=${metadata.calendarScaffold}, gate tồn=${metadata.qualityGates.stockReconciliation}, phạm vi=${metadata.storeCode}/${metadata.storeScopeStatus}, portfolioMode=${metadata.portfolioMode}.`,
      ],
    };
    const policy = DemandPlanningPolicy.fromMetadata(metadata, DEFAULT_POLICY);
    return new SimulationSession(kind, dto.datasetId, dto.contractVersion, dto.generatedAt, metadata, policy, dataset);
  }
}

function toSessionMetadata(dto: DemandSimulationDatasetDto): SessionMetadata {
  const metadata = dto.metadata;
  return {
    runMode: metadata.runMode,
    runDate: metadata.runDate,
    calendarScaffold: metadata.calendarScaffold,
    historyYears: metadata.historyYears,
    cycleLengthDays: metadata.cycleLengthDays,
    storeCode: metadata.storeCode,
    storeScopeStatus: metadata.storeScopeStatus,
    portfolioMode: metadata.portfolioMode,
    extractIsTruncated: metadata.extractIsTruncated,
    sourceWatermarks: { ...metadata.sourceWatermarks },
    extractMetadata: { ...metadata.extractMetadata },
    qualityGates: { ...metadata.qualityGates },
    rowCounts: { ...metadata.rowCounts },
    policyOverrides: { ...metadata.policyOverrides },
  };
}

/** Parity từng field với dailyRecord() của catalog.ts — golden regression là lưới kiểm chứng. */
function toDailyRecord(record: DailyHistoryRecordDto, kind: 'mock' | 'real'): DailyRecord {
  const openStock = record.openStock;
  const closeStock = record.closeStock;
  
  let stockCalculationStatus: StockCalculationStatus = 'CALCULATED';
  if (record.stockStatus === 'NEGATIVE_STOCK') {
    stockCalculationStatus = 'NEGATIVE_REVIEW';
  } else if (record.stockStatus === 'ANCHOR_MISSING') {
    stockCalculationStatus = 'ANCHOR_MISSING';
  }

  // Chỉ DEEP_PROMO (mechanismType 2/7) bị loại khỏi baseline và chuyển Chặng 4 tìm mức
  // bán tự nhiên; ALWAYS_ON/PROMOTION_UNRESOLVED giữ nguyên Sales (PromotionStatus.NONE).
  const isPromo = isBaselineExcludedPromo(record.promotionClass);

  const skuStr = kind === 'mock'
    ? `SKU-${record.productCode.toString().padStart(3, '0')}`
    : record.productCode.toString();

  return {
    sku: skuStr,
    barcode: record.barcode ?? skuStr,
    date: record.date,
    openStock,
    closeStock,
    sales: record.sales,
    hasSalesRecord: record.hasSalesRecord,
    receiptHour: record.receiptHour,
    promoCode: record.promotionCode !== null ? record.promotionCode.toString() : null,
    salesObservationStatus: record.hasSalesRecord
      ? SalesObservationStatus.RECORDED_SALE
      : SalesObservationStatus.SOURCE_DATA_GAP,
    isReferenceOnly: false, // engine tự tính theo ngày ở Chặng 1 (RULE-01-003) — cờ nguồn chỉ để đối chiếu
    stockSource: 'OBSERVED',
    stockCalculationStatus,
    promotionStatus: isPromo ? PromotionStatus.PROMOTION : PromotionStatus.NONE,
    stockoutStatus: StockoutStatus.NONE,
    baseDemand: null,
    baseDemandSource: BaseDemandSource.SOURCE_DATA_GAP,
    isCleanObservedReference: false,
    technicalFillStatus: TechnicalFillStatus.NOT_APPLICABLE,
    referenceDates: [],
    referenceEvidence: [],
    beforeReferenceDates: [],
    afterReferenceDates: [],
    referenceMedian: null,
    balanceStatus: null,
    selectionReason: '',
    storeCode: record.storeCode,
    productCode: record.productCode,
    promotionName: record.promotionName,
    promotionStartDate: record.promotionStartDate,
    promotionEndDate: record.promotionEndDate,
    promotionType: record.promotionType,
    promotionMechanismType: record.promotionMechanismType,
    promotionClass: record.promotionClass,
    stockStatus: record.stockStatus,
  };
}

function toSkuDefinition(product: ProductDto, dto: DemandSimulationDatasetDto): SkuDefinition {
  return {
    id: product.id,
    name: product.name,
    type: product.type,
    price: product.price,
    cycles: product.cycles,
    description: product.description,
    category: product.category,
    supplier: product.supplier,
    inboundPlan: product.inboundPlan.map(lot => ({ ...lot })),
    commitments: product.commitments.map(commitment => ({ ...commitment })),
    futurePromotions: product.futurePromotions.map(promo => ({ ...promo })),
    leadTimeHistoryDays: [...product.leadTimeHistoryDays],
    maxStock: product.maxStock,
    warehouseCapacity: product.warehouseCapacity,
    shelfLifeDays: product.shelfLifeDays,
    purchasePrice: product.purchasePrice,
    moq: product.moq,
    purchaseTermsComplete: product.purchaseTermsComplete,
    actualDemand: [...product.actualDemand],
    actualEndingStock: product.actualEndingStock,
    actualReceiptDelayDays: [...product.actualReceiptDelayDays],
    actualBudgetUsed: product.actualBudgetUsed,
    heldStock: product.heldStock,
    damagedStock: product.damagedStock,
    blockedStock: product.blockedStock,
    unsellableStock: product.unsellableStock,
    displayMinimumStock: product.displayMinimumStock,
    unitsPerCarton: product.unitsPerCarton,
    orderStep: product.orderStep,
    supplierMinOrderValue: product.supplierMinOrderValue,
    receivingLocation: product.receivingLocation,
    currency: product.currency,
    landedCostPerUnit: product.landedCostPerUnit,
    coreOrStrategicRole: product.coreOrStrategicRole,
    obsolescenceRiskRank: product.obsolescenceRiskRank,
    portfolioMode: dto.metadata.portfolioMode,
    extractIsTruncated: dto.metadata.extractIsTruncated,
  };
}
