# Đặc tả triển khai Demand Planning

## 1. Mục tiêu

Chuyển tài liệu giải pháp thành các quy tắc có thể code, log và kiểm thử. Khi nội dung trong tài liệu giải pháp và file này khác nhau, quyết định đã khóa và đặc tả này được ưu tiên.

## 2. Trạng thái dùng chung

```text
NOT_STARTED
EXECUTED
EVALUATED
LOCKED
LOCKED_WITH_REVIEW
COMPLETED_WITH_EXCEPTION
REVIEW_REQUIRED
BLOCKED
NOT_APPLICABLE
NOT_EVALUATED
```

`EXECUTED` chỉ nói hàm đã chạy. Chỉ `LOCKED`/`LOCKED_WITH_REVIEW` mới được bàn giao cho luồng tương ứng.

## 3. Chế độ chạy

| Chế độ | Ý nghĩa |
|---|---|
| `HISTORICAL_VALIDATION` | Kiểm tra xử lý trên lịch sử đã xảy ra. |
| `HISTORICAL_BACKTEST` | Giả lập tại một ngày quá khứ, không dùng thông tin phát sinh sau ngày đó để ra quyết định. |
| `OPERATIONAL_PLANNING` | Lập kế hoạch tương lai thật. |

## 4. Quy tắc dữ liệu và Chặng 1

### RULE-01-001 — Tạo lịch liên tục

- **Đầu vào:** `ProcessingStartDate`, `ProcessingEndDate`, danh sách SKU/nơi bán, `DailySourceRecord`.
- **Xử lý:** tạo một dòng cho mỗi SKU — nơi bán — ngày trong khung.
- **Ngày scaffold:** `HasRecord=false`, `Sales=null`.
- **Không được:** tự gán `Sales=0`.
- **Log:** số ngày lịch, số ngày nguồn, số ngày scaffold.

### RULE-01-002 — Tạo chu kỳ theo ngày lịch

- Chu kỳ dài 15 ngày.
- Không đếm 15 bản ghi nguồn.
- Ngày dư ở cuối khung được giữ để kiểm toán nhưng chưa tạo chu kỳ học.
- SQL không được dời ngày bắt đầu để làm tròn chu kỳ.

### RULE-01-003 — Vùng tham chiếu

- Dòng trước `ProcessingStartDate` nhưng sau `ReferenceReadStartDate` có `IsReferenceOnly=true`.
- Không đưa dòng này vào ABC/XYZ hoặc chuỗi học.
- Được dùng làm nguồn tham chiếu Chặng 3–5 nếu đáp ứng điều kiện sạch.

### RULE-01-004 — Phân biệt phạm vi dữ liệu

- Lưu `PortfolioMode` và `ExtractIsTruncated`.
- Nếu tập dữ liệu bị giới hạn, không kết luận SKU mới hoặc không có SKU tương tự chỉ từ tập hiện tại.

## 5. Chặng 2 — Stockout

### RULE-02-001 — Điều kiện dữ liệu tồn

Chỉ đánh dấu stockout tự động khi `StockCalculationStatus` không phải `UNRESOLVED`/`ANCHOR_MISSING`.

### RULE-02-002 — Ngày scaffold

Ngày `HasRecord=false` không được dùng nhánh “Sales=0 thật” để kết luận stockout.

### RULE-02-003 — Tồn âm

Giữ số âm, gắn `NEGATIVE_REVIEW`; không tự đổi thành 0. Có thể chạy mô phỏng nhưng trạng thái chặng là `REVIEW_REQUIRED` nếu quyết định stockout phụ thuộc tồn âm.

## 6. Chặng 3 — Nền ngày stockout không CTKM

### RULE-03-001 — Nguồn tham chiếu cấp 1

- Cùng SKU, cùng nơi bán.
- Không CTKM, không stockout, `HasRecord=true`, nền quan sát đủ tin cậy.
- Tìm ±7, mở ±14, tối đa ±24.
- Tối thiểu 3 ngày.

### RULE-03-002 — Một phía

Nếu không cân bằng được hai phía nhưng có ít nhất 3 ngày sạch ở một phía:

- tính trung vị;
- gắn `UNBALANCED_FIXED`;
- không để `BaseDemand=null` chỉ vì thiếu phía còn lại;
- không dùng ngày này làm nguồn cho ngày khác.

### RULE-03-003 — Nguồn dự phòng để phục hồi lịch sử

Thứ tự mặc định:

1. cùng SKU/cùng cửa hàng theo bối cảnh thời gian;
2. cùng SKU tại cửa hàng tham chiếu đã duyệt;
3. cùng vị trí mùa vụ năm trước;
4. `MANUAL_HISTORICAL_BASELINE` đã được phê duyệt;
5. `BASELINE_UNRESOLVED`.

`SKU tương tự` và `kế hoạch MD` không mặc định dùng để điền lịch sử. Chúng là chiến lược dự báo tương lai ở Chặng 11 khi chuỗi vẫn không đủ tự học. Mọi fallback lịch sử lưu nguồn, hệ số quy đổi, người duyệt và độ tin cậy.

## 7. Chặng 4 — Nền CTKM

### RULE-04-001 — Phân loại CTKM trước khi chuẩn hóa

- `STANDING_PRICE`: coi là ngày bán bình thường, không đưa về nền CTKM.
- `CAMPAIGN`, `BUNDLE`, `CLEARANCE`: xử lý theo chính sách riêng.
- `UNKNOWN_REVIEW`: không tự quyết; chuyển hàng đợi phê duyệt.

### RULE-04-002 — Nhận diện vùng

Nhóm liên tục theo SKU — nơi bán — loại/chương trình. CTKM chồng lấn phải lưu danh sách mã, không làm mất mã.

### RULE-04-003 — Một phía và cận lịch sử

Áp dụng cùng nguyên tắc tối thiểu 3 ngày một phía như RULE-03-002, nhưng gắn cờ biên `BOUNDARY_REFERENCE` khi vùng chạm cận lịch sử.

### RULE-04-004 — CTKM gần như liên tục

Nếu không đủ trạng thái bán bình thường để tách nền và hiệu ứng CTKM:

- không tự gán median bằng 0;
- thử nguồn dự phòng;
- nếu vẫn thiếu, gắn `BASELINE_NOT_IDENTIFIABLE`;
- tạo task tách rõ: phục hồi lịch sử bằng cùng SKU/cửa hàng tham chiếu hoặc `MANUAL_HISTORICAL_BASELINE`; nếu không thể phục hồi, Chặng 11 mới xét SKU tương tự/kế hoạch MD cho dự báo tương lai.

## 8. Chặng 5 — Hoàn chỉnh, khóa chu kỳ và đánh giá chất lượng chuỗi

### RULE-05-001 — Phân loại ngày trong chu kỳ

Đếm riêng:

- `sourceRecordDays`;
- `observedCleanDays`;
- `stockoutAdjustedDays`;
- `promoAdjustedDays`;
- `technicalFillDays`;
- `fallbackDays`;
- `unresolvedDays`.

Không dùng `unresolvedDays=15` để kết luận “trống”. Chỉ `sourceRecordDays=0` mới là `NO_SOURCE_RECORD`.

### RULE-05-002 — Tầng 1 lấp theo ngày sạch

Giữ cách tìm ngày sạch xung quanh. Ngày vừa lấp không được thêm vào tập tham chiếu.

### RULE-05-003 — Tầng 2 dùng mức đại diện chu kỳ

Tính từ snapshot các ngày nền hợp lệ có trước khi Chặng 5 lấp.

- 12–14 ngày: được phép tự động lấp; chu kỳ là `LOCKED_ADJUSTED`, `ReviewRequired=true` nếu có ngày ước lượng.
- 8–11 ngày: chỉ lấp khi phân bố ít nhất 2/3 đoạn đầu-giữa-cuối và chính sách bật; tối thiểu `REVIEW_REQUIRED`.
- 1–7 ngày: không dùng chính chu kỳ làm nguồn duy nhất.
- 0 ngày: không lấp toàn bộ chu kỳ.

Ngưỡng là cấu hình cần backtest.

### RULE-05-004 — Mức đại diện

Mặc định dùng trung vị:

$$B_{cycle}=Median(B_d)$$

Không nhân một ngày duy nhất cho cả chu kỳ.

### RULE-05-005 — Trạng thái chu kỳ

```text
LOCKED_OBSERVED
LOCKED_ADJUSTED
LOCKED_FALLBACK
PARTIAL_BASELINE
NO_SOURCE_RECORD
BASELINE_UNRESOLVED
OUTSIDE_ACTIVE_PERIOD
DATA_ERROR
```

Chu kỳ đủ điều kiện cơ bản phải đồng thời:

- đúng 15 ngày lịch;
- `CycleBaseDemand != null`;
- `CycleBaseDemand >= 0`;
- `unresolvedDays = 0`;
- trạng thái thuộc `LOCKED_OBSERVED`, `LOCKED_ADJUSTED`, `LOCKED_FALLBACK`.

Giá trị bằng 0 chỉ hợp lệ khi toàn bộ điều kiện trên đạt. Điều kiện `>=0` một mình không đủ.

### RULE-05-006 — Cổng chất lượng chuỗi sau Chặng 5

Cổng được đánh giá riêng cho từng chặng đích.

1. Xây dựng cửa sổ bằng `CycleId` theo lịch; giữ nguyên mọi vị trí.
2. Không lọc bỏ chu kỳ lỗi rồi đánh lại thứ tự.
3. Chu kỳ không đạt được giữ là vị trí `null/BLOCKED` trong cửa sổ.
4. Tính `EligibleCycleCount`, `MissingOrBlockedCycleIds`, `MaxContinuousEligibleCycles`.
5. Trả `ELIGIBLE`, `REVIEW_REQUIRED` hoặc `BLOCKED` cho ABC, XYZ và dự báo.

Nếu các CK hợp lệ nằm rải rác, hệ thống không được biến ví dụ `CK14, CK15, CK25` thành chuỗi ba phần tử liên tiếp.

## 9. Chặng 6 — ABC

### RULE-06-001 — Phạm vi danh mục

- `FULL_PORTFOLIO`: được tính/khóa ABC.
- `SELECTED_SKU_SIMULATION`: chỉ xếp hạng trong tập thử; không gọi là ABC chính thức.
- `USE_APPROVED_SNAPSHOT`: dùng ABC từ snapshot đã duyệt.

### RULE-06-002 — Phê duyệt

Kết quả tự động tạo `PROPOSED`; sau duyệt mới `EFFECTIVE`. Override phải có lý do và hiệu lực từ phiên sau.

### RULE-06-003 — Hợp đồng chuỗi đầu vào ABC

- Dùng một đoạn chu kỳ **liên tiếp** kết thúc tại chu kỳ đủ điều kiện gần nhất.
- Đạt số chu kỳ tối thiểu theo chính sách Chặng 6; mặc định hiện hành là 6.
- Không đếm các chu kỳ khóa nằm rải rác ở hai phía của một khoảng unresolved như một đoạn liên tiếp.
- Nếu cửa sổ bị đứt hoặc không đủ chu kỳ liên tiếp: `ABC=null`, `ABC_INPUT_BLOCKED` hoặc chỉ hiển thị mô phỏng chẩn đoán.
- Chu kỳ bằng 0 vẫn được tính nếu là chu kỳ khóa hợp lệ.

## 10. Chặng 7 — XYZ/D

### RULE-07-001 — D chỉ dành cho lịch sử thật sự ngắn

`DemandClass=D` chỉ khi đồng thời:

- SKU là SKU mới hoặc thời gian hoạt động thật sự chưa đạt số chu kỳ tối thiểu;
- `ExtractIsTruncated=false`;
- toàn bộ chu kỳ thuộc thời gian đã hoạt động đều đã được giải quyết hoặc có trạng thái hợp lệ;
- nguyên nhân thiếu lịch sử không phải do CTKM/stockout/nền unresolved.

Có thể lưu lý do `D_NEW` hoặc `D_TRUE_SHORT_HISTORY`.

Các trường hợp sau không phải D:

```text
BASELINE_UNRESOLVED
INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY
EXTRACT_TRUNCATED
DATA_ERROR
NO_SOURCE_RECORD trong thời gian đáng lẽ hoạt động
```

Khi gặp các trường hợp này:

```text
DemandClass = null
ClassificationStatus = CLASSIFICATION_BLOCKED
```

Z là nhu cầu thưa nhưng đủ dữ liệu; không dùng D thay cho lỗi dữ liệu.

### RULE-07-002 — Bằng chứng phân loại

Lưu ADI, CV², cửa sổ `CycleId`, số chu kỳ >0, số chu kỳ bằng 0 hợp lệ, chất lượng chu kỳ và lý do.

### RULE-07-003 — Cửa sổ XYZ liên tục

- Cửa sổ chuẩn hiện hành gồm 24 vị trí chu kỳ gần nhất theo lịch.
- Mọi vị trí trong cửa sổ phải được giữ nguyên.
- Không lấy riêng các chu kỳ đã khóa rồi nối lại.
- Nếu có `PARTIAL_BASELINE`, `BASELINE_UNRESOLVED`, `NO_SOURCE_RECORD` trong thời gian hoạt động hoặc `DATA_ERROR`, phân loại X/Y/Z bị chặn.
- Nếu SKU mới có ít hơn số chu kỳ tối thiểu nhưng mọi chu kỳ hoạt động đều hợp lệ, gán D.
- Giá trị 0 được đưa vào ADI khi đó là nền 0 đã khóa; `null` không được chuyển thành 0.

### RULE-07-004 — Không có nhu cầu dương

Nếu cửa sổ liên tục và hợp lệ nhưng mọi chu kỳ đều bằng 0, không gán D. Trả `NO_POSITIVE_DEMAND_REVIEW` hoặc chính sách Z-zero-demand đã được duyệt; không tính ADI bằng phép chia cho 0.

## 11. Chặng 8 — Chính sách

### RULE-08-001 — Phiên bản chính sách

Mỗi ma trận ABC×XYZ có version, trạng thái duyệt, ngày hiệu lực và không hồi tố.

### RULE-08-002 — Thiếu phân loại

Không dùng `serviceLevel=0` làm placeholder. Dùng `null` và `POLICY_UNRESOLVED`.

## 12. Chặng 9–12

Giữ mô hình/công thức hiện có, nhưng chỉ nhận chuỗi chu kỳ có trạng thái phù hợp và log số chu kỳ theo từng mức chất lượng.

### RULE-11-001 — Hợp đồng chuỗi dự báo

- Mỗi mô hình lấy một cửa sổ `CycleId` liên tục theo yêu cầu riêng.
- Không bỏ khoảng trống rồi nén chuỗi.
- `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY` chặn mô hình tự học.
- Trường hợp bị chặn không tự chuyển thành nhóm D. Sau phê duyệt mới dùng `MD_FUTURE_PLAN`, `SIMILAR_SKU_APPROVED` hoặc `REFERENCE_STORE_APPROVED` làm chiến lược dự báo tạm.
- Các chiến lược này không làm thay đổi ngược nhãn chất lượng lịch sử.

### RULE-12-001 — Hệ số CTKM

Chỉ học từ CTKM lịch sử có baseline đủ căn cứ và không bị stockout làm méo. CTKM thường trực không được học như uplift chiến dịch.

## 13. Chặng 13

### RULE-13-001 — Không có kế hoạch tương lai

Trong `HISTORICAL_VALIDATION` hiện tại:

```text
futurePromotionPlan = none
finalForecast = baselineForecast
status = PASSTHROUGH_NO_FUTURE_PROMO
```

Không tự tạo kế hoạch tương lai từ CTKM lịch sử.

### RULE-13-002 — Phạm vi kiểm thử

Nhánh áp hệ số CTKM tương lai được ghi `NOT_EVALUATED`, không được báo “đã khóa đầy đủ”.

## 14. Chặng 14–19 trong phiên hiện tại

Nếu thiếu nguồn hàng, lead time, MOQ, ngân sách hoặc quy trình phát hành:

- được phép hiển thị mô phỏng giả định riêng nếu người dùng bật;
- mặc định là `NOT_EVALUATED` hoặc `SIMULATION_ONLY`;
- không được tạo kết luận vận hành thật.

## 15. Hàng đợi ngoại lệ

Mọi `BASELINE_UNRESOLVED`, `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY`, `UNKNOWN_REVIEW`, `CLASSIFICATION_BLOCKED`, `POLICY_UNRESOLVED` phải tạo một task có:

- SKU/nơi bán;
- chặng phát hiện;
- bằng chứng;
- hành động đề xuất;
- vai trò xử lý;
- trạng thái task;
- phiên bản quyết định.
