import { Injectable } from '@angular/core';
import { SimulationDataset } from '../../../../domain/catalog';
import { DailyRecord, SkuDefinition } from '../../../../domain/models';
import { SessionMetadata, SimulationSession } from '../../domain/models/simulation-session.class';
import { DailyHistoryRecordDto } from '../dto/daily-history-record.dto';
import { DemandSimulationDatasetDto } from '../dto/demand-simulation-dataset.dto';
import { ProductDto } from '../dto/product.dto';

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
      // Parity với parseRealDataset cũ: opening-anchor chỉ thiết lập tồn trước khung đọc,
      // không phải ngày lịch sử — loại ngay tại cửa nạp.
      if (record.isOpeningAnchor) continue;
      (dailyBySku[record.sku] ??= []).push(toDailyRecord(record));
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
    return new SimulationSession(kind, dto.datasetId, dto.contractVersion, dto.generatedAt, metadata, dataset);
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
    qualityGates: { ...metadata.qualityGates },
    rowCounts: { ...metadata.rowCounts },
    policyOverrides: { ...metadata.policyOverrides },
  };
}

/** Parity từng field với dailyRecord() của catalog.ts — golden regression là lưới kiểm chứng. */
function toDailyRecord(record: DailyHistoryRecordDto): DailyRecord {
  const openStock = record.openStock ?? 0;
  const closeStock = record.closeStock ?? 0;
  return {
    sku: record.sku,
    date: record.date,
    openStock,
    closeStock,
    sales: record.sales,
    hasRecord: record.hasSalesRecord,
    isZeroSaleInferred: record.isZeroSaleInferred,
    receiptHour: record.receiptHour,
    promoCode: record.promoCode,
    salesStatus: record.sales === null ? 'SOURCE_UNKNOWN' : record.sales > 0 ? 'OBSERVED' : 'OBSERVED_ZERO',
    isReferenceOnly: false, // engine tự tính theo ngày ở Chặng 1 (RULE-01-003) — cờ nguồn chỉ để đối chiếu
    stockSource: 'OBSERVED',
    // Dòng validation không có bằng chứng tồn (openStock=null trong hợp đồng) → UNRESOLVED,
    // không được trình bày 0 như số đo thật.
    stockCalculationStatus: record.openStock === null ? 'UNRESOLVED' : openStock < 0 || closeStock < 0 ? 'NEGATIVE_REVIEW' : 'CALCULATED',
    isStockout: false,
    stockoutReason: null,
    stockoutReviewRequired: false,
    baseDemand: null,
    baseSource: null,
    referenceDates: [],
    beforeReferenceDates: [],
    afterReferenceDates: [],
    referenceMedian: null,
    balanceStatus: null,
    selectionReason: '',
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
