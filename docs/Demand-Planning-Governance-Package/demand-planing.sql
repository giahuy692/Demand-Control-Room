USE [POS];
SET NOCOUNT ON;
SET XACT_ABORT ON;

/* V10 note: temp table names carry a V10 suffix to avoid SQL Server binding to stale temp-table metadata from a previous failed run in the same SSMS session. */

/* ============================================================================
   demand-planing-v13-all-promotions.sql

   MỤC TIÊU
   - Chỉ đọc dữ liệu đã tồn tại trong POS; không INSERT/UPDATE/DELETE bảng thật.
   - Không tạo lịch ngày liên tục và không bịa record Sales = 0.
   - Lấy khung lịch sử Chặng 1 + đúng 14 ngày dữ liệu thật sau lịch sử. Nếu @PostRunDays=14 thì vùng sau lịch sử là RunDate..RunDate+13.
   - Phân loại đúng bán, trả, nhập và xuất theo mapping đã đối soát với
     dbo.sp_StockCurrent.
   - Tái tính tồn từ toàn bộ phát sinh và chỉ cho phép xuất khi tồn cuối khớp
     dbo.tbl_LSProduct.Quantity.

   OUTPUT
   1. DailySourceRecord : dữ liệu ngày do SQL tổng hợp từ nguồn thật để APP chạy mô phỏng.
   2. PromotionInterval: CTKM gắn trực tiếp với SKU.
   3. ExtractMetadata  : phạm vi, watermark, gate và giả định.
   4. RawPosSalesLine  : một dòng bán nguồn tương ứng đúng một dòng tbl_SALPoSDetails.
   5. Diagnostics      : chỉ xuất khi @ShowDiagnostics = 1; mặc định APP không xuất diagnostics.

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
DECLARE @ManualRunDate date = NULL;
-- NULL: tự chọn RunDate sao cho DB có đủ @PostRunDays ngày thật sau lịch sử.
-- Nếu cần lịch sử kết thúc 2026-01-31 thì đặt @ManualRunDate='2026-02-01'.
-- Không đặt RunDate xa hơn watermark DB, vì SQL không được tạo record thay thế.

DECLARE @HistoryYears int = 3;
DECLARE @CycleLength int = 15;
DECLARE @PostRunDays int = 14;              -- Đúng 14 ngày sau lịch sử: RunDate..RunDate+13.
DECLARE @ReferenceDaysBefore int = 24;      -- Khớp maxReferenceRadius hiện tại.
-- "Server 11" chỉ là tên gọi DB nguồn hiện tại, CHƯA xác định được đây là cửa hàng nào (khác các
-- StoreCode dạng "CH ..." của các cửa hàng đã biết) — dùng tạm nhãn này cho tới khi mapping rõ ràng.
DECLARE @StoreCode nvarchar(100) = N'Server 11';
DECLARE @FailOnStockMismatch bit = 1;
DECLARE @RequireFullPostRunWindow bit = 1;
DECLARE @RejectFutureSourceDate bit = 1;
DECLARE @ShowDiagnostics bit = 0; -- APP default: chỉ xuất 3 result set chính. Đổi =1 khi cần audit/debug.
DECLARE @OutputMode nvarchar(20) = N'ROWS'; -- Chỉ ROWS. JSON payload tạo ở converter để tránh phụ thuộc FOR JSON.
DECLARE @Tolerance decimal(38,6) = 0.000001;

DECLARE @QueryVersion nvarchar(100) = N'demand-planing-v13-all-promotions';
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

/* ============================== 1. DANH SÁCH SKU ===========================
   IMPORTANT
   - Input dưới đây là danh sách mã người dùng cung cấp. Phần lớn là barcode,
     nhưng DB POS thật không đảm bảo mọi mã đều nằm trong dbo.tbl_LSProduct.Barcode.
   - SKU chính dùng cho mô phỏng vẫn là tbl_LSProduct.Code / tbl_SALPoSDetails.Product.
   - Vì vậy mapping phải thử theo nhiều bằng chứng thật:
       1) tbl_LSProduct.Barcode
       2) tbl_LSProduct.Code                 -- trường hợp user dán Product Code
       3) tbl_SALPoSDetails.Barcode -> Product -> tbl_LSProduct.Code
   - Không tạo SKU giả. Mã không resolve được sẽ xuất diagnostic.
   - Mặc định không dừng khi một vài input không resolve được; chỉ dừng nếu không
     còn SKU hợp lệ hoặc một input map sang nhiều Product khác nhau.
   ============================================================================ */
DECLARE @FailOnUnresolvedInput bit = 0; -- 1 nếu muốn bắt buộc đủ 42/42 input đều map được.

IF OBJECT_ID('tempdb..#InputBarcodeV10') IS NOT NULL DROP TABLE #InputBarcodeV10;
CREATE TABLE #InputBarcodeV10
(
    Barcode nvarchar(100) NOT NULL PRIMARY KEY
);

INSERT INTO #InputBarcodeV10(Barcode)
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

IF OBJECT_ID('tempdb..#BarcodeMapV10') IS NOT NULL DROP TABLE #BarcodeMapV10;
CREATE TABLE #BarcodeMapV10
(
    Barcode nvarchar(100) NOT NULL,
    Product nvarchar(100) NOT NULL,
    CurrentQuantity decimal(38,6) NULL,
    ResolutionSource nvarchar(100) NOT NULL
);

/* 1) Input khớp trực tiếp với tbl_LSProduct.Barcode. */
INSERT INTO #BarcodeMapV10(Barcode,Product,CurrentQuantity,ResolutionSource)
SELECT DISTINCT
    i.Barcode,
    LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code))) AS Product,
    CONVERT(decimal(38,6),p.Quantity) AS CurrentQuantity,
    N'LSProduct.Barcode' AS ResolutionSource
FROM #InputBarcodeV10 i
JOIN dbo.tbl_LSProduct p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),p.Barcode)))=i.Barcode;

/* 2) Input thực ra là Product Code. Giữ lại để tránh nhầm barcode/code. */
INSERT INTO #BarcodeMapV10(Barcode,Product,CurrentQuantity,ResolutionSource)
SELECT DISTINCT
    i.Barcode,
    LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code))) AS Product,
    CONVERT(decimal(38,6),p.Quantity) AS CurrentQuantity,
    N'LSProduct.Code' AS ResolutionSource
FROM #InputBarcodeV10 i
JOIN dbo.tbl_LSProduct p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code)))=i.Barcode
WHERE NOT EXISTS
(
    SELECT 1
    FROM #BarcodeMapV10 existing
    WHERE existing.Barcode=i.Barcode
      AND existing.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code)))
);

/* 3) Barcode có trên dòng POS nhưng không có hoặc không đồng bộ trên master sản phẩm. */
INSERT INTO #BarcodeMapV10(Barcode,Product,CurrentQuantity,ResolutionSource)
SELECT DISTINCT
    i.Barcode,
    LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code))) AS Product,
    CONVERT(decimal(38,6),p.Quantity) AS CurrentQuantity,
    N'SALPoSDetails.Barcode' AS ResolutionSource
FROM #InputBarcodeV10 i
JOIN dbo.tbl_SALPoSDetails d
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),d.Barcode)))=i.Barcode
JOIN dbo.tbl_LSProduct p
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code)))=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE NOT EXISTS
(
    SELECT 1
    FROM #BarcodeMapV10 existing
    WHERE existing.Barcode=i.Barcode
      AND existing.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),p.Code)))
);

IF OBJECT_ID('tempdb..#InputResolutionV10') IS NOT NULL DROP TABLE #InputResolutionV10;
SELECT
    i.Barcode,
    COUNT(DISTINCT m.Product) AS ResolvedProductCount,
    MAX(m.Product) AS ResolvedProduct,
    STUFF
    (
        (
            SELECT DISTINCT N','+m2.ResolutionSource
            FROM #BarcodeMapV10 m2
            WHERE m2.Barcode=i.Barcode
            FOR XML PATH(''),TYPE
        ).value('.','nvarchar(max)'),
        1,1,N''
    ) AS ResolutionSources
INTO #InputResolutionV10
FROM #InputBarcodeV10 i
LEFT JOIN #BarcodeMapV10 m ON m.Barcode=i.Barcode
GROUP BY i.Barcode;

/* Một input map sang nhiều Product là lỗi thật: không được tự chọn. */
IF EXISTS (SELECT 1 FROM #InputResolutionV10 WHERE ResolvedProductCount>1)
BEGIN
    SELECT
        r.Barcode,
        m.Product,
        m.CurrentQuantity,
        m.ResolutionSource
    FROM #InputResolutionV10 r
    JOIN #BarcodeMapV10 m ON m.Barcode=r.Barcode
    WHERE r.ResolvedProductCount>1
    ORDER BY r.Barcode,m.Product,m.ResolutionSource;

    RAISERROR(N'Có input map nhiều Product. Không được tự chọn một SKU.',16,1);
    RETURN;
END;

IF @FailOnUnresolvedInput=1
   AND EXISTS (SELECT 1 FROM #InputResolutionV10 WHERE ResolvedProductCount=0)
BEGIN
    SELECT Barcode AS UnresolvedInput
    FROM #InputResolutionV10
    WHERE ResolvedProductCount=0
    ORDER BY Barcode;

    RAISERROR(N'Có input không resolve được thành Product thật. Dừng trích xuất theo @FailOnUnresolvedInput=1.',16,1);
    RETURN;
END;

IF NOT EXISTS (SELECT 1 FROM #BarcodeMapV10)
BEGIN
    SELECT Barcode AS UnresolvedInput
    FROM #InputResolutionV10
    WHERE ResolvedProductCount=0
    ORDER BY Barcode;

    RAISERROR(N'Không có input nào resolve được thành Product thật trong POS.',16,1);
    RETURN;
END;

IF OBJECT_ID('tempdb..#ProductsV10') IS NOT NULL DROP TABLE #ProductsV10;
CREATE TABLE #ProductsV10
(
    Product nvarchar(100) NOT NULL PRIMARY KEY,
    Barcode nvarchar(100) NOT NULL,
    CurrentQuantity decimal(38,6) NULL
);

INSERT INTO #ProductsV10(Product,Barcode,CurrentQuantity)
SELECT
    Product,
    MIN(Barcode) AS Barcode,
    MAX(CurrentQuantity) AS CurrentQuantity
FROM #BarcodeMapV10
GROUP BY Product;

/* Diagnostic luôn có sẵn để biết input nào bị bỏ qua. Không phải nguồn mô phỏng. */
IF @ShowDiagnostics=1
BEGIN
    SELECT
        Barcode AS InputBarcodeOrCode,
        CASE
            WHEN ResolvedProductCount=0 THEN N'UNRESOLVED_NOT_EXTRACTED'
            ELSE N'RESOLVED_TO_PRODUCT'
        END AS InputResolutionStatus,
        ResolvedProduct,
        ResolutionSources
    FROM #InputResolutionV10
    ORDER BY
        CASE WHEN ResolvedProductCount=0 THEN 0 ELSE 1 END,
        Barcode;
END;

/* Không được để JOIN sang master âm thầm làm mất hoặc nhân bản dòng POS thô. */
IF EXISTS
(
    SELECT 1
    FROM dbo.tbl_SALPoSDetails d
    JOIN #ProductsV10 p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    LEFT JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
    WHERE m.Code IS NULL
)
BEGIN
    SELECT d.Code AS PosDetailCode,d.PoSMaster,d.Product,d.Qty
    FROM dbo.tbl_SALPoSDetails d
    JOIN #ProductsV10 p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    LEFT JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
    WHERE m.Code IS NULL
    ORDER BY d.Code;

    RAISERROR(N'Có tbl_SALPoSDetails không nối được tbl_SALPoSMaster. Dừng để không âm thầm mất dòng raw.',16,1);
    RETURN;
END;

IF EXISTS
(
    SELECT 1
    FROM
    (
        SELECT Code
        FROM dbo.tbl_SALPoSMaster
        GROUP BY Code
        HAVING COUNT(*)>1
    ) duplicateMaster
    JOIN dbo.tbl_SALPoSDetails d ON d.PoSMaster=duplicateMaster.Code
    JOIN #ProductsV10 p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
)
BEGIN
    RAISERROR(N'tbl_SALPoSMaster.Code bị trùng. JOIN có thể nhân bản dòng raw.',16,1);
    RETURN;
END;

/* ============================== 2. WATERMARK NGUỒN =========================
   DatabaseWatermarkDate dùng để kiểm tra DB đã có đủ đúng @PostRunDays ngày thật sau lịch sử hay chưa.
   SelectedDataEndDate dùng để tái tính tồn của đúng các SKU đã chọn.
   Watermark chung KHÔNG tạo thêm dòng cho SKU.
   ============================================================================ */
SELECT @DatabaseWatermarkDate=MAX(SourceDate)
FROM
(
    SELECT MAX(CONVERT(date,m.TransactionDate)) AS SourceDate
    FROM dbo.tbl_SALPoSDetails d
    JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
    WHERE m.TransactionDate IS NOT NULL

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
    JOIN #ProductsV10 p
      ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
    WHERE m.TransactionDate IS NOT NULL

    UNION ALL

    SELECT MAX(CONVERT(date,m.EffDate))
    FROM dbo.tbl_OPSImExDetails d
    JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
    JOIN #ProductsV10 p
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

/* ============================== 3. KHUNG LỊCH SỬ + 14 NGÀY ================
   Quy ước V10:
   - ProcessingEndDate = RunDate - 1.
   - @PostRunDays = số ngày lịch thật cần đọc thêm SAU ProcessingEndDate.
   - Nếu @PostRunDays=14 và ProcessingEndDate='2026-01-31' thì
     ActualValidationEndDate='2026-02-14'. Tổng lịch đọc = D + 14, không phải D + 15.
   ============================================================================ */
SET @RunDate=COALESCE
(
    @ManualRunDate,
    CASE
        WHEN @PostRunDays=0 THEN DATEADD(day,1,@DatabaseWatermarkDate)
        ELSE DATEADD(day,-(@PostRunDays-1),@DatabaseWatermarkDate)
    END
);
SET @ProcessingEndDate=DATEADD(day,-1,@RunDate);
SET @ActualValidationEndDate=DATEADD(day,@PostRunDays,@ProcessingEndDate);
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

IF @PostRunDays>0
   AND @RequireFullPostRunWindow=1
   AND @ActualValidationEndDate>@DatabaseWatermarkDate
BEGIN
    SELECT
        @RunDate AS RequestedRunDate,
        @ActualValidationEndDate AS RequiredActualValidationEndDate,
        @DatabaseWatermarkDate AS AvailableDatabaseWatermarkDate,
        DATEDIFF(day,@DatabaseWatermarkDate,@ActualValidationEndDate) AS MissingCalendarDays;

    RAISERROR(N'DB chưa đủ số ngày thật sau lịch sử theo @PostRunDays. Không tạo record thay thế.',16,1);
    RETURN;
END;

/* ============================== 4. POS BÁN / TRẢ ============================
   Mapping đã kiểm tra trên DB POS thật:
   - tbl_SALPoSDetails là nguồn chính; không ép TransactionType=2.
   - Bán: RePosDetails IS NULL.
   - Trả/đảo chiều: RePosDetails IS NOT NULL.
   - Giữ nguyên Qty=0 vì đó là dòng nguồn thật; không COALESCE để bịa số lượng.
   ============================================================================ */
IF OBJECT_ID('tempdb..#RawPosLineV10') IS NOT NULL DROP TABLE #RawPosLineV10;

SELECT
    d.*,
    m.TransactionDate AS SourceTransactionDate,
    m.TransactionNo AS SourceTransactionNo,
    m.TransactionType AS SourceTransactionType,
    m.StatusName AS SourceStatusName,
    m.IsProcess AS SourceIsProcess,
    m.IsApproved AS SourceIsApproved
INTO #RawPosLineV10
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
JOIN #ProductsV10 p
  ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE m.TransactionDate IS NOT NULL
  AND m.TransactionDate<DATEADD(day,1,@SelectedDataEndDate);

IF OBJECT_ID('tempdb..#PosDailyV10') IS NOT NULL DROP TABLE #PosDailyV10;

SELECT
    LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product))) AS Product,
    CONVERT(date,d.SourceTransactionDate) AS [Date],
    SUM(CASE
        WHEN d.RePosDetails IS NULL
        THEN CONVERT(decimal(38,6),d.Qty)
        ELSE CONVERT(decimal(38,6),0)
    END) AS SalesQty,
    SUM(CASE
        WHEN d.RePosDetails IS NOT NULL
        THEN CONVERT(decimal(38,6),d.Qty)
        ELSE CONVERT(decimal(38,6),0)
    END) AS ReturnQty,
    SUM(CASE
        WHEN d.RePosDetails IS NULL THEN 1 ELSE 0
    END) AS SaleLineCount,
    SUM(CASE
        WHEN d.RePosDetails IS NOT NULL THEN 1 ELSE 0
    END) AS ReturnLineCount,
    COUNT_BIG(*) AS RelevantPosLineCount
INTO #PosDailyV10
FROM #RawPosLineV10 d
GROUP BY LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product))),CONVERT(date,d.SourceTransactionDate);

CREATE UNIQUE CLUSTERED INDEX IX_PosDaily ON #PosDailyV10(Product,[Date]);

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
IF OBJECT_ID('tempdb..#ImExDailyV10') IS NOT NULL DROP TABLE #ImExDailyV10;

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
INTO #ImExDailyV10
FROM dbo.tbl_OPSImExDetails d
JOIN dbo.tbl_OPSImExMaster m ON m.Code=d.DocumentNo
JOIN #ProductsV10 p
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

CREATE UNIQUE CLUSTERED INDEX IX_ImExDaily ON #ImExDailyV10(Product,[Date]);

/* ============================== 6. BIẾN ĐỘNG TỒN THEO NGÀY ================
   InventoryNetMovement = chỉ nhập/xuất kho.
   TotalStockDelta       = InventoryNetMovement + ReturnQty - SalesQty.
   ============================================================================ */
IF OBJECT_ID('tempdb..#MovementDailyV10') IS NOT NULL DROP TABLE #MovementDailyV10;

SELECT
    x.Product,
    x.[Date],
    SUM(x.ImExNetQty) AS ImExNetQty,
    SUM(x.SalesQty) AS SalesQty,
    SUM(x.ReturnQty) AS ReturnQty,
    SUM(x.ImExNetQty+x.ReturnQty-x.SalesQty) AS TotalStockDelta,
    CONVERT(bit,MAX(CONVERT(int,x.HasSalesRecord))) AS HasSalesRecord,
    CONVERT(bit,MAX(CONVERT(int,x.HasReturnRecord))) AS HasReturnRecord,
    CONVERT(bit,MAX(CONVERT(int,x.HasInventoryMovement))) AS HasInventoryMovement,
    CONVERT(bit,MAX(CONVERT(int,x.HasPosRecord))) AS HasPosRecord
INTO #MovementDailyV10
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
    FROM #ImExDailyV10

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
    FROM #PosDailyV10
) x
GROUP BY x.Product,x.[Date];

CREATE UNIQUE CLUSTERED INDEX IX_MovementDaily ON #MovementDailyV10(Product,[Date]);

/* ============================== 7. TỒN ĐẦU / CUỐI ===========================
   Mốc 0 chỉ được chấp nhận khi tồn tái tính cuối cùng khớp Quantity hiện tại.
   Nếu lịch sử bị purge hoặc mapping sai, gate sẽ FAIL và mặc định dừng.
   ============================================================================ */
IF OBJECT_ID('tempdb..#RunningStockV10') IS NOT NULL DROP TABLE #RunningStockV10;

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
INTO #RunningStockV10
FROM #MovementDailyV10 md;

CREATE UNIQUE CLUSTERED INDEX IX_RunningStock ON #RunningStockV10(Product,[Date]);

IF OBJECT_ID('tempdb..#StockReconciliationV10') IS NOT NULL DROP TABLE #StockReconciliationV10;

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
INTO #StockReconciliationV10
FROM #ProductsV10 p
OUTER APPLY
(
    SELECT TOP 1 rs.CloseStockCalc
    FROM #RunningStockV10 rs
    WHERE rs.Product=p.Product
    ORDER BY rs.[Date] DESC
) lastStock;

CREATE UNIQUE CLUSTERED INDEX IX_StockReconciliation ON #StockReconciliationV10(Product);

IF @FailOnStockMismatch=1
   AND EXISTS
   (
       SELECT 1
       FROM #StockReconciliationV10
       WHERE ReconciliationStatus<>N'MATCH'
   )
BEGIN
    SELECT
        Product,Barcode,CurrentQuantity,RecalculatedCurrentQuantity,
        Difference,ReconciliationStatus
    FROM #StockReconciliationV10
    ORDER BY ABS(Difference) DESC,Product;

    RAISERROR(N'Tồn tái tính không khớp tồn hiện tại. Không xuất dữ liệu vào mô phỏng.',16,1);
    RETURN;
END;

/* ============================== 8. PHIẾU NHẬP LOẠI 1 =======================
   HasReceiptRecord vẫn true khi phiếu tồn tại nhưng không xác định được giờ.
   Chỉ tính phiếu có lượng nhập dương theo status 2/3.
   ============================================================================ */
IF OBJECT_ID('tempdb..#ReceiptDailyV10') IS NOT NULL DROP TABLE #ReceiptDailyV10;

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
    JOIN #ProductsV10 p
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
INTO #ReceiptDailyV10
FROM ReceiptSource
GROUP BY Product,[Date];

CREATE UNIQUE CLUSTERED INDEX IX_ReceiptDaily ON #ReceiptDailyV10(Product,[Date]);

/* ============================== 9. GIÁ THƯỜNG GẦN NHẤT =====================
   Giá chỉ là giá suy ra từ Amount/Qty của dòng bán không có marker giảm giá.
   Chưa được gọi là giá niêm yết nếu nghiệp vụ chưa xác nhận Amount là giá thường.
   ============================================================================ */
IF OBJECT_ID('tempdb..#RegularPriceDailyV10') IS NOT NULL DROP TABLE #RegularPriceDailyV10;
IF OBJECT_ID('tempdb..#ProductPriceV10') IS NOT NULL DROP TABLE #ProductPriceV10;

SELECT
    p.Product,
    CONVERT(date,m.TransactionDate) AS [Date],
    SUM(CONVERT(decimal(38,6),d.Amount))
        / NULLIF(SUM(CONVERT(decimal(38,6),d.Qty)),0) AS UnitPrice
INTO #RegularPriceDailyV10
FROM dbo.tbl_SALPoSDetails d
JOIN dbo.tbl_SALPoSMaster m ON m.Code=d.PoSMaster
JOIN #ProductsV10 p
  ON p.Product=LTRIM(RTRIM(CONVERT(nvarchar(100),d.Product)))
WHERE d.RePosDetails IS NULL
  AND d.Qty>0
  AND d.Amount>0
  AND
  (
      d.Discount IS NULL
      OR LTRIM(RTRIM(CONVERT(nvarchar(100),d.Discount))) IN (N'',N'0')
  )
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

CREATE UNIQUE CLUSTERED INDEX IX_RegularPriceDaily ON #RegularPriceDailyV10(Product,[Date]);

SELECT
    p.Product,
    priceRow.UnitPrice AS Price,
    priceRow.[Date] AS PriceObservedDate
INTO #ProductPriceV10
FROM #ProductsV10 p
OUTER APPLY
(
    SELECT TOP 1 rpd.UnitPrice,rpd.[Date]
    FROM #RegularPriceDailyV10 rpd
    WHERE rpd.Product=p.Product
    ORDER BY rpd.[Date] DESC
) priceRow;

CREATE UNIQUE CLUSTERED INDEX IX_ProductPrice ON #ProductPriceV10(Product);

/* ============================== 10. TÊN SẢN PHẨM =========================== */
IF OBJECT_ID('tempdb..#ProductNameV10') IS NOT NULL DROP TABLE #ProductNameV10;
CREATE TABLE #ProductNameV10
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
        INSERT INTO #ProductNameV10(Product,ProductName)
        SELECT
            p.Product,
            MAX(CONVERT(nvarchar(500),lp.'+QUOTENAME(@NameColumn)+N'))
        FROM #ProductsV10 p
        JOIN dbo.tbl_LSProduct lp
          ON LTRIM(RTRIM(CONVERT(nvarchar(100),lp.Code)))=p.Product
        GROUP BY p.Product;';

    EXEC sp_executesql @NameSql;
END
ELSE
BEGIN
    INSERT INTO #ProductNameV10(Product,ProductName)
    SELECT Product,NULL
    FROM #ProductsV10;
END;

/* ============================== 11. KHOẢNG CTKM ============================
   Chỉ dùng quan hệ trực tiếp tbl_POLBundle.Product = SKU.
   Không dùng RefProduct vì chưa có bằng chứng đây là SKU được hưởng CTKM.
   ============================================================================ */
IF OBJECT_ID('tempdb..#PromoIntervalsV10') IS NOT NULL DROP TABLE #PromoIntervalsV10;

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
INTO #PromoIntervalsV10
FROM #ProductsV10 p
JOIN dbo.tbl_POLBundle b
  ON LTRIM(RTRIM(CONVERT(nvarchar(100),b.Product)))=p.Product
JOIN dbo.tbl_POLPromotion pr ON pr.Code=b.Promotion
WHERE pr.StartDate IS NOT NULL
  AND pr.EndDate IS NOT NULL
  AND CONVERT(date,pr.EndDate)>=@ReferenceReadStartDate
  AND CONVERT(date,pr.StartDate)<=@ActualValidationEndDate;

CREATE INDEX IX_PromoIntervals ON #PromoIntervalsV10(Product,StartDate,EndDate);

/* ============================== 12. KHÓA DÒNG XUẤT ==========================
   - Mọi ngày có phát sinh thật trong vùng tham chiếu/lịch sử/hậu kiểm.
   - Thêm đúng một dòng phát sinh thật gần nhất trước vùng đọc làm opening anchor.
   - Không tạo ngày mới.
   ============================================================================ */
IF OBJECT_ID('tempdb..#OutputKeysV10') IS NOT NULL DROP TABLE #OutputKeysV10;
CREATE TABLE #OutputKeysV10
(
    Product nvarchar(100) NOT NULL,
    [Date] date NOT NULL,
    IsOpeningAnchor bit NOT NULL,
    PRIMARY KEY(Product,[Date])
);

INSERT INTO #OutputKeysV10(Product,[Date],IsOpeningAnchor)
SELECT Product,[Date],CONVERT(bit,0)
FROM #RunningStockV10
WHERE [Date]>=@ReferenceReadStartDate
  AND [Date]<=@ActualValidationEndDate;

INSERT INTO #OutputKeysV10(Product,[Date],IsOpeningAnchor)
SELECT p.Product,anchorRow.[Date],CONVERT(bit,1)
FROM #ProductsV10 p
CROSS APPLY
(
    SELECT TOP 1 rs.[Date]
    FROM #RunningStockV10 rs
    WHERE rs.Product=p.Product
      AND rs.[Date]<@ReferenceReadStartDate
    ORDER BY rs.[Date] DESC
) anchorRow
WHERE NOT EXISTS
(
    SELECT 1
    FROM #OutputKeysV10 k
    WHERE k.Product=p.Product
      AND k.[Date]=anchorRow.[Date]
);

/* ============================== 13. DAILY OUTPUT =========================== */
IF OBJECT_ID('tempdb..#DailyOutputV10') IS NOT NULL DROP TABLE #DailyOutputV10;

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
INTO #DailyOutputV10
FROM #OutputKeysV10 k
JOIN #RunningStockV10 rs
  ON rs.Product=k.Product AND rs.[Date]=k.[Date]
JOIN #StockReconciliationV10 rec ON rec.Product=rs.Product
LEFT JOIN #ReceiptDailyV10 rd
  ON rd.Product=rs.Product AND rd.[Date]=rs.[Date]
LEFT JOIN #ProductPriceV10 pp ON pp.Product=rs.Product
LEFT JOIN #ProductNameV10 pn ON pn.Product=rs.Product
OUTER APPLY
(
    SELECT
        STUFF
        (
            (
                SELECT N'|'+pi.PromoCode
                FROM #PromoIntervalsV10 pi
                WHERE pi.Product=rs.Product
                  AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
                ORDER BY pi.StartDate,pi.PromoCode
                FOR XML PATH(''),TYPE
            ).value('.','nvarchar(max)'),
            1,1,N''
        ) AS PromoCode,
        STUFF
        (
            (
                SELECT N'|'+COALESCE(pi.PromoName,pi.PromoCode)
                FROM #PromoIntervalsV10 pi
                WHERE pi.Product=rs.Product
                  AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
                ORDER BY pi.StartDate,pi.PromoCode
                FOR XML PATH(''),TYPE
            ).value('.','nvarchar(max)'),
            1,1,N''
        ) AS PromoName
) promo
OUTER APPLY
(
    SELECT COUNT(*) AS PromoOverlapCount
    FROM #PromoIntervalsV10 pi
    WHERE pi.Product=rs.Product
      AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
) promoCount;

CREATE UNIQUE CLUSTERED INDEX IX_DailyOutput ON #DailyOutputV10(SKU,[Date]);

/* ============================== RESULT SET 1 ===============================
   Không dùng FOR JSON tại SQL để tránh lỗi parse trên SQL Server/compatibility
   chưa hỗ trợ INCLUDE_NULL_VALUES. Converter sẽ nhận 3 result set/file riêng và
   tạo payload DAILY-SOURCE-V2, giữ nguyên NULL.
   ============================================================================ */
SELECT *
FROM #DailyOutputV10
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
FROM #PromoIntervalsV10
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
    @PostRunDays AS AdditionalCalendarDaysAfterHistory,
    CASE
        WHEN @PostRunDays=0 THEN 0
        ELSE DATEDIFF(day,@RunDate,@ActualValidationEndDate)+1
    END AS ActualValidationDayCount,
    @ReferenceDaysBefore AS ReferenceDaysBefore,
    @StoreCode AS StoreCode,
    N'GLOBAL_DATABASE_SCOPE_NOT_STORE_FILTER' AS StoreScopeStatus,
    (SELECT COUNT(*) FROM #ProductsV10) AS SelectedSkuCount,
    N'SELECTED_SKU_SIMULATION' AS PortfolioMode,
    CONVERT(bit,1) AS ExtractIsTruncated,
    N'ZERO_BASED_FULL_HISTORY_RECONCILED_WITH_tbl_LSProduct_Quantity'
        AS StockAnchorAssumption,
    CASE
        WHEN EXISTS
        (
            SELECT 1 FROM #StockReconciliationV10
            WHERE ReconciliationStatus<>N'MATCH'
        ) THEN N'FAIL'
        ELSE N'PASS'
    END AS StockReconciliationGate,
    (
        SELECT COUNT(*) FROM #StockReconciliationV10
        WHERE ReconciliationStatus<>N'MATCH'
    ) AS StockMismatchSkuCount,
    (SELECT COUNT(*) FROM #DailyOutputV10) AS DailySourceRecordCount,
    (
        SELECT COUNT(*)
        FROM #RawPosLineV10
        WHERE RePosDetails IS NULL
          AND SourceTransactionDate>=@ReferenceReadStartDate
          AND SourceTransactionDate<DATEADD(day,1,@ActualValidationEndDate)
    ) AS RawPosSalesLineCount,
    (
        SELECT COUNT(*) FROM #RawPosLineV10
        WHERE RePosDetails IS NULL AND Qty=0
          AND SourceTransactionDate>=@ReferenceReadStartDate
          AND SourceTransactionDate<DATEADD(day,1,@ActualValidationEndDate)
    ) AS RawPosZeroQtyLineCount,
    (
        SELECT COUNT(*) FROM #RawPosLineV10
        WHERE RePosDetails IS NULL AND Qty<0
          AND SourceTransactionDate>=@ReferenceReadStartDate
          AND SourceTransactionDate<DATEADD(day,1,@ActualValidationEndDate)
    ) AS RawPosNegativeQtyLineCount,
    (
        SELECT COUNT(*) FROM #RawPosLineV10
        WHERE RePosDetails IS NULL AND Qty IS NULL
          AND SourceTransactionDate>=@ReferenceReadStartDate
          AND SourceTransactionDate<DATEADD(day,1,@ActualValidationEndDate)
    ) AS RawPosNullQtyLineCount,
    (SELECT COUNT(*) FROM #PromoIntervalsV10) AS PromotionIntervalCount,
    GETDATE() AS GeneratedAt;

/* ============================== RESULT SET 4 ===============================
   RAW POS SALES LINE
   - Một dòng kết quả tương ứng đúng một dòng tbl_SALPoSDetails.
   - Không GROUP BY, DISTINCT, SUM hoặc loại Qty=0.
   - Chỉ loại dòng trả/đảo chiều (RePosDetails IS NOT NULL).
   ============================================================================ */
SELECT
    CONVERT(nvarchar(36),@ExtractId) AS ExtractId,
    @StoreCode AS StoreCode,
    d.*
FROM #RawPosLineV10 d
WHERE d.RePosDetails IS NULL
  AND d.SourceTransactionDate>=@ReferenceReadStartDate
  AND d.SourceTransactionDate<DATEADD(day,1,@ActualValidationEndDate)
ORDER BY d.SourceTransactionDate,d.PoSMaster,d.Code;

/* ============================== DIAGNOSTICS ================================ */
IF @ShowDiagnostics=1
BEGIN
    /* D1. Đối soát tồn. */
    SELECT
        Product,Barcode,CurrentQuantity,RecalculatedCurrentQuantity,
        Difference,ReconciliationStatus
    FROM #StockReconciliationV10
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
    FROM #ProductsV10 p
    LEFT JOIN #RunningStockV10 rs ON rs.Product=p.Product
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
    JOIN #ProductsV10 p
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
    JOIN #ProductsV10 p
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
    FROM #ReceiptDailyV10
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
    JOIN #ProductsV10 p
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
    FROM #RunningStockV10 rs
    JOIN #PromoIntervalsV10 pi
      ON pi.Product=rs.Product
     AND rs.[Date] BETWEEN pi.StartDate AND pi.EndDate
    WHERE rs.[Date]>=@ReferenceReadStartDate
      AND rs.[Date]<=@ActualValidationEndDate
    GROUP BY rs.Product,rs.[Date]
    HAVING COUNT(*)>1
    ORDER BY rs.Product,rs.[Date];
END;
