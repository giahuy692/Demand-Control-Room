# Quy trình phê duyệt và xử lý ngoại lệ

## 1. Mục tiêu

Biến các câu “cần phê duyệt” trong tài liệu giải pháp thành một luồng chức năng có trạng thái, người chịu trách nhiệm và lịch sử quyết định.

## 2. Loại phê duyệt

### 2.1. Chính sách chung

- ngưỡng ABC;
- ngưỡng ADI/CV²;
- số chu kỳ tối thiểu;
- danh sách CTKM thường trực;
- ma trận mức phục vụ ABC×XYZ;
- ngưỡng chất lượng chu kỳ;
- ngưỡng sai số dự báo.

### 2.2. Ngoại lệ SKU/nơi bán

- override ABC;
- override XYZ/D;
- chọn cửa hàng tương đồng;
- chọn SKU tương tự;
- hệ số quy đổi;
- `MANUAL_HISTORICAL_BASELINE` để phục hồi lịch sử;
- `MD_FUTURE_PLAN` để dự báo tương lai;
- loại CTKM chưa phân loại;
- mô hình dự báo thủ công.


## 2.3. Phân biệt ba hướng xử lý

| Hướng | Dùng khi nào | Có làm thay đổi lịch sử không? |
|---|---|---:|
| Phục hồi nền lịch sử | Ngày/CK Chặng 3–5 còn thiếu; ưu tiên ngày sạch cùng SKU/cửa hàng, cửa hàng tham chiếu hoặc nền lịch sử thủ công đã duyệt | Có, nhưng phải lưu nguồn và version |
| SKU tương tự/cửa hàng tham chiếu | Hệ thống đề xuất nguồn đối chứng; chỉ áp sau phê duyệt | Cửa hàng tham chiếu có thể phục hồi lịch sử; SKU tương tự mặc định dùng dự báo tương lai, không tự điền lịch sử |
| Kế hoạch MD | SKU mới hoặc không thể tự học để tạo dự báo tương lai | Không; không mặc định điền ngày lịch sử |

**Cửa hàng tham chiếu** là cửa hàng khác bán cùng SKU, có dữ liệu sạch hơn và có giai đoạn chồng lấn để xác lập hệ số quy đổi. Không được chọn chỉ vì cùng khu vực hoặc cùng quy mô nếu chưa có bằng chứng.

**SKU tương tự** do AI/thuật toán đề xuất theo ngành hàng, công dụng, quy cách, giá và hình dạng nhu cầu. AI không có quyền tự duyệt.

## 3. Trạng thái

```text
DRAFT
PROPOSED
UNDER_REVIEW
APPROVED
REJECTED
EFFECTIVE
EXPIRED
SUPERSEDED
```

Task xử lý ngoại lệ:

```text
OPEN
CANDIDATE_FOUND
WAITING_APPROVAL
APPROVED
REJECTED
RESOLVED
```

## 4. Vai trò đề xuất

| Nội dung | Người đề xuất | Người duyệt |
|---|---|---|
| Chính sách dữ liệu/nền | BA/Data | Chủ nghiệp vụ Demand Planning |
| CTKM thường trực/loại CTKM | Marketing/MD | Quản lý Marketing/MD |
| SKU tương tự | Hệ thống/MD | MD/Thu mua |
| ABC/XYZ | Hệ thống/BA | Chủ nghiệp vụ + Thu mua |
| Ma trận mức phục vụ | BA/Thu mua | Quản lý Thu mua/Tài chính |
| Override số đặt | Thu mua | Người có quyền ngân sách |

Tên vai trò cụ thể cần map vào cơ cấu Hachi trước khi code quyền.

## 5. Dữ liệu phê duyệt bắt buộc

- `ApprovalId`;
- loại quyết định;
- phạm vi SKU/nơi bán hoặc toàn hệ thống;
- giá trị hệ thống đề xuất;
- giá trị được duyệt;
- bằng chứng;
- lý do;
- người tạo/người duyệt;
- thời điểm;
- phiên bản hiệu lực;
- ngày hết hiệu lực;
- liên kết quyết định bị thay thế.

## 6. Hàng đợi ngoại lệ

| Mã lỗi | Ví dụ hành động |
|---|---|
| `BASELINE_NOT_IDENTIFIABLE` | Phục hồi bằng cửa hàng tham chiếu/`MANUAL_HISTORICAL_BASELINE`; nếu không thể, chọn chiến lược dự báo tương lai. |
| `PROMO_TYPE_UNKNOWN` | Phân loại CTKM. |
| `STOCK_ANCHOR_MISSING` | Bổ sung mốc tồn/đối soát nguồn. |
| `ABC_SCOPE_INCOMPLETE` | Chạy toàn danh mục hoặc dùng snapshot đã duyệt. |
| `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY` | `DemandClass=null`; xử lý gốc Chặng 3–5 hoặc phê duyệt chiến lược dự báo tạm. |
| `CLASSIFICATION_BLOCKED` | Không gán D; hiển thị CK gây đứt chuỗi và hành động cần làm. |
| `TRUE_SHORT_HISTORY` | Có thể gán D và yêu cầu `MD_FUTURE_PLAN`/SKU tương tự đã duyệt. |
| `POLICY_UNRESOLVED` | Duyệt ma trận/chính sách trước chặng sau. |

## 7. Không hồi tố

Quyết định mới chỉ áp dụng từ phiên có hiệu lực. Không sửa ngược:

- chu kỳ đã khóa;
- nhóm ABC/XYZ đã dùng;
- dự báo đã khóa;
- đơn đã phát hành.

Phiên mới lưu liên kết tới phiên/quyết định cũ để so sánh.
