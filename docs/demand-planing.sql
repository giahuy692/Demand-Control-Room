USE [POS];
SET NOCOUNT ON;

/* ================================================================
   FILE DUY NHẤT CẦN CHẠY ĐỂ LẤY DỮ LIỆU TEST DEMAND PLANNING
   ================================================================

   Mục tiêu output (đúng tên cột yêu cầu):
       SKU, Date, OpenStock, CloseStock, Sales, ReceiptHour, PromoCode

   Nguyên tắc an toàn:
   - Chỉ đọc bảng thật trong POS.
   - Chỉ tạo bảng tạm #... trong tempdb.
   - Không UPDATE, DELETE, INSERT vào bảng thật.
   - Không gọi sp_StockCurrent.

   Logic bán hàng đã chỉnh theo POS thật:
   - tbl_SALPoSDetails là bảng chi tiết bán lẻ theo từng sản phẩm.
   - Sales lấy từ tbl_SALPoSDetails.Qty.
   - Match sản phẩm bằng tbl_SALPoSDetails.Product.
   - Không ép tbl_SALPoSMaster.TransactionType = 2 vì quy tắc đó
     được copy từ 3PPOS và đã không khớp dữ liệu POS thật.

   Quy ước POS:
   - RePosDetails IS NULL     => dòng bán ghi nhận.
   - RePosDetails IS NOT NULL => dòng hoàn/trả/tham chiếu, dùng tăng tồn.

   Quy ước tồn:
   - Tồn đầu ngày D = tổng phát sinh trước ngày D.
   - Tồn cuối ngày D = tổng phát sinh đến hết ngày D.
   - Phát sinh kho bám theo logic sp_StockCurrent đã cung cấp,
     nhưng chỉ tính trong bảng tạm, không cập nhật tbl_LSProduct.
   ================================================================ */

DECLARE @StartDate date;
DECLARE @EndDate date;
DECLARE @ProductCount int;

/* Khoảng ngày phải bao trùm dữ liệu bán thật của 3 SKU test.
   Chẩn đoán thô (mục 0) cho thấy giao dịch thật nằm trong 2021-01-01..2022-05-31,
   không phải 2023 trở đi -- nếu đổi lại @StartDate/@EndDate sau này,
   luôn đối chiếu với FirstTransactionDate/LastTransactionDate ở mục 0 trước. */
SET @StartDate = '2021-01-01';
SET @EndDate = '2026-07-07';

DECLARE @Products table
(
    Product nvarchar(100) NOT NULL PRIMARY KEY
);

INSERT INTO @Products(Product) VALUES (N'28972');
INSERT INTO @Products(Product) VALUES (N'28973');
INSERT INTO @Products(Product) VALUES (N'47297');

SELECT @ProductCount = COUNT(*) FROM @Products;

IF @ProductCount < 1 OR @ProductCount > 3
BEGIN
    RAISERROR(N'POC chỉ nhận từ 1 đến 3 mã sản phẩm.', 16, 1);
    RETURN;
END;

/* ================================================================
   0. CHẨN ĐOÁN THÔ (luôn chạy trước, không phụ thuộc @StartDate/@EndDate,
      không LTRIM/CONVERT) để tìm nguyên nhân nếu kết quả cuối ra toàn 0:
      sai kiểu dữ liệu Product, sai cột Qty, hay ngày nằm ngoài khoảng lọc.
   ================================================================ */
SELECT
    selected.Product AS InputProduct,
    COUNT(d.PoSMaster) AS RawLineCount,
    SUM(CASE WHEN d.RePosDetails IS NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS RawSaleQty,
    SUM(CASE WHEN d.RePosDetails IS NOT NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS RawReturnQty,
    MIN(m.TransactionDate) AS FirstTransactionDate,
    MAX(m.TransactionDate) AS LastTransactionDate
FROM @Products selected
LEFT JOIN dbo.tbl_SALPoSDetails d
  ON CONVERT(nvarchar(100), d.Product) = selected.Product
LEFT JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
GROUP BY selected.Product
ORDER BY selected.Product;
-- Đọc kết quả trên trước khi xem kết quả cuối:
--   RawLineCount = 0            => Product trong tbl_SALPoSDetails không khớp mã này
--                                   (kiểm tra định dạng: có số 0 đứng đầu, có khoảng trắng,
--                                   hay là barcode khác thay vì mã Product không).
--   RawLineCount > 0 nhưng
--   RawSaleQty = 0 và
--   RawReturnQty > 0            => Toàn bộ dòng khớp đều là dòng trả/tham chiếu
--                                   (RePosDetails NOT NULL), cần xem lại có đúng logic không.
--   FirstTransactionDate/
--   LastTransactionDate nằm
--   ngoài @StartDate..@EndDate  => Cần chỉnh lại @StartDate/@EndDate cho đúng.

IF OBJECT_ID('tempdb..#Dates') IS NOT NULL DROP TABLE #Dates;
IF OBJECT_ID('tempdb..#ProductDates') IS NOT NULL DROP TABLE #ProductDates;
IF OBJECT_ID('tempdb..#PosDaily') IS NOT NULL DROP TABLE #PosDaily;
IF OBJECT_ID('tempdb..#ActualPromoDaily') IS NOT NULL DROP TABLE #ActualPromoDaily;
IF OBJECT_ID('tempdb..#ImExDaily') IS NOT NULL DROP TABLE #ImExDaily;
IF OBJECT_ID('tempdb..#MovementDaily') IS NOT NULL DROP TABLE #MovementDaily;
IF OBJECT_ID('tempdb..#ReceiptDaily') IS NOT NULL DROP TABLE #ReceiptDaily;
IF OBJECT_ID('tempdb..#PromoDaily') IS NOT NULL DROP TABLE #PromoDaily;

/* 1. Lịch ngày đầy đủ để không mất ngày không bán. */
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
FROM @Products p
CROSS JOIN #Dates d;

CREATE UNIQUE CLUSTERED INDEX IX_ProductDates
    ON #ProductDates(Product, [Date]);

/* 2. POS bán lẻ theo ngày.
      Không lọc TransactionType.
      Chỉ dùng TransactionDate để chốt ngày bán. */
SELECT
    selected.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    SUM(CASE
            WHEN d.RePosDetails IS NULL
            THEN COALESCE(d.Qty, 0)
            ELSE 0
        END) AS GrossSalesQty,
    SUM(CASE
            WHEN d.RePosDetails IS NOT NULL
            THEN COALESCE(d.Qty, 0)
            ELSE 0
        END) AS ReturnQty
INTO #PosDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN @Products selected
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = selected.Product
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate < DATEADD(day, 1, @EndDate)
GROUP BY selected.Product, CONVERT(date, m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_PosDaily
    ON #PosDaily(Product, [Date]);

/* Nếu không có sales thì dừng, không trả chuỗi toàn 0 gây hiểu nhầm. */
IF NOT EXISTS
(
    SELECT 1
    FROM #PosDaily
    WHERE GrossSalesQty <> 0
)
BEGIN
    SELECT
        selected.Product AS InputProduct,
        COALESCE(SUM(pos.GrossSalesQty), 0) AS MatchedGrossSalesQty,
        COALESCE(SUM(pos.ReturnQty), 0) AS MatchedReturnQty,
        COUNT(pos.Product) AS MatchedSaleDays
    FROM @Products selected
    LEFT JOIN #PosDaily pos
      ON pos.Product = selected.Product
    GROUP BY selected.Product
    ORDER BY selected.Product;

    RAISERROR(N'Không tìm thấy sales theo tbl_SALPoSDetails.Product + Qty + RePosDetails IS NULL. Cần kiểm tra lại mã sản phẩm hoặc khoảng ngày.', 16, 1);
    RETURN;
END;

/* 3. Marker CTKM phát sinh trên dòng POS nếu có. */
SELECT
    selected.Product,
    CONVERT(date, m.TransactionDate) AS [Date],
    MAX(COALESCE(
        CONVERT(nvarchar(200), d.DiscountCouponInv),
        CONVERT(nvarchar(200), d.DiscountGroupProduct),
        CONVERT(nvarchar(200), d.Discount)
    )) AS ActualPromoMarker
INTO #ActualPromoDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
JOIN @Products selected
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = selected.Product
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate < DATEADD(day, 1, @EndDate)
  AND
  (
      d.DiscountCouponInv IS NOT NULL
   OR d.DiscountGroupProduct IS NOT NULL
   OR d.Discount IS NOT NULL
  )
GROUP BY selected.Product, CONVERT(date, m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_ActualPromoDaily
    ON #ActualPromoDaily(Product, [Date]);

/* 4. Nhập/xuất kho theo logic sp_StockCurrent. */
SELECT
    selected.Product,
    CONVERT(date, m.EffDate) AS [Date],
    SUM(
        CASE
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1',N'2',N'3',N'4',N'21',N'31',N'41',N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'3'
                THEN COALESCE(d.QtyReceived, 0)

            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1',N'2',N'3',N'4',N'21',N'31',N'41',N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'2'
                THEN COALESCE(d.Quantity, 0)

            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5',N'6',N'7',N'8',N'9',N'10',N'20',N'30',N'40',N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'6'
                THEN -COALESCE(d.QtyReceived, 0)

            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5',N'6',N'7',N'8',N'9',N'20',N'30',N'40',N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'5'
                THEN -COALESCE(d.QtyReceived, 0)

            ELSE 0
        END
    ) AS ImExNetQty
INTO #ImExDaily
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m
  ON m.Code = d.DocumentNo
JOIN @Products selected
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = selected.Product
WHERE m.EffDate IS NOT NULL
  AND m.EffDate < DATEADD(day, 1, @EndDate)
GROUP BY selected.Product, CONVERT(date, m.EffDate);

CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily
    ON #ImExDaily(Product, [Date]);

/* 5. Phát sinh tồn ròng theo ngày:
      nhập/xuất kho + trả hàng POS - bán POS. */
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

    SELECT
        Product,
        [Date],
        ReturnQty - GrossSalesQty AS NetQty
    FROM #PosDaily
) x
WHERE x.[Date] IS NOT NULL
GROUP BY x.Product, x.[Date];

CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily
    ON #MovementDaily(Product, [Date]);

/* 6. Phiếu nhập điều chuyển nội bộ đầu tiên trong ngày.
      DocumentType = 1 theo yêu cầu hiện tại.
      Ưu tiên ReceiptDate có giờ; nếu không có thì dùng CreateTime cùng ngày EffDate. */
;WITH Type1Receipts AS
(
    SELECT
        selected.Product,
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
    JOIN @Products selected
      ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = selected.Product
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

/* 7. CTKM theo bảng promotion/bundle nếu có cấu hình. */
;WITH PromoMatches AS
(
    SELECT DISTINCT
        pd.Product,
        pd.[Date],
        CONVERT(nvarchar(200), pr.Code) AS PromoCode
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
)
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
    ) AS PromoCode
INTO #PromoDaily
FROM
(
    SELECT DISTINCT Product, [Date]
    FROM PromoMatches
) base;

CREATE UNIQUE CLUSTERED INDEX IX_PromoDaily
    ON #PromoDaily(Product, [Date]);

/* 8. Kết quả duy nhất nạp vào mô phỏng. */
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
    COALESCE(promo.PromoCode, actualPromo.ActualPromoMarker) AS PromoCode
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
LEFT JOIN #PromoDaily promo
  ON promo.Product = pd.Product
 AND promo.[Date] = pd.[Date]
ORDER BY pd.Product, pd.[Date];