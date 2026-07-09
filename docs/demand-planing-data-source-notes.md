# Ghi chú nguồn dữ liệu cho Demand Planning

File này lưu lại phần ghi chú/khảo sát dữ liệu trước đó từng nằm trong `demand-planing.sql`.

Mục đích: giúp biết các bảng nào trong POS chứa dữ liệu cần lấy để chạy thử mô phỏng Demand Planning, không phải file SQL chính để chạy lấy dữ liệu.

File SQL chính hiện tại để chạy là:

```text
docs/demand-planing.sql
```

## 1. Các bảng nguồn cần kiểm tra

### 1.1. Bán lẻ chi tiết: `tbl_SALPoSDetails`

Vai trò:

- Bảng chi tiết bán lẻ theo từng sản phẩm.
- Mỗi dòng gắn với một sản phẩm bán ra trong hóa đơn POS.
- Đây là nguồn chính để lấy `sales`.

Cột quan trọng:

```text
PoSMaster
Product
Qty
Amount
Revenue
Discount
DiscountCouponInv
DiscountGroupProduct
RePosDetails
Barcode
```

Logic hiện tại cần dùng với POS thật:

```sql
sales = SUM(tbl_SALPoSDetails.Qty)
WHERE tbl_SALPoSDetails.Product = mã sản phẩm
  AND tbl_SALPoSDetails.RePosDetails IS NULL
```

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
```

### 1.2. Bán lẻ master: `tbl_SALPoSMaster`

Vai trò:

- Bảng header/master của hóa đơn POS.
- Dùng để lấy ngày bán đã chốt.

Cột quan trọng:

```text
Code
TransactionNo
TransactionDate
TransactionType
Amount
Revenue
Discount
DiscountCard
VAT
CashPaid
CardPaid
VoucherPaid
ReturnPaid
CreateTime
LastModifiedTime
```

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

Cột quan trọng:

```text
Code
DocumentNo
DocumentType
DocumentStatus
EffDate
ReceiptDate
Source
Destination
Reference
Inventory
PO
CreateTime
LastModifiedTime
```

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
```

### 2.2. Phiếu nhập/xuất chi tiết: `tbl_OPSImExDetails`

Vai trò:

- Dòng chi tiết sản phẩm của chứng từ nhập/xuất.
- Dùng để tính phát sinh tồn theo sản phẩm/ngày.

Cột quan trọng:

```text
DocumentNo
Product
Quantity
QtyReceived
UnitPrice
AvgPrice
ExpiredDate
RefID
```

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
```

## 3. Loại chứng từ: `tbl_LSDocumentType`

Vai trò:

- Bảng danh mục loại chứng từ.
- Không phải bảng phát sinh giao dịch.
- Dùng để hiểu ý nghĩa của `tbl_OPSImExMaster.DocumentType`.

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_LSDocumentType;
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

Cột quan trọng:

```text
Code
PromotionNo
Promotion
PromotionType
StartDate
EndDate
IsPOS
IsUse
Type
Amount
DetermineGift
```

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_POLPromotion;
```

### 5.2. Chi tiết/gói khuyến mãi: `tbl_POLBundle`

Vai trò:

- Dòng sản phẩm áp dụng trong chương trình.
- Dùng để map sản phẩm với promotion.

Cột quan trọng:

```text
Product
RefProduct
Promotion
Quantity
MaxQuantity
PriceDiscount
Price
Barcode
PosCode
StockQty
SellQty
```

Câu kiểm tra:

```sql
SELECT TOP 100 *
FROM tbl_POLBundle;
```

Logic CTKM hiện tại:

```sql
tbl_POLBundle.Product hoặc tbl_POLBundle.RefProduct = Product
AND tbl_POLPromotion.Code = tbl_POLBundle.Promotion
AND ngày BETWEEN StartDate AND EndDate
```

Ngoài ra, trên dòng POS có thể có marker CTKM:

```text
tbl_SALPoSDetails.Discount
tbl_SALPoSDetails.DiscountCouponInv
tbl_SALPoSDetails.DiscountGroupProduct
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
sales = SUM(tbl_SALPoSDetails.Qty)
WHERE tbl_SALPoSDetails.RePosDetails IS NULL
```

Không dùng:

```sql
tbl_SALPoSMaster.TransactionType = 2
```

vì điều kiện này làm sales ra 0 trên dữ liệu POS thật.

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

### 6.8. `promoCode`

Nguồn 1: lịch CTKM:

```text
tbl_POLPromotion + tbl_POLBundle
```

Nguồn 2: marker trên dòng POS:

```text
Discount
DiscountCouponInv
DiscountGroupProduct
```

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

6. Nếu output toàn `0`, không được dùng để test module. Phải kiểm tra lại:

   ```sql
   SELECT Product, SUM(Qty)
   FROM tbl_SALPoSDetails
   WHERE Product IN (28972, 28973, 47297)
     AND RePosDetails IS NULL
   GROUP BY Product;
   ```
