# Báo cáo rà soát — Tài liệu giải pháp & Website mô phỏng

Ngày rà soát: 02/07/2026. Phạm vi: đối chiếu `Tài liệu giải pháp - Demand Planning & Replenishment Governance.md` (19 chặng) với `simulation.js` / `index.html`.

---

## Phần A — Quyết định chỉnh TÀI LIỆU GIẢI PHÁP

| # | Vị trí | Vấn đề đã rà soát | Quyết định áp dụng |
|---|---|---|---|
| A1 | Mục lục cấp 1 | Nhảy từ `# 2. Sơ đồ hành trình tổng thể` sang `# 4. Các chặng xử lý`. | Đánh lại `Các chặng xử lý` thành mục `# 3`; các mục cấp 1 sau đó dồn lên theo đúng thứ tự. |
| A2 | Cuối tài liệu | Khối `Hướng dẫn sử dụng` và `Đầu ra khóa` của Chặng 19 đang bị đặt như heading cấp 1. | Đưa hai khối này về heading cấp 3 thuộc Chặng 19; đánh lại số các mục cấp 1 cuối tài liệu. |
| A3 | Bảng tổng hợp đầu ra | Bảng tổng hợp đầu ra vẫn cần giữ lại vì đây là bảng bàn giao giữa các chặng. | Không bỏ bảng. Chỉnh lại để bảng có đủ 19 chặng và đúng đầu ra của từng chặng. |
| A4 | `# 8. Báo cáo kiểm tra chất lượng` | Mục này không còn cần nằm trong tài liệu giải pháp chính. | Bỏ mục `# 8. Báo cáo kiểm tra chất lượng`. |
| A5 | Chặng 11 | Cần làm rõ Grid Search thô + kiểm tra mịn có thay thư viện được không. | Ghi rõ: Grid Search có thể thay thư viện ở mức triển khai ban đầu hoặc kiểm soát nội bộ; không thay thế hoàn toàn thư viện chuẩn cho Holt-Winters/ETS đầy đủ. |
| A6 | Chặng 6 | Quy tắc biên nhóm C cần thống nhất với ví dụ và code. | Chốt nhóm C từ mức lũy kế `>= 90%`; ví dụ phải chỉnh để không gán dòng đúng 90% vào B. Mô phỏng phải sửa theo quy tắc này. |
| A7 | Chặng 2 | Thuật ngữ "giờ nhập thực tế" và "phiếu nhập đầu tiên" dễ hiểu thành hai biến khác nhau. | Thống nhất dùng "giờ nhập đầu tiên"; đây là trường giờ nhập trên phiếu nhập đầu tiên trong ngày. |
| A8 | Chặng 16 §6, Chặng 17 §6 | Cột "Chặng sau được dùng" có tham chiếu lỗi như "Chặng 17, 16, 17", "Chặng 18, 18". | Sửa lại số chặng tham chiếu theo đúng nơi sử dụng thực tế. |
| A9 | Chặng 4 §6.1 | CTKM sát nhau không đủ ngày sạch nằm giữa cần xử lý thống nhất. | Coi các CTKM đó như một cụm CTKM, tức một CTKM kéo dài, rồi bù nền theo quy tắc Chặng 4. |
| A10 | Chặng 5 §13 | Hàng "Danh sách ngày không được dùng làm nguồn tham chiếu" đang trỏ về cả chặng trước. | Sửa thành các chặng sử dụng thực tế: Chặng 5 và Chặng 19. |

Các quyết định trên đã được dùng làm chuẩn chỉnh tài liệu giải pháp.

---

## Phần B — Sai lệch của CODE so với tài liệu (đã sửa trong lần refactor này)

| # | Vị trí code cũ | Sai lệch | Cách sửa |
|---|---|---|---|
| B1 | `runStage2` | Tự chế thêm quy tắc "SKU bán thưa: nếu cả chu kỳ không có nhu cầu thì bỏ cờ stockout" — **không có trong tài liệu** (C2 chỉ có đúng 2 điều kiện) | Xóa heuristic; giữ đúng 2 điều kiện |
| B2 | `processCycles` / `runStage5` | Chu kỳ còn ngày thiếu căn cứ vẫn được cộng (ngày thiếu tính 0) và **vẫn được dùng để học** ở C6/C7/C9/C10/C11 — vi phạm C5 §7 ("chu kỳ chỉ được gom khi đủ 15 ngày nền") | Thêm trạng thái `locked` / `emptyCycle`; lấp nền chỉ khi chu kỳ có ≥1 ngày đủ căn cứ; các chặng sau **chỉ đọc chu kỳ đã khóa** |
| B3 | `runStage6` | Điểm cắt C = lũy kế > 95% hoặc > 90% đều không khớp quyết định mới nếu bỏ qua trường hợp đúng 90%. | Đổi về `>= 90%`. |
| B4 | `analyzeSeasonality` | Kết luận vị trí LẶP CAO/THẤP chỉ dựa tỷ lệ lặp 67%, **thiếu điều kiện hệ số mùa vụ** `S_p ≥ 1,15` / `≤ 0,85` (C9 §8 yêu cầu CẢ HAI) | Bổ sung điều kiện hệ số |
| B5 | `resolveForecastModelSelection` | Chọn mô hình dựa vào **metadata `type` của SKU** (nhìn trước đáp án: "trend" → Holt kể cả khi C9 xác nhận mùa vụ; "seasonal" → HW cho cả nhóm không phải Y) — vi phạm bảng chuyển nhánh C11 §3 | Viết lại: chỉ dùng đầu ra C7/C9/C10; nhóm X kiểm tra xu hướng bằng đúng thuật toán C10 rồi so backtest Holt vs SES (Holt không tốt hơn → SES) |
| B6 | `runCroston` + trace | Khởi tạo `P = i + 1` (khoảng cách tính **từ đầu chuỗi** đến lần phát sinh đầu) — tài liệu **cấm** (C11 §8.4/§8.5); dự báo hiện ra ngay sau lần phát sinh 1 | Sửa: `P₁ = t₂ − t₁` (giữa 2 lần phát sinh); F = null khi chưa đủ 2 lần phát sinh; <2 lần phát sinh → không khóa Croston tự động |
| B7 | `detectPeriodicIntermittentDemand` | Yêu cầu **quy mô mỗi lần bán bằng nhau tuyệt đối** mới nhận nhịp làm hệ thống bỏ sót SKU có nhịp rõ nhưng lượng bán dao động nhẹ. | Kiểm tra khoảng cách phát sinh ổn định; quy mô phát sinh lấy theo trung vị hoặc ngưỡng ổn định đã duyệt trong Chặng 11. |
| B8 | Trace Croston | Bug: gán biến `P_title` chưa khai báo (rò biến toàn cục), tooltip khoảng cách không hiển thị | Sửa tên biến, hiển thị đúng |
| B9 | Toàn cục | Chỉ mô phỏng 11/19 chặng | Bổ sung Chặng 12 (hệ số KM), 13 (áp CTKM tương lai), 14 (nguồn hàng & vị thế tồn), 15 (tồn kho an toàn) theo phạm vi anh chọn |
| B10 | `runStage11` | Không có so sánh "Holt phải tốt hơn SES" trước khi khóa (C11 §6.6); không tạo **dự báo nền tương lai** cho chặng sau | Thêm so sánh backtest và dự báo 6 chu kỳ tương lai (đầu vào C13/C15) |
| B11 | `simulation.test.js` | Test cũ khẳng định hành vi sai B5 (Y + mùa vụ → Holt) | Viết lại bộ test theo tài liệu (21 test T01–T21 trong Developer Spec) |

## Phần C — Diễn giải mô phỏng (không phải sai lệch, cần biết)

1. Dữ liệu là **dữ liệu sinh giả lập** (14 SKU điển hình + 200 SKU catalog); mỗi SKU sinh tròn bội số 15 ngày kết thúc ngay trước ngày chạy, nên lịch chu kỳ của SKU trùng với lịch chu kỳ phiên.
2. Ngưỡng WAPE/Bias theo ô ABC×XYZ ở Chặng 11 là **bảng minh họa** — tài liệu yêu cầu xác lập bằng backtest trên dữ liệu thật và phê duyệt (C11 §10.5).
3. Chặng 14–15: lead time, lô đang về, cam kết là **số liệu mô phỏng** (120 ± 18 ngày ≈ 8 ± 1,2 chu kỳ) đúng bối cảnh nhập khẩu 3–6 tháng của tài liệu.
4. Chặng 13: kế hoạch CTKM tương lai được giả lập từ chính lịch CTKM định kỳ (FLASH20, MUA2G10, …) chiếu sang các chu kỳ tương lai.
