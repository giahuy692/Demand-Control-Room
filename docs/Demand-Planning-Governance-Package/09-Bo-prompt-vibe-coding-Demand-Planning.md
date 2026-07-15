# Bộ prompt vibe coding Demand Planning

> Mọi prompt trong file này đều giả định `INSTRUCTIONS.md` nằm ở root repository. Nếu công cụ không tự đọc file, câu đầu tiên bắt buộc là: **“Đọc và tuân thủ `INSTRUCTIONS.md` trước khi thực hiện.”**

## 1. Prompt Preflight bắt buộc

```text
Đọc và tuân thủ INSTRUCTIONS.md.
Không sửa file.

TaskMode: REVIEW_ONLY
RunMode: [HISTORICAL_VALIDATION | HISTORICAL_BACKTEST | OPERATIONAL_PLANNING]
PortfolioMode: [FULL_PORTFOLIO | SELECTED_SKU_SIMULATION | USE_APPROVED_SNAPSHOT]
Scope: [CHẶNG/RULE]

Hãy xuất đúng khối INSTRUCTION_ACK và Preflight gồm:
- nguồn đã đọc;
- relevant rules;
- impact map;
- conflict/missing data;
- file được/không được sửa;
- test plan;
- trạng thái PASS hoặc BLOCKED_FOR_DECISION.
```

## 2. Prompt triển khai một chặng

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: IMPLEMENTATION
RunMode: [RUN MODE]
PortfolioMode: [PORTFOLIO MODE]
Scope: triển khai duy nhất [CHẶNG/RULE].

Được phép sửa:
- [danh sách file]

Không được sửa:
- các chặng trước đã khóa;
- công thức/rule ngoài phạm vi;
- golden test đã duyệt;
- [danh sách bổ sung].

Lệnh test:
- [lệnh test]

Quy trình bắt buộc:
1. Xuất INSTRUCTION_ACK và Preflight.
2. Nếu PASS, audit Rule → code → test.
3. Viết/hoàn thiện test trước.
4. Triển khai từng RULE.
5. Gắn RuleId vào log quyết định.
6. Chạy unit, stage, golden và regression test.
7. Cập nhật traceability matrix.
8. Xuất báo cáo hoàn thành theo INSTRUCTIONS.md.

Không tuyên bố hoàn thành nếu còn RULE chưa có test hoặc test chưa đạt.
```

## 3. Prompt sửa lỗi dữ liệu thật

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: BUG_FIX
RunMode: HISTORICAL_VALIDATION
PortfolioMode: SELECTED_SKU_SIMULATION
Lỗi: [mô tả]
SKU/chu kỳ mẫu: [mã/ngày]

Không vá riêng SKU.
Hãy:
1. Xuất INSTRUCTION_ACK và Preflight.
2. Xác định tầng lỗi: source, import, calendar, stage rule, approval hay reporting.
3. Trích bằng chứng dữ liệu.
4. Xác định RULE hiện có đã bao phủ chưa.
5. Nếu chưa có RULE, dừng ở BLOCKED_FOR_DECISION và đề xuất rule + golden test.
6. Nếu RULE đã có, viết regression test rồi sửa implementation.
7. Chạy lại SKU lỗi và ít nhất một SKU đối chứng.
```

## 4. Prompt audit code sau triển khai

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: REVIEW_ONLY
Scope: audit [CHẶNG/RULE].
Không sửa code.

Xuất:
- Rule triển khai đầy đủ;
- Rule triển khai một phần;
- Rule bị bỏ sót;
- assumption không có trong tài liệu;
- test đang kiểm tra implementation thay vì nghiệp vụ;
- null/0 sai nghĩa;
- trạng thái EXECUTED/LOCKED sai;
- rủi ro lan sang chặng sau;
- kết luận PASS hoặc BLOCKED_FOR_DECISION.
```

## 5. Prompt rà SQL nguồn

```text
Đọc và tuân thủ INSTRUCTIONS.md.
Đọc thêm:
- demand-planing-data-source-notes-v3.md
- 02-Hop-dong-du-lieu-dau-vao.md
- 03-Kiem-tra-du-lieu-nguon.sql

TaskMode: DATA_AUDIT
Scope: [SQL/file/table].

Không sửa SQL trước.
Hãy kiểm tra:
- join theo FK/bằng chứng;
- dấu nhập/xuất;
- mốc tính tồn;
- sales null/zero;
- dữ liệu thưa;
- CTKM interval;
- store/inventory scope;
- ngày đầu/biên tham chiếu;
- diagnostics còn thiếu.

Nếu mapping chưa xác nhận, dùng BLOCKED_FOR_DECISION thay vì tự đoán.
```

## 6. Prompt cập nhật tài liệu sau quyết định đã duyệt

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: DOCUMENTATION
DecisionId: [DEC-*]
Scope: [file/mục].

Chỉ cập nhật nội dung đã được duyệt.
Yêu cầu:
- giữ văn phong nghiệp vụ;
- gắn DecisionId/RuleId;
- không thay đổi rule khác;
- cập nhật source-of-truth, manifest và version nếu cần;
- liệt kê mọi file đã sửa.
```

## 7. Prompt không được dùng

```text
Hãy code toàn bộ hệ thống theo tài liệu đính kèm.
```

Lý do: phạm vi quá lớn, AI dễ bỏ nhánh, tự chọn giả định, sửa lan và không tạo bằng chứng nghiệm thu.

## 8. Prompt triển khai cổng Chặng 5 → Chặng 6/7/11

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: IMPLEMENTATION
RunMode: HISTORICAL_VALIDATION
Scope: RULE-05-006, RULE-06-003, RULE-07-001 đến RULE-07-004, RULE-11-001

Bắt buộc:
- Giữ nguyên CycleId và mọi khoảng trống.
- Không lọc CK lỗi rồi nối các CK còn lại.
- CycleBaseDemand >= 0 chỉ hợp lệ khi CK đã LOCKED và unresolvedDays=0.
- SKU lâu năm có chuỗi đứt phải DemandClass=null/CLASSIFICATION_BLOCKED, không D.
- D chỉ cho SKU mới hoặc lịch sử thật ngắn đã xác minh.
- SKU tương tự chỉ tạo candidate; MD plan chỉ dùng dự báo tương lai.

Viết và chạy GT-31 đến GT-40 trước khi tuyên bố hoàn thành.
```
