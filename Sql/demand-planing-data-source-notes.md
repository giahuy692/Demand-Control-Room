# Ghi chú nguồn dữ liệu cho Demand Planning

File này lưu lại phần ghi chú/khảo sát dữ liệu trước đó từng nằm trong `demand-planing.sql`.

Mục đích: giúp biết các bảng nào trong POS chứa dữ liệu cần lấy để chạy thử mô phỏng Demand Planning, không phải file SQL chính để chạy lấy dữ liệu.

File SQL chính hiện tại để chạy là:

```text
Sql/demand-planing.sql
```

Nguyên tắc đọc note này:

- Ưu tiên lấy đúng trường tối thiểu để chạy mô phỏng: `sku`, `date`, `openStock`,
  `closeStock`, `sales`, `receiptHour`, `promoCode`, `promoName`, `Price`,
  `ProductName`.
- Không tự đoán ý nghĩa của mã nghiệp vụ (`TransactionType`, `DocumentType`,
  `DocumentStatus`, `Discount`) nếu chưa có query phân bố dữ liệu thật.
- Cột nào đang không có dữ liệu ổn định (`Revenue`, một số đơn vị tính, giờ nhập)
  chỉ dùng để đối soát, không dùng làm nguồn tính chính.
- Với khóa ngoại, ưu tiên theo constraint thật hơn tên cột. Ví dụ quan trọng:
  `tbl_OPSImExDetails.DocumentNo` đang FK tới `tbl_OPSImExMaster.Code`, không phải
  mặc định nối vào `tbl_OPSImExMaster.DocumentNo` chỉ vì trùng tên.

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

## 9. Cột cho Chặng 1–13 (đã xong `Price`), Chặng 14–19 để sau

Phạm vi hiện tại **chỉ chạy Chặng 1–13**. `Sql/demand-planing.sql` giờ trả 10 cột:
SKU, Date, OpenStock, CloseStock, Sales, ReceiptHour, PromoCode, PromoName,
**`Price`**, và **`ProductName`** — đủ để chạy trọn Chặng 1–13.

### 9.1. `price` (đơn giá chuẩn, Chặng 6 & 8) — đã giải quyết

Lưu ý: đây là `price` — **khác** `purchasePrice` (giá mua, chỉ dùng ở Chặng 17–18,
xem mục 9.2). Công thức Chặng 6 ghi rõ "đơn giá chuẩn, không dùng giá khuyến mãi"
(ký hiệu P trong `V_năm = Q_năm × P`,
[simulation-engine.ts:288](src/app/domain/simulation-engine.ts#L288)).

`tbl_SALPoSDetails` không có cột giá sẵn, và `tbl_LSProduct` chưa xác nhận có cột giá
ổn định. Đã chốt cách suy ra: `AVG(Amount/Qty)` **chỉ trên dòng bán sạch**
(`RePosDetails IS NULL`, không dính `Discount`/`DiscountCouponInv`/
`DiscountGroupProduct`) để không lẫn giá đã giảm KM — implement ở mục "2.1. Đơn giá
chuẩn theo SKU" trong `demand-planing.sql`, ra một giá trị `Price` duy nhất cho mỗi
SKU, lặp lại trên mọi dòng ngày của SKU đó trong SELECT kết quả cuối (mục 8).

Rủi ro cần theo dõi khi có kết quả thật: nếu `Amount` trong POS là giá trị **sau**
khi trừ chiết khấu (chứ không phải giá gộp trước giảm) thì công thức này vẫn có thể
lệch nhẹ so với "giá niêm yết" — không chặn được vì không có cách kiểm tra từ xa, cần
đối chiếu thủ công vài SKU quen thuộc sau khi chạy thật. Nếu SKU không có dòng bán
sạch nào trong `@StartDate..@EndDate` (chỉ toàn ngày KM hoặc chỉ có hoàn/trả), `Price`
sẽ ra `NULL` và Chặng 6 sẽ không xếp ABC được cho SKU đó — không phải lỗi SQL, mà là
dữ liệu SKU đó không đủ căn cứ.

Nếu sau này tìm được cột giá ổn định hơn trong `tbl_LSProduct` (câu SQL dò cột ở mục
0.1 của `demand-planing.sql`), có thể thay khối 2.1 bằng `LEFT JOIN` thẳng tới đó thay
vì suy ra từ giao dịch.

### 9.1b. `ProductName` (hiển thị UI, không bắt buộc) — đã bổ sung

Không đợi xác nhận tên cột thủ công nữa — mục "2.2" trong `demand-planing.sql` **tự
dò** tên cột trong `tbl_LSProduct` qua `INFORMATION_SCHEMA.COLUMNS` (ưu tiên
`ProductName` → `Name` → `ProductNameVN` → `FullName` → `ShortName` → `Description` →
`Title`, cột nào khớp trước dùng cột đó), rồi đọc bằng dynamic SQL (`sp_executesql`,
chỉ `SELECT`, không sửa bảng thật) vào `#ProductName`, join thẳng vào SELECT kết quả
cuối cùng cột `Price`.

Vì tên cột được đoán theo mẫu thường gặp chứ không xác nhận trực tiếp với schema thật,
cần kiểm tra khi chạy thật:

- Script có `PRINT` ra tên cột đã chọn (hoặc cảnh báo nếu không tìm thấy cột nào) —
  đọc dòng PRINT đầu tiên khi chạy để biết đã dùng cột nào.
- Nếu kết quả `ProductName` toàn `NULL`, hoặc ra mã/số thay vì tên chữ (chọn nhầm cột),
  chạy mục 0.1 để xem toàn bộ cột của `tbl_LSProduct`, rồi gán tay
  `SET @NameColumn = N'<tên cột đúng>'` ngay dưới khối tự dò trong mục 2.2 (đã có sẵn
  dòng mẫu, chỉ cần bỏ comment và sửa tên cột).

### 9.2. Chặng 14–19: chưa cần xử lý bây giờ

CTKM hiện chỉ chạy trên lịch sử (`tbl_POLPromotion` quá khứ) dùng cho Chặng 3/4 (nâng
nền/chuẩn hóa CTKM đã xảy ra) — chưa có chức năng hay bảng lưu **kế hoạch CTKM tương
lai**, nên Chặng 12–13 (học hệ số K và áp CTKM tương lai) chỉ chạy được ở mức "chưa có
kế hoạch nào được xác nhận", không phải lỗi thiếu SQL.

Bảng dưới đây liệt kê các trường `SkuDefinition` mà Chặng 14–19 cần — **không cần xử
lý bây giờ**, giữ lại để tham khảo khi mở rộng phạm vi sau khi Chặng 1–13 chạy tốt
trên dữ liệu thật:

| Trường SkuDefinition | Dùng ở Chặng | Ý nghĩa | Nguồn khả dĩ trong POS |
|---|---|---|---|
| `purchasePrice` | 17, 18 | Giá mua (khác `price` ở mục 9.1 — dùng để tính giá trị đặt hàng/ngân sách, không dùng để xếp ABC) | `tbl_OPSImExDetails.UnitPrice`/`AvgPrice` của phiếu nhập từ NCC (`DocumentType = 4`) — cần kiểm chứng có ổn định theo SKU không |
| `supplier` | 14 | Nhà cung cấp gắn với SKU | Chưa thấy bảng NCC trong các bảng đã khảo sát; `tbl_OPSImExMaster.Source` có thể là mã nguồn nhưng chưa xác nhận là NCC |
| `inboundPlan` | 14 | Lô hàng đang về, có ETA + trạng thái xác nhận | Có thể là PO đang mở (`DocumentType = 4`, `DocumentStatus` chưa hoàn tất) trong `tbl_OPSImExMaster/Details`, nhưng cần bảng Purchase Order riêng nếu có (chưa khảo sát) |
| `commitments` | 14 | Đơn giữ hàng/điều chuyển đã cam kết | Có thể là chứng từ `DocumentType = 5` (xuất điều chuyển nội bộ) chưa hoàn tất — cần xác nhận |
| `leadTimeHistoryDays` | 15 | Số ngày từ đặt hàng NCC đến ngày nhận (`EffDate`/`ReceiptDate`) | Cần cột "ngày đặt PO" — chưa thấy trong `tbl_OPSImExMaster` (chỉ có `EffDate`, `ReceiptDate`, không thấy `OrderDate`/`POCreateDate`) |
| `moq` | 16 | Số lượng đặt tối thiểu theo NCC | Chưa thấy bảng master điều khoản mua hàng |
| `maxStock` / `warehouseCapacity` | 16 | Giới hạn tồn kho vật lý | Có thể ở `tbl_LSProduct` hoặc bảng cấu hình kho — chưa khảo sát cột |
| `shelfLifeDays` | — | Hạn sử dụng | Có thể ở `tbl_LSProduct` — chưa khảo sát cột |
| `purchaseTermsComplete` | 18 | Đủ điều kiện phát hành đơn mua (ETA, MOQ, giá, NCC đầy đủ) | Suy ra được từ các trường trên một khi có, không cần bảng riêng |
| `futurePromotions` (đã xác nhận) | 12–13 | Lịch CTKM tương lai đã duyệt | **Chưa có nguồn** — hiện chỉ chạy CTKM lịch sử; chưa có chức năng/bảng lưu kế hoạch CTKM tương lai. Khi nào nghiệp vụ có quy trình duyệt kế hoạch CTKM thì mới bổ sung |
| `periodBudget` (policy, không phải SkuDefinition) | 17 | Ngân sách kỳ | Chưa thấy bảng ngân sách trong POS — nhiều khả năng nằm ở hệ thống tài chính/ERP khác, không phải POS |

SQL dò schema để tìm các bảng còn thiếu (an toàn, chỉ đọc catalog, không đọc dữ liệu):

```sql
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME LIKE '%Suppl%'
   OR TABLE_NAME LIKE '%NCC%'
   OR TABLE_NAME LIKE '%PUR%'
   OR TABLE_NAME LIKE '%Purchase%'
   OR TABLE_NAME LIKE '%Order%'
   OR TABLE_NAME LIKE '%Budget%'
   OR TABLE_NAME LIKE '%Warehouse%'
   OR TABLE_NAME LIKE '%Kho%'
ORDER BY TABLE_NAME;

-- Sau khi có tên bảng ứng viên, liệt kê cột:
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = '<tên bảng ứng viên>';

-- Kiểm tra tbl_LSProduct có cột giá/MOQ/hạn dùng không (đã có bảng, chỉ chưa soi hết cột):
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'tbl_LSProduct';
```

### Cách chạy được Chặng 19 (hậu kiểm) mà KHÔNG cần thêm dữ liệu mới — tham khảo cho sau này

Chặng 19 so dự báo với nhu cầu thực tế *sau* ngày chạy — nhưng vì `demand-planing.sql`
đã lấy dữ liệu đến `2026-07-07` (bằng "hôm nay"), không có gì để so. Cách không tốn
thêm dữ liệu: lùi `policy.runDate` về khoảng 6 chu kỳ (90 ngày) trước ngày cuối cùng
có dữ liệu, ví dụ `runDate = '2026-04-09'` thay vì `'2026-07-08'`. Khi đó 90 ngày cuối
(2026-04-09 → 2026-07-07) đã có sẵn trong CSV, dùng làm `actualDemand` thật cho Chặng 19
— kiểm chứng được độ chính xác dự báo trên dữ liệu thật mà không cần đợi thêm hay xuất
thêm file.

## 10. Đối chiếu Tài liệu giải pháp × engine × UI cho Chặng 1–13: cần cột nào

Thẩm định trực tiếp trên `simulation-engine.ts`, `math.ts`, `stage-trace.ts` (panel
thế số từng chặng), `stage-insights.ts` và `executive-dashboard.component.ts` — không
suy diễn từ tài liệu mô tả, mà grep đúng chỗ field được đọc.

| Chặng | Engine tính gì | Cột SQL cần cho **tính toán** | Cột SQL cần thêm cho **hiển thị UI** |
|---|---|---|---|
| 1 | Khung lịch, chia chu kỳ | Date (đã có) | `SKU` làm nhãn (đã có, dạng mã thô) |
| 2 | Đánh dấu stockout | OpenStock, CloseStock, Sales, ReceiptHour (đã có) | — |
| 3 | Nâng nền ngày stockout | Sales, PromoCode (đã có) | — |
| 4 | Chuẩn hóa CTKM | PromoCode (đã có) | `PromoName` — engine không đọc, chỉ tồn tại trong SQL, UI cũng không hiển thị (đã kiểm, không có usage) |
| 5 | Lấp nền & khóa chu kỳ | Không cần cột mới | — |
| **6** | **ABC theo giá trị tiêu thụ năm hóa** | **`Price` (đơn giá chuẩn) — đã có, suy ra từ `AVG(Amount/Qty)` dòng sạch, xem mục 9.1** | — |
| 7 | XYZ/D theo ADI/CV² | Không cần cột mới (tính trên sản lượng, không cần giá) | — |
| **8** | Ma trận chính sách ABC×XYZ | Phụ thuộc kết quả Chặng 6 → **cũng cần `Price`** (đã có) | — |
| 9 | Kiểm tra mùa vụ | Không cần cột mới | — |
| 10 | Kiểm tra xu hướng | Không cần cột mới | — |
| 11 | Chọn & chạy mô hình dự báo | Không cần cột mới | — |
| 12 | Hệ số CTKM từ lịch sử | PromoCode + Sales (đã có) | — |
| 13 | Áp CTKM tương lai | `futurePromotions` đã xác nhận — **chưa có nguồn** (mục 9.2); thiếu thì Chặng 13 vẫn chạy, chỉ luôn ở trạng thái "chưa có kế hoạch KM nào được xác nhận" (không lỗi, không phải chặn cứng) | — |
| Toàn bộ 1–13 | Bảng ABC/XYZ, danh sách SKU trong dashboard | — | `ProductName` — đã có (mục 9.1b, tự dò cột), thay "Mã ERP {SKU}" bằng tên thật trên mọi bảng/dashboard hiển thị theo cặp `id + name` |

Kết luận đúng phạm vi câu hỏi: `Sql/demand-planing.sql` giờ trả đủ 10 cột (8 cột gốc +
`Price` + `ProductName`) — **Chặng 1–13 tính đúng và hiển thị đầy đủ**, không còn cột
nào thiếu. `Price` bắt buộc (mục 9.1) và `ProductName` không bắt buộc/chỉ ảnh hưởng UI
(mục 9.1b) đều đã có cách lấy tự động, không cần chờ thêm thông tin từ ai. Không có
trường nào khác trong Chặng 1–13 bị thiếu — đã grep hết field `.definition.*` và field
thô của `DailyRecord` được engine Chặng 1–13 đọc tới. `PromoName` đang có trong SQL
nhưng không nơi nào trong engine/UI dùng tới — giữ lại không hại gì (phục vụ audit thủ
công) nhưng không cần ưu tiên.

Việc còn lại chỉ là **chạy thật và kiểm tra bằng mắt**: dòng `PRINT` của mục 2.2 báo
cột `ProductName` đã chọn, và cột `Price`/`ProductName` trong kết quả cuối có hợp lý
không (Price không toàn NULL, ProductName ra tên chữ chứ không phải mã số) — xem mục
9.1/9.1b nếu cần chỉnh tay.

## 11. Câu hỏi cần trả lời bằng dữ liệu thật trước khi chốt SELECT

Mục này dành cho trường hợp AI cần hiểu đúng ý nghĩa cột nhưng không được đoán. Chạy
các query dưới đây trên dữ liệu thật, gửi lại bảng kết quả là đủ.

### 11.1. Phiếu bán hợp lệ được nhận diện bằng gì?

Cần biết `TransactionType`, `StatusName`, `IsProcess`, `IsApproved` nào là bán thật,
trả hàng, hủy, hoặc phiếu chưa chốt.

```sql
SELECT
    m.TransactionType,
    m.StatusName,
    m.IsProcess,
    m.IsApproved,
    COUNT(DISTINCT m.Code) AS InvoiceCount,
    COUNT(d.Code) AS LineCount,
    SUM(CASE WHEN d.RePosDetails IS NULL THEN d.Qty ELSE 0 END) AS NormalQty,
    SUM(CASE WHEN d.RePosDetails IS NOT NULL THEN d.Qty ELSE 0 END) AS RePosQty,
    SUM(CASE WHEN d.Qty < 0 THEN 1 ELSE 0 END) AS NegativeQtyLines
FROM tbl_SALPoSMaster m
LEFT JOIN tbl_SALPoSDetails d
    ON d.PoSMaster = m.Code
GROUP BY m.TransactionType, m.StatusName, m.IsProcess, m.IsApproved
ORDER BY InvoiceCount DESC;
```

Câu trả lời cần rút ra: điều kiện lọc phiếu bán hợp lệ là gì, và có cần loại thêm
`StatusName`/`TransactionType` nào ngoài `RePosDetails IS NULL` không.

### 11.2. `RePosDetails` thật sự đại diện cho trả hàng/đảo dòng hay không?

```sql
SELECT TOP 100
    d.Code,
    d.RePosDetails,
    d.PoSMaster,
    m.TransactionNo,
    m.TransactionDate,
    m.TransactionType,
    m.StatusName,
    d.Product,
    d.Qty,
    d.Amount
FROM tbl_SALPoSDetails d
LEFT JOIN tbl_SALPoSMaster m
    ON m.Code = d.PoSMaster
WHERE d.RePosDetails IS NOT NULL
ORDER BY m.TransactionDate DESC;
```

Câu trả lời cần rút ra: dòng có `RePosDetails` nên bị loại khỏi `sales`, hay phải tính
ngược dấu để phản ánh trả hàng.

### 11.3. `Amount` đang là trước giảm, sau giảm, có VAT, hay chưa VAT?

```sql
SELECT TOP 200
    d.Code,
    d.Product,
    d.Qty,
    d.Amount,
    d.DiscountAmount,
    d.VAT,
    d.Tax,
    CAST(d.Amount * 1.0 / NULLIF(d.Qty, 0) AS decimal(18, 2)) AS UnitPriceFromAmount,
    d.AvgPrice,
    d.Discount,
    d.DiscountCouponInv,
    d.DiscountGroupProduct
FROM tbl_SALPoSDetails d
WHERE d.Qty > 0
ORDER BY d.Code DESC;
```

Câu trả lời cần rút ra: `Price = Amount/Qty` có gần đúng giá niêm yết sạch không; nếu
không, cần tìm cột giá chuẩn trong `tbl_LSProduct` hoặc bảng giá khác.

### 11.4. `Discount` trên POS nối với mã CTKM nào?

```sql
SELECT TOP 100
    d.Discount,
    p.Code,
    p.PromotionNo,
    p.Promotion,
    p.StartDate,
    p.EndDate
FROM tbl_SALPoSDetails d
LEFT JOIN tbl_POLPromotion p
    ON CONVERT(nvarchar(100), p.Code) = CONVERT(nvarchar(100), d.Discount)
WHERE d.Discount IS NOT NULL;

SELECT TOP 100
    d.Discount,
    p.Code,
    p.PromotionNo,
    p.Promotion,
    p.StartDate,
    p.EndDate
FROM tbl_SALPoSDetails d
LEFT JOIN tbl_POLPromotion p
    ON CONVERT(nvarchar(100), p.PromotionNo) = CONVERT(nvarchar(100), d.Discount)
WHERE d.Discount IS NOT NULL;
```

Câu trả lời cần rút ra: dùng `Discount = tbl_POLPromotion.Code`, dùng
`Discount = PromotionNo`, hay chỉ coi `Discount` là marker CTKM không join được.

### 11.5. Chi tiết kho nối vào master bằng `Code` hay `DocumentNo`?

```sql
SELECT
    COUNT(*) AS DetailLines,
    SUM(CASE WHEN EXISTS (
        SELECT 1 FROM tbl_OPSImExMaster m WHERE m.Code = d.DocumentNo
    ) THEN 1 ELSE 0 END) AS LinesJoinMasterCode,
    SUM(CASE WHEN EXISTS (
        SELECT 1 FROM tbl_OPSImExMaster m WHERE m.DocumentNo = d.DocumentNo
    ) THEN 1 ELSE 0 END) AS LinesJoinMasterDocumentNo
FROM tbl_OPSImExDetails d;
```

Câu trả lời cần rút ra: nếu `LinesJoinMasterCode` gần bằng `DetailLines`, giữ join
`d.DocumentNo = m.Code` theo FK.

### 11.6. `DocumentType` và `DocumentStatus` nào cộng/trừ tồn?

```sql
SELECT
    m.DocumentType,
    dt.DocumentType AS DocumentTypeName,
    dt.TypeID,
    m.DocumentStatus,
    s.StatusName,
    COUNT(*) AS LineCount,
    SUM(d.Quantity) AS TotalQuantity,
    SUM(d.QtyReceived) AS TotalQtyReceived
FROM tbl_OPSImExDetails d
JOIN tbl_OPSImExMaster m
    ON m.Code = d.DocumentNo
LEFT JOIN tbl_LSDocumentType dt
    ON dt.Code = m.DocumentType
LEFT JOIN tbl_LSStatus s
    ON s.Code = m.DocumentStatus
GROUP BY m.DocumentType, dt.DocumentType, dt.TypeID, m.DocumentStatus, s.StatusName
ORDER BY m.DocumentType, m.DocumentStatus;
```

Câu trả lời cần rút ra: danh sách `DocumentType` nào là nhập tăng tồn, danh sách nào
là xuất giảm tồn, và status nào dùng `Quantity` hay `QtyReceived`.

### 11.7. `receiptHour` nên lấy từ `ReceiptDate` hay `CreateTime`?

```sql
SELECT
    m.DocumentType,
    COUNT(*) AS DocumentCount,
    SUM(CASE WHEN m.ReceiptDate IS NOT NULL AND CONVERT(time, m.ReceiptDate) <> '00:00:00' THEN 1 ELSE 0 END) AS ReceiptDateHasTime,
    SUM(CASE WHEN m.CreateTime IS NOT NULL AND CONVERT(time, m.CreateTime) <> '00:00:00' THEN 1 ELSE 0 END) AS CreateTimeHasTime,
    MIN(m.ReceiptDate) AS MinReceiptDate,
    MAX(m.ReceiptDate) AS MaxReceiptDate
FROM tbl_OPSImExMaster m
GROUP BY m.DocumentType
ORDER BY m.DocumentType;
```

Câu trả lời cần rút ra: cột nào còn giờ thật để xác định nhập trước/sau giờ cắt tồn.

### 11.8. CTKM theo bundle nên dùng `Product`, `RefProduct`, hay barcode?

```sql
SELECT
    COUNT(*) AS BundleLines,
    SUM(CASE WHEN Product IS NOT NULL THEN 1 ELSE 0 END) AS HasProduct,
    SUM(CASE WHEN RefProduct IS NOT NULL THEN 1 ELSE 0 END) AS HasRefProduct,
    SUM(CASE WHEN Barcode IS NOT NULL THEN 1 ELSE 0 END) AS HasBarcode,
    SUM(CASE WHEN IsClosed = 1 THEN 1 ELSE 0 END) AS ClosedLines
FROM tbl_POLBundle;

SELECT TOP 100
    b.Promotion,
    p.Promotion AS PromotionName,
    b.Product,
    b.RefProduct,
    b.Barcode,
    b.Quantity,
    b.MaxQuantity,
    b.PriceDiscount,
    b.Price,
    b.StockQty,
    b.SellQty,
    b.IsClosed
FROM tbl_POLBundle b
LEFT JOIN tbl_POLPromotion p
    ON p.Code = b.Promotion
ORDER BY b.Promotion DESC;
```

Câu trả lời cần rút ra: `Product` đã đủ map SKU với CTKM chưa; `RefProduct` là SKU
tham chiếu thật hay chỉ là dòng bundle nội bộ.

## 12. Rà soát dữ liệu thật đã chạy (2026-07-10): vì sao SO/CTKM/Nền bị rối và vì sao thấy toàn Z không Y

Đối chiếu trực tiếp `src/assets/demand-planning-real.json` (92.400 dòng, 80 SKU đã
xuất thật) thay vì suy đoán, phát hiện 3 vấn đề dữ liệu — không phải lỗi công thức
Chặng 2–7 (`math.ts::isStockout`/`classifyXyz` vẫn đúng theo Developer Spec):

1. **`PromoCode`/`PromoName` bị phủ quá rộng cho một số SKU.** 41,2% số dòng có
   promo (trung bình), nhưng có SKU (`40733`) ra promo **100% trong 1.155 ngày**
   liên tục 3 năm. Kiểm chứng bằng tay: chương trình phủ toàn bộ lịch sử là
   `"GIẢM 5% BEST PRICE - DÀNH RIÊNG KHTT"` — đây là mức giá cố định theo hạng
   thành viên, không phải một đợt CTKM tăng bán theo thời vụ, nhưng
   `tbl_POLPromotion` lưu chung dạng với CTKM thật (`StartDate`/`EndDate` dài).
   Khi gần như mọi ngày đều bị đánh dấu CTKM, Chặng 3/4 gần như không còn ngày
   sạch để làm nền tham chiếu ⇒ nhiều chu kỳ "THIẾU CĂN CỨ", không khóa được ⇒
   `classifyXyz` chỉ nhận được một mẫu thưa và lệch, đẩy nhiều SKU về `Z` thay vì
   phân loại đúng. **Đã sửa:** `demand-planing.sql` thêm tham số
   `@ExcludePromotionCodes` để loại thủ công các mã kiểu "giá cố định" sau khi
   xem bảng chẩn đoán mới "9b. Độ phủ từng mã CTKM" (bật `@ShowDiagnostics = 1`).
   Không tự loại mã nào theo ngưỡng đoán — đúng nguyên tắc không tự đặt ngưỡng
   của dự án; phải xem PromoName + độ phủ ngày rồi xác nhận bằng mắt.
   (Đã thấy vài `tbl_POLPromotion.Code` âm trên dữ liệu thật, ví dụ `-251`,
   `-2837`, `-1330` — ban đầu nghi là mã lỗi/sentinel nên đã lọc `Code > 0`,
   nhưng người dùng xác nhận đây là cách lưu có chủ đích của nghiệp vụ, không
   phải lỗi dữ liệu, nên KHÔNG lọc theo dấu của `Code` nữa; đã gỡ điều kiện đó.)
2. **`ProductName` ra `NULL` 100% (92.400/92.400 dòng)** trong file đã xuất, dù
   mục 9.1b đã có cơ chế tự dò cột. Nhiều khả năng lần chạy sinh ra file này rơi
   vào nhánh "Khong tim thay cot ten san pham" (không cột nào trong 7 tên đoán
   khớp `tbl_LSProduct`). **Đã sửa:** mở rộng danh sách tên cột đoán (thêm
   `ProductNameVi`, `ProductFullName`, `NameVN`, `TenSanPham`, `TenSP`,
   `TenHang`) và thêm bước dự phòng: nếu vẫn không khớp, tự chọn cột kiểu chuỗi
   ngắn nhất có chữ "Name"/"Ten" trong tên. Vẫn cần chạy lại với
   `@ShowDiagnostics = 1` và đọc dòng `PRINT` để xác nhận cột đã chọn đúng.
3. **`src/assets/List-product.json` (sinh ra ngoài repo này) bị lỗi, không dùng
   được để chọn SKU mẫu.** `ActiveCycles`/`ZeroCycles` gần như hằng số cho MỌI
   SKU (64–65/21–23) ⇒ `ApproxDemandShape` ra `"Z_INTERMITTENT"` cho cả 80/80
   SKU và `CoverageScore` = 83 cho cả 80/80 — không phản ánh dữ liệu thật (khi
   tính lại đúng công thức ADI/CV² trên dữ liệu thô, phân bố thật gần
   Z 29 · X 32 · Y 19). File này cũng là nguồn hiển thị nhãn "Dạng nhu cầu
   Z_INTERMITTENT" trong panel danh mục SKU của app — rất có thể đây là nơi
   người dùng thấy "toàn Z, không Y" trước cả khi chạy pipeline thật.
   **Đã thêm** `Sql/demand-planing-sku-coverage.sql`: script quét lại đúng
   ADI/CV²/ABC tạm tính/độ phủ stockout/CTKM cho một tập SKU rộng (không giới
   hạn 80 mã hiện tại), dùng để chọn một bộ SKU thật phủ đủ các trường hợp như
   14 SKU dữ liệu giả (AX-stable…D-zero-stock) — chạy xong, xuất lại
   `List-product.json` (và mở rộng `@ProductCodes` trong `demand-planing.sql`
   nếu muốn thêm SKU) rồi mới tin nhãn phân loại hiển thị trong app.

Ngoài ra, có 164/92.400 dòng (9 SKU) tồn âm (`OpenStock`/`CloseStock` < 0) — dấu
hiệu ghi nhận chứng từ lệch thứ tự trong ERP nguồn (bán ghi trước, nhập kho ghi
sau). Quy mô nhỏ, chỉ mới thêm bảng đếm ở mục "9c" của `demand-planing.sql`,
chưa sửa vì không có căn cứ để đoán giá trị tồn đúng.

## 13. Bộ dữ liệu thật thứ hai (2026-07-10, 19 SKU từ `demand-planning-real.txt`): nền CTKM ra 0 và câu hỏi "CTKM thường trực"

Bộ dữ liệu thật khác (19 SKU, từ `src/assets/demand-planning-real.txt` — định dạng
**thưa**, chỉ ghi dòng khi tồn/bán thay đổi, đã convert thành
`src/assets/demand-planning-real.json` đủ một dòng/ngày, xác nhận
`CloseStock[i-1] === OpenStock[i]` đúng 100% qua mọi khoảng hở trước khi mở rộng) cho
kết quả Chặng 7: **0/19 SKU thuộc X hoặc Y**, dù raw sales cho thấy nhiều SKU bán rất
tốt (ví dụ SKU `48902` CocaCola 160ml: 22.205 đơn vị/3 năm).

**Cơ chế đã chứng minh:** với mọi 19 SKU, ngày "sạch" (không CTKM, không stockout) có tỷ
lệ ngày bán > 0 rất thấp (0–42%), trong khi 40–100% tổng doanh số nằm trên ngày có
CTKM. Chặng 4 tính `Bₜ = Median(ngày sạch quanh vùng)` đúng công thức §4 — nhưng vì ngày
sạch gần như luôn bán = 0, median ra 0 cho hầu hết vùng CTKM, kéo `baseDemand` của phần
lớn chu kỳ về 0, đẩy ADI > 1,32 → luôn rơi vào Z (không bao giờ đạt X/Y).

Người dùng xác nhận (2026-07-10): CTKM **thường trực** (chính sách giá cố định theo hạng
khách hàng, ví dụ "GIẢM 5% GIÁ TỐT NHẤT - DÀNH RIÊNG KHTT") nên được coi là một phần
của nền bán bình thường, không phải nội dung Chặng 4 cần chuẩn hóa/loại bỏ.

**Đã cài đặt (engine, không phải SQL, vì file `.txt` này đi thẳng vào app không qua
`demand-planing.sql`):**

- `SimulationPolicy.standingPromotionCodes` (`models.ts`) — danh sách mã CTKM thường
  trực, rỗng theo mặc định.
- `stripStandingPromoCodes()` (`math.ts`) — loại các mã này khỏi `promoCode` đã ghép
  nhiều mã bằng `|`; ngày chỉ dính mã thường trực trở thành ngày không CTKM (bán bình
  thường); nếu còn mã chiến dịch khác thì ngày đó vẫn là ngày CTKM.
- Áp dụng ở Chặng 1 (`simulation-engine.ts::runStage1`), trước khi bất kỳ chặng nào
  khác đọc `promoCode` — áp dụng cho toàn bộ `allRows` (kể cả phần dùng tính
  `futurePromotions`), không chỉ phần `daily` đưa vào chu kỳ.
- `DEFAULT_POLICY.standingPromotionCodes` (`policy.ts`) đã điền 19 mã xác nhận là
  "GIẢM 5% GIÁ TỐT NHẤT/BEST PRICE - DÀNH RIÊNG KHTT" trên bộ 19 SKU này:
  `-165, 17607, 17715, 17736, 27763, 27782, 27861, 27886, 27891, 27892, 27902, 27912,
  27927, 38101, 38216, 38231, 38242, 38350, 38373`.

**Kết quả thực tế sau khi cài (quan trọng — đọc kỹ):** áp danh sách trên vào Chặng 7
**KHÔNG đổi bất kỳ SKU nào** (vẫn 0 X, 0 Y). Lý do: 19 mã "GIẢM 5%...KHTT" này chỉ hoạt
động 2023–2024 (kiểm tra `first`/`last` từng mã), còn cửa sổ phân loại (24 chu kỳ gần
`runDate` nhất, tức khoảng 2025-02 → 2026-02) đã KHÔNG còn mã nào trong số đó — chương
trình giá cố định này có vẻ đã ngừng trước 2025.

**Phát hiện mới, khác bản chất, cần quyết định riêng:** từ 2025 trở đi, mẫu hình chi
phối không phải "một mã cố định" mà là **"HACHI KHUYẾN MÃI" chạy nối tiếp gần như mỗi
tháng** (`(1/3-31/3)`, `(1/4-4/5)`, `(2/6-30/6)`, `(1/7-31/7)`, `(3/9-30/9)`,
`(1/10-31/10)`, `(1/11-30/11)`, `(1/12-4/1)`...), gần như không có ngày trống giữa hai
đợt. Đây là các chiến dịch **có tên, có khung ngày cụ thể, hợp lệ theo đúng nghĩa CTKM
chiến dịch** — KHÁC bản chất với "giá cố định theo hạng khách hàng" mà bạn vừa xác nhận.
Nhưng vì gần như không có ngày trống giữa các đợt, hệ quả toán học vẫn giống hệt: không
đủ ngày sạch để làm nền tham chiếu. Đây là câu hỏi chính sách MỚI, chưa xin ý kiến:

> Có nên coi các đợt CTKM chiến dịch chạy sát nhau, gần như liên tục quanh năm (không
> phải giá cố định, mà là tần suất tổ chức) cũng là một phần của nền bình thường
> không, hay giữ nguyên đúng theo Chặng 4 (chấp nhận baseDemand thấp/0 vì đó là thực
> tế: SKU gần như chỉ bán được khi có chương trình)?

Chưa tự quyết theo hướng nào — nếu chọn coi các đợt "HACHI KHUYẾN MÃI" hàng tháng là nền
bình thường, cơ chế `standingPromotionCodes` đã có sẵn để áp dụng, chỉ cần điền đúng mã
sau khi xác nhận.

## 14. Root cause THẬT SỰ của "0 X, 0 Y" (2026-07-10, phát hiện sau khi người dùng tự
    rà `demand-planing.sql`): ngày không có bản ghi bị coi nhầm là "bán = 0 đã xác nhận"

Mục 12/13 ở trên đúng nhưng CHƯA phải nguyên nhân lớn nhất. Người dùng tự sửa
`demand-planing.sql` thành bản dựng `#ProductDates` chỉ từ `#MovementDaily` (chỉ lấy
ngày có phát sinh) và tự kiểm chứng: lọc `tbl_SALPoSDetails.Qty = 0` trên tập SKU đang
chạy chỉ ra ĐÚNG 1 dòng — xác nhận `tbl_SALPoSDetails` là event-driven thật (chỉ sinh
dòng khi Qty thay đổi, không sinh dòng Qty=0 cho ngày không bán).

**Lỗi kép đã xác nhận:**

1. Khi convert file thưa này thành dữ liệu dày (bản trước của tôi, mục 12), tôi đã tự
   gán `Sales=0, OpenStock=CloseStock=(giá trị cuối đã biết)` cho MỌI ngày không có dòng
   nguồn — vi phạm trực tiếp **nguyên tắc bất biến #2** của Developer Spec: *"Giá trị 0
   là dữ liệu thật. Ngày không có bản ghi không được suy diễn thành bán = 0, tồn = 0 hay
   stockout [C1 §3]"*.
2. Hệ quả nghiêm trọng hơn cả việc tính sai MỘT ngày: những ngày "bán=0 giả định" này bị
   engine dùng làm **NGÀY SẠCH THAM CHIẾU** cho các ngày CTKM/stockout ở gần nó (Chặng
   3/4's `selectReferences`/`isObservedClean`) — tức là median tham chiếu của rất nhiều
   ngày CTKM thật bị kéo về gần 0 bởi các ngày "sạch giả" chen vào, không phải vì SKU đó
   thật sự không bán được ngoài CTKM (đây là lý do phát hiện mục 12 có vẻ đúng nhưng thật
   ra chỉ là TRIỆU CHỨNG của lỗi này).

**Đã sửa (cả engine lẫn 2 nguồn dữ liệu):**

- `models.ts`: thêm `DailyRecord.hasRecord: boolean` — `false` ⇔ ngày scaffold không có
  dòng nguồn; `sales` ở dòng đó chỉ là placeholder, không được tin.
- `math.ts::isStockout`: nhánh `emptyAllDay` (cần Q=0 đã xác nhận) gate theo
  `hasRecord`; nhánh `lateReceipt` không cần (tồn kho là nguồn độc lập, vẫn tin được).
- `simulation-engine.ts`: `isObservedClean` gate theo `hasRecord` (ngày không có bản ghi
  không bao giờ được chọn làm tham chiếu cho ngày khác); `runStage3` không tự nâng nền
  cho ngày `!hasRecord` — gán thẳng `baseSource:'insufficient'`, giao **nguyên vẹn** cho
  Chặng 5 lấp nền kỹ thuật (đúng yêu cầu: chỉ MỘT nơi quyết định lấp nền).
- `tools/convert-real-data.mjs` (mới, thay bản nháp cũ): convert
  `demand-planning-real.txt` → `demand-planning-real.json`, đánh dấu đúng
  `HasRecord=true` cho ngày có dòng nguồn, `HasRecord=false` cho MỌI ngày còn lại
  (không còn tự "chứng minh bằng sổ tồn kho" như bản nháp trước — giao hẳn cho Chặng 5).
  Chạy lại: `npm run convert:real-data`.
- `demand-planing.sql` mục 7/10: dựng lại trục thời gian **liên tục, một dòng/ngày**
  (CTE đệ quy `#Dates`, neo theo ngày phát sinh đầu tiên của TỪNG SKU — không lùi về
  `@StartDate` chung, đúng "SKU có dữ liệu một phần vẫn xử lý phần đang có" [C1]), thêm
  cột `HasRecord`, và đổi OpenStock/CloseStock từ subquery tương quan O(n²) sang
  `SUM() OVER` cộng dồn O(n log n) — vừa đúng lại vừa nhanh hơn khi trục thời gian dày
  trở lại.

**Kết quả thực nghiệm (bộ 19 SKU, so trước/sau):**

| | Trước (sales=0 giả định cho ngày khuyết) | Sau (hasRecord, giao Chặng 5) |
|---|---|---|
| Chặng 7 | 0 X · 0 Y · 14 Z · 5 D | 15 X · 0 Y · 0 Z · 4 D |
| SKU `33959` | Z, ADI=6,00 | X, ADI=1,00, CV²=0,032 |
| SKU `48902` | D (m=0/24 — CocaCola 22.205 đv/3 năm bị coi "không nhu cầu") | X, n=18, m=18, ADI=1,00 |

4 SKU còn `D` (`33970`, `55875`, `60537`, `164034`) là các SKU lịch sử thật sự ngắn/thưa
(≤3 chu kỳ khóa được) — đúng bản chất `n<6`, không phải lỗi.

**Việc cần làm tiếp:** đây là kết quả trên bộ 19 SKU export tay; cần chạy lại
`demand-planing.sql` đã sửa trên DB thật để xác nhận `HasRecord` tính đúng ở quy mô lớn
hơn, và xem lại câu hỏi "CTKM thường trực"/"HACHI KHUYẾN MÃI liên tục" ở mục 13 có còn
đáng kể sau khi lỗi lớn hơn này đã sửa hay không (rất có thể một phần hiện tượng ở mục
13 chỉ là triệu chứng phụ của lỗi này, cần đo lại trên dữ liệu đã sửa trước khi quyết).
