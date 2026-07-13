# Quy trình đưa `INSTRUCTIONS.md` vào hệ thống vibe coding

## 1. Mục tiêu

`INSTRUCTIONS.md` là chỉ dẫn thường trực để AI không chỉ “đọc tài liệu”, mà còn phải làm đúng quy trình: đọc đúng nguồn sự thật, chạy Preflight, triển khai theo rule, kiểm thử và xuất bằng chứng.

File này làm giảm đáng kể tình trạng:

- AI bỏ sót một nhánh;
- tự đổi `null` thành 0;
- tự thêm giả định;
- sửa lan sang chặng khác;
- tuyên bố hoàn thành khi chưa chạy golden test;
- gọi chặng “đã khóa” chỉ vì code đã chạy.

Không có file instruction nào bảo đảm tuyệt đối mọi lần chạy đúng 100%. Cơ chế tốt nhất là kết hợp **instruction thường trực + prompt theo task + golden test + cổng kiểm duyệt**.

---

## 2. Vị trí đặt file

Đặt `INSTRUCTIONS.md` ở thư mục gốc của repository, cùng cấp với source code chính.

Ví dụ:

```text
project-root/
├── INSTRUCTIONS.md
├── docs/
│   └── demand-planning-governance/
│       ├── 00-README-Nguon-su-that.md
│       ├── 01-Danh-sach-quyet-dinh-nghiep-vu.md
│       ├── ...
│       └── 10-Bao-cao-so-sanh-truoc-va-sau.md
├── src/
└── tests/
```

Nếu công cụ vibe coding có phần **Project Instructions/Rules**, dán toàn bộ nội dung `INSTRUCTIONS.md` vào đó hoặc cấu hình để công cụ luôn đọc file này khi mở project.

Nếu công cụ không tự đọc file, mọi prompt giao việc phải bắt đầu bằng:

```text
Đọc và tuân thủ file INSTRUCTIONS.md trước khi thực hiện.
Không bắt đầu sửa code nếu chưa xuất INSTRUCTION_ACK và Preflight.
```

---

## 3. Quy trình thiết lập một lần

### Bước 1 — Đưa bộ governance vào repository

Khuyến nghị đặt toàn bộ gói vào:

```text
docs/demand-planning-governance/
```

Giữ `INSTRUCTIONS.md` ở root để AI dễ thấy nhất.

### Bước 2 — Kiểm tra đường dẫn trong tài liệu

Đảm bảo tên file trong `INSTRUCTIONS.md` trùng với tên file thực tế. Không giữ hai bản tài liệu giải pháp cùng hoạt động.

### Bước 3 — Khóa version instruction

Giữ ba thông tin ở đầu file:

```text
Instruction ID: DP-AI-001
Version: 1.1.0
Mức bắt buộc: bắt buộc
```

Khi thay đổi quy trình, tăng version và ghi quyết định trong `01-Danh-sach-quyet-dinh-nghiep-vu.md`.

### Bước 4 — Thử handshake

Giao một task đọc-only:

```text
Đọc INSTRUCTIONS.md và các nguồn sự thật liên quan.
Không sửa file. Chỉ xuất INSTRUCTION_ACK và Preflight cho Chặng 5.
```

Chỉ tiếp tục nếu AI trả đủ:

- instruction version;
- run mode;
- portfolio mode;
- rule liên quan;
- file nguồn;
- phạm vi;
- test cần chạy.

### Bước 5 — Thử một task nhỏ

Chọn một rule nhỏ, ví dụ `RULE-13-001`, để xác nhận AI:

- không tạo CTKM tương lai;
- viết test;
- cập nhật traceability;
- xuất báo cáo sau sửa.

---

## 4. Quy trình cho mỗi lần giao việc

### Pha A — Giao task

Prompt chỉ cần chỉ rõ:

1. mục tiêu;
2. chặng/rule;
3. chế độ chạy;
4. file được sửa;
5. file không được sửa;
6. lệnh test;
7. có triển khai ngay hay chỉ review.

Mẫu:

```text
Đọc và tuân thủ INSTRUCTIONS.md.

TaskMode: IMPLEMENTATION
RunMode: HISTORICAL_VALIDATION
PortfolioMode: SELECTED_SKU_SIMULATION
Scope: Chặng 5, RULE-05-001 đến RULE-05-005

Được sửa:
- src/.../stage-5.ts
- tests/.../stage-5.spec.ts
- 05-Ma-tran-truy-vet-quy-tac.md

Không được sửa:
- Chặng 1–4
- Golden test đã duyệt
- Công thức Chặng 6 trở đi

Hãy chạy Preflight; nếu PASS thì triển khai, chạy test và xuất báo cáo bắt buộc.
```

### Pha B — Kiểm tra Preflight

Không cho phép AI sửa code nếu Preflight thiếu:

- relevant rules;
- impact map;
- test plan;
- conflict check.

### Pha C — Triển khai

AI thực hiện theo `INSTRUCTIONS.md`:

```text
Audit → Test → Code → Test → Regression → Traceability → Report
```

### Pha D — Kiểm duyệt

Chỉ duyệt khi:

- rule map đầy đủ;
- test đạt;
- không có assumption ẩn;
- trạng thái báo cáo đúng;
- ngoại lệ còn lại được liệt kê.

---

## 5. Phân loại task để tránh AI làm quá phạm vi

| TaskMode | Khi dùng | AI được sửa file? |
|---|---|---:|
| `REVIEW_ONLY` | Thẩm định code/tài liệu | Không |
| `DATA_AUDIT` | Rà SQL, mapping và dữ liệu | Chỉ file audit nếu được phép |
| `DOCUMENTATION` | Cập nhật tài liệu đã duyệt | Có, trong phạm vi tài liệu |
| `IMPLEMENTATION` | Triển khai rule mới | Có |
| `BUG_FIX` | Rule đã đúng nhưng code sai | Có, kèm regression test |

Không dùng prompt mơ hồ như “hãy sửa hệ thống cho đúng”.

---

## 6. Cổng kiểm soát đề xuất

### Gate 1 — Instruction Gate

AI đã xuất `INSTRUCTION_ACK` đúng version.

### Gate 2 — Rule Gate

Mọi rule trong phạm vi đã được liệt kê và không có xung đột.

### Gate 3 — Test Gate

Đã có expected result rõ cho từng rule.

### Gate 4 — Scope Gate

Danh sách file được sửa và không được sửa đã rõ.

### Gate 5 — Completion Gate

Golden test, regression test và traceability đều đạt.

Nếu một gate không đạt, task không được ghi là hoàn thành.

---

## 7. Cách dùng với từng loại công việc

### 7.1. Rà SQL nguồn

Đính kèm/cho AI đọc:

- `INSTRUCTIONS.md`;
- `demand-planing-data-source-notes-v3.md`;
- `02-Hop-dong-du-lieu-dau-vao.md`;
- `03-Kiem-tra-du-lieu-nguon.sql`;
- SQL cần rà.

Yêu cầu `TaskMode=DATA_AUDIT` trước; chỉ chuyển sang `IMPLEMENTATION` sau khi mapping DB đã rõ.

### 7.2. Sửa Chặng 1–5

Đính kèm:

- `INSTRUCTIONS.md`;
- phần tương ứng của tài liệu giải pháp;
- `04-Dac-ta-trien-khai-Demand-Planning.md`;
- `07-Danh-muc-Golden-Test.md`;
- source và test của đúng chặng.

Mỗi lần chỉ sửa một chặng hoặc một nhóm rule liên quan chặt chẽ.

### 7.3. Phê duyệt ABC/XYZ/D

Dùng:

- `06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md`;
- `08-Dac-ta-bao-cao-mo-phong-va-Audit-Explorer.md`;
- rule Chặng 6–8.

Không cho AI khóa ABC chính thức nếu `PortfolioMode=SELECTED_SKU_SIMULATION`.

### 7.4. Sửa báo cáo

Dùng `TaskMode=IMPLEMENTATION`, nhưng chỉ cho phép sửa presentation/reporting layer. Không được sửa công thức nghiệp vụ để làm báo cáo “đẹp hơn”.

---

## 8. Checklist kiểm duyệt nhanh sau mỗi phiên AI

- [ ] Có `INSTRUCTION_ACK` đúng version.
- [ ] Có RunMode và PortfolioMode.
- [ ] Có danh sách rule đầy đủ.
- [ ] Có file được/không được sửa.
- [ ] Có test trước hoặc cùng lúc với code.
- [ ] Golden test không bị sửa để pass.
- [ ] Không có `null → 0` trái rule.
- [ ] Không có hard-code theo SKU.
- [ ] Không có chặng `EXECUTED` bị gọi là `LOCKED`.
- [ ] Có bảng test result.
- [ ] Có traceability update.
- [ ] Có danh sách ngoại lệ còn lại.

---

## 9. Quy trình nâng version instruction

Chỉ sửa `INSTRUCTIONS.md` khi thay đổi **cách AI phải làm việc**, không dùng file này để chứa mọi công thức nghiệp vụ.

Quy trình:

1. tạo quyết định mới trong file `01`;
2. cập nhật `INSTRUCTIONS.md`;
3. tăng version;
4. cập nhật `MANIFEST.md`;
5. chạy lại handshake test;
6. thông báo version mới cho mọi agent/công cụ.

---

## 10. Kết luận

Cấu hình tốt nhất không phải chỉ “đưa một file instruction vào hệ thống”, mà là tạo một chu trình cưỡng chế:

```text
Instruction luôn được đọc
→ Preflight có xác nhận
→ Rule được ánh xạ
→ Test có expected result
→ Code trong phạm vi
→ Golden/regression test
→ Traceability
→ Human approval
```

Đây là cơ chế phù hợp nhất để giảm lỗi bỏ sót và bảo đảm mỗi lần vibe coding đều có bằng chứng kiểm chứng, thay vì dựa vào tuyên bố của AI.

## 9. Task ưu tiên sau bản v3

Task đầu tiên nên triển khai `RULE-05-006`, `RULE-06-003`, `RULE-07-001`–`RULE-07-004` và `RULE-11-001`. Đây là cổng ngăn SKU 31054 hoặc SKU tương tự bị nén các CK rời rạc rồi gán D/X/Y/Z sai.

Không triển khai tiếp mô hình dự báo cho SKU bị `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY` trước khi cổng này hoạt động và GT-31–GT-40 đạt.
