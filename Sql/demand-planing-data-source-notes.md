# Ghi chú nguồn dữ liệu cho Demand Planning

## 0. Vai trò và phạm vi

Đây là tài liệu nguồn để tham khảo khi lấy dữ liệu POS/ERP cho Demand Planning. Tài liệu phải trả lời:

- bảng nào chứa dữ liệu cần lấy;
- khóa nối nào đúng;
- logic tính `Sales`, `OpenStock`, `CloseStock`, `ReceiptHour`, `Price`;
- dữ liệu nào là nguồn thô, dữ liệu nào được tính từ giao dịch thật;
- truy vấn nào cần chạy để kiểm chứng giả định;
- rủi ro nào chưa được phép tự suy diễn.


## 0.1. Kiến trúc đã khóa

1. POS/ERP trả dữ liệu **thưa**, chỉ có dòng khi DB thật có giao dịch hoặc phát sinh nguồn.
2. SQL không tạo lịch liên tục, không tạo ngày khuyết, không chia chu kỳ 15 ngày.
3. Module Demand Planning tạo lịch ngày liên tục và gắn `HasRecord=false` cho ngày scaffold.
4. Tồn đầu/cuối không có bảng ngày thô; SQL phải tính từ phát sinh thật.
5. Tồn đầu hôm nay bằng tồn cuối hôm trước.
6. Không có dòng bán không tự động đồng nghĩa với bán bằng 0.
7. CTKM lịch sử phải được xuất bằng khoảng hiệu lực để module gắn được cả ngày không bán.
8. SQL không tự loại mã CTKM thường trực; việc đó thuộc chính sách đã duyệt trong module.
9. Phiên hiện tại là kiểm thử lịch sử; chưa có kế hoạch CTKM tương lai thật.

## 0.2. Ba tập dữ liệu đầu ra

- `DailySourceRecord`: ngày có bán, trả, phát sinh kho hoặc receipt.
- `PromotionInterval`: SKU, mã CTKM, ngày bắt đầu/kết thúc.
- `ExtractMetadata`: phạm vi đọc, ngày chạy, StoreCode, phiên bản query, phạm vi SKU.

Các trường và quy tắc null/0 được khóa trong `02-Hop-dong-du-lieu-dau-vao.md`.

---

## 1. Các bảng nguồn cần kiểm tra

### 1.1. Bán lẻ chi tiết: `tbl_SALPoSDetails`

Vai trò:

- Bảng chi tiết bán lẻ theo từng sản phẩm.
- Mỗi dòng gắn với một sản phẩm bán ra trong hóa đơn POS.
- Đây là nguồn chính để lấy `sales`.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `Code` | Định danh dòng chi tiết | Không phải SKU, không dùng để group demand |
| `PoSMaster` | Khóa nối sang `tbl_SALPoSMaster.Code` | Bắt buộc để lấy ngày bán và trạng thái phiếu |
| `RePosDetails` | Dấu hiệu dòng hoàn/trả/đảo chiều | Trong 1,000 dòng chỉ vài dòng có giá trị; mặc định loại khỏi `sales` nền bằng `RePosDetails IS NULL` cho tới khi xác minh cơ chế trả hàng |
| `Product` | SKU bán ra | FK tới `tbl_LSProduct.Code`; đây là `sku` chính |
| `Qty` | Số lượng bán lẻ | Nguồn chính để tính `sales`; cần kiểm tra có dòng âm không |
| `BaseUnit`, `TranUnit` | Đơn vị cơ sở/giao dịch | Hiện thường bằng nhau hoặc trống; không dùng để đổi đơn vị nếu chưa xác minh |
| `ConvertUnit` | Hệ số đổi đơn vị | Hiện tất cả bằng `1`; không cần nhân vào `Qty` |
| `Amount` | Giá trị tiền dòng bán | Dùng suy ra `Price = Amount / Qty` khi không có đơn giá lưu sẵn |
| `VAT`, `Tax` | Thuế/VAT | `Tax` FK tới `tbl_LSVAT.Code`; không dùng để tính demand |
| `DiscountAmount` | Số tiền giảm giá | Dùng đối soát liệu `Amount` đã trước/sau giảm giá |
| `Discount` | Mã CTKM/giảm giá trên dòng POS | Chưa được FK trực tiếp tới `tbl_POLPromotion`; cần kiểm chứng join bằng dữ liệu thật |
| `Revenue` | Doanh thu dòng | Hiện không có dòng nào có giá trị; không dùng làm nguồn tính |
| `AvgPrice` | Giá bình quân nếu ERP có lưu | Chưa rõ ổn định; chỉ dùng sau khi so với `Amount/Qty` |
| `Barcode` | Mã vạch bán | Có thể dùng đối soát nếu `Product` không map được |
| `PowerID`, `EmployeeID`, `PowerCard` | Người thao tác/duyệt | Không cần cho demand |
| `BOM`, `BOMQty`, `BOMPrice`, `BOMDiscountPrice`, `BOMName` | Bộ hàng/hamper/combo | Không đưa vào logic nền nếu chưa xác định SKU cha/con |
| `DiscountGroupProduct`, `DiscountCouponInv` | Marker CTKM khác | Dùng đánh dấu ngày có khuyến mãi cùng với `Discount` |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_SALPoSDetails_tbl_SALPoSMaster` | `PoSMaster` | `tbl_SALPoSMaster.Code` |
| `FK_tbl_SALPoSDetails_tbl_LSProduct` | `Product` | `tbl_LSProduct.Code` |
| `FK_tbl_SALPoSDetails_tbl_LSUnit1` | `TranUnit` | `tbl_LSUnit.Code` |
| `FK_tbl_SALPoSDetails_tbl_LSUnit` | `BaseUnit` | `tbl_LSUnit.Code` |
| `FK_tbl_SALPoSDetails_tbl_LSVAT` | `Tax` | `tbl_LSVAT.Code` |
| `FK_tbl_SALPoSDetails_tbl_SYSUsers` | `PowerID` | `tbl_SYSUsers.Code` |
| `FK_tbl_SALPoSDetails_tbl_HREmployee` | `EmployeeID` | `tbl_HREmployee.Code` |

Cột [Discount] lưu Code của [tbl_POLBundle].
Trường Promation trong [tbl_POLBundle] lưu Code tbl_POLPromotion.
Dữ liệu của cột này hiện tại chỉ data của vài năm gần đây được lưu, cần dự liệu của 7 8 trước đó thì đã bị xóa dữ liệu trường này.
Logic hiện tại cần dùng với POS thật:

```sql
sales = SUM(COALESCE(tbl_SALPoSDetails.Qty, 0))
WHERE tbl_SALPoSDetails.Product = mã sản phẩm
  AND tbl_SALPoSDetails.RePosDetails IS NULL
```

Đơn giá chuẩn khi không có cột đơn giá tin cậy:

```sql
Price = AVG(Amount * 1.0 / NULLIF(Qty, 0))
WHERE RePosDetails IS NULL
  AND Qty > 0
  AND Amount > 0
  AND Discount IS NULL
  AND DiscountCouponInv IS NULL
  AND DiscountGroupProduct IS NULL
```

Điểm phải hiểu đúng: `Amount/Qty` chỉ là cách suy ra giá khi ERP không lưu đơn giá
đầy đủ. Nếu `Amount` là giá sau giảm hoặc đã gồm VAT, `Price` sẽ không còn là giá
niêm yết sạch. Vì vậy cần đối soát vài SKU quen thuộc sau khi chạy thật.

Điểm đã sửa so với giả định cũ:

- Không ép `tbl_SALPoSMaster.TransactionType = 2`.
- Quy tắc `TransactionType = 2` là logic copy từ `3PPOS`, chưa đúng với POS thật.
- Với POS thật, bảng chi tiết `tbl_SALPoSDetails` đã là nguồn dòng bán theo sản phẩm.

Câu kiểm tra nhanh:

```sql
SELECT TOP 100 *
FROM tbl_SALPoSDetails;

SELECT
    Product,
    SUM(Qty) AS TotalQty,
    COUNT(*) AS LineCount
FROM tbl_SALPoSDetails
WHERE Product IN (28972, 28973, 47297)
  AND RePosDetails IS NULL
GROUP BY Product;

SELECT
    COUNT(*) AS Lines,
    SUM(CASE WHEN RePosDetails IS NULL THEN 1 ELSE 0 END) AS NormalLines,
    SUM(CASE WHEN RePosDetails IS NOT NULL THEN 1 ELSE 0 END) AS RePosLines,
    SUM(CASE WHEN Qty < 0 THEN 1 ELSE 0 END) AS NegativeQtyLines,
    SUM(CASE WHEN Revenue IS NOT NULL AND Revenue <> 0 THEN 1 ELSE 0 END) AS NonZeroRevenueLines,
    MIN(ConvertUnit) AS MinConvertUnit,
    MAX(ConvertUnit) AS MaxConvertUnit
FROM tbl_SALPoSDetails;

SELECT TOP 50
    Code,
    Product,
    Qty,
    Amount,
    CAST(Amount * 1.0 / NULLIF(Qty, 0) AS decimal(18, 2)) AS UnitPriceFromAmount,
    AvgPrice,
    DiscountAmount,
    Discount,
    DiscountCouponInv,
    DiscountGroupProduct,
    VAT,
    Tax
FROM tbl_SALPoSDetails
WHERE Qty > 0
ORDER BY Code DESC;
```

### 1.2. Bán lẻ master: `tbl_SALPoSMaster`

Vai trò:

- Bảng header/master của hóa đơn POS.
- Dùng để lấy ngày bán, trạng thái phiếu và loại giao dịch.
- Là bảng đối soát tổng tiền đầu phiếu với tổng dòng chi tiết.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `Code` | Khóa nối từ `tbl_SALPoSDetails.PoSMaster` | Bắt buộc khi lấy ngày bán |
| `TransactionNo` | Số hóa đơn | Chỉ dùng audit/đối soát |
| `TransactionDate` | Ngày giờ giao dịch thực tế | Nguồn chính cho `date` |
| `EffDate` | Ngày hiệu lực kế toán/vận hành | Chỉ dùng đối soát nếu lệch `TransactionDate` |
| `TransactionType` | Loại giao dịch | Cần kiểm tra để loại phiếu trả hàng/hủy; không ép `= 2` |
| `IsProcess` | Cờ đã xử lý | Chỉ dùng lọc sau khi biết phân bố thật |
| `IsApproved` | Cờ hợp lệ/duyệt | Trước đây có dữ liệu `NULL`, nên không mặc định lọc |
| `StatusName` | Trạng thái hiển thị | Nếu có cột này trong DB thật, dùng để nhận diện phiếu hủy/trả |
| `Revenue`, `Amount`, `Discount` | Tổng đầu phiếu | Dùng đối soát, không thay cho `SUM(d.Qty)` |
| `CashPaid`, `CardPaid`, `VoucherPaid`, `ReturnPaid` | Thanh toán | Không cần cho demand |
| `CreateTime`, `LastModifiedTime` | Thời điểm tạo/sửa | Audit, không phải ngày bán chính |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_SALPoSMaster_tbl_SYSConfigValue` | `TransactionType` | `tbl_SYSConfigValue.Code` |
| `FK_tbl_SALPoSMaster_tbl_POLCard` | `Card` | `tbl_POLCard.Code` |
| `FK_tbl_SALPoSMaster_tbl_SYSUsers` | `PowerUser` | `tbl_SYSUsers.Code` |
| `FK_tbl_SALPoSMaster_tbl_HREmployee` | `EmpPower` | `tbl_HREmployee.Code` |

Quy tắc ngày bán:

```sql
Ngày bán = CAST(tbl_SALPoSMaster.TransactionDate AS date)
```

Câu kiểm tra nhanh:

```sql
SELECT TOP 100 *
FROM tbl_SALPoSMaster;

SELECT TOP 100 *
FROM tbl_SALPoSMaster
WHERE Code = 235331;

SELECT
    TransactionType,
    StatusName,
    IsProcess,
    IsApproved,
    COUNT(*) AS InvoiceCount,
    MIN(TransactionDate) AS MinTransactionDate,
    MAX(TransactionDate) AS MaxTransactionDate,
    SUM(Amount) AS HeaderAmount,
    SUM(Revenue) AS HeaderRevenue
FROM tbl_SALPoSMaster
GROUP BY TransactionType, StatusName, IsProcess, IsApproved
ORDER BY InvoiceCount DESC;

SELECT TOP 100
    m.Code,
    m.TransactionNo,
    m.TransactionDate,
    m.EffDate,
    m.TransactionType,
    m.StatusName,
    m.IsProcess,
    m.IsApproved,
    SUM(d.Qty) AS DetailQty,
    SUM(d.Amount) AS DetailAmount,
    m.Amount AS HeaderAmount,
    m.Revenue AS HeaderRevenue
FROM tbl_SALPoSMaster m
INNER JOIN tbl_SALPoSDetails d
    ON d.PoSMaster = m.Code
GROUP BY
    m.Code,
    m.TransactionNo,
    m.TransactionDate,
    m.EffDate,
    m.TransactionType,
    m.StatusName,
    m.IsProcess,
    m.IsApproved,
    m.Amount,
    m.Revenue
ORDER BY m.TransactionDate DESC;
```

Join bán lẻ:

```sql
SELECT
    d.Product,
    d.Qty,
    d.Amount,
    d.Revenue,
    m.TransactionDate
FROM tbl_SALPoSMaster m
INNER JOIN tbl_SALPoSDetails d
    ON m.Code = d.PoSMaster;
```

### 1.3. Master sản phẩm: `tbl_LSProduct`

Vai trò:

- Danh mục sản phẩm.
- Dùng để xác nhận mã sản phẩm có tồn tại.
- Có thể dùng `Quantity` để đối chiếu tồn hiện tại nếu cần, nhưng không được cập nhật trực tiếp.

Câu kiểm tra nhanh:

```sql
SELECT *
FROM tbl_LSProduct
WHERE Code IN (28972, 28973, 47297);
```

Lưu ý:

- Nếu `tbl_LSProduct.Code` tồn tại nhưng `tbl_SALPoSDetails.Product` không ra dòng bán, cần kiểm tra lại mapping mã sản phẩm/barcode.
- Nhưng theo thông tin hiện tại, `tbl_SALPoSDetails.Product` có lưu mã Product đầy đủ.

## 2. Các bảng nhập/xuất kho

### 2.1. Phiếu nhập/xuất master: `tbl_OPSImExMaster`

Vai trò:

- Header của chứng từ nhập/xuất kho.
- Dùng để lấy ngày hiệu lực tồn và loại chứng từ.
- Có thể dùng để dựng lại luồng tồn kho nếu không có bảng tồn ngày.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `Code` | Mã đầu phiếu | Theo FK, chi tiết `tbl_OPSImExDetails.DocumentNo` nối vào cột này |
| `DocumentNo` | Số chứng từ nghiệp vụ | Không mặc định dùng để join nếu FK đang chỉ tới `Code` |
| `DocumentType` | Loại nhập/xuất/chuyển | FK tới `tbl_LSDocumentType.Code`; quyết định dấu cộng/trừ tồn |
| `DocumentStatus` | Trạng thái chứng từ | FK tới `tbl_LSStatus.Code`; quyết định dùng `Quantity` hay `QtyReceived` |
| `EffDate` | Ngày hiệu lực chứng từ | Nguồn chính cho ngày phát sinh tồn |
| `ReceiptDate` | Ngày/giờ nhận hàng | Có thể dùng `receiptHour` nếu còn phần giờ thật |
| `Source`, `Destination` | Nơi xuất/nơi nhận | Cần xác minh khi tính tồn theo một kho/cửa hàng cụ thể |
| `Inventory` | Kho/nơi bán liên quan | FK tới `tbl_INInventoryMaster.Code`; dùng lọc đúng kho nếu chạy theo cửa hàng |
| `PO` | Liên kết PO | Có thể dùng về sau cho Chặng 14-19, chưa cần cho Chặng 1-13 |
| `IsApproved` | Cờ duyệt chứng từ | Trước đây thấy nhiều `NULL`; không mặc định lọc nếu chưa kiểm chứng |
| `CreateTime`, `LastModifiedTime` | Thời điểm tạo/sửa | Có thể làm fallback cho giờ nhập nếu `ReceiptDate` mất giờ |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_OPSImExMaster_tbl_LSDocumentType` | `DocumentType` | `tbl_LSDocumentType.Code` |
| `FK_tbl_OPSImExMaster_tbl_LSStatus` | `DocumentStatus` | `tbl_LSStatus.Code` |
| `FK_tbl_OPSImExMaster_tbl_INInventoryMaster` | `Inventory` | `tbl_INInventoryMaster.Code` |
| `FK_tbl_OPSImExMaster_tbl_LSClient_Source` | `Source` | `tbl_LSClient.Code` |
| `FK_tbl_OPSImExMaster_tbl_LSClient_Destination` | `Destination` | `tbl_LSClient.Code` |
| `FK_tbl_OPSImExMaster_tbl_OPSPOMaster` | `PO` | `tbl_OPSPOMaster.Code` |

Ngày dùng cho tồn:

```sql
Ngày phát sinh tồn = CAST(tbl_OPSImExMaster.EffDate AS date)
```

Phiếu nhập đầu tiên trong ngày:

```sql
DocumentType = 1
```

Trong danh sách loại chứng từ, `1 = Nhập điều chuyển nội bộ`.

Câu kiểm tra nhanh:

```sql
SELECT TOP 100 *
FROM tbl_OPSImExMaster;

SELECT
    m.DocumentType,
    dt.DocumentType AS DocumentTypeName,
    dt.TypeID,
    m.DocumentStatus,
    s.StatusName,
    m.IsApproved,
    COUNT(*) AS DocumentCount,
    MIN(m.EffDate) AS MinEffDate,
    MAX(m.EffDate) AS MaxEffDate
FROM tbl_OPSImExMaster m
LEFT JOIN tbl_LSDocumentType dt
    ON dt.Code = m.DocumentType
LEFT JOIN tbl_LSStatus s
    ON s.Code = m.DocumentStatus
GROUP BY
    m.DocumentType,
    dt.DocumentType,
    dt.TypeID,
    m.DocumentStatus,
    s.StatusName,
    m.IsApproved
ORDER BY DocumentCount DESC;

SELECT
    SUM(CASE WHEN ReceiptDate IS NOT NULL AND CONVERT(time, ReceiptDate) <> '00:00:00' THEN 1 ELSE 0 END) AS ReceiptDateHasTime,
    SUM(CASE WHEN CreateTime IS NOT NULL AND CONVERT(time, CreateTime) <> '00:00:00' THEN 1 ELSE 0 END) AS CreateTimeHasTime,
    COUNT(*) AS DocumentCount
FROM tbl_OPSImExMaster;
```

### 2.2. Phiếu nhập/xuất chi tiết: `tbl_OPSImExDetails`

Vai trò:

- Dòng chi tiết sản phẩm của chứng từ nhập/xuất.
- Dùng để tính phát sinh tồn theo sản phẩm/ngày.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `DocumentNo` | Khóa nối sang master | Theo FK nối tới `tbl_OPSImExMaster.Code`; tên cột dễ gây hiểu nhầm |
| `Product` | SKU phát sinh kho | FK tới `tbl_LSProduct.Code` |
| `Quantity` | Số lượng chứng từ | Dùng khi chứng từ đang ở trạng thái chưa hoàn tất nhận/xuất theo rule hiện tại |
| `QtyReceived` | Số lượng thực nhận/thực xuất | Dùng cho chứng từ đã hoàn tất; cần kiểm tra null/0 theo status |
| `UnitPrice`, `AvgPrice` | Giá nhập/giá bình quân | Không dùng cho `sales`; có thể dùng về sau cho `purchasePrice` |
| `POStore` | Liên quan dòng đặt/mua | Chưa dùng cho Chặng 1-13 |
| `ExpiredDate` | Hạn dùng | Không cần cho dự báo nền ban đầu |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_OPSImExDetails_tbl_OPSImExMaster` | `DocumentNo` | `tbl_OPSImExMaster.Code` |
| `FK_tbl_OPSImExDetails_tbl_OPSPOStore` | `POStore` | `tbl_OPSPOStore.Code` |
| `FK_tbl_OPSImExDetails_tbl_LSProduct` | `Product` | `tbl_LSProduct.Code` |

Join kho:

```sql
SELECT
    d.Product,
    m.EffDate,
    m.DocumentType,
    m.DocumentStatus,
    d.Quantity,
    d.QtyReceived
FROM tbl_OPSImExDetails d
INNER JOIN tbl_OPSImExMaster m
    ON d.DocumentNo = m.Code;

-- Kiểm tra join đúng theo FK, tránh nối nhầm vào m.DocumentNo.
SELECT
    COUNT(*) AS DetailLines,
    SUM(CASE WHEN mByCode.Code IS NOT NULL THEN 1 ELSE 0 END) AS JoinByMasterCode,
    SUM(CASE WHEN mByNo.Code IS NOT NULL THEN 1 ELSE 0 END) AS JoinByMasterDocumentNo
FROM tbl_OPSImExDetails d
LEFT JOIN tbl_OPSImExMaster mByCode
    ON mByCode.Code = d.DocumentNo
LEFT JOIN tbl_OPSImExMaster mByNo
    ON mByNo.DocumentNo = d.DocumentNo;

SELECT
    m.DocumentType,
    m.DocumentStatus,
    COUNT(*) AS LineCount,
    SUM(CASE WHEN d.Quantity IS NULL THEN 1 ELSE 0 END) AS NullQuantityLines,
    SUM(CASE WHEN d.QtyReceived IS NULL THEN 1 ELSE 0 END) AS NullQtyReceivedLines,
    SUM(d.Quantity) AS TotalQuantity,
    SUM(d.QtyReceived) AS TotalQtyReceived
FROM tbl_OPSImExDetails d
INNER JOIN tbl_OPSImExMaster m
    ON d.DocumentNo = m.Code
GROUP BY m.DocumentType, m.DocumentStatus
ORDER BY LineCount DESC;
```

## 3. Loại chứng từ: `tbl_LSDocumentType`

Vai trò:

- Bảng danh mục loại chứng từ.
- Không phải bảng phát sinh giao dịch.
- Dùng để hiểu ý nghĩa của `tbl_OPSImExMaster.DocumentType`.
- Cột `TypeID` có thể là phân nhóm nhập/xuất, nhưng không được dùng thay rule dấu
  tồn nếu chưa xem dữ liệu thật.

Cột cần đọc:

| Cột | Cách dùng |
|---|---|
| `Code` | Mã loại chứng từ, nối với `tbl_OPSImExMaster.DocumentType` |
| `DocumentType` | Tên loại chứng từ |
| `TypeID` | Phân nhóm nghiệp vụ tiềm năng; cần kiểm chứng |

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_LSDocumentType;

SELECT
    dt.Code,
    dt.DocumentType,
    dt.TypeID,
    COUNT(m.Code) AS DocumentCount
FROM tbl_LSDocumentType dt
LEFT JOIN tbl_OPSImExMaster m
    ON m.DocumentType = dt.Code
GROUP BY dt.Code, dt.DocumentType, dt.TypeID
ORDER BY dt.Code;
```

Danh sách loại chứng từ hiện biết:

```text
1   Nhập điều chuyển nội bộ
2   Nhập tồn đầu kỳ
3   Nhập hàng bán sỉ (trả lại)
4   Nhập hàng từ NCC
5   Xuất điều chuyển nội bộ
6   Xuất sử dụng nội bộ
7   Xuất hàng hư bể
8   Xuất hàng thanh lý
9   Xuất khác
10  Xuất hàng bán sỉ
11  Xuất điều chuyển tự cân đối
12  Nhập điều chuyển tự cân đối
20  Cân chỉnh thiếu (hàng) trong kỳ
21  Cân chỉnh thừa (hàng) trong kỳ
30  Cân chỉnh thiếu sau kiểm kê
31  Cân chỉnh thừa sau kiểm kê
40  Trả Hamper (bán lẻ)
41  Bán Hamper (bán lẻ)
50  Gói Hamper
51  Xuất sản phẩm tạo Hamper
52  Rã Hamper
53  Nhập sản phẩm rã Hamper
100 Mua hàng nội địa
101 Nhập khẩu
200 Đơn đặt hàng khách hàng
```

Điểm cần nhớ:

- Không được hiểu nhầm `tbl_LSDocumentType = 1`.
- Đúng là `tbl_OPSImExMaster.DocumentType = 1`.

## 4. Trạng thái chứng từ: `tbl_LSStatus`

Vai trò:

- Bảng danh mục trạng thái.
- Dùng để hiểu `tbl_OPSImExMaster.DocumentStatus`.

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_LSStatus;
```

Trạng thái liên quan logic tồn hiện tại:

```text
2 = Đang nhận hàng
3 = Hoàn tất nhận hàng
5 = Soạn hàng
6 = Hoàn tất xuất hàng
```

Lưu ý:

- `tbl_OPSImExMaster.IsApproved` hiện có nhiều dòng nhưng không có giá trị khác `NULL`.
- Không dùng `IsApproved` làm điều kiện lọc.

## 5. Bảng khuyến mãi

### 5.1. Chương trình khuyến mãi: `tbl_POLPromotion`

Vai trò:

- Header chương trình khuyến mãi.
- Dùng để xác định ngày thuộc CTKM.
- Có thể chứa cả CTKM lịch sử và CTKM tương lai nếu nghiệp vụ nhập trước kế hoạch.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `Code` | Mã CTKM | Nối với `tbl_POLBundle.Promotion` |
| `PromotionNo` | Số CTKM | Audit/hiển thị |
| `Promotion` | Tên CTKM | Nguồn cho `promoName` |
| `PromotionType` | Loại CTKM | FK tới `tbl_LSPromotionType.Code` |
| `StartDate`, `EndDate` | Khoảng ngày hiệu lực | Dùng map ngày bán vào CTKM |
| `IsGoldHour` | CTKM theo giờ vàng | Chỉ dùng nếu cần phân tích theo giờ, chưa cần cho daily demand |
| `IsUse` | CTKM đang được dùng | Có thể dùng lọc sau khi xác minh ý nghĩa |
| `IsWholeSale` | CTKM bán sỉ | Có thể loại nếu chỉ chạy bán lẻ POS |
| `IsPOS` | Áp dụng POS | Nên ưu tiên khi map khuyến mãi bán lẻ |
| `DetermineGift` | Có thể là CTKM quà tặng | Cần kiểm chứng nếu ảnh hưởng `Qty`/hamper |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_POLPromotion_tbl_LSPromotionType` | `PromotionType` | `tbl_LSPromotionType.Code` |

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_POLPromotion;

SELECT
    PromotionType,
    IsGoldHour,
    IsUse,
    IsWholeSale,
    IsPOS,
    DetermineGift,
    COUNT(*) AS PromotionCount,
    MIN(StartDate) AS MinStartDate,
    MAX(EndDate) AS MaxEndDate
FROM tbl_POLPromotion
GROUP BY PromotionType, IsGoldHour, IsUse, IsWholeSale, IsPOS, DetermineGift
ORDER BY PromotionCount DESC;
```

### 5.2. Chi tiết/gói khuyến mãi: `tbl_POLBundle`

Vai trò:

- Dòng sản phẩm áp dụng trong chương trình.
- Dùng để map sản phẩm với promotion.

Cột quan trọng và cách hiểu hiện tại:

| Cột | Cách dùng cho mô phỏng | Ghi chú/rủi ro |
|---|---|---|
| `Promotion` | Mã CTKM | Nối với `tbl_POLPromotion.Code` |
| `Product` | SKU áp dụng CTKM | Nguồn chính để map CTKM theo SKU |
| `RefProduct` | Dòng/bundle liên quan | Chỉ dùng sau khi hiểu quan hệ gói/ref |
| `Quantity`, `MaxQuantity` | Điều kiện số lượng | Không phải doanh số bán thực tế |
| `PriceDiscount`, `Price` | Giá/giảm giá trong CTKM | Chỉ dùng audit, không thay cho `Price` chuẩn |
| `Barcode`, `PosCode` | Mã phụ cho POS | Dùng đối soát nếu `Product` không map đủ |
| `StockQty`, `SellQty` | Số kiểm soát trong CTKM | Không dùng làm demand ngày |
| `IsClosed` | Dòng CTKM đã đóng hay chưa | Cần kiểm chứng trước khi lọc |

Khóa ngoại đã biết:

| Khóa ngoại | Cột hiện tại | Tham chiếu |
|---|---|---|
| `FK_tbl_POLBundle_tbl_POLPromotionInv` | `RefInv` | `tbl_POLPromotionInv.Code` |
| `FK_tbl_POLBundle_tbl_POLBundle` | `RefProduct` | `tbl_POLBundle.Code` |
| `FK_tbl_POLBundle_tbl_LSProduct` | `Product` | `tbl_LSProduct.Code` |

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_POLBundle;

SELECT
    b.Promotion,
    p.PromotionNo,
    p.Promotion AS PromotionName,
    b.Product,
    COUNT(*) AS BundleLineCount,
    MIN(p.StartDate) AS StartDate,
    MAX(p.EndDate) AS EndDate
FROM tbl_POLBundle b
LEFT JOIN tbl_POLPromotion p
    ON p.Code = b.Promotion
GROUP BY b.Promotion, p.PromotionNo, p.Promotion, b.Product
ORDER BY BundleLineCount DESC;
```

Logic CTKM hiện tại:

```sql
tbl_POLBundle.Product = Product
AND tbl_POLPromotion.Code = tbl_POLBundle.Promotion
AND ngày BETWEEN StartDate AND EndDate
AND tbl_POLPromotion.IsPOS = 1 -- nếu dữ liệu xác nhận cờ này đáng tin
```

`RefProduct` chỉ nên đưa vào logic nếu query chứng minh nó đại diện cho SKU con/cha
cần gộp. Mặc định dùng `tbl_POLBundle.Product` vì đây là FK trực tiếp tới sản phẩm.

Ngoài ra, trên dòng POS có thể có marker CTKM:

```text
tbl_SALPoSDetails.Discount
tbl_SALPoSDetails.DiscountCouponInv
tbl_SALPoSDetails.DiscountGroupProduct
```

Query cần chạy để biết `tbl_SALPoSDetails.Discount` có nối được với bảng CTKM nào:

```sql
SELECT TOP 100
    d.Discount,
    p.Code AS PromotionCodeByCode,
    p.PromotionNo AS PromotionNoByCode,
    p.Promotion AS PromotionNameByCode
FROM tbl_SALPoSDetails d
LEFT JOIN tbl_POLPromotion p
    ON CONVERT(nvarchar(100), p.Code) = CONVERT(nvarchar(100), d.Discount)
WHERE d.Discount IS NOT NULL;

SELECT TOP 100
    d.Discount,
    p.Code AS PromotionCodeByNo,
    p.PromotionNo,
    p.Promotion AS PromotionNameByNo
FROM tbl_SALPoSDetails d
LEFT JOIN tbl_POLPromotion p
    ON CONVERT(nvarchar(100), p.PromotionNo) = CONVERT(nvarchar(100), d.Discount)
WHERE d.Discount IS NOT NULL;
```

## 6. Công thức dữ liệu đầu vào cần cho mô phỏng

Output cần nạp vào module:

```text
sku
date
openStock
closeStock
sales
receiptHour
promoCode
promoName
Price
ProductName
```

### 6.1. `sku`

```sql
sku = tbl_SALPoSDetails.Product
```

hoặc mã sản phẩm trong `tbl_LSProduct.Code`, nếu hai bảng dùng cùng mã.

### 6.2. `date`

```sql
date = CAST(tbl_SALPoSMaster.TransactionDate AS date)
```

### 6.3. `sales`

Logic đúng cho POS thật hiện tại:

```sql
sales = SUM(COALESCE(tbl_SALPoSDetails.Qty, 0))
WHERE tbl_SALPoSDetails.RePosDetails IS NULL
```

Không dùng:

```sql
tbl_SALPoSMaster.TransactionType = 2
```

vì điều kiện này làm sales ra 0 trên dữ liệu POS thật.

Không dùng:

```sql
Revenue
Amount
DiscountAmount
```

vì đây là tiền, không phải số lượng nhu cầu. Tiền chỉ dùng cho `Price` và đối soát.

### 6.4. `openStock`

```text
openStock ngày D = tổng phát sinh tồn trước ngày D
```

Nói cách khác:

```text
tồn đầu ngày hôm nay = tồn cuối ngày hôm trước
```

### 6.5. `closeStock`

```text
closeStock ngày D = tổng phát sinh tồn đến hết ngày D
```

### 6.6. Phát sinh tồn kho

Nhập tăng tồn:

```text
DocumentType IN (1,2,3,4,21,31,41,50), DocumentStatus = 3 => +QtyReceived
DocumentType IN (1,2,3,4,21,31,41,50), DocumentStatus = 2 => +Quantity
```

Xuất giảm tồn:

```text
DocumentType IN (5,6,7,8,9,10,20,30,40,52), DocumentStatus = 6 => -QtyReceived
DocumentType IN (5,6,7,8,9,20,30,40,52), DocumentStatus = 5 => -QtyReceived
```

POS tác động tồn:

```text
RePosDetails IS NULL     => -Qty
RePosDetails IS NOT NULL => +Qty
```

### 6.7. `receiptHour`

Phiếu nhập đầu tiên dùng cho stockout:

```text
tbl_OPSImExMaster.DocumentType = 1
```

Ưu tiên lấy giờ từ:

```text
ReceiptDate nếu còn giờ thật
CreateTime nếu cùng ngày EffDate và còn giờ thật
```

Nếu các trường đã bị ép về `date` hoặc giờ là `00:00:00`, chưa đủ căn cứ đánh giá nhập sớm/trễ.

### 6.8. `promoCode` / `promoName`

Nguồn 1: lịch CTKM:

```text
tbl_POLPromotion + tbl_POLBundle
```

```text
promoCode = tbl_POLPromotion.Code
promoName = tbl_POLPromotion.Promotion
```

Nguồn 2: marker trên dòng POS:

```text
Discount
DiscountCouponInv
DiscountGroupProduct
```

### 6.9. `Price`

`Price` là đơn giá chuẩn dùng cho ABC và chính sách ABC/XYZ, không phải doanh thu.
Khi không có cột đơn giá sạch, tính từ dòng bán sạch:

```sql
Price = AVG(Amount * 1.0 / NULLIF(Qty, 0))
WHERE RePosDetails IS NULL
  AND Qty > 0
  AND Amount > 0
  AND Discount IS NULL
  AND DiscountCouponInv IS NULL
  AND DiscountGroupProduct IS NULL
```

Không lấy từ:

```text
Revenue
DiscountAmount
tbl_OPSImExDetails.UnitPrice
tbl_OPSImExDetails.AvgPrice
```

vì `Revenue`/`DiscountAmount` là tiền bán sau nghiệp vụ, còn `UnitPrice`/`AvgPrice`
của kho là giá nhập/giá vốn, dùng cho `purchasePrice` về sau chứ không dùng xếp ABC.

### 6.10. `ProductName`

`ProductName` chỉ để UI hiển thị tên SKU. Nguồn đúng là `tbl_LSProduct`, nhưng tên
cột thật cần dò trong schema (`ProductName`, `Name`, `Description`, ...). Nếu không
tìm được tên, mô phỏng vẫn chạy bằng mã `sku`, chỉ thiếu nhãn dễ đọc.

## 7. Các câu query khảo sát schema đã dùng trước đó

```sql
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_SALPoSDetails';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_SALPoSMaster';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_OPSImExMaster';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_OPSImExDetails';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_LSDocumentType';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_LSStatus';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_POLPromotion';

SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_POLBundle';
```

## 8. Những điểm cần thận trọng

1. Không áp máy móc logic từ `3PPOS` sang `POS`.

   Ví dụ đã sai:

   ```sql
   TransactionType = 2
   ```

2. `tbl_LSDocumentType` là bảng danh mục, không phải bảng phát sinh.

3. `IsApproved` không dùng được vì đang `NULL`.

4. `ReceiptDate`, `EffDate`, `CreateTime` có thể đã mất giờ. Nếu mất giờ thì không thể kết luận nhập sớm/trễ chính xác.

5. CTKM có thể đến từ nhiều nguồn. Nếu chỉ lấy `tbl_POLPromotion/tbl_POLBundle` có thể thiếu CTKM ghi trực tiếp trên dòng POS.

6. Không join kho theo tên cột một cách máy móc. Theo FK hiện tại,
   `tbl_OPSImExDetails.DocumentNo` nối vào `tbl_OPSImExMaster.Code`.

7. `BaseUnit`, `TranUnit`, `ConvertUnit` chưa đủ căn cứ để đổi đơn vị. Hiện
   `ConvertUnit = 1`, nên dùng trực tiếp `Qty` cho bán lẻ.

8. `Amount/Qty` là fallback cho đơn giá, không phải bằng chứng tuyệt đối của giá
   niêm yết. Cần kiểm tra `DiscountAmount`, VAT và vài SKU quen thuộc.

9. Nếu output toàn `0`, không được dùng để test module. Phải kiểm tra lại:

   ```sql
   SELECT Product, SUM(Qty)
   FROM tbl_SALPoSDetails
   WHERE Product IN (28972, 28973, 47297)
     AND RePosDetails IS NULL
   GROUP BY Product;
   ```
## 9. Hợp đồng đầu ra hiện hành

### 9.1. `DailySourceRecord`

SQL chỉ trả ngày có nguồn thật. Các trường cốt lõi:

```text
ExtractId
StoreCode
SKU
Date
Sales                  -- null nếu ngày chỉ có nguồn kho
HasSalesRecord
ReturnQty
InventoryNetMovement
HasInventoryMovement
OpenStock
CloseStock
StockCalculationStatus
ReceiptHour
HasReceiptRecord
Price
ProductName
HasRecord              -- luôn true trong output SQL
IsReferenceOnly
```

Không dùng một cờ `HasRecord` duy nhất để thay cho `HasSalesRecord` và `HasInventoryMovement`.

### 9.2. `PromotionInterval`

```text
ExtractId
StoreCode
SKU
PromoCode
PromoName
StartDate
EndDate
PromoTypeSource
IsPOS
SourceRole
```

Module dùng interval để phủ CTKM lên lịch, kể cả ngày không có dòng bán.

### 9.3. `ExtractMetadata`

Phải có `RunDate`, `ProcessingStartDate`, `ProcessingEndDate`, `ReferenceReadStartDate`, `PortfolioMode`, `StoreCode`, `QueryVersion`, `StockAnchorAssumption`.

## 10. Công thức tồn được xác nhận

$$
OpenStock_d = CloseStock_{d-1}
$$

$$
CloseStock_d = OpenStock_d + ImExNet_d + Return_d - Sales_d
$$

SQL cộng dồn từ toàn bộ phát sinh đã ghi nhận trước ngày kết thúc. Module chỉ mang tồn qua các ngày scaffold không có phát sinh. Ngày mang tồn phải ghi nguồn `CARRIED_FORWARD`.

Các vấn đề phải báo cáo, không tự sửa:

- tồn âm;
- thiếu mốc neo;
- sai dấu chứng từ;
- gộp sai nơi bán/kho;
- không thống nhất đơn vị tính.

## 11. Phạm vi ngày và cận dưới lịch sử

Phân biệt:

- `ProcessingStartDate`: ngày đầu module tạo chu kỳ;
- `ReferenceReadStartDate`: ngày SQL đọc thêm để Chặng 3–5 tìm tham chiếu;
- `ProcessingEndDate`: ngày cuối lịch sử.

SQL không được dời `ProcessingStartDate` chỉ để số ngày chia hết cho 15. Ngày dư là trách nhiệm Chặng 1.

Vùng tham chiếu khởi điểm đề xuất là 24 ngày trước khung; nếu CTKM cắt qua biên và vẫn chưa đủ, hệ thống có thể yêu cầu query bổ sung có mục tiêu thay vì tải toàn DB.

## 12. Ngày không có dòng bán

Bảng POS chi tiết có tính chất event-driven. Vì vậy:

- ngày không có dòng SKU chưa đủ bằng chứng là bán 0;
- ngày chỉ tồn tại vì có phiếu kho phải có `Sales=null`, `HasSalesRecord=false`;
- ngày do module tạo có `HasRecord=false`, `Sales=null`;
- chỉ chuyển thành `CONFIRMED_ZERO` khi có bằng chứng POS cấp cửa hàng-ngày đầy đủ và SKU đang hoạt động.

Ngày `HasRecord=false` không được dùng làm ngày sạch tham chiếu cho Chặng 3/4.

## 13. CTKM thường trực và CTKM chạy liên tục

### 13.1. CTKM thường trực

Các chương trình giá cố định theo hạng khách hàng có thể được coi là một phần bán bình thường, nhưng chỉ sau khi mã được phê duyệt vào danh sách chính sách. SQL vẫn xuất nguyên mã.

### 13.2. Chiến dịch nối tiếp gần như quanh năm

Không tự đồng nhất với giá thường trực. Nếu vẫn là chiến dịch thực sự nhưng không còn ngày đối chứng, đây là vấn đề `BASELINE_NOT_IDENTIFIABLE`. Cần dùng cửa hàng/SKU đối chứng hoặc nền MD đã duyệt.

### 13.3. Mã âm

Không mặc định là lỗi. Mã được giữ nguyên dạng chuỗi.

## 14. Bài học từ dữ liệu thật và nội dung cũ bị thay thế

Các lần mô phỏng cũ từng tạo lịch dày và gán `Sales=0` cho ngày không có bản ghi. Cách này đã được xác định là sai vì ngày 0 giả có thể bị dùng làm ngày sạch, kéo median nền CTKM/stockout về 0 và làm sai XYZ/D.

Bản 3 khóa lại:

- SQL trả dữ liệu thưa;
- module tạo scaffold;
- scaffold không được xem là bán 0;
- không dùng scaffold làm tham chiếu;
- “không có bản ghi” và “có bản ghi nhưng chưa có nền” là hai trạng thái khác nhau.

Mọi ghi chú cũ nói rằng `demand-planing.sql` phải tạo một dòng/ngày hoặc có thể dùng `Sales=0` placeholder như dữ liệu thật đều không còn hiệu lực.

## 15. Phạm vi Chặng 13–19

- Chặng 12 có thể học hệ số từ CTKM lịch sử nếu baseline đủ căn cứ.
- Chặng 13 hiện chỉ passthrough vì chưa có kế hoạch CTKM tương lai thật.
- Chặng 14–19 cần thêm nhà cung cấp, PO đang mở, ETA, MOQ, giá mua, lead time và ngân sách; chưa xem là đã kiểm chứng đầy đủ.

## 16. Cách dùng các query khảo sát

Các query chi tiết ở phần 1–8 giúp hiểu bảng/cột. Dùng thêm `03-Kiem-tra-du-lieu-nguon.sql` để chạy checklist tập trung. Mỗi kết quả khảo sát phải ghi:

- môi trường/DB;
- thời điểm chạy;
- số dòng;
- kết luận được duyệt;
- tác động tới query chính.
