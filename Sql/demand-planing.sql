USE [POS];
SET NOCOUNT ON;

/* ================================================================
   LẤY DỮ LIỆU THẬT CHO demand-planing-simulation
   Đã cập nhật: Nối danh sách đầu vào với cột Barcode của tbl_LSProduct.
   ================================================================ */

DECLARE @ManualRunDate date = NULL; 
DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @ShowDiagnostics bit = 0; 

DECLARE @ExcludePromotionCodes nvarchar(max) = N'';

DECLARE @ProductCount int;
DECLARE @StoreDataEndDate date;
DECLARE @SelectedSalesEndDate date;
DECLARE @SelectedMovementEndDate date;
DECLARE @DataEndDate date;
DECLARE @RunDate date;
DECLARE @HistoryStart date;
DECLARE @HistoryEnd date;
DECLARE @TotalHistoryDays int;
DECLARE @FullCycleCount int;
DECLARE @FullCycleDays int;
DECLARE @StartDate date;
DECLARE @EndDate date;

IF @HistoryYears < 1 OR @CycleLength < 1
BEGIN
    RAISERROR(N'@HistoryYears hoac @CycleLength khong hop le.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#Products') IS NOT NULL DROP TABLE #Products;
CREATE TABLE #Products
(
    Product nvarchar(100) NOT NULL PRIMARY KEY
);

-- ================================================================
-- LOGIC DYNAMIC: Dò tìm qua Barcode và trả về Code hệ thống
-- ================================================================
WITH DanhSachCanTim AS (
    SELECT MaSanPham
    FROM (VALUES 
        ('4932313033092'),
        ('4965078102116'),
        ('4987645005453'),
        ('4987645005989'),
        ('4901001194186'),
        ('4903024904957'),
        ('4955209080352'),
        ('4955209080338'),
        ('4955209080345'),
        ('4573475402137'),
        ('4534374394596'),
        ('4971710573664'),
        ('4901065606939'),
        ('4973221032487'),
        ('4905489647905'),
        ('8997240600041'),
        ('4582517330024'),
        ('8936013251042'),
        ('4976416007932'),
        ('4902102019187'),
        ('4902871053900'),
        ('4908609116909'),
        ('8936013251097'),
        ('4550516493583'),
        ('4905687446263'),
        ('4968583245477'),
        ('4526112647644'),
        ('4582695026467'),
        ('4982790187924'),
        ('4535792442340'),
        ('4978929915261'),
        ('4941336729073'),
        ('4901548603844'),
        ('4905596183068'),
        ('4976790247870'),
        ('4901616010413'),
        ('4982790412309'),
        ('4901111910973'),
        ('4970285280038'),
        ('4546490702476'),
        ('4562370392322'),
        ('4560127703445')
    ) AS BangTam(MaSanPham)
)
INSERT INTO #Products (Product)
SELECT DISTINCT LTRIM(RTRIM(CONVERT(nvarchar(100), p.Code)))
FROM dbo.tbl_LSProduct p
INNER JOIN DanhSachCanTim d 
    -- ĐIỂM KẾT NỐI ĐÃ ĐƯỢC CẬP NHẬT THÀNH CỘT BARCODE
    ON LTRIM(RTRIM(CONVERT(nvarchar(100), p.Barcode))) = d.MaSanPham;
-- ================================================================

SELECT @ProductCount = COUNT(*) FROM #Products;

IF OBJECT_ID('tempdb..#ExcludedPromotions') IS NOT NULL DROP TABLE #ExcludedPromotions;
CREATE TABLE #ExcludedPromotions (Code nvarchar(100) NOT NULL PRIMARY KEY);

IF LTRIM(RTRIM(@ExcludePromotionCodes)) <> N''
BEGIN
    DECLARE @ExcludePromotionCodesXml xml = CAST(
        N'<x><i>' +
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(
                        REPLACE(LTRIM(RTRIM(@ExcludePromotionCodes)), CHAR(13), N','),
                        CHAR(10), N','
                    ),
                    CHAR(9), N','
                ),
                N';', N','
            ),
            N',', N'</i><i>'
        ) +
        N'</i></x>' AS xml
    );
    INSERT INTO #ExcludedPromotions (Code)
    SELECT DISTINCT LTRIM(RTRIM(ExNode.Item.value('.', 'nvarchar(100)')))
    FROM @ExcludePromotionCodesXml.nodes('/x/i') AS ExNode(Item)
    WHERE LTRIM(RTRIM(ExNode.Item.value('.', 'nvarchar(100)'))) <> N'';
END;

IF @ProductCount < 1
BEGIN
    RAISERROR(N'Chua co ma san pham trong @ProductCodes hoac khong tim thay ma san pham tuong ung.', 16, 1);
    RETURN;
END;

SELECT @StoreDataEndDate = MAX(CONVERT(date, m.TransactionDate))
FROM dbo.tbl_SALPoSMaster m
WHERE m.TransactionDate IS NOT NULL;

SELECT @SelectedSalesEndDate = MAX(CONVERT(date, m.TransactionDate))
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.TransactionDate IS NOT NULL;

SELECT @SelectedMovementEndDate = MAX(CONVERT(date, m.EffDate))
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m
  ON m.Code = d.DocumentNo
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.EffDate IS NOT NULL;

SET @DataEndDate = @StoreDataEndDate;
IF @DataEndDate IS NULL OR (@SelectedSalesEndDate IS NOT NULL AND @SelectedSalesEndDate > @DataEndDate)
    SET @DataEndDate = @SelectedSalesEndDate;
IF @DataEndDate IS NULL OR (@SelectedMovementEndDate IS NOT NULL AND @SelectedMovementEndDate > @DataEndDate)
    SET @DataEndDate = @SelectedMovementEndDate;

IF @ManualRunDate IS NULL AND @DataEndDate IS NULL
BEGIN
    RAISERROR(N'Khong tim thay ngay du lieu trong POS.', 16, 1);
    RETURN;
END;

SET @RunDate = COALESCE(@ManualRunDate, DATEADD(day, 1, @DataEndDate));

SET @HistoryStart = CONVERT(date, CONVERT(char(4), YEAR(@RunDate) - @HistoryYears) + '0101', 112);
SET @HistoryEnd = DATEADD(day, -1, @RunDate);
SET @TotalHistoryDays = DATEDIFF(day, @HistoryStart, @HistoryEnd) + 1;
SET @FullCycleCount = @TotalHistoryDays / @CycleLength;

IF @FullCycleCount < 1
BEGIN
    RAISERROR(N'Khung lich Chang 1 khong du 1 chu ky day du.', 16, 1);
    RETURN;
END;

SET @FullCycleDays = @FullCycleCount * @CycleLength;
SET @StartDate = DATEADD(day, 1 - @FullCycleDays, @HistoryEnd);
SET @EndDate = @HistoryEnd;

IF OBJECT_ID('tempdb..#PosDaily') IS NOT NULL DROP TABLE #PosDaily;
IF OBJECT_ID('tempdb..#ProductPrice') IS NOT NULL DROP TABLE #ProductPrice;
IF OBJECT_ID('tempdb..#ProductName') IS NOT NULL DROP TABLE #ProductName;
IF OBJECT_ID('tempdb..#ActualPromoDaily') IS NOT NULL DROP TABLE #ActualPromoDaily;
IF OBJECT_ID('tempdb..#ImExDaily') IS NOT NULL DROP TABLE #ImExDaily;
IF OBJECT_ID('tempdb..#MovementDaily') IS NOT NULL DROP TABLE #MovementDaily;
IF OBJECT_ID('tempdb..#ReceiptDaily') IS NOT NULL DROP TABLE #ReceiptDaily;
IF OBJECT_ID('tempdb..#PromoDailyNamed') IS NOT NULL DROP TABLE #PromoDailyNamed;

/* 1. Bán lẻ theo ngày thực tế. */
SELECT
    p.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    SUM(CASE WHEN d.RePosDetails IS NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS GrossSalesQty,
    SUM(CASE WHEN d.RePosDetails IS NOT NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS ReturnQty
INTO #PosDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate < DATEADD(day, 1, @EndDate)
GROUP BY p.Product, CONVERT(date, m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_PosDaily
    ON #PosDaily(Product, [Date]);

/* 2. Đơn giá chuẩn. */
SELECT
    p.Product,
    AVG(d.Amount * 1.0 / NULLIF(d.Qty, 0)) AS Price
INTO #ProductPrice
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE d.RePosDetails IS NULL
  AND COALESCE(d.Discount, 0) = 0
  AND (d.DiscountCouponInv IS NULL OR LTRIM(RTRIM(CONVERT(nvarchar(100), d.DiscountCouponInv))) IN (N'', N'0'))
  AND (d.DiscountGroupProduct IS NULL OR LTRIM(RTRIM(CONVERT(nvarchar(100), d.DiscountGroupProduct))) IN (N'', N'0'))
  AND d.Qty > 0
  AND m.TransactionDate IS NOT NULL
  AND m.TransactionDate < @RunDate
GROUP BY p.Product;

CREATE UNIQUE CLUSTERED INDEX IX_ProductPrice
    ON #ProductPrice(Product);

/* 3. Tên sản phẩm. */
DECLARE @NameColumn sysname;
DECLARE @NameSql nvarchar(max);

SELECT TOP 1 @NameColumn = COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo'
  AND TABLE_NAME = 'tbl_LSProduct'
  AND COLUMN_NAME IN (
      'ProductName', 'Name', 'ProductNameVN', 'FullName', 'ShortName', 'Description', 'Title',
      'ProductNameVi', 'ProductFullName', 'NameVN', 'TenSanPham', 'TenSP', 'TenHang'
  )
ORDER BY CASE COLUMN_NAME WHEN 'ProductName' THEN 1 WHEN 'Name' THEN 2 ELSE 99 END;

IF @NameColumn IS NULL
BEGIN
    SELECT TOP 1 @NameColumn = COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'tbl_LSProduct'
      AND (COLUMN_NAME LIKE '%Name%' OR COLUMN_NAME LIKE '%Ten%')
      AND DATA_TYPE IN ('nvarchar', 'varchar', 'nchar', 'char', 'ntext', 'text')
    ORDER BY LEN(COLUMN_NAME), COLUMN_NAME;
END;

CREATE TABLE #ProductName
(
    Product nvarchar(100) NOT NULL PRIMARY KEY,
    ProductName nvarchar(500) NULL
);

IF @NameColumn IS NOT NULL
BEGIN
    SET @NameSql = N'
        INSERT INTO #ProductName (Product, ProductName)
        SELECT p.Product, MAX(CONVERT(nvarchar(500), lp.' + QUOTENAME(@NameColumn) + N'))
        FROM #Products p
        JOIN dbo.tbl_LSProduct lp
          ON LTRIM(RTRIM(CONVERT(nvarchar(100), lp.Code))) = p.Product
        GROUP BY p.Product;';
    EXEC sp_executesql @NameSql;
END
ELSE
BEGIN
    INSERT INTO #ProductName (Product, ProductName)
    SELECT Product, NULL FROM #Products;
END;

/* 4. Marker CTKM trên dòng bán POS thực tế. */
SELECT
    p.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    MAX(COALESCE(
        CASE WHEN d.DiscountCouponInv IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountCouponInv))) NOT IN (N'', N'0') THEN CONVERT(nvarchar(200), d.DiscountCouponInv) ELSE NULL END,
        CASE WHEN d.DiscountGroupProduct IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountGroupProduct))) NOT IN (N'', N'0') THEN CONVERT(nvarchar(200), d.DiscountGroupProduct) ELSE NULL END,
        CASE WHEN COALESCE(d.Discount, 0) <> 0 THEN CONVERT(nvarchar(200), d.Discount) ELSE NULL END
    )) AS ActualPromoMarker
INTO #ActualPromoDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code = d.PoSMaster
JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.TransactionDate IS NOT NULL AND m.TransactionDate >= @StartDate AND m.TransactionDate < DATEADD(day, 1, @EndDate)
  AND (COALESCE(d.Discount, 0) <> 0 OR (d.DiscountCouponInv IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountCouponInv))) NOT IN (N'', N'0')) OR (d.DiscountGroupProduct IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountGroupProduct))) NOT IN (N'', N'0')))
GROUP BY p.Product, CONVERT(date, m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_ActualPromoDaily ON #ActualPromoDaily(Product, [Date]);

/* 5. Nhập/xuất kho thực tế. */
SELECT
    p.Product,
    CONVERT(date, m.EffDate) AS [Date],
    SUM(
        CASE
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50') AND CONVERT(nvarchar(20), m.DocumentStatus) = N'3' THEN COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50') AND CONVERT(nvarchar(20), m.DocumentStatus) = N'2' THEN COALESCE(d.Quantity, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'10', N'20', N'30', N'40', N'52') AND CONVERT(nvarchar(20), m.DocumentStatus) = N'6' THEN -COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'20', N'30', N'40', N'52') AND CONVERT(nvarchar(20), m.DocumentStatus) = N'5' THEN -COALESCE(d.QtyReceived, 0)
            ELSE 0
        END
    ) AS ImExNetQty
INTO #ImExDaily
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m ON m.Code = d.DocumentNo
JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.EffDate IS NOT NULL AND m.EffDate < DATEADD(day, 1, @EndDate)
GROUP BY p.Product, CONVERT(date, m.EffDate);

CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily ON #ImExDaily(Product, [Date]);

/* 6. Phát sinh tồn ròng tổng hợp. */
SELECT x.Product, x.[Date], SUM(x.NetQty) AS NetQty
INTO #MovementDaily
FROM (
    SELECT Product, [Date], ImExNetQty AS NetQty FROM #ImExDaily
    UNION ALL
    SELECT Product, [Date], ReturnQty - GrossSalesQty AS NetQty FROM #PosDaily
) x
WHERE x.[Date] IS NOT NULL
GROUP BY x.Product, x.[Date];

CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily ON #MovementDaily(Product, [Date]);

/* 7. Giờ nhập đầu tiên trong ngày. */
;WITH Type1Receipts AS
(
    SELECT
        p.Product, CONVERT(date, m.EffDate) AS [Date],
        CASE
            WHEN m.ReceiptDate IS NOT NULL AND CONVERT(date, m.ReceiptDate) = CONVERT(date, m.EffDate) AND CONVERT(char(8), m.ReceiptDate, 108) <> '00:00:00' THEN CONVERT(datetime, m.ReceiptDate)
            WHEN m.CreateTime IS NOT NULL AND CONVERT(date, m.CreateTime) = CONVERT(date, m.EffDate) AND CONVERT(char(8), m.CreateTime, 108) <> '00:00:00' THEN CONVERT(datetime, m.CreateTime)
            ELSE NULL
        END AS ReceiptDateTime
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code = d.DocumentNo
    JOIN #Products p ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
    WHERE CONVERT(nvarchar(20), m.DocumentType) = N'1' AND m.EffDate IS NOT NULL AND m.EffDate >= @StartDate AND m.EffDate < DATEADD(day, 1, @EndDate)
      AND ((CONVERT(nvarchar(20), m.DocumentStatus) = N'3' AND COALESCE(d.QtyReceived, 0) > 0) OR (CONVERT(nvarchar(20), m.DocumentStatus) = N'2' AND COALESCE(d.Quantity, 0) > 0))
)
SELECT Product, [Date], MIN(ReceiptDateTime) AS FirstReceiptDateTime
INTO #ReceiptDaily
FROM Type1Receipts
WHERE ReceiptDateTime IS NOT NULL
GROUP BY Product, [Date];

CREATE UNIQUE CLUSTERED INDEX IX_ReceiptDaily ON #ReceiptDaily(Product, [Date]);

/* 8. CTKM theo bảng promotion/bundle (chỉ lấy cho ngày có bán POS thực tế). */
CREATE TABLE #PromoDailyNamed
(
    Product nvarchar(100) NOT NULL,
    [Date] date NOT NULL,
    PromoCode nvarchar(max) NULL,
    PromoDisplayName nvarchar(max) NULL
);

;WITH PromoMatches AS
(
    SELECT DISTINCT
        pos.Product, pos.[Date],
        CONVERT(nvarchar(200), pr.Code) AS PromoCode,
        COALESCE(NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500), pr.Promotion))), N''), NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(200), pr.PromotionNo))), N''), CONVERT(nvarchar(200), pr.Code)) AS PromoDisplayName
    FROM #PosDaily pos
    JOIN dbo.tbl_POLBundle b ON LTRIM(RTRIM(CONVERT(nvarchar(100), b.Product))) = pos.Product OR LTRIM(RTRIM(CONVERT(nvarchar(100), b.RefProduct))) = pos.Product
    JOIN dbo.tbl_POLPromotion pr ON pr.Code = b.Promotion
    WHERE pr.StartDate IS NOT NULL AND pr.EndDate IS NOT NULL
      AND pos.[Date] BETWEEN CONVERT(date, pr.StartDate) AND CONVERT(date, pr.EndDate)
      AND (pr.IsPOS IS NULL OR CONVERT(nvarchar(20), pr.IsPOS) IN (N'1', N'True', N'true'))
      AND NOT EXISTS (SELECT 1 FROM #ExcludedPromotions ex WHERE ex.Code = CONVERT(nvarchar(100), pr.Code))
)
INSERT INTO #PromoDailyNamed (Product, [Date], PromoCode, PromoDisplayName)
SELECT
    base.Product, base.[Date],
    STUFF((SELECT N'|' + pm2.PromoCode FROM PromoMatches pm2 WHERE pm2.Product = base.Product AND pm2.[Date] = base.[Date] ORDER BY pm2.PromoCode FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') AS PromoCode,
    STUFF((SELECT N'|' + pm2.PromoDisplayName FROM PromoMatches pm2 WHERE pm2.Product = base.Product AND pm2.[Date] = base.[Date] ORDER BY pm2.PromoDisplayName FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, N'') AS PromoDisplayName
FROM (SELECT DISTINCT Product, [Date] FROM PromoMatches) base;

CREATE UNIQUE CLUSTERED INDEX IX_PromoDailyNamed ON #PromoDailyNamed(Product, [Date]);

/* 9. Kết quả xuất cuối cùng — chỉ ngày có dòng nguồn thật. */
;WITH RunningStock AS
(
    SELECT
        mv.Product,
        mv.[Date],
        SUM(mv.NetQty) OVER (
            PARTITION BY mv.Product ORDER BY mv.[Date]
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS CloseStockCalc,
        SUM(mv.NetQty) OVER (
            PARTITION BY mv.Product ORDER BY mv.[Date]
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS OpenStockCalc
    FROM #MovementDaily mv
    WHERE mv.[Date] <= @EndDate
)
SELECT
    rs.Product AS SKU,
    CONVERT(char(10), rs.[Date], 23) AS [Date],
    COALESCE(rs.OpenStockCalc, 0) AS OpenStock,
    COALESCE(rs.CloseStockCalc, 0) AS CloseStock,
    COALESCE(pos.GrossSalesQty, 0) AS Sales,
    1 AS HasRecord,
    CASE
        WHEN receipt.FirstReceiptDateTime IS NULL THEN NULL
        ELSE CONVERT(char(5), receipt.FirstReceiptDateTime, 108)
    END AS ReceiptHour,
    COALESCE(promo.PromoCode, actualPromo.ActualPromoMarker) AS PromoCode,
    COALESCE(promo.PromoDisplayName, actualPromo.ActualPromoMarker) AS PromoName,
    price.Price AS Price,
    pname.ProductName AS ProductName
FROM RunningStock rs
LEFT JOIN #PosDaily pos ON pos.Product = rs.Product AND pos.[Date] = rs.[Date]
LEFT JOIN #ActualPromoDaily actualPromo ON actualPromo.Product = rs.Product AND actualPromo.[Date] = rs.[Date]
LEFT JOIN #ReceiptDaily receipt ON receipt.Product = rs.Product AND receipt.[Date] = rs.[Date]
LEFT JOIN #PromoDailyNamed promo ON promo.Product = rs.Product AND promo.[Date] = rs.[Date]
LEFT JOIN #ProductPrice price ON price.Product = rs.Product
LEFT JOIN #ProductName pname ON pname.Product = rs.Product
WHERE rs.[Date] >= @StartDate
  AND rs.[Date] <= @EndDate
ORDER BY rs.Product, rs.[Date];