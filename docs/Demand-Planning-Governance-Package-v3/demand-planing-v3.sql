USE [POS];
SET NOCOUNT ON;

/* ============================================================================
   demand-planing-v3.sql

   MỤC TIÊU
   - Lấy dữ liệu nguồn thật cho Demand Planning.
   - Tính OpenStock/CloseStock từ phát sinh thật vì POS không có bảng tồn ngày thô.
   - KHÔNG tạo lịch ngày liên tục.
   - KHÔNG chia chu kỳ 15 ngày.
   - KHÔNG lấp nền, phân loại CTKM hay dự báo.

   KẾT QUẢ
   1. DailySourceRecord: chỉ ngày có nguồn thật.
   2. PromotionInterval: khoảng CTKM lịch sử của SKU.
   3. ExtractMetadata: phạm vi và giả định của lần trích xuất.
   ============================================================================ */

DECLARE @ManualRunDate date = NULL;
DECLARE @ManualProcessingStartDate date = NULL;
DECLARE @HistoryYears int = 3;
DECLARE @ReferenceDaysBefore int = 24;
DECLARE @StoreCode nvarchar(100) = N'POS_DEFAULT';
DECLARE @ShowDiagnostics bit = 0;

DECLARE @QueryVersion nvarchar(50) = N'demand-planing-v3';
DECLARE @ExtractId uniqueidentifier = NEWID();
DECLARE @DataEndDate date;
DECLARE @RunDate date;
DECLARE @ProcessingStartDate date;
DECLARE @ProcessingEndDate date;
DECLARE @ReferenceReadStartDate date;

IF @HistoryYears < 1 OR @ReferenceDaysBefore < 0
BEGIN
    RAISERROR(N'Tham số lịch sử không hợp lệ.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#Products') IS NOT NULL DROP TABLE #Products;
CREATE TABLE #Products (Product nvarchar(100) NOT NULL PRIMARY KEY);

/* Thay danh sách barcode bên dưới bằng danh sách cần chạy. */
WITH InputBarcode AS
(
    SELECT Barcode
    FROM (VALUES
        (N'4932313033092'),
        (N'4965078102116'),
        (N'4987645005453')
    ) v(Barcode)
)
INSERT INTO #Products(Product)
SELECT DISTINCT LTRIM(RTRIM(CONVERT(nvarchar(100), p.Code)))
FROM dbo.tbl_LSProduct p
JOIN InputBarcode i
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), p.Barcode))) = i.Barcode;

IF NOT EXISTS (SELECT 1 FROM #Products)
BEGIN
    RAISERROR(N'Không tìm thấy SKU từ danh sách barcode.', 16, 1);
    RETURN;
END;

/* Ngày cuối nguồn thật. */
SELECT @DataEndDate = MAX(d)
FROM
(
    SELECT MAX(CONVERT(date, m.TransactionDate)) d
    FROM dbo.tbl_SALPoSDetails x
    JOIN dbo.tbl_SALPoSMaster m ON m.Code = x.PoSMaster
    JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), x.Product))) = p.Product
    UNION ALL
    SELECT MAX(CONVERT(date, m.EffDate))
    FROM dbo.tbl_OPSImExDetails x
    JOIN dbo.tbl_OPSImExMaster m ON m.Code = x.DocumentNo
    JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), x.Product))) = p.Product
) q;

IF @ManualRunDate IS NULL AND @DataEndDate IS NULL
BEGIN
    RAISERROR(N'Không có dữ liệu nguồn.', 16, 1);
    RETURN;
END;

SET @RunDate = COALESCE(@ManualRunDate, DATEADD(day, 1, @DataEndDate));
SET @ProcessingEndDate = DATEADD(day, -1, @RunDate);
SET @ProcessingStartDate = COALESCE(
    @ManualProcessingStartDate,
    CONVERT(date, CONVERT(char(4), YEAR(@RunDate) - @HistoryYears) + '0101', 112)
);
SET @ReferenceReadStartDate = DATEADD(day, -@ReferenceDaysBefore, @ProcessingStartDate);

IF @ProcessingStartDate > @ProcessingEndDate
BEGIN
    RAISERROR(N'Khoảng xử lý không hợp lệ.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#PosDaily') IS NOT NULL DROP TABLE #PosDaily;
IF OBJECT_ID('tempdb..#ImExDaily') IS NOT NULL DROP TABLE #ImExDaily;
IF OBJECT_ID('tempdb..#MovementDaily') IS NOT NULL DROP TABLE #MovementDaily;
IF OBJECT_ID('tempdb..#ReceiptDaily') IS NOT NULL DROP TABLE #ReceiptDaily;
IF OBJECT_ID('tempdb..#ProductPrice') IS NOT NULL DROP TABLE #ProductPrice;
IF OBJECT_ID('tempdb..#ProductName') IS NOT NULL DROP TABLE #ProductName;
IF OBJECT_ID('tempdb..#PromoIntervals') IS NOT NULL DROP TABLE #PromoIntervals;
IF OBJECT_ID('tempdb..#RunningStock') IS NOT NULL DROP TABLE #RunningStock;

/* 1. Bán và trả theo ngày có giao dịch POS. */
SELECT
    p.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    SUM(CASE WHEN d.RePosDetails IS NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS SalesQty,
    SUM(CASE WHEN d.RePosDetails IS NOT NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS ReturnQty,
    COUNT_BIG(*) AS PosLineCount
INTO #PosDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code = d.PoSMaster
JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate < DATEADD(day, 1, @ProcessingEndDate)
GROUP BY p.Product, CONVERT(date, m.TransactionDate);
CREATE UNIQUE CLUSTERED INDEX IX_PosDaily ON #PosDaily(Product, [Date]);

/* 2. Nhập/xuất kho theo ngày. Danh sách type/status phải được đối soát bằng file 03. */
SELECT
    p.Product,
    CONVERT(date, m.EffDate) AS [Date],
    SUM(CASE
        WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1',N'2',N'3',N'4',N'21',N'31',N'41',N'50')
         AND CONVERT(nvarchar(20), m.DocumentStatus) = N'3' THEN COALESCE(d.QtyReceived,0)
        WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1',N'2',N'3',N'4',N'21',N'31',N'41',N'50')
         AND CONVERT(nvarchar(20), m.DocumentStatus) = N'2' THEN COALESCE(d.Quantity,0)
        WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5',N'6',N'7',N'8',N'9',N'10',N'20',N'30',N'40',N'52')
         AND CONVERT(nvarchar(20), m.DocumentStatus) IN (N'5',N'6') THEN -COALESCE(d.QtyReceived,0)
        ELSE 0 END) AS ImExNetQty,
    COUNT_BIG(*) AS ImExLineCount
INTO #ImExDaily
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m ON m.Code = d.DocumentNo
JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.EffDate IS NOT NULL
  AND m.EffDate < DATEADD(day, 1, @ProcessingEndDate)
GROUP BY p.Product, CONVERT(date, m.EffDate);
CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily ON #ImExDaily(Product, [Date]);

/* 3. Phát sinh tồn ròng. POS bán giảm tồn, trả tăng tồn. */
SELECT x.Product, x.[Date], SUM(x.NetQty) NetQty,
       MAX(x.HasSales) HasSalesRecord,
       MAX(x.HasInventory) HasInventoryMovement
INTO #MovementDaily
FROM
(
    SELECT Product, [Date], ImExNetQty NetQty, 0 HasSales, 1 HasInventory FROM #ImExDaily
    UNION ALL
    SELECT Product, [Date], ReturnQty - SalesQty, 1, 1 FROM #PosDaily
) x
GROUP BY x.Product, x.[Date];
CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily ON #MovementDaily(Product, [Date]);

/* 4. Phiếu nhập loại 1 đầu tiên trong ngày. */
;WITH ReceiptSource AS
(
    SELECT
        p.Product,
        CONVERT(date, m.EffDate) [Date],
        CASE
            WHEN m.ReceiptDate IS NOT NULL
             AND CONVERT(date,m.ReceiptDate)=CONVERT(date,m.EffDate)
             AND CONVERT(time,m.ReceiptDate) <> '00:00:00' THEN CONVERT(datetime,m.ReceiptDate)
            WHEN m.CreateTime IS NOT NULL
             AND CONVERT(date,m.CreateTime)=CONVERT(date,m.EffDate)
             AND CONVERT(time,m.CreateTime) <> '00:00:00' THEN CONVERT(datetime,m.CreateTime)
            ELSE NULL
        END ReceiptDateTime
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code = d.DocumentNo
    JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
    WHERE CONVERT(nvarchar(20),m.DocumentType)=N'1'
      AND m.EffDate >= @ReferenceReadStartDate
      AND m.EffDate < DATEADD(day,1,@ProcessingEndDate)
)
SELECT Product,[Date],MIN(ReceiptDateTime) FirstReceiptDateTime
INTO #ReceiptDaily
FROM ReceiptSource
WHERE ReceiptDateTime IS NOT NULL
GROUP BY Product,[Date];
CREATE UNIQUE CLUSTERED INDEX IX_ReceiptDaily ON #ReceiptDaily(Product,[Date]);

/* 5. Đơn giá chuẩn, không dùng dòng có marker giảm giá. */
SELECT p.Product, AVG(d.Amount * 1.0 / NULLIF(d.Qty,0)) Price
INTO #ProductPrice
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))=p.Product
WHERE d.RePosDetails IS NULL
  AND d.Qty > 0 AND d.Amount > 0
  AND COALESCE(d.Discount,0)=0
  AND (d.DiscountCouponInv IS NULL OR LTRIM(RTRIM(CONVERT(nvarchar(100),d.DiscountCouponInv))) IN (N'',N'0'))
  AND (d.DiscountGroupProduct IS NULL OR LTRIM(RTRIM(CONVERT(nvarchar(100),d.DiscountGroupProduct))) IN (N'',N'0'))
  AND m.TransactionDate < @RunDate
GROUP BY p.Product;
CREATE UNIQUE CLUSTERED INDEX IX_ProductPrice ON #ProductPrice(Product);

/* 6. Tên sản phẩm: đổi @NameColumn nếu schema thật dùng tên khác. */
DECLARE @NameColumn sysname = NULL;
DECLARE @NameSql nvarchar(max);
SELECT TOP 1 @NameColumn=COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='tbl_LSProduct'
  AND COLUMN_NAME IN ('ProductName','Name','ProductNameVN','FullName','ShortName','Description','Title','ProductNameVi','ProductFullName','NameVN','TenSanPham','TenSP','TenHang')
ORDER BY CASE COLUMN_NAME WHEN 'ProductName' THEN 1 WHEN 'Name' THEN 2 ELSE 99 END;

CREATE TABLE #ProductName(Product nvarchar(100) NOT NULL PRIMARY KEY, ProductName nvarchar(500) NULL);
IF @NameColumn IS NOT NULL
BEGIN
    SET @NameSql=N'INSERT INTO #ProductName(Product,ProductName)
        SELECT p.Product,MAX(CONVERT(nvarchar(500),lp.'+QUOTENAME(@NameColumn)+N'))
        FROM #Products p JOIN dbo.tbl_LSProduct lp
          ON LTRIM(RTRIM(CONVERT(nvarchar(100),lp.Code)))=p.Product
        GROUP BY p.Product;';
    EXEC sp_executesql @NameSql;
END
ELSE INSERT INTO #ProductName SELECT Product,NULL FROM #Products;

/* 7. Khoảng CTKM lịch sử. Không tự loại mã “thường trực” ở SQL. */
SELECT DISTINCT
    p.Product,
    CONVERT(nvarchar(200),pr.Code) PromoCode,
    COALESCE(NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500),pr.Promotion))),N''),CONVERT(nvarchar(200),pr.Code)) PromoName,
    CONVERT(date,pr.StartDate) StartDate,
    CONVERT(date,pr.EndDate) EndDate,
    CONVERT(nvarchar(100),pr.PromotionType) PromoTypeSource,
    pr.IsPOS,
    CASE WHEN LTRIM(RTRIM(CONVERT(nvarchar(100),b.Product)))=p.Product THEN N'DIRECT_PRODUCT' ELSE N'REF_PRODUCT' END SourceRole
INTO #PromoIntervals
FROM #Products p
JOIN dbo.tbl_POLBundle b
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),b.Product)))=p.Product
  OR LTRIM(RTRIM(CONVERT(nvarchar(100),b.RefProduct)))=p.Product
JOIN dbo.tbl_POLPromotion pr ON pr.Code=b.Promotion
WHERE pr.StartDate IS NOT NULL AND pr.EndDate IS NOT NULL
  AND CONVERT(date,pr.EndDate) >= @ReferenceReadStartDate
  AND CONVERT(date,pr.StartDate) <= @ProcessingEndDate;

/* RESULT SET 1 — DailySourceRecord. Chỉ ngày có nguồn thật. */
SELECT
    mv.Product,mv.[Date],mv.NetQty,mv.HasSalesRecord,mv.HasInventoryMovement,
    SUM(mv.NetQty) OVER(
        PARTITION BY mv.Product ORDER BY mv.[Date]
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) CloseStockCalc,
    SUM(mv.NetQty) OVER(
        PARTITION BY mv.Product ORDER BY mv.[Date]
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) OpenStockCalc
INTO #RunningStock
FROM #MovementDaily mv
WHERE mv.[Date] <= @ProcessingEndDate;
CREATE UNIQUE CLUSTERED INDEX IX_RunningStock ON #RunningStock(Product,[Date]);

SELECT
    CONVERT(nvarchar(36),@ExtractId) ExtractId,
    @StoreCode StoreCode,
    rs.Product SKU,
    CONVERT(char(10),rs.[Date],23) [Date],
    pos.SalesQty Sales,
    CONVERT(bit,CASE WHEN pos.Product IS NULL THEN 0 ELSE 1 END) HasSalesRecord,
    pos.ReturnQty,
    rs.NetQty InventoryNetMovement,
    CONVERT(bit,rs.HasInventoryMovement) HasInventoryMovement,
    COALESCE(rs.OpenStockCalc,0) OpenStock,
    COALESCE(rs.CloseStockCalc,0) CloseStock,
    CASE
        WHEN COALESCE(rs.OpenStockCalc,0)<0 OR COALESCE(rs.CloseStockCalc,0)<0 THEN N'NEGATIVE_REVIEW'
        ELSE N'CALCULATED' END StockCalculationStatus,
    CASE WHEN r.FirstReceiptDateTime IS NULL THEN NULL ELSE CONVERT(char(5),r.FirstReceiptDateTime,108) END ReceiptHour,
    CONVERT(bit,CASE WHEN r.Product IS NULL THEN 0 ELSE 1 END) HasReceiptRecord,
    pp.Price,
    pn.ProductName,
    CONVERT(bit,1) HasRecord,
    CONVERT(bit,CASE WHEN rs.[Date] < @ProcessingStartDate THEN 1 ELSE 0 END) IsReferenceOnly
FROM #RunningStock rs
LEFT JOIN #PosDaily pos ON pos.Product=rs.Product AND pos.[Date]=rs.[Date]
LEFT JOIN #ReceiptDaily r ON r.Product=rs.Product AND r.[Date]=rs.[Date]
LEFT JOIN #ProductPrice pp ON pp.Product=rs.Product
LEFT JOIN #ProductName pn ON pn.Product=rs.Product
WHERE rs.[Date] >= @ReferenceReadStartDate
  AND rs.[Date] <= @ProcessingEndDate
ORDER BY rs.Product,rs.[Date];

/* RESULT SET 2 — PromotionInterval. */
SELECT
    CONVERT(nvarchar(36),@ExtractId) ExtractId,
    @StoreCode StoreCode,
    Product SKU,PromoCode,PromoName,
    CONVERT(char(10),StartDate,23) StartDate,
    CONVERT(char(10),EndDate,23) EndDate,
    PromoTypeSource,IsPOS,SourceRole
FROM #PromoIntervals
ORDER BY Product,StartDate,PromoCode;

/* RESULT SET 3 — ExtractMetadata. */
SELECT
    CONVERT(nvarchar(36),@ExtractId) ExtractId,
    @QueryVersion QueryVersion,
    N'HISTORICAL_VALIDATION' RunMode,
    CONVERT(char(10),@RunDate,23) RunDate,
    CONVERT(char(10),@ProcessingStartDate,23) ProcessingStartDate,
    CONVERT(char(10),@ProcessingEndDate,23) ProcessingEndDate,
    CONVERT(char(10),@ReferenceReadStartDate,23) ReferenceReadStartDate,
    @StoreCode StoreCode,
    (SELECT COUNT(*) FROM #Products) SelectedSkuCount,
    N'SELECTED_SKU_SIMULATION' PortfolioMode,
    N'ZERO_BEFORE_FIRST_RECORDED_MOVEMENT_OR_FULL_HISTORY_ASSUMPTION' StockAnchorAssumption,
    GETDATE() GeneratedAt;

IF @ShowDiagnostics=1
BEGIN
    SELECT Product,MIN([Date]) MinDate,MAX([Date]) MaxDate,COUNT(*) SourceDays,
           SUM(CASE WHEN HasSalesRecord=1 THEN 1 ELSE 0 END) SalesDays,
           SUM(CASE WHEN CloseStockCalc<0 OR OpenStockCalc<0 THEN 1 ELSE 0 END) NegativeStockDays
    FROM #RunningStock
    GROUP BY Product
    ORDER BY Product;
END;
