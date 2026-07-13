# Hướng dẫn sử dụng bộ tài liệu — Bản 3

## 0. Thiết lập bắt buộc cho AI

1. Đặt `INSTRUCTIONS.md` tại root repository.
2. Đặt các file governance còn lại trong `docs/demand-planning-governance/`.
3. Thực hiện handshake theo `11-Quy-trinh-dua-INSTRUCTIONS-vao-he-thong.md`.
4. Không cho sửa code nếu AI chưa xuất Preflight.


## 1. Khi kiểm duyệt nghiệp vụ

Đọc theo thứ tự:

1. `01-Danh-sach-quyet-dinh-nghiep-vu.md` — kiểm tra các quyết định đã khóa và đề xuất.
2. `Tài liệu giải pháp...(26).md` — đọc toàn bộ giải pháp dễ hiểu.
3. `06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md` — duyệt cách xử lý khi hệ thống không đủ dữ liệu.
4. `07-Danh-muc-Golden-Test.md` — duyệt kết quả mong đợi trước khi code.

## 2. Khi kiểm tra dữ liệu POS/ERP

1. Đọc `demand-planing-data-source-notes-v3.md`.
2. Chạy từng khối trong `03-Kiem-tra-du-lieu-nguon.sql`.
3. Ghi kết quả vào biên bản khảo sát.
4. Sau khi các mapping được xác nhận, chạy `demand-planing-v3.sql`.

`demand-planing-v3.sql` trả ba result set:

- Result set 1: ngày có nguồn thật;
- Result set 2: khoảng CTKM lịch sử;
- Result set 3: metadata.

Module phải nhập đủ cả ba. Không convert riêng result set 1 rồi tự suy diễn CTKM trên ngày thiếu.

## 3. Khi giao AI vibe coding

1. Chỉ giao một chặng.
2. Đính kèm `04`, `05`, `07` và phần tương ứng của tài liệu giải pháp.
3. Dùng prompt trong `09-Bo-prompt-vibe-coding-Demand-Planning.md`.
4. Bắt AI xuất bảng Rule → hàm → test.
5. Không chấp nhận câu “đã hoàn thành” nếu golden test chưa chạy.

## 4. Khi review kết quả mô phỏng

Dùng `08-Dac-ta-bao-cao-mo-phong-va-Audit-Explorer.md` làm checklist. Sau khi sửa code, điền `10-Bao-cao-so-sanh-truoc-va-sau.md`.

## 5. File không dùng để code trực tiếp

- báo cáo mô phỏng cũ;
- JSON dữ liệu thật chưa có metadata;
- ghi chú hoặc SQL cũ đã bị thay thế.

Chúng chỉ dùng làm bằng chứng/regression.

## 6. Thứ tự triển khai ưu tiên của bản 3

1. Cổng chất lượng `RULE-05-006`.
2. Hợp đồng ABC `RULE-06-003`.
3. Cửa sổ XYZ và định nghĩa D `RULE-07-001`–`RULE-07-004`.
4. Hợp đồng đầu vào dự báo `RULE-11-001`.
5. Golden Test GT-31–GT-40.
6. Sau khi đạt mới chạy lại SKU 31054 và các SKU khác.
