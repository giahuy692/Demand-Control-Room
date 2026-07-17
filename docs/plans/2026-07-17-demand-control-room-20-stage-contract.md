# Hợp đồng đối chiếu Demand Control Room 20 chặng

Nguồn nghiệp vụ: `docs/Demand-Planning-Governance-Package/Tài liệu giải pháp - Demand Planning & Replenishment Governance.md` tại trạng thái working tree ngày 2026-07-17.

Nguồn giao diện: `AGENTS.md` là chuẩn đang chạy. Vì vậy Minimalist Dark hiện hữu (Aptos/Bahnschrift/Cascadia Code, token amber-on-slate, mật độ cao) được giữ thay cho màu và font DevLog trong prompt khi hai nguồn xung đột.

## Quyết định trước triển khai

- Giữ dữ liệu gốc bất biến; mọi giá trị làm sạch nằm ở `baseDemand` và có nguồn, bằng chứng, trạng thái riêng.
- `null` là thiếu quan sát; `0` chỉ là số 0 thật khi có bằng chứng nguồn. Không đổi `null` thành `0`.
- Chặng 5 chỉ xử lý ngày còn thiếu nền. Chặng 6 chỉ gom đúng 15 ngày; không lấp thêm và không nối qua chu kỳ lỗi.
- Cùng dữ liệu, chính sách và phiên bản quy tắc phải cho cùng kết quả. Chạy lại tạo snapshot mới, không sửa snapshot đã phát hành.
- Khi thiếu điều kiện bắt buộc, kết quả là cần xem xét, chưa thể tiếp tục, không áp dụng hoặc chưa đánh giá; không tạo số thay thế có vẻ hợp lý.

## Ma trận 20 chặng

| Chặng | Đầu vào | Công thức hoặc quy tắc quyết định | Điều kiện chốt / dừng | Kết quả bàn giao | Chặng nhận |
| ---: | --- | --- | --- | --- | --- |
| 1 | Ngày chạy, số năm lịch sử, lịch nguồn theo mã hàng/nơi bán | Khóa cửa sổ lịch sử theo năm hoàn tất; chia tuần tự thành chu kỳ 15 ngày, giữ ngày dư và ngày ngoài phạm vi | Thiếu ngày chạy hoặc lịch không hợp lệ: chưa thể tiếp tục | Khoảng lịch sử, lịch ngày liên tục, lịch chu kỳ | 2–20 |
| 2 | Lịch ngày, bán ghi nhận, tồn đầu/cuối, nhập và giờ nhập đầu tiên | Chỉ đánh dấu thiếu hàng từ bằng chứng tồn; ngày mất dòng nguồn không tự là thiếu hàng | Tồn âm, thiếu mốc tồn hoặc bằng chứng không đủ: cần xem xét | Cờ thiếu hàng và lý do theo ngày | 3, 4, 5, 20 |
| 3 | Ngày thiếu hàng không khuyến mãi, ngày sạch lân cận | Tìm ±7 → ±14 → tối đa ±24; ưu tiên cân bằng hai phía; nền = median tham chiếu; nếu có bán thì `max(sales, median)` | Dưới số tham chiếu tối thiểu: chưa đủ căn cứ | Nền ngày thiếu hàng, tập tham chiếu, độ cân bằng | 5, 6, 20 |
| 4 | Vùng khuyến mãi, bán ghi nhận, ngày sạch trước/sau | Không xuyên qua cụm khuyến mãi; nền tự nhiên = median ngày sạch hợp lệ; giữ riêng phần tăng do khuyến mãi | Combo/hàng tặng, loại khuyến mãi chưa rõ hoặc thiếu nền: cần xem xét | Nền tự nhiên ngày khuyến mãi và bằng chứng vùng | 5, 6, 13, 20 |
| 5 | Kết quả ngày Chặng 2–4 và cờ đầy đủ nguồn | Chỉ lấp ngày thật sự thiếu bằng median tối đa 14 ngày sạch, tối thiểu 3; không dùng ngày ước lượng làm nguồn; nếu có bán thì `max(sales, median)` | Số 0 thật, ngoài kỳ, chu kỳ trống, tồn bất thường: không lấp; thiếu 3 nguồn: chưa đủ căn cứ | Dữ liệu ngày hoàn thiện, ngày lấp, ngày chưa giải quyết, độ tin cậy | 6, 20 |
| 6 | 15 ngày lịch đã xử lý | `Y_j = sum(B_d), d=1..15`; giữ số ngày sạch, 0 thật, thiếu hàng, khuyến mãi, lấp và chưa rõ | Còn `baseDemand=null`, âm hoặc chưa xác nhận: không dùng để học tự động; không bỏ vị trí thời gian | Chuỗi sức mua cơ bản 15 ngày và chất lượng chu kỳ | 7–13, 16, 20 |
| 7 | Chu kỳ đủ điều kiện và giá/giá trị đã duyệt | Giá trị tiêu thụ chuẩn hóa; sắp giảm dần; nhóm theo tỷ trọng giá trị cộng dồn và điểm cắt A/B/C được duyệt | Tập danh mục bị cắt hoặc quá ít chu kỳ: đề xuất/chưa xếp chính thức | ABC, giá trị, tỷ trọng, tỷ trọng cộng dồn, version duyệt | 9, 12, 16, 18, 20 |
| 8 | Chuỗi chu kỳ giữ nguyên khoảng trống và số 0 thật | `ADI = số chu kỳ / số chu kỳ có nhu cầu`; `CV² = (độ lệch chuẩn / trung bình khi có nhu cầu)²`; quyết định X/Y/Z/D theo thứ tự tài liệu | Chuỗi ngắn, bị cắt hoặc còn chu kỳ chưa giải quyết: D có lý do hoặc chặn, không gộp thành Z | X/Y/Z/D, ADI, CV², lý do | 9, 12, 16, 18, 20 |
| 9 | ABC, XYZ/D, vai trò danh mục đã duyệt | Tra ma trận ABC × XYZ; D đi nhánh riêng; vai trò danh mục chỉ điều chỉnh sau ma trận | Thiếu phân loại hoặc ô chính sách: cần duyệt, không tự suy rộng | Mức phục vụ tối thiểu, ưu tiên vốn, chính sách ngoại lệ | 12, 16, 18, 19, 20 |
| 10 | Nhóm Y và các vòng mùa vụ cùng vị trí | So sánh hệ số vị trí qua nhiều vòng; chốt khi tín hiệu lặp đạt số vòng và độ tin cậy quy định | Không phải Y: không áp dụng; thiếu vòng: chưa đánh giá | Kết luận mùa vụ, hệ số theo vị trí, tỷ lệ lặp | 11, 12, 20 |
| 11 | Nhóm Y không có mùa vụ rõ, 12 chu kỳ gần nhất | Chia ba đoạn, tính trung bình; chỉ kết luận tăng/giảm khi hai mức thay đổi liên tiếp cùng hướng và qua giới hạn an toàn | Không phải Y hoặc thiếu 12 chu kỳ: không áp dụng/chưa đánh giá | Xu hướng tăng, giảm hoặc chưa rõ và bằng chứng ba đoạn | 12, 20 |
| 12 | Nhóm nhu cầu, cấu trúc mùa vụ/xu hướng, chuỗi khóa | Chỉ thử tập cách dự báo được phép; kiểm tra theo thứ tự thời gian; tính RMSE, nRMSE, WAPE, Bias; chọn cách đạt cả điều kiện cấu trúc và sai số, không chỉ sai số thấp nhất | Không cách nào đạt hoặc ngưỡng chưa được duyệt: cần xem xét; nhóm D dùng kế hoạch/đối tượng tương tự đã duyệt | Cách dự báo, tham số, dự báo nền, sai số và lý do loại | 14, 16, 20 |
| 13 | Các đợt khuyến mãi lịch sử, nền tự nhiên Chặng 4/5, loại khuyến mãi | Học hệ số từ mẫu tương tự gần nhất đủ căn cứ; số mẫu khác dùng kiểm tra ổn định, không lấy median tùy tiện | Thiếu mẫu tương tự, combo/hàng tặng chưa tách hoặc chồng lấn: hệ số cần duyệt/bị chặn | Nhóm khuyến mãi, hệ số, mẫu nguồn, độ ổn định | 14, 19, 20 |
| 14 | Dự báo nền, kế hoạch khuyến mãi đã xác nhận, hệ số đã duyệt | Chỉ phần thời gian khuyến mãi được nhân hệ số; không có kế hoạch thì dự báo cuối = dự báo nền | Kế hoạch chưa xác nhận hoặc hệ số chưa đủ căn cứ: giữ nền hoặc tạo bản tham khảo cần duyệt | Dự báo cuối, phần tăng/giảm, hệ số và trạng thái áp dụng | 16, 17, 20 |
| 15 | Tồn sử dụng được, cam kết, lô đang về, ngày có thể sử dụng, độ chắc chắn | Lập lịch nguồn hàng; tách tồn ngay, lô chắc chắn và lô bị loại; không trừ dự báo ở chặng này | Nguy cơ tính trùng, thiếu nguồn hoặc lô chưa xác nhận: chờ kiểm tra, không phát hành tự động | Lượng có thể sử dụng và lịch hàng về, lead time | 16, 17, 19, 20 |
| 16 | Dự báo cuối, sai số, lead time, mức phục vụ tối thiểu, trưng bày/hạn dùng/sức chứa | Tính dự trữ theo sai số và lead time; mức bảo vệ là mức đáp ứng đồng thời dự trữ, trưng bày và ràng buộc đã duyệt | Không mức phục vụ nào khả thi hoặc thiếu sai số/lead time: chính sách chưa khả thi/cần duyệt | Mức phục vụ, dự trữ an toàn, mức cần bảo vệ | 17, 19, 20 |
| 17 | Dự báo vùng bao phủ, nguồn hàng theo thời gian, mức bảo vệ, MOQ/quy cách | `Q_raw = max(0, nhu cầu vùng bao phủ + mức bảo vệ - nguồn sử dụng được)`; làm tròn theo MOQ/quy cách và lưu phần dư | Thiếu dữ liệu mua, dư vượt ngưỡng, hạn dùng/sức chứa không đạt: cần duyệt | Số cần mua trước ngân sách, số sau quy cách, phần dư và rủi ro | 18, 19, 20 |
| 18 | Đề xuất Chặng 17, ngân sách, giá mua, ưu tiên, ngày hết hàng | Phân bổ theo rổ/thứ tự ưu tiên đã duyệt; giữ bội số mua; không sửa dự báo, mức bảo vệ hay MOQ | Thiếu giá/ngân sách hoặc phương án không khả thi: hoãn/cần duyệt | Số được cấp tiền, số bị hoãn, ngân sách còn lại và lý do | 19, 20 |
| 19 | Số được cấp tiền và toàn bộ ngoại lệ Chặng 16–18 | Số cuối bắt đầu từ số được cấp; chỉ thay đổi qua quyết định có người, lý do, version; đây là chặng duy nhất phát hành/dừng | Còn ngoại lệ chặn hoặc thiếu người duyệt: chờ duyệt/chưa thể phát hành | Số mua cuối, trạng thái phát hành, người duyệt và phiên bản | 20 |
| 20 | Snapshot đã chốt, dự báo nền/cuối, bán thực tế, tồn, giao hàng và phát hành | RMSE, nRMSE, WAPE, Bias; đo thiếu hàng, dư tồn, vốn giữ, lead time; phân rã sai lệch theo nguồn | Chưa có thực tế hậu kiểm: chưa đánh giá; chỉ đề xuất cho phiên sau, không hồi tố | Kết quả thực tế, nguyên nhân và đề xuất phiên kế tiếp | Kỳ sau |

## Sai khác đã xác định trước khi sửa mã

1. Runtime hiện đăng ký 19 processor: Chặng 5 đang vừa lấp ngày vừa gom chu kỳ; Chặng 6–19 tương ứng Chặng 7–20 của tài liệu.
2. `StageNumber`, store, trace, formula registry, journey map, test và nhãn UI đều đang khóa ở 19.
3. `devlog-lab` là mô phỏng riêng 1–12 trên dữ liệu giả; không được dùng để tuyên bố dashboard chính đã hoàn thành hoặc thay cho runtime dataset hiện tại.
4. Tài liệu có mâu thuẫn nội bộ tại bảng rủi ro dòng nói Chặng 6 lấp nền, trong khi mục chi tiết Chặng 6 và prompt cấm việc đó. Thực thi theo mục chi tiết: Chặng 5 lấp, Chặng 6 chỉ cộng.
5. Dữ liệu vận hành đầy đủ cho nguồn hàng, ngân sách, phê duyệt và thực tế hậu kiểm chưa phải lúc nào cũng có; các chặng 15–20 phải hiển thị đúng trạng thái thiếu căn cứ thay vì dựng số thật giả.
