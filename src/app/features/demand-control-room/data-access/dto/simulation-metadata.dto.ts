import { JsonObjectReader } from '../../../../core/json/json-object-reader.class';
import { DataQualityError } from '../../../../core/errors/data-quality-error.class';
import { addDaysIso } from '../../../../core/date/iso-date.value-object';

export type DatasetRunMode = 'HISTORICAL_VALIDATION' | 'PLANNING_SIMULATION';
/**
 * Cách Chặng 1 nhận dữ liệu ngày — KHAI BÁO trong dataset thay vì branch mock/real trong engine:
 * - GLOBAL_WINDOW: dòng nguồn thưa, Chặng 1 phải scaffold lịch liên tục toàn cửa sổ (RULE-01-001)
 *   + vùng đọc tham chiếu (RULE-01-003). Dữ liệu thật luôn ở dạng này.
 * - PRESCAFFOLDED: mỗi SKU đã là chuỗi ngày liên tục trong đúng khoảng hoạt động của nó
 *   (dữ liệu giả sinh sẵn theo pattern kiểm thử); Chặng 1 nhận nguyên trạng, KHÔNG scaffold
 *   lùi về đầu cửa sổ — nếu scaffold, SKU lịch sử ngắn (pattern BY-short, ONE-CYCLE…) sẽ bị
 *   bơm ngày SOURCE_UNKNOWN và đổi hoàn toàn ngữ nghĩa kiểm thử.
 */
export type DatasetCalendarScaffold = 'GLOBAL_WINDOW' | 'PRESCAFFOLDED';
export type DatasetStoreScopeStatus = 'FILTERED_SINGLE_STORE' | 'GLOBAL_POS_AGGREGATE' | 'SYNTHETIC_FIXTURE';
export type DatasetPortfolioMode = 'FULL_PORTFOLIO' | 'SELECTED_SKU_SIMULATION' | 'USE_APPROVED_SNAPSHOT';

export class ExtractMetadataDto {
  constructor(
    readonly salesDataThroughDate: string,
    readonly stockDataThroughDate: string,
    readonly extractionCompleted: boolean,
  ) {
    Object.freeze(this);
  }
}

export class SimulationMetadataDto {
  readonly runMode!: DatasetRunMode;
  readonly runDate!: string;
  readonly calendarScaffold!: DatasetCalendarScaffold;
  readonly historyYears!: number;
  readonly cycleLengthDays!: number;
  readonly storeCode!: string;
  readonly storeScopeStatus!: DatasetStoreScopeStatus;
  readonly portfolioMode!: DatasetPortfolioMode;
  readonly extractIsTruncated!: boolean;
  readonly sourceWatermarks!: { readonly sales: string | null; readonly stock: string | null };
  readonly extractMetadata!: ExtractMetadataDto;
  readonly qualityGates!: { readonly stockReconciliation: 'PASS' | 'FAIL'; readonly stockMismatchSkuCount: number };
  readonly rowCounts!: { readonly dailyRecords: number; readonly products: number };
  readonly policyOverrides!: Readonly<Record<string, unknown>>;

  private constructor(props: Omit<SimulationMetadataDto, never>) {
    Object.assign(this, props);
    Object.freeze(this);
  }

  static fromUnknown(value: unknown, path: string, datasetKind: 'MOCK' | 'REAL'): SimulationMetadataDto {
    const row = JsonObjectReader.read(value, path);
    const watermarks = row.child('sourceWatermarks');
    const gates = row.child('qualityGates');
    const counts = row.child('rowCounts');
    const salesDataThroughDate = watermarks.isoDate('sales');
    const stockDataThroughDate = watermarks.isoDate('stock');
    const extractionCompleted = row.requiredBoolean('extractionCompleted');
    const metadata = new SimulationMetadataDto({
      runMode: row.literal('runMode', ['HISTORICAL_VALIDATION', 'PLANNING_SIMULATION']),
      runDate: row.isoDate('runDate'),
      calendarScaffold: row.literal('calendarScaffold', ['GLOBAL_WINDOW', 'PRESCAFFOLDED']),
      historyYears: row.nonNegativeInteger('historyYears'),
      cycleLengthDays: row.nonNegativeInteger('cycleLengthDays'),
      storeCode: row.requiredString('storeCode'),
      storeScopeStatus: row.literal('storeScopeStatus', ['FILTERED_SINGLE_STORE', 'GLOBAL_POS_AGGREGATE', 'SYNTHETIC_FIXTURE']),
      portfolioMode: row.literal('portfolioMode', ['FULL_PORTFOLIO', 'SELECTED_SKU_SIMULATION', 'USE_APPROVED_SNAPSHOT']),
      extractIsTruncated: row.requiredBoolean('extractIsTruncated'),
      sourceWatermarks: { sales: salesDataThroughDate, stock: stockDataThroughDate },
      extractMetadata: new ExtractMetadataDto(salesDataThroughDate, stockDataThroughDate, extractionCompleted),
      qualityGates: {
        stockReconciliation: gates.literal('stockReconciliation', ['PASS', 'FAIL']),
        stockMismatchSkuCount: gates.nonNegativeInteger('stockMismatchSkuCount'),
      },
      rowCounts: { dailyRecords: counts.nonNegativeInteger('dailyRecords'), products: counts.nonNegativeInteger('products') },
      policyOverrides: row.rawObject('policyOverrides'),
    });

    // §9 — gate đối soát tồn PHẢI PASS trước khi dataset được nạp; FAIL không được nạp,
    // không fallback, không tự hạ cấp thành cảnh báo.
    if (metadata.qualityGates.stockReconciliation !== 'PASS') {
      throw new DataQualityError('STOCK_RECONCILIATION', `gate=FAIL (${metadata.qualityGates.stockMismatchSkuCount} SKU lệch tồn) — không nạp dataset. Export lại nguồn trước khi chạy.`);
    }
    if (datasetKind === 'REAL') {
      // §3.10 — dataset thật không được khai phạm vi cửa hàng dạng fixture tổng hợp.
      if (metadata.storeScopeStatus === 'SYNTHETIC_FIXTURE') {
        throw new DataQualityError('STORE_SCOPE', 'datasetKind=REAL không được khai storeScopeStatus=SYNTHETIC_FIXTURE.');
      }
      // Dữ liệu thật là dòng thưa từ POS/ERP — bắt buộc GLOBAL_WINDOW để Chặng 1 scaffold theo RULE-01-001.
      if (metadata.calendarScaffold !== 'GLOBAL_WINDOW') {
        throw new DataQualityError('CALENDAR_SCAFFOLD', `datasetKind=REAL yêu cầu calendarScaffold=GLOBAL_WINDOW, nhận được ${metadata.calendarScaffold}.`);
      }
      // DEC-008/009 — nguồn thật hiện chưa có kế hoạch CTKM tương lai được xác nhận: phiên thật
      // chỉ được chạy HISTORICAL_VALIDATION; PLANNING_SIMULATION trên REAL là rò rỉ tương lai tiềm ẩn.
      if (metadata.runMode !== 'HISTORICAL_VALIDATION') {
        throw new DataQualityError('RUN_MODE', `datasetKind=REAL yêu cầu runMode=HISTORICAL_VALIDATION (DEC-008/009), nhận được ${metadata.runMode}.`);
      }
      // Lịch sử phải phủ trọn tới runDate−1. Stock của phiên backtest CỐ Ý dừng đúng
      // ProcessingEndDate = runDate−1, nên điều kiện đúng là runDate ≤ watermark+1,
      // không phải runDate ≤ watermark.
      const watermark = metadata.extractMetadata.salesDataThroughDate < metadata.extractMetadata.stockDataThroughDate ? metadata.extractMetadata.salesDataThroughDate : metadata.extractMetadata.stockDataThroughDate;
      if (metadata.runDate > addDaysIso(watermark, 1)) {
        throw new DataQualityError('RUN_DATE_WATERMARK', `runDate=${metadata.runDate} vượt watermark nguồn ${watermark} (lịch sử phải phủ tới runDate−1) — không được tự lùi RunDate, export lại nguồn hoặc chọn RunDate hợp lệ.`);
      }
    }
    return metadata;
  }
}
