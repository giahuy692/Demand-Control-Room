# Đặc tả báo cáo mô phỏng và Audit Explorer

## 1. Mục tiêu

Báo cáo phải cho biết hệ thống đã làm gì, dựa vào dữ liệu nào, vì sao rẽ nhánh và kết quả có đủ điều kiện dùng hay không.

## 2. Cấp phiên

Hiển thị:

- `RunMode`;
- `PortfolioMode`;
- `RunDate`;
- `ProcessingStartDate/EndDate`;
- `ReferenceReadStartDate`;
- query version/extract id;
- số SKU;
- chặng nào `LOCKED`, `BLOCKED`, `NOT_EVALUATED`;
- số task ngoại lệ đang mở.

Không dùng câu “19/19 chặng đã khóa” khi chỉ có 19 hàm đã chạy.

## 3. Cấp chặng

| Trạng thái | Số SKU | Ý nghĩa |
|---|---:|---|
| `LOCKED` | | Đủ điều kiện bàn giao. |
| `LOCKED_WITH_REVIEW` | | Được dùng có cờ kiểm tra. |
| `REVIEW_REQUIRED` | | Chờ người xử lý. |
| `BLOCKED` | | Không được dùng chặng sau. |
| `NOT_APPLICABLE` | | Không thuộc SKU/chế độ. |
| `NOT_EVALUATED` | | Thiếu phạm vi/dữ liệu để kiểm chứng. |

## 4. Cấp ngày

- nguồn dòng: POS/kho/scaffold;
- `HasRecord`, `HasSalesRecord`;
- Sales và trạng thái của Sales;
- tồn, nguồn tồn, chất lượng tồn;
- CTKM và loại CTKM;
- stockout;
- BaseDemand;
- nguồn baseline;
- ngày tham chiếu được dùng;
- rule id đã quyết định.

## 5. Cấp chu kỳ

Hiển thị bắt buộc:

- ngày bắt đầu/kết thúc **theo lịch**;
- 15 vị trí ngày;
- `sourceRecordDays`;
- `observedCleanDays`;
- `stockoutAdjustedDays`;
- `promoAdjustedDays`;
- `technicalFillDays`;
- `fallbackDays`;
- `unresolvedDays`;
- median dùng lấp;
- trạng thái khóa;
- lý do không khóa.

`Rỗng` chỉ dùng khi `sourceRecordDays=0`.

## 6. CTKM

Gom lỗi theo vùng, không lặp một lỗi cho từng ngày:

| SKU | PromoCode(s) | Từ ngày | Đến ngày | Số ngày | Nguồn trước | Nguồn sau | Trạng thái |
|---|---|---|---|---:|---:|---:|---|

## 7. Cổng chất lượng chuỗi sau Chặng 5

Hiển thị theo từng SKU và chặng đích:

- cửa sổ `CycleId` bắt buộc;
- `EligibleCycleCount`;
- `MaxContinuousEligibleCycles`;
- danh sách `MissingOrBlockedCycleIds`;
- chu kỳ bằng 0 hợp lệ;
- `EligibilityStatus` và `BlockedReason`.

Giao diện không được ẩn CK lỗi rồi nối hai đầu thành một chuỗi liên tục giả.

## 8. ABC/XYZ

- ghi rõ `FULL_PORTFOLIO` hay tập mẫu;
- hiển thị `DemandClass=null` nếu chất lượng chuỗi bị chặn;
- không hiển thị D cho SKU lâu năm có nền unresolved;
- tách `D_NEW/D_TRUE_SHORT_HISTORY` khỏi `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY`;
- ABC tự động/ảnh chụp đã duyệt;
- ADI/CV²;
- số chu kỳ và chất lượng chu kỳ;
- nhóm đề xuất/nhóm hiệu lực;
- quyết định phê duyệt.

## 8. Hàng đợi công việc

Mỗi dòng:

- SKU/nơi bán;
- chặng;
- mã ngoại lệ;
- bằng chứng;
- hành động cần làm;
- vai trò phụ trách;
- trạng thái;
- hạn xử lý;
- liên kết màn hình audit.

## 9. Chặng 13 trong phiên hiện tại

Hiển thị:

```text
RunMode: HISTORICAL_VALIDATION
Future promotion plan: Không có
Final forecast: bằng baseline forecast
Status: PASSTHROUGH_NO_FUTURE_PROMO
Apply-future-promo branch: NOT_EVALUATED
```

## 9. Chiến lược ngoại lệ

Báo cáo phải tách:

- `HistoricalBaselineRecovery`: nguồn dùng phục hồi lịch sử;
- `ReferenceStoreCandidate`: cùng SKU ở cửa hàng khác;
- `SimilarSkuCandidate`: AI đề xuất, trạng thái duyệt;
- `MdFuturePlan`: kế hoạch dự báo tương lai, không phải nền lịch sử.
