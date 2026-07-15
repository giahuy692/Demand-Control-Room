USE [POS];
SET NOCOUNT ON;

/* =====================================================================
   LẤY TOÀN BỘ LỊCH SỬ BÁN HÀNG CHO NHIỀU BARCODE

   ĐẦU RA VÀ Ý NGHĨA:

   1. Barcode
      - Mã vạch định danh sản phẩm.
      - Nguồn: tbl_LSProduct.Barcode.
      - Được dùng để tìm Code nội bộ của sản phẩm.

   2. ProductName
      - Tên tiếng Việt của sản phẩm.
      - Nguồn: tbl_LSProduct.VName.
      - Chỉ dùng để giao diện hiển thị.
      - Không tham gia tính demand, forecast hoặc phân loại ABC.

   3. Date
      - Ngày phát sinh giao dịch bán hàng.
      - Nguồn: tbl_SALPoSMaster.TransactionDate.
      - Chỉ lấy phần ngày.

   4. Sales
      - Tổng số lượng bán của sản phẩm trong ngày.
      - Công thức:

            Sales = SUM(tbl_SALPoSDetails.Qty)

   5. Amount
      - Tổng tiền trước giảm giá trong ngày.
      - Công thức:

            Amount = SUM(tbl_SALPoSDetails.Amount)

      - Không trừ DiscountAmount.

   6. Price
      - Đơn giá bình quân trước giảm giá.
      - Công thức:

            Price = SUM(Amount) / SUM(Qty)

      - Được sử dụng để tính giá trị tiêu thụ phục vụ phân loại ABC.
      - Có thể NULL nếu tổng Qty bằng 0.

   7. PromoCode
      - Chuỗi JSON chứa danh sách chương trình khuyến mãi áp dụng
        cho sản phẩm trong ngày.
      - Mỗi phần tử gồm:

            PromoCode: tbl_POLPromotion.Code
            PromoName: tbl_POLPromotion.Promotion

      - Nếu không có chương trình khuyến mãi:

            []

   LUỒNG TÌM DỮ LIỆU:

       Danh sách Barcode
           -> tbl_LSProduct.Barcode
           -> tbl_LSProduct.Code
           -> tbl_SALPoSDetails.Product
           -> tbl_SALPoSMaster.TransactionDate

   QUY TẮC:

   - Barcode là thông tin định danh sản phẩm đáng tin cậy.
   - Không dùng tbl_SALPoSDetails.Barcode để tìm sản phẩm.
   - Không dùng RePosDetails làm điều kiện.
   - Không ép TransactionType = 2.
   - Không tự sinh ngày không có giao dịch.
   - Không tạo record giả.
   - Không dùng FOR JSON PATH.
   - Không dùng STRING_AGG.
   ===================================================================== */


/* =====================================================================
   1. TẠO BẢNG TẠM CHỨA DANH SÁCH BARCODE ĐẦU VÀO

   Mỗi Barcode chỉ được xuất hiện một lần.
   ===================================================================== */

IF OBJECT_ID('tempdb..#InputBarcodes') IS NOT NULL
BEGIN
    DROP TABLE #InputBarcodes;
END;

CREATE TABLE #InputBarcodes
(
    Barcode varchar(100) NOT NULL
        PRIMARY KEY
);


/* =====================================================================
   2. NHẬP DANH SÁCH BARCODE CẦN LẤY LỊCH SỬ
   ===================================================================== */

INSERT INTO #InputBarcodes (Barcode)
SELECT DISTINCT [Barcode]
FROM [tbl_LSProduct]
WHERE [Code] IN (
    /* Top 100 SKU ban chay nhat theo tong luong ban — dong bo giua sales va stock. */
    SELECT TOP 100 [Product]
    FROM [POS].[dbo].[tbl_SALPoSDetails]
    GROUP BY [Product]
    ORDER BY SUM([Qty]) DESC
)
AND [Barcode] IS NOT NULL;


/* =====================================================================
   3. TẠO BẢNG TẠM CHỨA SẢN PHẨM TÌM ĐƯỢC

   ProductCode:
   - Nguồn: tbl_LSProduct.Code.
   - Dùng đối chiếu với tbl_SALPoSDetails.Product.

   Barcode:
   - Nguồn: tbl_LSProduct.Barcode.

   ProductName:
   - Nguồn: tbl_LSProduct.VName.
   ===================================================================== */

IF OBJECT_ID('tempdb..#TargetProducts') IS NOT NULL
BEGIN
    DROP TABLE #TargetProducts;
END;

CREATE TABLE #TargetProducts
(
    Barcode varchar(100) NOT NULL,

    ProductCode int NOT NULL,

    ProductName nvarchar(500) NULL,

    PRIMARY KEY
    (
        Barcode,
        ProductCode
    )
);


/* =====================================================================
   4. TÌM CODE SẢN PHẨM TỪ DANH SÁCH BARCODE

   Quan hệ:

       #InputBarcodes.Barcode
           = tbl_LSProduct.Barcode
   ===================================================================== */

INSERT INTO #TargetProducts
(
    Barcode,
    ProductCode,
    ProductName
)
SELECT DISTINCT
    CONVERT(
        varchar(100),
        Product.Barcode
    ) AS Barcode,

    Product.Code AS ProductCode,

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
    ) AS ProductName

FROM #InputBarcodes AS InputBarcode

INNER JOIN dbo.tbl_LSProduct AS Product
    ON Product.Barcode = InputBarcode.Barcode;


/* =====================================================================
   5. THÔNG BÁO BARCODE KHÔNG TÌM THẤY

   Chỉ tạo thông báo trong tab Messages.
   Không tạo thêm result set nên không làm ứng dụng đọc nhầm bảng kết quả.
   ===================================================================== */

DECLARE @MissingBarcodeCount int;
DECLARE @MissingBarcodeList nvarchar(max);

SELECT
    @MissingBarcodeCount = COUNT(*)
FROM #InputBarcodes AS InputBarcode

LEFT JOIN #TargetProducts AS TargetProduct
    ON TargetProduct.Barcode = InputBarcode.Barcode

WHERE TargetProduct.Barcode IS NULL;


IF @MissingBarcodeCount > 0
BEGIN
    SELECT
        @MissingBarcodeList =
            STUFF(
                (
                    SELECT
                        N', '
                        + CONVERT(
                            nvarchar(100),
                            InputBarcode.Barcode
                        )

                    FROM #InputBarcodes AS InputBarcode

                    LEFT JOIN #TargetProducts AS TargetProduct
                        ON TargetProduct.Barcode = InputBarcode.Barcode

                    WHERE TargetProduct.Barcode IS NULL

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
        @MissingBarcodeCount,
        @MissingBarcodeList
    );
END;


/* =====================================================================
   6. TẠO INDEX CHO DANH SÁCH SẢN PHẨM

   Giúp SQL Server join ProductCode với bảng POS nhanh hơn.
   ===================================================================== */

CREATE NONCLUSTERED INDEX IX_TargetProducts_ProductCode
ON #TargetProducts
(
    ProductCode
);


/* =====================================================================
   7. TẠO BẢNG TẠM CHỨA DỮ LIỆU BÁN THEO NGÀY

   Bảng này chỉ tồn tại trong phiên chạy hiện tại.
   Không cập nhật hoặc tạo dữ liệu trong bảng thật.
   ===================================================================== */

IF OBJECT_ID('tempdb..#DailySales') IS NOT NULL
BEGIN
    DROP TABLE #DailySales;
END;

CREATE TABLE #DailySales
(
    Barcode varchar(100) NOT NULL,

    ProductCode int NOT NULL,

    ProductName nvarchar(500) NULL,

    SaleDate date NOT NULL,

    Sales decimal(38, 6) NOT NULL,

    Amount decimal(38, 6) NOT NULL,

    Price decimal(18, 2) NULL
);


/* =====================================================================
   8. TỔNG HỢP TOÀN BỘ LỊCH SỬ BÁN HÀNG

   Không giới hạn FromDate hoặc ToDate.

   Điều kiện sản phẩm:

       tbl_SALPoSDetails.Product
           = tbl_LSProduct.Code

   Điều kiện lấy ngày:

       tbl_SALPoSDetails.PoSMaster
           = tbl_SALPoSMaster.Code

   Không sử dụng:

       RePosDetails
       TransactionType = 2
       IsApproved
       IsProcess
   ===================================================================== */

INSERT INTO #DailySales
(
    Barcode,
    ProductCode,
    ProductName,
    SaleDate,
    Sales,
    Amount,
    Price
)
SELECT
    /*
       Barcode:
       Mã vạch định danh sản phẩm.
    */
    TargetProduct.Barcode,

    /*
       ProductCode:
       Chỉ sử dụng nội bộ để join dữ liệu.
       Không được xuất ra kết quả cuối.
    */
    TargetProduct.ProductCode,

    /*
       ProductName:
       Tên tiếng Việt dùng cho UI.
    */
    TargetProduct.ProductName,

    /*
       Date:
       Ngày giao dịch thực tế.
    */
    CAST(
        PosMaster.TransactionDate
        AS date
    ) AS SaleDate,

    /*
       Sales:
       Tổng số lượng bán trong ngày.

       Công thức:
           SUM(Qty)
    */
    SUM(
        CAST(
            COALESCE(
                PosDetail.Qty,
                0
            )
            AS decimal(38, 6)
        )
    ) AS Sales,

    /*
       Amount:
       Tổng tiền trước giảm giá trong ngày.

       Công thức:
           SUM(Amount)

       Không trừ:
           DiscountAmount
    */
    SUM(
        CAST(
            COALESCE(
                PosDetail.Amount,
                0
            )
            AS decimal(38, 6)
        )
    ) AS Amount,

    /*
       Price:
       Đơn giá bình quân trước giảm giá.

       Ở cấp dòng:
           Price = Amount / Qty

       Khi tổng hợp nhiều dòng trong ngày:
           Price = SUM(Amount) / SUM(Qty)

       NULLIF ngăn lỗi chia cho 0.
    */
    CAST(
        SUM(
            CAST(
                COALESCE(
                    PosDetail.Amount,
                    0
                )
                AS decimal(38, 8)
            )
        )
        /
        NULLIF(
            SUM(
                CAST(
                    COALESCE(
                        PosDetail.Qty,
                        0
                    )
                    AS decimal(38, 8)
                )
            ),
            0
        )
        AS decimal(18, 2)
    ) AS Price

FROM #TargetProducts AS TargetProduct

INNER JOIN dbo.tbl_SALPoSDetails AS PosDetail
    ON PosDetail.Product = TargetProduct.ProductCode

INNER JOIN dbo.tbl_SALPoSMaster AS PosMaster
    ON PosMaster.Code = PosDetail.PoSMaster

/*
   Không dùng điều kiện:

       PosDetail.RePosDetails IS NULL
*/

/*
   Không dùng điều kiện:

       PosMaster.TransactionType = 2
*/

GROUP BY
    TargetProduct.Barcode,
    TargetProduct.ProductCode,
    TargetProduct.ProductName,
    CAST(
        PosMaster.TransactionDate
        AS date
    );


/* =====================================================================
   9. TẠO INDEX CHO DỮ LIỆU BÁN THEO NGÀY

   Hỗ trợ:
   - Sắp xếp kết quả.
   - Map chương trình khuyến mãi.
   ===================================================================== */

CREATE NONCLUSTERED INDEX IX_DailySales_ProductDate
ON #DailySales
(
    ProductCode,
    SaleDate
);


/* =====================================================================
   10. TẠO BẢNG TẠM CHỨA CHƯƠNG TRÌNH KHUYẾN MÃI

   Mỗi dòng tương ứng:

       Một Barcode
       + một ngày
       + một chương trình khuyến mãi

   PromoCode:
       tbl_POLPromotion.Code

   PromoName:
       tbl_POLPromotion.Promotion
   ===================================================================== */

IF OBJECT_ID('tempdb..#DailyPromotions') IS NOT NULL
BEGIN
    DROP TABLE #DailyPromotions;
END;

CREATE TABLE #DailyPromotions
(
    Barcode varchar(100) NOT NULL,

    SaleDate date NOT NULL,

    PromoCode nvarchar(100) NOT NULL,

    PromoName nvarchar(500) NOT NULL
);


/* =====================================================================
   11. MAP CHƯƠNG TRÌNH KHUYẾN MÃI THEO SKU VÀ NGÀY

   Quan hệ:

       tbl_POLBundle.Product
           = tbl_LSProduct.Code

       tbl_POLBundle.Promotion
           = tbl_POLPromotion.Code

   Điều kiện hiệu lực:

       StartDate <= ngày bán
       EndDate >= ngày bán

   EndDate NULL:
       Được hiểu là chương trình chưa có ngày kết thúc.

   DISTINCT:
       Tránh một CTKM xuất hiện nhiều lần do nhiều dòng Bundle.
   ===================================================================== */

INSERT INTO #DailyPromotions
(
    Barcode,
    SaleDate,
    PromoCode,
    PromoName
)
SELECT DISTINCT
    DailySale.Barcode,

    DailySale.SaleDate,

    COALESCE(
        CONVERT(
            nvarchar(100),
            Promotion.Code
        ),
        N''
    ) AS PromoCode,

    COALESCE(
        CONVERT(
            nvarchar(500),
            Promotion.Promotion
        ),
        N''
    ) AS PromoName

FROM #DailySales AS DailySale

INNER JOIN dbo.tbl_POLBundle AS Bundle
    ON Bundle.Product = DailySale.ProductCode

INNER JOIN dbo.tbl_POLPromotion AS Promotion
    ON Promotion.Code = Bundle.Promotion

WHERE
    /*
       Chương trình bắt đầu trước khi ngày bán kết thúc.
    */
    Promotion.StartDate
        < DATEADD(
            DAY,
            1,
            DailySale.SaleDate
        )

    /*
       Chương trình chưa kết thúc trước ngày bán.
    */
    AND
    (
        Promotion.EndDate IS NULL
        OR Promotion.EndDate >= DailySale.SaleDate
    )

    /*
       Chưa lọc:

           Promotion.IsPOS
           Promotion.IsUse
           Promotion.IsWholeSale
           Bundle.IsClosed

       Chỉ bổ sung khi đã xác minh chắc chắn ý nghĩa nghiệp vụ.
    */;


/* =====================================================================
   12. TẠO INDEX CHO DỮ LIỆU KHUYẾN MÃI
   ===================================================================== */

CREATE NONCLUSTERED INDEX IX_DailyPromotions_BarcodeDate
ON #DailyPromotions
(
    Barcode,
    SaleDate
);


/* =====================================================================
   13. TRẢ KẾT QUẢ CUỐI

   Chỉ tạo một result set.

   Mỗi dòng tương ứng:
       Một Barcode trong một ngày có giao dịch thực tế.

   PromoCode có cấu trúc:

       [
           {
               "PromoCode": "KM001",
               "PromoName": "Tên chương trình"
           },
           {
               "PromoCode": "KM002",
               "PromoName": "Tên chương trình khác"
           }
       ]

   Nếu không có chương trình:
       []
   ===================================================================== */

SELECT
    /*
       Barcode:
       Mã vạch định danh sản phẩm.
    */
    DailySale.Barcode,

    /*
       ProductName:
       Tên tiếng Việt của sản phẩm.

       Nguồn:
           tbl_LSProduct.VName
    */
    DailySale.ProductName,

    /*
       Date:
       Ngày phát sinh giao dịch bán hàng.

       Nguồn:
           tbl_SALPoSMaster.TransactionDate
    */
    DailySale.SaleDate AS [Date],

    /*
       Sales:
       Tổng số lượng bán trong ngày.
    */
    DailySale.Sales,

    /*
       Amount:
       Tổng tiền trước giảm giá trong ngày.
    */
    CAST(
        DailySale.Amount
        AS decimal(18, 2)
    ) AS Amount,

    /*
       Price:
       Đơn giá bình quân trước giảm giá.

       Công thức:
           SUM(Amount) / SUM(Qty)
    */
    DailySale.Price,

    /*
       PromoCode:
       Mảng JSON chứa chương trình khuyến mãi áp dụng trong ngày.

       SQL Server hiện tại không hỗ trợ FOR JSON PATH,
       nên sử dụng STUFF + FOR XML PATH.

       Nếu không có khuyến mãi:
           []
    */
    N'['
    +
    COALESCE(
        STUFF(
            (
                SELECT
                    N','
                    +
                    N'{'
                    +
                    N'"PromoCode":"'
                    +
                    /*
                       Escape PromoCode để không làm hỏng JSON.
                    */
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    REPLACE(
                                        COALESCE(
                                            DailyPromotion.PromoCode,
                                            N''
                                        ),
                                        N'\',
                                        N'\\'
                                    ),
                                    N'"',
                                    N'\"'
                                ),
                                CHAR(13),
                                N'\r'
                            ),
                            CHAR(10),
                            N'\n'
                        ),
                        CHAR(9),
                        N'\t'
                    )
                    +
                    N'",'
                    +
                    N'"PromoName":"'
                    +
                    /*
                       Escape PromoName để không làm hỏng JSON.
                    */
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    REPLACE(
                                        COALESCE(
                                            DailyPromotion.PromoName,
                                            N''
                                        ),
                                        N'\',
                                        N'\\'
                                    ),
                                    N'"',
                                    N'\"'
                                ),
                                CHAR(13),
                                N'\r'
                            ),
                            CHAR(10),
                            N'\n'
                        ),
                        CHAR(9),
                        N'\t'
                    )
                    +
                    N'"'
                    +
                    N'}'

                FROM #DailyPromotions AS DailyPromotion

                WHERE DailyPromotion.Barcode = DailySale.Barcode
                  AND DailyPromotion.SaleDate = DailySale.SaleDate

                ORDER BY
                    DailyPromotion.PromoCode

                FOR XML PATH(N''), TYPE
            ).value(
                N'.',
                N'nvarchar(max)'
            ),
            1,
            1,
            N''
        ),
        N''
    )
    +
    N']' AS PromoCode

FROM #DailySales AS DailySale

ORDER BY
    DailySale.Barcode,
    DailySale.SaleDate;


/* =====================================================================
   14. XÓA CÁC BẢNG TẠM

   Không ảnh hưởng dữ liệu thật trong database.
   ===================================================================== */

DROP TABLE #DailyPromotions;
DROP TABLE #DailySales;
DROP TABLE #TargetProducts;
DROP TABLE #InputBarcodes;
