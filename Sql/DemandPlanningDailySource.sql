USE [POS];
SET NOCOUNT ON;

/* =================================================================================================
   TÊN QUERY
       DemandPlanningDailySource.sql

   MỤC ĐÍCH
       Trả về MỘT BẢNG DUY NHẤT phục vụ mô phỏng Demand Planning tại cửa hàng 11.

   KIẾN TRÚC ĐÃ CHỐT
       1. SQL tạo đầy đủ lịch:
              Mã hàng × ngày
       2. Doanh số chỉ lấy từ dbo.tbl_SALPoSDetails.
       3. Không dùng dữ liệu tồn để loại hoặc làm mất bất kỳ dòng bán nào.
       4. Ngày không có dòng bán thật:
              HasSalesRecord = 0
              Sales          = NULL
          Không tự đổi thành Sales = 0.
       5. Kết quả cuối chỉ có MỘT DÒNG cho mỗi:
              StoreCode + ProductCode + Date.
          Các dòng bán có nhiều Discount/CTKM trong ngày vẫn được giữ đầy đủ trong
          bảng tạm để tính tổng Sales và chọn CTKM chính, nhưng không làm nhân dòng đầu ra.
       6. Tồn đầu hôm nay = tồn cuối hôm trước.
       7. Chiều cộng/trừ tồn tham khảo đúng dbo.sp_StockCurrent trong StockCurrent.sql.
       8. RePosDetails và TransactionType chỉ dùng để tính biến động tồn POS.
          Tuyệt đối không đưa chúng vào điều kiện lọc doanh số.
       9. Không cập nhật, xóa hoặc chèn dữ liệu vào bảng thật.
          Query chỉ đọc bảng thật và chỉ ghi vào bảng tạm #.
      10. Barcode bắt đầu bằng H hoặc G không được đưa vào mô phỏng:
              H = combo
              G = quà tặng
      11. Phân loại CTKM:
              tbl_POLPromotion.[Type] IN (2, 7) => DEEP_PROMO
              các Type còn lại                  => ALWAYS_ON
          Nếu cùng ngày có nhiều CTKM, CTKM sâu được ưu tiên; trong cùng mức ưu tiên,
          CTKM có Sales lớn nhất là CTKM chính của ngày.
      12. Ngày không có giao dịch bán không được tự gắn CTKM chỉ vì nằm trong khoảng
          StartDate/EndDate. Có gì ghi nhận đúng như dữ liệu giao dịch có thật.
      13. Giá dùng cho ABC:
              Ưu tiên giá sạch gần nhất trước RunDate: Amount / Qty khi không Discount.
              Nếu ngày gần nhất chỉ có giao dịch khuyến mãi, dùng giá trước giảm:
                  (Amount + DiscountAmount) / Qty
          Kết quả cuối chỉ xuất trường Price dùng cho ABC.
          Các giá trung gian vẫn được giữ trong bảng tạm để kiểm tra.
      14. Khung dữ liệu mô phỏng:
              ExtractStartDate -> RunDate - 1      : lịch sử
              RunDate          -> RunDate + 13 ngày: đúng 14 ngày hậu kiểm
          @PostRunDays = 14 nghĩa là lấy đúng 14 ngày bắt đầu từ RunDate.
          Ví dụ RunDate = 2026-02-01 => hậu kiểm 2026-02-01 .. 2026-02-14.

   HỢP ĐỒNG ĐẦU RA CHO DEMAND PLANNING
       Mỗi StoreCode + ProductCode + Date có đúng một dòng.

       Các trường được xuất:
           StoreCode
           ProductCode
           Barcode
           ProductName
           Date
           HasSalesRecord
           Sales
           Price
           PromotionCode
           PromotionName
           PromotionStartDate
           PromotionEndDate
           PromotionType
           PromotionMechanismType
           PromotionClass
           OpenStock
           CloseStock
           ReceiptHour
           StockStatus

       Cách Demand Planning sử dụng PromotionClass:
           NO_PROMOTION:
               Giữ nguyên Sales làm mức bán nền quan sát được.

           ALWAYS_ON:
               KHÔNG bóc tách khuyến mãi.
               Giữ nguyên toàn bộ Sales của ngày để tính Baseline vì ưu đãi đã trở thành
               một phần ổn định của mức tiêu thụ tự nhiên tại cửa hàng.

           DEEP_PROMO:
               Chuyển sang Chặng 4 để đưa ngày này về mức bán tự nhiên.

           PROMOTION_UNRESOLVED:
               Không tự kết luận. Chuyển sang danh sách cần xem xét.

       HasSalesRecord phân biệt:
           0 + Sales NULL: không có dòng bán thật.
           1 + Sales 0   : có dòng bán thật nhưng tổng Qty bằng 0.
   ================================================================================================= */


/* =================================================================================================
   0. THAM SỐ
   ================================================================================================= */

DECLARE @StoreCode int = 11;

/* Bản mô phỏng mặc định dùng đúng 50 mã hàng đã chốt.
   Đổi thành 0 khi triển khai chính thức để lấy toàn bộ mã hàng không bắt đầu bằng H/G. */
DECLARE @UseFixedSimulationProducts bit = 1;

DECLARE @ExtractStartDate date = '2022-02-01';
DECLARE @RunDate date = '2026-02-01';
DECLARE @PostRunDays int = 14;

/* Ngày cuối lịch sử luôn lùi một ngày so với RunDate. */
DECLARE @HistoryEndDate date = DATEADD(day, -1, @RunDate);

/* Đúng 14 ngày tính từ RunDate:
   RunDate + 0 ... RunDate + 13. */
DECLARE @OutputEndDate date = DATEADD(day, @PostRunDays - 1, @RunDate);

/* tbl_LSProduct.Quantity được xem là mốc tồn hiện tại theo logic StockCurrent.
   Query dựng ngược từ mốc này về OutputEndDate và ExtractStartDate. */
DECLARE @StockSnapshotDate date = CONVERT(date, GETDATE());

DECLARE @SalesRowCountBefore bigint;   -- số nhóm sales nội bộ theo Discount/CTKM
DECLARE @SalesDayCountBefore bigint;   -- số ProductCode + Date thật sự có sales
DECLARE @SalesQtyBefore decimal(38, 6);
DECLARE @SalesDayCountAfter bigint;
DECLARE @SalesQtyAfter decimal(38, 6);

IF @PostRunDays < 1
BEGIN
    RAISERROR(N'@PostRunDays phải lớn hơn hoặc bằng 1.', 16, 1);
    RETURN;
END;

IF @ExtractStartDate > @HistoryEndDate
BEGIN
    RAISERROR(N'Ngày bắt đầu lấy dữ liệu lớn hơn ngày cuối lịch sử.', 16, 1);
    RETURN;
END;

IF @OutputEndDate > @StockSnapshotDate
BEGIN
    RAISERROR
    (
        N'Ngày cuối đầu ra lớn hơn ngày mốc tồn hiện tại. Không thể dựng tồn cho ngày tương lai.',
        16,
        1
    );
    RETURN;
END;


/* =================================================================================================
   1. DỌN BẢNG TẠM CỦA LẦN CHẠY TRƯỚC
   ================================================================================================= */

IF OBJECT_ID('tempdb..#RequestedProducts') IS NOT NULL DROP TABLE #RequestedProducts;
IF OBJECT_ID('tempdb..#TargetProducts') IS NOT NULL DROP TABLE #TargetProducts;
IF OBJECT_ID('tempdb..#Calendar') IS NOT NULL DROP TABLE #Calendar;
IF OBJECT_ID('tempdb..#ProductCalendar') IS NOT NULL DROP TABLE #ProductCalendar;
IF OBJECT_ID('tempdb..#PosSource') IS NOT NULL DROP TABLE #PosSource;
IF OBJECT_ID('tempdb..#SalesBase') IS NOT NULL DROP TABLE #SalesBase;
IF OBJECT_ID('tempdb..#DailySales') IS NOT NULL DROP TABLE #DailySales;
IF OBJECT_ID('tempdb..#PriceCandidates') IS NOT NULL DROP TABLE #PriceCandidates;
IF OBJECT_ID('tempdb..#RegularPrice') IS NOT NULL DROP TABLE #RegularPrice;
IF OBJECT_ID('tempdb..#PromotionDayAgg') IS NOT NULL DROP TABLE #PromotionDayAgg;
IF OBJECT_ID('tempdb..#PrimaryPromotion') IS NOT NULL DROP TABLE #PrimaryPromotion;
IF OBJECT_ID('tempdb..#ImExSource') IS NOT NULL DROP TABLE #ImExSource;
IF OBJECT_ID('tempdb..#DailyMovement') IS NOT NULL DROP TABLE #DailyMovement;
IF OBJECT_ID('tempdb..#StockAtOutputEnd') IS NOT NULL DROP TABLE #StockAtOutputEnd;
IF OBJECT_ID('tempdb..#StockDaily') IS NOT NULL DROP TABLE #StockDaily;
IF OBJECT_ID('tempdb..#FirstReceipt') IS NOT NULL DROP TABLE #FirstReceipt;
IF OBJECT_ID('tempdb..#FinalResult') IS NOT NULL DROP TABLE #FinalResult;


/* =================================================================================================
   2. DANH SÁCH MÃ HÀNG

   - Mô phỏng: dùng đúng 50 mã đã chốt.
   - Chính thức: @UseFixedSimulationProducts = 0 để lấy toàn bộ danh mục.
   - Barcode chỉ bị loại khi BẮT ĐẦU bằng H hoặc G.
     Không dùng '%H%' hoặc '%G%' vì cách đó có thể loại nhầm barcode hợp lệ.
   ================================================================================================= */

CREATE TABLE #RequestedProducts
(
    ProductCode int NOT NULL PRIMARY KEY
);

INSERT INTO #RequestedProducts (ProductCode)
VALUES
    (49054), (50084), (14750), (30255), (39632), (31866), (20179),
    (33811), (31419), (39895), (36968), (28977), (24695), (39089),
    (48923), (40717), (24010), (31825), (34456), (38665), (34752),
    (41952), (55570), (19551), (39894), (44351), (31863), (15346),
    (30947), (31883), (46526), (42409), (37918), (47145), (33808),
    (46688), (33810), (34462), (34457), (24011), (28589), (56842),
    (42943), (39778), (41143), (33959), (41123), (30610), (31667),
    (46569);

IF @UseFixedSimulationProducts = 1
AND EXISTS
(
    SELECT 1
    FROM #RequestedProducts AS Requested
    LEFT JOIN dbo.tbl_LSProduct AS Product
        ON Product.Code = Requested.ProductCode
    WHERE Product.Code IS NULL
)
BEGIN
    RAISERROR(N'Có ProductCode mô phỏng không tồn tại trong dbo.tbl_LSProduct.', 16, 1);
    RETURN;
END;

CREATE TABLE #TargetProducts
(
    ProductCode int NOT NULL PRIMARY KEY,
    Barcode nvarchar(100) NULL,
    ProductName nvarchar(500) NULL,
    CurrentStock decimal(38, 6) NULL
);

IF @UseFixedSimulationProducts = 1
BEGIN
    INSERT INTO #TargetProducts
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
        CONVERT(decimal(38, 6), Product.Quantity)
    FROM dbo.tbl_LSProduct AS Product
    INNER JOIN #RequestedProducts AS Requested
        ON Requested.ProductCode = Product.Code
    WHERE
        Product.Barcode IS NULL
        OR
        (
            CONVERT(nvarchar(100), Product.Barcode) NOT LIKE N'H%'
            AND CONVERT(nvarchar(100), Product.Barcode) NOT LIKE N'G%'
        );
END
ELSE
BEGIN
    INSERT INTO #TargetProducts
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
        CONVERT(decimal(38, 6), Product.Quantity)
    FROM dbo.tbl_LSProduct AS Product
    WHERE
        Product.Barcode IS NULL
        OR
        (
            CONVERT(nvarchar(100), Product.Barcode) NOT LIKE N'H%'
            AND CONVERT(nvarchar(100), Product.Barcode) NOT LIKE N'G%'
        );
END;

IF NOT EXISTS (SELECT 1 FROM #TargetProducts)
BEGIN
    RAISERROR(N'Không có mã hàng hợp lệ sau khi loại barcode H/G.', 16, 1);
    RETURN;
END;


/* =================================================================================================
   3. TẠO LỊCH ĐẦY ĐỦ PRODUCT × DATE

   SQL chủ động tạo lịch theo yêu cầu mới.
   Ngày không có giao dịch vẫn tồn tại trong #ProductCalendar.
   ================================================================================================= */

CREATE TABLE #Calendar
(
    BusinessDate date NOT NULL PRIMARY KEY
);

;WITH Calendar AS
(
    SELECT @ExtractStartDate AS BusinessDate

    UNION ALL

    SELECT DATEADD(day, 1, BusinessDate)
    FROM Calendar
    WHERE BusinessDate < @OutputEndDate
)
INSERT INTO #Calendar (BusinessDate)
SELECT BusinessDate
FROM Calendar
OPTION (MAXRECURSION 0);

CREATE TABLE #ProductCalendar
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    PRIMARY KEY (ProductCode, BusinessDate)
);

INSERT INTO #ProductCalendar
(
    ProductCode,
    BusinessDate
)
SELECT
    Product.ProductCode,
    Calendar.BusinessDate
FROM #TargetProducts AS Product
CROSS JOIN #Calendar AS Calendar;


/* =================================================================================================
   4. ĐỌC POS MỘT LẦN

   #PosSource phục vụ đồng thời:
       - tổng hợp sales;
       - tính giá;
       - tính biến động tồn POS.

   Phạm vi phải kéo đến @StockSnapshotDate vì muốn dựng tồn lịch sử từ
   tbl_LSProduct.Quantity hiện tại thì phải trừ toàn bộ biến động sau OutputEndDate.

   LOGIC SALES KHÔNG CÓ:
       - TransactionType filter;
       - RePosDetails filter.

   Hai trường đó chỉ được lưu để phần tính tồn sử dụng sau.
   ================================================================================================= */

CREATE TABLE #PosSource
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    Qty decimal(38, 6) NOT NULL,
    Amount decimal(38, 6) NOT NULL,
    DiscountAmount decimal(38, 6) NOT NULL,
    DiscountCode int NULL,
    TransactionType int NULL,
    HasRePosDetails bit NOT NULL
);

INSERT INTO #PosSource
(
    ProductCode,
    BusinessDate,
    Qty,
    Amount,
    DiscountAmount,
    DiscountCode,
    TransactionType,
    HasRePosDetails
)
SELECT
    Detail.Product,
    CONVERT(date, Master.EffDate),
    CONVERT(decimal(38, 6), COALESCE(Detail.Qty, 0)),
    CONVERT(decimal(38, 6), COALESCE(Detail.Amount, 0)),
    CONVERT(decimal(38, 6), COALESCE(Detail.DiscountAmount, 0)),
    Detail.Discount,
    Master.TransactionType,
    CONVERT(bit, CASE WHEN Detail.RePosDetails IS NULL THEN 0 ELSE 1 END)
FROM dbo.tbl_SALPoSDetails AS Detail
INNER JOIN dbo.tbl_SALPoSMaster AS Master
    ON Master.Code = Detail.PoSMaster
INNER JOIN #TargetProducts AS Product
    ON Product.ProductCode = Detail.Product
WHERE
    Master.EffDate >= @ExtractStartDate
    AND Master.EffDate < DATEADD(day, 1, @StockSnapshotDate)
OPTION (RECOMPILE);

CREATE CLUSTERED INDEX IX_PosSource_Product_Date
    ON #PosSource (ProductCode, BusinessDate);

CREATE NONCLUSTERED INDEX IX_PosSource_Date_Product
    ON #PosSource (BusinessDate, ProductCode);


/* =================================================================================================
   5. TỔNG HỢP SALES — GIỮ NGUYÊN BẢN CHẤT ĐÃ CHỐT

   Sales = SUM(Qty)

   Mỗi nhóm Product + Date + Discount + Promotion là một dòng sales.
   Không gộp các CTKM khác nhau thành một dòng.
   ================================================================================================= */

CREATE TABLE #SalesBase
(
    SalesRowId bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,

    Sales decimal(38, 6) NULL,
    RecordedAmount decimal(38, 6) NULL,
    DiscountAmount decimal(38, 6) NULL,

    /* Giá khách được ghi nhận trên dòng bán. */
    RecordedUnitPrice decimal(38, 6) NULL,

    /* Giá trước giảm tái dựng từ Amount + DiscountAmount.
       Đây là giá trị để đối chiếu, không ghi đè RecordedUnitPrice. */
    PreDiscountUnitPrice decimal(38, 6) NULL,

    DiscountCode int NULL,
    PromotionCode int NULL,
    PromotionName nvarchar(500) NULL,
    PromotionStartDate date NULL,
    PromotionEndDate date NULL,

    /* PromotionType: KM thường, giờ vàng... */
    PromotionType int NULL,

    /* PromotionMechanismType = tbl_POLPromotion.[Type]:
       combo/giftset/xả kho/... theo cách phân loại ERP. */
    PromotionMechanismType int NULL,

    PromotionClass varchar(30) NOT NULL
);

INSERT INTO #SalesBase
(
    ProductCode,
    BusinessDate,
    Sales,
    RecordedAmount,
    DiscountAmount,
    RecordedUnitPrice,
    PreDiscountUnitPrice,
    DiscountCode,
    PromotionCode,
    PromotionName,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType,
    PromotionMechanismType,
    PromotionClass
)
SELECT
    Pos.ProductCode,
    Pos.BusinessDate,

    /* LOGIC SALES ĐÃ KHÓA — KHÔNG SỬA. */
    SUM(Pos.Qty) AS Sales,

    SUM(Pos.Amount) AS RecordedAmount,
    SUM(Pos.DiscountAmount) AS DiscountAmount,

    SUM(Pos.Amount) / NULLIF(SUM(Pos.Qty), 0) AS RecordedUnitPrice,

    SUM(Pos.Amount + Pos.DiscountAmount)
        / NULLIF(SUM(Pos.Qty), 0) AS PreDiscountUnitPrice,

    Pos.DiscountCode,
    Promotion.Code,
    CONVERT(nvarchar(500), Promotion.Promotion),
    CONVERT(date, Promotion.StartDate),
    CONVERT(date, Promotion.EndDate),
    Promotion.PromotionType,
    Promotion.[Type],

    CASE
        WHEN Pos.DiscountCode IS NULL
            THEN 'NO_PROMOTION'

        WHEN Promotion.Code IS NULL
            THEN 'PROMOTION_UNRESOLVED'

        WHEN Promotion.[Type] IN (2, 7)
            THEN 'DEEP_PROMO'

        ELSE 'ALWAYS_ON'
    END AS PromotionClass
FROM #PosSource AS Pos
LEFT JOIN dbo.tbl_POLBundle AS Bundle
    ON Bundle.Code = Pos.DiscountCode
LEFT JOIN dbo.tbl_POLPromotion AS Promotion
    ON Promotion.Code = Bundle.Promotion
WHERE Pos.BusinessDate >= @ExtractStartDate
  AND Pos.BusinessDate <= @OutputEndDate
GROUP BY
    Pos.ProductCode,
    Pos.BusinessDate,
    Pos.DiscountCode,
    Promotion.Code,
    Promotion.Promotion,
    CONVERT(date, Promotion.StartDate),
    CONVERT(date, Promotion.EndDate),
    Promotion.PromotionType,
    Promotion.[Type];

CREATE NONCLUSTERED INDEX IX_SalesBase_Product_Date
    ON #SalesBase (ProductCode, BusinessDate);

SELECT
    @SalesRowCountBefore = COUNT_BIG(*),
    @SalesQtyBefore = SUM(COALESCE(Sales, 0))
FROM #SalesBase;


/* =================================================================================================
   6. GIÁ THƯỜNG DÙNG CHO ABC

   Cách chọn:
       1. Lấy NGÀY CÓ GIÁ GẦN RUNDATE NHẤT.
       2. Nếu cùng ngày có cả giá sạch và giá tái dựng, ưu tiên giá sạch.

       Giá sạch:
           Dòng không có Discount và DiscountAmount = 0
           Giá = Amount / Qty

       Giá tái dựng:
           Dùng khi ngày gần nhất chỉ có giao dịch khuyến mãi.
           Giá = (Amount + DiscountAmount) / Qty

   Nếu ngày được chọn có nhiều giao dịch thì dùng giá bình quân gia quyền theo Qty.

   Không dùng giá nhập kho hoặc giá vốn để xếp ABC.
   ================================================================================================= */

CREATE TABLE #PriceCandidates
(
    ProductCode int NOT NULL,
    PriceDate date NOT NULL,
    PricePriority int NOT NULL,
    RegularPrice decimal(38, 6) NOT NULL,
    PriceMethod varchar(50) NOT NULL,
    PRIMARY KEY (ProductCode, PricePriority, PriceDate)
);

INSERT INTO #PriceCandidates
(
    ProductCode,
    PriceDate,
    PricePriority,
    RegularPrice,
    PriceMethod
)
SELECT
    Pos.ProductCode,
    Pos.BusinessDate,
    1,
    SUM(Pos.Amount) / NULLIF(SUM(Pos.Qty), 0),
    'CLEAN_AMOUNT_PER_QTY'
FROM #PosSource AS Pos
WHERE Pos.BusinessDate < @RunDate
  AND Pos.Qty > 0
  AND Pos.Amount > 0
  AND Pos.DiscountCode IS NULL
  AND Pos.DiscountAmount = 0
GROUP BY
    Pos.ProductCode,
    Pos.BusinessDate
HAVING SUM(Pos.Qty) > 0
   AND SUM(Pos.Amount) > 0;

INSERT INTO #PriceCandidates
(
    ProductCode,
    PriceDate,
    PricePriority,
    RegularPrice,
    PriceMethod
)
SELECT
    Pos.ProductCode,
    Pos.BusinessDate,
    2,
    SUM(Pos.Amount + Pos.DiscountAmount) / NULLIF(SUM(Pos.Qty), 0),
    'RECONSTRUCTED_AMOUNT_PLUS_DISCOUNT'
FROM #PosSource AS Pos
WHERE Pos.BusinessDate < @RunDate
  AND Pos.Qty > 0
  AND (Pos.Amount + Pos.DiscountAmount) > 0
GROUP BY
    Pos.ProductCode,
    Pos.BusinessDate
HAVING SUM(Pos.Qty) > 0
   AND SUM(Pos.Amount + Pos.DiscountAmount) > 0;

CREATE TABLE #RegularPrice
(
    ProductCode int NOT NULL PRIMARY KEY,
    RegularPriceForABC decimal(38, 6) NULL,
    RegularPriceDate date NULL,
    RegularPriceMethod varchar(50) NULL
);

;WITH RankedPrice AS
(
    SELECT
        Candidate.ProductCode,
        Candidate.RegularPrice,
        Candidate.PriceDate,
        Candidate.PriceMethod,
        ROW_NUMBER() OVER
        (
            PARTITION BY Candidate.ProductCode
            ORDER BY
                Candidate.PriceDate DESC,
                Candidate.PricePriority ASC
        ) AS PriceOrder
    FROM #PriceCandidates AS Candidate
)
INSERT INTO #RegularPrice
(
    ProductCode,
    RegularPriceForABC,
    RegularPriceDate,
    RegularPriceMethod
)
SELECT
    Product.ProductCode,
    Price.RegularPrice,
    Price.PriceDate,
    Price.PriceMethod
FROM #TargetProducts AS Product
LEFT JOIN RankedPrice AS Price
    ON Price.ProductCode = Product.ProductCode
   AND Price.PriceOrder = 1;


/* =================================================================================================
   7. CHỌN CTKM CHÍNH CỦA PRODUCT + DATE

   Mục đích:
       - Không dùng để xóa hoặc gộp dòng sales.
       - Chỉ giúp Demand Planning biết ngày đó có bị CTKM sâu làm méo hay không.
       - Giữ PromotionCode để gom các ngày cùng một CTKM thành một cụm xử lý.

   Thứ tự chọn:
       1. DEEP_PROMO;
       2. ALWAYS_ON;
       3. PROMOTION_UNRESOLVED;
       4. Sales lớn nhất;
       5. PromotionCode nhỏ nhất;
       6. DiscountCode nhỏ nhất.
   ================================================================================================= */

CREATE TABLE #PromotionDayAgg
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    DiscountCode int NULL,
    PromotionCode int NULL,
    PromotionName nvarchar(500) NULL,
    PromotionStartDate date NULL,
    PromotionEndDate date NULL,
    PromotionType int NULL,
    PromotionMechanismType int NULL,
    PromotionClass varchar(30) NOT NULL,
    PromotionSales decimal(38, 6) NULL
);

INSERT INTO #PromotionDayAgg
(
    ProductCode,
    BusinessDate,
    DiscountCode,
    PromotionCode,
    PromotionName,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType,
    PromotionMechanismType,
    PromotionClass,
    PromotionSales
)
SELECT
    Sales.ProductCode,
    Sales.BusinessDate,
    Sales.DiscountCode,
    Sales.PromotionCode,
    Sales.PromotionName,
    Sales.PromotionStartDate,
    Sales.PromotionEndDate,
    Sales.PromotionType,
    Sales.PromotionMechanismType,
    Sales.PromotionClass,
    SUM(Sales.Sales)
FROM #SalesBase AS Sales
WHERE Sales.DiscountCode IS NOT NULL
GROUP BY
    Sales.ProductCode,
    Sales.BusinessDate,
    Sales.DiscountCode,
    Sales.PromotionCode,
    Sales.PromotionName,
    Sales.PromotionStartDate,
    Sales.PromotionEndDate,
    Sales.PromotionType,
    Sales.PromotionMechanismType,
    Sales.PromotionClass;

CREATE TABLE #PrimaryPromotion
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    PrimaryDiscountCode int NULL,
    PrimaryPromotionCode int NULL,
    PrimaryPromotionName nvarchar(500) NULL,
    PrimaryPromotionStartDate date NULL,
    PrimaryPromotionEndDate date NULL,
    PrimaryPromotionType int NULL,
    PrimaryPromotionMechanismType int NULL,
    DayPromotionClass varchar(30) NOT NULL,
    IsDeepPromoDay bit NOT NULL,
    PRIMARY KEY (ProductCode, BusinessDate)
);

;WITH RankedPromotion AS
(
    SELECT
        Promotion.*,
        ROW_NUMBER() OVER
        (
            PARTITION BY Promotion.ProductCode, Promotion.BusinessDate
            ORDER BY
                CASE Promotion.PromotionClass
                    WHEN 'DEEP_PROMO' THEN 1
                    WHEN 'ALWAYS_ON' THEN 2
                    WHEN 'PROMOTION_UNRESOLVED' THEN 3
                    ELSE 4
                END,
                Promotion.PromotionSales DESC,
                COALESCE(Promotion.PromotionCode, 2147483647),
                COALESCE(Promotion.DiscountCode, 2147483647)
        ) AS PromotionOrder
    FROM #PromotionDayAgg AS Promotion
)
INSERT INTO #PrimaryPromotion
(
    ProductCode,
    BusinessDate,
    PrimaryDiscountCode,
    PrimaryPromotionCode,
    PrimaryPromotionName,
    PrimaryPromotionStartDate,
    PrimaryPromotionEndDate,
    PrimaryPromotionType,
    PrimaryPromotionMechanismType,
    DayPromotionClass,
    IsDeepPromoDay
)
SELECT
    ProductCode,
    BusinessDate,
    DiscountCode,
    PromotionCode,
    PromotionName,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType,
    PromotionMechanismType,
    PromotionClass,
    CONVERT(bit, CASE WHEN PromotionClass = 'DEEP_PROMO' THEN 1 ELSE 0 END)
FROM RankedPromotion
WHERE PromotionOrder = 1;


/* =================================================================================================
   8. ĐỌC NHẬP/XUẤT KHO MỘT LẦN

   Dấu cộng/trừ lấy đúng từ StockCurrent.sql:

       Nhập tăng:
           Type (1,2,3,4,21,31,41,50), Status 3 => +QtyReceived
           Type (1,2,3,4,21,31,41,50), Status 2 => +Quantity

       Xuất giảm:
           Type (5,6,7,8,9,10,20,30,40,52), Status 6 => -QtyReceived
           Type (5,6,7,8,9,20,30,40,52),    Status 5 => -QtyReceived
           Lưu ý: Type 10 không nằm trong Status 5 theo StockCurrent.

   Giờ nhập:
       1. ReceiptDate nếu thật sự còn phần giờ khác 00:00;
       2. CreateTime nếu tồn tại và còn phần giờ;
       3. LastModifiedTime nếu tồn tại và còn phần giờ;
       4. nếu không còn giờ thật => NULL.

   Dynamic SQL chỉ dùng vì CreateTime/LastModifiedTime có thể không tồn tại ở
   một số bản DB. Bảng thật vẫn chỉ được đọc.
   ================================================================================================= */

CREATE TABLE #ImExSource
(
    DocumentCode int NOT NULL,
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    DocumentType int NOT NULL,
    DocumentStatus int NOT NULL,
    InventoryNetQty decimal(38, 6) NOT NULL,
    IsReceiptDocument bit NOT NULL,
    ReceiptCandidateDateTime datetime NULL
);

DECLARE @ReceiptCandidateExpr nvarchar(max);

SET @ReceiptCandidateExpr = N'
CASE
    WHEN Master.ReceiptDate IS NOT NULL
         AND CONVERT(time(0), Master.ReceiptDate) <> ''00:00:00''
    THEN DATEADD
         (
             second,
             DATEDIFF
             (
                 second,
                 CONVERT(date, CONVERT(datetime, Master.ReceiptDate)),
                 CONVERT(datetime, Master.ReceiptDate)
             ),
             CONVERT(datetime, CONVERT(date, Master.EffDate))
         )
END';

IF COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'CreateTime') IS NOT NULL
BEGIN
    SET @ReceiptCandidateExpr =
        N'COALESCE('
        + @ReceiptCandidateExpr
        + N',
CASE
    WHEN Master.CreateTime IS NOT NULL
         AND CONVERT(time(0), Master.CreateTime) <> ''00:00:00''
    THEN DATEADD
         (
             second,
             DATEDIFF
             (
                 second,
                 CONVERT(date, CONVERT(datetime, Master.CreateTime)),
                 CONVERT(datetime, Master.CreateTime)
             ),
             CONVERT(datetime, CONVERT(date, Master.EffDate))
         )
END)';
END;

IF COL_LENGTH(N'dbo.tbl_OPSImExMaster', N'LastModifiedTime') IS NOT NULL
BEGIN
    SET @ReceiptCandidateExpr =
        N'COALESCE('
        + @ReceiptCandidateExpr
        + N',
CASE
    WHEN Master.LastModifiedTime IS NOT NULL
         AND CONVERT(time(0), Master.LastModifiedTime) <> ''00:00:00''
    THEN DATEADD
         (
             second,
             DATEDIFF
             (
                 second,
                 CONVERT(date, CONVERT(datetime, Master.LastModifiedTime)),
                 CONVERT(datetime, Master.LastModifiedTime)
             ),
             CONVERT(datetime, CONVERT(date, Master.EffDate))
         )
END)';
END;

DECLARE @ImExSql nvarchar(max);

SET @ImExSql = N'
INSERT INTO #ImExSource
(
    DocumentCode,
    ProductCode,
    BusinessDate,
    DocumentType,
    DocumentStatus,
    InventoryNetQty,
    IsReceiptDocument,
    ReceiptCandidateDateTime
)
SELECT
    Master.Code,
    Detail.Product,
    CONVERT(date, Master.EffDate),
    Master.DocumentType,
    Master.DocumentStatus,

    CONVERT
    (
        decimal(38, 6),
        CASE
            WHEN Master.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
                 AND Master.DocumentStatus = 3
                THEN COALESCE(Detail.QtyReceived, 0)

            WHEN Master.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
                 AND Master.DocumentStatus = 2
                THEN COALESCE(Detail.Quantity, 0)

            WHEN Master.DocumentType IN (5, 6, 7, 8, 9, 10, 20, 30, 40, 52)
                 AND Master.DocumentStatus = 6
                THEN -COALESCE(Detail.QtyReceived, 0)

            WHEN Master.DocumentType IN (5, 6, 7, 8, 9, 20, 30, 40, 52)
                 AND Master.DocumentStatus = 5
                THEN -COALESCE(Detail.QtyReceived, 0)

            ELSE 0
        END
    ),

    CONVERT
    (
        bit,
        CASE
            WHEN Master.DocumentType = 1
                 AND Master.DocumentStatus IN (2, 3)
                THEN 1
            ELSE 0
        END
    ),

    ' + @ReceiptCandidateExpr + N'
FROM dbo.tbl_OPSImExDetails AS Detail
INNER JOIN dbo.tbl_OPSImExMaster AS Master
    ON Master.Code = Detail.DocumentNo
INNER JOIN #TargetProducts AS Product
    ON Product.ProductCode = Detail.Product
WHERE
    Master.EffDate >= @FromDate
    AND Master.EffDate < DATEADD(day, 1, @ToDate)
    AND
    (
        (
            Master.DocumentType IN (1, 2, 3, 4, 21, 31, 41, 50)
            AND Master.DocumentStatus IN (2, 3)
        )
        OR
        (
            Master.DocumentType IN (5, 6, 7, 8, 9, 10, 20, 30, 40, 52)
            AND Master.DocumentStatus = 6
        )
        OR
        (
            Master.DocumentType IN (5, 6, 7, 8, 9, 20, 30, 40, 52)
            AND Master.DocumentStatus = 5
        )
    )
OPTION (RECOMPILE);';

EXEC sys.sp_executesql
    @ImExSql,
    N'@FromDate date, @ToDate date',
    @FromDate = @ExtractStartDate,
    @ToDate = @StockSnapshotDate;

CREATE CLUSTERED INDEX IX_ImExSource_Product_Date
    ON #ImExSource (ProductCode, BusinessDate);

CREATE NONCLUSTERED INDEX IX_ImExSource_Receipt
    ON #ImExSource (IsReceiptDocument, ProductCode, BusinessDate);


/* =================================================================================================
   9. GOM BIẾN ĐỘNG TỒN THEO PRODUCT + DATE

   Công thức:
       DailyNetMovement
           = ImExNetQty
           - PosStockSalesQty
           + PosReturnQty

   Phần sales dùng cho Demand Planning vẫn là SUM(Qty) không lọc.
   Phần POS dùng để tính tồn mới áp dụng TransactionType/RePosDetails.
   ================================================================================================= */

CREATE TABLE #DailyMovement
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    ImExNetQty decimal(38, 6) NOT NULL,
    PosStockSalesQty decimal(38, 6) NOT NULL,
    PosReturnQty decimal(38, 6) NOT NULL,
    DailyNetMovement decimal(38, 6) NOT NULL,
    PRIMARY KEY (ProductCode, BusinessDate)
);

INSERT INTO #DailyMovement
(
    ProductCode,
    BusinessDate,
    ImExNetQty,
    PosStockSalesQty,
    PosReturnQty,
    DailyNetMovement
)
SELECT
    Movement.ProductCode,
    Movement.BusinessDate,
    SUM(Movement.ImExNetQty),
    SUM(Movement.PosStockSalesQty),
    SUM(Movement.PosReturnQty),
    SUM
    (
        Movement.ImExNetQty
        - Movement.PosStockSalesQty
        + Movement.PosReturnQty
    )
FROM
(
    SELECT
        ImEx.ProductCode,
        ImEx.BusinessDate,
        ImEx.InventoryNetQty AS ImExNetQty,
        CONVERT(decimal(38, 6), 0) AS PosStockSalesQty,
        CONVERT(decimal(38, 6), 0) AS PosReturnQty
    FROM #ImExSource AS ImEx

    UNION ALL

    SELECT
        Pos.ProductCode,
        Pos.BusinessDate,
        CONVERT(decimal(38, 6), 0),
        CONVERT
        (
            decimal(38, 6),
            CASE
                WHEN Pos.TransactionType = 2
                     AND Pos.HasRePosDetails = 0
                    THEN Pos.Qty
                ELSE 0
            END
        ),
        CONVERT
        (
            decimal(38, 6),
            CASE
                WHEN Pos.TransactionType = 3
                    THEN Pos.Qty

                WHEN Pos.TransactionType = 2
                     AND Pos.HasRePosDetails = 1
                    THEN Pos.Qty

                ELSE 0
            END
        )
    FROM #PosSource AS Pos
) AS Movement
WHERE Movement.BusinessDate >= @ExtractStartDate
  AND Movement.BusinessDate <= @StockSnapshotDate
GROUP BY
    Movement.ProductCode,
    Movement.BusinessDate;


/* =================================================================================================
   10. ĐƯA TỒN HIỆN TẠI QUAY VỀ CUỐI NGÀY OUTPUTENDDATE

   Vì tbl_LSProduct.Quantity là tồn hiện tại, muốn biết tồn tại 14/02/2026 phải:
       CurrentStock
       - tổng biến động từ 15/02/2026 đến ngày mốc tồn hiện tại.

   Sau đó mới dựng ngược từng ngày trong khoảng đầu ra.
   ================================================================================================= */

CREATE TABLE #StockAtOutputEnd
(
    ProductCode int NOT NULL PRIMARY KEY,
    CurrentStock decimal(38, 6) NULL,
    PostOutputMovement decimal(38, 6) NOT NULL,
    CloseStockAtOutputEnd decimal(38, 6) NULL
);

INSERT INTO #StockAtOutputEnd
(
    ProductCode,
    CurrentStock,
    PostOutputMovement,
    CloseStockAtOutputEnd
)
SELECT
    Product.ProductCode,
    Product.CurrentStock,
    CONVERT
    (
        decimal(38, 6),
        COALESCE
        (
            SUM
            (
                CASE
                    WHEN Movement.BusinessDate > @OutputEndDate
                         AND Movement.BusinessDate <= @StockSnapshotDate
                        THEN Movement.DailyNetMovement
                    ELSE 0
                END
            ),
            0
        )
    ) AS PostOutputMovement,

    CASE
        WHEN Product.CurrentStock IS NULL
            THEN NULL

        ELSE
            Product.CurrentStock
            - CONVERT
              (
                  decimal(38, 6),
                  COALESCE
                  (
                      SUM
                      (
                          CASE
                              WHEN Movement.BusinessDate > @OutputEndDate
                                   AND Movement.BusinessDate <= @StockSnapshotDate
                                  THEN Movement.DailyNetMovement
                              ELSE 0
                          END
                      ),
                      0
                  )
              )
    END AS CloseStockAtOutputEnd
FROM #TargetProducts AS Product
LEFT JOIN #DailyMovement AS Movement
    ON Movement.ProductCode = Product.ProductCode
GROUP BY
    Product.ProductCode,
    Product.CurrentStock;


/* =================================================================================================
   11. DỰNG OPENSTOCK/CLOSESTOCK THEO NGÀY

   Với ngày d:
       OpenStock(d)
           = CloseStockAtOutputEnd
             - tổng DailyNetMovement từ d đến OutputEndDate

       CloseStock(d)
           = OpenStock(d) + DailyNetMovement(d)

   Công thức bảo đảm:
       OpenStock hôm nay = CloseStock hôm trước.
   ================================================================================================= */

CREATE TABLE #StockDaily
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,

    OpenStock decimal(38, 6) NULL,
    CloseStock decimal(38, 6) NULL,

    ImExNetQty decimal(38, 6) NOT NULL,
    PosStockSalesQty decimal(38, 6) NOT NULL,
    PosReturnQty decimal(38, 6) NOT NULL,
    DailyNetMovement decimal(38, 6) NOT NULL,

    HasInventoryMovement bit NOT NULL,
    StockCalculationStatus varchar(30) NOT NULL,

    PRIMARY KEY (ProductCode, BusinessDate)
);

;WITH ProductDates AS
(
    SELECT
        Calendar.ProductCode,
        Calendar.BusinessDate,
        Anchor.CurrentStock,
        Anchor.CloseStockAtOutputEnd,

        CONVERT(decimal(38, 6), COALESCE(Movement.ImExNetQty, 0))
            AS ImExNetQty,

        CONVERT(decimal(38, 6), COALESCE(Movement.PosStockSalesQty, 0))
            AS PosStockSalesQty,

        CONVERT(decimal(38, 6), COALESCE(Movement.PosReturnQty, 0))
            AS PosReturnQty,

        CONVERT(decimal(38, 6), COALESCE(Movement.DailyNetMovement, 0))
            AS DailyNetMovement
    FROM #ProductCalendar AS Calendar
    INNER JOIN #StockAtOutputEnd AS Anchor
        ON Anchor.ProductCode = Calendar.ProductCode
    LEFT JOIN #DailyMovement AS Movement
        ON Movement.ProductCode = Calendar.ProductCode
       AND Movement.BusinessDate = Calendar.BusinessDate
),
ReverseMovement AS
(
    SELECT
        ProductDates.*,

        SUM(DailyNetMovement) OVER
        (
            PARTITION BY ProductCode
            ORDER BY BusinessDate DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS MovementFromDateToOutputEnd
    FROM ProductDates
),
CalculatedStock AS
(
    SELECT
        ReverseMovement.*,

        CASE
            WHEN CurrentStock IS NULL
                THEN NULL
            ELSE
                CloseStockAtOutputEnd - MovementFromDateToOutputEnd
        END AS CalculatedOpenStock,

        CASE
            WHEN CurrentStock IS NULL
                THEN NULL
            ELSE
                CloseStockAtOutputEnd
                - MovementFromDateToOutputEnd
                + DailyNetMovement
        END AS CalculatedCloseStock
    FROM ReverseMovement
)
INSERT INTO #StockDaily
(
    ProductCode,
    BusinessDate,
    OpenStock,
    CloseStock,
    ImExNetQty,
    PosStockSalesQty,
    PosReturnQty,
    DailyNetMovement,
    HasInventoryMovement,
    StockCalculationStatus
)
SELECT
    ProductCode,
    BusinessDate,
    CalculatedOpenStock,
    CalculatedCloseStock,
    ImExNetQty,
    PosStockSalesQty,
    PosReturnQty,
    DailyNetMovement,

    CONVERT
    (
        bit,
        CASE
            WHEN ImExNetQty <> 0
                 OR PosStockSalesQty <> 0
                 OR PosReturnQty <> 0
                THEN 1
            ELSE 0
        END
    ),

    CASE
        WHEN CurrentStock IS NULL
            THEN 'ANCHOR_MISSING'

        WHEN CalculatedOpenStock < 0
             OR CalculatedCloseStock < 0
            THEN 'NEGATIVE_STOCK'

        ELSE 'CALCULATED'
    END
FROM CalculatedStock;


/* Kiểm tra bắt buộc:
   tồn đầu hôm nay phải bằng tồn cuối hôm trước. */
IF EXISTS
(
    SELECT 1
    FROM #StockDaily AS Today
    INNER JOIN #StockDaily AS PreviousDay
        ON PreviousDay.ProductCode = Today.ProductCode
       AND PreviousDay.BusinessDate = DATEADD(day, -1, Today.BusinessDate)
    WHERE Today.OpenStock IS NOT NULL
      AND PreviousDay.CloseStock IS NOT NULL
      AND ABS(Today.OpenStock - PreviousDay.CloseStock) > 0.000001
)
BEGIN
    RAISERROR(N'Chuỗi tồn không liên tục: OpenStock hôm nay khác CloseStock hôm trước.', 16, 1);
    RETURN;
END;


/* =================================================================================================
   12. PHIẾU NHẬP ĐẦU TIÊN THEO PRODUCT + DATE

   - Chỉ DocumentType = 1.
   - Chỉ DocumentStatus IN (2, 3).
   - Ngày ghép luôn là EffDate.
   - Nếu không còn giờ thật thì ReceiptHour/ReceiptTime để NULL.
   ================================================================================================= */

CREATE TABLE #FirstReceipt
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    FirstReceiptCode int NULL,
    FirstReceiptDateTime datetime NULL,
    PRIMARY KEY (ProductCode, BusinessDate)
);

;WITH ReceiptByDocument AS
(
    SELECT
        Receipt.ProductCode,
        Receipt.BusinessDate,
        Receipt.DocumentCode,
        MIN(Receipt.ReceiptCandidateDateTime) AS ReceiptDateTime
    FROM #ImExSource AS Receipt
    WHERE Receipt.IsReceiptDocument = 1
      AND Receipt.BusinessDate >= @ExtractStartDate
      AND Receipt.BusinessDate <= @OutputEndDate
    GROUP BY
        Receipt.ProductCode,
        Receipt.BusinessDate,
        Receipt.DocumentCode
),
RankedReceipt AS
(
    SELECT
        ReceiptByDocument.*,

        ROW_NUMBER() OVER
        (
            PARTITION BY ProductCode, BusinessDate
            ORDER BY
                CASE WHEN ReceiptDateTime IS NULL THEN 1 ELSE 0 END,
                ReceiptDateTime,
                DocumentCode
        ) AS ReceiptOrder
    FROM ReceiptByDocument
)
INSERT INTO #FirstReceipt
(
    ProductCode,
    BusinessDate,
    FirstReceiptCode,
    FirstReceiptDateTime
)
SELECT
    ProductCode,
    BusinessDate,
    DocumentCode,
    ReceiptDateTime
FROM RankedReceipt
WHERE ReceiptOrder = 1;


/* =================================================================================================
   13. GOM SALES VỀ MỘT DÒNG CHO MỖI PRODUCT + DATE

   #SalesBase vẫn giữ riêng các nhóm Discount/CTKM để:
       - không mất Sales;
       - xác định CTKM chính;
       - kiểm tra Promotion.Type và Promotion.PromotionType.

   #DailySales chỉ cộng tất cả các nhóm đó thành tổng số bán trong ngày.
   Đây là mức dữ liệu Demand Planning cần sử dụng.
   ================================================================================================= */

CREATE TABLE #DailySales
(
    ProductCode int NOT NULL,
    BusinessDate date NOT NULL,
    Sales decimal(38, 6) NULL,
    PRIMARY KEY (ProductCode, BusinessDate)
);

INSERT INTO #DailySales
(
    ProductCode,
    BusinessDate,
    Sales
)
SELECT
    Sales.ProductCode,
    Sales.BusinessDate,
    SUM(Sales.Sales)
FROM #SalesBase AS Sales
GROUP BY
    Sales.ProductCode,
    Sales.BusinessDate;

SELECT
    @SalesDayCountBefore = COUNT_BIG(*)
FROM #DailySales;


/* =================================================================================================
   14. KẾT QUẢ CUỐI TỐI GIẢN CHO DEMAND PLANNING

   Mỗi StoreCode + ProductCode + BusinessDate có đúng một dòng.

   Chỉ xuất những trường Demand Planning thực sự cần:
       - nhận diện mã hàng và ngày;
       - phân biệt ngày có dòng bán với ngày lịch được tạo thêm;
       - số bán;
       - giá thường dùng cho ABC;
       - CTKM chính của ngày;
       - tồn đầu, tồn cuối;
       - giờ nhập đầu tiên;
       - tình trạng chất lượng tồn.

   Quy tắc PromotionClass:
       NO_PROMOTION
           => giữ Sales làm Baseline.

       ALWAYS_ON
           => giữ Sales làm Baseline;
              KHÔNG đưa ngày này qua bước bóc tách khuyến mãi.

       DEEP_PROMO
           => đưa sang Chặng 4 để tìm mức bán tự nhiên.

       PROMOTION_UNRESOLVED
           => cần xem xét, không tự kết luận.
   ================================================================================================= */

CREATE TABLE #FinalResult
(
    StoreCode int NOT NULL,
    ProductCode int NOT NULL,
    Barcode nvarchar(100) NULL,
    ProductName nvarchar(500) NULL,
    BusinessDate date NOT NULL,

    HasSalesRecord bit NOT NULL,
    Sales decimal(38, 6) NULL,

    /* Đơn giá thường dùng để xếp nhóm ABC. */
    Price decimal(38, 6) NULL,

    /* CTKM chính của Product + Date.
       Nếu ngày có nhiều CTKM, DEEP_PROMO được ưu tiên;
       sau đó chọn CTKM có Sales lớn nhất. */
    PromotionCode int NULL,
    PromotionName nvarchar(500) NULL,
    PromotionStartDate date NULL,
    PromotionEndDate date NULL,

    /* PromotionType = phân loại như KM thường, giờ vàng...
       PromotionMechanismType = tbl_POLPromotion.[Type],
       dùng nhận diện combo/giftset/xả kho/... */
    PromotionType int NULL,
    PromotionMechanismType int NULL,

    /* NO_PROMOTION / ALWAYS_ON / DEEP_PROMO / PROMOTION_UNRESOLVED */
    PromotionClass varchar(30) NOT NULL,

    OpenStock decimal(38, 6) NULL,
    CloseStock decimal(38, 6) NULL,

    /* Giờ nhập đầu tiên trong ngày.
       NULL nghĩa là không có phiếu nhập hoặc nguồn không còn giờ thật. */
    ReceiptHour int NULL,

    /* CALCULATED / NEGATIVE_STOCK / ANCHOR_MISSING */
    StockStatus varchar(30) NOT NULL,

    PRIMARY KEY (StoreCode, ProductCode, BusinessDate)
);

INSERT INTO #FinalResult
(
    StoreCode,
    ProductCode,
    Barcode,
    ProductName,
    BusinessDate,
    HasSalesRecord,
    Sales,
    Price,
    PromotionCode,
    PromotionName,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType,
    PromotionMechanismType,
    PromotionClass,
    OpenStock,
    CloseStock,
    ReceiptHour,
    StockStatus
)
SELECT
    @StoreCode,
    Calendar.ProductCode,
    Product.Barcode,
    Product.ProductName,
    Calendar.BusinessDate,

    CONVERT
    (
        bit,
        CASE
            WHEN DailySales.ProductCode IS NULL THEN 0
            ELSE 1
        END
    ) AS HasSalesRecord,

    /* Không có dòng bán thật => NULL, không tự đổi thành 0. */
    DailySales.Sales,

    RegularPrice.RegularPriceForABC,

    PrimaryPromotion.PrimaryPromotionCode,
    PrimaryPromotion.PrimaryPromotionName,
    PrimaryPromotion.PrimaryPromotionStartDate,
    PrimaryPromotion.PrimaryPromotionEndDate,
    PrimaryPromotion.PrimaryPromotionType,
    PrimaryPromotion.PrimaryPromotionMechanismType,

    COALESCE(PrimaryPromotion.DayPromotionClass, 'NO_PROMOTION')
        AS PromotionClass,

    Stock.OpenStock,
    Stock.CloseStock,

    DATEPART(hour, Receipt.FirstReceiptDateTime),

    Stock.StockCalculationStatus
FROM #ProductCalendar AS Calendar
INNER JOIN #TargetProducts AS Product
    ON Product.ProductCode = Calendar.ProductCode
LEFT JOIN #DailySales AS DailySales
    ON DailySales.ProductCode = Calendar.ProductCode
   AND DailySales.BusinessDate = Calendar.BusinessDate
LEFT JOIN #RegularPrice AS RegularPrice
    ON RegularPrice.ProductCode = Calendar.ProductCode
LEFT JOIN #PrimaryPromotion AS PrimaryPromotion
    ON PrimaryPromotion.ProductCode = Calendar.ProductCode
   AND PrimaryPromotion.BusinessDate = Calendar.BusinessDate
INNER JOIN #StockDaily AS Stock
    ON Stock.ProductCode = Calendar.ProductCode
   AND Stock.BusinessDate = Calendar.BusinessDate
LEFT JOIN #FirstReceipt AS Receipt
    ON Receipt.ProductCode = Calendar.ProductCode
   AND Receipt.BusinessDate = Calendar.BusinessDate;


/* =================================================================================================
   15. KIỂM TRA BẢO TOÀN DỮ LIỆU
   ================================================================================================= */

/* 15.1. Tổng Sales sau khi gom theo ngày phải bằng tổng Sales từ #SalesBase. */
SELECT
    @SalesDayCountAfter =
        SUM(CASE WHEN HasSalesRecord = 1 THEN CONVERT(bigint, 1) ELSE CONVERT(bigint, 0) END),
    @SalesQtyAfter =
        SUM(CASE WHEN HasSalesRecord = 1 THEN COALESCE(Sales, 0) ELSE 0 END)
FROM #FinalResult;

IF @SalesDayCountBefore <> @SalesDayCountAfter
BEGIN
    RAISERROR
    (
        N'Số ngày có sales đã thay đổi sau khi ghép lịch, tồn và CTKM.',
        16,
        1
    );
    RETURN;
END;

IF @SalesQtyBefore <> @SalesQtyAfter
BEGIN
    RAISERROR
    (
        N'Tổng Sales đã thay đổi sau khi gom về một dòng ProductCode + Date.',
        16,
        1
    );
    RETURN;
END;


/* 15.2. Mỗi ProductCode + Date trong lịch phải có đúng một dòng kết quả.
   PRIMARY KEY đã ngăn trùng; kiểm tra dưới đây bảo đảm không bị thiếu. */
IF EXISTS
(
    SELECT 1
    FROM #ProductCalendar AS Calendar
    LEFT JOIN #FinalResult AS Final
        ON Final.ProductCode = Calendar.ProductCode
       AND Final.BusinessDate = Calendar.BusinessDate
       AND Final.StoreCode = @StoreCode
    WHERE Final.ProductCode IS NULL
)
BEGIN
    RAISERROR
    (
        N'Có ProductCode + Date trong lịch không xuất hiện ở kết quả cuối.',
        16,
        1
    );
    RETURN;
END;


/* 15.3. Ngày không có dòng bán thật phải giữ Sales = NULL. */
IF EXISTS
(
    SELECT 1
    FROM #FinalResult
    WHERE HasSalesRecord = 0
      AND Sales IS NOT NULL
)
BEGIN
    RAISERROR
    (
        N'Ngày không có dòng bán thật đã bị gán Sales khác NULL.',
        16,
        1
    );
    RETURN;
END;


/* 15.4. Ngày có Sales nhưng không có CTKM phải là NO_PROMOTION. */
IF EXISTS
(
    SELECT 1
    FROM #FinalResult
    WHERE PromotionCode IS NULL
      AND PromotionClass NOT IN ('NO_PROMOTION', 'PROMOTION_UNRESOLVED')
)
BEGIN
    RAISERROR
    (
        N'Có ngày không có PromotionCode nhưng PromotionClass không hợp lệ.',
        16,
        1
    );
    RETURN;
END;


/* 15.5. Kiểm tra quy tắc Type 2 hoặc 7 phải được nhận diện DEEP_PROMO. */
IF EXISTS
(
    SELECT 1
    FROM #FinalResult
    WHERE PromotionMechanismType IN (2, 7)
      AND PromotionClass <> 'DEEP_PROMO'
)
BEGIN
    RAISERROR
    (
        N'Có Promotion Type 2/7 chưa được phân loại DEEP_PROMO.',
        16,
        1
    );
    RETURN;
END;


/* 15.6. Các ngày ALWAYS_ON được giữ nguyên Sales để Demand Planning tính Baseline.
   Query không tạo Baseline tại đây; kiểm tra chỉ bảo đảm Sales vẫn còn nguyên. */
IF EXISTS
(
    SELECT 1
    FROM #FinalResult AS Final
    INNER JOIN #DailySales AS DailySales
        ON DailySales.ProductCode = Final.ProductCode
       AND DailySales.BusinessDate = Final.BusinessDate
    WHERE Final.PromotionClass = 'ALWAYS_ON'
      AND
      (
          Final.HasSalesRecord <> 1
          OR Final.Sales <> DailySales.Sales
      )
)
BEGIN
    RAISERROR
    (
        N'Sales của ngày ALWAYS_ON đã bị thay đổi hoặc bị mất.',
        16,
        1
    );
    RETURN;
END;


/* =================================================================================================
   16. RESULT SET DUY NHẤT — HỢP ĐỒNG ĐẦU VÀO DEMAND PLANNING
   ================================================================================================= */

SELECT
    StoreCode,
    ProductCode,
    Barcode,
    ProductName,
    BusinessDate AS [Date],

    HasSalesRecord,
    Sales,

    Price,

    PromotionCode,
    PromotionName,
    PromotionStartDate,
    PromotionEndDate,
    PromotionType,
    PromotionMechanismType,
    PromotionClass,

    OpenStock,
    CloseStock,
    ReceiptHour,
    StockStatus
FROM #FinalResult
ORDER BY
    ProductCode ASC,
    BusinessDate ASC;


/* =================================================================================================
   17. DỌN BẢNG TẠM
   ================================================================================================= */

DROP TABLE #FinalResult;
DROP TABLE #DailySales;
DROP TABLE #FirstReceipt;
DROP TABLE #StockDaily;
DROP TABLE #StockAtOutputEnd;
DROP TABLE #DailyMovement;
DROP TABLE #ImExSource;
DROP TABLE #PrimaryPromotion;
DROP TABLE #PromotionDayAgg;
DROP TABLE #RegularPrice;
DROP TABLE #PriceCandidates;
DROP TABLE #SalesBase;
DROP TABLE #PosSource;
DROP TABLE #ProductCalendar;
DROP TABLE #Calendar;
DROP TABLE #TargetProducts;
DROP TABLE #RequestedProducts;


/* =================================================================================================
   GỢI Ý CHỈ MỤC CHO DBA — KHÔNG TỰ CHẠY TRONG QUERY NÀY

   Chỉ xem xét sau khi DBA kiểm tra chỉ mục hiện có:

   1. tbl_SALPoSDetails
          (Product, PoSMaster)
          INCLUDE (Qty, Amount, DiscountAmount, Discount, RePosDetails)

   2. tbl_SALPoSMaster
          (EffDate, Code)
          INCLUDE (TransactionType)

   3. tbl_OPSImExDetails
          (Product, DocumentNo)
          INCLUDE (Quantity, QtyReceived)

   4. tbl_OPSImExMaster
          (EffDate, Code, DocumentType, DocumentStatus)
          INCLUDE (ReceiptDate)

   5. tbl_POLBundle
          (Code)
          INCLUDE (Promotion)

   6. tbl_POLPromotion
          (Code)
          INCLUDE (Promotion, StartDate, EndDate, PromotionType, [Type])

   Query đã tránh:
       - N+1;
       - vòng lặp theo từng mã hàng;
       - đọc POS lặp lại cho sales và stock;
       - đọc nhập/xuất lặp lại cho stock và receipt;
       - tạo lịch từ năm 2022 đến ngày hiện tại.

   Khi chạy toàn bộ danh mục và nhiều cửa hàng:
       - chạy riêng từng DB cửa hàng;
       - lưu kết quả theo cửa hàng và khoảng thời gian;
       - không xuất toàn bộ nhiều triệu dòng vào một CSV duy nhất.
   ================================================================================================= */
