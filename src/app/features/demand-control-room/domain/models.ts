export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;
export type AbcClass = 'A' | 'B' | 'C' | 'N/A';
export type XyzClass = 'X' | 'Y' | 'Z' | 'D';
/**
 * RULE-07-001 — 6 lý do gộp trong nhóm D, không dùng D thay cho lỗi dữ liệu. D_MANUAL_PLAN/D_SIMILAR_SKU chưa có nguồn dữ liệu (không có UI nhập kế hoạch thủ công hay danh mục SKU tương tự đã duyệt) nên không bao giờ được gán trong app hiện tại — ghi nhận tường minh.
 * D_SHORT_HISTORY tương đương literal `D_TRUE_SHORT_HISTORY` của tài liệu 04 §9 — giữ tên cũ trong code, không đổi để tránh phá vỡ mọi nơi đang dùng; coi là đồng nghĩa.
 * D_BASELINE_UNRESOLVED không còn được gán từ sau khi Chặng 7 (RULE-07-003) chặn cửa sổ có chu kỳ BASELINE_UNRESOLVED TRƯỚC khi gọi classifyDSubtype — giữ literal để không phá kiểu, nhưng không bao giờ xuất hiện trong runtime nữa.
 */
export type DSubtype = 'D_NEW' | 'D_SHORT_HISTORY' | 'D_EXTRACT_TRUNCATED' | 'D_BASELINE_UNRESOLVED' | 'D_MANUAL_PLAN' | 'D_SIMILAR_SKU';
export type LockStatus = 'locked' | 'review' | 'temporary' | 'exception';
export type BalanceStatus = 'balanced' | 'temporary' | 'fixed' | 'insufficient' | null;
export enum SalesObservationStatus {
  RECORDED_SALE = 'RECORDED_SALE',
  CONFIRMED_ZERO = 'CONFIRMED_ZERO',
  SOURCE_DATA_GAP = 'SOURCE_DATA_GAP',
}
export enum BaseDemandSource {
  CLEAN_OBSERVED_SALE = 'CLEAN_OBSERVED_SALE',
  CLEAN_OBSERVED_ZERO = 'CLEAN_OBSERVED_ZERO',
  STOCKOUT_BASELINE = 'STOCKOUT_BASELINE',
  PROMOTION_BASELINE = 'PROMOTION_BASELINE',
  TECHNICAL_FILL = 'TECHNICAL_FILL',
  STOCKOUT_UNRESOLVED = 'STOCKOUT_UNRESOLVED',
  PROMOTION_UNRESOLVED = 'PROMOTION_UNRESOLVED',
  SOURCE_DATA_GAP = 'SOURCE_DATA_GAP',
}
export enum PromotionStatus {
  NONE = 'NONE',
  PROMOTION = 'PROMOTION',
}
export enum StockoutStatus {
  NONE = 'NONE',
  ALL_DAY_STOCKOUT_CANDIDATE = 'ALL_DAY_STOCKOUT_CANDIDATE',
  LATE_RECEIPT_STOCKOUT = 'LATE_RECEIPT_STOCKOUT',
  DEPLETION_REVIEW = 'DEPLETION_REVIEW',
  NEGATIVE_STOCK_REVIEW = 'NEGATIVE_STOCK_REVIEW',
}
export enum TechnicalFillStatus {
  NOT_APPLICABLE = 'NOT_APPLICABLE',
  PENDING = 'PENDING',
  FILLED = 'FILLED',
  UNRESOLVED = 'UNRESOLVED',
}
/** 02-Hop-dong-du-lieu-dau-vao.md §3.1 — trạng thái tính tồn; RULE-02-001 chỉ cho auto-stockout khi CALCULATED/NEGATIVE_REVIEW. */
export type StockCalculationStatus = 'CALCULATED' | 'ANCHOR_MISSING' | 'NEGATIVE_REVIEW' | 'UNRESOLVED';
/** 02-Hop-dong-du-lieu-dau-vao.md §6 — nguồn của openStock/closeStock: quan sát trực tiếp hay mang tiếp từ ngày trước (DEC-003). */
export type StockSource = 'OBSERVED' | 'CARRIED_FORWARD';
/** 02-Hop-dong-du-lieu-dau-vao.md §3.2/RULE-04-001 — phân loại CTKM trước khi chuẩn hóa Chặng 4. STANDING_PRICE không xuất hiện ở đây vì đã bị loại khỏi promoCode trước Chặng 2. */
export type PolicyClassification = 'CAMPAIGN' | 'CLEARANCE' | 'UNKNOWN_REVIEW';
/** 01-Danh-sach-quyet-dinh-nghiep-vu.md RULE-01-004/06-001 — phạm vi tập dữ liệu đang chạy. */
export type PortfolioMode = 'FULL_PORTFOLIO' | 'SELECTED_SKU_SIMULATION' | 'USE_APPROVED_SNAPSHOT';

/** Chế độ phiên của dataset (DEMAND-SIMULATION-DATASET-V1): backtest lịch sử hay mô phỏng kế hoạch có dữ liệu vận hành xác nhận. */
export type SessionRunMode = 'HISTORICAL_VALIDATION' | 'PLANNING_SIMULATION';
/** Cách Chặng 1 nhận dữ liệu ngày — khai báo trong dataset, không branch mock/real trong engine (xem SimulationMetadataDto). */
export type CalendarScaffoldMode = 'GLOBAL_WINDOW' | 'PRESCAFFOLDED';

export interface SimulationPolicy {
  runDate: string;
  historyYears: number;
  cycleLength: number;
  cutoffHour: string;
  referenceRadius: number;
  /** RULE-03-001 — mốc mở rộng trung gian giữa `referenceRadius` và `maxReferenceRadius` ("Tìm ±7, mở ±14, tối đa ±24"). */
  referenceRadiusExtended: number;
  maxReferenceRadius: number;
  minimumReferences: number;
  maxBalancedPerSide: number;
  abcThresholds: { readonly aMaxCumulativeShare: number; readonly cMinCumulativeShare: number };
  xyzThresholds: { readonly zMinAdi: number; readonly xMaxCv2: number };
  abcWindowCycles: number;
  minimumAbcLockedCycles: number;
  serviceLevels: Readonly<Record<string, number>>;
  capitalPriorities: Readonly<Record<string, string>>;
  version: string;
  periodBudget: number;
  /**
   * Mã CTKM THƯỜNG TRỰC (chính sách giá cố định theo hạng khách hàng, ví dụ
   * "GIẢM 5% GIÁ TỐT NHẤT - DÀNH RIÊNG KHTT") — khác CTKM CHIẾN DỊCH thời vụ.
   * Các mã trong danh sách này bị loại khỏi promoCode trước Chặng 2, để những
   * ngày CHỈ dính mã thường trực được coi là ngày bán bình thường (baseDemand
   * = sales thật) thay vì luôn bị Chặng 3/4 chuẩn hóa về median ngày sạch.
   * Rỗng theo mặc định — không tự đoán; chỉ điền sau khi người có thẩm quyền
   * xác nhận từng mã qua bảng chẩn đoán (xem Sql/demand-planing.sql mục 9b).
   */
  standingPromotionCodes: readonly string[];
  /**
   * RULE-04-001 — mã CTKM CLEARANCE (thanh lý/xả hàng) đã được phân loại thủ công. Rỗng mặc định
   * — không tự đoán. Hiện tài liệu Chặng 4 không nêu công thức tính riêng cho CLEARANCE khác
   * CAMPAIGN nên vẫn xử lý qua cùng đường chuẩn hóa median; chỉ khác ở nhãn phân loại được ghi log.
   */
  clearancePromotionCodes: readonly string[];
  /**
   * RULE-04-001 nhánh 3 — mã CTKM CHƯA xác định loại, không tự quyết mà chuyển hàng đợi phê duyệt
   * (PROMO_TYPE_UNKNOWN). Rỗng mặc định — mọi mã không thường trực mặc nhiên xử lý như CAMPAIGN để
   * không đổi hành vi hiện có; chỉ mã được liệt kê rõ ở đây mới bị chặn chuẩn hóa.
   */
  unknownReviewPromotionCodes: readonly string[];

  /**
   * Chặng 15 §4 — các mức phục vụ được phép dò khi tìm mức thấp nhất vừa đủ đạt
   * cả 4 điều kiện mô phỏng. Phải là các mức đã có hệ số Z (POLICY.Z_VALUES).
   * Mặc định lấy các mức phổ biến ≥ sàn chính sách Chặng 8; CHƯA PHÊ DUYỆT chính
   * thức — chỉ là điểm khởi đầu hợp lý để không phải luôn rơi về công thức fallback.
   */
  serviceLevelCandidates: readonly number[];
  /** Chặng 15 §5/§6 — số cửa sổ lead-time tối thiểu để dùng phương pháp percentile SKU tự thân; dưới ngưỡng này mới fallback sang nhóm ABC×XYZ rồi công thức Z×√(...). CHƯA PHÊ DUYỆT. */
  minimumLeadTimeWindows: number;
  /** Chặng 15 §4 điều kiện 2 — tỷ lệ tối đa số cửa sổ được phép vượt mức tồn an toàn đang xét. CHƯA PHÊ DUYỆT. */
  maxLeadTimeBreachRate: number;
  /** Chặng 15 §4 điều kiện 3 — trần dư thừa = bội số của D̄ một chu kỳ. CHƯA PHÊ DUYỆT. */
  safetyStockSurplusCapMultiplier: number;
  /** Chặng 15 §4 điều kiện 4 — trần vốn khóa trong tồn an toàn mỗi SKU; Infinity = chưa cấu hình, không chặn. CHƯA PHÊ DUYỆT. */
  safetyStockCapitalCapPerSku: number;

  /** Chặng 16 §3 — số ngày lead time mặc định khi SKU chưa có lịch sử lead time thật (ví dụ toàn bộ dữ liệu ERP thật hiện nay). CHƯA PHÊ DUYỆT. */
  defaultLeadTimeDays: number;

  /** Chặng 17 §10 — chỉ đề xuất duyệt vượt ngân sách cho SKU sắp hết hàng trong vòng bao nhiêu chu kỳ tới. CHƯA PHÊ DUYỆT. */
  overBudgetProposalWindowCycles: number;

  /** Chặng 18 §5 — MOQ dư vượt tỷ lệ này so với số đặt thì bắt buộc chuyển duyệt. CHƯA PHÊ DUYỆT. */
  moqSurplusApprovalThresholdRatio: number;
  /** RULE-05-003 — DEC-P03/P04/P05 (ĐÃ KHÓA 2026-07-20): bật lấp Tầng 2 mức đại diện chu kỳ theo ngưỡng 12-14/8-11 ngày nền. Mặc định true. */
  enableTier2CycleFallback: boolean;
  /**
   * 04 §14/DEC-W05 — nguồn ngân sách, MOQ, nhà cung cấp, ETA thật để kiểm thử Chặng 14–18 hiện
   * "KHÔNG ÁP DỤNG HIỆN TẠI" (chưa có trong bất kỳ pipeline ingest nào). Mặc định 'NOT_APPLICABLE'
   * đúng theo DEC-W05 — toàn bộ đầu ra Chặng 14–19 khi đó là SIMULATION_ONLY, không phải kết luận
   * vận hành thật. Chỉ chuyển 'CONFIRMED' khi người dùng xác nhận dữ liệu vận hành thật đã sẵn sàng.
   */
  operationalDataStatus: 'NOT_APPLICABLE' | 'CONFIRMED';
  /** Chặng 18 §5 — số đặt vượt bội số này của nhu cầu bình quân các chu kỳ khóa gần nhất thì coi là bất thường, bắt buộc chuyển duyệt. CHƯA PHÊ DUYỆT. */
  abnormalOrderMultiplier: number;
  /**
   * DEC-P11 (ĐỀ XUẤT 2026-07-20) — Chặng 11 (dự báo nền) KHÔNG được nạp toàn bộ chuỗi chu kỳ khóa
   * liên tục (có thể tới ~75 CK/3 năm) làm TRAIN/TEST như nhau cho mọi mô hình. Mỗi mô hình chỉ lấy
   * đúng lượng lịch sử cần thiết, đếm NGƯỢC từ chu kỳ gần nhất: lịch sử thừa từng kéo lệch hệ số làm
   * mượt α/β khỏi hành vi gần đây (rà soát thật 2026-07-20, SKU 33811/37918/46569 — CV² đo trên 24 CK
   * gần nhất rất thấp nhưng WAPE Chặng 11 vẫn cao vì α tối ưu trên tới 60 CK TRAIN, phần lớn là dữ
   * liệu 2-3 năm trước không còn phản ánh hành vi hiện tại).
   * `min`/`minSeasons` = ngưỡng dưới còn CHẠY được — ít hơn vẫn chạy (không chặn SKU, đúng nguyên tắc
   * bucket-(c)) nhưng gắn `reliability:'low'`; `reliable`/`reliableSeasons` = cỡ cửa sổ mục tiêu, CẮT
   * BỚT nếu lịch sử dài hơn, KHÔNG kéo dài hơn nếu ngắn hơn. Holt-Winters tính theo bội số mùa
   * (SEASON_LENGTH = 24 CK/mùa). Croston/Nhịp phát sinh dùng chung `croston` (cả hai đọc cùng chuỗi Z).
   */
  forecastWindowCycles: {
    readonly ses: { readonly min: number; readonly reliable: number };
    readonly holt: { readonly min: number; readonly reliable: number };
    readonly holtWinters: { readonly minSeasons: number; readonly reliableSeasons: number };
    readonly croston: { readonly min: number; readonly reliable: number };
  };
}

/** Chặng 14 §8 — 5 mức độ tin cậy của một lô hàng đang về. */
export type LotReliability = 'shipped-confirmed' | 'supplier-confirmed' | 'planned' | 'overdue' | 'cancelled';

export interface SkuDefinition {
  id: string;
  name: string;
  type: string;
  price: number;
  cycles: number;
  description: string;
  category: string;
  supplier: string;
  inboundPlan: {
    offsetDays: number; quantity: number; confirmed: boolean; label: string;
    /** Chặng 14 §8 — mức tin cậy thật của lô; `confirmed` ở trên được suy ra từ trường này để tương thích ngược. */
    reliability: LotReliability;
    /** Chặng 14 §6 — số lượng đã thực nhận của lô (giảm trừ số còn phải về). */
    receivedQuantity: number;
    /** Chặng 14 §6 — số lượng đã bị hủy của lô (giảm trừ số còn phải về). */
    cancelledQuantity: number;
    /** Chặng 14 §4.1/§10 — định danh lô, dùng để phát hiện trùng nguồn hàng khi 2 dòng cùng lotId. */
    lotId: string;
  }[];
  commitments: { offsetDays: number; quantity: number; label: string }[];
  futurePromotions: { cycleOffset: number; promoDays: number; code: string; confirmed: boolean }[];
  leadTimeHistoryDays: number[];
  maxStock: number;
  warehouseCapacity: number;
  shelfLifeDays: number | null;
  purchasePrice: number;
  moq: number;
  purchaseTermsComplete: boolean;
  actualDemand: number[];
  actualEndingStock: number;
  actualReceiptDelayDays: number[];
  actualBudgetUsed: number;

  /** Chặng 14 §5.1 — hàng đang giữ cho đơn khác, chưa thể bán ngay. CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP — mặc định 0. */
  heldStock: number;
  /** Chặng 14 §5.1 — hàng hư hỏng chờ xử lý. CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP — mặc định 0. */
  damagedStock: number;
  /** Chặng 14 §5.1 — hàng bị khóa (tranh chấp/kiểm kê...). CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP — mặc định 0. */
  blockedStock: number;
  /** Chặng 14 §5.1 — hàng không còn đủ điều kiện bán (hết hạn/không đạt chất lượng). CHƯA CÓ TRƯỜNG RIÊNG TỪ ERP — mặc định 0. */
  unsellableStock: number;

  /** Chặng 15 §7 — tồn tối thiểu phải giữ để trưng bày, không phụ thuộc công thức tồn kho an toàn. CHƯA CÓ TRƯỜNG RIÊNG — mặc định 0 (DisplayMin=0). */
  displayMinimumStock: number;

  /** Chặng 16 §8 — số đơn vị trong một thùng/carton, dùng quy đổi trước khi làm tròn MOQ. CHƯA CÓ TRƯỜNG RIÊNG — mặc định 1 (không đổi hành vi cũ). */
  unitsPerCarton: number;
  /** Chặng 16 §8 — bước làm tròn đơn hàng theo số carton (order step). CHƯA CÓ TRƯỜNG RIÊNG — mặc định 1. */
  orderStep: number;
  /** Chặng 16 §9 — giá trị đơn hàng tối thiểu theo nhà cung cấp để không phát sinh phí lẻ; null = chưa có ràng buộc. CHƯA CÓ TRƯỜNG RIÊNG. */
  supplierMinOrderValue: number | null;
  /** Chặng 16 §9 — kho nhận hàng, dùng để gộp đơn cùng nhà cung cấp/kho. CHƯA CÓ TRƯỜNG RIÊNG — mặc định 'KGV'. */
  receivingLocation: string;
  /** Chặng 16 §9 — tiền tệ đặt hàng, dùng để gộp đơn. CHƯA CÓ TRƯỜNG RIÊNG — mặc định 'VND'. */
  currency: string;

  /** Chặng 17 §4 — giá vốn kế hoạch đã gồm cước/thuế nhập khẩu; null = chưa có, dùng tạm purchasePrice và phải cảnh báo là ước tính. CHƯA CÓ TRƯỜNG RIÊNG. */
  landedCostPerUnit: number | null;
  /** Chặng 17 §7 — vai trò danh mục để ưu tiên khi sắp xếp giỏ phân bổ; mặc định 'normal' để không tự đôn ưu tiên SKU nào. CHƯA CÓ TRƯỜNG RIÊNG. */
  coreOrStrategicRole: 'core' | 'strategic' | 'traffic-driver' | 'normal';
  /** Chặng 17 §7 — thứ hạng rủi ro lỗi thời (0=thấp), suy ra thô từ có/không hạn dùng; là proxy, không phải điểm rủi ro thật. */
  obsolescenceRiskRank: number;

  /** RULE-01-004/06-001 — phạm vi tập dữ liệu của phiên đang chạy, sao chép từ SimulationDataset ở Chặng 1. */
  portfolioMode: PortfolioMode;
  /** RULE-01-004 — true khi tập dữ liệu đang chạy là một phần cắt từ danh mục thật (không được kết luận "không có SKU tương tự" chỉ từ tập này). */
  extractIsTruncated: boolean;
}

export interface ReferenceEvidence {
  date: string;
  value: number | null;
  source: BaseDemandSource | null;
  selected: boolean;
  reason: string;
}

/**
 * 02-Hop-dong-du-lieu-dau-vao.md — phân loại ngày theo CTKM chính của mã hàng:
 * - NO_PROMOTION/ALWAYS_ON: giữ nguyên Sales làm mức bán nền quan sát được (ALWAYS_ON
 *   là ưu đãi thường trực đã thành một phần ổn định của tiêu thụ tự nhiên).
 * - DEEP_PROMO: kích cầu mạnh (tbl_POLPromotion.[Type] IN (2, 7)) — KHÔNG dùng Sales
 *   làm baseline, chuyển ngày sang Chặng 4 tìm mức bán tự nhiên.
 * - PROMOTION_UNRESOLVED: có ưu đãi nhưng chưa xác định loại. QUYẾT ĐỊNH 2026-07-17:
 *   Chặng 4 CHỈ xử lý mechanismType 2/7 — ngày UNRESOLVED được coi là ngày bán bình
 *   thường cho baseline; Chặng 4 vẫn tạo task nhắc phân loại (RULE-04-001) để không
 *   tự quyết im lặng.
 */
export type PromotionClass = 'NO_PROMOTION' | 'ALWAYS_ON' | 'DEEP_PROMO' | 'PROMOTION_UNRESOLVED';

/** 02-Hop-dong-du-lieu-dau-vao.md §6 — tình trạng độ tin cậy của dữ liệu tồn ngày. */
export type StockStatus = 'CALCULATED' | 'NEGATIVE_STOCK' | 'ANCHOR_MISSING';

/** tbl_POLPromotion.[Type] được nghiệp vụ khóa là khuyến mãi kích cầu mạnh (DEEP_PROMO). */
export const DEEP_PROMO_MECHANISM_TYPES: readonly number[] = [2, 7];

/**
 * true khi ngày này KHÔNG được dùng trực tiếp Sales làm baseline mà phải qua Chặng 4
 * tìm mức bán tự nhiên (median ngày sạch quanh vùng CTKM). Theo quyết định 2026-07-17,
 * CHỈ DEEP_PROMO (mechanismType 2/7) bị loại — mọi class khác là ngày bán bình thường.
 */
export function isBaselineExcludedPromo(promotionClass: PromotionClass): boolean {
  return promotionClass === 'DEEP_PROMO';
}

export interface DailyDemandRecord {
  sku: string;
  barcode: string;
  date: string;
  openStock: number | null;
  closeStock: number | null;
  /**
   * RULE-01-001/02-Hop-dong-du-lieu-dau-vao.md §5 — `null` khi ngày không có nguồn
   * thật (scaffold) hoặc chưa xác nhận đủ độ đầy đủ POS; SỐ (kể cả 0) chỉ khi có
   * bằng chứng nguồn thật. KHÔNG được coi 0 và null là cùng một giá trị [DEC-007].
   */
  sales: number | null;
  hasSalesRecord: boolean;
  salesObservationStatus: SalesObservationStatus;
  /** RULE-01-003 — true khi ngày này nằm trong vùng đọc tham chiếu trước ProcessingStartDate; không được đưa vào ABC/XYZ hay chuỗi học. */
  isReferenceOnly: boolean;
  /** RULE-02-003/02-Hop-dong-du-lieu-dau-vao.md §6 — trạng thái tính tồn của openStock/closeStock ngày này. */
  stockCalculationStatus: StockCalculationStatus;
  /** 02-Hop-dong-du-lieu-dau-vao.md §6 — openStock/closeStock quan sát trực tiếp hay mang tiếp từ ngày trước. */
  stockSource: StockSource;
  receiptHour: number | null;
  promoCode: string | null;
  promotionStatus: PromotionStatus;
  stockoutStatus: StockoutStatus;
  baseDemand: number | null;
  baseDemandSource: BaseDemandSource;
  isCleanObservedReference: boolean;
  technicalFillStatus: TechnicalFillStatus;
  referenceDates: string[];
  referenceEvidence: ReferenceEvidence[];
  beforeReferenceDates: string[];
  afterReferenceDates: string[];
  referenceMedian: number | null;
  balanceStatus: BalanceStatus;
  selectionReason: string;
  storeCode: number;
  productCode: number;
  promotionName: string | null;
  promotionStartDate: string | null;
  promotionEndDate: string | null;
  promotionType: number | null;
  promotionMechanismType: number | null;
  promotionClass: PromotionClass;
  stockStatus: StockStatus;
}

export type DailyRecord = DailyDemandRecord;

/** RULE-05-005 — 8 trạng thái chu kỳ. OUTSIDE_ACTIVE_PERIOD/DATA_ERROR chưa có nguồn dữ liệu để phát hiện (không có ngày mở/ngưng bán SKU, không có cờ lỗi dữ liệu) nên hiện không bao giờ được gán — ghi nhận tường minh, không giả vờ có khả năng phát hiện. */
export type CycleStatus = 'LOCKED_OBSERVED' | 'LOCKED_ADJUSTED' | 'LOCKED_FALLBACK' | 'PARTIAL_BASELINE' | 'NO_SOURCE_RECORD' | 'BASELINE_UNRESOLVED' | 'BLOCKED_NO_VALID_BASELINE' | 'OUTSIDE_ACTIVE_PERIOD' | 'DATA_ERROR';

export interface CycleRecord {
  cycleIndex: number;
  dateStart: string;
  dateEnd: string;
  days: number;
  baseDemand: number;
  locked: boolean;
  emptyCycle: boolean;
  cleanDays: number;
  stockoutLiftedDays: number;
  promoNormalizedDays: number;
  technicalFillDays: number;
  unresolvedDays: number;
  /** RULE-05-001 — số ngày CÓ bản ghi nguồn thật (hasRecord=true), bất kể đã giải quyết được baseDemand hay chưa. Chỉ giá trị này =0 mới được kết luận NO_SOURCE_RECORD. */
  sourceRecordDays: number;
  /** RULE-05-001/03-003 cấp 3 — số ngày trong chu kỳ dùng nguồn dự phòng (mùa vụ năm trước) thay vì nền theo thời gian bình thường. */
  fallbackDays: number;
  /** RULE-05-003 — true khi chu kỳ được lấp bằng mức đại diện Tầng 2 (median các ngày nền hợp lệ có sẵn trong chính chu kỳ), khác Tầng 1 (lấp từng ngày bằng ngày sạch lân cận). */
  tier2Filled: boolean;
  /** RULE-05-003 — true khi chu kỳ được khóa nhờ lấp Tầng 2 (12–14 ngày nền có ngày ước lượng, hoặc 8–11 ngày nền) — bắt buộc con người rà soát dù đã khóa để tính. */
  reviewRequired: boolean;
  status: CycleStatus;
  seasonRound: number;
  seasonPosition: number;
}

export interface Classification {
  abc: AbcClass;
  /** RULE-06-001/DEC-010 — ABC chỉ được coi là chính thức khi portfolioMode là FULL_PORTFOLIO hoặc USE_APPROVED_SNAPSHOT; SELECTED_SKU_SIMULATION chỉ là xếp hạng mô phỏng trong tập hiện tại. */
  abcOfficial: boolean;
  /** RULE-06-002 — hệ thống chỉ tự sinh PROPOSED; không có cơ chế phê duyệt/lưu vết bền vững trong công cụ mô phỏng một lượt chạy này nên KHÔNG BAO GIỜ tự chuyển EFFECTIVE — cần quy trình phê duyệt ngoài phạm vi app này (xem 06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md). */
  approvalStatus: 'PROPOSED' | 'EFFECTIVE';
  /** §2.1 LỆNH CODEX — chất lượng cửa sổ 24 vị trí gần nhất: 'full'=FULL_COVERAGE (24/24 khóa), 'annualized'=ANNUALIZED_WITH_GAPS (≥6 khóa, có khoảng khuyết), 'not-rated'=NOT_RATED (<6 khóa). */
  abcStatus: 'full' | 'annualized' | 'not-rated';
  lockedCycles: number;
  periodQuantity: number;
  annualizationFactor: number | null;
  annualQuantity: number | null;
  annualValue: number;
  valueShare: number;
  cumulativeShare: number;
  abcRank: number | null;
  /** RULE-07-003 — null khi classificationStatus khác 'CLASSIFIED' (chặn cửa sổ hoặc không có nhu cầu dương). */
  xyz: XyzClass | null;
  /** RULE-07-003/004 — 'CLASSIFICATION_BLOCKED' khi cửa sổ 24 vị trí gần nhất theo lịch có ít nhất một chu kỳ không khóa; 'NO_POSITIVE_DEMAND_REVIEW' khi cửa sổ đủ dài (n≥6) và liên tục nhưng toàn bộ chu kỳ bằng 0. */
  classificationStatus: 'CLASSIFIED' | 'CLASSIFICATION_BLOCKED' | 'NO_POSITIVE_DEMAND_REVIEW';
  /** RULE-07-003 — trạng thái chu kỳ đã chặn cửa sổ; chỉ có giá trị khi classificationStatus='CLASSIFICATION_BLOCKED'. */
  classificationBlockReason: CycleStatus | null;
  n: number;
  m: number;
  adi: number | null;
  positiveMean: number | null;
  positiveStdev: number | null;
  cv: number | null;
  cv2: number | null;
  /** RULE-07-001 — lý do cụ thể khi xyz='D'; null khi không phải nhóm D. */
  dSubtype: DSubtype | null;
  /** RULE-07-002 — bằng chứng chất lượng chuỗi: tỷ lệ chu kỳ khóa thành công / tổng chu kỳ có trong khung (0..1); null khi chưa có chu kỳ nào trong khung. */
  seriesQualityRatio: number | null;
  /** RULE-07-002 — lý do phân loại dạng văn bản, phục vụ kiểm toán. */
  classificationReason: string;
}

/** Một dòng trong danh sách r(p) đã thử khi dò chu kỳ lặp ngắn [C11 §8.8, §8.12]. */
export interface ShortCycleScanEntry {
  p: number;
  r: number | null;
  status: 'candidate' | 'below-threshold' | 'insufficient-data';
}

export type ForecastModelName = 'SES' | 'Holt' | 'Holt-Winters' | 'SeasonalNaive' | 'Croston' | 'PulseRhythm' | 'PurchasePlan';

export interface ForecastResult {
  model: ForecastModelName;
  params: Record<string, number>;
  baseForecast: number[];
  rmse: number | null;
  nrmse: number | null;
  wape: number | null;
  bias: number | null;
  hitRate: number | null;
  missedPulses: number;
  falsePulses: number;
  wapePositive: number | null;
  lockStatus: LockStatus;
  reason: string;
  /** Danh sách r(p) đã thử ở cửa chu kỳ ngắn 11XY-SN; null nếu SKU không qua cửa này [C11 §8.12]. */
  rpScan: ShortCycleScanEntry[] | null;
  /** Chu kỳ lặp p* đã chọn nếu SeasonalNaive được khóa [C11 §8.8]. */
  pStar: number | null;
  /** Mô hình đối chứng đã so ở kiểm tra ngược và WAPE của nó [C11 §8.10]. */
  controlModel: ForecastModelName | null;
  controlWape: number | null;
  /** 'low' khi tập TEST < 3 chu kỳ: ĐỘ TIN CẬY THẤP — KHÔNG DÙNG ĐỂ SO MÔ HÌNH TỰ ĐỘNG [C11 §8.10]. */
  reliability: 'ok' | 'low';
  /** Chu kỳ nguồn (1-based) được sao chép cho từng F tương lai của SeasonalNaive [C11 §8.12]. */
  futureSources: number[] | null;
}

export interface SupplyMilestone {
  date: string;
  label: string;
  onHand: number;
  confirmedInbound: number;
  committed: number;
  freeStock: number;
}

/** Chặng 15 §5/§6 — phương pháp tính đã dùng, theo đúng thứ bậc ưu tiên của tài liệu. */
export type SafetyStockMethod = 'percentile' | 'z-formula' | 'policy-buffer';
/** Chặng 15 §5/§6 — nguồn mẫu dùng để tính, theo thứ bậc thay thế khi thiếu dữ liệu SKU tự thân. */
export type SafetyStockSourceTier = 'sku-history' | 'abc-xyz-group' | 'policy-fallback';

export interface SafetyStockAuditState {
  z: number;
  serviceLevel: number;
  dBar: number;
  sigmaD: number;
  sigmaDSource: 'backtest' | 'cycle-std';
  sigmaDObservationCount: number;
  ltBarDays: number;
  sigmaLtDays: number;
  ltBarCycles: number;
  sigmaLtCycles: number;
  /** Giữ để tương thích ngược; suy ra từ `method` (`'full'` khi method≠'policy-buffer'). */
  formula: 'full' | 'policy';
  warnings: string[];
  /** Chặng 15 §5/§6 — phương pháp thực sự đã dùng để chốt Z/SS. */
  method: SafetyStockMethod;
  /** Chặng 15 §5/§6 — nguồn mẫu độ lệch lead-time đã dùng. */
  sourceTier: SafetyStockSourceTier;
  /** Chặng 15 §5 — mẫu độ lệch (actual−forecast trong lead time) đã dùng cho percentile; null nếu dùng công thức Z×√(...). */
  percentileSample: number[] | null;
  /** Chặng 15 §4 — kết quả dò từng mức phục vụ ứng viên. */
  serviceLevelSearch: { candidate: number; passed: boolean; failedConditions: string[] }[];
  /** Chặng 15 §4 — không mức phục vụ ứng viên nào đạt đủ 4 điều kiện. */
  unfeasiblePolicy: boolean;
  /** Chặng 15 §7 — mức cần bảo vệ = max(SS, tồn trưng bày tối thiểu). */
  protection: number;
  /** Chặng 15 §8 — trần thực sự bảo vệ được (trần tồn/sức chứa/hạn dùng), null nếu không có ràng buộc nào áp dụng. */
  maxProtectable: number | null;
  /** Chặng 15 §8 — phần bảo vệ không thể đáp ứng = max(0, protection − maxProtectable). */
  unmetProtection: number;
}

export interface OrderPlanState {
  coverageCycles: number;
  demandCover: number;
  freeStock: number;
  rawQuantity: number;
  orderQuantity: number;
  moq: number;
  moqSurplus: number;
  warnings: string[];
  /** Chặng 16 §3 — số ngày của vùng cần bao phủ = lead time (thật hoặc mặc định chính sách) + chu kỳ lập kế hoạch. */
  coverageDays: number;
  /** Chặng 16 §8 — số carton đã đặt sau khi làm tròn theo order-step. */
  cartonsOrdered: number;
  /** Chặng 16 §7 — lượng thiếu hụt dự kiến trước khi lô mới về, theo mô phỏng tồn từng chu kỳ. */
  shortageBeforeNewLot: number;
  /** Chặng 16 §7 — chu kỳ đầu tiên dự kiến tồn âm; null nếu không có chu kỳ nào âm trong tầm dự báo. */
  daysToStockout: number | null;
  /** Chặng 16 §9 — trạng thái gộp đơn theo nhà cung cấp/kho/tiền tệ so với giá trị tối thiểu. */
  consolidationStatus: 'ok' | 'below-supplier-minimum' | 'not-applicable';
  /** Chặng 16 §10 — số đặt vượt nhu cầu ước tính trong hạn dùng còn lại. */
  expiryRisk: boolean;
  /** Chặng 16 §10 — số đặt cộng tồn hiện có vượt sức chứa kho. */
  capacityRisk: boolean;
}

/** Chặng 17 §9 — trạng thái cấp vốn theo đúng bảng tài liệu, thay cho chuỗi lý do tự do trước đây. */
export type BudgetAllocationStatus = 'funded-full' | 'funded-partial-valid' | 'shortage-only' | 'deferred-no-budget' | 'over-budget-proposal' | 'out-of-scope' | 'awaiting-consolidation';

export interface BudgetAllocationState {
  orderValue: number;
  priorityRank: number | null;
  fundedQuantity: number;
  fundedValue: number;
  cutQuantity: number;
  reason: string;
  /** Chặng 17 §5/§6 — rổ chính đã cấp vốn nhiều nhất (1=tránh hết hàng, 2=bảo vệ, 3=rủi ro MOQ); một SKU có thể có số lượng ở nhiều rổ, đây là rổ đại diện để hiển thị. */
  basket: 1 | 2 | 3;
  /** Chặng 17 §5.1 — số lượng tối thiểu để tránh hết hàng (Rổ 1). */
  minimumToAvoidShortage: number;
  /** Chặng 17 §5.2 — số lượng bổ sung để đạt mức bảo vệ đầy đủ (Rổ 2). */
  additionalForProtection: number;
  /** Chặng 17 §6 — phần số lượng thuộc diện rủi ro MOQ/hết hạn/quá sức chứa (Rổ 3). */
  atRiskQuantity: number;
  /** Chặng 17 §4 — true khi `landedCostPerUnit` chưa có và đang tạm dùng purchasePrice. */
  landedCostIsEstimate: boolean;
  /** Chặng 17 §9 — trạng thái cấp vốn theo bảng tài liệu. */
  status: BudgetAllocationStatus;
  /** Chặng 17 §10 — đề xuất duyệt vượt ngân sách; null nếu không thuộc diện đề xuất. */
  overBudgetProposal: { shortfallValue: number; requiredQuantity: number; stockoutDate: string | null; impactIfNotFunded: string; impactIfFunded: string } | null;
}

export interface ReleaseDecisionState {
  status: 'not-issued' | 'awaiting-info' | 'awaiting-approval' | 'issued';
  releasedQuantity: number;
  reasons: string[];
  /** Chặng 18 §7 — số lượng trước khi qua cổng duyệt (bằng số được cấp vốn ở Chặng 17). */
  quantityBeforeApproval: number;
  /** Chặng 18 §7 — số lượng sau khi qua cổng duyệt (0 nếu chưa phát hành). */
  quantityAfterApproval: number;
  /** Chặng 18 §8 — khóa nhóm PO (nhà cung cấp+tiền tệ+kho nhận) mà dòng này thuộc về; null nếu chưa gộp nhóm. */
  purchaseOrderGroupKey: string | null;
  /** Chặng 18 §9 — true nếu lần phát hành này bị chặn vì đã phát hành cho cùng planningSessionId trước đó. */
  duplicateReleaseBlocked: boolean;
}

export interface PostAuditState {
  forecastWape: number | null;
  actualDemand: number;
  stockoutUnits: number;
  endingStock: number;
  averageReceiptDelayDays: number;
  budgetVariance: number;
  primaryCause: string;
  proposal: string;
  proposalStatus: 'future-version' | 'monitor';
  /** Chặng 19 §4.1 — sai số dự báo NỀN (chỉ đo trên chu kỳ không có CTKM xác nhận), tách biệt với sai số dự báo CUỐI. null nếu chưa đủ dữ liệu để tính. */
  baseForecastWape: number | null;
  baseForecastRmse: number | null;
  baseForecastNrmse: number | null;
  baseForecastBias: number | null;
  /** Chặng 19 §4.2 — bổ sung đủ bộ RMSE/nRMSE/Bias cho dự báo CUỐI (WAPE đã có ở `forecastWape`). */
  finalForecastRmse: number | null;
  finalForecastNrmse: number | null;
  finalForecastBias: number | null;
  /** Chặng 19 §7 — phần dư phát sinh do làm tròn MOQ tại thời điểm đặt (đọc từ orderPlan.moqSurplus). */
  moqSurplusResidual: number;
  /** Chặng 19 §8 dòng 4 — số lượng bị cắt vì ngân sách (đọc từ budgetAllocation.cutQuantity). */
  budgetCutUnits: number;
  /** Chặng 19 §8 dòng 5 — số lượng bị giảm do quyết định thủ công ở Chặng 18 (quantityBeforeApproval − quantityAfterApproval). */
  manualReductionUnits: number;
  /** Chặng 19 §5 — lead time thực tế đo được, nếu có. */
  leadTimeActualDays: number | null;
  /** Chặng 19 §5 — độ trễ nhận hàng so với kế hoạch (ngày), giữ dấu để truy vết sớm/trễ. */
  receiptDelayDaysVsPlan: number;
  /** Chặng 19 §8 — mọi nguyên nhân khớp trong bảng 10 nguyên nhân, không chỉ nguyên nhân chính. */
  contributingCauses: string[];
  /** Chặng 19 §8 — bằng chứng số liệu dùng để kết luận nguyên nhân, phục vụ kiểm toán. */
  evidence: string[];
}

export interface SkuPipelineState {
  definition: SkuDefinition;
  daily: DailyRecord[];
  /** RULE-01-003 — vùng đọc tham chiếu trước ProcessingStartDate (DEC-P01, chưa duyệt chính thức); đã nạp lịch liên tục nhưng KHÔNG được đưa vào `daily`/ABC/XYZ/chuỗi học. */
  referenceOnlyDaily: DailyRecord[];
  cycles: CycleRecord[];
  classification: Classification;
  serviceLevel: number | null;
  capitalPriority: string;
  seasonality: 'confirmed' | 'no-clear-season' | 'insufficient-structure' | 'not-applicable';
  trend: 'up' | 'down' | 'none' | 'insufficient';
  trendRates: [number | null, number | null];
  forecast: ForecastResult | null;
  promoFactor: number | null;
  promoConfidence: 'auto' | 'low' | 'suggest-only' | 'none' | 'blocked';
  finalForecast: number[];
  /** RULE-13-001 — literal status: 'PASSTHROUGH_NO_FUTURE_PROMO' khi không có kế hoạch CTKM tương lai đã xác nhận nào (đúng phiên HISTORICAL_VALIDATION/DEC-008/DEC-009 hiện tại), 'FUTURE_PROMO_APPLIED' khi có ít nhất một kế hoạch được áp. */
  finalForecastStatus: 'PASSTHROUGH_NO_FUTURE_PROMO' | 'FUTURE_PROMO_APPLIED';
  freeStock: number | null;
  supplyMilestones: SupplyMilestone[];
  safetyStock: number | null;
  safetyStockAudit: SafetyStockAuditState | null;
  orderPlan: OrderPlanState | null;
  budgetAllocation: BudgetAllocationState | null;
  releaseDecision: ReleaseDecisionState | null;
  postAudit: PostAuditState | null;

  /** Chặng 14 §5.1 — tồn có thể sử dụng ngay (khác I_free §9: luôn ≥0, dùng làm onHand cho chuỗi mốc nguồn hàng). */
  availableStockAudit: { actualStock: number; heldStock: number; damagedStock: number; blockedStock: number; unsellableStock: number; availableStock: number; mismatch: boolean } | null;
  /** Chặng 14 §8/§12 — các lô bị loại khỏi hàng tự do, kèm lý do (không chỉ đếm số lượng như trước). */
  excludedLots: { lotId: string; quantity: number; reliability: LotReliability; reason: string }[];
  /** Chặng 14 §4.1/§10 — cờ chờ kiểm tra nguồn hàng khi phát hiện dấu hiệu tính trùng lô. */
  supplyStatus: { pendingVerification: boolean; reasons: string[] };
}

export interface StageDefinition {
  number: StageNumber;
  phase: number;
  title: string;
  shortTitle: string;
  goal: string;
  flow: string[];
  formula: string;
  variables: { symbol: string; meaning: string }[];
}

export interface FormulaBlock {
  title: string;
  expression: string;
  source: string;
}

/**
 * 06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md §6 — mã ngoại lệ chuẩn, không tự đặt mã mới ngoài danh sách này.
 * D_BASELINE_UNRESOLVED không còn được phát sinh (xem ghi chú DSubtype) — giữ literal, không xóa để không phá kiểu.
 * ABC_INPUT_BLOCKED/CLASSIFICATION_BLOCKED/FORECAST_INPUT_BLOCKED — RULE-06-003/07-003/11-001: chuỗi chu kỳ dùng để
 * tính ABC/XYZ/dự báo bị đứt quãng (có chu kỳ không khóa xen giữa), không được nối lại thành chuỗi liên tục giả.
 * CYCLE_EXCEPTION — RULE-05-006 (cổng chất lượng chuỗi sau Chặng 5): một task GỘP theo chu kỳ (không phải theo
 * ngày) cho mỗi CK không khóa; mang `cycleIndexes/affectedDateFrom/affectedDateTo/resolutionOptions` bên dưới.
 */
export type ExceptionCode = 'BASELINE_NOT_IDENTIFIABLE' | 'PROMO_TYPE_UNKNOWN' | 'STOCK_ANCHOR_MISSING' | 'ABC_SCOPE_INCOMPLETE' | 'D_BASELINE_UNRESOLVED' | 'POLICY_UNRESOLVED' | 'ABC_INPUT_BLOCKED' | 'CLASSIFICATION_BLOCKED' | 'FORECAST_INPUT_BLOCKED' | 'CYCLE_EXCEPTION' | 'CYCLE_TIER2_REVIEW_REQUIRED';
/** 06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md §3 — trạng thái task xử lý ngoại lệ. */
export type ExceptionTaskStatus = 'OPEN' | 'CANDIDATE_FOUND' | 'WAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RESOLVED';

/**
 * Phương án xử lý ngoại lệ NGOÀI phạm vi mô phỏng — hệ thống chỉ liệt kê, KHÔNG bao giờ tự thực hiện
 * (xem `ExceptionResolutionOption.executableInSimulation`, luôn `false`). MD_FUTURE_PLAN chỉ áp dụng
 * cho dự báo tương lai, không được lấp ngược chu kỳ lịch sử; các phương án còn lại chỉ dùng cho nền lịch sử.
 */
export type ExceptionResolutionType =
  | 'RESTORE_DAILY_BASELINE'
  | 'REFERENCE_STORE'
  | 'SIMILAR_SKU'
  | 'MANUAL_HISTORICAL_BASELINE'
  | 'MD_FUTURE_PLAN'
  | 'KEEP_UNRESOLVED';

export interface ExceptionResolutionOption {
  readonly type: ExceptionResolutionType;
  readonly title: string;
  readonly description: string;
  readonly requiredInputs: readonly string[];
  readonly requiresApproval: boolean;
  readonly responsibleRole: string;
  readonly applicableTo: 'HISTORICAL_BASELINE' | 'FUTURE_FORECAST';
  readonly executableInSimulation: false;
}

/**
 * 04-Dac-ta-trien-khai-Demand-Planning.md §15 — một mục trong hàng đợi ngoại lệ, luôn gắn RuleId để truy vết.
 * Các trường `cycleIndexes.../simulationOnly` là mở rộng tương thích ngược (optional) cho ngoại lệ cấp CHU
 * KỲ (RULE-05-006) — ngoại lệ cấp NGÀY (Chặng 2–4) không cần điền các trường này.
 */
export interface ExceptionTask {
  readonly id: string;
  readonly ruleId: string;
  readonly code: ExceptionCode;
  readonly stage: StageNumber;
  readonly skuId: string;
  readonly date: string | null;
  readonly evidence: string;
  readonly suggestedAction: string;
  readonly role: string;
  readonly status: ExceptionTaskStatus;
  readonly decisionVersion: string;
  /** RULE-05-006 — các chu kỳ (thường một CK duy nhất) mà task này gộp lại; rỗng/undefined cho ngoại lệ cấp ngày. */
  readonly cycleIndexes?: readonly number[];
  readonly affectedDateFrom?: string | null;
  readonly affectedDateTo?: string | null;
  /** Các chặng sau bị chặn/ảnh hưởng bởi ngoại lệ này (ví dụ ABC=6, XYZ=7, mùa vụ=9, xu hướng=10, dự báo=11). */
  readonly blockingStages?: readonly StageNumber[];
  /** Phương án xử lý CÓ THỂ thực hiện NGOÀI mô phỏng — mô phỏng chỉ đề xuất, không tự áp dụng. */
  readonly resolutionOptions?: readonly ExceptionResolutionOption[];
  /** true ⇔ ngoại lệ này chỉ có ý nghĩa trong phiên mô phỏng hiện tại — chưa qua quy trình phê duyệt/thực thi thật. */
  readonly simulationOnly?: boolean;
}

/**
 * §7 LỆNH CODEX — vai trò kinh doanh do Hachi gán, nạp từ asset benchmark riêng (KHÔNG phải từ pipeline SQL).
 * CHỈ dùng để đối chiếu SAU KHI hệ thống đã tính ABC/XYZ/mùa vụ/mô hình độc lập — không bao giờ được dùng làm
 * đầu vào cho các phép tính đó (xem test bất biến ở `business-role.spec.ts`).
 */
export type HachiBusinessRole = 'CORE' | 'SEASONAL' | 'MARGIN' | 'TRAFFIC' | 'NEW' | 'STANDARD';

/** §7.1 — kết luận đối chiếu giữa HachiBusinessRole (benchmark) và kết quả hệ thống tính độc lập. */
export type BusinessRoleComparisonConclusion =
  | 'ALIGNED'
  | 'POSSIBLE_DIFFERENCE'
  | 'INVESTIGATION_REQUIRED'
  | 'NOT_COMPARABLE_WITH_CURRENT_DATA'
  | 'NOT_EVALUATED';

export interface BusinessRoleComparisonRow {
  readonly skuId: string;
  readonly skuName: string;
  readonly hachiRole: HachiBusinessRole | null;
  readonly systemResult: string;
  readonly comparableLevel: string;
  readonly conclusion: BusinessRoleComparisonConclusion;
  readonly reason: string;
}

/**
 * §8 — bằng chứng vòng đời sản phẩm chính thức cho D_NEW/D_SHORT_HISTORY. Nguồn ngoài pipeline demand hiện tại
 * (asset riêng, optional) — vắng mặt thì KHÔNG được suy ra vòng đời chỉ từ HachiBusinessRole='NEW'.
 */
export interface ProductLifecycleRecord {
  readonly skuId: string;
  readonly lifecycleStage: 'NEW' | 'GROWTH' | 'MATURE' | 'DECLINE' | 'DISCONTINUED';
  readonly asOfDate: string;
  readonly evidence: string;
}

/**
 * Yêu cầu cập nhật nguồn dữ liệu thật §4 — hợp đồng dữ liệu thô V2 từ RESULT SET 1 của
 * `Sql/demand-planing.sql` (demand-planing-v6-pos-real-backtest). Đây là DTO NGUỒN, chưa chuẩn hóa —
 * không được ép vào `DailyRecord` (đã qua calendar scaffold) quá sớm. Bất biến bắt buộc:
 *
 * ```
 * sales === null  ⇔ hasSalesRecord === false   (không có dòng bán POS thật trong ngày)
 * sales is number ⇔ hasSalesRecord === true    (có dòng bán thật, kể cả tổng Qty = 0)
 * ```
 *
 * Tương tự cho `returnQty/hasReturnRecord` và `inventoryNetMovement/hasInventoryMovement`.
 */
export interface DailySourceRecordV2 {
  readonly sku: string;
  readonly date: string;
  readonly openStock: number;
  readonly closeStock: number;

  readonly sales: number | null;
  readonly hasSalesRecord: boolean;
  readonly isZeroSaleInferred?: boolean;

  readonly returnQty: number | null;
  readonly hasReturnRecord: boolean;

  readonly inventoryNetMovement: number | null;
  readonly hasInventoryMovement: boolean;
  readonly totalStockDelta: number;

  readonly receiptHour: number | null;
  readonly hasReceiptRecord: boolean;
  readonly receiptTimeSource: 'RECEIPT_DATE' | 'CREATE_TIME_FALLBACK' | 'UNRESOLVED' | null;

  readonly promoCode: string | null;
  readonly promoName: string | null;
  readonly price: number | null;
  readonly productName: string | null;

  readonly hasRecord: true;
  readonly isOpeningAnchor: boolean;
  readonly isReferenceOnly: boolean;
  readonly isHistoryRecord: boolean;
  readonly isValidationActual: boolean;
}

export interface StageSnapshot {
  stage: StageNumber;
  completedAt: string;
  policyVersion: string;
  states: Readonly<Record<string, Readonly<SkuPipelineState>>>;
  summary: Readonly<Record<string, string | number>>;
  audit: readonly string[];
  /** 04 §15/06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md — ngoại lệ MỚI phát sinh ở chặng này (không dồn từ chặng trước, giống cách `audit` chỉ ghi log của riêng chặng này). */
  exceptions: readonly ExceptionTask[];
}

export interface StageViewModel {
  definition: StageDefinition;
  hasRun: boolean;
  state: Readonly<SkuPipelineState> | null;
  summary: Readonly<Record<string, string | number>>;
  audit: readonly string[];
  /** Ngoại lệ MỚI phát sinh riêng ở chặng đang xem (không dồn từ chặng trước) — xem `StageSnapshot.exceptions`. */
  exceptions: readonly ExceptionTask[];
  inputs: { label: string; value: string }[];
  calculations: { label: string; value: string }[];
  outputs: { label: string; value: string; tone?: 'good' | 'warn' | 'neutral' }[];
  formulas: FormulaBlock[];
}
