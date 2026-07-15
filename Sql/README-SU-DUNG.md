# Hướng dẫn sử dụng bộ tài liệu

## 1. Khi kiểm duyệt nghiệp vụ

Đọc theo thứ tự:

1. `01-Danh-sach-quyet-dinh-nghiep-vu.md` — kiểm tra các quyết định đã khóa và đề xuất.
2. `Tài liệu giải pháp...(26).md` — đọc toàn bộ giải pháp dễ hiểu.
3. `06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md` — duyệt cách xử lý khi hệ thống không đủ dữ liệu.
4. `07-Danh-muc-Golden-Test.md` — duyệt kết quả mong đợi trước khi code.

## 2. Khi kiểm tra dữ liệu POS/ERP

1. Đọc `demand-planing-data-source-notes.md`.
2. Chạy từng khối trong `docs/Demand-Planning-Governance-Package-v3/03-Kiem-tra-du-lieu-nguon.sql`.
3. Ghi kết quả vào biên bản khảo sát.
4. Sau khi các mapping được xác nhận, chạy `demand-planing.sql` (demand-planing-v6-pos-real-backtest).

`demand-planing.sql` chỉ ĐỌC dữ liệu đã tồn tại trong POS (không INSERT/UPDATE/DELETE), tái tính tồn từ
toàn bộ phát sinh, và CHỈ xuất dữ liệu khi tồn tái tính khớp `dbo.tbl_LSProduct.Quantity`
(`StockReconciliationGate = PASS` trong RESULT SET 3). Nếu gate `FAIL`, KHÔNG được tắt
`@FailOnStockMismatch` để ép chạy — phải tìm nguyên nhân (sai database, lịch sử bị purge, mapping chứng
từ sai) trước khi export lại.

`demand-planing.sql` trả ba result set:

- Result set 1 (`DailySourceRecord`, hợp đồng `DAILY-SOURCE-V2`): ngày có nguồn thật, dạng THƯA. `Sales`
  là `number | null` — `null` khi `HasSalesRecord=false` (không có dòng bán POS thật trong ngày), khác
  hẳn `Sales=0` (`HasSalesRecord=true`, có dòng bán thật với tổng Qty bằng 0). Tương tự cho cặp
  `ReturnQty/HasReturnRecord` và `InventoryNetMovement/HasInventoryMovement`. `IsOpeningAnchor=true` chỉ
  dùng để thiết lập trạng thái tồn trước khung đọc — KHÔNG phải ngày lịch sử, bị loại khỏi
  `dailyBySku` ngay tại `catalog.ts`.
- Result set 2 (`PromotionInterval`): khoảng CTKM lịch sử gắn trực tiếp SKU (`tbl_POLBundle.Product = SKU`).
- Result set 3 (`ExtractMetadata`): phạm vi, watermark, gate đối soát tồn và giả định. `parseRealDataset`
  (`src/app/domain/catalog.ts`) CHẶN nạp dữ liệu vào mô phỏng nếu `StockReconciliationGate ≠ PASS` — không
  fallback âm thầm sang dữ liệu giả.

Chuyển đổi TSV export sang JSON bằng `tools/convert-real-data.mjs <input.txt> <output.json>` — script tự
nhận diện đang convert result set nào qua tên cột header (`HasSalesRecord`/`PromoTypeSource`/
`StockReconciliationGate`). Không convert riêng result set 1 rồi tự suy diễn CTKM trên ngày thiếu.

**Ghi chú tương thích**: bản trước dùng `demand-planing-v3.sql`/`-data-source-notes-v3.md` trong
`docs/Demand-Planning-Governance-Package-v3/` với `Sales: number` không nullable — đã THAY THẾ hoàn toàn
bởi hợp đồng `DAILY-SOURCE-V2` này (không giữ nhánh tương thích ngược). Asset thật đang có trong
`src/assets/demand-planning-real.json` vẫn ở định dạng cũ cho tới khi được export lại bằng pipeline mới;
nguồn "Dữ liệu thật" trong ứng dụng sẽ báo lỗi rõ ràng (không fallback mock) cho tới lúc đó.

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
