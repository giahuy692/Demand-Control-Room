# Demand Planning Monitor — operational design

## 1. Vấn đề của bản monitor cũ

Bản đầu chỉ chọn một tín hiệu nổi trội cho mỗi SKU. Cách này làm mất ba thứ quan trọng:

- một SKU có thể cùng lúc cần duyệt phân nhóm, mô hình, MOQ và phát hành;
- không nhìn được đầu ra đã khóa của từng chặng;
- không tách kết quả pipeline, hàng đợi quyết định và hậu kiểm.

## 2. Nguyên tắc từ tài liệu giải pháp Hachi

Monitor phải bám ba lớp:

1. **Control board 19 chặng:** hiển thị snapshot, đầu ra khóa, số SKU đã xử lý, số cần xem xét và ngoại lệ.
2. **Decision inbox:** mỗi dòng là một quyết định cần người chịu trách, có bằng chứng và drill-down về đúng SKU/chặng.
3. **Outcome review:** đo WAPE/Bias, stockout, tồn cuối, ETA, MOQ, vốn và nghẽn duyệt; tách nguyên nhân theo Chặng 19 và không hồi tố.

Nhóm quyết định bắt buộc hiển thị gồm:

- C1–C5: stockout, nền thiếu căn cứ, chu kỳ không khóa;
- C6–C8: ABC năm hóa/N-A, nhóm Z/D, chính sách ngoài ma trận;
- C9–C10: mùa vụ thiếu cấu trúc, xu hướng bị giới hạn;
- C11: model lock/review/temporary/exception, riêng nhánh Z/D;
- C12–C13: hệ số CTKM tin cậy thấp/bị chặn và tác động dự báo cuối;
- C14–C16: free stock, lead time, safety stock, thiếu master, dư MOQ;
- C17–C18: cắt vốn, thiếu thông tin, chờ duyệt, không phát hành;
- C19: sai số, stockout, ETA, tồn cuối, nguyên nhân và đề xuất phiên sau.

## 3. Đối chiếu thực hành thị trường

- SAP IBP dùng exception management với rule/threshold, chia sẻ, snooze, case và drill-down về planning context: <https://help.sap.com/docs/SAP_INTEGRATED_BUSINESS_PLANNING/feae3cea3cc549aaa9d9de7d363a83e6/3fbecc72ba3a41fb8c867e4ee16289bd.html>
- SAP alert thể hiện severity score, owner, location/time và sắp theo mức nghiêm trọng: <https://help.sap.com/docs/SAP_TRANSPORTATION_RESOURCE_PLANNING/5e6a4678e771476eaa6aa75795c4f0c1/9cefe3535582482ae10000000a423f68.html>
- Oracle tổ chức exceptions theo measure, level và threshold; demand exceptions bao gồm forecast error và deviation giữa actual/forecast: <https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/26b/fasdm/predefined-demand-planning-exceptions.html>
- Oracle plan approval tạo bản forecast tĩnh sau chu kỳ review/override: <https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/25b/faupc/approve-a-demand-plan.html>
- Microsoft nhấn mạnh aggregation/disaggregation, accuracy, version history, collaboration và exception-based planning: <https://learn.microsoft.com/en-us/dynamics365/supply-chain/demand-planning/demand-planning-home-page>

## 4. Information architecture

### Tổng quan

- readiness của phiên;
- decision backlog và SKU bị ảnh hưởng;
- giá trị mua có rủi ro;
- tỷ lệ phát hành;
- sáu cổng: data, segmentation/policy, forecast/promo, supply/inventory, capital/release, learning.

### Duyệt & ngoại lệ

Mỗi item có: severity, chặng, SKU, quyết định, bằng chứng, tác động, owner và nút mở hồ sơ. Monitor không giả lập nút Approve nếu domain chưa có decision log/người duyệt.

### Kiểm soát 19 chặng

Mỗi chặng có: purpose, owner, processed count, review count, exception count, snapshot summary, status và drill-down.

### Hậu kiểm

Hiển thị outcome theo SKU và phân bố root cause. Mọi đề xuất chỉ áp dụng cho phiên sau.

