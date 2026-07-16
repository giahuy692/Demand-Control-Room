import { DataSourceId, SimulationDataset } from '../../../../domain/catalog';
import { CalendarScaffoldMode, PortfolioMode, SessionRunMode } from '../../../../domain/models';

/** Bản sao DOMAIN của metadata dataset — cắt phụ thuộc UI/store vào tầng DTO. */
export interface SessionMetadata {
  readonly runMode: SessionRunMode;
  readonly runDate: string;
  readonly calendarScaffold: CalendarScaffoldMode;
  readonly historyYears: number;
  readonly cycleLengthDays: number;
  readonly storeCode: string;
  readonly storeScopeStatus: string;
  readonly portfolioMode: PortfolioMode;
  readonly extractIsTruncated: boolean;
  readonly sourceWatermarks: { readonly sales: string | null; readonly stock: string | null };
  readonly qualityGates: { readonly stockReconciliation: 'PASS' | 'FAIL'; readonly stockMismatchSkuCount: number };
  readonly rowCounts: { readonly dailyRecords: number; readonly products: number };
  readonly policyOverrides: Readonly<Record<string, unknown>>;
}

/**
 * Một PHIÊN dữ liệu đã nạp hợp lệ: dataset domain cho engine + hồ sơ metadata để UI
 * hiển thị (datasetKind/id/contract/generatedAt/gates…). Chỉ DatasetDomainMapper tạo ra.
 */
export class SimulationSession {
  constructor(
    readonly kind: DataSourceId,
    readonly datasetId: string,
    readonly contractVersion: string,
    readonly generatedAt: string,
    readonly metadata: SessionMetadata,
    readonly dataset: SimulationDataset,
  ) {
    Object.freeze(this);
  }
}
