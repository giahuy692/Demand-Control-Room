USE [POS];
SET NOCOUNT ON;

/* ================================================================
   QUÉT ĐỘ PHỦ SKU THẬT CHO demand-planing-simulation

   Mục đích: tìm một bộ mã SKU thật đại diện đủ các trường hợp Chặng 1-13,
   giống cách 14 SKU dữ liệu giả trong `catalog.ts` cố tình phủ đủ
   AX-stable/AY-seasonal/AZ-intermittent/BX-trend-up/BY-trend-volatile/
   BZ-sparse/BY-short/CX-boundary/CY-volatile/CZ-single/NEW/ONE-CYCLE/
   FIVE-CYCLES/D-zero-stock.

   Vì sao cần file này: `src/assets/List-product.json` (sinh ra ngoài repo
   này) bị lỗi — ActiveCycles/ZeroCycles gần như một hằng số cho MỌI SKU
   (64-65/21-23), nên ApproxDemandShape luôn ra "Z_INTERMITTENT" và
   CoverageScore luôn = 83 cho cả 80/80 SKU, không phản ánh dữ liệu thật.
   Nguyên nhân kỹ thuật: n (tổng chu kỳ) bị tính giống hệt nhau cho mọi SKU
   thay vì m (chu kỳ có nhu cầu dương) được tính đúng theo TỪNG SKU.

   Cách dùng:
   - Để @ProductCodes = NULL: tự quét @MaxCandidates SKU có tổng sản lượng
     bán cao nhất trong lịch sử (đủ dữ liệu để phân loại có ý nghĩa).
   - Hoặc dán danh sách mã (cùng cú pháp @ProductCodes của demand-planing.sql)
     để chỉ quét đúng các SKU đó.
   - Đọc cột `Shape` (X/Y/Z/D, đúng công thức ADI/CV² của
     `src/app/domain/math.ts::classifyXyz`) và `AnnualValueHint` (xếp theo giá
     trị tiêu thụ tạm tính, thay cho ABC thật của Chặng 6) để chọn SKU phủ đủ
     3×3 ô ma trận, cộng thêm vài SKU có `StockoutSignalDayPct`/
     `PromoDayPctOfSaleDays` cao để phủ trường hợp SO/CTKM rõ rệt, và vài SKU
     có `SaleDays` thấp để phủ trường hợp NEW/ONE-CYCLE/FIVE-CYCLES.

   Không cross join lịch ngày × SKU (tốn với quy mô ~8000 SKU thật) — gộp
   thẳng theo chu kỳ từ dòng bán bằng DATEDIFF/CycleLength, và dùng SUM() OVER
   (window function, O(n log n) mỗi SKU) thay cho subquery tương quan để tính
   tồn/stockout, thay vì lặp lại kiểu O(n²) của `demand-planing.sql`.
   ================================================================ */

DECLARE @ManualRunDate date = NULL;
DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @MaxCandidates int = 500; -- chỉ áp dụng khi @ProductCodes IS NULL
DECLARE @ProductCodes nvarchar(max) = NULL; -- NULL = tự chọn top theo sản lượng bán

DECLARE @RunDate date;
DECLARE @HistoryStart date;
DECLARE @HistoryEnd date;
DECLARE @TotalHistoryDays int;
DECLARE @FullCycleCount int;
DECLARE @StartDate date;
DECLARE @EndDate date;

SELECT @RunDate = COALESCE(@ManualRunDate, DATEADD(day, 1, MAX(CONVERT(date, TransactionDate))))
FROM dbo.tbl_SALPoSMaster
WHERE TransactionDate IS NOT NULL;

IF @RunDate IS NULL
BEGIN
    RAISERROR(N'Khong tim thay ngay giao dich nao trong tbl_SALPoSMaster.', 16, 1);
    RETURN;
END;

SET @HistoryStart = CONVERT(date, CONVERT(char(4), YEAR(@RunDate) - @HistoryYears) + '0101', 112);
SET @HistoryEnd = DATEADD(day, -1, @RunDate);
SET @TotalHistoryDays = DATEDIFF(day, @HistoryStart, @HistoryEnd) + 1;
SET @FullCycleCount = @TotalHistoryDays / @CycleLength;
SET @StartDate = DATEADD(day, 1 - @FullCycleCount * @CycleLength, @HistoryEnd);
SET @EndDate = @HistoryEnd;

IF OBJECT_ID('tempdb..#Candidates') IS NOT NULL DROP TABLE #Candidates;
CREATE TABLE #Candidates (Product nvarchar(100) NOT NULL PRIMARY KEY);

IF @ProductCodes IS NOT NULL AND LTRIM(RTRIM(@ProductCodes)) <> N''
BEGIN
    DECLARE @ProductCodesXml xml = CAST(
        N'<x><i>' + REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            LTRIM(RTRIM(@ProductCodes)), CHAR(13), N','), CHAR(10), N','), CHAR(9), N','), N';', N','), N',', N'</i><i>'
        ) + N'</i></x>' AS xml
    );
    INSERT INTO #Candidates (Product)
    SELECT DISTINCT LTRIM(RTRIM(ProductNode.Item.value('.', 'nvarchar(100)')))
    FROM @ProductCodesXml.nodes('/x/i') AS ProductNode(Item)
    WHERE LTRIM(RTRIM(ProductNode.Item.value('.', 'nvarchar(100)'))) <> N'';
END
ELSE
BEGIN
    INSERT INTO #Candidates (Product)
    SELECT TOP (@MaxCandidates) LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product)))
    FROM dbo.tbl_SALPoSDetails d
    JOIN dbo.tbl_SALPoSMaster m ON m.Code = d.PoSMaster
    WHERE d.RePosDetails IS NULL
      AND m.TransactionDate >= @StartDate
      AND m.TransactionDate < DATEADD(day, 1, @EndDate)
    GROUP BY LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product)))
    ORDER BY SUM(COALESCE(d.Qty, 0)) DESC;
END;

/* 1. Bán theo ngày (chỉ ngày thật có dòng bán — không cross join lịch). */
IF OBJECT_ID('tempdb..#SalesDaily') IS NOT NULL DROP TABLE #SalesDaily;
SELECT
    c.Product,
    CONVERT(date, m.TransactionDate) AS SaleDate,
    SUM(CASE WHEN d.RePosDetails IS NULL THEN COALESCE(d.Qty, 0) ELSE 0 END) AS Qty
INTO #SalesDaily
FROM #Candidates c
JOIN dbo.tbl_SALPoSDetails d
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = c.Product
JOIN dbo.tbl_SALPoSMaster m
  ON m.Code = d.PoSMaster
WHERE m.TransactionDate >= @StartDate
  AND m.TransactionDate < DATEADD(day, 1, @EndDate)
GROUP BY c.Product, CONVERT(date, m.TransactionDate);

/* 2. Gộp theo chu kỳ (bucket = số ngày lệch so với @StartDate chia CycleLength).
      Chu kỳ không có dòng bán nào sẽ KHÔNG xuất hiện ở đây — coi là chu kỳ 0,
      đúng bản chất "chu kỳ có nhu cầu dương" (m) dùng trong classifyXyz. */
IF OBJECT_ID('tempdb..#CycleAgg') IS NOT NULL DROP TABLE #CycleAgg;
SELECT
    Product,
    DATEDIFF(day, @StartDate, SaleDate) / @CycleLength AS CycleIndex,
    SUM(Qty) AS CycleQty
INTO #CycleAgg
FROM #SalesDaily
GROUP BY Product, DATEDIFF(day, @StartDate, SaleDate) / @CycleLength
HAVING SUM(Qty) > 0;

/* 3. ADI/CV² đúng công thức math.ts::classifyXyz. n = số Ô chu kỳ trong cửa sổ
      đuôi tối đa 24 (hằng số theo lịch, KHÔNG phải số dòng dương), khớp
      lockedValues(state).slice(-24) phía engine: nếu chỉ đếm "24 chu kỳ dương
      gần nhất" theo thứ hạng thay vì theo Ô lịch thật, ADI sẽ bị tính sai khi
      giữa các chu kỳ dương có khoảng trống dài (đúng lỗi đã thấy ở
      List-product.json). */
DECLARE @TailWindow int = CASE WHEN @FullCycleCount < 24 THEN @FullCycleCount ELSE 24 END;
DECLARE @TailStartCycleIndex int = @FullCycleCount - @TailWindow; -- CycleIndex 0-based, đuôi = [@TailStartCycleIndex, @FullCycleCount-1]

IF OBJECT_ID('tempdb..#Shape') IS NOT NULL DROP TABLE #Shape;
SELECT
    c.Product,
    @TailWindow AS TotalCycles,
    COUNT(a.CycleIndex) AS PositiveCyclesInTail,
    CAST(@TailWindow * 1.0 / NULLIF(COUNT(a.CycleIndex), 0) AS decimal(10, 3)) AS Adi,
    AVG(CAST(a.CycleQty AS float)) AS PositiveMean,
    CASE WHEN COUNT(a.CycleIndex) > 1 THEN STDEVP(CAST(a.CycleQty AS float)) ELSE 0 END AS PositiveStdevPopulation,
    CASE WHEN AVG(CAST(a.CycleQty AS float)) > 0 AND COUNT(a.CycleIndex) > 1 THEN
        POWER(STDEVP(CAST(a.CycleQty AS float)) / AVG(CAST(a.CycleQty AS float)), 2)
    ELSE NULL END AS Cv2
INTO #Shape
FROM #Candidates c
LEFT JOIN #CycleAgg a
  ON a.Product = c.Product AND a.CycleIndex >= @TailStartCycleIndex AND a.CycleIndex < @FullCycleCount
GROUP BY c.Product;

/* 4. Tồn/stockout: SUM() OVER window (O(n log n)/SKU) thay cho subquery
      tương quan O(n²) — đủ rẻ để chạy trên vài trăm/nghìn SKU. */
IF OBJECT_ID('tempdb..#ImExDailyScan') IS NOT NULL DROP TABLE #ImExDailyScan;
SELECT
    c.Product,
    CONVERT(date, m.EffDate) AS MoveDate,
    SUM(
        CASE
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'3' THEN COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'1', N'2', N'3', N'4', N'21', N'31', N'41', N'50')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'2' THEN COALESCE(d.Quantity, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'10', N'20', N'30', N'40', N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'6' THEN -COALESCE(d.QtyReceived, 0)
            WHEN CONVERT(nvarchar(20), m.DocumentType) IN (N'5', N'6', N'7', N'8', N'9', N'20', N'30', N'40', N'52')
             AND CONVERT(nvarchar(20), m.DocumentStatus) = N'5' THEN -COALESCE(d.QtyReceived, 0)
            ELSE 0
        END
    ) AS ImExNetQty
INTO #ImExDailyScan
FROM #Candidates c
JOIN dbo.tbl_OPSImExDetails d
  ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = c.Product
JOIN dbo.tbl_OPSImExMaster m
  ON m.Code = d.DocumentNo
WHERE m.EffDate IS NOT NULL
  AND m.EffDate < DATEADD(day, 1, @EndDate)
GROUP BY c.Product, CONVERT(date, m.EffDate);

IF OBJECT_ID('tempdb..#MovementScan') IS NOT NULL DROP TABLE #MovementScan;
SELECT Product, MoveDate, SUM(NetQty) AS NetQty
INTO #MovementScan
FROM
(
    SELECT Product, MoveDate, ImExNetQty AS NetQty FROM #ImExDailyScan
    UNION ALL
    SELECT Product, SaleDate AS MoveDate, -Qty AS NetQty FROM #SalesDaily
) x
GROUP BY Product, MoveDate;

IF OBJECT_ID('tempdb..#RunningStock') IS NOT NULL DROP TABLE #RunningStock;
SELECT
    Product, MoveDate, NetQty,
    SUM(NetQty) OVER (PARTITION BY Product ORDER BY MoveDate
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS CloseStock,
    SUM(NetQty) OVER (PARTITION BY Product ORDER BY MoveDate
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS OpenStock
INTO #RunningStock
FROM #MovementScan
WHERE MoveDate BETWEEN @StartDate AND @EndDate;

IF OBJECT_ID('tempdb..#StockoutScan') IS NOT NULL DROP TABLE #StockoutScan;
SELECT
    r.Product,
    COUNT(*) AS StockoutSignalDays
INTO #StockoutScan
FROM #RunningStock r
WHERE COALESCE(r.OpenStock, 0) <= 0
  AND COALESCE(r.CloseStock, 0) > 0; -- hết hàng rồi có nhập lại trong cùng ngày

-- Ghi chú StockoutScan: bảng này KHÔNG cross join lịch đầy đủ (giữ chi phí
-- thấp trên nhiều SKU) nên KHÔNG đếm được kiểu "trống cả ngày, không nhập
-- không bán" (ngày đó không sinh dòng movement nào để SUM() OVER thấy) và
-- KHÔNG có receiptHour để so giờ cắt — đây chỉ là tín hiệu "hết hàng rồi có
-- nhập bù trong ngày", dùng để XẾP HẠNG TƯƠNG ĐỐI giữa các SKU khi chọn mẫu,
-- không thay cho số liệu Chặng 2 thật (đọc đúng từ demand-planing.sql).

/* 5. Promo coverage (đếm ngày có PromoCode thật từ tbl_POLPromotion/Bundle,
      cùng điều kiện match với demand-planing.sql). */
IF OBJECT_ID('tempdb..#PromoScan') IS NOT NULL DROP TABLE #PromoScan;
SELECT
    s.Product,
    COUNT(DISTINCT CASE WHEN pm.PromoCode IS NOT NULL THEN s.SaleDate END) AS PromoDays,
    COUNT(DISTINCT s.SaleDate) AS SaleDays
INTO #PromoScan
FROM #SalesDaily s
OUTER APPLY
(
    SELECT TOP 1 pr.Code AS PromoCode
    FROM dbo.tbl_POLBundle b
    JOIN dbo.tbl_POLPromotion pr ON pr.Code = b.Promotion
    WHERE (LTRIM(RTRIM(CONVERT(nvarchar(100), b.Product))) = s.Product
        OR LTRIM(RTRIM(CONVERT(nvarchar(100), b.RefProduct))) = s.Product)
      AND pr.StartDate IS NOT NULL AND pr.EndDate IS NOT NULL
      AND s.SaleDate BETWEEN CONVERT(date, pr.StartDate) AND CONVERT(date, pr.EndDate)
      AND (pr.IsPOS IS NULL OR CONVERT(nvarchar(20), pr.IsPOS) IN (N'1', N'True', N'true'))
) pm
GROUP BY s.Product;

/* 6. ABC tạm tính: giá trị = tổng SL 24 chu kỳ gần nhất × giá bình quân dòng
      sạch — chỉ để xếp thứ tự tương đối khi chọn mẫu, KHÔNG thay Chặng 6 thật. */
IF OBJECT_ID('tempdb..#PriceScan') IS NOT NULL DROP TABLE #PriceScan;
SELECT c.Product, AVG(d.Amount * 1.0 / NULLIF(d.Qty, 0)) AS Price
INTO #PriceScan
FROM #Candidates c
JOIN dbo.tbl_SALPoSDetails d ON LTRIM(RTRIM(CONVERT(nvarchar(100), d.Product))) = c.Product
JOIN dbo.tbl_SALPoSMaster m ON m.Code = d.PoSMaster
WHERE d.RePosDetails IS NULL AND COALESCE(d.Discount, 0) = 0 AND d.Qty > 0
  AND m.TransactionDate < @RunDate
GROUP BY c.Product;

/* 7. Kết quả: mỗi dòng = 1 SKU ứng viên, đủ thông tin để chọn mẫu phủ trường hợp. */
SELECT
    c.Product AS SKU,
    sh.TotalCycles,
    sh.PositiveCyclesInTail,
    sh.Adi,
    sh.Cv2,
    CASE
        WHEN sh.PositiveCyclesInTail IS NULL OR sh.PositiveCyclesInTail = 0 OR sh.TotalCycles < 6 THEN 'D'
        WHEN sh.Adi > 1.32 THEN 'Z'
        WHEN COALESCE(sh.Cv2, 999) <= 0.49 THEN 'X'
        ELSE 'Y'
    END AS Shape,
    price.Price,
    CAST(COALESCE(sh.PositiveMean, 0) * 24 * COALESCE(price.Price, 0) AS decimal(18, 0)) AS AnnualValueHint,
    COALESCE(so.StockoutSignalDays, 0) AS StockoutSignalDays,
    CAST(COALESCE(so.StockoutSignalDays, 0) * 100.0 / NULLIF(@FullCycleCount * @CycleLength, 0) AS decimal(5, 1)) AS StockoutSignalDayPct,
    COALESCE(pr.PromoDays, 0) AS PromoDays,
    CAST(COALESCE(pr.PromoDays, 0) * 100.0 / NULLIF(pr.SaleDays, 0) AS decimal(5, 1)) AS PromoDayPctOfSaleDays,
    COALESCE(pr.SaleDays, 0) AS SaleDays,
    @FullCycleCount * @CycleLength AS HistoryDaysScanned
FROM #Candidates c
LEFT JOIN #Shape sh ON sh.Product = c.Product
LEFT JOIN #PriceScan price ON price.Product = c.Product
LEFT JOIN #StockoutScan so ON so.Product = c.Product
LEFT JOIN #PromoScan pr ON pr.Product = c.Product
ORDER BY Shape, AnnualValueHint DESC;
