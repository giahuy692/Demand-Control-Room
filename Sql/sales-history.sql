/* =====================================================================
   SALES HISTORY + TỒN KHO THEO NGÀY

   Kiến trúc: SALES LÀ BẢNG CHÍNH, STOCK CHỈ LÀ THÔNG TIN PHỤ.

   Bước 1: tổng hợp sales hoàn chỉnh vào #SalesBase (logic sales đã khóa,
           giữ nguyên văn — không sửa công thức, không thêm điều kiện lọc).
   Bước 2: tái dựng tồn theo ProductCode + ngày (#StockDaily), tham khảo
           dấu cộng/trừ từ sp_StockCurrent (StockCurrent.sql). Chỉ đọc,
           không ghi bảng thật.
   Bước 3: LEFT JOIN stock + phiếu nhập đầu tiên vào sales.

   Lưu ý sử dụng kết quả:
       Không SUM OpenStock hoặc CloseStock sau khi join.
       Khi cần dữ liệu tồn duy nhất, deduplicate theo ProductCode + Date.
       (Cùng ProductCode + Date có thể có nhiều dòng sales do Discount /
        Promotion khác nhau; Open/CloseStock lặp lại trên các dòng đó.)
   ===================================================================== */

SET NOCOUNT ON;

DECLARE @StockAnchorDate date = CONVERT(date, GETDATE());
DECLARE @StockStartDate date;
DECLARE @StockEndDate date;
DECLARE @SalesRowCountBefore bigint;
DECLARE @SalesQtyBefore decimal(38, 6);
DECLARE @SalesRowCountAfter bigint;
DECLARE @SalesQtyAfter decimal(38, 6);
DECLARE @DuplicateStockRows int;
DECLARE @DuplicateReceiptRows int;

IF OBJECT_ID('tempdb..#SalesBase') IS NOT NULL DROP TABLE #SalesBase;
IF OBJECT_ID('tempdb..#StockProducts') IS NOT NULL DROP TABLE #StockProducts;
IF OBJECT_ID('tempdb..#StockCalendar') IS NOT NULL DROP TABLE #StockCalendar;
IF OBJECT_ID('tempdb..#StockDailyMovement') IS NOT NULL DROP TABLE #StockDailyMovement;
IF OBJECT_ID('tempdb..#StockDaily') IS NOT NULL DROP TABLE #StockDaily;
IF OBJECT_ID('tempdb..#FirstReceipt') IS NOT NULL DROP TABLE #FirstReceipt;
IF OBJECT_ID('tempdb..#FinalResult') IS NOT NULL DROP TABLE #FinalResult;

/* =====================================================================
   BƯỚC 1 — #SalesBase: logic sales đã khóa, giữ nguyên văn
   ===================================================================== */

CREATE TABLE #SalesBase
(
    SalesRowId bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    ProductCode int NOT NULL,
    Barcode nvarchar(100) NULL,
    ProductName nvarchar(500) NULL,
    TotalQty decimal(38, 6) NULL,
    Price decimal(38, 6) NULL,
    SalesEffDate datetime NULL,
    Discount int NULL,
    PromotionCode nvarchar(100) NULL,
    Promotion nvarchar(500) NULL,
    PromotionStartDate date NULL,
    PromotionEndDate date NULL,
    PromotionType int NULL /* Bổ sung khoang chứa Type */
);

INSERT INTO #SalesBase
(
    ProductCode,
    Barcode,
    ProductName,
    TotalQty,
    Price,
    SalesEffDate,
    Discount,
    PromotionCode,
    Promotion,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType /* Khai báo tên cột cần chèn */
)
SELECT
    tbl_SALPoSDetails.Product,
    tbl_LSProduct.Barcode,
    tbl_LSProduct.VName,
    SUM(tbl_SALPoSDetails.Qty) AS TotalQty,
    (SUM(tbl_SALPoSDetails.Amount) / NULLIF(SUM(tbl_SALPoSDetails.Qty), 0)) AS Price,
    tbl_SALPoSMaster.EffDate,
    tbl_SALPoSDetails.Discount,
    CONVERT(nvarchar(100), tbl_POLPromotion.Code),
    tbl_POLPromotion.Promotion,
    CONVERT(date, tbl_POLPromotion.StartDate),
    CONVERT(date, tbl_POLPromotion.EndDate),
    tbl_POLPromotion.Type /* Trích xuất dữ liệu Type */
FROM tbl_SALPoSDetails
/* Dùng mấu nối chặt chẽ cho dữ liệu giao dịch cốt lõi */
JOIN tbl_SALPoSMaster ON tbl_SALPoSDetails.PoSMaster = tbl_SALPoSMaster.Code
JOIN tbl_LSProduct ON tbl_LSProduct.Code = tbl_SALPoSDetails.Product

/* Dùng mấu nối mở rộng (LEFT JOIN) cho dữ liệu khuyến mãi */
LEFT JOIN tbl_POLBundle ON tbl_POLBundle.Code = tbl_SALPoSDetails.Discount
LEFT JOIN tbl_POLPromotion ON tbl_POLBundle.Promotion = tbl_POLPromotion.Code

WHERE
    /* Điều kiện 1: Lọc theo danh sách Mã sản phẩm nội bộ (Code) */
    tbl_salposdetails.product IN ( 49054, 50084, 14750, 30255, 39632, 31866, 20179,
33811, 31419, 39895, 36968, 28977, 24695, 39089, 48923, 40717, 24010, 31825,
34456, 38665, 34752, 41952, 55570, 19551, 39894, 44351, 31863, 15346, 30947,
31883, 46526, 42409, 37918, 47145, 33808, 46688, 33810, 34462, 34457, 24011,
28589, 56842, 42943, 39778, 41143, 33959, 41123, 30610, 31667, 46569 ) 
    /* Kết hợp với Điều kiện 2: Lọc theo danh sách Mã vạch (Barcode) */
    --OR tbl_LSProduct.Barcode IN ( ... ) 
    AND tbl_LSProduct.Barcode NOT LIKE '%H%' 
    AND tbl_LSProduct.Barcode NOT LIKE '%G%'
    /* Điều kiện 3: Giới hạn khung thời gian đúng 4 năm */
    AND tbl_SALPoSMaster.EffDate >= '2022-02-01'
    AND tbl_SALPoSMaster.EffDate <= '2026-02-01'

GROUP BY
    tbl_SALPoSMaster.EffDate,
    tbl_LSProduct.Barcode,
    tbl_LSProduct.VName,
    tbl_SALPoSDetails.Product,
    tbl_SALPoSDetails.Discount,
    tbl_POLPromotion.Code,
    tbl_POLPromotion.Promotion,
    CONVERT(date, tbl_POLPromotion.StartDate),
    CONVERT(date, tbl_POLPromotion.EndDate),
    tbl_POLPromotion.Type; /* Bắt buộc đưa vào nhóm phân loại */

SELECT
    @SalesRowCountBefore = COUNT_BIG(*),
    @SalesQtyBefore = SUM(COALESCE(TotalQty, 0))
FROM #SalesBase;

/* =====================================================================
   BƯỚC 2 — Phạm vi sản phẩm + ngày tồn, lấy từ chính #SalesBase.
   Không dùng stock để quyết định sản phẩm nào được giữ.
   ===================================================================== */

CREATE TABLE #StockProducts
(
    ProductCode int NOT NULL PRIMARY KEY,
    CurrentStock decimal(38, 6) NULL  -- NULL giữ nguyên, không COALESCE về 0
);

INSERT INTO #StockProducts (ProductCode, CurrentStock)
SELECT
    Sales.ProductCode,
    Product.Quantity
FROM (SELECT DISTINCT ProductCode FROM #SalesBase) AS Sales
LEFT JOIN dbo.tbl_LSProduct AS Product
    ON Product.Code = Sales.ProductCode;

SELECT
    @StockStartDate = MIN(CONVERT(date, SalesEffDate)),
    @StockEndDate = MAX(CONVERT(date, SalesEffDate))
FROM #SalesBase;

CREATE TABLE #StockCalendar
(
    StockDate date NOT NULL PRIMARY KEY
);

IF @StockStartDate IS NOT NULL AND @StockStartDate <= @StockAnchorDate
BEGIN
    ;WITH Calendar AS
    (
        SELECT @StockStartDate AS StockDate

        UNION ALL

        SELECT DATEADD(day, 1, StockDate)
        FROM Calendar
        WHERE StockDate < @StockAnchorDate
    )
    INSERT INTO #StockCalendar (StockDate)
    SELECT StockDate
    FROM Calendar
    OPTION (MAXRECURSION 0);
END;

/* =====================================================================
   Biến động tồn theo ngày. Ngày biến động là EffDate (không dùng
   ReceiptDate/TransactionDate) để cùng trục ngày với sales.
   Dấu cộng/trừ và danh sách DocumentType/DocumentStatus lấy nguyên
   từ sp_StockCurrent — không tự sửa.
   ===================================================================== */

CREATE TABLE #StockDailyMovement
(
    ProductCode int NOT NULL,
    MovementDate date NOT NULL,
    ImExNetQty decimal(38, 6) NOT NULL,
    PosSalesMovement decimal(38, 6) NOT NULL,
    PosReturnMovement decimal(38, 6) NOT NULL,
    DailyNetMovement decimal(38, 6) NOT NULL,
    PRIMARY KEY (ProductCode, MovementDate)
);

INSERT INTO #StockDailyMovement
(
    ProductCode,
    MovementDate,
    ImExNetQty,
    PosSalesMovement,
    PosReturnMovement,
    DailyNetMovement
)
SELECT
    Movement.ProductCode,
    Movement.MovementDate,
    SUM(Movement.ImExQty),
    SUM(Movement.PosSalesQty),
    SUM(Movement.PosReturnQty),
    SUM(Movement.ImExQty + Movement.PosSalesQty + Movement.PosReturnQty)
FROM
(
    /* --- Nhập / xuất kho: ngày nghiệp vụ = EffDate --- */
    SELECT
        StockDetail.Product AS ProductCode,
        CONVERT(date, StockMaster.EffDate) AS MovementDate,
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
        ) AS ImExQty,
        CONVERT(decimal(38, 6), 0) AS PosSalesQty,
        CONVERT(decimal(38, 6), 0) AS PosReturnQty
    FROM dbo.tbl_OPSImExDetails AS StockDetail
    INNER JOIN dbo.tbl_OPSImExMaster AS StockMaster
        ON StockMaster.Code = StockDetail.DocumentNo
    INNER JOIN #StockProducts AS TargetProduct
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

    /* --- POS chỉ để tính tồn (bán giảm tồn, trả/hoàn tăng tồn).
           RePosDetails/TransactionType chỉ dùng ở đây, không đưa vào
           #SalesBase. Ngày = EffDate, cùng trục ngày với sales. --- */
    SELECT
        PosDetail.Product,
        CONVERT(date, PosMaster.EffDate),
        CONVERT(decimal(38, 6), 0),
        CONVERT
        (
            decimal(38, 6),
            CASE
                WHEN PosMaster.TransactionType = 2
                     AND PosDetail.RePosDetails IS NULL
                    THEN -COALESCE(PosDetail.Qty, 0)
                ELSE 0
            END
        ),
        CONVERT
        (
            decimal(38, 6),
            CASE
                WHEN PosMaster.TransactionType = 3
                    THEN COALESCE(PosDetail.Qty, 0)
                WHEN PosMaster.TransactionType = 2
                     AND PosDetail.RePosDetails IS NOT NULL
                    THEN COALESCE(PosDetail.Qty, 0)
                ELSE 0
            END
        )
    FROM dbo.tbl_SALPoSDetails AS PosDetail
    INNER JOIN dbo.tbl_SALPoSMaster AS PosMaster
        ON PosMaster.Code = PosDetail.PoSMaster
    INNER JOIN #StockProducts AS TargetProduct
        ON TargetProduct.ProductCode = PosDetail.Product
) AS Movement
WHERE Movement.MovementDate >= @StockStartDate
  AND Movement.MovementDate <= @StockAnchorDate
GROUP BY
    Movement.ProductCode,
    Movement.MovementDate;

/* =====================================================================
   #StockDaily — duy nhất theo ProductCode + StockDate (PK bắt buộc).
   Tái dựng ngược từ tbl_LSProduct.Quantity (chỉ đọc):
       OpenStock(d)  = CurrentStock - SUM(DailyNetMovement từ d đến neo)
       CloseStock(d) = OpenStock(d) + DailyNetMovement(d)
   Tồn âm giữ nguyên. CurrentStock NULL → Open/Close NULL (ANCHOR_MISSING).
   ===================================================================== */

CREATE TABLE #StockDaily
(
    ProductCode int NOT NULL,
    StockDate date NOT NULL,
    OpenStock decimal(38, 6) NULL,
    CloseStock decimal(38, 6) NULL,
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
    FROM #StockProducts AS Product
    CROSS JOIN #StockCalendar AS Calendar
    LEFT JOIN #StockDailyMovement AS Movement
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
INSERT INTO #StockDaily
(
    ProductCode,
    StockDate,
    OpenStock,
    CloseStock
)
SELECT
    ProductCode,
    StockDate,
    CurrentStock - ReverseMovement,
    CurrentStock - ReverseMovement + DailyNetMovement
FROM ReverseMovements;

/* =====================================================================
   Phiếu nhập đầu tiên theo ProductCode + ngày nghiệp vụ (EffDate).
   Giờ nhập ưu tiên: ReceiptDate → CreateTime → LastModifiedTime
   (chỉ dùng cột giờ để lấy giờ; ngày join luôn là EffDate).
   Dynamic SQL vì CreateTime/LastModifiedTime có thể không tồn tại.
   ===================================================================== */

CREATE TABLE #FirstReceipt
(
    ProductCode int NOT NULL,
    ReceiptBusinessDate date NOT NULL,
    FirstReceiptCode int NOT NULL,
    FirstReceiptDateTime datetime NULL,
    PRIMARY KEY (ProductCode, ReceiptBusinessDate)
);

DECLARE @ReceiptTimeExpr nvarchar(max) = N'CONVERT(datetime, Master.ReceiptDate)';

IF COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'CreateTime') IS NOT NULL
    SET @ReceiptTimeExpr += N', CONVERT(datetime, Master.CreateTime)';
IF COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'LastModifiedTime') IS NOT NULL
    SET @ReceiptTimeExpr += N', CONVERT(datetime, Master.LastModifiedTime)';

SET @ReceiptTimeExpr =
    N'COALESCE(' + @ReceiptTimeExpr + N', CONVERT(datetime, NULL))';

DECLARE @FirstReceiptSql nvarchar(max) = N'
;WITH ReceiptDocuments AS
(
    SELECT
        Detail.Product AS ProductCode,
        CONVERT(date, Master.EffDate) AS ReceiptBusinessDate,
        Master.Code AS FirstReceiptCode,
        MIN(' + @ReceiptTimeExpr + N') AS FirstReceiptDateTime
    FROM dbo.tbl_OPSImExDetails AS Detail
    INNER JOIN dbo.tbl_OPSImExMaster AS Master
        ON Master.Code = Detail.DocumentNo
    INNER JOIN #StockProducts AS Product
        ON Product.ProductCode = Detail.Product
    WHERE Master.DocumentType = 1
      AND Master.DocumentStatus IN (2, 3)
      AND CONVERT(date, Master.EffDate) >= @FromDate
      AND CONVERT(date, Master.EffDate) <= @ToDate
    GROUP BY
        Detail.Product,
        CONVERT(date, Master.EffDate),
        Master.Code
),
RankedReceipts AS
(
    SELECT
        ReceiptDocuments.*,
        ROW_NUMBER() OVER
        (
            PARTITION BY ProductCode, ReceiptBusinessDate
            ORDER BY
                COALESCE(FirstReceiptDateTime,
                         CONVERT(datetime, ReceiptBusinessDate)),
                FirstReceiptCode
        ) AS ReceiptOrder
    FROM ReceiptDocuments
)
INSERT INTO #FirstReceipt
(
    ProductCode,
    ReceiptBusinessDate,
    FirstReceiptCode,
    FirstReceiptDateTime
)
SELECT
    ProductCode,
    ReceiptBusinessDate,
    FirstReceiptCode,
    FirstReceiptDateTime
FROM RankedReceipts
WHERE ReceiptOrder = 1;';

EXEC sys.sp_executesql
    @FirstReceiptSql,
    N'@FromDate date, @ToDate date',
    @FromDate = @StockStartDate,
    @ToDate = @StockEndDate;

/* =====================================================================
   BƯỚC 3 — LEFT JOIN stock vào sales. #SalesBase dẫn kết quả;
   không có điều kiện Stock/Receipt nào trong WHERE.
   ===================================================================== */

CREATE TABLE #FinalResult
(
    SalesRowId bigint NOT NULL PRIMARY KEY,
    ProductCode int NOT NULL,
    Barcode nvarchar(100) NULL,
    ProductName nvarchar(500) NULL,
    TotalQty decimal(38, 6) NULL,
    Price decimal(38, 6) NULL,
    EffDate datetime NULL,
    Discount int NULL,
    PromotionCode nvarchar(100) NULL,
    Promotion nvarchar(500) NULL,
    PromotionStartDate date NULL,
    PromotionEndDate date NULL,
    PromotionType int NULL, /* Bổ sung khoang chứa Type ở trạm cuối */
    OpenStock decimal(38, 6) NULL,
    CloseStock decimal(38, 6) NULL,
    FirstReceiptCode int NULL,
    ReceiptHour int NULL,
    ReceiptTime time(0) NULL,
    StockJoinStatus varchar(30) NOT NULL
);

INSERT INTO #FinalResult
(
    SalesRowId,
    ProductCode,
    Barcode,
    ProductName,
    TotalQty,
    Price,
    EffDate,
    Discount,
    PromotionCode,
    Promotion,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType, /* Gọi tên cột */
    OpenStock,
    CloseStock,
    FirstReceiptCode,
    ReceiptHour,
    ReceiptTime,
    StockJoinStatus
)
SELECT
    Sales.SalesRowId,
    Sales.ProductCode,
    Sales.Barcode,
    Sales.ProductName,
    Sales.TotalQty,
    Sales.Price,
    Sales.SalesEffDate,
    Sales.Discount,
    Sales.PromotionCode,
    Sales.Promotion,
    Sales.PromotionStartDate,
    Sales.PromotionEndDate,
    Sales.PromotionType, /* Trích xuất từ bảng tạm */

    Stock.OpenStock,
    Stock.CloseStock,

    Receipt.FirstReceiptCode,
    DATEPART(hour, Receipt.FirstReceiptDateTime),
    CONVERT(time(0), Receipt.FirstReceiptDateTime),

    CASE
        WHEN Stock.ProductCode IS NULL
             AND CONVERT(date, Sales.SalesEffDate) > @StockAnchorDate
            THEN 'AFTER_STOCK_ANCHOR'

        WHEN Stock.ProductCode IS NULL
            THEN 'STOCK_NOT_AVAILABLE'

        WHEN Stock.OpenStock IS NULL
             OR Stock.CloseStock IS NULL
            THEN 'ANCHOR_MISSING'

        ELSE 'MATCHED'
    END
FROM #SalesBase AS Sales
LEFT JOIN #StockDaily AS Stock
    ON Stock.ProductCode = Sales.ProductCode
   AND Stock.StockDate = CONVERT(date, Sales.SalesEffDate)
LEFT JOIN #FirstReceipt AS Receipt
    ON Receipt.ProductCode = Sales.ProductCode
   AND Receipt.ReceiptBusinessDate = CONVERT(date, Sales.SalesEffDate);

/* =====================================================================
   Kiểm tra chống mất / nhân dòng sales trước khi xuất
   ===================================================================== */

SELECT
    @SalesRowCountAfter = COUNT_BIG(*),
    @SalesQtyAfter = SUM(COALESCE(TotalQty, 0))
FROM #FinalResult;

IF @SalesRowCountBefore <> @SalesRowCountAfter
BEGIN
    RAISERROR(N'Số dòng sales đã thay đổi sau khi LEFT JOIN tồn.', 16, 1);
    RETURN;
END;

IF @SalesQtyBefore <> @SalesQtyAfter
BEGIN
    RAISERROR(N'Tổng Sales đã thay đổi sau khi LEFT JOIN tồn.', 16, 1);
    RETURN;
END;

/* PK đã chặn trùng về mặt cấu trúc; kiểm tra lại tường minh theo yêu cầu. */
SELECT @DuplicateStockRows = COUNT(*)
FROM
(
    SELECT ProductCode, StockDate
    FROM #StockDaily
    GROUP BY ProductCode, StockDate
    HAVING COUNT(*) > 1
) AS DuplicateStock;

IF @DuplicateStockRows > 0
BEGIN
    RAISERROR(N'#StockDaily có dòng trùng ProductCode + StockDate.', 16, 1);
    RETURN;
END;

SELECT @DuplicateReceiptRows = COUNT(*)
FROM
(
    SELECT ProductCode, ReceiptBusinessDate
    FROM #FirstReceipt
    GROUP BY ProductCode, ReceiptBusinessDate
    HAVING COUNT(*) > 1
) AS DuplicateReceipt;

IF @DuplicateReceiptRows > 0
BEGIN
    RAISERROR(N'#FirstReceipt có dòng trùng ProductCode + ReceiptBusinessDate.', 16, 1);
    RETURN;
END;

/* =====================================================================
   Result set duy nhất
   ===================================================================== */

SELECT
    ProductCode,
    Barcode,
    ProductName,
    TotalQty,
    Price,
    EffDate,
    Discount,
    PromotionCode,
    Promotion,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType, /* Hiển thị ra màn hình báo cáo */
    OpenStock,
    CloseStock,
    FirstReceiptCode,
    ReceiptHour,
    ReceiptTime,
    StockJoinStatus
FROM #FinalResult
ORDER BY
    ProductCode ASC,
    EffDate DESC,
    SalesRowId;

DROP TABLE #FinalResult;
DROP TABLE #FirstReceipt;
DROP TABLE #StockDaily;
DROP TABLE #StockDailyMovement;
DROP TABLE #StockCalendar;
DROP TABLE #StockProducts;
DROP TABLE #SalesBase;