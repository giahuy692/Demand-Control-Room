# Hợp đồng dữ liệu đầu vào cho Demand Planning

## 1. Phạm vi

Tài liệu này quy định dữ liệu POS/ERP bàn giao cho module Demand Planning. Đây là ranh giới giữa **dữ liệu nguồn** và **dữ liệu được module tạo ra**.

## 2. Nguyên tắc bất biến

1. SQL không tạo dòng cho ngày không có nguồn thật.
2. Module Demand Planning tạo lịch liên tục.
3. Không dùng `0` thay cho `null`.
4. Tồn được tính từ phát sinh thật; nền nhu cầu được ước lượng ở Chặng 3–5 là lớp dữ liệu khác.
5. CTKM lịch sử được bàn giao bằng khoảng hiệu lực, không chỉ bằng marker trên ngày có bán.
6. Mọi lần trích xuất phải có metadata để biết phạm vi và phiên bản query.

## 3. Các tập dữ liệu

### 3.1. `DailySourceRecord`

Một dòng ứng với SKU — nơi bán — ngày có ít nhất một nguồn thật: bán, trả, phát sinh kho hoặc phiếu nhập.

| Trường | Kiểu | Null | Ý nghĩa |
|---|---|---:|---|
| `ExtractId` | string | Không | Mã lần trích xuất. |
| `StoreCode` | string | Không | Nơi bán/kho. Nếu DB chỉ có một nơi, lấy từ tham số metadata. |
| `SKU` | string | Không | Mã sản phẩm. |
| `Date` | date | Không | Ngày nguồn. |
| `Sales` | decimal | Có | Số bán khi có dòng POS. `null` khi dòng tồn tại chỉ do nguồn kho. |
| `HasSalesRecord` | boolean | Không | Có dòng bán POS của SKU trong ngày. |
| `ReturnQty` | decimal | Có | Số lượng hoàn/trả nếu xác định được. |
| `InventoryNetMovement` | decimal | Có | Phát sinh tồn ròng trong ngày. |
| `HasInventoryMovement` | boolean | Không | Có phát sinh kho hoặc POS tác động tồn. |
| `OpenStock` | decimal | Có | Tồn đầu ngày được tính từ phát sinh thật. |
| `CloseStock` | decimal | Có | Tồn cuối ngày được tính từ phát sinh thật. |
| `StockCalculationStatus` | enum | Không | `CALCULATED`, `ANCHOR_MISSING`, `NEGATIVE_REVIEW`, `UNRESOLVED`. |
| `ReceiptHour` | time | Có | Giờ phiếu nhập đầu tiên loại 1, nếu còn giờ thật. |
| `HasReceiptRecord` | boolean | Không | Có phiếu nhập phù hợp. |
| `Price` | decimal | Có | Đơn giá chuẩn phục vụ ABC; phải có nguồn và phương pháp rõ. |
| `ProductName` | string | Có | Tên hiển thị. |
| `HasRecord` | boolean | Không | Luôn `true` ở tập SQL này. Dòng scaffold do module tạo sẽ là `false`. |
| `IsReferenceOnly` | boolean | Không | Nằm trước khung xử lý, chỉ dùng tìm tham chiếu. |

### 3.2. `PromotionInterval`

| Trường | Kiểu | Null | Ý nghĩa |
|---|---|---:|---|
| `StoreCode` | string | Không | Phạm vi áp dụng nếu có. |
| `SKU` | string | Không | SKU trong bundle/promotion. |
| `PromoCode` | string | Không | Mã CTKM nguyên bản. |
| `PromoName` | string | Có | Tên chương trình. |
| `StartDate` | date | Không | Ngày bắt đầu. |
| `EndDate` | date | Không | Ngày kết thúc. |
| `PromoTypeSource` | string | Có | Loại từ DB nếu có. |
| `IsPOS` | boolean | Có | Cờ áp dụng POS. |
| `SourceRole` | enum | Không | `DIRECT_PRODUCT`, `REF_PRODUCT`, `POS_MARKER`. |
| `PolicyClassification` | enum | Có | Do module/chính sách gán: `CAMPAIGN`, `STANDING_PRICE`, `CLEARANCE`, `UNKNOWN_REVIEW`. |

### 3.3. `ExtractMetadata`

| Trường | Ý nghĩa |
|---|---|
| `ExtractId` | Mã duy nhất. |
| `QueryVersion` | Ví dụ `demand-planing-v3`. |
| `RunMode` | `HISTORICAL_VALIDATION`, `HISTORICAL_BACKTEST`, `OPERATIONAL_PLANNING`. |
| `RunDate` | Ngày mô phỏng/lập kế hoạch. |
| `ProcessingStartDate` | Ngày đầu module tạo chu kỳ. |
| `ProcessingEndDate` | Ngày cuối dữ liệu quá khứ được phép dùng. |
| `ReferenceReadStartDate` | Ngày sớm nhất SQL đọc để làm tham chiếu. |
| `StoreCode` | Nơi bán. |
| `SelectedSkuCount` | Số SKU. |
| `PortfolioMode` | `FULL_PORTFOLIO`, `SELECTED_SKU_SIMULATION`, `SINGLE_SKU_DIAGNOSTIC`. |
| `StockAnchorAssumption` | Giả định mốc tồn. |
| `GeneratedAt` | Thời điểm chạy query. |

## 4. Dữ liệu module tạo ra

Module tạo `CalendarDailyRecord` cho mọi ngày trong khung:

| Trường | Cách tạo |
|---|---|
| `Date` | Từ lịch liên tục. |
| `CycleId` | Chia theo 15 ngày lịch, không đếm bản ghi nguồn. |
| `HasRecord` | `true` nếu ghép được `DailySourceRecord`, ngược lại `false`. |
| `SalesStatus` | `OBSERVED`, `CONFIRMED_ZERO`, `SOURCE_UNKNOWN`, `OUTSIDE_ACTIVE_PERIOD`. |
| `OpenStock`/`CloseStock` | Từ nguồn hoặc mang tiếp theo quy tắc tồn, có trạng thái nguồn. |
| `PromoStatus` | Ghép từ `PromotionInterval`. |
| `BaseDemand` | Chỉ được tạo từ Chặng 3–5. |


### 4.1. `CycleBaselineRecord`

Một dòng ứng với một vị trí chu kỳ 15 ngày theo lịch. Chu kỳ không được biến mất chỉ vì chưa khóa.

| Trường | Kiểu | Null | Ý nghĩa |
|---|---|---:|---|
| `CycleId` | integer/string | Không | Vị trí chu kỳ theo lịch, liên tiếp và không tái đánh số sau khi lọc. |
| `CycleStartDate`/`CycleEndDate` | date | Không | Ranh giới đúng 15 ngày lịch. |
| `CycleBaseDemand` | decimal | Có | Tổng nền chu kỳ; `null` khi chưa giải quyết. |
| `CycleStatus` | enum | Không | `LOCKED_OBSERVED`, `LOCKED_ADJUSTED`, `LOCKED_FALLBACK`, `PARTIAL_BASELINE`, `NO_SOURCE_RECORD`, `BASELINE_UNRESOLVED`, `OUTSIDE_ACTIVE_PERIOD`, `DATA_ERROR`. |
| `UnresolvedDays` | integer | Không | Số ngày chưa có nền. |
| `ReviewRequired` | boolean | Không | Chu kỳ được dùng có điều kiện. |
| `IsEligibleBaseCycle` | boolean | Không | Chỉ `true` khi đủ 15 ngày, nền khác `null`, không âm, `UnresolvedDays=0` và trạng thái `LOCKED_*`. |

Giá trị `CycleBaseDemand=0` chỉ hợp lệ khi `IsEligibleBaseCycle=true`. `0` không được dùng thay cho chu kỳ `null`.

### 4.2. `SeriesEligibilityAssessment`

Được tạo sau Chặng 5 cho từng SKU — nơi bán và từng chặng đích.

| Trường | Ý nghĩa |
|---|---|
| `TargetStage` | `ABC`, `XYZ`, `FORECAST` hoặc chặng khác. |
| `RequiredWindowStart/End` | Cửa sổ chu kỳ cố định được đánh giá. |
| `RequiredCycleCount` | Số vị trí chu kỳ phải có. |
| `EligibleCycleCount` | Số chu kỳ đạt hợp đồng. |
| `MissingOrBlockedCycleIds` | Danh sách vị trí không đạt; không được loại bỏ để nén chuỗi. |
| `MaxContinuousEligibleCycles` | Đoạn liên tiếp dài nhất. |
| `EligibilityStatus` | `ELIGIBLE`, `REVIEW_REQUIRED`, `BLOCKED`. |
| `BlockedReason` | Ví dụ `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY`. |

### 4.3. `DemandClassificationResult`

| Trường | Null | Ý nghĩa |
|---|---:|---|
| `DemandClass` | Có | `X`, `Y`, `Z`, `D`; phải là `null` nếu phân loại bị chặn bởi chất lượng dữ liệu. |
| `ClassificationStatus` | Không | `CLASSIFIED`, `D_TRUE_SHORT_HISTORY`, `CLASSIFICATION_BLOCKED`, `REVIEW_REQUIRED`. |
| `ReasonCode` | Có | Nguyên nhân, không được dùng D thay cho lỗi nền. |
| `ForecastFallbackStrategy` | Có | `MD_FUTURE_PLAN`, `SIMILAR_SKU_APPROVED`, `REFERENCE_STORE_APPROVED` hoặc `NONE`; đây không phải nhãn D. |

## 5. Quy tắc về số 0

| Tình huống | `Sales` | Trạng thái |
|---|---:|---|
| Có dòng POS và tổng Qty bằng 0 thật | 0 | `OBSERVED_ZERO` |
| Không có dòng POS nhưng POS ngày đó được xác nhận đầy đủ, SKU đang hoạt động | 0 | `CONFIRMED_ZERO` |
| Không có dòng POS và chưa có bằng chứng độ đầy đủ | null | `SOURCE_UNKNOWN` |
| SKU chưa mở bán/đã ngưng | null | `OUTSIDE_ACTIVE_PERIOD` |

## 6. Tính tồn

$$
C_d = O_d + I_d + R_d - X_d - S_d
$$

$$
O_d = C_{d-1}
$$

Trong đó:

- $O_d$: tồn đầu ngày;
- $C_d$: tồn cuối ngày;
- $I_d$: nhập tăng tồn;
- $R_d$: trả hàng tăng tồn;
- $X_d$: xuất giảm tồn;
- $S_d$: bán giảm tồn.

Nếu không có phát sinh ở ngày do module tạo:

$$
O_d=C_{d-1},\qquad C_d=O_d
$$

Nguồn phải được ghi `CARRIED_FORWARD`, không được gọi là quan sát trực tiếp.

## 7. Điều kiện nghiệm thu dữ liệu

- Không có chu kỳ được tạo trong SQL.
- Không mất ngày thật chỉ để làm tròn số chu kỳ.
- Có thể đối soát `OpenStock[d] = CloseStock[d-1]` trên lịch dày.
- Promo interval phủ được cả ngày không bán.
- Không có `Sales=0` giả phát sinh từ `COALESCE` mà thiếu `HasSalesRecord`.
- Metadata cho biết rõ tập dữ liệu bị giới hạn hay toàn danh mục.
- Chuỗi sau Chặng 5 giữ nguyên mọi `CycleId`; không có bước lọc rồi đánh lại thứ tự.
- `DemandClass` phải là `null` khi cửa sổ phân loại bị đứt bởi chu kỳ unresolved.
