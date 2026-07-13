# Ma trận truy vết quy tắc — trạng thái thật sau khi sửa code

Bản đối chiếu sống, cập nhật theo từng đợt triển khai Chặng 1–19 (xem `2026-07-12-rule-audit-chang-1-19.md` cho phân tích gốc). Cấu trúc theo đúng `docs/Demand-Planning-Governance-Package-v1/05-Ma-tran-truy-vet-quy-tac.md`, nhưng cột "Trạng thái" phản ánh **thực tế trong code**, không phải giá trị mặc định "Chờ triển khai" của tài liệu gốc. Quy tắc nghiệm thu (không đổi): không đóng task nếu còn ghi "Chưa có test".

## Quy ước trạng thái cột "Trạng thái"

- `XONG` — có hàm thực thi + có test riêng khớp rule + test đang xanh.
- `MỘT PHẦN` — có hàm thực thi nhưng thiếu một phần rule (ghi rõ thiếu gì).
- `CHỜ TRIỂN KHAI` — chưa có hàm thực thi (giữ nguyên như tài liệu gốc).

## Chặng 1

| Rule | Tài liệu giải pháp | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|---|
| RULE-01-001 | Chặng 1 | `calendar-scaffold.ts::buildCalendarScaffold` + `simulation-engine.ts::runStage1` | `calendar-scaffold.spec.ts` (GT-01, GT-02, DEC-006/007) | Có — `[RULE-01-001]` trong `snapshot.audit` | **XONG** |
| RULE-01-002 | Chặng 1 | Hệ quả trực tiếp của RULE-01-001 (scaffold đảm bảo `daily` luôn dày đặc nên `fillAndBuildCycles` nhóm đúng theo ngày lịch mà không cần sửa thuật toán Chặng 5) | `catalog.spec.ts` "Chặng 1 dùng daily thật..." (kiểm `expectedWindowDays`) | Có — `[RULE-01-002]` | **XONG** |
| RULE-01-003 | Chặng 1 | `simulation-engine.ts::runStage1` (nạp `referenceOnlyDaily`, gắn `isReferenceOnly`, tách khỏi `daily`) | `catalog.spec.ts` "Chặng 1 dùng daily thật..." (kiểm `referenceOnlyDaily`) + `calendar-scaffold.spec.ts` | Có — `[RULE-01-003]` | **MỘT PHẦN** — đã nạp/tag/loại khỏi ABC-XYZ đúng yêu cầu bắt buộc; **CHƯA** nối vào tìm kiếm tham chiếu Chặng 3–5 (`selectReferences`) vì thuật toán đó khóa theo index của `daily` — ghi nhận là giới hạn đã biết, không giấu. |
| RULE-01-004 | Chặng 1/6 | `catalog.ts::SimulationDataset.portfolioMode/extractIsTruncated` + `models.ts::SkuDefinition.portfolioMode/extractIsTruncated`, tiêu thụ ở `runStage6` (`Classification.abcOfficial`) | `catalog.spec.ts` "RULE-01-004" + `stage6-8-classification.spec.ts` | Có — `[RULE-01-004]`/`[RULE-06-001]` | **XONG** — đã nối tới Chặng 6 (xem bên dưới). |

## Chặng 2

| Rule | Tài liệu giải pháp | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|---|
| RULE-02-001 | Chặng 2 | `math.ts::isStockout` (tham số `stockCalculationStatus`, mặc định `'CALCULATED'` để không đổi hành vi lời gọi cũ) + `simulation-engine.ts::runStage2` | `calendar-scaffold.spec.ts` (ANCHOR_MISSING) + `catalog.spec.ts` "RULE-02-001/003" (kiểm chặn qua engine thật, kiểm exception task) | Có — `[RULE-02-001]` | **XONG** |
| RULE-02-002 | Chặng 2 | `math.ts::isStockout` (`emptyAllDay` yêu cầu `hasRecord`) — đã đúng từ trước, nay có đường kích hoạt thật nhờ RULE-01-001 | `math.spec.ts` (đã có từ trước) | Không cần — không phải nhánh BLOCKED/REVIEW mới | **XONG** |
| RULE-02-003 | Chặng 2 | `calendar-scaffold.ts::classifyStockStatus` (gắn NEGATIVE_REVIEW, giữ nguyên số âm, mang tiếp sang ngày scaffold kế) + `simulation-engine.ts::runStage2` (đánh giá `reviewRequired` theo đúng nghĩa "quyết định phụ thuộc tồn âm", không gated theo `flagged` — lỗi thiết kế ban đầu đã bị chính test tự viết bắt được và sửa ngay, xem log dưới) | `calendar-scaffold.spec.ts` (GT-06 + carry-forward) + `catalog.spec.ts` "RULE-02-001/003" | Có — `[RULE-02-003]` | **XONG** |

**Hạ tầng mới dùng chung cho toàn bộ Chặng 2–19**: `ExceptionTask`/`ExceptionCode`/`ExceptionTaskStatus` (`models.ts`) + `StageSnapshot.exceptions` (chỉ chứa ngoại lệ MỚI phát sinh ở chặng đó, cùng quy ước với `audit`) — mọi RULE tạo trạng thái BLOCKED/REVIEW từ đây trở đi phải đẩy vào mảng này kèm `ruleId`.

## Chặng 3

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-03-001 | `simulation-engine.ts::selectReferences` (dò tuần tự ±7→±14→±24, export để test trực tiếp) | `reference-search.spec.ts` (3 test: dừng sớm ở 7, dừng ở 14, phải mở tới 24) | Có — `[RULE-03-001]` | **XONG** |
| RULE-03-002 | `qualifySelection` (status `'fixed'` — tên khác literal `UNBALANCED_FIXED` nhưng cùng ý nghĩa) | `acceptance.spec.ts` T05 (đã có từ trước) | Không có literal `UNBALANCED_FIXED` trong log — chỉ khác tên, không khác hành vi | **XONG** (ghi chú: tên trạng thái nội bộ khác literal tài liệu, không ảnh hưởng kết quả) |
| RULE-03-003 | `seasonalFallbackSelection` (cấp 3 — mùa vụ năm trước, lùi 24 chu kỳ) + task ngoại lệ `BASELINE_NOT_IDENTIFIABLE` khi hết cấp 1+3 trong `runStage3` | `stage3-baseline.spec.ts` (2 test: cấp 3 thành công + cấp 1&3 đều thất bại tạo task) | Có — `[RULE-03-003]` | **XONG cho cấp 1/3**; cấp 2 (cửa hàng tương đồng) **không áp dụng** (app single-store); cấp 4/5 (SKU tương tự đã duyệt/nền thủ công MD) **descope có lý do** — không có danh mục/UI tương ứng, hệ thống chỉ đề nghị qua task ngoại lệ theo đúng DEC-016 (cần phê duyệt trước khi dùng chính thức). |

## Chặng 4

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-04-001 | `math.ts::classifyPromoPolicy/classifyPromoRegionPolicy` + `policy.unknownReviewPromotionCodes/clearancePromotionCodes` (mặc định rỗng — hành vi CAMPAIGN như cũ) + chặn chuẩn hóa trong `runStage4` | `math.spec.ts` (6 test đơn vị) + `stage4-promo-policy.spec.ts` (2 test qua engine thật) | Có — `[RULE-04-001]` | **XONG** cho STANDING_PRICE/CAMPAIGN/UNKNOWN_REVIEW; CLEARANCE được phân loại/ghi log nhưng xử lý số học giống CAMPAIGN vì tài liệu Chặng 4 không nêu công thức riêng — ghi nhận rõ trong code. |
| RULE-04-002 | `buildPromoRegions` — đã đúng từ trước (giữ danh sách mã chồng lấn bằng Set) | `acceptance.spec.ts` T06 | Không cần — không phải rule mới | **XONG** |
| RULE-04-003 | `qualifySelection` (export để test trực tiếp) gắn `[BOUNDARY_REFERENCE]` vào `reason` khi chạm biên lịch sử, tách khỏi UNBALANCED_FIXED thường | `stage4-boundary.spec.ts` (2 test) | Không (đây là field `reason`, không phải audit log chặng — đã kiểm bằng test trực tiếp) | **XONG** |
| RULE-04-004 | `runStage4` phát hiện `selection.status==='insufficient' && region.clustered` → task `BASELINE_NOT_IDENTIFIABLE` | `stage4-clustered-promo.spec.ts` (2 test: cụm phủ kín toàn chuỗi → task; hai vùng tách biệt có ngày sạch xen giữa → không tạo task) | Có — `[RULE-04-004]` trong audit | **XONG** |

## Chặng 5

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-05-001 | `CycleRecord.sourceRecordDays/fallbackDays` + `cycleStatus()` (NO_SOURCE_RECORD chỉ khi sourceRecordDays=0) | `stage5-cycle-fill.spec.ts` (2 test RULE-05-001 riêng) | Có — `[RULE-05-001]` | **XONG** |
| RULE-05-002 | Đã đúng từ trước (`isObservedClean` loại `baseSource='technical-fill'` khỏi tập tham chiếu) | `stage5-cycle-fill.spec.ts` "RULE-05-002" (bố cục cách ly bán kính hiệu lực; đã xác nhận bằng mutation-test thủ công: cho `isObservedClean` coi `technical-fill` là sạch thì test fail đúng như kỳ vọng, sau đó khôi phục) | — | **XONG** |
| RULE-05-003 | `tier2RepresentativeFill` + `policy.enableTier2CycleFallback` (mặc định **false** — DEC-P03/P04/P05 "ĐỀ XUẤT", chưa duyệt) | `stage5-cycle-fill.spec.ts` (6 test: tắt mặc định, GT-18, GT-19, chặn khi không trải segment, GT-20, 0 ngày) | Có — `[RULE-05-003]` | **XONG** (cơ chế đầy đủ, mặc định tắt đúng theo trạng thái chưa phê duyệt của DEC-P03/04/05 — không đổi hành vi khóa chu kỳ hiện có cho tới khi được duyệt). |
| RULE-05-004 | `tier2RepresentativeFill` dùng `median()`, không nhân 1 ngày | `stage5-cycle-fill.spec.ts` GT-20 | — | **XONG** |
| RULE-05-005 | `models.ts::CycleStatus` (8 giá trị) + `cycleStatus()` | `stage5-cycle-fill.spec.ts` (nhiều test kiểm `cycle.status`) | Có — `[RULE-05-005]` | **XONG cho 6/8 trạng thái**; OUTSIDE_ACTIVE_PERIOD/DATA_ERROR **không có nguồn dữ liệu để phát hiện** (không có ngày mở/ngưng bán SKU, không có cờ lỗi dữ liệu riêng) — ghi nhận tường minh trong code, không giả vờ có khả năng này. |

## Chặng 6

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-06-001 | `Classification.abcOfficial` (true chỉ khi portfolioMode=FULL_PORTFOLIO/USE_APPROVED_SNAPSHOT) trong `runStage6` | `stage6-8-classification.spec.ts` (3 test) | Có — `[RULE-06-001]` | **XONG** |
| RULE-06-002 | `Classification.approvalStatus` — hệ thống chỉ tự sinh `'PROPOSED'`, không bao giờ tự chuyển `'EFFECTIVE'` | `stage6-8-classification.spec.ts` | Có — `[RULE-06-002]` | **MỘT PHẦN theo đúng nghĩa** — cơ chế PROPOSED đã thật; quy trình phê duyệt/override (lý do, version, hiệu lực phiên sau — 06-Quy-trinh-phe-duyet...) **không có UI/persistence trong app một-lượt-chạy này** — descope có lý do, ghi rõ trong code, không giả vờ có workflow phê duyệt. |
| RULE-06-003 | **(đợt 5 — sửa lỗi gốc)** `trailingLockedRun()` (`math.ts`) dùng trong `runStage6` thay cho `lockedValues()` cũ (`cycles.filter(locked)` — xóa khoảng trống rồi nối 2 đoạn xa nhau thành chuỗi liên tục giả, vi phạm trực tiếp rule này). ABC dùng đoạn chu kỳ khóa liên tiếp kết thúc tại chu kỳ gần nhất; khi không đủ 6 VÀ có gap ở đâu đó trong lịch sử → task `ABC_INPUT_BLOCKED` (phân biệt với SKU thật sự mới). | `stage6-7-11-contiguity.spec.ts` (GT-32/34, 2 test) | Có — `[RULE-06-003]` + `ABC_INPUT_BLOCKED` | **XONG** |

## Chặng 7

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-07-001 | `models.ts::DSubtype` + `classifyDSubtype()` trong `runStage7`. **(đợt 5 — sửa)** nhánh `D_BASELINE_UNRESOLVED` gỡ bỏ (dead code): kể từ khi cửa sổ Chặng 7 được `fixedCalendarWindow` chặn TRƯỚC khi gọi `classifyDSubtype`, hàm này không bao giờ còn thấy chu kỳ unresolved lẫn trong cửa sổ đang xét nữa — case đó giờ đi vào `CLASSIFICATION_BLOCKED` (RULE-07-003) đúng nghĩa hơn. `D_SHORT_HISTORY` giữ tên code cũ, coi là đồng nghĩa với `D_TRUE_SHORT_HISTORY` của tài liệu (quyết định người dùng, không đổi tên). | `stage6-8-classification.spec.ts` (D_NEW, D_EXTRACT_TRUNCATED, D_SHORT_HISTORY) + `stage6-7-11-contiguity.spec.ts` (GT-35) | Có — `[RULE-07-001]` | **XONG cho 3/6 subtype còn áp dụng** (D_NEW/D_SHORT_HISTORY/D_EXTRACT_TRUNCATED); D_BASELINE_UNRESOLVED không còn được gán (xem trên); D_MANUAL_PLAN/D_SIMILAR_SKU **không có nguồn dữ liệu** — ghi nhận tường minh. |
| RULE-07-002 | `Classification.seriesQualityRatio` + `classificationReason` | `stage6-8-classification.spec.ts` | Có — `[RULE-07-002]` | **XONG** |
| RULE-07-003 | **(đợt 5 — sửa lỗi gốc nghiêm trọng nhất đợt này)** `fixedCalendarWindow()` (`math.ts`) — cửa sổ CỐ ĐỊNH đúng 24 vị trí chu kỳ gần nhất theo lịch (giữ nguyên mọi vị trí kể cả gap), thay cho `lockedValues()` cũ (`cycles.filter(locked)` — xóa gap rồi nối 2 đoạn xa nhau thành chuỗi liên tục giả, khiến XYZ/ADI/CV² tính trên dữ liệu sai lệch mà không hề báo lỗi). Có gap trong cửa sổ → `xyz=null`, `classificationStatus='CLASSIFICATION_BLOCKED'`, `classificationBlockReason` = trạng thái chu kỳ chặn, task `CLASSIFICATION_BLOCKED`. Bug này **chưa từng được audit ở đợt 1–4** (không có trong `2026-07-12-rule-audit-chang-1-19.md`), do người dùng phát hiện qua đối chiếu Chặng 6–13 với `04-Dac-ta-trien-khai-Demand-Planning.md`. | `stage6-7-11-contiguity.spec.ts` (GT-23/32/33, 3 test) | Có — `[RULE-07-003]` + `CLASSIFICATION_BLOCKED` | **XONG** |
| RULE-07-004 | **(đợt 5 — sửa)** `classifyXyz()` (`math.ts`) tách nhánh `m=0` (cửa sổ đủ dài n≥6 nhưng toàn bộ chu kỳ bằng 0) ra khỏi nhánh `n<6` — trước đây gộp chung thành D, sai theo rule này. Trả `xyz=null`, `classificationStatus='NO_POSITIVE_DEMAND_REVIEW'`, không tính ADI bằng phép chia 0. | `math.spec.ts` (3 test đơn vị) + `stage6-7-11-contiguity.spec.ts` (GT-36, dùng lại fixture `SKU-014` có sẵn — test hồi quy: trước bản sửa kết quả là `'D'`) | Có — `[RULE-07-004]` | **XONG** |

## Chặng 8

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-08-001 | Audit ghi rõ phiên chính sách (`policy.version`) dùng cho ma trận | `stage6-8-classification.spec.ts` | Có — `[RULE-08-001]` | **MỘT PHẦN** — có version tag; "không hồi tố" giữa nhiều lần chạy **không thể đảm bảo** vì app không lưu lịch sử phiên bản qua các lần chạy (stateless per-session) — ghi nhận tường minh, không giả vờ có cơ chế đó. |
| RULE-08-002 | Đã đúng từ trước (`serviceLevel=null`, không dùng 0); nay thêm task `POLICY_UNRESOLVED` | `stage6-8-classification.spec.ts` | Có — `[RULE-08-002]` | **XONG** |

## Chặng 9–11

Không có RULE-xx-xxx riêng cho Chặng 9/10 trong `04` (chỉ có hướng dẫn chung §12: "giữ mô hình/công thức hiện có, chỉ nhận chuỗi có trạng thái phù hợp"). **Đã bổ sung (đợt 4)**: `lockedCycleQualityBreakdown()` (`simulation-engine.ts`) đếm số chu kỳ khóa theo từng `CycleStatus` (LOCKED_OBSERVED/LOCKED_ADJUSTED/LOCKED_FALLBACK) toàn danh mục, ghi vào `summary`/`audit` của cả 3 chặng 9, 10, 11. Test: `stage9-11-cycle-quality.spec.ts` (3 test).

**Sửa lỗi gốc (đợt 5)**: `lockedValues()`/`lockedSeriesAll()`/inline filter riêng của Chặng 9 trước đây đều dùng `cycles.filter(cycle => cycle.locked)` — xóa hẳn khoảng trống (chu kỳ không khóa) rồi nối 2 đoạn chu kỳ khóa cách xa nhau lại thành một chuỗi liên tục GIẢ, vi phạm nguyên tắc §12 "chỉ nhận chuỗi có trạng thái phù hợp" (và trực tiếp RULE-06-003/07-003/11-001 ở các chặng dùng chung). Đã đổi toàn bộ sang `trailingLockedRun()` (dò ngược từ chu kỳ gần nhất theo lịch, DỪNG ở gap đầu tiên — không bao giờ nối 2 đoạn cách nhau bởi gap). Vì mọi test hiện có đều chạy trên dữ liệu giả gapless (`generateDailyRecords`), hành vi không đổi cho toàn bộ test cũ (172+ test vẫn xanh nguyên) — bug chỉ lộ ra khi có gap thật, đúng như `stage6-7-11-contiguity.spec.ts` dựng thủ công để khóa.

### RULE-11-001 (Chặng 11 — dự báo)

`runStage11` dùng `trailingLockedRun(state.cycles)` làm chuỗi học (không giới hạn độ dài — Holt-Winters cần ≥2 vòng mùa vụ). Khi chuỗi này rỗng (chu kỳ gần nhất theo lịch chính là một gap) HOẶC `classification.xyz===null` (đã CLASSIFICATION_BLOCKED ở Chặng 7) → `fitBaseForecast` trả placeholder chặn cứng (`lockStatus='exception'`, `baseForecast=[]`, reason chứa `FORECAST_INPUT_BLOCKED`), KHÔNG tự chuyển thành nhóm D. Khi chuỗi học không rỗng nhưng lịch sử cũ hơn (ngoài cửa sổ 24 của Chặng 7) bị loại vì một gap xa hơn → mô hình vẫn chạy trên phần đuôi liên tục còn lại (đúng tinh thần "mỗi mô hình lấy cửa sổ liên tục theo yêu cầu riêng" — ngưỡng độ dài riêng của từng mô hình trong cascade SES/Holt/Holt-Winters/Croston/PulseRhythm/SeasonalNaive tự động lọc đúng), nhưng vẫn tạo task `FORECAST_INPUT_BLOCKED` để ghi nhận phần lịch sử bị loại — không nén chuỗi, không im lặng. Test: `stage6-7-11-contiguity.spec.ts` (GT-33, GT-37 dạng chặt + 1 test dạng "gap xa hơn 24 chu kỳ", 3 test).

**Người dùng đã chọn "làm đầy đủ FORECAST_INPUT_BLOCKED theo RULE-11-001"** (không chọn phương án tối thiểu) — cơ chế chặn cứng + gắn cờ ở trên là kết quả của lựa chọn đó, đã được duyệt qua kế hoạch (`jiggly-purring-sundae.md`). Ghi nhận rõ một phần còn lại NGOÀI phạm vi kế hoạch đã duyệt: RULE-11-001 còn nói "mỗi mô hình lấy một cửa sổ CycleId liên tục THEO YÊU CẦU RIÊNG" theo nghĩa chặt nhất — hiện mọi mô hình (SES/Holt/Holt-Winters/Croston/PulseRhythm/SeasonalNaive) vẫn nhận CHUNG một chuỗi `trailingLockedRun` rồi tự quyết theo ngưỡng độ dài sẵn có của từng mô hình (`values.length>=3` cho Holt...), chưa có cơ chế kiểm tra tính liên tục ĐỘC LẬP theo đúng cửa sổ riêng từng mô hình cần (ví dụ Holt-Winters cần 48 liên tục, SES chỉ cần vài chu kỳ). Việc này đòi hỏi thiết kế lại nội bộ `forecast-models.ts` — kế hoạch đã duyệt không bao gồm phần này (xem mục "Chặng 11 (dự báo)" trong plan, người dùng chọn giữa 2 phương án và phương án được chọn không mở rộng tới mức thiết kế lại từng mô hình) — cần một đợt riêng nếu muốn làm tiếp.

## Chặng 12–13

| Rule | Thành phần thực tế | Golden test | RuleId trong log? | Trạng thái |
|---|---|---|---|---|
| RULE-12-001 | `buildPromoRegionSamples` — đã đúng từ trước (loại hasStockout/missingBase, CTKM thường trực đã bị loại khỏi promoCode trước Chặng 2) | `acceptance.spec.ts` T18/T18b (đã có từ trước) | Có — `[RULE-12-001]` (mới thêm vào audit) | **XONG** |
| RULE-13-001 | `SkuPipelineState.finalForecastStatus` ('PASSTHROUGH_NO_FUTURE_PROMO'/'FUTURE_PROMO_APPLIED') trong `runStage13` | `stage12-13-promo.spec.ts` | Có — `[RULE-13-001]` | **XONG** |
| RULE-13-002 | Đếm `kNotEvaluated` (SKU có kế hoạch CTKM tương lai nhưng K chưa tự khóa) + audit `NOT_EVALUATED` | `stage12-13-promo.spec.ts` | Có — `[RULE-13-002]` | **XONG** |

## Chặng 14–19 — mâu thuẫn SIMULATION_ONLY đã xử lý

`policy.operationalDataStatus` (mặc định `'NOT_APPLICABLE'`, đúng literal DEC-W05) + `operationalStatusNote()` gắn `summary['Trạng thái vận hành']='SIMULATION_ONLY'` và audit `[Chặng N][04 §14/DEC-W05]` cho cả 6 chặng — **không đổi bất kỳ phép tính nào** (đã test: mọi số liệu summary khác giữ nguyên khi bật/tắt `operationalDataStatus`). Giải quyết đúng mâu thuẫn đã ghi trong `2026-07-12-rule-audit-chang-1-19.md` mục 2.1: công việc rebuild thuật toán Chặng 14–19 từ lượt trước được GIỮ NGUYÊN (vẫn hữu ích để kiểm tra thuật toán), nhưng nay được nhãn hóa rõ ràng là mô phỏng, không phải kết luận vận hành thật, cho tới khi `operationalDataStatus='CONFIRMED'`.

Test: `stage14-19-simulation-only.spec.ts` (8 test gốc + 7 test mới cho báo cáo mô phỏng — 1 test/chặng × 6 + 1 test CONFIRMED).

**Đã nối UI (đợt 4)**: panel chặng (`app.component.html` summary-grid) đã tự động hiển thị "Trạng thái vận hành" vì nó lặp qua toàn bộ `snapshot.summary` không cần sửa gì thêm. Phần thực sự thiếu là báo cáo mô phỏng độc lập (`report-builder.ts::buildSimulationReport` + `simulation-report.component.ts`) — hàm này trước đây KHÔNG nhận `policy` nên `STAGE_CHECKERS` Chặng 14–19 không thể biết `operationalDataStatus`. Đã sửa: `buildSimulationReport` nhận thêm tham số `operationalDataStatus`, mỗi checker Chặng 14–19 chèn một `ReportIssue` mức `info` ("Toàn bộ đầu ra chặng này là SIMULATION_ONLY…") áp dụng cho toàn bộ SKU của chặng khi `operationalDataStatus !== 'CONFIRMED'`, biến mất khi `CONFIRMED`. `simulation-report.component.ts` truyền `this.store.policy().operationalDataStatus` vào lời gọi. Test khớp trong `stage14-19-simulation-only.spec.ts`.

## Hạng mục còn thiếu (ghi nhận đầy đủ, không tuyên bố hoàn thành)

1. ~~RULE-04-003/RULE-04-004 thiếu test riêng~~ — **đã xong (đợt 4)**: `stage4-boundary.spec.ts` (04-003, có từ đợt 3) + `stage4-clustered-promo.spec.ts` (04-004, mới).
2. ~~RULE-05-002 thiếu test khóa hành vi~~ — **đã xong (đợt 4)**: `stage5-cycle-fill.spec.ts` "RULE-05-002", xác nhận bằng mutation-test thủ công.
3. RULE-06-002/08-001 — cơ chế `PROPOSED`/version đã thật, nhưng phần "phê duyệt/override/không hồi tố" đầy đủ **không có UI/persistence** trong kiến trúc một-lượt-chạy hiện tại của app — descope có lý do, không phải thiếu sót ẩn. (Không đổi trong đợt 4.)
4. RULE-07-001 — D_MANUAL_PLAN/D_SIMILAR_SKU **không có nguồn dữ liệu**, không bao giờ được gán — giống RULE-05-005's OUTSIDE_ACTIVE_PERIOD/DATA_ERROR. (Không đổi trong đợt 4.)
5. ~~Chặng 14–19 SIMULATION_ONLY label chưa lên UI~~ — **đã xong (đợt 4)** cho báo cáo mô phỏng (`buildSimulationReport` + `simulation-report.component.ts`); panel chặng (`app.component.html`) đã tự hiển thị từ trước qua `summary-grid`.
6. ~~Chặng 9–11 chưa log breakdown CycleStatus~~ — **đã xong (đợt 4)**: `lockedCycleQualityBreakdown()` + `stage9-11-cycle-quality.spec.ts`.
7. Exception Queue (`StageSnapshot.exceptions`) mới được nối cho các nhánh BLOCKED/REVIEW phát sinh từ RULE-01 đến RULE-08 đã triển khai ở đợt 1–3; các cảnh báo/REVIEW tồn tại từ trước (Chặng 9–11 REVIEW, Chặng 15 `unfeasiblePolicy`, Chặng 16 `warnings`, Chặng 17 cắt/hoãn, Chặng 18 `awaiting-approval`) **vẫn chưa được hồi tố vào hàng đợi ngoại lệ chuẩn** — vẫn dùng cơ chế cảnh báo cũ (mảng `warnings`/`reasons` riêng của từng chặng), có log nhưng không có `ExceptionTask` kèm `ruleId` chuẩn hóa. **Chưa xử lý trong đợt 4/5** — đây là hạng mục lớn nhất còn lại, cần một đợt riêng (thiết kế lại cách mỗi chặng 9–18 phát sinh `ExceptionTask` thay vì chỉ ghi `warnings`/`reasons` tự do).
8. RULE-11-001 — chỉ làm phần chặn cứng khi chuỗi rỗng/phân loại bị chặn + gắn cờ khi lịch sử cũ hơn bị loại (đợt 5, theo đúng phạm vi kế hoạch người dùng đã duyệt); **chưa làm** cơ chế kiểm tra cửa sổ liên tục ĐỘC LẬP theo yêu cầu riêng của từng mô hình dự báo (SES/Holt/Holt-Winters/Croston/PulseRhythm/SeasonalNaive) — cần thiết kế lại nội bộ `forecast-models.ts`, ngoài phạm vi đợt 5.

## Nhật ký cập nhật

- 2026-07-12 (đợt 1): Hoàn tất RULE-01-001/002 (XONG), RULE-01-003/004 (MỘT PHẦN, giới hạn đã ghi nhận). `npm run build` 0 lỗi. `npx vitest run`: 13/13 file, 123 test pass, 2 skip (không đổi), 0 fail sau khi cập nhật đúng 1 test (`catalog.spec.ts` "Chặng 1 dùng daily thật...") để phản ánh hành vi RULE-01-001 mới thay vì hành vi cũ (chưa scaffold) mà nó vô tình khóa cứng trước đây.
- 2026-07-12 (đợt 2): Hoàn tất RULE-02-001/002/003 (XONG cả 3). Dựng hạ tầng `ExceptionTask`/`StageSnapshot.exceptions` dùng chung cho mọi chặng sau. Test tự viết (`catalog.spec.ts` "RULE-02-001/003") bắt được lỗi thiết kế thật trong lần triển khai đầu (điều kiện `reviewRequired = flagged && NEGATIVE_REVIEW` không bao giờ đúng vì hai điều kiện stockout đòi hỏi đúng bằng 0, không thể trùng với số âm) — đã sửa thành `reviewRequired = stockCalculationStatus === 'NEGATIVE_REVIEW'` theo đúng nghĩa "quyết định stockout phụ thuộc tồn âm" của RULE-02-003. `npm run build` 0 lỗi. `npx vitest run`: 13/13 file, 129 test pass, 2 skip, 0 fail.
- 2026-07-12 (đợt 3): Hoàn tất Chặng 3 (RULE-03-001/002/003), Chặng 4 (RULE-04-001..004, 2/4 thiếu test riêng), Chặng 5 (RULE-05-001..005 đầy đủ, Tầng 2 mặc định tắt vì DEC-P03/04/05 chưa duyệt), Chặng 6-8 (RULE-06-001/002, 07-001/002, 08-001/002), Chặng 12-13 (RULE-12-001 xác nhận đúng, 13-001/002 thêm literal status), và xử lý mâu thuẫn Chặng 14-19 bằng `operationalDataStatus`/SIMULATION_ONLY labeling không đổi số liệu. Test tự viết bắt được 2 lỗi thiết kế thật trong lượt này (Chặng 3 fixture ban đầu vô tình cho cấp 1 tự thành công qua escalation nội bộ tới ±24; Chặng 5 fixture ban đầu để baseSource='clean' khiến Tầng 1 tự lấp trước khi kịp kiểm Tầng 2) — cả hai đã sửa và xác nhận lại. `npm run build` 0 lỗi. `npx vitest run`: 20/20 file, 170 test pass, 2 skip (không đổi), 0 fail.
- 2026-07-13 (đợt 4): Đối chiếu lại toàn bộ `docs/` với code hiện tại, tiếp tục đúng danh sách "Hạng mục còn thiếu" của đợt 3 thay vì làm lại từ đầu. Đóng 4/7 mục:
  1. RULE-04-004 — thêm `stage4-clustered-promo.spec.ts` (2 test: toàn chuỗi bị 2 mã CTKM liền kề phủ kín và không còn ngày sạch nào → cụm gộp lại vẫn `insufficient` → task `BASELINE_NOT_IDENTIFIABLE`; hai vùng CTKM tách biệt có ngày sạch xen giữa → không tạo task).
  2. RULE-05-002 — thêm `stage5-cycle-fill.spec.ts` "RULE-05-002" (bố cục cách ly đúng bán kính hiệu lực thật của `selectReferences` — phát hiện quan trọng: khi `maxReferenceRadius` truyền vào < 14, tầng thứ 3 của vòng lặp dò 3 mốc luôn recompute lại đúng bán kính đó, "ghi đè" kết quả tầng 14 vừa tìm được trước đó, nên bán kính hiệu lực thật sự chỉ là `max(referenceRadius, maxReferenceRadius)`, không phải `referenceRadiusExtended` — không phải bug, chỉ là hành vi cần nắm đúng để viết fixture chính xác). Xác nhận test bằng mutation-test thủ công (tạm cho `isObservedClean` coi `technical-fill` là sạch → test fail đúng số liệu kỳ vọng → khôi phục nguyên trạng).
  3. Nối SIMULATION_ONLY vào báo cáo mô phỏng độc lập: `report-builder.ts::buildSimulationReport` nhận thêm tham số `operationalDataStatus`; `STAGE_CHECKERS` Chặng 14–19 chèn `ReportIssue` mức `info` cho toàn bộ SKU khi chưa `CONFIRMED`; `simulation-report.component.ts` truyền `policy().operationalDataStatus`. Test bổ sung trong `stage14-19-simulation-only.spec.ts`.
  4. Chặng 9–11 — thêm `lockedCycleQualityBreakdown()` (đếm LOCKED_OBSERVED/LOCKED_ADJUSTED/LOCKED_FALLBACK toàn danh mục), ghi vào `summary`/`audit` cả 3 chặng, thuần log bổ sung không đổi phép tính. Test: `stage9-11-cycle-quality.spec.ts` (3 test).
  Còn lại mục 3, 4 (descope có lý do, không đổi) và mục 7 (Exception Queue retrofit cho Chặng 9-18 — chưa làm, xem ghi chú ngay dưới mục đó). `npm run build`: 0 lỗi (chỉ còn cảnh báo NG8107 có từ trước ở `comparison-report.component.html`, không liên quan). `npx vitest run`: 24/24 file, 189 test pass, 2 skip (không đổi), 0 fail.
- 2026-07-13 (đợt 5 — người dùng báo "logic mô phỏng vẫn đang sai", tự khoanh vùng Chặng 6-13): Đối chiếu lại `04-Dac-ta-trien-khai-Demand-Planning.md` §9-13 và `07-Danh-muc-Golden-Test.md` (GT-23, GT-31..GT-37) với code — phát hiện **lỗi gốc chưa từng được audit ở đợt 1-4**: `lockedValues()`/`lockedSeriesAll()` (và bản sao trong `stage-insights.ts`/`stage-trace.ts`/`demand-risk.ts`) đều dùng `cycles.filter(cycle => cycle.locked)` — xóa hẳn chu kỳ không khóa rồi NỐI 2 đoạn chu kỳ khóa cách xa nhau thành một chuỗi liên tục GIẢ. Vi phạm trực tiếp RULE-06-003 (Chặng 6/ABC), RULE-07-003/004 (Chặng 7/XYZ), RULE-11-001 (Chặng 11/dự báo). Dùng `EnterPlanMode` (1 Explore + 1 Plan agent hỗ trợ, 2 vòng `AskUserQuestion` để chốt 3 quyết định phạm vi) trước khi sửa vì đây là thay đổi kiến trúc (thêm `classificationStatus`/`classificationBlockReason`, `xyz` chuyển sang nullable) ảnh hưởng ~20 điểm chạm UI/DTO. Đã sửa:
  1. Thêm `trailingLockedRun()`/`fixedCalendarWindow()` (`math.ts`) — 2 nguyên hàm dùng chung thay cho mọi bản `cycles.filter(locked)` cũ.
  2. `classifyXyz()` tách nhánh `m=0` (RULE-07-004) khỏi `n<6`, trả `xyz=null` thay vì gộp chung D.
  3. `Classification` thêm `xyz: XyzClass|null`, `classificationStatus`, `classificationBlockReason`; `ExceptionCode` thêm `ABC_INPUT_BLOCKED`/`CLASSIFICATION_BLOCKED`/`FORECAST_INPUT_BLOCKED`; gỡ nhánh `D_BASELINE_UNRESOLVED` (dead code sau khi gate Chặng 7 chặn trước).
  4. `runStage6` (RULE-06-003), `runStage7` (RULE-07-003/004), `runStage8` (mở rộng gate), `runStage9` (dùng trailingLockedRun), `runStage11` (RULE-11-001 đầy đủ theo lựa chọn người dùng — chặn cứng khi chuỗi rỗng/bị chặn phân loại, gắn cờ khi lịch sử cũ hơn bị loại).
  5. `forecast-models.ts` (`fitBaseForecast` nhận `xyz` nullable, `lockedSeriesAll` dùng trailingLockedRun), đồng bộ toàn bộ UI mirror (`stage-insights.ts`, `stage-trace.ts`, `demand-risk.ts`) và vá cơ học ~10 điểm hiển thị `xyz` ở DTO/UI (phát hiện thêm 1 bug thật trong lúc vá: `sku-catalog.collection.ts::countByXyz[sku.xyz]++` sẽ thành `NaN` khi xyz=null — đã sửa thêm bucket `BLOCKED`).
  Test mới: `stage6-7-11-contiguity.spec.ts` (12 test, kỹ thuật cấy `CycleRecord[]` thủ công vào state sau Chặng 5 để dựng đúng vị trí gap — khớp GT-23/32/33/34/35/36/37), `math.spec.ts` (+3 test RULE-07-004). Cập nhật 3 test cũ bị ảnh hưởng bởi đổi type (không đổi ý nghĩa test, chỉ mở rộng điều kiện lọc/skip): `solution-contract.spec.ts`, `trace-sanity.spec.ts` — cả hai bị fail đúng 1 lần trước khi sửa vì `SKU-014` (fixture mock có sẵn, 6 chu kỳ =0) chuyển từ `'D'` (sai) sang `NO_POSITIVE_DEMAND_REVIEW` (đúng), đúng là bằng chứng bug đã sửa thật. `npm run build`: 0 lỗi. `npx vitest run`: 25/25 file, 200 test pass, 2 skip (không đổi), 0 fail. Đã khởi động `ng serve` để xác nhận app compile/chạy được ở chế độ dev, không chỉ prod build.
