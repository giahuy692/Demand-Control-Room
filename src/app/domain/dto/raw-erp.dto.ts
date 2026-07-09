/**
 * Raw Response DTOs — hình dạng dữ liệu thô đúng như API/ERP trả về (bảng tbl_SAL..., tbl_OPS...).
 * Lớp này KHÔNG có logic, KHÔNG có getter tính toán. Chỉ mô tả field-by-field để:
 *  - tránh "any" lan khắp codebase khi consume API thật;
 *  - làm input duy nhất cho các Mapper ở `sku-view.model.ts`.
 * Kiểu string cho các cột thời gian vì JSON/REST trả ISO string, không phải Date.
 */

/** tbl_SALPoSDetails — 1 dòng = 1 mặt hàng trong 1 hóa đơn POS. */
export interface PosDetailRawDto {
  Code: string;
  PoSMaster: string;
  RePosDetails: string | null;
  Product: string;
  Qty: number;
  BaseUnit: string;
  TranUnit: string;
  ConvertUnit: number;
  Amount: number;
  VAT: number;
  Tax: number;
  DiscountAmount: number;
  Discount: number;
  OrderBy: number | null;
  Revenue: number;
  DiscountCard: number;
  DiscountAllocation: number;
  AvgPrice: number;
  PowerCard: string | null;
  PowerID: string | null;
  Barcode: string | null;
  EmployeeID: string | null;
  BOM: string | null;
  BOMQty: number | null;
  BOMPrice: number | null;
  BOMDiscountPrice: number | null;
  BOMName: string | null;
  DiscountGroupProduct: string | null;
  DiscountCouponInv: string | null;
}

/** tbl_SALPoSMaster — 1 dòng = 1 hóa đơn/phiên giao dịch POS. */
export interface PosMasterRawDto {
  Code: string;
  RefPosMaster: string | null;
  TransactionNo: string;
  TransactionDate: string;
  EffDate: string;
  Shift: string | null;
  TransactionType: string;
  Amount: number;
  Discount: number;
  DiscountCard: number;
  VAT: number;
  IsProcess: boolean;
  Revenue: number;
  DiscountAllocation: number;
  CashPaid: number;
  CardPaid: number;
  ReturnPaid: number;
  Remark: string | null;
  IsApproved: boolean;
  CreateBy: string | null;
  CreateTime: string;
  LastModifiedBy: string | null;
  LastModifiedTime: string | null;
  ReasonID: string | null;
}

/** tbl_OPSImExMaster — chứng từ nhập/xuất kho. */
export interface ImExMasterRawDto {
  Code: string;
  DocumentNo: string;
  DocumentType: string;
  DocumentStatus: string;
  EffDate: string;
  ReceiptDate: string | null;
  Source: string;
  Destination: string;
  Reference: string | null;
  Remark: string | null;
  Inventory: string;
  PO: string | null;
  IsApproved: boolean;
  Createby: string | null;
  CreateTime: string;
}

/** tbl_OPSImExDetails — dòng chi tiết chứng từ nhập/xuất (dùng để suy ra tồn đầu/cuối, phiếu nhập đầu tiên trong ngày). */
export interface ImExDetailRawDto {
  Code: string;
  DocumentNo: string;
  Product: string;
  IDX: number;
  Quantity: number;
  QtyReceived: number;
  UnitPrice: number;
  VATPercentage: number;
  ExchangeRate: number | null;
  Currency: string | null;
  AvgPrice: number;
  IsNew: boolean;
  POStore: string | null;
  ExpiredDate: string | null;
  ExpDuration: number | null;
  RefID: string | null;
}

/** tbl_POLPromotion — chương trình CTKM lịch sử/tương lai. */
export interface PromotionRawDto {
  Code: string;
  PromotionNo: string;
  Promotion: string;
  PromotionType: string;
  StartDate: string;
  EndDate: string;
  Remark: string | null;
  IsGoldHour: boolean;
  Type: string;
  Amount: number;
  IsUse: boolean;
  IsWholeSale: boolean;
  IsPOS: boolean;
}

/** tbl_LSStatus — danh mục trạng thái dùng chung (SKU, chứng từ...). */
export interface StatusRawDto {
  Code: string;
  StatusName: string;
  TypeOfStatus: string;
}
