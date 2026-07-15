USE [POS];
SET NOCOUNT ON;

/*
  Chạy từng khối. Không có lệnh INSERT/UPDATE/DELETE vào bảng thật.
  Thay danh sách mã mẫu theo nhu cầu.
*/

/* 1. Kiểm tra mapping Product/Barcode. */
SELECT TOP 200 Code, Barcode
FROM dbo.tbl_LSProduct
WHERE Barcode IN (N'4932313033092',N'4965078102116');

/* 2. Phân bố POS master để xác định phiếu hợp lệ/hủy/trả. */
SELECT m.TransactionType,m.StatusName,m.IsProcess,m.IsApproved,
       COUNT(DISTINCT m.Code) InvoiceCount,COUNT(d.Code) LineCount,
       SUM(CASE WHEN d.RePosDetails IS NULL THEN COALESCE(d.Qty,0) ELSE 0 END) NormalQty,
       SUM(CASE WHEN d.RePosDetails IS NOT NULL THEN COALESCE(d.Qty,0) ELSE 0 END) RePosQty
FROM dbo.tbl_SALPoSMaster m
LEFT JOIN dbo.tbl_SALPoSDetails d ON d.PoSMaster=m.Code
GROUP BY m.TransactionType,m.StatusName,m.IsProcess,m.IsApproved
ORDER BY InvoiceCount DESC;

/* 3. Kiểm tra ngày không có dòng POS: bảng chi tiết có phải event-driven không. */
SELECT COUNT(*) TotalLines,
       SUM(CASE WHEN Qty=0 THEN 1 ELSE 0 END) ZeroQtyLines,
       SUM(CASE WHEN Qty<0 THEN 1 ELSE 0 END) NegativeQtyLines
FROM dbo.tbl_SALPoSDetails;

/* 4. Kiểm tra RePosDetails. */
SELECT TOP 200 d.Code,d.RePosDetails,d.PoSMaster,m.TransactionNo,m.TransactionDate,
       m.TransactionType,m.StatusName,d.Product,d.Qty,d.Amount
FROM dbo.tbl_SALPoSDetails d
LEFT JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
WHERE d.RePosDetails IS NOT NULL
ORDER BY m.TransactionDate DESC;

/* 5. Kiểm tra join kho theo FK. */
SELECT COUNT(*) DetailLines,
       SUM(CASE WHEN mByCode.Code IS NOT NULL THEN 1 ELSE 0 END) JoinByMasterCode,
       SUM(CASE WHEN mByNo.Code IS NOT NULL THEN 1 ELSE 0 END) JoinByMasterDocumentNo
FROM dbo.tbl_OPSImExDetails d
LEFT JOIN dbo.tbl_OPSImExMaster mByCode ON mByCode.Code=d.DocumentNo
LEFT JOIN dbo.tbl_OPSImExMaster mByNo ON mByNo.DocumentNo=d.DocumentNo;

/* 6. Đối soát dấu tồn theo DocumentType/Status. */
SELECT m.DocumentType,dt.DocumentType DocumentTypeName,dt.TypeID,
       m.DocumentStatus,s.StatusName,COUNT(*) LineCount,
       SUM(d.Quantity) TotalQuantity,SUM(d.QtyReceived) TotalQtyReceived,
       SUM(CASE WHEN d.Quantity IS NULL THEN 1 ELSE 0 END) NullQuantity,
       SUM(CASE WHEN d.QtyReceived IS NULL THEN 1 ELSE 0 END) NullQtyReceived
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
LEFT JOIN dbo.tbl_LSDocumentType dt ON dt.Code=m.DocumentType
LEFT JOIN dbo.tbl_LSStatus s ON s.Code=m.DocumentStatus
GROUP BY m.DocumentType,dt.DocumentType,dt.TypeID,m.DocumentStatus,s.StatusName
ORDER BY m.DocumentType,m.DocumentStatus;

/* 7. Chất lượng giờ nhập. */
SELECT m.DocumentType,COUNT(*) DocumentCount,
       SUM(CASE WHEN m.ReceiptDate IS NOT NULL AND CONVERT(time,m.ReceiptDate)<>'00:00:00' THEN 1 ELSE 0 END) ReceiptDateHasTime,
       SUM(CASE WHEN m.CreateTime IS NOT NULL AND CONVERT(time,m.CreateTime)<>'00:00:00' THEN 1 ELSE 0 END) CreateTimeHasTime
FROM dbo.tbl_OPSImExMaster m
GROUP BY m.DocumentType
ORDER BY m.DocumentType;

/* 8. Độ phủ CTKM theo mã và SKU. */
SELECT b.Product,pr.Code PromoCode,pr.Promotion PromoName,
       MIN(pr.StartDate) StartDate,MAX(pr.EndDate) EndDate,
       COUNT(*) BundleLines,pr.PromotionType,pr.IsPOS
FROM dbo.tbl_POLBundle b
JOIN dbo.tbl_POLPromotion pr ON pr.Code=b.Promotion
GROUP BY b.Product,pr.Code,pr.Promotion,pr.PromotionType,pr.IsPOS
ORDER BY b.Product,StartDate;

/* 9. CTKM chồng lấn của cùng SKU. */
WITH P AS
(
    SELECT DISTINCT CONVERT(nvarchar(100),b.Product) SKU,pr.Code,
           CONVERT(date,pr.StartDate) StartDate,CONVERT(date,pr.EndDate) EndDate
    FROM dbo.tbl_POLBundle b
    JOIN dbo.tbl_POLPromotion pr ON pr.Code=b.Promotion
    WHERE pr.StartDate IS NOT NULL AND pr.EndDate IS NOT NULL
)
SELECT a.SKU,a.Code PromoA,b.Code PromoB,a.StartDate,a.EndDate,b.StartDate,b.EndDate
FROM P a JOIN P b
  ON a.SKU=b.SKU AND CONVERT(nvarchar(100),a.Code)<CONVERT(nvarchar(100),b.Code)
 AND a.StartDate<=b.EndDate AND b.StartDate<=a.EndDate
ORDER BY a.SKU,a.StartDate;

/* 10. Giá Amount/Qty và marker giảm giá. */
SELECT TOP 300 d.Product,d.Qty,d.Amount,
       CAST(d.Amount*1.0/NULLIF(d.Qty,0) AS decimal(18,2)) UnitPriceFromAmount,
       d.AvgPrice,d.DiscountAmount,d.Discount,d.DiscountCouponInv,d.DiscountGroupProduct,d.VAT,d.Tax
FROM dbo.tbl_SALPoSDetails d
WHERE d.Qty>0
ORDER BY d.Code DESC;

/* 11. Schema nơi bán/kho để chốt StoreCode. */
SELECT COLUMN_NAME,DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('tbl_OPSImExMaster','tbl_SALPoSMaster','tbl_INInventoryMaster')
ORDER BY TABLE_NAME,ORDINAL_POSITION;

/* 12. Tìm bảng/cột phục vụ Chặng 14–19 về sau. */
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME LIKE '%Suppl%' OR TABLE_NAME LIKE '%NCC%'
   OR TABLE_NAME LIKE '%Purchase%' OR TABLE_NAME LIKE '%Order%'
   OR TABLE_NAME LIKE '%Budget%' OR TABLE_NAME LIKE '%Warehouse%'
ORDER BY TABLE_NAME;
