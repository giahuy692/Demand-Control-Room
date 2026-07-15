# README — Nguồn sự thật của phân hệ Demand Planning

## 1. Mục đích

File này xác định tài liệu nào được dùng để hiểu nghiệp vụ, tài liệu nào dùng để triển khai, file nào chỉ là dữ liệu/bằng chứng và thứ tự ưu tiên khi có nội dung mâu thuẫn.

## 2. Thứ tự ưu tiên

| Ưu tiên | Nguồn | Vai trò |
|---:|---|---|
| 1 | `INSTRUCTIONS.md` | Quy trình bắt buộc để AI đọc nguồn, chạy Preflight, test và báo cáo. |
| 2 | `01-Danh-sach-quyet-dinh-nghiep-vu.md` | Các quyết định đã thống nhất; có hiệu lực cao nhất trong gói này. |
| 3 | `02-Hop-dong-du-lieu-dau-vao.md` | Hợp đồng giữa POS/ERP và module Demand Planning. |
| 4 | `04-Dac-ta-trien-khai-Demand-Planning.md` | Quy tắc đủ cụ thể để code và kiểm thử. |
| 5 | `07-Danh-muc-Golden-Test.md` + dữ liệu kiểm thử | Kết quả mong đợi dùng để nghiệm thu. |
| 6 | `Tài liệu giải pháp - Demand Planning & Replenishment Governance(26).md` | Tài liệu nghiệp vụ dễ đọc cho MC, LGT, BA, MD, Thu mua và IT. |
| 7 | `demand-planing-data-source-notes-v3.md` | Khảo sát bảng nguồn, khóa nối, logic tính dữ liệu thực và rủi ro dữ liệu. |
| 8 | `demand-planing-v3.sql` | Bản SQL đề xuất để lấy dữ liệu nguồn thật và dữ liệu tồn được tính từ phát sinh thật. |
| 9 | Báo cáo mô phỏng và JSON lịch sử | Bằng chứng đầu vào/kết quả cũ; không tự trở thành quy tắc nghiệp vụ. |

## 3. Kiến trúc đã khóa

1. POS/ERP trả dữ liệu nguồn theo kiểu **thưa**: chỉ có dòng khi DB thật có giao dịch hoặc phát sinh nguồn.
2. SQL **không tạo lịch liên tục**, không chia chu kỳ 15 ngày và không lấp nền.
3. `OpenStock` và `CloseStock` không có bảng tồn ngày thô; chúng được tính từ bán, trả, nhập, xuất và điều chỉnh đã ghi nhận trong DB.
4. Module Demand Planning tạo lịch liên tục, ghép dữ liệu nguồn và tạo các ngày `HasRecord=false`.
5. Ngày không có dòng bán không mặc nhiên là `Sales=0`. Giá trị 0 chỉ được dùng khi có đủ bằng chứng đây là số 0 thật.
6. Phiên kiểm thử hiện tại là `HISTORICAL_VALIDATION`; chưa có kế hoạch CTKM tương lai thật.
7. Chặng 13 trong phiên hiện tại chỉ chạy nhánh `PASSTHROUGH_NO_FUTURE_PROMO`.
8. Chỉ chạy một tập SKU không đủ để khóa ABC chính thức của toàn danh mục.
9. “Đã chạy” không đồng nghĩa “đã khóa”.
10. Sau Chặng 5 phải có cổng chất lượng chuỗi riêng cho Chặng 6, Chặng 7 và Chặng 11.
11. Không được bỏ các chu kỳ chưa khóa rồi nối những chu kỳ còn lại thành một chuỗi giả liên tục.
12. Chu kỳ có giá trị bằng 0 chỉ hợp lệ khi chu kỳ đã được giải quyết và khóa; điều kiện `>= 0` không đủ để chứng minh dữ liệu hợp lệ.
13. SKU lâu năm có chu kỳ đứt đoạn hoặc nền chưa giải quyết phải có `DemandClass=null` và trạng thái chặn; không được gán D để đi tiếp.
14. Nhóm D chỉ dành cho SKU mới hoặc có lịch sử thật sự ngắn sau khi đã xác nhận phạm vi dữ liệu đầy đủ.
15. Kế hoạch MD là dự báo tương lai; không mặc định dùng để điền lịch sử. AI chỉ đề xuất SKU tương tự, người có thẩm quyền phải duyệt.


## 4. File cũ

| File cũ | Trạng thái |
|---|---|
| `Tài liệu giải pháp...(25).md` | Được thay bằng bản 26 trong gói này. |
| `demand-planing-data-source-notes(2).md` | Nội dung khảo sát hữu ích đã được tổ chức lại trong bản v3; các kết luận cũ mâu thuẫn không còn hiệu lực. |
| `demand-planing(2).sql` | Giữ làm đối chiếu; bản v3 là bản đề xuất mới. |
| `bao-cao-mo-phong-2026-02-01(1).md` | Bằng chứng trước điều chỉnh, không phải tiêu chuẩn nghiệm thu. |

## 5. Quy tắc xử lý mâu thuẫn

- Không tự chọn cách hiểu thuận tiện cho code.
- Ghi mâu thuẫn vào `01-Danh-sach-quyet-dinh-nghiep-vu.md` với trạng thái `CHỜ DUYỆT`.
- Chưa được chuyển một quy tắc `CHỜ DUYỆT` thành hành vi vận hành chính thức.
- Có thể code dưới dạng cấu hình/tính năng tắt mặc định nếu đặc tả yêu cầu chuẩn bị trước.
