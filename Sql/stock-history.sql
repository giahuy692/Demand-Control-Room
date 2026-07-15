USE [POS];
SET NOCOUNT ON;

/* =====================================================================
   TÁI DỰNG LỊCH SỬ TỒN KHO THEO NGÀY CHO NHIỀU BARCODE

   ĐẦU RA VÀ Ý NGHĨA:

   1. ProductCode
      - Mã sản phẩm nội bộ.
      - Nguồn: tbl_LSProduct.Code.
      - Là khóa kỹ thuật để liên kết với lịch sử bán hàng:

            StockHistory.ProductCode = SalesHistory.ProductCode
            StockHistory.Date        = SalesHistory.Date

   2. Barcode
      - Mã vạch định danh sản phẩm.
      - Nguồn: tbl_LSProduct.Barcode.

   3. ProductName
      - Tên tiếng Việt của sản phẩm.
      - Nguồn: tbl_LSProduct.VName.
      - Chỉ dùng để UI hiển thị.

   4. Date
      - Ngày tồn kho đang được tái dựng.

   5. OpenStock
      - Tồn đầu ngày.
      - Bằng CloseStock của ngày liền trước.
      - Công thức:

            OpenStock(D)
                = CloseStock(D - 1)

   6. CloseStock
      - Tồn cuối ngày sau toàn bộ biến động trong ngày.
      - Công thức:

            CloseStock
                = OpenStock + DailyNetMovement

   7. FirstReceiptCode
      - Code phiếu nhập hàng đầu tiên trong ngày.
      - Chỉ xét phiếu có DocumentType = 1.

   8. ReceiptHour
      - Giờ của phiếu nhập đầu tiên trong ngày.
      - Giá trị từ 0 đến 23.
      - NULL nếu ngày đó không có phiếu nhập loại 1.

   9. FirstReceiptQty
      - Tổng số lượng sản phẩm thuộc phiếu nhập đầu tiên trong ngày.
      - NULL nếu ngày đó không có phiếu nhập.

   BẢN CHẤT DỮ LIỆU:

   Database không lưu snapshot tồn theo ngày.

   Query tái dựng ngược từ:

       tbl_LSProduct.Quantity

   kết hợp với toàn bộ biến động:

       - Phiếu nhập.
       - Phiếu xuất.
       - Điều chuyển hoặc loại chứng từ liên quan.
       - Bán hàng POS.

   QUY TẮC POS:

   - Không lọc RePosDetails.
   - Không ép TransactionType = 2.
   - Biến động tồn do POS được tính:

         PosMovement = -SUM(Qty)

   Nếu Qty âm, phép trừ Qty âm sẽ tự cộng lại tồn kho.

   GIỚI HẠN:

   - Độ chính xác phụ thuộc lịch sử chứng từ còn đầy đủ.
   - Nếu đã xóa chứng từ cũ hoặc điều chỉnh tồn thủ công mà không có
     transaction tương ứng, tồn lịch sử có thể bị lệch.
   - Đây là số liệu tái dựng, không phải snapshot gốc được lưu tại thời điểm đó.
   ===================================================================== */


/* =====================================================================
   1. KHOẢNG NGÀY CẦN TRẢ KẾT QUẢ

   FromDate:
       Ngày đầu tiên cần lấy lịch sử.

   ToDate:
       Ngày cuối cùng cần lấy lịch sử.

   ToDate cố định theo watermark bán hàng đã chốt.
   ===================================================================== */

DECLARE @FromDate date;
DECLARE @ToDate date;
DECLARE @AnchorDate date;
DECLARE @TopProducts int;

SET @FromDate = '2022-01-01';
SET @ToDate = '2026-02-14';
SET @TopProducts = 50;

/*
   Ngày neo tái dựng.

   CurrentStock trong tbl_LSProduct.Quantity được xem là tồn hiện tại
   tại thời điểm chạy query.
*/
SET @AnchorDate = CONVERT(date, GETDATE());


/* =====================================================================
   2. KIỂM TRA KHOẢNG NGÀY
   ===================================================================== */

IF @FromDate IS NULL
BEGIN
    RAISERROR(
        N'FromDate không được để trống.',
        16,
        1
    );

    RETURN;
END;


IF @ToDate IS NULL
BEGIN
    RAISERROR(
        N'ToDate không được để trống.',
        16,
        1
    );

    RETURN;
END;


IF @FromDate > @ToDate
BEGIN
    RAISERROR(
        N'FromDate không được lớn hơn ToDate.',
        16,
        1
    );

    RETURN;
END;


IF @ToDate > @AnchorDate
BEGIN
    RAISERROR(
        N'ToDate không được lớn hơn ngày hiện tại.',
        16,
        1
    );

    RETURN;
END;


/* =====================================================================
   3. DANH SÁCH BARCODE ĐẦU VÀO
   ===================================================================== */

IF OBJECT_ID('tempdb..#InputBarcodes') IS NOT NULL
BEGIN
    DROP TABLE #InputBarcodes;
END;


CREATE TABLE #InputBarcodes
(
    Barcode nvarchar(100) NOT NULL
        PRIMARY KEY
);


INSERT INTO #InputBarcodes (Barcode)
SELECT DISTINCT [Barcode]
FROM [tbl_LSProduct]
WHERE [Code] IN (
    /* Cung tap top SKU va cung cutoff voi sales-history.sql. */
    SELECT TOP (@TopProducts)
        PosDetail.[Product]
    FROM [POS].[dbo].[tbl_SALPoSDetails] AS PosDetail
    INNER JOIN [POS].[dbo].[tbl_SALPoSMaster] AS PosMaster
        ON PosMaster.[Code] = PosDetail.[PoSMaster]
    WHERE PosMaster.[TransactionDate] < DATEADD(DAY, 1, @ToDate)
    GROUP BY PosDetail.[Product]
    ORDER BY
        SUM(COALESCE(PosDetail.[Qty], 0)) DESC,
        PosDetail.[Product] ASC
)
AND [Barcode] IS NOT NULL;

/* =====================================================================
   4. MAP BARCODE SANG PRODUCT CODE

   CurrentStock:
       Tồn hiện tại trong tbl_LSProduct.Quantity.

   Đây là điểm neo để tái dựng lịch sử tồn ngược về quá khứ.
   ===================================================================== */

IF OBJECT_ID('tempdb..#TargetProducts') IS NOT NULL
BEGIN
    DROP TABLE #TargetProducts;
END;


CREATE TABLE #TargetProducts
(
    ProductCode int NOT NULL,

    Barcode nvarchar(100) NOT NULL,

    ProductName nvarchar(500) NULL,

    CurrentStock decimal(38, 6) NOT NULL,

    PRIMARY KEY
    (
        ProductCode
    )
);


INSERT INTO #TargetProducts
(
    ProductCode,
    Barcode,
    ProductName,
    CurrentStock
)
SELECT
    Product.Code AS ProductCode,

    CONVERT(
        nvarchar(100),
        Product.Barcode
    ) AS Barcode,

    NULLIF(
        LTRIM(
            RTRIM(
                CONVERT(
                    nvarchar(500),
                    Product.VName
                )
            )
        ),
        N''
    ) AS ProductName,

    CAST(
        COALESCE(
            Product.Quantity,
            0
        )
        AS decimal(38, 6)
    ) AS CurrentStock

FROM #InputBarcodes AS InputBarcode

INNER JOIN dbo.tbl_LSProduct AS Product
    ON Product.Barcode = InputBarcode.Barcode;


/* =====================================================================
   5. KIỂM TRA BARCODE KHÔNG TÌM THẤY
   ===================================================================== */

DECLARE @MissingCount int;
DECLARE @MissingList nvarchar(max);


SELECT
    @MissingCount = COUNT(*)
FROM #InputBarcodes AS InputBarcode

LEFT JOIN #TargetProducts AS TargetProduct
    ON TargetProduct.Barcode = InputBarcode.Barcode

WHERE TargetProduct.ProductCode IS NULL;


IF @MissingCount > 0
BEGIN
    SELECT
        @MissingList =
            STUFF(
                (
                    SELECT
                        N', ' + InputBarcode.Barcode

                    FROM #InputBarcodes AS InputBarcode

                    LEFT JOIN #TargetProducts AS TargetProduct
                        ON TargetProduct.Barcode = InputBarcode.Barcode

                    WHERE TargetProduct.ProductCode IS NULL

                    ORDER BY
                        InputBarcode.Barcode

                    FOR XML PATH(N''), TYPE
                ).value(
                    N'.',
                    N'nvarchar(max)'
                ),
                1,
                2,
                N''
            );

    RAISERROR(
        N'Có %d Barcode không tìm thấy trong tbl_LSProduct: %s',
        10,
        1,
        @MissingCount,
        @MissingList
    );
END;


/* =====================================================================
   6. TẠO DANH SÁCH NGÀY

   Calendar phải chạy đến AnchorDate, không chỉ ToDate.

   Nguyên nhân:
       Để tính tồn quá khứ, query phải đảo ngược cả biến động từ
       ngày sau ToDate đến thời điểm hiện tại.
   ===================================================================== */

IF OBJECT_ID('tempdb..#Calendar') IS NOT NULL
BEGIN
    DROP TABLE #Calendar;
END;


CREATE TABLE #Calendar
(
    StockDate date NOT NULL
        PRIMARY KEY
);


;WITH CalendarData AS
(
    SELECT
        @FromDate AS StockDate

    UNION ALL

    SELECT
        DATEADD(
            DAY,
            1,
            StockDate
        )
    FROM CalendarData
    WHERE StockDate < @AnchorDate
)
INSERT INTO #Calendar
(
    StockDate
)
SELECT
    StockDate
FROM CalendarData
OPTION
(
    MAXRECURSION 0
);


/* =====================================================================
   7. TỔNG HỢP BIẾN ĐỘNG TỒN KHO THEO NGÀY

   DailyNetMovement gồm:

       InventoryMovement
           + biến động từ phiếu nhập/xuất

       PosMovement
           - Qty bán hàng POS

   DailyNetMovement dương:
       Tồn kho tăng.

   DailyNetMovement âm:
       Tồn kho giảm.
   ===================================================================== */

IF OBJECT_ID('tempdb..#DailyMovements') IS NOT NULL
BEGIN
    DROP TABLE #DailyMovements;
END;


CREATE TABLE #DailyMovements
(
    ProductCode int NOT NULL,

    MovementDate date NOT NULL,

    DailyNetMovement decimal(38, 6) NOT NULL,

    PRIMARY KEY
    (
        ProductCode,
        MovementDate
    )
);


/* =====================================================================
   7.1. TẠO TẤT CẢ BIẾN ĐỘNG, SAU ĐÓ GROUP THEO PRODUCT + DATE
   ===================================================================== */

INSERT INTO #DailyMovements
(
    ProductCode,
    MovementDate,
    DailyNetMovement
)
SELECT
    AllMovement.ProductCode,

    AllMovement.MovementDate,

    SUM(
        AllMovement.MovementQty
    ) AS DailyNetMovement

FROM
(
    /* -----------------------------------------------------------------
       A. BIẾN ĐỘNG TỪ PHIẾU NHẬP/XUẤT

       Nhóm tăng tồn:

       DocumentType:
           1, 2, 3, 4, 21, 31, 41, 50

       DocumentStatus = 3:
           Dùng QtyReceived.

       DocumentStatus = 2:
           Dùng Quantity.

       Nhóm giảm tồn:

       DocumentStatus = 6:
           DocumentType 5,6,7,8,9,10,20,30,40,52.

       DocumentStatus = 5:
           DocumentType 5,6,7,8,9,20,30,40,52.

       Logic được lấy từ quy trình cập nhật CurrentStock tham khảo.
       ----------------------------------------------------------------- */

    SELECT
        InventoryData.ProductCode,

        InventoryData.MovementDate,

        InventoryData.MovementQty

    FROM
    (
        SELECT
            StockDetail.Product AS ProductCode,

            /*
               Phiếu tăng tồn ưu tiên ReceiptDate.

               Phiếu giảm tồn ưu tiên EffDate.
            */
            CAST(
                CASE
                    WHEN StockMaster.DocumentType IN
                    (
                        1, 2, 3, 4, 21, 31, 41, 50
                    )
                        THEN COALESCE(
                            StockMaster.ReceiptDate,
                            StockMaster.EffDate
                        )

                    ELSE COALESCE(
                        StockMaster.EffDate,
                        StockMaster.ReceiptDate
                    )
                END
                AS date
            ) AS MovementDate,

            CAST(
                CASE
                    /* Phiếu tăng tồn đã nhận. */
                    WHEN StockMaster.DocumentType IN
                    (
                        1, 2, 3, 4, 21, 31, 41, 50
                    )
                    AND StockMaster.DocumentStatus = 3
                        THEN COALESCE(
                            StockDetail.QtyReceived,
                            0
                        )

                    /* Phiếu tăng tồn đang dùng Quantity. */
                    WHEN StockMaster.DocumentType IN
                    (
                        1, 2, 3, 4, 21, 31, 41, 50
                    )
                    AND StockMaster.DocumentStatus = 2
                        THEN COALESCE(
                            StockDetail.Quantity,
                            0
                        )

                    /* Phiếu giảm tồn trạng thái 6. */
                    WHEN StockMaster.DocumentType IN
                    (
                        5, 6, 7, 8, 9, 10,
                        20, 30, 40, 52
                    )
                    AND StockMaster.DocumentStatus = 6
                        THEN -COALESCE(
                            StockDetail.QtyReceived,
                            0
                        )

                    /* Phiếu giảm tồn trạng thái 5. */
                    WHEN StockMaster.DocumentType IN
                    (
                        5, 6, 7, 8, 9,
                        20, 30, 40, 52
                    )
                    AND StockMaster.DocumentStatus = 5
                        THEN -COALESCE(
                            StockDetail.QtyReceived,
                            0
                        )

                    ELSE 0
                END
                AS decimal(38, 6)
            ) AS MovementQty

        FROM dbo.tbl_OPSImExDetails AS StockDetail

        INNER JOIN dbo.tbl_OPSImExMaster AS StockMaster
            ON StockMaster.Code = StockDetail.DocumentNo

        INNER JOIN #TargetProducts AS TargetProduct
            ON TargetProduct.ProductCode = StockDetail.Product

        WHERE
        (
            StockMaster.DocumentType IN
            (
                1, 2, 3, 4, 21, 31, 41, 50
            )
            AND StockMaster.DocumentStatus IN
            (
                2, 3
            )
        )
        OR
        (
            StockMaster.DocumentType IN
            (
                5, 6, 7, 8, 9, 10,
                20, 30, 40, 52
            )
            AND StockMaster.DocumentStatus = 6
        )
        OR
        (
            StockMaster.DocumentType IN
            (
                5, 6, 7, 8, 9,
                20, 30, 40, 52
            )
            AND StockMaster.DocumentStatus = 5
        )
    ) AS InventoryData

    WHERE InventoryData.MovementDate >= @FromDate
      AND InventoryData.MovementDate <= @AnchorDate


    UNION ALL


    /* -----------------------------------------------------------------
       B. BIẾN ĐỘNG TỪ BÁN HÀNG POS

       Công thức:

           PosMovement = -Qty

       Không dùng:
           RePosDetails
           TransactionType = 2

       Nếu Qty âm:
           -Qty sẽ trở thành số dương và cộng lại tồn.
       ----------------------------------------------------------------- */

    SELECT
        PosDetail.Product AS ProductCode,

        CAST(
            PosMaster.TransactionDate
            AS date
        ) AS MovementDate,

        CAST(
            -COALESCE(
                PosDetail.Qty,
                0
            )
            AS decimal(38, 6)
        ) AS MovementQty

    FROM dbo.tbl_SALPoSDetails AS PosDetail

    INNER JOIN dbo.tbl_SALPoSMaster AS PosMaster
        ON PosMaster.Code = PosDetail.PoSMaster

    INNER JOIN #TargetProducts AS TargetProduct
        ON TargetProduct.ProductCode = PosDetail.Product

    WHERE PosMaster.TransactionDate >= @FromDate
      AND PosMaster.TransactionDate
            < DATEADD(
                DAY,
                1,
                @AnchorDate
            )
) AS AllMovement

GROUP BY
    AllMovement.ProductCode,
    AllMovement.MovementDate;


/* =====================================================================
   8. TÌM PHIẾU NHẬP LOẠI 1 ĐẦU TIÊN TRONG NGÀY

   Chỉ xét:

       DocumentType = 1
       DocumentStatus IN (2, 3)

   Thời gian phiếu nhập được ưu tiên theo:

       1. CreateTime
       2. LastModifiedTime
       3. ReceiptDate
       4. EffDate

   Query tự dò tên cột thời gian có tồn tại trong schema.
   ===================================================================== */

IF OBJECT_ID('tempdb..#FirstReceipts') IS NOT NULL
BEGIN
    DROP TABLE #FirstReceipts;
END;


CREATE TABLE #FirstReceipts
(
    ProductCode int NOT NULL,

    ReceiptDate date NOT NULL,

    FirstReceiptCode int NOT NULL,

    FirstReceiptDateTime datetime NULL,

    FirstReceiptQty decimal(38, 6) NULL,

    PRIMARY KEY
    (
        ProductCode,
        ReceiptDate
    )
);


DECLARE @ReceiptTimeColumn sysname;
DECLARE @ReceiptSql nvarchar(max);


/* Chọn cột thời gian tốt nhất đang có trong bảng. */
IF COL_LENGTH(
    N'dbo.tbl_OPSImExMaster',
    N'CreateTime'
) IS NOT NULL
BEGIN
    SET @ReceiptTimeColumn = N'CreateTime';
END;
ELSE IF COL_LENGTH(
    N'dbo.tbl_OPSImExMaster',
    N'LastModifiedTime'
) IS NOT NULL
BEGIN
    SET @ReceiptTimeColumn = N'LastModifiedTime';
END;
ELSE IF COL_LENGTH(
    N'dbo.tbl_OPSImExMaster',
    N'ReceiptDate'
) IS NOT NULL
BEGIN
    SET @ReceiptTimeColumn = N'ReceiptDate';
END;
ELSE
BEGIN
    SET @ReceiptTimeColumn = N'EffDate';
END;


/*
   Dynamic SQL chỉ dùng vì tên cột chứa thời gian có thể khác nhau
   giữa các phiên bản database.
*/
SET @ReceiptSql =
N'
;WITH ReceiptDocuments AS
(
    SELECT
        ReceiptDetail.Product AS ProductCode,

        CAST(
            COALESCE(
                ReceiptMaster.ReceiptDate,
                ReceiptMaster.EffDate,
                ReceiptMaster.' + QUOTENAME(@ReceiptTimeColumn) + N'
            )
            AS date
        ) AS ReceiptDate,

        ReceiptMaster.Code AS FirstReceiptCode,

        MIN(
            CONVERT(
                datetime,
                ReceiptMaster.' + QUOTENAME(@ReceiptTimeColumn) + N'
            )
        ) AS FirstReceiptDateTime,

        SUM(
            CAST(
                CASE
                    WHEN ReceiptMaster.DocumentStatus = 3
                        THEN COALESCE(
                            ReceiptDetail.QtyReceived,
                            0
                        )

                    WHEN ReceiptMaster.DocumentStatus = 2
                        THEN COALESCE(
                            ReceiptDetail.Quantity,
                            0
                        )

                    ELSE 0
                END
                AS decimal(38, 6)
            )
        ) AS FirstReceiptQty

    FROM dbo.tbl_OPSImExDetails AS ReceiptDetail

    INNER JOIN dbo.tbl_OPSImExMaster AS ReceiptMaster
        ON ReceiptMaster.Code = ReceiptDetail.DocumentNo

    INNER JOIN #TargetProducts AS TargetProduct
        ON TargetProduct.ProductCode = ReceiptDetail.Product

    WHERE ReceiptMaster.DocumentType = 1
      AND ReceiptMaster.DocumentStatus IN
      (
          2, 3
      )
      AND COALESCE(
            ReceiptMaster.ReceiptDate,
            ReceiptMaster.EffDate,
            ReceiptMaster.' + QUOTENAME(@ReceiptTimeColumn) + N'
          ) >= @FromDateInput
      AND COALESCE(
            ReceiptMaster.ReceiptDate,
            ReceiptMaster.EffDate,
            ReceiptMaster.' + QUOTENAME(@ReceiptTimeColumn) + N'
          ) < DATEADD(
                DAY,
                1,
                @ToDateInput
          )

    GROUP BY
        ReceiptDetail.Product,

        CAST(
            COALESCE(
                ReceiptMaster.ReceiptDate,
                ReceiptMaster.EffDate,
                ReceiptMaster.' + QUOTENAME(@ReceiptTimeColumn) + N'
            )
            AS date
        ),

        ReceiptMaster.Code
),
RankedReceipts AS
(
    SELECT
        ReceiptDocuments.ProductCode,
        ReceiptDocuments.ReceiptDate,
        ReceiptDocuments.FirstReceiptCode,
        ReceiptDocuments.FirstReceiptDateTime,
        ReceiptDocuments.FirstReceiptQty,

        ROW_NUMBER() OVER
        (
            PARTITION BY
                ReceiptDocuments.ProductCode,
                ReceiptDocuments.ReceiptDate

            ORDER BY
                COALESCE(
                    ReceiptDocuments.FirstReceiptDateTime,
                    CONVERT(
                        datetime,
                        ReceiptDocuments.ReceiptDate
                    )
                ),
                ReceiptDocuments.FirstReceiptCode
        ) AS ReceiptOrder

    FROM ReceiptDocuments
)
INSERT INTO #FirstReceipts
(
    ProductCode,
    ReceiptDate,
    FirstReceiptCode,
    FirstReceiptDateTime,
    FirstReceiptQty
)
SELECT
    RankedReceipts.ProductCode,
    RankedReceipts.ReceiptDate,
    RankedReceipts.FirstReceiptCode,
    RankedReceipts.FirstReceiptDateTime,
    RankedReceipts.FirstReceiptQty

FROM RankedReceipts

WHERE RankedReceipts.ReceiptOrder = 1;
';


EXEC sys.sp_executesql
    @ReceiptSql,
    N'
      @FromDateInput date,
      @ToDateInput date
    ',
    @FromDateInput = @FromDate,
    @ToDateInput = @ToDate;


/* =====================================================================
   9. TÁI DỰNG OPEN STOCK VÀ CLOSE STOCK

   Với mỗi sản phẩm và mỗi ngày:

       ReverseMovement(D)
           = Tổng biến động từ ngày D đến AnchorDate.

       OpenStock(D)
           = CurrentStock - ReverseMovement(D)

       CloseStock(D)
           = OpenStock(D) + DailyNetMovement(D)

   Do đó:

       OpenStock hôm nay
           = CloseStock hôm qua
   ===================================================================== */

IF OBJECT_ID('tempdb..#StockHistory') IS NOT NULL
BEGIN
    DROP TABLE #StockHistory;
END;


CREATE TABLE #StockHistory
(
    ProductCode int NOT NULL,

    Barcode nvarchar(100) NOT NULL,

    ProductName nvarchar(500) NULL,

    StockDate date NOT NULL,

    OpenStock decimal(38, 6) NOT NULL,

    CloseStock decimal(38, 6) NOT NULL,

    PRIMARY KEY
    (
        ProductCode,
        StockDate
    )
);


;WITH ProductDates AS
(
    SELECT
        TargetProduct.ProductCode,

        TargetProduct.Barcode,

        TargetProduct.ProductName,

        TargetProduct.CurrentStock,

        Calendar.StockDate,

        CAST(
            COALESCE(
                DailyMovement.DailyNetMovement,
                0
            )
            AS decimal(38, 6)
        ) AS DailyNetMovement

    FROM #TargetProducts AS TargetProduct

    CROSS JOIN #Calendar AS Calendar

    LEFT JOIN #DailyMovements AS DailyMovement
        ON DailyMovement.ProductCode =
            TargetProduct.ProductCode
       AND DailyMovement.MovementDate =
            Calendar.StockDate
),
ReverseMovements AS
(
    SELECT
        ProductDates.ProductCode,

        ProductDates.Barcode,

        ProductDates.ProductName,

        ProductDates.CurrentStock,

        ProductDates.StockDate,

        ProductDates.DailyNetMovement,

        SUM(
            ProductDates.DailyNetMovement
        ) OVER
        (
            PARTITION BY
                ProductDates.ProductCode

            ORDER BY
                ProductDates.StockDate DESC

            ROWS BETWEEN
                UNBOUNDED PRECEDING
                AND CURRENT ROW
        ) AS ReverseMovement

    FROM ProductDates
)
INSERT INTO #StockHistory
(
    ProductCode,
    Barcode,
    ProductName,
    StockDate,
    OpenStock,
    CloseStock
)
SELECT
    ReverseMovements.ProductCode,

    ReverseMovements.Barcode,

    ReverseMovements.ProductName,

    ReverseMovements.StockDate,

    /*
       OpenStock:
       Tồn trước toàn bộ biến động của ngày.
    */
    CAST(
        ReverseMovements.CurrentStock
        - ReverseMovements.ReverseMovement
        AS decimal(38, 6)
    ) AS OpenStock,

    /*
       CloseStock:
       Tồn đầu ngày cộng biến động trong ngày.
    */
    CAST(
        ReverseMovements.CurrentStock
        - ReverseMovements.ReverseMovement
        + ReverseMovements.DailyNetMovement
        AS decimal(38, 6)
    ) AS CloseStock

FROM ReverseMovements;


/* =====================================================================
   10. KẾT QUẢ CUỐI

   Chỉ trả những ngày từ FromDate đến ToDate.

   Khóa mapping với lịch sử bán:

       ProductCode + Date

   Ví dụ:

       SalesHistory.ProductCode = StockHistory.ProductCode
       SalesHistory.Date        = StockHistory.Date
   ===================================================================== */

SELECT
    /*
       ProductCode:
       Khóa kỹ thuật để map lịch sử tồn với lịch sử bán.
    */
    StockHistory.ProductCode,

    /*
       Barcode:
       Mã vạch định danh sản phẩm.
    */
    StockHistory.Barcode,

    /*
       ProductName:
       Tên tiếng Việt của sản phẩm.
    */
    StockHistory.ProductName,

    /*
       Date:
       Ngày tồn kho.
    */
    StockHistory.StockDate AS [Date],

    /*
       OpenStock:
       Tồn đầu ngày.

       Luôn bằng CloseStock của ngày trước nếu dữ liệu liên tục.
    */
    StockHistory.OpenStock,

    /*
       CloseStock:
       Tồn cuối ngày.
    */
    StockHistory.CloseStock,

    /*
       FirstReceiptCode:
       Code phiếu nhập loại 1 đầu tiên trong ngày.

       NULL nếu không có phiếu nhập.
    */
    FirstReceipt.FirstReceiptCode,

    /*
       ReceiptHour:
       Giờ của phiếu nhập đầu tiên.

       Giá trị:
           0 đến 23.

       NULL:
           Không có phiếu nhập trong ngày.
    */
    CASE
        WHEN FirstReceipt.FirstReceiptDateTime IS NULL
            THEN NULL

        ELSE DATEPART(
            HOUR,
            FirstReceipt.FirstReceiptDateTime
        )
    END AS ReceiptHour,

    /*
       FirstReceiptQty:
       Số lượng sản phẩm thuộc phiếu nhập đầu tiên trong ngày.
    */
    FirstReceipt.FirstReceiptQty

FROM #StockHistory AS StockHistory

LEFT JOIN #FirstReceipts AS FirstReceipt
    ON FirstReceipt.ProductCode =
        StockHistory.ProductCode
   AND FirstReceipt.ReceiptDate =
        StockHistory.StockDate

WHERE StockHistory.StockDate >= @FromDate
  AND StockHistory.StockDate <= @ToDate

ORDER BY
    StockHistory.Barcode,
    StockHistory.StockDate;


/* =====================================================================
   11. XÓA BẢNG TẠM
   ===================================================================== */

DROP TABLE #StockHistory;
DROP TABLE #FirstReceipts;
DROP TABLE #DailyMovements;
DROP TABLE #Calendar;
DROP TABLE #TargetProducts;
DROP TABLE #InputBarcodes;
