USE [POS];
SET NOCOUNT ON;

/* ================================================================
   LẤY DỮ LIỆU THẬT CHO demand-planing-simulation

   Kết quả cuối chỉ có 10 cột, đúng thứ tự app đang đọc:
   SKU, Date, OpenStock, CloseStock, Sales, ReceiptHour,
   PromoCode, PromoName, Price, ProductName.

   Cách dùng:
   - Dán mã sản phẩm vào @ProductCodes, cách nhau bằng dấu phẩy,
     xuống dòng, tab hoặc dấu chấm phẩy.
   - Để @ManualRunDate = NULL nếu muốn lấy tối đa dữ liệu POS hiện có.
   - Gán @ManualRunDate = 'yyyy-mm-dd' nếu muốn chạy đúng một ngày mô phỏng
     cố định giống policy.runDate trong app.
   - Bật @ShowDiagnostics = 1 rồi xem bảng "9b. Độ phủ từng mã CTKM" trước khi
     tin PromoCode/PromoName: mã nào phủ gần 100% lịch sử của SKU nhiều khả
     năng là mức giá cố định theo hạng khách hàng (không phải CTKM tăng bán
     theo thời vụ) — dán mã đó vào @ExcludePromotionCodes sau khi xác nhận
     bằng PromoName, cùng cú pháp danh sách như @ProductCodes.

   Tương thích SQL Server cũ:
   - Chỉ dùng cú pháp phổ biến: RAISERROR, OBJECT_ID, FOR XML PATH,
     CONVERT, DATEADD, DATEDIFF.
   ================================================================ */

DECLARE @ManualRunDate date = NULL; -- ví dụ: '2026-06-01'
DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @ShowDiagnostics bit = 0; -- đổi thành 1 khi cần xem bảng kiểm tra

-- Mã CTKM cần loại khỏi PromoCode/PromoName sau khi đối chiếu bảng chẩn đoán
-- "9b. Độ phủ từng mã CTKM" (bật @ShowDiagnostics = 1 để xem). Một mã có
-- DayShare gần 100% suốt nhiều năm nhiều khả năng là mức giá cố định theo hạng
-- thành viên (ví dụ "GIẢM 5% BEST PRICE - DÀNH RIÊNG KHTT"), không phải một đợt
-- CTKM tăng bán theo thời vụ — KHÔNG tự loại mã nào cho tới khi xem bảng chẩn
-- đoán và xác nhận bằng mắt, đúng nguyên tắc không tự đoán của dự án.
DECLARE @ExcludePromotionCodes nvarchar(max) = N'';

DECLARE @ProductCodes nvarchar(max) = N'
30259, 32986, 35725, 37237, 39201, 39321, 39900, 40080,
40733, 40880, 41145, 41216, 41749, 42008, 42404, 42447,
42827, 42871, 42945, 42989, 43025, 43193, 43462, 43667,
43744, 43918, 43980, 44017, 44154, 44358, 44637, 44661,
45335, 45664, 45801, 46033, 46127, 46558, 46681, 46685,
46785, 46867, 46881, 47284, 47613, 47659, 47679, 47700,
47784, 47789, 47905, 48425, 51129, 52166, 52506, 52599,
52600, 52646, 52718, 54216, 54537, 54614, 55061, 55262,
55569, 55985, 56351, 56793, 56806, 56891, 56918, 56967,
57034, 57069, 57157, 57158, 57167, 57437, 57662, 57731
';

DECLARE @ProductCodesXml xml;
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

SET @ProductCodesXml = CAST(
    N'<x><i>' +
    REPLACE(
        REPLACE(
            REPLACE(
                REPLACE(
                    REPLACE(LTRIM(RTRIM(@ProductCodes)), CHAR(13), N','),
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

INSERT INTO #Products (Product)
SELECT DISTINCT LTRIM(RTRIM(ProductNode.Item.value('.', 'nvarchar(100)'))) AS Product
FROM @ProductCodesXml.nodes('/x/i') AS ProductNode(Item)
WHERE LTRIM(RTRIM(ProductNode.Item.value('.', 'nvarchar(100)'))) <> N'';

SELECT @ProductCount = COUNT(*) FROM #Products;

/* Mã CTKM bị loại thủ công sau khi xem bảng chẩn đoán độ phủ (mục 9b). */
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
    RAISERROR(N'Chua co ma san pham trong @ProductCodes.', 16, 1);
    RETURN;
END;

/* Ngày dữ liệu cuối: ưu tiên lịch POS của cả cửa hàng để giữ các ngày bán = 0. */
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
    RAISERROR(N'Khong tim thay ngay du lieu trong POS cho cac ma san pham da nhap.', 16, 1);
    RETURN;
END;

SET @RunDate = COALESCE(@ManualRunDate, DATEADD(day, 1, @DataEndDate));

/* Chặng 1: từ 01/01 của năm lùi @HistoryYears đến trước @RunDate,
   sau đó bỏ phần ngày dư ở đầu để còn đủ chu kỳ 15 ngày. */
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

IF @ShowDiagnostics = 1
BEGIN
    SELECT
        @RunDate AS RunDate,
        @HistoryStart AS RawHistoryStart,
        @StartDate AS StartDate,
        @EndDate AS EndDate,
        @TotalHistoryDays AS RawHistoryDays,
        @FullCycleCount AS FullCycleCount,
        @TotalHistoryDays - @FullCycleDays AS DroppedLeadingDays,
        @CycleLength AS CycleLengthDays,
        @ProductCount AS ProductCount,
        @DataEndDate AS DataEndDate;

    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'tbl_LSProduct'
    ORDER BY ORDINAL_POSITION;
END;

IF OBJECT_ID('tempdb..#Dates') IS NOT NULL DROP TABLE #Dates;
IF OBJECT_ID('tempdb..#ProductDates') IS NOT NULL DROP TABLE #ProductDates;
IF OBJECT_ID('tempdb..#PosDaily') IS NOT NULL DROP TABLE #PosDaily;
IF OBJECT_ID('tempdb..#ProductPrice') IS NOT NULL DROP TABLE #ProductPrice;
IF OBJECT_ID('tempdb..#ProductName') IS NOT NULL DROP TABLE #ProductName;
IF OBJECT_ID('tempdb..#ActualPromoDaily') IS NOT NULL DROP TABLE #ActualPromoDaily;
IF OBJECT_ID('tempdb..#ImExDaily') IS NOT NULL DROP TABLE #ImExDaily;
IF OBJECT_ID('tempdb..#MovementDaily') IS NOT NULL DROP TABLE #MovementDaily;
IF OBJECT_ID('tempdb..#ReceiptDaily') IS NOT NULL DROP TABLE #ReceiptDaily;
IF OBJECT_ID('tempdb..#PromoDailyNamed') IS NOT NULL DROP TABLE #PromoDailyNamed;

/* 1. Lịch ngày đầy đủ: SKU không bán vẫn có dòng sales = 0. */
;WITH Dates AS
(
    SELECT @StartDate AS [Date]
    UNION ALL
    SELECT DATEADD(day, 1, [Date])
    FROM Dates
    WHERE [Date] < @EndDate
)
SELECT [Date]
INTO #Dates
FROM Dates
OPTION (MAXRECURSION 0);

SELECT p.Product, d.[Date]
INTO #ProductDates
FROM #Products p
CROSS JOIN #Dates d;

CREATE UNIQUE CLUSTERED INDEX IX_ProductDates
    ON #ProductDates(Product, [Date]);

/* 2. Bán lẻ theo ngày. Không lọc TransactionType vì POS thật không khớp luật 3PPOS. */
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

IF NOT EXISTS
(
    SELECT 1
    FROM #PosDaily
    WHERE GrossSalesQty <> 0
      AND [Date] BETWEEN @StartDate AND @EndDate
)
BEGIN
    IF @ShowDiagnostics = 1
    BEGIN
        SELECT
            p.Product AS InputProduct,
            COALESCE(SUM(pos.GrossSalesQty), 0) AS MatchedGrossSalesQty,
            COALESCE(SUM(pos.ReturnQty), 0) AS MatchedReturnQty,
            COUNT(pos.Product) AS MatchedSaleDays
        FROM #Products p
        LEFT JOIN #PosDaily pos
          ON pos.Product = p.Product
         AND pos.[Date] BETWEEN @StartDate AND @EndDate
        GROUP BY p.Product
        ORDER BY p.Product;
    END;

    RAISERROR(N'Khong tim thay sales trong khung lich Chang 1. Kiem tra ma san pham hoac @ManualRunDate.', 16, 1);
    RETURN;
END;

/* 3. Đơn giá chuẩn: lấy trung bình Amount/Qty trên dòng bán sạch trước ngày chạy. */
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

/* 4. Tên sản phẩm: tự dò cột tên thường gặp trong tbl_LSProduct. */
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
ORDER BY
    CASE COLUMN_NAME
        WHEN 'ProductName' THEN 1
        WHEN 'Name' THEN 2
        WHEN 'ProductNameVN' THEN 3
        WHEN 'ProductNameVi' THEN 4
        WHEN 'FullName' THEN 5
        WHEN 'ProductFullName' THEN 6
        WHEN 'ShortName' THEN 7
        WHEN 'NameVN' THEN 8
        WHEN 'TenSanPham' THEN 9
        WHEN 'TenSP' THEN 10
        WHEN 'TenHang' THEN 11
        WHEN 'Description' THEN 12
        WHEN 'Title' THEN 13
        ELSE 99
    END;

-- Không khớp tên cột thường gặp nào ở trên: thử mọi cột có chữ "Name"/"Ten" trong
-- tên (ưu tiên cột ngắn nhất, thường là cột tên chính chứ không phải mô tả dài).
-- Đây chỉ là suy luận theo TÊN CỘT (an toàn, không đoán ý nghĩa dữ liệu); vẫn cần
-- xem PRINT bên dưới và đối chiếu vài SKU quen thuộc trước khi tin tưởng hoàn toàn.
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

-- Nếu POS dùng tên cột khác, gán tay tại đây, ví dụ:
-- SET @NameColumn = N'ProductName';

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
    PRINT N'ProductName lay tu tbl_LSProduct.' + @NameColumn + N'.';
END
ELSE
BEGIN
    INSERT INTO #ProductName (Product, ProductName)
    SELECT Product, NULL FROM #Products;
    PRINT N'Khong tim thay cot ten san pham trong tbl_LSProduct.';
END;

/* 5. Marker CTKM trên dòng bán POS. */
SELECT
    p.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    MAX(COALESCE(
        CASE
            WHEN d.DiscountCouponInv IS NOT NULL
             AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountCouponInv))) NOT IN (N'', N'0')
            THEN CONVERT(nvarchar(200), d.DiscountCouponInv)
            ELSE NULL
        END,
        CASE
            WHEN d.DiscountGroupProduct IS NOT NULL
             AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountGroupProduct))) NOT IN (N'', N'0')
            THEN CONVERT(nvarchar(200), d.DiscountGroupProduct)
            ELSE NULL
        END,
        CASE
            WHEN COALESCE(d.Discount, 0) <> 0
            THEN CONVERT(nvarchar(200), d.Discount)
            ELSE NULL
        END
    )) AS ActualPromoMarker
INTO #ActualPromoDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate >= @StartDate
  AND m.TransactionDate < DATEADD(day, 1, @EndDate)
  AND
  (
      COALESCE(d.Discount, 0) <> 0
   OR (d.DiscountCouponInv IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountCouponInv))) NOT IN (N'', N'0'))
   OR (d.DiscountGroupProduct IS NOT NULL AND LTRIM(RTRIM(CONVERT(nvarchar(200), d.DiscountGroupProduct))) NOT IN (N'', N'0'))
  )
GROUP BY p.Product, CONVERT(date, m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_ActualPromoDaily
    ON #ActualPromoDaily(Product, [Date]);

/* 6. Nhập/xuất kho theo logic sp_StockCurrent đã khảo sát. */
SELECT
    p.Product,
    CONVERT(date, m.EffDate) AS [Date],
    SUM(
        CASE
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'3'
                THEN COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'2'
                THEN COALESCE(d.Quantity, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'10', N'20', N'30', N'40', N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'6'
                THEN -COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'20', N'30', N'40', N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'5'
                THEN -COALESCE(d.QtyReceived, 0)
            ELSE 0
        END
    ) AS ImExNetQty
INTO #ImExDaily
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m
  ON m.Code = d.DocumentNo
JOIN #Products p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
WHERE m.EffDate IS NOT NULL
  AND m.EffDate < DATEADD(day, 1, @EndDate)
GROUP BY p.Product, CONVERT(date, m.EffDate);

CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily
    ON #ImExDaily(Product, [Date]);

/* 7. Phát sinh tồn ròng: kho + trả hàng POS - bán POS. */
SELECT
    x.Product,
    x.[Date],
    SUM(x.NetQty) AS NetQty
INTO #MovementDaily
FROM
(
    SELECT Product, [Date], ImExNetQty AS NetQty
    FROM #ImExDaily

    UNION ALL

    SELECT Product, [Date], ReturnQty - GrossSalesQty AS NetQty
    FROM #PosDaily
) x
WHERE x.[Date] IS NOT NULL
GROUP BY x.Product, x.[Date];

CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily
    ON #MovementDaily(Product, [Date]);

/* 8. Giờ nhập đầu tiên trong ngày, chỉ lấy phiếu nhập điều chuyển nội bộ. */
;WITH Type1Receipts AS
(
    SELECT
        p.Product,
        CONVERT(date, m.EffDate) AS [Date],
        CASE
            WHEN m.ReceiptDate IS NOT NULL
             AND CONVERT(date, m.ReceiptDate) = CONVERT(date, m.EffDate)
             AND CONVERT(char(8), m.ReceiptDate, 108) <> '00:00:00'
                THEN CONVERT(datetime, m.ReceiptDate)
            WHEN m.CreateTime IS NOT NULL
             AND CONVERT(date, m.CreateTime) = CONVERT(date, m.EffDate)
             AND CONVERT(char(8), m.CreateTime, 108) <> '00:00:00'
                THEN CONVERT(datetime, m.CreateTime)
            ELSE NULL
        END AS ReceiptDateTime
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m
      ON m.Code = d.DocumentNo
    JOIN #Products p
      ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = p.Product
    WHERE CONVERT(nvarchar(20), m.DocumentType) = N'1'
      AND m.EffDate IS NOT NULL
      AND m.EffDate >= @StartDate
      AND m.EffDate < DATEADD(day, 1, @EndDate)
      AND
      (
          (CONVERT(nvarchar(20), m.DocumentStatus) = N'3' AND COALESCE(d.QtyReceived, 0) > 0)
       OR (CONVERT(nvarchar(20), m.DocumentStatus) = N'2' AND COALESCE(d.Quantity, 0) > 0)
      )
)
SELECT
    Product,
    [Date],
    MIN(ReceiptDateTime) AS FirstReceiptDateTime
INTO #ReceiptDaily
FROM Type1Receipts
WHERE ReceiptDateTime IS NOT NULL
GROUP BY Product, [Date];

CREATE UNIQUE CLUSTERED INDEX IX_ReceiptDaily
    ON #ReceiptDaily(Product, [Date]);

/* 9. CTKM theo bảng promotion/bundle. Gom nhiều mã bằng FOR XML PATH. */
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
        pd.Product,
        pd.[Date],
        CONVERT(nvarchar(200), pr.Code) AS PromoCode,
        COALESCE(
            NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500), pr.Promotion))), N''),
            NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(200), pr.PromotionNo))), N''),
            CONVERT(nvarchar(200), pr.Code)
        ) AS PromoDisplayName
    FROM #ProductDates pd
    JOIN dbo.tbl_POLBundle b
      ON LTRIM(RTRIM(CONVERT(nvarchar(100), b.Product))) = pd.Product
      OR LTRIM(RTRIM(CONVERT(nvarchar(100), b.RefProduct))) = pd.Product
    JOIN dbo.tbl_POLPromotion pr
      ON pr.Code = b.Promotion
    WHERE pr.StartDate IS NOT NULL
      AND pr.EndDate IS NOT NULL
      AND pd.[Date] BETWEEN CONVERT(date, pr.StartDate)
                        AND CONVERT(date, pr.EndDate)
      AND (pr.IsPOS IS NULL OR CONVERT(nvarchar(20), pr.IsPOS) IN (N'1', N'True', N'true'))
      AND NOT EXISTS (
          SELECT 1 FROM #ExcludedPromotions ex
          WHERE ex.Code = CONVERT(nvarchar(100), pr.Code)
      )
)
INSERT INTO #PromoDailyNamed (Product, [Date], PromoCode, PromoDisplayName)
SELECT
    base.Product,
    base.[Date],
    STUFF(
        (
            SELECT N'|' + pm2.PromoCode
            FROM PromoMatches pm2
            WHERE pm2.Product = base.Product
              AND pm2.[Date] = base.[Date]
            ORDER BY pm2.PromoCode
            FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'),
        1,
        1,
        N''
    ) AS PromoCode,
    STUFF(
        (
            SELECT N'|' + pm2.PromoDisplayName
            FROM PromoMatches pm2
            WHERE pm2.Product = base.Product
              AND pm2.[Date] = base.[Date]
            ORDER BY pm2.PromoDisplayName
            FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'),
        1,
        1,
        N''
    ) AS PromoDisplayName
FROM
(
    SELECT DISTINCT Product, [Date]
    FROM PromoMatches
) base;

CREATE UNIQUE CLUSTERED INDEX IX_PromoDailyNamed
    ON #PromoDailyNamed(Product, [Date]);

IF @ShowDiagnostics = 1
BEGIN
    SELECT
        p.Product AS InputProduct,
        CASE WHEN price.Product IS NULL THEN 1 ELSE 0 END AS MissingPrice,
        CASE WHEN pname.ProductName IS NULL THEN 1 ELSE 0 END AS MissingProductName,
        MIN(pos.[Date]) AS FirstSaleDate,
        MAX(pos.[Date]) AS LastSaleDate,
        COALESCE(SUM(pos.GrossSalesQty), 0) AS GrossSalesQty
    FROM #Products p
    LEFT JOIN #ProductPrice price
      ON price.Product = p.Product
    LEFT JOIN #ProductName pname
      ON pname.Product = p.Product
    LEFT JOIN #PosDaily pos
      ON pos.Product = p.Product
     AND pos.[Date] BETWEEN @StartDate AND @EndDate
    GROUP BY p.Product, price.Product, pname.ProductName
    ORDER BY p.Product;

    /* 9b. Độ phủ từng mã CTKM đã khớp: dùng để phân biệt CTKM thời vụ thật
       (kéo dài vài tuần/tháng) với chính sách giá cố định bị ghi nhận như một
       "promotion" kéo dài gần như toàn bộ lịch sử (ví dụ mức giá riêng cho
       khách hàng thân thiết). DayShare càng gần 100% trên càng nhiều SKU thì
       càng nên đưa mã đó vào @ExcludePromotionCodes sau khi xem PromoName. */
    SELECT
        pm.PromoCode,
        MAX(pm.PromoDisplayName) AS SamplePromoName,
        COUNT(DISTINCT pm.Product) AS MatchedProducts,
        MIN(pm.[Date]) AS FirstMatchedDate,
        MAX(pm.[Date]) AS LastMatchedDate,
        COUNT(DISTINCT pm.[Date]) AS DistinctDaysAnyProduct,
        CAST(
            COUNT(*) * 100.0 / NULLIF((DATEDIFF(day, @StartDate, @EndDate) + 1) * COUNT(DISTINCT pm.Product), 0)
            AS decimal(5, 1)
        ) AS AvgDayShareOfHistoryPct
    FROM
    (
        SELECT DISTINCT
            base.Product, base.[Date],
            pr.Code AS PromoCode,
            COALESCE(NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500), pr.Promotion))), N''), CONVERT(nvarchar(200), pr.Code)) AS PromoDisplayName
        FROM #ProductDates base
        JOIN dbo.tbl_POLBundle b
          ON LTRIM(RTRIM(CONVERT(nvarchar(100), b.Product))) = base.Product
          OR LTRIM(RTRIM(CONVERT(nvarchar(100), b.RefProduct))) = base.Product
        JOIN dbo.tbl_POLPromotion pr
          ON pr.Code = b.Promotion
        WHERE pr.StartDate IS NOT NULL
          AND pr.EndDate IS NOT NULL
          AND base.[Date] BETWEEN CONVERT(date, pr.StartDate) AND CONVERT(date, pr.EndDate)
          AND (pr.IsPOS IS NULL OR CONVERT(nvarchar(20), pr.IsPOS) IN (N'1', N'True', N'true'))
    ) pm
    GROUP BY pm.PromoCode
    ORDER BY AvgDayShareOfHistoryPct DESC;

    /* 9c. Tồn âm: dấu hiệu lệch thứ tự ghi nhận chứng từ (bán trước, nhập kho
       ghi sau) trong ERP nguồn — không tự động sửa (không có căn cứ để đoán
       giá trị đúng), chỉ liệt kê để biết phạm vi ảnh hưởng. */
    SELECT
        movement.Product,
        COUNT(*) AS NegativeStockDays,
        MIN(movement.[Date]) AS FirstNegativeDate,
        MAX(movement.[Date]) AS LastNegativeDate
    FROM
    (
        SELECT
            m.Product, m.[Date],
            SUM(m.NetQty) OVER (PARTITION BY m.Product ORDER BY m.[Date]
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS RunningCloseStock
        FROM #MovementDaily m
    ) movement
    WHERE movement.RunningCloseStock < 0
    GROUP BY movement.Product
    ORDER BY NegativeStockDays DESC;
END;

/* 10. Kết quả cuối để xuất ra demand-planning-real.csv. */
SELECT
    pd.Product AS SKU,
    CONVERT(char(10), pd.[Date], 23) AS [Date],
    COALESCE(
        (
            SELECT SUM(movement.NetQty)
            FROM #MovementDaily movement
            WHERE movement.Product = pd.Product
              AND movement.[Date] < pd.[Date]
        ),
        0
    ) AS OpenStock,
    COALESCE(
        (
            SELECT SUM(movement.NetQty)
            FROM #MovementDaily movement
            WHERE movement.Product = pd.Product
              AND movement.[Date] <= pd.[Date]
        ),
        0
    ) AS CloseStock,
    COALESCE(pos.GrossSalesQty, 0) AS Sales,
    CASE
        WHEN receipt.FirstReceiptDateTime IS NULL THEN NULL
        ELSE CONVERT(char(5), receipt.FirstReceiptDateTime, 108)
    END AS ReceiptHour,
    COALESCE(promo.PromoCode, actualPromo.ActualPromoMarker) AS PromoCode,
    COALESCE(promo.PromoDisplayName, actualPromo.ActualPromoMarker) AS PromoName,
    price.Price AS Price,
    pname.ProductName AS ProductName
FROM #ProductDates pd
LEFT JOIN #PosDaily pos
  ON pos.Product = pd.Product
 AND pos.[Date] = pd.[Date]
LEFT JOIN #ActualPromoDaily actualPromo
  ON actualPromo.Product = pd.Product
 AND actualPromo.[Date] = pd.[Date]
LEFT JOIN #ReceiptDaily receipt
  ON receipt.Product = pd.Product
 AND receipt.[Date] = pd.[Date]
LEFT JOIN #PromoDailyNamed promo
  ON promo.Product = pd.Product
 AND promo.[Date] = pd.[Date]
LEFT JOIN #ProductPrice price
  ON price.Product = pd.Product
LEFT JOIN #ProductName pname
  ON pname.Product = pd.Product
ORDER BY pd.Product, pd.[Date];
