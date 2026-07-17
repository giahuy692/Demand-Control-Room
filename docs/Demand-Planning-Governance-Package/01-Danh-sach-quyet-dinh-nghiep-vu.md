# Danh sách quyết định nghiệp vụ

## 1. Quy ước trạng thái

| Trạng thái | Ý nghĩa |
|---|---|
| `ĐÃ KHÓA` | Được phép dùng làm nguồn sự thật để code và kiểm thử. |
| `ĐỀ XUẤT` | Có phương án cụ thể nhưng cần người có thẩm quyền duyệt trước khi vận hành. |
| `CHỜ DỮ LIỆU` | Chưa đủ dữ liệu thật để kết luận. |
| `KHÔNG ÁP DỤNG HIỆN TẠI` | Chưa thuộc phạm vi phiên kiểm thử lịch sử. |

## 2. Quyết định đã khóa

| Mã | Quyết định | Trạng thái |
|---|---|---|
| DEC-001 | SQL chỉ lấy dữ liệu thật có trong DB; không tạo lịch ngày liên tục. | ĐÃ KHÓA |
| DEC-002 | Module Demand Planning tạo lịch ngày, ghép dữ liệu nguồn và chia chu kỳ 15 ngày. | ĐÃ KHÓA |
| DEC-003 | Tồn đầu ngày hiện tại bằng tồn cuối ngày trước. | ĐÃ KHÓA |
| DEC-004 | Tồn cuối được tính từ tồn đầu cộng nhập, trả và trừ xuất, bán. | ĐÃ KHÓA |
| DEC-005 | `OpenStock`/`CloseStock` là dữ liệu tính từ phát sinh thật, không phải nền ước lượng. | ĐÃ KHÓA |
| DEC-006 | Ngày không có dòng POS không tự động được hiểu là bán bằng 0. | ĐÃ KHÓA |
| DEC-007 | `null`, số 0 thật và không áp dụng là ba trạng thái khác nhau. | ĐÃ KHÓA |
| DEC-008 | Phiên hiện tại là `HISTORICAL_VALIDATION`; không có kế hoạch CTKM tương lai thật. | ĐÃ KHÓA |
| DEC-009 | Chặng 13 giữ dự báo cuối bằng dự báo nền khi không có kế hoạch CTKM tương lai đã xác nhận. | ĐÃ KHÓA |
| DEC-010 | ABC chính thức chỉ được khóa khi chạy toàn danh mục hoặc dùng snapshot ABC đã duyệt. | ĐÃ KHÓA |
| DEC-011 | XYZ/D có thể mô phỏng trên tập SKU nhỏ, nhưng phải ghi rõ chất lượng chuỗi nền và phạm vi chạy. | ĐÃ KHÓA |
| DEC-012 | “Đã chạy”, “đã đánh giá”, “đã khóa”, “bị chặn” và “không áp dụng” là các trạng thái riêng. | ĐÃ KHÓA |
| DEC-013 | CTKM thường trực/chính sách giá thường xuyên chỉ được loại khỏi Chặng 4 bằng danh sách chính sách đã duyệt; SQL không tự loại. | ĐÃ KHÓA |
| DEC-014 | CTKM lịch sử phải được cấp cho module dưới dạng khoảng hiệu lực để ngày không có giao dịch vẫn được nhận diện là ngày CTKM. | ĐÃ KHÓA |
| DEC-015 | Ngày vừa được lấp nền không được dùng làm tham chiếu để lấp ngày khác trong cùng phiên. | ĐÃ KHÓA |
| DEC-016 | SKU tương tự/cửa hàng tương đồng do hệ thống đề xuất nhưng phải có phê duyệt trước khi dùng làm nguồn chính thức. | ĐÃ KHÓA |
| DEC-017 | Sau Chặng 5 phải đánh giá riêng tính hợp lệ và tính liên tục của chuỗi trước khi cho từng chặng sau sử dụng. | ĐÃ KHÓA |
| DEC-018 | Chu kỳ được phép dùng phải đủ 15 ngày lịch, `CycleBaseDemand` khác `null`, `unresolvedDays=0`, có trạng thái `LOCKED_*` và giá trị không âm. | ĐÃ KHÓA |
| DEC-019 | Giá trị chu kỳ bằng 0 là hợp lệ khi đã được xác nhận và khóa; `CycleBaseDemand >= 0` chỉ là điều kiện cần, không phải điều kiện đủ. | ĐÃ KHÓA |
| DEC-020 | Không được bỏ chu kỳ lỗi/trống rồi nối các chu kỳ còn lại để tính ABC, ADI, CV², xu hướng, mùa vụ hoặc dự báo. | ĐÃ KHÓA |
| DEC-021 | SKU lâu năm có nền chưa giải quyết hoặc cửa sổ chu kỳ không liên tục phải có `DemandClass=null` và `CLASSIFICATION_BLOCKED`; không gán D. | ĐÃ KHÓA |
| DEC-022 | Nhóm D chỉ áp dụng cho SKU mới hoặc lịch sử thật sự ngắn, sau khi xác nhận extract không bị cắt và toàn bộ chu kỳ hoạt động đang có đã được giải quyết. | ĐÃ KHÓA |
| DEC-023 | Cửa hàng tham chiếu là cửa hàng khác bán cùng SKU, có chuỗi sạch và hệ số quy đổi đã được duyệt; đây là nguồn đối chứng, không phải cửa hàng bất kỳ. | ĐÃ KHÓA |
| DEC-024 | AI chỉ đề xuất SKU tương tự; hệ thống không tự áp dụng nếu chưa có phê duyệt SKU tham chiếu, hệ số quy đổi và thời hạn hiệu lực. | ĐÃ KHÓA |
| DEC-025 | Kế hoạch MD là đầu vào dự báo tương lai cho SKU mới/không thể tự học; không mặc định dùng để lấp ngày lịch sử. Nền lịch sử thủ công là loại ngoại lệ riêng. | ĐÃ KHÓA |

## 3. Quyết định cấu hình đề xuất

Các nội dung dưới đây được thiết kế thành tham số để có thể code và backtest, nhưng chưa được coi là ngưỡng vận hành chính thức.

| Mã | Đề xuất | Giá trị khởi điểm | Trạng thái |
|---|---|---:|---|
| DEC-P01 | Vùng đọc tham chiếu trước khung xử lý | 24 ngày | ĐỀ XUẤT |
| DEC-P02 | Số ngày tham chiếu sạch tối thiểu | 3 ngày | ĐÃ CÓ TRONG GIẢI PHÁP, CẦN BACKTEST |
| DEC-P03 | Chu kỳ có 12–14 ngày nền hợp lệ được phép lấp từ mức đại diện chu kỳ | Bật, có log | ĐỀ XUẤT |
| DEC-P04 | Chu kỳ có 8–11 ngày nền hợp lệ | Chỉ lấp khi dữ liệu trải ít nhất 2/3 đoạn và chuyển `REVIEW_REQUIRED` | ĐỀ XUẤT |
| DEC-P05 | Chu kỳ có 1–7 ngày nền | Không dùng chính chu kỳ làm nguồn duy nhất | ĐỀ XUẤT |
| DEC-P06 | Tỷ lệ ngày ước lượng tối đa để chu kỳ được học tự động | Cấu hình theo nhóm chất lượng | ĐỀ XUẤT |
| DEC-P08 | Số chu kỳ liên tiếp tối thiểu cho ABC | Dùng ngưỡng hiện hành của Chặng 6, mặc định 6 | ĐỀ XUẤT CẦN BACKTEST |
| DEC-P09 | Cửa sổ XYZ chuẩn | 24 vị trí chu kỳ liên tiếp; không được nén khoảng trống | ĐÃ KHÓA VỀ NGUYÊN TẮC, NGƯỠNG 24 THEO CHÍNH SÁCH HIỆN HÀNH |
| DEC-P07 | CTKM chiến dịch nối tiếp gần như liên tục | Không tự coi là nền thường; chuyển `BASELINE_NOT_IDENTIFIABLE` nếu thiếu nguồn đối chứng | ĐỀ XUẤT |

## 4. Nội dung chờ dữ liệu hoặc ngoài phạm vi

| Mã | Nội dung | Trạng thái |
|---|---|---|
| DEC-W01 | Một database POS tương ứng một nơi bán hay nhiều nơi bán. | CHỜ DỮ LIỆU |
| DEC-W02 | Có mốc tồn gốc/snapshot để đối soát cộng dồn hay lịch sử phát sinh đủ từ 0. | CHỜ DỮ LIỆU |
| DEC-W03 | Trạng thái POS theo ngày để xác nhận “không có dòng = bán 0 thật”. | CHỜ DỮ LIỆU |
| DEC-W04 | Nguồn kế hoạch CTKM tương lai. | KHÔNG ÁP DỤNG HIỆN TẠI |
| DEC-W05 | Nguồn ngân sách, MOQ, nhà cung cấp, ETA để kiểm thử Chặng 14–18. | KHÔNG ÁP DỤNG HIỆN TẠI |

## 5. Mâu thuẫn tài liệu ↔ triển khai chờ duyệt (rà soát 2026-07-17)

Các mục dưới đây được phát hiện khi đối chiếu engine với `Tài liệu giải pháp - Demand Planning & Replenishment Governance.md`. Theo protocol của `00-README-Nguon-su-that.md`: chưa mục nào được coi là hành vi vận hành chính thức cho tới khi người có thẩm quyền duyệt; engine giữ nguyên hành vi hiện tại (đang bị acceptance gate khóa) trong lúc chờ.

| Mã | Nội dung mâu thuẫn | Tài liệu giải pháp quy định | Engine hiện tại | Trạng thái |
|---|---|---|---|---|
| DEC-R01 | Chặng 3 §7 (và Chặng 5 §7): công thức nền ngày thiếu hàng | `Sức mua cơ bản = max(Số bán ghi nhận, Mức nền tham chiếu)` — "Chặng 3 không làm giảm số bán thật" | Dùng median thuần, KHÔNG max; trace ghi rõ "không dùng max(sales, median)" và bị test acceptance khóa. Ngày stockout có sales cao hơn median sẽ bị GIẢM so với số bán thật | CHỜ DUYỆT |
| DEC-R02 | Chặng 13 §6: cách chốt hệ số K áp dụng | KHÔNG lấy trung bình/trung vị các hệ số; chọn mẫu KM tương tự GẦN NHẤT đủ căn cứ (`K_approved = K_{j*}`), mẫu cũ chỉ làm bối cảnh | `promoFactor = median(K các vùng đủ điều kiện)`; chưa có "biên chính sách" khi tự động | CHỜ DUYỆT |
| DEC-R03 | Chặng 2 §3 điều kiện 2: đánh dấu thiếu hàng cả ngày | Tồn đầu = 0 VÀ tồn cuối = 0 VÀ **số bán = 0** | Chỉ kiểm tồn đầu = 0 và tồn cuối = 0, KHÔNG kiểm số bán → ngày nhập-bán hết trong ngày (sales > 0) vẫn bị đánh ALL_DAY_STOCKOUT_CANDIDATE và bị Chặng 3 thay sales thật bằng median | CHỜ DUYỆT |
| DEC-R04 | Chặng 2: phạm vi trạng thái ngoài 2 trường hợp tài liệu cho phép | "Các trường hợp không thuộc hai điều kiện trên thì Chặng 2 không đánh dấu thiếu hàng" | Engine thêm DEPLETION_REVIEW (tồn đầu > 0, cuối = 0) và NEGATIVE_STOCK_REVIEW, và Chặng 3 nâng nền cả các ngày này (thay sales thật bằng median) thay vì chỉ ghi nhận cần xem xét | CHỜ DUYỆT |
| DEC-R05 | Chặng 5 §6: cắt phía dư để cân bằng trước/sau khi lấp ngày thiếu dữ liệu | "nếu có 5 ngày trước và 3 ngày sau, chỉ lấy 3 ngày trước gần nhất và 3 ngày sau" | `technicalReferences` lấy tối đa 14 ngày sạch GẦN NHẤT bất kể phía, không cắt phía dư | CHỜ DUYỆT |
| DEC-R06 | RULE-05-003 / GT-18, GT-19: lấp Tầng 2 theo mức đại diện chu kỳ | 04-Dac-ta §8 mô tả đầy đủ ngưỡng 12-14/8-11/1-7/0; 07-Golden-Test yêu cầu GT-18 "lấp 1 ngày, LOCKED_ADJUSTED", GT-19 "lấp theo cấu hình, ít nhất LOCKED_WITH_REVIEW" | Tầng 2 CHƯA được cài đặt: cờ `enableTier2CycleFallback` là tham số chết, `tier2Filled` luôn false. GT-18/GT-19 hiện CHƯA ĐẠT (spec test đã đổi tên phản ánh đúng). Hành vi hiện tại = tắt vĩnh viễn, trùng với trạng thái DEC-P03/P04/P05 chưa duyệt | CHỜ DUYỆT |
| DEC-R07 | Chặng 3 §6.2: vùng đệm tham chiếu ngoài khung phiên | Được đọc ngày sạch ngoài khung phiên để cân bằng nền | Vùng đọc đã nạp (`isReferenceOnly`) nhưng CHƯA nối vào tìm kiếm tham chiếu Chặng 3–5 (giới hạn đã log ở Chặng 1, DEC-P01 ĐỀ XUẤT) | CHỜ DUYỆT |
