SELECT 
    tbl_SALPoSDetails.Product,
    tbl_LSProduct.Barcode,
    tbl_LSProduct.VName, 
    SUM(tbl_SALPoSDetails.Qty) AS TotalQty, 
    (SUM(tbl_SALPoSDetails.Amount) / NULLIF(SUM(tbl_SALPoSDetails.Qty), 0)) AS AvgPrice,
    tbl_SALPoSMaster.EffDate,
    tbl_SALPoSDetails.Discount,
    tbl_POLPromotion.Promotion
FROM tbl_SALPoSDetails
/* Dùng mấu nối chặt chẽ cho dữ liệu giao dịch cốt lõi */
JOIN tbl_SALPoSMaster ON tbl_SALPoSDetails.PoSMaster = tbl_SALPoSMaster.Code
JOIN tbl_LSProduct ON tbl_LSProduct.Code = tbl_SALPoSDetails.Product

/* Dùng mấu nối mở rộng (LEFT JOIN) cho dữ liệu khuyến mãi */
LEFT JOIN tbl_POLBundle ON tbl_POLBundle.Code = tbl_SALPoSDetails.Discount
LEFT JOIN tbl_POLPromotion ON tbl_POLBundle.Promotion = tbl_POLPromotion.Code

WHERE 
    /* Điều kiện 1: Lọc theo danh sách Mã sản phẩm nội bộ (Code) */
    tbl_SALPoSDetails.Product IN (
        49054, 50084, 14750, 30255, 61200, 
        39632, 59975, 31866, 20179, 33811, 
        31419, 39895, 36968, 28977, 24695, 
        39089, 48923, 40717, 24010, 31825, 
        34456, 38665, 34752, 41952, 55570, 
        19551, 39894, 44351, 31863, 15346
    )
    /* Kết hợp với Điều kiện 2: Lọc theo danh sách Mã vạch (Barcode) */
    OR tbl_LSProduct.Barcode IN (
        '4932313033092', '4965078102116', '4987645005453', '4987645005989',
        '4901001194186', '4903024904957', '4955209080352', '4955209080338',
        '4955209080345', '4573475402137', '4534374394596', '4971710573664',
        '4901065606939', '4973221032487', '4905489647905', '8997240600041',
        '4582517330024', '8936013251042', '4976416007932', '4902102019187',
        '4902871053900', '4908609116909', '8936013251097', '4550516493583',
        '4905687446263', '4968583245477', '4526112647644', '4582695026467',
        '4982790187924', '4535792442340', '4978929915261', '4941336729073',
        '4901548603844', '4905596183068', '4976790247870', '4901616010413',
        '4982790412309', '4901111910973', '4970285280038', '4546490702476',
        '4562370392322', '4560127703445'
    )
GROUP BY 
    tbl_SALPoSMaster.EffDate,
    tbl_LSProduct.Barcode,
    tbl_LSProduct.VName,
    tbl_SALPoSDetails.Product,
    tbl_SALPoSDetails.Discount,
    tbl_POLPromotion.Promotion
ORDER BY 
    tbl_SALPoSDetails.Product ASC,
	tbl_SALPoSMaster.EffDate DESC;


--Tìm ra những sản phẩm ít áp dụng KM nhất
SELECT TOP 30 WITH TIES 
[Product], 
COUNT(*) AS TotalNullDiscount
FROM [POS].[dbo].[tbl_SALPoSDetails]
WHERE [Discount] IS NULL
GROUP BY [Product]
ORDER BY TotalNullDiscount DESC;


/* =====================================================================
   LỊCH SỬ TỒN KHO PHỤC VỤ MÔ PHỎNG NGÀY 2026-02-01

   Hai SELECT doanh số phía trên được giữ nguyên. Result set này ghép với
   doanh số bằng ProductCode + Date.

   Khung xử lý Chặng 1:
       2023-01-03 .. 2026-01-31

   Vùng 24 ngày trước khung:
       2022-12-10 .. 2023-01-02
       IsReferenceOnly = 1, chỉ dùng tìm ngày tham chiếu để bù nền.

   Tồn được tái dựng ngược từ tbl_LSProduct.Quantity và toàn bộ phát sinh
   kho/POS đến ngày chạy SQL. Đây là số tái dựng, không phải snapshot gốc.
   ===================================================================== */

DECLARE @SimulationRunDate date = '2026-02-01';
DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @ReferenceDaysBefore int = 24;
DECLARE @StockAnchorDate date = CONVERT(date, GETDATE());
DECLARE @HistoryCandidateStartDate date;
DECLARE @ProcessingStartDate date;
DECLARE @ProcessingEndDate date = DATEADD(day, -1, @SimulationRunDate);
DECLARE @ReferenceReadStartDate date;
DECLARE @FullCycleDays int;

SET @HistoryCandidateStartDate = CONVERT
(
    date,
    CONVERT(char(4), YEAR(@SimulationRunDate) - @HistoryYears) + '0101',
    112
);

SET @FullCycleDays =
    (DATEDIFF(day, @HistoryCandidateStartDate, @ProcessingEndDate) + 1)
    / @CycleLength * @CycleLength;

SET @ProcessingStartDate = DATEADD
(
    day,
    -@FullCycleDays + 1,
    @ProcessingEndDate
);

SET @ReferenceReadStartDate = DATEADD
(
    day,
    -@ReferenceDaysBefore,
    @ProcessingStartDate
);

IF @FullCycleDays < @CycleLength
BEGIN
    RAISERROR(N'Khung lịch sử không tạo được một chu kỳ đầy đủ.', 16, 1);
    RETURN;
END;

IF @ProcessingEndDate > @StockAnchorDate
BEGIN
    RAISERROR(N'Ngày cuối lịch sử lớn hơn ngày neo tồn hiện tại.', 16, 1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#SalesHistoryTargetProducts') IS NOT NULL
    DROP TABLE #SalesHistoryTargetProducts;
IF OBJECT_ID('tempdb..#SalesHistoryCalendar') IS NOT NULL
    DROP TABLE #SalesHistoryCalendar;
IF OBJECT_ID('tempdb..#SalesHistoryDailyMovements') IS NOT NULL
    DROP TABLE #SalesHistoryDailyMovements;
IF OBJECT_ID('tempdb..#SalesHistoryStock') IS NOT NULL
    DROP TABLE #SalesHistoryStock;
IF OBJECT_ID('tempdb..#SalesHistoryFirstReceipts') IS NOT NULL
    DROP TABLE #SalesHistoryFirstReceipts;

CREATE TABLE #SalesHistoryTargetProducts
(
    ProductCode int NOT NULL PRIMARY KEY,
    Barcode nvarchar(100) NULL,
    ProductName nvarchar(500) NULL,
    CurrentStock decimal(38, 6) NOT NULL
);

INSERT INTO #SalesHistoryTargetProducts
(
    ProductCode,
    Barcode,
    ProductName,
    CurrentStock
)
SELECT
    Product.Code,
    CONVERT(nvarchar(100), Product.Barcode),
    CONVERT(nvarchar(500), Product.VName),
    CONVERT(decimal(38, 6), COALESCE(Product.Quantity, 0))
FROM dbo.tbl_LSProduct AS Product
WHERE Product.Code IN
(
    49054, 50084, 14750, 30255, 61200,
    39632, 59975, 31866, 20179, 33811,
    31419, 39895, 36968, 28977, 24695,
    39089, 48923, 40717, 24010, 31825,
    34456, 38665, 34752, 41952, 55570,
    19551, 39894, 44351, 31863, 15346
)
OR Product.Barcode IN
(
    '4932313033092', '4965078102116', '4987645005453', '4987645005989',
    '4901001194186', '4903024904957', '4955209080352', '4955209080338',
    '4955209080345', '4573475402137', '4534374394596', '4971710573664',
    '4901065606939', '4973221032487', '4905489647905', '8997240600041',
    '4582517330024', '8936013251042', '4976416007932', '4902102019187',
    '4902871053900', '4908609116909', '8936013251097', '4550516493583',
    '4905687446263', '4968583245477', '4526112647644', '4582695026467',
    '4982790187924', '4535792442340', '4978929915261', '4941336729073',
    '4901548603844', '4905596183068', '4976790247870', '4901616010413',
    '4982790412309', '4901111910973', '4970285280038', '4546490702476',
    '4562370392322', '4560127703445'
);

CREATE TABLE #SalesHistoryCalendar
(
    StockDate date NOT NULL PRIMARY KEY
);

;WITH Calendar AS
(
    SELECT @ReferenceReadStartDate AS StockDate

    UNION ALL

    SELECT DATEADD(day, 1, StockDate)
    FROM Calendar
    WHERE StockDate < @StockAnchorDate
)
INSERT INTO #SalesHistoryCalendar (StockDate)
SELECT StockDate
FROM Calendar
OPTION (MAXRECURSION 0);

CREATE TABLE #SalesHistoryDailyMovements
(
    ProductCode int NOT NULL,
    MovementDate date NOT NULL,
    DailyNetMovement decimal(38, 6) NOT NULL,
    PRIMARY KEY (ProductCode, MovementDate)
);

INSERT INTO #SalesHistoryDailyMovements
(
    ProductCode,
    MovementDate,
    DailyNetMovement
)
SELECT
    Movement.ProductCode,
    Movement.MovementDate,
    SUM(Movement.MovementQty)
FROM
(
    SELECT
        StockDetail.Product AS ProductCode,
        CONVERT
        (
            date,
            CASE
                WHEN StockMaster.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
                    THEN COALESCE(StockMaster.ReceiptDate, StockMaster.EffDate)
                ELSE COALESCE(StockMaster.EffDate, StockMaster.ReceiptDate)
            END
        ) AS MovementDate,
        CONVERT
        (
            decimal(38, 6),
            CASE
                WHEN StockMaster.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
                     AND StockMaster.DocumentStatus = 3
                    THEN COALESCE(StockDetail.QtyReceived, 0)
                WHEN StockMaster.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
                     AND StockMaster.DocumentStatus = 2
                    THEN COALESCE(StockDetail.Quantity, 0)
                WHEN StockMaster.DocumentType IN (5, 6, 7, 8, 9, 10, 20, 30, 40, 52)
                     AND StockMaster.DocumentStatus = 6
                    THEN -COALESCE(StockDetail.QtyReceived, 0)
                WHEN StockMaster.DocumentType IN (5, 6, 7, 8, 9, 20, 30, 40, 52)
                     AND StockMaster.DocumentStatus = 5
                    THEN -COALESCE(StockDetail.QtyReceived, 0)
                ELSE 0
            END
        ) AS MovementQty
    FROM dbo.tbl_OPSImExDetails AS StockDetail
    INNER JOIN dbo.tbl_OPSImExMaster AS StockMaster
        ON StockMaster.Code = StockDetail.DocumentNo
    INNER JOIN #SalesHistoryTargetProducts AS TargetProduct
        ON TargetProduct.ProductCode = StockDetail.Product
    WHERE
        (
            StockMaster.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
            AND StockMaster.DocumentStatus IN (2, 3)
        )
        OR
        (
            StockMaster.DocumentType IN (5, 6, 7, 8, 9, 10, 20, 30, 40, 52)
            AND StockMaster.DocumentStatus = 6
        )
        OR
        (
            StockMaster.DocumentType IN (5, 6, 7, 8, 9, 20, 30, 40, 52)
            AND StockMaster.DocumentStatus = 5
        )

    UNION ALL

    SELECT
        PosDetail.Product,
        CONVERT(date, PosMaster.TransactionDate),
        CONVERT(decimal(38, 6), -COALESCE(PosDetail.Qty, 0))
    FROM dbo.tbl_SALPoSDetails AS PosDetail
    INNER JOIN dbo.tbl_SALPoSMaster AS PosMaster
        ON PosMaster.Code = PosDetail.PoSMaster
    INNER JOIN #SalesHistoryTargetProducts AS TargetProduct
        ON TargetProduct.ProductCode = PosDetail.Product
) AS Movement
WHERE Movement.MovementDate >= @ReferenceReadStartDate
  AND Movement.MovementDate <= @StockAnchorDate
GROUP BY
    Movement.ProductCode,
    Movement.MovementDate;

CREATE TABLE #SalesHistoryStock
(
    ProductCode int NOT NULL,
    StockDate date NOT NULL,
    OpenStock decimal(38, 6) NOT NULL,
    CloseStock decimal(38, 6) NOT NULL,
    PRIMARY KEY (ProductCode, StockDate)
);

;WITH ProductDates AS
(
    SELECT
        Product.ProductCode,
        Product.CurrentStock,
        Calendar.StockDate,
        CONVERT(decimal(38, 6), COALESCE(Movement.DailyNetMovement, 0))
            AS DailyNetMovement
    FROM #SalesHistoryTargetProducts AS Product
    CROSS JOIN #SalesHistoryCalendar AS Calendar
    LEFT JOIN #SalesHistoryDailyMovements AS Movement
        ON Movement.ProductCode = Product.ProductCode
       AND Movement.MovementDate = Calendar.StockDate
),
ReverseMovements AS
(
    SELECT
        ProductDates.*,
        SUM(DailyNetMovement) OVER
        (
            PARTITION BY ProductCode
            ORDER BY StockDate DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS ReverseMovement
    FROM ProductDates
)
INSERT INTO #SalesHistoryStock
(
    ProductCode,
    StockDate,
    OpenStock,
    CloseStock
)
SELECT
    ProductCode,
    StockDate,
    CONVERT(decimal(38, 6), CurrentStock - ReverseMovement),
    CONVERT(decimal(38, 6), CurrentStock - ReverseMovement + DailyNetMovement)
FROM ReverseMovements;

CREATE TABLE #SalesHistoryFirstReceipts
(
    ProductCode int NOT NULL,
    ReceiptDate date NOT NULL,
    FirstReceiptCode int NOT NULL,
    FirstReceiptDateTime datetime NULL,
    PRIMARY KEY (ProductCode, ReceiptDate)
);

DECLARE @ReceiptTimeColumn sysname =
    CASE
        WHEN COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'CreateTime') IS NOT NULL
            THEN N'CreateTime'
        WHEN COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'LastModifiedTime') IS NOT NULL
            THEN N'LastModifiedTime'
        WHEN COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'ReceiptDate') IS NOT NULL
            THEN N'ReceiptDate'
        ELSE N'EffDate'
    END;
DECLARE @FirstReceiptSql nvarchar(max);

SET @FirstReceiptSql = N'
;WITH ReceiptDocuments AS
(
    SELECT
        Detail.Product AS ProductCode,
        CONVERT
        (
            date,
            COALESCE(Master.ReceiptDate, Master.EffDate, Master.'
            + QUOTENAME(@ReceiptTimeColumn) + N')
        ) AS ReceiptDate,
        Master.Code AS FirstReceiptCode,
        MIN(CONVERT(datetime, Master.' + QUOTENAME(@ReceiptTimeColumn) + N'))
            AS FirstReceiptDateTime
    FROM dbo.tbl_OPSImExDetails AS Detail
    INNER JOIN dbo.tbl_OPSImExMaster AS Master
        ON Master.Code = Detail.DocumentNo
    INNER JOIN #SalesHistoryTargetProducts AS Product
        ON Product.ProductCode = Detail.Product
    WHERE Master.DocumentType = 1
      AND Master.DocumentStatus IN (2, 3)
      AND COALESCE(Master.ReceiptDate, Master.EffDate, Master.'
        + QUOTENAME(@ReceiptTimeColumn) + N') >= @FromDate
      AND COALESCE(Master.ReceiptDate, Master.EffDate, Master.'
        + QUOTENAME(@ReceiptTimeColumn) + N') < DATEADD(day, 1, @ToDate)
    GROUP BY
        Detail.Product,
        CONVERT
        (
            date,
            COALESCE(Master.ReceiptDate, Master.EffDate, Master.'
            + QUOTENAME(@ReceiptTimeColumn) + N')
        ),
        Master.Code
),
RankedReceipts AS
(
    SELECT
        ReceiptDocuments.*,
        ROW_NUMBER() OVER
        (
            PARTITION BY ProductCode, ReceiptDate
            ORDER BY
                COALESCE(FirstReceiptDateTime, CONVERT(datetime, ReceiptDate)),
                FirstReceiptCode
        ) AS ReceiptOrder
    FROM ReceiptDocuments
)
INSERT INTO #SalesHistoryFirstReceipts
(
    ProductCode,
    ReceiptDate,
    FirstReceiptCode,
    FirstReceiptDateTime
)
SELECT
    ProductCode,
    ReceiptDate,
    FirstReceiptCode,
    FirstReceiptDateTime
FROM RankedReceipts
WHERE ReceiptOrder = 1;';

EXEC sys.sp_executesql
    @FirstReceiptSql,
    N'@FromDate date, @ToDate date',
    @FromDate = @ReferenceReadStartDate,
    @ToDate = @ProcessingEndDate;

SELECT
    Product.ProductCode,
    Product.Barcode,
    Product.ProductName,
    Stock.StockDate AS [Date],
    Stock.OpenStock,
    Stock.CloseStock,
    Receipt.FirstReceiptCode,
    DATEPART(hour, Receipt.FirstReceiptDateTime) AS ReceiptHour,
    CONVERT(time(0), Receipt.FirstReceiptDateTime) AS ReceiptTime,
    CONVERT
    (
        bit,
        CASE WHEN Stock.StockDate < @ProcessingStartDate THEN 1 ELSE 0 END
    ) AS IsReferenceOnly
FROM #SalesHistoryStock AS Stock
INNER JOIN #SalesHistoryTargetProducts AS Product
    ON Product.ProductCode = Stock.ProductCode
LEFT JOIN #SalesHistoryFirstReceipts AS Receipt
    ON Receipt.ProductCode = Stock.ProductCode
   AND Receipt.ReceiptDate = Stock.StockDate
WHERE Stock.StockDate >= @ReferenceReadStartDate
  AND Stock.StockDate <= @ProcessingEndDate
ORDER BY
    Product.ProductCode,
    Stock.StockDate;

DROP TABLE #SalesHistoryFirstReceipts;
DROP TABLE #SalesHistoryStock;
DROP TABLE #SalesHistoryDailyMovements;
DROP TABLE #SalesHistoryCalendar;
DROP TABLE #SalesHistoryTargetProducts;
