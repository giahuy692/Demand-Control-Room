/** Sơ đồ hành trình tổng thể — chép nguyên văn từ mục 2, "Tài liệu giải pháp - Demand Planning & Replenishment Governance.md". */
export const JOURNEY_DIAGRAM = `flowchart TD
    ST(["Bắt đầu phiên lập kế hoạch"])

    Q0{"Đến ngày chạy kế hoạch theo lịch chu kỳ chưa?"}
    X0["Không chạy phiên"]
    FIN0(["Kết thúc kiểm tra lịch"])

    D1[/"Lấy dữ liệu bán lẻ đã chuẩn hóa
SKU − nơi bán − ngày − số bán ghi nhận trong ngày − mã/vùng CTKM nếu có − kế hoạch CTKM − tồn đầu − tồn cuối − phiếu nhập để bán đầu tiên"/]
    D2[/"Lấy kế hoạch CTKM tương lai đã xác nhận"/]
    D3[/"Lấy dữ liệu nguồn hàng: tồn hiện tại − lô đang về − ETA − cam kết − số lượng mua tối thiểu"/]

    subgraph P1["PHA 1 − CLEAN DATA VÀ TẠO SỨC MUA CƠ BẢN"]
        S1_HISTORY["1. Xác định khoảng lịch sử theo lịch ngày của phiên"]
        S2_STOCKOUT_FLAG["2. Đánh dấu stockout bằng tồn đầu, tồn cuối và phiếu nhập để bán đầu tiên"]
        S3_STOCKOUT_BASE["3. Xác định sức mua cơ bản sau xử lý stockout cho ngày không CTKM"]
        S4_PROMO_BASE["4. Xử lý ngày CTKM và đưa về mức bán tự nhiên"]
        S5_CHECK_CYCLE{"5. Chu kỳ cần lấp nền không?"}
        S5_FILL_BASE["5A. Lấp nền cho ngày thiếu hoặc ngày chưa đủ căn cứ"]
        S5_NO_FILL["5B. Không cần lấp nền khi đã đủ 15 ngày nền"]
        S5_AGG_CYCLE["5C. Gom 15 ngày thành sức mua cơ bản chu kỳ"]
        S1_HISTORY --> S2_STOCKOUT_FLAG --> S3_STOCKOUT_BASE --> S4_PROMO_BASE --> S5_CHECK_CYCLE
        S5_CHECK_CYCLE -- "Có" --> S5_FILL_BASE --> S5_AGG_CYCLE
        S5_CHECK_CYCLE -- "Không" --> S5_NO_FILL --> S5_AGG_CYCLE
    end

    subgraph P2["PHA 2 − PHÂN LOẠI VÀ GÁN CHÍNH SÁCH"]
        S6_ABC["6. Phân loại ABC theo giá trị tiêu thụ"]
        S7_XYZ["7. Phân loại XYZ/D theo độ đều và độ thưa"]
        S8_POLICY["8. Gán chính sách vận hành theo ABC/XYZ và vai trò danh mục"]
        S6_ABC --> S8_POLICY
        S7_XYZ --> S8_POLICY
    end

    subgraph P3["PHA 3 − NHẬN DIỆN CẤU TRÚC NHU CẦU, DỰ BÁO NỀN VÀ ÁP HỆ SỐ KM"]
        S11_ROUTER["11. Chọn nhánh mô hình dự báo nền theo nhóm X/Y/Z/D"]
        Q11_GROUP{"Nhóm nhu cầu sau Chặng 7 là gì?"}

        S9_Y["9. Chỉ nhóm Y: kiểm tra mùa vụ"]
        S10_Y["10. Chỉ nhóm Y: kiểm tra xu hướng và công tắc mô hình"]
        Q11_Y_SEASON{"Nhóm Y có mùa vụ đủ căn cứ?"}
        Q11_Y_TREND{"Nhóm Y có xu hướng đủ căn cứ?"}

        S11_X["11X. Nhóm X: SES hoặc Holt"]
        S11_Y_HW["11Y. Nhóm Y có mùa vụ: Holt-Winters"]
        S11_Y_HOLT["11Y. Nhóm Y không mùa vụ nhưng có xu hướng: Holt"]
        S11_Y_SES["11Y. Nhóm Y không mùa vụ, không xu hướng: SES hoặc nền ổn định"]
        S11_Z["11Z. Nhóm Z: Croston hoặc nhịp phát sinh"]
        S11_D["11D. Nhóm D: kế hoạch MD hoặc mượn mã tương tự"]
        S11_BACKTEST["11. Kiểm tra ngược và khóa dự báo nền"]

        S12_PROMO_LEARN["12. Xác định hệ số KM từ CTKM lịch sử"]
        S13_PROMO_APPLY["13. Áp kế hoạch CTKM tương lai bằng hệ số KM"]

        S11_ROUTER --> Q11_GROUP
        Q11_GROUP -- "Nhóm X" --> S11_X --> S11_BACKTEST
        Q11_GROUP -- "Nhóm Y" --> S9_Y --> S10_Y --> Q11_Y_SEASON
        Q11_Y_SEASON -- "Có" --> S11_Y_HW --> S11_BACKTEST
        Q11_Y_SEASON -- "Không" --> Q11_Y_TREND
        Q11_Y_TREND -- "Có" --> S11_Y_HOLT --> S11_BACKTEST
        Q11_Y_TREND -- "Không" --> S11_Y_SES --> S11_BACKTEST
        Q11_GROUP -- "Nhóm Z" --> S11_Z --> S11_BACKTEST
        Q11_GROUP -- "Nhóm D" --> S11_D --> S11_BACKTEST
        S11_BACKTEST --> S13_PROMO_APPLY
        S12_PROMO_LEARN --> S13_PROMO_APPLY
    end

    subgraph P4["PHA 4 − NGUỒN HÀNG"]
        S14_SOURCE["14. Dựng lịch nguồn hàng và vị thế tồn"]
    end

    subgraph P5["PHA 5 − DỰ TRỮ VÀ SỐ CẦN MUA"]
        S15_SAFETY["15. Tính tồn kho an toàn"]
        S16_ORDER_RAW["16. Tính số đặt chưa xét ngân sách và làm tròn số lượng mua tối thiểu"]
        S15_SAFETY --> S16_ORDER_RAW
    end

    subgraph P6["PHA 6 − NGÂN SÁCH, PHÁT HÀNH VÀ HỌC LẠI"]
        S17_BUDGET["17. Phân bổ ngân sách khi vốn bị giới hạn"]
        S18_RELEASE["18. Duyệt ngoại lệ và phát hành số đặt"]
        S19_REVIEW["19. Đo kết quả và tạo đề xuất kỳ sau"]
        S17_BUDGET --> S18_RELEASE --> S19_REVIEW
    end

    ST --> Q0
    Q0 -- "Không" --> X0 --> FIN0
    Q0 -- "Có" --> D1 --> S1_HISTORY
    Q0 -- "Có" --> D2 --> S13_PROMO_APPLY
    Q0 -- "Có" --> D3 --> S14_SOURCE

    S5_AGG_CYCLE --> S6_ABC
    S5_AGG_CYCLE --> S7_XYZ
    S5_AGG_CYCLE --> S11_ROUTER
    S5_AGG_CYCLE --> S12_PROMO_LEARN
    S8_POLICY --> S11_ROUTER
    S8_POLICY --> S12_PROMO_LEARN
    S13_PROMO_APPLY --> S15_SAFETY
    S14_SOURCE --> S15_SAFETY
    S15_SAFETY --> S16_ORDER_RAW
    S16_ORDER_RAW --> S17_BUDGET
    S19_REVIEW --> FIN(["Kết thúc vòng lập kế hoạch"])
`;
