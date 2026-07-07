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

## Phần D — Rà soát độ chính xác mô hình dự báo C11 (bổ sung 2026-07-06)

### D.1 Kết quả kiểm định cài đặt so với Developer Spec

Đối chiếu từng công thức trong `forecast-models.ts` với C11 §5–§8.6 và chạy backtest toàn danh mục:

| SKU | Kiểu dữ liệu | Nhánh mô hình | WAPE backtest | Đánh giá |
|---|---|---|---|---|
| SKU-001 | Ổn định | SES (α=0,05) | 2,1% | ✅ đúng nhánh, đúng công thức |
| SKU-002 | Mùa vụ 24 CK | Holt-Winters | 4,6% | ✅ S/L/T khởi tạo & cập nhật đúng §7 |
| SKU-003 | Nhịp 3 CK | PulseRhythm (D=3, Q=90,5) | 0,6% | ✅ đúng §8.6 |
| SKU-004 | Tăng trưởng | Holt (α=β=0,48) | 4,1% | ✅ nhánh X-có-xu-hướng thắng backtest đúng §3/§6.6 |
| SKU-005 | Dao động chu kỳ 4 | SES | **60,4%** | ⚠️ xem D.3 |
| SKU-006 | Thưa không đều | Croston | — (exception) | ✅ đúng §8.5, F=null trước 2 lần phát sinh |
| SKU-007 | Lịch sử ngắn n=8 | SES | **60,6%** | ⚠️ xem D.3 (TEST chỉ 1 CK) |
| SKU-008 | Biên X, răng cưa 2 CK | SES | **79,8%** | ⚠️ xem D.3 |
| SKU-009 | Dao động chu kỳ 6 | SES | **73,9%** | ⚠️ xem D.3 |
| SKU-010/011/012/013/014 | D / thiếu lịch sử | PurchasePlan/Croston | — | ✅ đúng luồng ngoại lệ |

Kết luận: **các mô hình được cài đúng công thức và đúng bảng chuyển nhánh C11 §3**; grid search đúng quy tắc thô→mịn, ràng buộc β ≤ α, chặn xu hướng ±15%, chặn dự báo âm, TRAIN/TEST chia theo thời gian.

### D.2 Hai lỗi hệ thống đã sửa trong lần rà soát này

| # | Vị trí | Lỗi | Cách sửa |
|---|---|---|---|
| D2.1 | `catalog.ts` · `actualDemand` | "Thực tế tương lai" dùng cho hậu kiểm C19 là chuỗi chung chung ~70–118 cho MỌI SKU, không liên quan mẫu nhu cầu lịch sử → C19 báo WAPE 64–100% cho cả những SKU dự báo chuẩn (SKU-002 mùa thấp bị so với "thực tế" 88; SKU-003 nhịp 0-0-91 bị so với 77-85-93), đổ oan nguyên nhân sang "hàng về trễ" | Sinh thực tế bằng chính `targetForCycle` tiếp nối chu kỳ lịch sử + nhiễu ±4% + uplift CTKM đúng chu kỳ đã xác nhận. Sau sửa: WAPE19 của SKU-001/002/003/004 = 3,7% / 3,9% / 1,6% / 2,4% — hậu kiểm đo đúng chất lượng mô hình |
| D2.2 | `forecast-models.ts` · `testMetrics` | Chu kỳ TEST mà mô hình bị CẤM phát dự báo (F = null theo §8.4/§8.5) bị tính như "dự báo 0" trong RMSE/WAPE/Bias → phạt oan Croston/nhịp khi lần phát sinh thứ 2 rơi vào TEST | Loại F=null khỏi sai số liên tục; vẫn đếm missed pulse khi có nhu cầu mà không có dự báo dương. Có test hồi quy kèm theo |

### D.3 Nguyên nhân nhóm SKU sai số cao (60–80%) — thiếu trong tài liệu giải pháp, không phải lỗi cài đặt

Cả 4 SKU sai số cao có chung một bản chất: **nhu cầu lặp theo chu kỳ NGẮN** (2–6 chu kỳ; ví dụ hàng đẩy theo đợt lương tháng, lịch lễ 2 tháng/lần) trong khi tài liệu chỉ có:
- Kiểm tra mùa vụ C9 với **đúng 24 vị trí/vòng** (mùa vụ NĂM), chỉ áp cho nhóm Y, cần ≥ 2 vòng (48 CK);
- Holt-Winters cố định **m = 24**.

→ Không nhánh nào bắt được dao động chu kỳ 2–6; SES/Holt cho dự báo phẳng đi giữa hai biên nên WAPE 60–80% là **hệ quả tất yếu của phạm vi tài liệu**, không phải bug. Kiểm chứng bằng thí nghiệm: dò chu kỳ p* bằng tự tương quan trên TRAIN rồi dự báo seasonal-naïve `F_t = Y_{t−p*}` trên TEST:

| SKU | p* (tự tương quan) | WAPE mô hình hiện tại | WAPE seasonal-naïve(p*) |
|---|---|---|---|
| SKU-005 | 4 (r=0,89) | 60,4% | **3,9%** |
| SKU-007 | 2 (r=0,67) | 60,6% | **5,6%** |
| SKU-008 | 2 (r=0,85) | 79,8% | **17,1%** |
| SKU-009 | 2 (r=0,86) | 73,9% | **24,0%** |

### D.4 Đề xuất bổ sung cho phiên bản tài liệu tương lai (chưa cài vào mô phỏng — chờ phê duyệt)

1. **[C10-mới] Kiểm tra chu kỳ lặp ngắn trước khi rơi về SES** — ✅ **ĐÃ CÀI (2026-07-06, xem D.5)**: với nhóm X/Y không mùa vụ năm và không xu hướng, dò p ∈ [2..12] bằng hệ số tự tương quan trên TRAIN; nếu r(p) ≥ ngưỡng phê duyệt (đề xuất 0,6) → dùng seasonal-naïve theo p (hoặc Holt-Winters m=p) và bắt buộc thắng SES trên backtest mới được khóa — cùng triết lý "Holt phải thắng SES" hiện có ở §6.6.
2. **[C11 §10] Cờ tin cậy theo cỡ TEST**: khi TEST < 3 chu kỳ (ví dụ SKU-007 chỉ có 1), mọi chỉ tiêu sai số phải gắn nhãn "độ tin cậy thấp — không dùng để so mô hình", tránh đọc WAPE 60% của 1 điểm dữ liệu như kết luận thống kê.
3. **[C11 §10] Ngưỡng cảnh báo WAPE**: bổ sung quy định khi WAPE backtest > ngưỡng ban hành theo ô ABC×XYZ thì SKU buộc đi luồng duyệt thủ công kèm ghi chú nguyên nhân (hiện tài liệu chưa ban hành ngưỡng nên mô phỏng để `review` toàn bộ — đúng nguyên tắc nhưng người duyệt không được nhắc SKU nào cần soi trước).

### D.5 Kết quả triển khai đề xuất D.4-1 — mô hình chu kỳ lặp ngắn `SeasonalNaive` (2026-07-06)

Cài đặt: `detectShortCycle` (math.ts) dò p ∈ [2..12] bằng tự tương quan **chỉ trên TRAIN**, ngưỡng r ≥ 0,60;
mô hình `F_t = Y_{t−p}` chỉ được chọn ở nhánh "không mùa vụ năm, không xu hướng" và **bắt buộc thắng SES
trên WAPE TEST** (cùng triết lý "Holt phải thắng SES" C11 §6.6). p chu kỳ đầu F = null (không dự báo khi
chưa có vòng lặp trước). Nhóm Z/D và các nhánh Holt-Winters/Holt giữ nguyên.

| SKU | Mô hình trước → sau | WAPE backtest trước → sau | WAPE hậu kiểm C19 |
|---|---|---|---|
| SKU-005 | SES → SeasonalNaive (p=4, r=0,89) | 60,4% → **3,9%** | 6,2% |
| SKU-007 | SES → SeasonalNaive (p=2, r=0,67) | 60,6% → **5,6%** | 9,5% |
| SKU-008 | SES → SeasonalNaive (p=2, r=0,85) | 79,8% → **17,1%** | 18,3% |
| SKU-009 | SES → SeasonalNaive (p=2, r=0,86) | 73,9% → **24,0%** | 15,2% |

10 SKU còn lại giữ nguyên mô hình và số liệu (chuỗi hằng/ổn định không kích hoạt nhánh mới — có test chống chọn bừa).
Trạng thái C11 của SKU dùng SeasonalNaive vẫn là REVIEW theo nguyên tắc P25. Đề xuất D.4-2 (cờ TEST < 3 CK)
và D.4-3 (ngưỡng WAPE cảnh báo) vẫn chờ ban hành ngưỡng chính thức.

### D.6 Đồng bộ lại C11 theo đặc tả chính thức của Tài liệu giải pháp (2026-07-06)

Tài liệu giải pháp đã ban hành đặc tả đầy đủ cho chu kỳ lặp ngắn tại **C11 mục 8 (nhánh 11XY-SN)**, thay thế
bản vá D.4-1. Mô phỏng đã được đồng bộ lại đúng đặc tả:

1. **Công thức r(p) chuẩn [C11 §8.5]**: đổi từ ACF một trung bình chung sang **tương quan Pearson giữa dãy A/B
   lệch p** (hai trung bình riêng, mẫu số √(ΣA²·ΣB²)) — tái tạo đúng r(4) ≈ 0,995 của ví dụ §8.6.
2. **Cửa SN sau MỌI nhánh X/Y [sơ đồ mục 13]**: kể cả nhánh Holt/Holt-Winters; mô hình đối chứng là
   **mô hình đang thắng** của nhánh, không cố định SES [C11 §8.10].
3. **Quy tắc thắng [C11 §4.3 bước 7, §4.5]**: Holt phải thắng SES (áp cả nhánh Y-xu hướng), Holt-Winters phải
   thắng Holt/SES, thua → fallback; SES tối ưu α trong 0,05–0,5 [§5.5]; HW thêm ràng buộc γ ≤ 1−α [§4.2].
4. **Cờ tin cậy [C11 §8.10, mục 12] — đóng luôn D.4-2**: TEST < 3 CK → gắn `ĐỘ TIN CẬY THẤP — KHÔNG DÙNG
   ĐỂ SO MÔ HÌNH TỰ ĐỘNG`, SN không được tự thắng bằng so sánh.
5. **Bằng chứng kiểm toán [C11 §8.12]**: lưu và hiển thị danh sách r(p) đã thử, p*, mô hình đối chứng + WAPE,
   chu kỳ nguồn được sao chép của từng F tương lai; hòa gần (≤ 0,05) → ưu tiên p nhỏ [§8.8].
6. **Bộ ca kiểm thử SN-01..SN-10 [C11 §8.13]** cài tại `forecast-models.spec.ts` (SN-06/07 ngoài phạm vi
   mô phỏng vì chuỗi vào C11 là chu kỳ locked liền mạch từ C5 — skip có ghi lý do).

Kết quả sau đồng bộ (khác D.5 ở hai dòng, đều là hệ quả đúng đặc tả):

| SKU | Mô hình sau đồng bộ | WAPE backtest | Ghi chú |
|---|---|---|---|
| SKU-005 | SeasonalNaive (p*=4) | **3,9%** | Giữ nguyên D.5. |
| SKU-007 | **SES (cờ độ tin cậy thấp)** | 60,6% (tham khảo: SN 5,6%) | TEST = 1 CK < 3 → SN không được tự thắng [§8.10, SN-04]; hành vi D.5 cũ (tự chọn SN) là vi phạm đặc tả. |
| SKU-008 | SeasonalNaive (p*=2) | **17,1%** | Giữ nguyên D.5. |
| SKU-009 | SeasonalNaive (**p*=6**) | **5,2%** (trước 24,0%) | Pearson bắt đúng chu kỳ thật 6 CK (D.1 đã ghi nhận "dao động chu kỳ 6"); ACF cũ chọn nhầm p=2. |

SKU-004 (Holt) minh chứng cửa SN sau nhánh Holt: có ứng viên p=2 nhưng không thắng Holt trên TEST → giữ Holt.
