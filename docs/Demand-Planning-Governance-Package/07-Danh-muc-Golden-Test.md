# Danh mục Golden Test

## 1. Quy cách một test

Mỗi test phải có:

- mã test;
- rule liên quan;
- dữ liệu đầu vào nhỏ, đọc được bằng mắt;
- kết quả trung gian;
- kết quả cuối;
- lý do;
- file JSON/CSV đi kèm khi triển khai.

## 2. Danh sách test bắt buộc

| Mã | Tình huống | Kết quả mong đợi |
|---|---|---|
| GT-01 | SQL thưa có ngày 1 và 3 | Module tạo ngày 2 với `HasRecord=false`, `Sales=null`. |
| GT-02 | Ngày scaffold có `Sales` placeholder 0 | Không được xem là số 0 quan sát hoặc ngày sạch. |
| GT-03 | 15 ngày lịch nhưng chỉ 8 bản ghi | Vẫn tạo đúng một CK 15 ngày, không kéo dài tới bản ghi thứ 15. |
| GT-04 | Dữ liệu tham chiếu trước khung | Được tìm nền nhưng không vào chuỗi học. |
| GT-05 | Tồn chưa đủ tin cậy | Không đánh stockout tự động. |
| GT-06 | Tồn âm | Giữ số âm, gắn `NEGATIVE_REVIEW`. |
| GT-07 | Có 3 ngày sạch quanh stockout | Lấy trung vị, không dùng ngày lấp làm nguồn. |
| GT-08 | Chỉ có 5 ngày sạch một phía | Tạo nền `UNBALANCED_FIXED`, không để null. |
| GT-09 | Mã CTKM được duyệt `STANDING_PRICE` | Ngày được xử lý như bán bình thường. |
| GT-10 | Hai CTKM chồng lấn | Giữ cả hai mã và một vùng có bằng chứng đầy đủ. |
| GT-11 | CTKM sát cận dưới, có 3 ngày một phía | Tính nền tạm và gắn cờ biên. |
| GT-12 | CTKM phủ gần toàn lịch sử, không có đối chứng | `BASELINE_NOT_IDENTIFIABLE`, tạo task ngoại lệ. |
| GT-13 | Có cửa hàng tương đồng đã duyệt | Dùng baseline sau quy đổi, lưu nguồn. |
| GT-14 | Không có ứng viên trong tập 30 SKU | `REFERENCE_SEARCH_REQUIRED`, không kết luận không tồn tại ứng viên. |
| GT-15 | Chạy 30 SKU | Không khóa ABC chính thức. |
| GT-16 | `sourceRecordDays=0` | `NO_SOURCE_RECORD`. |
| GT-17 | Có dữ liệu nhưng 15 ngày unresolved | `BASELINE_UNRESOLVED`, không gọi “trống”. |
| GT-18 | CK có 14/15 ngày nền | Lấy median snapshot, lấp 1 ngày, `LOCKED_ADJUSTED`. |
| GT-19 | CK có 8/15 ngày trải đầu-giữa-cuối | Lấp theo cấu hình, ít nhất `LOCKED_WITH_REVIEW`. |
| GT-20 | CK chỉ có 1/15 ngày nền | Không nhân 1 ngày cho 14 ngày còn lại. |
| GT-21 | `SELECTED_SKU_SIMULATION` | Chỉ xếp hạng trong tập, ABC official = null. |
| GT-22 | Override ABC | Bắt buộc lý do/version, hiệu lực phiên sau. |
| GT-23 | SKU cũ nhưng baseline unresolved | `DemandClass=null`, `CLASSIFICATION_BLOCKED_BASELINE_UNRESOLVED`; không D. |
| GT-24 | XYZ | Log ADI, CV², số CK, bằng chứng phân loại. |
| GT-25 | Chính sách chưa duyệt | Không thành `EFFECTIVE`. |
| GT-26 | Không có service level | `null`, không dùng 0%. |
| GT-27 | CTKM thường trực | Không học hệ số uplift chiến dịch. |
| GT-28 | Không có kế hoạch CTKM tương lai | `finalForecast=baselineForecast`. |
| GT-29 | Chặng 13 passthrough | `PASSTHROUGH_NO_FUTURE_PROMO`, nhánh áp K = `NOT_EVALUATED`. |
| GT-30 | Hàm chạy nhưng dữ liệu blocked | Stage = `BLOCKED`, không báo `LOCKED`. |
| GT-31 | CK có `CycleBaseDemand=0`, đã khóa và `unresolvedDays=0` | CK hợp lệ; số 0 được giữ như nhu cầu 0 thật. |
| GT-32 | CK14, CK15, CK25 đều khóa nhưng CK16–24 unresolved | Không nối thành chuỗi 3 CK; ABC/XYZ cửa sổ liên tục bị chặn. |
| GT-33 | SKU lâu năm có 22/75 CK khóa rải rác | `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY`, `DemandClass=null`, không D và không chạy mô hình tự học. |
| GT-34 | Có 6 CK khóa liên tiếp trong cửa sổ ABC | Được năm hóa theo chính sách; nếu 6 CK nằm rải rác thì không được dùng. |
| GT-35 | SKU mới có 4 CK hoạt động, extract đầy đủ và cả 4 CK đã khóa | Gán D với lý do `D_TRUE_SHORT_HISTORY`; không coi là lỗi nền. |
| GT-36 | 24 CK liên tục đều khóa và đều bằng 0 | Không gán D; trả `NO_POSITIVE_DEMAND_REVIEW` hoặc chính sách Z-zero-demand đã duyệt. |
| GT-37 | Dự báo nhận 12 CK khóa nhưng có một CycleId bị thiếu ở giữa | `FORECAST_INPUT_BLOCKED`; không nén thành 11 CK và không tự chuyển D. |
| GT-38 | AI tìm được SKU tương tự | Chỉ tạo candidate; chưa có phê duyệt thì không áp dự báo. |
| GT-39 | MD nhập kế hoạch tương lai | Tạo `MD_FUTURE_PLAN`; không ghi ngược thành baseline lịch sử. |
| GT-40 | Cùng SKU tại cửa hàng tham chiếu đã duyệt | Cho phép quy đổi theo hệ số và lưu giai đoạn chồng lấn/bằng chứng. |

## 3. Regression test dữ liệu thật

Chọn ít nhất sáu SKU:

1. `31054 — Rice bran oil 1500g`: CTKM dày.
2. SKU stockout nhiều.
3. SKU ít CTKM và đủ nền.
4. SKU mới.
5. SKU bán thưa nhưng đủ dữ liệu.
6. SKU có tồn âm.

Mỗi regression test phải khóa snapshot đầu vào và kết quả mong đợi sau khi nghiệp vụ duyệt, không chỉ so với kết quả code cũ.
