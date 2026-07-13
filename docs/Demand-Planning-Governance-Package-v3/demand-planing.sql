USE [POS];
SET NOCOUNT ON;
SET XACT_ABORT ON;

/* ============================================================================
   demand-planing-v6-pos-real-backtest.sql

   MỤC TIÊU
   - Chỉ đọc dữ liệu đã tồn tại trong POS; không INSERT/UPDATE/DELETE bảng thật.
   - Không tạo lịch ngày liên tục và không bịa record Sales = 0.
   - Lấy khung lịch sử Chặng 1 + dữ liệu hậu kiểm từ RunDate đến RunDate + 14.
   - Phân loại đúng bán, trả, nhập và xuất theo mapping đã đối soát với
     dbo.sp_StockCurrent.
   - Tái tính tồn từ toàn bộ phát sinh và chỉ cho phép xuất khi tồn cuối khớp
     dbo.tbl_LSProduct.Quantity.

   OUTPUT
   1. DailySourceRecord  : dòng thưa, chỉ ngày có nguồn thật.
   2. PromotionInterval : CTKM gắn trực tiếp với SKU.
   3. ExtractMetadata   : phạm vi, watermark, gate và giả định.
   4. Diagnostics       : chỉ xuất khi @ShowDiagnostics = 1.

   QUY TẮC NULL/0
   - Sales = NULL, HasSalesRecord = 0: không có dòng bán POS thật trong ngày.
   - Sales = 0,    HasSalesRecord = 1: có dòng bán thật và tổng Qty bằng 0.
   - SQL không biến trường hợp thứ nhất thành trường hợp thứ hai.

   LƯU Ý DATABASE
   - File này dùng USE [POS] theo yêu cầu triển khai hiện tại.
   - Chỉ được nghiệm thu khi mapping của POS cho kết quả đối soát tồn PASS.
   - Nếu dbo.sp_StockCurrent thực tế chạy ở [3PPOS], không được trộn dữ liệu giữa
     hai database; hãy đổi USE sang đúng database và chạy lại diagnostics.
   ============================================================================ */

/* ============================== 0. THAM SỐ ================================ */
DECLARE @ManualRunDate date = '2026-06-01';
-- NULL: tự chọn RunDate = watermark chung của DB - 14 ngày.
-- Giá trị cụ thể phải trùng DEFAULT_POLICY.runDate của ứng dụng.

DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @PostRunDays int = 14;              -- RunDate..RunDate+14: 15 ngày tính cả RunDate.
DECLARE @ReferenceDaysBefore int = 24;      -- Khớp maxReferenceRadius hiện tại.
DECLARE @StoreCode nvarchar(100) = N'GLOBAL_POS';
DECLARE @FailOnStockMismatch bit = 1;
DECLARE @RequireFullPostRunWindow bit = 1;
DECLARE @RejectFutureSourceDate bit = 1;
DECLARE @ShowDiagnostics bit = 1;
DECLARE @OutputMode nvarchar(20) = N'ROWS'; -- Chỉ ROWS. JSON payload tạo ở converter để tránh phụ thuộc FOR JSON.
DECLARE @Tolerance decimal(38,6) = 0.000001;

DECLARE @QueryVersion nvarchar(100) = N'demand-planing-v6-pos-real-backtest';
DECLARE @DataContractVersion nvarchar(30) = N'DAILY-SOURCE-V2';
DECLARE @ExtractId uniqueidentifier = NEWID();

DECLARE @DatabaseWatermarkDate date;
DECLARE @SelectedDataEndDate date;
DECLARE @RunDate date;
DECLARE @HistoryCandidateStartDate date;
DECLARE @ProcessingStartDate date;
DECLARE @ProcessingEndDate date;
DECLARE @ReferenceReadStartDate date;
DECLARE @ActualValidationEndDate date;
DECLARE @TotalCandidateDays int;
DECLARE @FullCycleCount int;
DECLARE @FullCycleDays int;
DECLARE @DroppedLeadingDays int;

IF @HistoryYears < 1
   OR @CycleLength < 1
   OR @PostRunDays < 0
   OR @ReferenceDaysBefore < 0
BEGIN
    RAISERROR(N'Tham số lịch sử/chu kỳ không hợp lệ.',16,1);
    RETURN;
END;

IF UPPER(@OutputMode)<>N'ROWS'
BEGIN
    RAISERROR(N'@OutputMode hiện chỉ nhận ROWS. Hãy xuất 3 result set và dùng converter tạo JSON versioned.',16,1);
    RETURN;
END;

/* ============================== 1. DANH SÁCH SKU =========================== */
IF OBJECT_ID('tempdb..#InputBarcode') IS NOT NULL DROP TABLE #InputBarcode;
CREATE TABLE #InputBarcode
(
    Barcode nvarchar(100) NOT NULL PRIMARY KEY
);

INSERT INTO #InputBarcode(Barcode)
VALUES
(N'4932313033092'),(N'4965078102116'),(N'4987645005453'),
(N'4987645005989'),(N'4901001194186'),(N'4903024904957'),
(N'4955209080352'),(N'4955209080338'),(N'4955209080345'),
(N'4573475402137'),(N'4534374394596'),(N'4971710573664'),
(N'4901065606939'),(N'4973221032487'),(N'4905489647905'),
(N'8997240600041'),(N'4582517330024'),(N'8936013251042'),
(N'4976416007932'),(N'4902102019187'),(N'4902871053900'),
(N'4908609116909'),(N'8936013251097'),(N'4550516493583'),
(N'4905687446263'),(N'4968583245477'),(N'4526112647644'),
(N'4582695026467'),(N'4982790187924'),(N'4535792442340'),
(N'4978929915261'),(N'4941336729073'),(N'4901548603844'),
(N'4905596183068'),(N'4976790247870'),(N'4901616010413'),
(N'4982790412309'),(N'4901111910973'),(N'4970285280038'),
(N'4546490702476'),(N'4562370392322'),(N'4560127703445');

IF OBJECT_ID('tempdb..#BarcodeMap') IS NOT NULL DROP TABLE #BarcodeMap;
CREATE TABLE #BarcodeMap
(
    Barcode nvarchar(100) NOT NULL,
    Product nvarchar(100) NOT NULL,
    CurrentQuantity decimal(38,6) NULL
);

INSERT INTO #BarcodeMap(Barcode,Product,CurrentQuantity)
SELECT
    i.Barcode,
    LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code))) AS Product,
    CONVERT(decimal(38,6),p.Quantity) AS CurrentQuantity
FROM #InputBarcode i
JOIN dbo.tbl_LSProduct p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),p.Barcode)))=i.Barcode;

IF EXISTS
(
    SELECT 1
    FROM #InputBarcode i
    LEFT JOIN #BarcodeMap m ON m.Barcode=i.Barcode
    WHERE m.Product IS NULL
)
BEGIN
    SELECT i.Barcode AS UnmappedBarcode
    FROM #InputBarcode i
    LEFT JOIN #BarcodeMap m ON m.Barcode=i.Barcode
    WHERE m.Product IS NULL
    ORDER BY i.Barcode;

    RAISERROR(N'Có barcode không tồn tại trong dbo.tbl_LSProduct. Dừng trích xuất.',16,1);
    RETURN;
END;

IF EXISTS
(
    SELECT Barcode
    FROM #BarcodeMap
    GROUP BY Barcode
    HAVING COUNT(DISTINCT Product)<>1
)
BEGIN
    SELECT Barcode,Product,CurrentQuantity
    FROM #BarcodeMap
    WHERE Barcode IN
    (
        SELECT Barcode
        FROM #BarcodeMap
        GROUP BY Barcode
        HAVING COUNT(DISTINCT Product)<>1
    )
    ORDER BY Barcode,Product;

    RAISERROR(N'Có barcode map nhiều Product. Không được tự chọn một SKU.',16,1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#Products') IS NOT NULL DROP TABLE #Products;
CREATE TABLE #Products
(
    Product nvarchar(100) NOT NULL PRIMARY KEY,
    Barcode nvarchar(100) NOT NULL,
    CurrentQuantity decimal(38,6) NULL
);

INSERT INTO #Products(Product,Barcode,CurrentQuantity)
SELECT Product,MAX(Barcode),MAX(CurrentQuantity)
FROM #BarcodeMap
GROUP BY Product;

/* ============================== 2. WATERMARK NGUỒN =========================
   DatabaseWatermarkDate dùng để kiểm tra DB đã đi qua RunDate+14 hay chưa.
   SelectedDataEndDate dùng để tái tính tồn của đúng các SKU đã chọn.
   Watermark chung KHÔNG tạo thêm dòng cho SKU.
   ============================================================================ */
SELECT @DatabaseWatermarkDate=MAX(SourceDate)
FROM
(
    SELECT MAX(CONVERT(date,m.TransactionDate)) AS SourceDate
    FROM dbo.tbl_SALPoSMaster m
    WHERE m.TransactionDate IS NOT NULL
      AND
      (
           m.TransactionType=2
        OR m.TransactionType=3
      )

    UNION ALL

    SELECT MAX(CONVERT(date,m.EffDate))
    FROM dbo.tbl_OPSImExMaster m
    WHERE m.EffDate IS NOT NULL
      AND
      (
           (m.DocumentType IN (1,2,3,4,21,31,41,50) AND m.DocumentStatus IN (2,3))
        OR (m.DocumentType IN (5,6,7,8,9,10,20,30,40,52) AND m.DocumentStatus=6)
        OR (m.DocumentType IN (5,6,7,8,9,20,30,40,52) AND m.DocumentStatus=5)
      )
) w;

SELECT @SelectedDataEndDate=MAX(SourceDate)
FROM
(
    SELECT MAX(CONVERT(date,m.TransactionDate)) AS SourceDate
    FROM dbo.tbl_SALPoSDetails d
    JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.TransactionDate IS NOT NULL
      AND
      (
           (m.TransactionType=2 AND d.RePosDetails IS NULL)
        OR m.TransactionType=3
        OR (m.TransactionType=2 AND d.RePosDetails IS NOT NULL)
      )

    UNION ALL

    SELECT MAX(CONVERT(date,m.EffDate))
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.EffDate IS NOT NULL
      AND
      (
           (m.DocumentType IN (1,2,3,4,21,31,41,50) AND m.DocumentStatus IN (2,3))
        OR (m.DocumentType IN (5,6,7,8,9,10,20,30,40,52) AND m.DocumentStatus=6)
        OR (m.DocumentType IN (5,6,7,8,9,20,30,40,52) AND m.DocumentStatus=5)
      )
) s;

IF @DatabaseWatermarkDate IS NULL
BEGIN
    RAISERROR(N'Không xác định được watermark dữ liệu của POS.',16,1);
    RETURN;
END;

IF @SelectedDataEndDate IS NULL
BEGIN
    RAISERROR(N'Không có phát sinh nguồn hợp lệ cho danh sách SKU đã chọn.',16,1);
    RETURN;
END;

IF @RejectFutureSourceDate=1
   AND @DatabaseWatermarkDate>CONVERT(date,GETDATE())
BEGIN
    SELECT @DatabaseWatermarkDate AS FutureDatabaseWatermarkDate,
           CONVERT(date,GETDATE()) AS ServerCurrentDate;
    RAISERROR(N'Nguồn có ngày tương lai. Dừng để tránh lấy watermark sai.',16,1);
    RETURN;
END;

/* ============================== 3. KHUNG LỊCH SỬ + 14 NGÀY ================ */
SET @RunDate=COALESCE(@ManualRunDate,DATEADD(day,-@PostRunDays,@DatabaseWatermarkDate));
SET @ProcessingEndDate=DATEADD(day,-1,@RunDate);
SET @ActualValidationEndDate=DATEADD(day,@PostRunDays,@RunDate);
SET @HistoryCandidateStartDate=CONVERT
(
    date,
    CONVERT(char(4),YEAR(@RunDate)-@HistoryYears)+'0101',
    112
);

SET @TotalCandidateDays=DATEDIFF(day,@HistoryCandidateStartDate,@ProcessingEndDate)+1;
SET @FullCycleCount=@TotalCandidateDays/@CycleLength;
SET @FullCycleDays=@FullCycleCount*@CycleLength;
SET @DroppedLeadingDays=@TotalCandidateDays-@FullCycleDays;
SET @ProcessingStartDate=DATEADD(day,-@FullCycleDays+1,@ProcessingEndDate);
SET @ReferenceReadStartDate=DATEADD(day,-@ReferenceDaysBefore,@ProcessingStartDate);

IF @FullCycleCount<1 OR @ProcessingStartDate>@ProcessingEndDate
BEGIN
    RAISERROR(N'Khung lịch sử không tạo được ít nhất một chu kỳ đầy đủ.',16,1);
    RETURN;
END;

IF @RequireFullPostRunWindow=1
   AND @ActualValidationEndDate>@DatabaseWatermarkDate
BEGIN
    SELECT
        @RunDate AS RequestedRunDate,
        @ActualValidationEndDate AS RequiredActualValidationEndDate,
        @DatabaseWatermarkDate AS AvailableDatabaseWatermarkDate,
        DATEDIFF(day,@DatabaseWatermarkDate,@ActualValidationEndDate) AS MissingCalendarDays;

    RAISERROR(N'DB chưa đi qua RunDate + 14. Không tạo record thay thế.',16,1);
    RETURN;
END;

/* ============================== 4. POS BÁN / TRẢ ============================
   Mapping đối soát:
   - Bán: TransactionType=2 AND RePosDetails IS NULL.
   - Trả: TransactionType=3 OR
          (TransactionType=2 AND RePosDetails IS NOT NULL).
   ============================================================================ */
IF OBJECT_ID('tempdb..#PosDaily') IS NOT NULL DROP TABLE #PosDaily;

SELECT
    p.Product,
    CONVERT(date,m.TransactionDate) AS [Date],
    SUM(CASE
        WHEN m.TransactionType=2 AND d.RePosDetails IS NULL
        THEN CONVERT(decimal(38,6),COALESCE(d.Qty,0))
        ELSE CONVERT(decimal(38,6),0)
    END) AS SalesQty,
    SUM(CASE
        WHEN m.TransactionType=3
          OR (m.TransactionType=2 AND d.RePosDetails IS NOT NULL)
        THEN CONVERT(decimal(38,6),COALESCE(d.Qty,0))
        ELSE CONVERT(decimal(38,6),0)
    END) AS ReturnQty,
    SUM(CASE
        WHEN m.TransactionType=2 AND d.RePosDetails IS NULL THEN 1 ELSE 0
    END) AS SaleLineCount,
    SUM(CASE
        WHEN m.TransactionType=3
          OR (m.TransactionType=2 AND d.RePosDetails IS NOT NULL)
        THEN 1 ELSE 0
    END) AS ReturnLineCount,
    COUNT_BIG(*) AS RelevantPosLineCount
INTO #PosDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
JOIN #Products p
  ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate<DATEADD(day,1,@SelectedDataEndDate)
  AND
  (
       (m.TransactionType=2 AND d.RePosDetails IS NULL)
    OR m.TransactionType=3
    OR (m.TransactionType=2 AND d.RePosDetails IS NOT NULL)
  )
GROUP BY p.Product,CONVERT(date,m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_PosDaily ON #PosDaily(Product,[Date]);

/* ============================== 5. NHẬP / XUẤT KHO ==========================
   Mapping theo dbo.sp_StockCurrent đã đối soát:

   Nhập:
   - type 1,2,3,4,21,31,41,50 + status 3: +QtyReceived
   - type 1,2,3,4,21,31,41,50 + status 2: +Quantity

   Xuất:
   - type 5,6,7,8,9,10,20,30,40,52 + status 6: -QtyReceived
   - type 5,6,7,8,9,20,30,40,52    + status 5: -QtyReceived

   Lưu ý: type 10/status 5 KHÔNG thuộc nhánh xuất.
   ============================================================================ */
IF OBJECT_ID('tempdb..#ImExDaily') IS NOT NULL DROP TABLE #ImExDaily;

SELECT
    p.Product,
    CONVERT(date,m.EffDate) AS [Date],
    SUM(CASE
        WHEN m.DocumentType IN (1,2,3,4,21,31,41,50)
         AND m.DocumentStatus=3
            THEN CONVERT(decimal(38,6),COALESCE(d.QtyReceived,0))

        WHEN m.DocumentType IN (1,2,3,4,21,31,41,50)
         AND m.DocumentStatus=2
            THEN CONVERT(decimal(38,6),COALESCE(d.Quantity,0))

        WHEN m.DocumentType IN (5,6,7,8,9,10,20,30,40,52)
         AND m.DocumentStatus=6
            THEN -CONVERT(decimal(38,6),COALESCE(d.QtyReceived,0))

        WHEN m.DocumentType IN (5,6,7,8,9,20,30,40,52)
         AND m.DocumentStatus=5
            THEN -CONVERT(decimal(38,6),COALESCE(d.QtyReceived,0))

        ELSE CONVERT(decimal(38,6),0)
    END) AS ImExNetQty,
    COUNT_BIG(*) AS RelevantImExLineCount
INTO #ImExDaily
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
JOIN #Products p
  ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE m.EffDate IS NOT NULL
  AND m.EffDate<DATEADD(day,1,@SelectedDataEndDate)
  AND
  (
       (m.DocumentType IN (1,2,3,4,21,31,41,50) AND m.DocumentStatus IN (2,3))
    OR (m.DocumentType IN (5,6,7,8,9,10,20,30,40,52) AND m.DocumentStatus=6)
    OR (m.DocumentType IN (5,6,7,8,9,20,30,40,52) AND m.DocumentStatus=5)
  )
GROUP BY p.Product,CONVERT(date,m.EffDate);

CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily ON #ImExDaily(Product,[Date]);

/* ============================== 6. BIẾN ĐỘNG TỒN THEO NGÀY ================
   InventoryNetMovement = chỉ nhập/xuất kho.
   TotalStockDelta       = InventoryNetMovement + ReturnQty - SalesQty.
   ============================================================================ */
IF OBJECT_ID('tempdb..#MovementDaily') IS NOT NULL DROP TABLE #MovementDaily;

SELECT
    x.Product,
    x.[Date],
    SUM(x.ImExNetQty) AS ImExNetQty,
    SUM(x.SalesQty) AS SalesQty,
    SUM(x.ReturnQty) AS ReturnQty,
    SUM(x.ImExNetQty+x.ReturnQty-x.SalesQty) AS TotalStockDelta,
    MAX(x.HasSalesRecord) AS HasSalesRecord,
    MAX(x.HasReturnRecord) AS HasReturnRecord,
    MAX(x.HasInventoryMovement) AS HasInventoryMovement,
    MAX(x.HasPosRecord) AS HasPosRecord
INTO #MovementDaily
FROM
(
    SELECT
        Product,[Date],
        ImExNetQty,
        CONVERT(decimal(38,6),0) AS SalesQty,
        CONVERT(decimal(38,6),0) AS ReturnQty,
        CONVERT(bit,0) AS HasSalesRecord,
        CONVERT(bit,0) AS HasReturnRecord,
        CONVERT(bit,1) AS HasInventoryMovement,
        CONVERT(bit,0) AS HasPosRecord
    FROM #ImExDaily

    UNION ALL

    SELECT
        Product,[Date],
        CONVERT(decimal(38,6),0) AS ImExNetQty,
        SalesQty,
        ReturnQty,
        CONVERT(bit,CASE WHEN SaleLineCount>0 THEN 1 ELSE 0 END),
        CONVERT(bit,CASE WHEN ReturnLineCount>0 THEN 1 ELSE 0 END),
        CONVERT(bit,0),
        CONVERT(bit,1)
    FROM #PosDaily
) x
GROUP BY x.Product,x.[Date];

CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily ON #MovementDaily(Product,[Date]);

/* ============================== 7. TỒN ĐẦU / CUỐI ===========================
   Mốc 0 chỉ được chấp nhận khi tồn tái tính cuối cùng khớp Quantity hiện tại.
   Nếu lịch sử bị purge hoặc mapping sai, gate sẽ FAIL và mặc định dừng.
   ============================================================================ */
IF OBJECT_ID('tempdb..#RunningStock') IS NOT NULL DROP TABLE #RunningStock;

SELECT
    md.Product,
    md.[Date],
    md.ImExNetQty,
    md.SalesQty,
    md.ReturnQty,
    md.TotalStockDelta,
    md.HasSalesRecord,
    md.HasReturnRecord,
    md.HasInventoryMovement,
    md.HasPosRecord,
    COALESCE
    (
        SUM(md.TotalStockDelta) OVER
        (
            PARTITION BY md.Product
            ORDER BY md.[Date]
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),
        CONVERT(decimal(38,6),0)
    ) AS OpenStockCalc,
    SUM(md.TotalStockDelta) OVER
    (
        PARTITION BY md.Product
        ORDER BY md.[Date]
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS CloseStockCalc
INTO #RunningStock
FROM #MovementDaily md;

CREATE UNIQUE CLUSTERED INDEX IX_RunningStock ON #RunningStock(Product,[Date]);

IF OBJECT_ID('tempdb..#StockReconciliation') IS NOT NULL DROP TABLE #StockReconciliation;

SELECT
    p.Product,
    p.Barcode,
    p.CurrentQuantity,
    COALESCE(lastStock.CloseStockCalc,CONVERT(decimal(38,6),0)) AS RecalculatedCurrentQuantity,
    p.CurrentQuantity-COALESCE(lastStock.CloseStockCalc,CONVERT(decimal(38,6),0)) AS Difference,
    CASE
        WHEN p.CurrentQuantity IS NULL THEN N'CURRENT_QUANTITY_MISSING'
        WHEN ABS(p.CurrentQuantity-COALESCE(lastStock.CloseStockCalc,0))<=@Tolerance
            THEN N'MATCH'
        ELSE N'ANCHOR_OR_MAPPING_MISMATCH'
    END AS ReconciliationStatus
INTO #StockReconciliation
FROM #Products p
OUTER APPLY
(
    SELECT TOP 1 rs.CloseStockCalc
    FROM #RunningStock rs
    WHERE rs.Product=p.Product
    ORDER BY rs.[Date] DESC
) lastStock;

CREATE UNIQUE CLUSTERED INDEX IX_StockReconciliation ON #StockReconciliation(Product);

IF @FailOnStockMismatch=1
   AND EXISTS
   (
       SELECT 1
       FROM #StockReconciliation
       WHERE ReconciliationStatus<>N'MATCH'
   )
BEGIN
    SELECT
        Product,Barcode,CurrentQuantity,RecalculatedCurrentQuantity,
        Difference,ReconciliationStatus
    FROM #StockReconciliation
    ORDER BY ABS(Difference) DESC,Product;

    RAISERROR(N'Tồn tái tính không khớp tồn hiện tại. Không xuất dữ liệu vào mô phỏng.',16,1);
    RETURN;
END;

/* ============================== 8. PHIẾU NHẬP LOẠI 1 =======================
   HasReceiptRecord vẫn true khi phiếu tồn tại nhưng không xác định được giờ.
   Chỉ tính phiếu có lượng nhập dương theo status 2/3.
   ============================================================================ */
IF OBJECT_ID('tempdb..#ReceiptDaily') IS NOT NULL DROP TABLE #ReceiptDaily;

;WITH ReceiptSource AS
(
    SELECT
        p.Product,
        CONVERT(date,m.EffDate) AS [Date],
        CASE
            WHEN m.ReceiptDate IS NOT NULL
             AND CONVERT(date,m.ReceiptDate)=CONVERT(date,m.EffDate)
             AND CONVERT(time,m.ReceiptDate)<>'00:00:00'
                THEN CONVERT(datetime,m.ReceiptDate)
            ELSE NULL
        END AS ReceiptDateTime,
        CASE
            WHEN m.CreateTime IS NOT NULL
             AND CONVERT(date,m.CreateTime)=CONVERT(date,m.EffDate)
             AND CONVERT(time,m.CreateTime)<>'00:00:00'
                THEN CONVERT(datetime,m.CreateTime)
            ELSE NULL
        END AS CreateDateTime
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.DocumentType=1
      AND m.DocumentStatus IN (2,3)
      AND m.EffDate IS NOT NULL
      AND m.EffDate<DATEADD(day,1,@ActualValidationEndDate)
      AND
      (
           (m.DocumentStatus=3 AND COALESCE(d.QtyReceived,0)>0)
        OR (m.DocumentStatus=2 AND COALESCE(d.Quantity,0)>0)
      )
)
SELECT
    Product,
    [Date],
    COUNT_BIG(*) AS ReceiptRecordCount,
    MIN(ReceiptDateTime) AS FirstReceiptDateTime,
    MIN(CreateDateTime) AS FirstCreateDateTime
INTO #ReceiptDaily
FROM ReceiptSource
GROUP BY Product,[Date];

CREATE UNIQUE CLUSTERED INDEX IX_ReceiptDaily ON #ReceiptDaily(Product,[Date]);

/* ============================== 9. GIÁ THƯỜNG GẦN NHẤT =====================
   Giá chỉ là giá suy ra từ Amount/Qty của dòng bán không có marker giảm giá.
   Chưa được gọi là giá niêm yết nếu nghiệp vụ chưa xác nhận Amount là giá thường.
   ============================================================================ */
IF OBJECT_ID('tempdb..#RegularPriceDaily') IS NOT NULL DROP TABLE #RegularPriceDaily;
IF OBJECT_ID('tempdb..#ProductPrice') IS NOT NULL DROP TABLE #ProductPrice;

SELECT
    p.Product,
    CONVERT(date,m.TransactionDate) AS [Date],
    SUM(CONVERT(decimal(38,6),d.Amount))
        / NULLIF(SUM(CONVERT(decimal(38,6),d.Qty)),0) AS UnitPrice
INTO #RegularPriceDaily
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
JOIN #Products p
  ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE m.TransactionType=2
  AND d.RePosDetails IS NULL
  AND d.Qty>0
  AND d.Amount>0
  AND COALESCE(d.Discount,0)=0
  AND
  (
      d.DiscountCouponInv IS NULL
      OR LTRIM(RTRIM(CONVERT(nvarchar(100),d.DiscountCouponInv))) IN (N'',N'0')
  )
  AND
  (
      d.DiscountGroupProduct IS NULL
      OR LTRIM(RTRIM(CONVERT(nvarchar(100),d.DiscountGroupProduct))) IN (N'',N'0')
  )
  AND m.TransactionDate<@RunDate
GROUP BY p.Product,CONVERT(date,m.TransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_RegularPriceDaily ON #RegularPriceDaily(Product,[Date]);

SELECT
    p.Product,
    priceRow.UnitPrice AS Price,
    priceRow.[Date] AS PriceObservedDate
INTO #ProductPrice
FROM #Products p
OUTER APPLY
(
    SELECT TOP 1 rpd.UnitPrice,rpd.[Date]
    FROM #RegularPriceDaily rpd
    WHERE rpd.Product=p.Product
    ORDER BY rpd.[Date] DESC
) priceRow;

CREATE UNIQUE CLUSTERED INDEX IX_ProductPrice ON #ProductPrice(Product);

/* ============================== 10. TÊN SẢN PHẨM =========================== */
IF OBJECT_ID('tempdb..#ProductName') IS NOT NULL DROP TABLE #ProductName;
CREATE TABLE #ProductName
(
    Product nvarchar(100) NOT NULL PRIMARY KEY,
    ProductName nvarchar(500) NULL
);

DECLARE @NameColumn sysname=NULL;
DECLARE @NameSql nvarchar(max);

SELECT TOP 1 @NameColumn=COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA='dbo'
  AND TABLE_NAME='tbl_LSProduct'
  AND COLUMN_NAME IN
  (
      'ProductName','Name','ProductNameVN','FullName','ShortName',
      'Description','Title','ProductNameVi','ProductFullName','NameVN',
      'TenSanPham','TenSP','TenHang'
  )
ORDER BY CASE COLUMN_NAME WHEN 'ProductName' THEN 1 WHEN 'Name' THEN 2 ELSE 99 END;

IF @NameColumn IS NULL
BEGIN
    SELECT TOP 1 @NameColumn=COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo'
      AND TABLE_NAME='tbl_LSProduct'
      AND (COLUMN_NAME LIKE '%Name%' OR COLUMN_NAME LIKE '%Ten%')
      AND DATA_TYPE IN ('nvarchar','varchar','nchar','char','ntext','text')
    ORDER BY LEN(COLUMN_NAME),COLUMN_NAME;
END;

IF @NameColumn IS NOT NULL
BEGIN
    SET @NameSql=N'
        INSERT INTO #ProductName(Product,ProductName)
        SELECT
            p.Product,
            MAX(CONVERT(nvarchar(500),lp.'+QUOTENAME(@NameColumn)+N'))
        FROM #Products p
        JOIN dbo.tbl_LSProduct lp
          ON LTRIM(RTRIM(CONVERT(nvarchar(100),lp.Code)))=p.Product
        GROUP BY p.Product;';

    EXEC sp_executesql @NameSql;
END
ELSE
BEGIN
    INSERT INTO #ProductName(Product,ProductName)
    SELECT Product,NULL
    FROM #Products;
END;

/* ============================== 11. KHOẢNG CTKM ============================
   Chỉ dùng quan hệ trực tiếp tbl_POLBundle.Product = SKU.
   Không dùng RefProduct vì chưa có bằng chứng đây là SKU được hưởng CTKM.
   ============================================================================ */
IF OBJECT_ID('tempdb..#PromoIntervals') IS NOT NULL DROP TABLE #PromoIntervals;

SELECT DISTINCT
    p.Product,
    CONVERT(nvarchar(200),pr.Code) AS PromoCode,
    COALESCE
    (
        NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500),pr.Promotion))),N''),
        CONVERT(nvarchar(200),pr.Code)
    ) AS PromoName,
    CONVERT(date,pr.StartDate) AS StartDate,
    CONVERT(date,pr.EndDate) AS EndDate,
    CONVERT(nvarchar(100),pr.PromotionType) AS PromoTypeSource,
    pr.IsPOS,
    N'DIRECT_PRODUCT' AS SourceRole
INTO #PromoIntervals
FROM #Products p
JOIN dbo.tbl_POLBundle b
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),b.Product)))=p.Product
JOIN dbo.tbl_POLPromotion pr ON pr.Code=b.Promotion
WHERE pr.StartDate IS NOT NULL
  AND pr.EndDate IS NOT NULL
  AND CONVERT(date,pr.EndDate)>=@ReferenceReadStartDate
  AND CONVERT(date,pr.StartDate)<=@ActualValidationEndDate;

CREATE INDEX IX_PromoIntervals ON #PromoIntervals(Product,StartDate,EndDate);

/* ============================== 12. KHÓA DÒNG XUẤT ==========================
   - Mọi ngày có phát sinh thật trong vùng tham chiếu/lịch sử/hậu kiểm.
   - Thêm đúng một dòng phát sinh thật gần nhất trước vùng đọc làm opening anchor.
   - Không tạo ngày mới.
   ============================================================================ */
IF OBJECT_ID('tempdb..#OutputKeys') IS NOT NULL DROP TABLE #OutputKeys;
CREATE TABLE #OutputKeys
(
    Product nvarchar(100) NOT NULL,
    [Date] date NOT NULL,
    IsOpeningAnchor bit NOT NULL,
    PRIMARY KEY(Product,[Date])
);

INSERT INTO #OutputKeys(Product,[Date],IsOpeningAnchor)
SELECT Product,[Date],CONVERT(bit,0)
FROM #RunningStock
WHERE [Date]>=@ReferenceReadStartDate
  AND [Date]<=@ActualValidationEndDate;

INSERT INTO #OutputKeys(Product,[Date],IsOpeningAnchor)
SELECT p.Product,anchorRow.[Date],CONVERT(bit,1)
FROM #Products p
CROSS APPLY
(
    SELECT TOP 1 rs.[Date]
    FROM #RunningStock rs
    WHERE rs.Product=p.Product
      AND rs.[Date]<@ReferenceReadStartDate
    ORDER BY rs.[Date] DESC
) anchorRow
WHERE NOT EXISTS
(
    SELECT 1
    FROM #OutputKeys k
    WHERE k.Product=p.Product
      AND k.[Date]=anchorRow.[Date]
);

/* ============================== 13. DAILY OUTPUT =========================== */
IF OBJECT_ID('tempdb..#DailyOutput') IS NOT NULL DROP TABLE #DailyOutput;

SELECT
    CONVERT(nvarchar(36),@ExtractId) AS ExtractId,
    @DataContractVersion AS DataContractVersion,
    @StoreCode AS StoreCode,
    rs.Product AS SKU,
    CONVERT(char(10),rs.[Date],23) AS [Date],

    CASE WHEN rs.HasSalesRecord=1 THEN rs.SalesQty ELSE NULL END AS Sales,
    CONVERT(bit,rs.HasSalesRecord) AS HasSalesRecord,

    CASE WHEN rs.HasReturnRecord=1 THEN rs.ReturnQty ELSE NULL END AS ReturnQty,
    CONVERT(bit,rs.HasReturnRecord) AS HasReturnRecord,

    CASE WHEN rs.HasInventoryMovement=1 THEN rs.ImExNetQty ELSE NULL END
        AS InventoryNetMovement,
    CONVERT(bit,rs.HasInventoryMovement) AS HasInventoryMovement,
    rs.TotalStockDelta,

    rs.OpenStockCalc AS OpenStock,
    rs.CloseStockCalc AS CloseStock,
    CASE
        WHEN rs.OpenStockCalc<0 OR rs.CloseStockCalc<0 THEN N'NEGATIVE_REVIEW'
        ELSE N'CALCULATED'
    END AS StockCalculationStatus,
    rec.ReconciliationStatus AS StockReconciliationStatus,

    CASE
        WHEN rd.FirstReceiptDateTime IS NOT NULL
            THEN CONVERT(char(5),rd.FirstReceiptDateTime,108)
        WHEN rd.FirstCreateDateTime IS NOT NULL
            THEN CONVERT(char(5),rd.FirstCreateDateTime,108)
        ELSE NULL
    END AS ReceiptHour,
    CONVERT(bit,CASE WHEN rd.Product IS NULL THEN 0 ELSE 1 END) AS HasReceiptRecord,
    CASE
        WHEN rd.FirstReceiptDateTime IS NOT NULL THEN N'RECEIPT_DATE'
        WHEN rd.FirstCreateDateTime IS NOT NULL THEN N'CREATE_TIME_FALLBACK'
        WHEN rd.Product IS NOT NULL THEN N'UNRESOLVED'
        ELSE NULL
    END AS ReceiptTimeSource,
    CASE
        WHEN rd.FirstReceiptDateTime IS NOT NULL THEN N'CONFIRMED_TIME'
        WHEN rd.FirstCreateDateTime IS NOT NULL THEN N'FALLBACK_TIME_REVIEW'
        WHEN rd.Product IS NOT NULL THEN N'RECORD_WITHOUT_TIME'
        ELSE NULL
    END AS ReceiptTimeQuality,

    promo.PromoCode,
    promo.PromoName,
    COALESCE(promoCount.PromoOverlapCount,0) AS PromoOverlapCount,

    pp.Price,
    CONVERT(char(10),pp.PriceObservedDate,23) AS PriceObservedDate,
    CASE WHEN pp.Price IS NULL THEN NULL ELSE N'LATEST_REGULAR_AMOUNT_DIV_QTY' END
        AS PriceSource,
    pn.ProductName,

    CONVERT(bit,1) AS HasRecord,
    k.IsOpeningAnchor,
    CONVERT(bit,CASE
        WHEN k.IsOpeningAnchor=0 AND rs.[Date]<@ProcessingStartDate THEN 1 ELSE 0 END)
        AS IsReferenceOnly,
    CONVERT(bit,CASE
        WHEN rs.[Date]>=@ProcessingStartDate AND rs.[Date]<=@ProcessingEndDate
            THEN 1 ELSE 0 END) AS IsHistoryRecord,
    CONVERT(bit,CASE
        WHEN rs.[Date]>=@RunDate AND rs.[Date]<=@ActualValidationEndDate
            THEN 1 ELSE 0 END) AS IsValidationActual
INTO #DailyOutput
FROM #OutputKeys k
JOIN #RunningStock rs
  ON rs.Product=k.Product AND rs.[Date]=k.[Date]
JOIN #StockReconciliation rec ON rec.Product=rs.Product
LEFT JOIN #ReceiptDaily rd
  ON rd.Product=rs.Product AND rd.[Date]=rs.[Date]
LEFT JOIN #ProductPrice pp ON pp.Product=rs.Product
LEFT JOIN #ProductName pn ON pn.Product=rs.Product
OUTER APPLY
(
    SELECT TOP 1 pi.PromoCode,pi.PromoName
    FROM #PromoIntervals pi
    WHERE pi.Product=rs.Product
      AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
    ORDER BY
        CASE WHEN pi.IsPOS=1 THEN 0 ELSE 1 END,
        pi.StartDate DESC,
        pi.PromoCode
) promo
OUTER APPLY
(
    SELECT COUNT(*) AS PromoOverlapCount
    FROM #PromoIntervals pi
    WHERE pi.Product=rs.Product
      AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
) promoCount;

CREATE UNIQUE CLUSTERED INDEX IX_DailyOutput ON #DailyOutput(SKU,[Date]);

/* ============================== RESULT SET 1 ===============================
   Không dùng FOR JSON tại SQL để tránh lỗi parse trên SQL Server/compatibility
   chưa hỗ trợ INCLUDE_NULL_VALUES. Converter sẽ nhận 3 result set/file riêng và
   tạo payload DAILY-SOURCE-V2, giữ nguyên NULL.
   ============================================================================ */
SELECT *
FROM #DailyOutput
ORDER BY SKU,[Date];

/* ============================== RESULT SET 2 =============================== */
SELECT
    CONVERT(nvarchar(36),@ExtractId) AS ExtractId,
    @StoreCode AS StoreCode,
    Product AS SKU,
    PromoCode,
    PromoName,
    CONVERT(char(10),StartDate,23) AS StartDate,
    CONVERT(char(10),EndDate,23) AS EndDate,
    PromoTypeSource,
    IsPOS,
    SourceRole
FROM #PromoIntervals
ORDER BY Product,StartDate,PromoCode;

/* ============================== RESULT SET 3 =============================== */
SELECT
    CONVERT(nvarchar(36),@ExtractId) AS ExtractId,
    @QueryVersion AS QueryVersion,
    @DataContractVersion AS DataContractVersion,
    DB_NAME() AS DatabaseName,
    N'HISTORICAL_VALIDATION' AS RunMode,
    CONVERT(char(10),@RunDate,23) AS RunDate,
    CONVERT(char(10),@HistoryCandidateStartDate,23) AS HistoryCandidateStartDate,
    CONVERT(char(10),@ProcessingStartDate,23) AS ProcessingStartDate,
    CONVERT(char(10),@ProcessingEndDate,23) AS ProcessingEndDate,
    CONVERT(char(10),@ReferenceReadStartDate,23) AS ReferenceReadStartDate,
    CONVERT(char(10),@ActualValidationEndDate,23) AS ActualValidationEndDate,
    CONVERT(char(10),@DatabaseWatermarkDate,23) AS DatabaseWatermarkDate,
    CONVERT(char(10),@SelectedDataEndDate,23) AS SelectedSkuLastSourceDate,
    @CycleLength AS CycleLengthDays,
    @FullCycleCount AS FullCycleCount,
    @DroppedLeadingDays AS DroppedLeadingDays,
    @PostRunDays AS AdditionalDaysAfterRunDate,
    @ReferenceDaysBefore AS ReferenceDaysBefore,
    @StoreCode AS StoreCode,
    N'GLOBAL_DATABASE_SCOPE_NOT_STORE_FILTER' AS StoreScopeStatus,
    (SELECT COUNT(*) FROM #Products) AS SelectedSkuCount,
    N'SELECTED_SKU_SIMULATION' AS PortfolioMode,
    CONVERT(bit,1) AS ExtractIsTruncated,
    N'ZERO_BASED_FULL_HISTORY_RECONCILED_WITH_tbl_LSProduct_Quantity'
        AS StockAnchorAssumption,
    CASE
        WHEN EXISTS
        (
            SELECT 1 FROM #StockReconciliation
            WHERE ReconciliationStatus<>N'MATCH'
        ) THEN N'FAIL'
        ELSE N'PASS'
    END AS StockReconciliationGate,
    (
        SELECT COUNT(*) FROM #StockReconciliation
        WHERE ReconciliationStatus<>N'MATCH'
    ) AS StockMismatchSkuCount,
    (SELECT COUNT(*) FROM #DailyOutput) AS DailySourceRecordCount,
    (SELECT COUNT(*) FROM #PromoIntervals) AS PromotionIntervalCount,
    GETDATE() AS GeneratedAt;

/* ============================== DIAGNOSTICS ================================ */
IF @ShowDiagnostics=1
BEGIN
    /* D1. Đối soát tồn. */
    SELECT
        Product,Barcode,CurrentQuantity,RecalculatedCurrentQuantity,
        Difference,ReconciliationStatus
    FROM #StockReconciliation
    ORDER BY
        CASE WHEN ReconciliationStatus=N'MATCH' THEN 1 ELSE 0 END,
        ABS(Difference) DESC,
        Product;

    /* D2. Phủ dữ liệu theo SKU; số ngày thưa không được hiểu thành số ngày bán 0. */
    SELECT
        p.Product,
        p.Barcode,
        MIN(rs.[Date]) AS FirstSourceDate,
        MAX(rs.[Date]) AS LastSourceDate,
        SUM(CASE WHEN rs.[Date]>=@ProcessingStartDate
                  AND rs.[Date]<=@ProcessingEndDate THEN 1 ELSE 0 END)
            AS HistorySourceDayCount,
        SUM(CASE WHEN rs.[Date]>=@RunDate
                  AND rs.[Date]<=@ActualValidationEndDate THEN 1 ELSE 0 END)
            AS ValidationSourceDayCount,
        SUM(CASE WHEN rs.[Date]>=@RunDate
                  AND rs.[Date]<=@ActualValidationEndDate
                  AND rs.HasSalesRecord=1 THEN 1 ELSE 0 END)
            AS ValidationSalesRecordDayCount,
        N'SPARSE_SOURCE_ROWS_NOT_ZERO_FILLED' AS CoverageMeaning
    FROM #Products p
    LEFT JOIN #RunningStock rs ON rs.Product=p.Product
    GROUP BY p.Product,p.Barcode
    ORDER BY p.Product;

    /* D3. Phân phối POS để xác minh mapping bán/trả. */
    SELECT
        m.TransactionType,
        CASE WHEN d.RePosDetails IS NULL THEN N'NULL' ELSE N'NOT_NULL' END
            AS RePosState,
        COUNT_BIG(*) AS LineCount,
        SUM(CONVERT(decimal(38,6),COALESCE(d.Qty,0))) AS Qty
    FROM dbo.tbl_SALPoSDetails d
    JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.TransactionDate IS NOT NULL
      AND m.TransactionDate<DATEADD(day,1,@SelectedDataEndDate)
    GROUP BY
        m.TransactionType,
        CASE WHEN d.RePosDetails IS NULL THEN N'NULL' ELSE N'NOT_NULL' END
    ORDER BY m.TransactionType,RePosState;

    /* D4. Phân phối loại/trạng thái nhập xuất. */
    SELECT
        m.DocumentType,
        m.DocumentStatus,
        COUNT_BIG(*) AS LineCount,
        SUM(CONVERT(decimal(38,6),COALESCE(d.Quantity,0))) AS Quantity,
        SUM(CONVERT(decimal(38,6),COALESCE(d.QtyReceived,0))) AS QtyReceived
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.EffDate IS NOT NULL
      AND m.EffDate<DATEADD(day,1,@SelectedDataEndDate)
    GROUP BY m.DocumentType,m.DocumentStatus
    ORDER BY m.DocumentType,m.DocumentStatus;

    /* D5. Chất lượng giờ nhập. */
    SELECT
        CASE
            WHEN FirstReceiptDateTime IS NOT NULL THEN N'RECEIPT_DATE'
            WHEN FirstCreateDateTime IS NOT NULL THEN N'CREATE_TIME_FALLBACK'
            ELSE N'UNRESOLVED'
        END AS ReceiptTimeSource,
        COUNT_BIG(*) AS ProductDayCount
    FROM #ReceiptDaily
    GROUP BY CASE
        WHEN FirstReceiptDateTime IS NOT NULL THEN N'RECEIPT_DATE'
        WHEN FirstCreateDateTime IS NOT NULL THEN N'CREATE_TIME_FALLBACK'
        ELSE N'UNRESOLVED'
    END
    ORDER BY ReceiptTimeSource;

    /* D6. Scope kho/nơi đi/nơi đến. Chỉ chẩn đoán, chưa gán StoreCode thật. */
    SELECT
        m.Inventory,
        m.Source,
        m.Destination,
        COUNT_BIG(*) AS LineCount,
        MIN(CONVERT(date,m.EffDate)) AS MinDate,
        MAX(CONVERT(date,m.EffDate)) AS MaxDate
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
    JOIN #Products p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.EffDate IS NOT NULL
      AND m.EffDate<DATEADD(day,1,@SelectedDataEndDate)
    GROUP BY m.Inventory,m.Source,m.Destination
    ORDER BY LineCount DESC;

    /* D7. CTKM chồng lấn. */
    SELECT
        rs.Product,
        rs.[Date],
        COUNT(*) AS ActivePromotionCount
    FROM #RunningStock rs
    JOIN #PromoIntervals pi
      ON pi.Product=rs.Product
     AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
    WHERE rs.[Date]>=@ReferenceReadStartDate
      AND rs.[Date]<=@ActualValidationEndDate
    GROUP BY rs.Product,rs.[Date]
    HAVING COUNT(*)>1
    ORDER BY rs.Product,rs.[Date];
END;