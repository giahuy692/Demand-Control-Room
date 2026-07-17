import { CalendarScaffoldMode, DailyRecord, HachiBusinessRole, PortfolioMode, PromotionClass, SessionRunMode, SkuDefinition } from './models';

export type DataSourceId = 'mock' | 'real';

export interface ExtractMetadata {
  readonly salesDataThroughDate: string;
  readonly stockDataThroughDate: string;
  readonly extractionCompleted: boolean;
}

export interface PromotionInterval {
  readonly sku: string | null;
  readonly code: string;
  readonly name: string | null;
  readonly startDate: string;
  readonly endDate: string;
  /**
   * Phân loại của CTKM tạo ra khoảng này (từ tbl_POLPromotion.[Type]: 2/7 → DEEP_PROMO,
   * còn lại → ALWAYS_ON). Ngày scaffold không có dòng nguồn nằm trong khoảng sẽ nhận
   * đúng class này thay vì mặc nhiên bị coi là DEEP_PROMO.
   */
  readonly promotionClass: PromotionClass;
}

/**
 * Dataset domain đã map từ hợp đồng DEMAND-SIMULATION-DATASET-V1 — đầu vào duy nhất
 * của SimulationEngine. Được tạo DUY NHẤT bởi DatasetDomainMapper (mock lẫn real);
 * mock generator/parser CSV cũ đã dời sang tools/demand-data (build-time).
 */
export interface SimulationDataset {
  readonly source: DataSourceId;
  readonly label: string;
  readonly catalog: readonly SkuDefinition[];
  readonly dailyBySku: Readonly<Record<string, readonly DailyRecord[]>>;
  readonly promotionIntervals: readonly PromotionInterval[];
  readonly extractMetadata: ExtractMetadata;
  readonly audit: readonly string[];
  readonly dateRange?: { min: string; max: string; recommendedRunDate: string };
  /** Ngữ nghĩa phiên — do dataset KHAI BÁO (metadata hợp đồng V1), engine không suy từ mock/real. */
  readonly runMode: SessionRunMode;
  readonly calendarScaffold: CalendarScaffoldMode;
  /**
   * RULE-01-004/06-001 [DEC-010] — SELECTED_SKU_SIMULATION chỉ là xếp hạng mô phỏng trong tập
   * hiện tại, KHÔNG khóa ABC chính thức toàn danh mục.
   */
  readonly portfolioMode: PortfolioMode;
  readonly extractIsTruncated: boolean;
}

/**
 * §7 LỆNH CODEX — benchmark HachiBusinessRole, nạp từ asset JSON RIÊNG (`src/assets/hachi-business-roles.json`),
 * KHÔNG phải từ pipeline dataset. Trả map rỗng khi payload rỗng/không hợp lệ — không bao giờ suy đoán.
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

function textCell(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text && text.toUpperCase() !== 'NULL' ? text : null;
}
