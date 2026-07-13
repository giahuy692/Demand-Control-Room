# INSTRUCTIONS — Demand Planning & Replenishment Governance

**Instruction ID:** `DP-AI-001`  
**Version:** `1.1.0`  
**Phạm vi:** toàn bộ repository/module Demand Planning  
**Mức bắt buộc:** bắt buộc tuân thủ trước mọi hành động đọc, sửa, tạo code, test, SQL, báo cáo hoặc tài liệu.

---

## 1. Mục tiêu của file này

File này là chỉ dẫn vận hành thường trực cho AI/coding agent. Mục tiêu là bảo đảm mọi lần triển khai đều:

- đọc đúng nguồn sự thật;
- không tự suy diễn khi tài liệu chưa chốt;
- chỉ sửa đúng phạm vi;
- triển khai theo từng `RULE`;
- viết kiểm thử trước hoặc đồng thời với code;
- không tuyên bố hoàn thành nếu chưa có bằng chứng;
- không làm sai các nguyên tắc dữ liệu đã khóa của Hachi.

File này không thay thế tài liệu giải pháp hoặc đặc tả triển khai. Nó quy định **cách AI phải sử dụng các tài liệu đó**.

---

## 2. Thứ tự nguồn sự thật

Khi thực hiện một công việc, phải đọc và ưu tiên theo thứ tự sau:

1. `INSTRUCTIONS.md`
2. `00-README-Nguon-su-that.md`
3. `01-Danh-sach-quyet-dinh-nghiep-vu.md`
4. `02-Hop-dong-du-lieu-dau-vao.md`
5. `04-Dac-ta-trien-khai-Demand-Planning.md`
6. `07-Danh-muc-Golden-Test.md`
7. `06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md`
8. `08-Dac-ta-bao-cao-mo-phong-va-Audit-Explorer.md`
9. `Tài liệu giải pháp - Demand Planning & Replenishment Governance(26).md`
10. `demand-planing-data-source-notes-v3.md`
11. source code, test hiện có và báo cáo mô phỏng cũ.

### Khi có mâu thuẫn

- Không tự chọn cách hiểu thuận tiện nhất.
- Dừng phần bị mâu thuẫn.
- Ghi rõ hai nội dung xung đột, file và mục liên quan.
- Đề xuất quyết định cần người dùng duyệt.
- Chỉ tiếp tục các phần độc lập không bị ảnh hưởng.

Source code hiện tại không được xem là nguồn sự thật nếu khác với `RULE` đã duyệt.

---

## 3. Các nguyên tắc bất biến

Mọi triển khai phải giữ các nguyên tắc sau.

### 3.1. Dữ liệu nguồn và lịch ngày

- POS/ERP chỉ trả dữ liệu thực sự có trong DB.
- SQL không tạo lịch ngày liên tục.
- Module Demand Planning tạo lịch liên tục và chu kỳ 15 ngày.
- Chu kỳ được chia theo **ngày lịch**, không theo số dòng nguồn.
- Ngày scaffold phải có `HasRecord=false` và `Sales=null` ban đầu.
- Không được tự hiểu ngày không có dòng là bán bằng 0.

### 3.2. Tồn kho

- Tồn được tính từ phát sinh giao dịch thật.
- Tồn đầu ngày hôm nay bằng tồn cuối ngày hôm trước.
- Ngày không có phát sinh được mang tồn gần nhất sang, nhưng phải ghi nguồn `CARRIED_FORWARD`.
- Không tự đổi tồn âm thành 0.
- Nếu thiếu mốc tồn hoặc dữ liệu phát sinh, phải ghi trạng thái chất lượng tồn.

### 3.3. `null`, số 0 và không áp dụng

Ba trạng thái phải luôn tách biệt:

- `0`: giá trị thật đã xác định bằng 0;
- `null`: chưa xác định hoặc thiếu căn cứ;
- `NOT_APPLICABLE`: quy tắc không áp dụng.

Không dùng `COALESCE(..., 0)` trong logic nghiệp vụ nếu chưa có `RULE` cho phép.

### 3.4. CTKM

- CTKM lịch sử và kế hoạch CTKM tương lai là hai dữ liệu khác nhau.
- Phiên hiện tại là `HISTORICAL_VALIDATION`, chưa có kế hoạch CTKM tương lai.
- Chặng 13 phải dùng `PASSTHROUGH_NO_FUTURE_PROMO` và `finalForecast = baselineForecast`.
- Không tự tạo kế hoạch CTKM tương lai từ CTKM lịch sử.
- CTKM thường trực/chính sách giá thường xuyên không được mặc định xử lý như uplift chiến dịch.
- CTKM chưa phân loại phải tạo ngoại lệ phê duyệt, không tự loại hoặc tự giữ.

### 3.5. Chu kỳ và nền

- Không gọi chu kỳ là “trống” chỉ vì chưa xác định được nền.
- Chỉ `sourceRecordDays=0` mới là `NO_SOURCE_RECORD`.
- Ngày vừa lấp không được dùng làm nguồn để lấp tiếp trong cùng lượt.
- Không dùng một ngày nền duy nhất để nhân cho cả chu kỳ.
- Chỉ các trạng thái `LOCKED_*` được bàn giao vào chuỗi học theo chính sách.

### 3.6. ABC, XYZ/D và chính sách

- Không khóa ABC chính thức khi chỉ chạy tập SKU mẫu.
- `SELECTED_SKU_SIMULATION` chỉ được xếp hạng trong tập thử hoặc dùng snapshot đã duyệt.
- Z là nhu cầu thưa nhưng đủ dữ liệu; D không được dùng để che lỗi dữ liệu.
- Không được lọc bỏ chu kỳ unresolved rồi nối các chu kỳ còn lại.
- SKU lâu năm có chuỗi không liên tục phải `DemandClass=null` và bị chặn, không chuyển D.
- D chỉ dành cho SKU mới/lịch sử thật ngắn sau khi xác minh extract đầy đủ.
- `CycleBaseDemand >= 0` chỉ hợp lệ khi chu kỳ đã khóa và `unresolvedDays=0`.
- SKU tương tự do AI đề xuất phải chờ duyệt; kế hoạch MD là dự báo tương lai, không phải lấp lịch sử.
- Không dùng `serviceLevel=0` thay cho chính sách chưa xác định.
- Mọi override phải có lý do, người duyệt, phiên bản và ngày hiệu lực.

### 3.7. Trạng thái chạy

- `EXECUTED` không đồng nghĩa với `LOCKED`.
- Không gọi “19/19 chặng đã khóa” nếu chỉ chạy qua hàm.
- Dữ liệu/chặng `BLOCKED` không được tự động đi vào quyết định vận hành.
- Chặng 14–19 thiếu dữ liệu thật phải là `NOT_EVALUATED` hoặc `SIMULATION_ONLY`, không được giả thành kết quả vận hành.

---

## 4. Quy trình bắt buộc trước khi sửa code

Mọi task phải bắt đầu bằng **Preflight**.

### 4.1. Preflight phải xuất

1. **Instruction:** `DP-AI-001 v1.1.0`.
2. **Chế độ task:** `REVIEW_ONLY`, `IMPLEMENTATION`, `BUG_FIX`, `DATA_AUDIT` hoặc `DOCUMENTATION`.
3. **RunMode:** `HISTORICAL_VALIDATION`, `HISTORICAL_BACKTEST` hoặc `OPERATIONAL_PLANNING`.
4. **PortfolioMode:** `FULL_PORTFOLIO`, `SELECTED_SKU_SIMULATION` hoặc `USE_APPROVED_SNAPSHOT`.
5. **Phạm vi:** chặng, rule, file được sửa và file không được sửa.
6. **Nguồn đã đọc:** danh sách file/mục liên quan.
7. **Rule inventory:** toàn bộ `RULE-*` liên quan.
8. **Impact map:** đầu vào, đầu ra, chặng trước, chặng sau bị ảnh hưởng.
9. **Mâu thuẫn/thiếu dữ liệu:** nếu có.
10. **Kế hoạch test:** golden test và regression test cần chạy.

### 4.2. Khi nào được tiếp tục tự động

AI được tiếp tục triển khai sau Preflight nếu đồng thời thỏa:

- không có mâu thuẫn tài liệu;
- rule đã đủ;
- dữ liệu/field cần thiết đã có;
- phạm vi file được phép sửa đã rõ;
- không thay đổi chính sách nghiệp vụ đã khóa;
- task yêu cầu triển khai, không chỉ yêu cầu thẩm định.

Nếu không thỏa, phải chuyển sang `BLOCKED_FOR_DECISION` và nêu đúng quyết định cần người dùng chốt.

---

## 5. Quy trình triển khai bắt buộc

### Bước 1 — Audit hiện trạng

- Tìm code/hàm/test hiện tại liên quan từng `RULE`.
- Tạo bảng `RULE → code hiện tại → test hiện tại → khoảng thiếu`.
- Không sửa code trước khi biết khoảng thiếu.

### Bước 2 — Khóa phạm vi

- Chỉ sửa file được cho phép.
- Không sửa chặng trước đã khóa nếu không có bằng chứng lỗi lan truyền.
- Nếu cần sửa ngoài phạm vi, dừng và xin mở rộng phạm vi.

### Bước 3 — Viết hoặc cập nhật test trước

- Mỗi `RULE` phải có ít nhất một test.
- Trường hợp biên phải có test riêng.
- Test phải kiểm tra kết quả nghiệp vụ, không chỉ sao chép implementation.
- Golden test đã duyệt không được sửa để làm code “pass”.

### Bước 4 — Triển khai tối thiểu theo rule

- Triển khai từng rule độc lập khi có thể.
- Gắn `RuleId` vào log quyết định.
- Không thêm heuristic/ngưỡng mới nếu chưa có trong cấu hình hoặc tài liệu.
- Không vá riêng một SKU bằng mã cứng.

### Bước 5 — Chạy kiểm thử theo tầng

1. unit test của rule;
2. test của chặng;
3. golden test;
4. regression test SKU thật;
5. test tích hợp chặng trước/sau;
6. kiểm tra báo cáo/Audit Explorer nếu trạng thái hoặc log thay đổi.

### Bước 6 — Kiểm tra dữ liệu bất biến

Ít nhất phải kiểm tra:

- không có `null` bị đổi ngầm thành 0;
- chu kỳ đúng 15 ngày lịch;
- `OpenStock[d] = CloseStock[d-1]` theo phạm vi tính tồn;
- ngày scaffold không trở thành ngày sạch quan sát;
- ngày vừa lấp không thành tham chiếu;
- `BLOCKED` không đi vào quyết định mua;
- chuỗi không bị nén qua các `CycleId` thiếu hoặc unresolved;
- classification blocked không bị đổi thành D;
- `HISTORICAL_VALIDATION` không sinh kế hoạch CTKM tương lai.

### Bước 7 — Cập nhật truy vết và tài liệu

- Cập nhật `05-Ma-tran-truy-vet-quy-tac.md`.
- Cập nhật tài liệu chỉ khi hành vi đã được duyệt.
- Không sửa tài liệu để hợp thức hóa code sai.
- Nếu có quyết định mới, ghi vào `01-Danh-sach-quyet-dinh-nghiep-vu.md` trước.

---

## 6. Điều kiện dừng bắt buộc

Phải dừng và không tự suy diễn khi gặp một trong các trường hợp:

1. Hai tài liệu nguồn sự thật mâu thuẫn.
2. Không xác định được ý nghĩa cột DB hoặc mã nghiệp vụ.
3. Thiếu dữ liệu bắt buộc để triển khai rule.
4. Cần thêm ngưỡng/heuristic mới chưa được duyệt.
5. Cần sửa chặng ngoài phạm vi được giao.
6. Golden test chưa có kết quả mong đợi rõ.
7. Tập dữ liệu mẫu không đủ để kết luận toàn danh mục.
8. Không phân biệt được dữ liệu lịch sử với dữ liệu biết tại `AsOfDate`.
9. Cần phê duyệt nghiệp vụ nhưng chưa có quyết định.
10. Test thất bại nhưng nguyên nhân chưa xác định.

Khi dừng, phải xuất:

```text
Status: BLOCKED_FOR_DECISION
AffectedRules: [...]
Evidence: ...
DecisionRequired: ...
SafeWorkCompleted: ...
```

---

## 7. Điều kiện được tuyên bố hoàn thành

Không được dùng câu “đã hoàn thành” nếu thiếu bất kỳ điều kiện nào:

- 100% rule trong phạm vi có implementation hoặc trạng thái rõ;
- 100% rule có test;
- 100% golden test trong phạm vi đạt;
- regression test liên quan đạt;
- không có lỗi type/lint/build trong phạm vi;
- không có `null → 0` ngoài rule cho phép;
- log/Audit Explorer giải thích được mọi nhánh;
- traceability matrix đã cập nhật;
- các giới hạn còn lại được ghi rõ;
- không có task ngoại lệ bị che giấu.

Nếu chỉ đạt một phần, dùng:

- `COMPLETED_WITH_EXCEPTION`, hoặc
- `PARTIALLY_IMPLEMENTED`, hoặc
- `BLOCKED_FOR_DECISION`.

---

## 8. Báo cáo bắt buộc sau khi thực hiện

Mọi task triển khai phải kết thúc bằng bảng sau:

### 8.1. Tóm tắt thay đổi

- Task/chặng:
- RunMode:
- Rule đã triển khai:
- Rule chưa triển khai:
- File đã sửa:
- File đã tạo:

### 8.2. Bằng chứng kiểm thử

| Nhóm test | Tổng | Đạt | Không đạt | Chưa chạy |
|---|---:|---:|---:|---:|
| Unit | | | | |
| Stage | | | | |
| Golden | | | | |
| Regression | | | | |
| Integration | | | | |

### 8.3. Ảnh hưởng nghiệp vụ

- Kết quả trước:
- Kết quả sau:
- SKU/chu kỳ bị ảnh hưởng:
- Có thay đổi trạng thái khóa không:
- Có cần migration/chạy lại dữ liệu không:

### 8.4. Ngoại lệ còn lại

- Vấn đề:
- Rule liên quan:
- Mức độ:
- Hành động tiếp theo:
- Người cần duyệt:

---

## 9. Quy tắc dành cho SQL và dữ liệu nguồn

Khi sửa SQL:

- Chỉ dùng câu lệnh đọc nếu task không cho phép ghi.
- Không tạo bảng thật; chỉ dùng temp table khi cần.
- Không tự chia chu kỳ 15 ngày trong SQL nguồn.
- Không tự dời `ProcessingStartDate` để làm tròn chu kỳ.
- Có thể đọc dữ liệu trước khung để tính tồn hoặc làm tham chiếu, nhưng phải gắn phạm vi rõ.
- Không tự loại PromoCode trong tầng trích xuất; xuất dữ liệu và để chính sách phân loại xử lý.
- Giữ riêng dữ liệu khoảng CTKM nếu cần đánh dấu ngày không có giao dịch.
- Mọi join phải dựa trên khóa ngoại hoặc bằng chứng dữ liệu thật.
- Phải xuất diagnostics cho các mapping chưa chắc chắn.

---

## 10. Quy tắc dành cho lỗi dữ liệu thật

Khi có một SKU lỗi:

1. Không vá riêng SKU trước.
2. Xác định lỗi thuộc tầng nào:
   - SQL/source;
   - import/data contract;
   - calendar;
   - stage rule;
   - approval;
   - reporting.
3. Thu thập bằng chứng theo ngày/chu kỳ.
4. Kiểm tra rule đã bao phủ chưa.
5. Nếu chưa có rule: đề xuất rule và golden test trước khi code.
6. Nếu đã có rule: sửa implementation và thêm regression test.
7. Chạy lại tối thiểu SKU lỗi và một SKU đối chứng không lỗi.

Không dùng tên SKU hoặc mã SKU làm điều kiện code cố định.

---

## 11. Quy tắc dành cho thay đổi tài liệu

- Giữ văn phong nghiệp vụ dễ đọc ở tài liệu giải pháp.
- Đưa chi tiết có thể code vào đặc tả triển khai.
- Mỗi thay đổi hành vi phải có mã quyết định hoặc mã rule.
- Không xóa lịch sử quyết định; đánh dấu `SUPERSEDED` khi thay thế.
- Không hồi tố kết quả phiên đã khóa.
- Mỗi bản phát hành tài liệu phải tăng version và cập nhật manifest.

---

## 12. Mẫu xác nhận bắt đầu bắt buộc

AI phải mở đầu task kỹ thuật bằng khối ngắn sau:

```text
INSTRUCTION_ACK: DP-AI-001 v1.1.0
TaskMode: ...
RunMode: ...
PortfolioMode: ...
Scope: ...
RelevantRules: ...
PreflightStatus: PASS | BLOCKED_FOR_DECISION
```

Nếu không xuất được khối này, không được bắt đầu sửa code.
