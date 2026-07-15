import { StageNumber } from './models';

export interface StageTraceContract {
  purpose: string;
  inputs: readonly string[];
  rules: readonly string[];
  outputs: readonly string[];
  controls: readonly string[];
  documentCoverage: readonly string[];
}

/**
 * Hợp đồng nội dung của panel MÔ PHỎNG TÍNH TOÁN.
 * Mỗi mục được đối chiếu trực tiếp với các tiểu mục của Chặng 1–19 trong tài liệu giải pháp.
 * Phần này mô tả chuẩn nghiệp vụ; stage-trace.ts chịu trách nhiệm thế số bằng snapshot thực tế.
 */
export const STAGE_TRACE_CONTRACTS: Readonly<Record<StageNumber, StageTraceContract>> = {
  1: {
    purpose: 'Khóa đúng khoảng lịch sử và lịch chu kỳ cố định của phiên trước khi bất kỳ SKU nào được làm sạch hoặc học mô hình.',
    inputs: ['Ngày chạy kế hoạch và số năm lịch sử chuẩn', 'Độ dài chu kỳ M (mặc định 15 ngày)', 'Dữ liệu bán, tồn và CTKM đã được POS/ERP chốt'],
    rules: ['D_start là 01/01 của năm gốc lùi số năm cấu hình; D_end là ngày trước phiên', 'Dựng đủ lịch ngày rồi chia chu kỳ, không đếm bản ghi SKU để tạo lịch', 'Mốc 3 năm là khuyến nghị cho mùa vụ, không phải điều kiện loại SKU mới'],
    outputs: ['Khoảng lịch sử D_start–D_end', 'Lịch ngày và chu kỳ 15 ngày', 'Số chu kỳ đủ ngày, ngày dư và dữ liệu SKU đã gắn lịch'],
    controls: ['Không biến ngày thiếu bản ghi thành bán bằng 0', 'Không lấp chu kỳ trống ở Chặng 1', 'Chưa xử lý stockout hoặc CTKM tại đây'],
    documentCoverage: ['§1–3 Vấn đề, lý do, điều kiện', '§4–8 Hành động, biến chuẩn, quy tắc ngày và mốc 3 năm', '§9–11 Hiệu quả, rẽ nhánh, flowchart', '§12 Đầu ra bàn giao'],
  },
  2: {
    purpose: 'Đánh dấu ngày doanh số có thể bị kéo thấp vì không còn hàng thực sự để bán.',
    inputs: ['Tồn đầu O và tồn cuối C', 'Giờ phiếu nhập để bán đầu tiên h', 'Số bán ghi nhận Q theo SKU–nơi bán–ngày'],
    rules: ['Stockout nếu O=0, C>0 và h sau giờ cắt', 'Hoặc stockout nếu O=0, C=0 và Q=0', 'Chỉ dùng hai điều kiện đã ban hành, không thêm heuristic theo loại SKU'],
    outputs: ['Cờ stockout theo ngày', 'Lý do nhập trễ hoặc trống cả ngày', 'Dữ liệu tồn/phiếu nhập làm bằng chứng kiểm toán'],
    controls: ['Không tự nâng nền ở Chặng 2', 'Không suy diễn thiếu hàng chỉ từ doanh số thấp'],
    documentCoverage: ['§1 Mục tiêu', '§2 Dữ liệu cần dùng', '§3–4 Quy tắc và cách hiểu vận hành', '§5 Flowchart', '§6 Đầu ra'],
  },
  3: {
    purpose: 'Tạo sức mua cơ bản cho ngày không CTKM, đặc biệt là ngày stockout có số bán thấp giả.',
    inputs: ['Cờ stockout Chặng 2', 'Số bán ghi nhận Q', 'Ngày sạch không CTKM/stockout/lấp kỹ thuật quanh ngày cần xử lý'],
    rules: ['Ngày CTKM phải chuyển sang Chặng 4', 'Tìm tham chiếu ±7 ngày, mở rộng tối đa ±24; ưu tiên 2+2 cân bằng', 'Nền R dùng trung vị; B=max(Q,R), không làm giảm số bán thật', 'Thiếu tối thiểu số ngày tham chiếu thì giữ trạng thái thiếu căn cứ'],
    outputs: ['Sức mua cơ bản ngày không CTKM', 'Mức nền và danh sách ngày tham chiếu', 'Trạng thái cân bằng/tạm/thiếu căn cứ'],
    controls: ['Ngày lấp kỹ thuật không được làm nguồn sạch', 'Giữ Q gốc và toàn bộ lý do chọn tham chiếu', 'Nền chưa cân bằng phải được Chặng 5/19 nhận biết'],
    documentCoverage: ['§1–4 Vấn đề, mục tiêu, điều kiện, loại CTKM', '§5–8 Tham chiếu, tìm nền, công thức, kiểm tra lại', '§9–11 Ví dụ, bảng quyết định, flowchart', '§12 Đầu ra'],
  },
  4: {
    purpose: 'Loại tác động CTKM khỏi chuỗi nền bằng cách đưa ngày CTKM về mức bán tự nhiên.',
    inputs: ['Mã/vùng CTKM và số bán quan sát', 'Ngày sạch trước/sau vùng CTKM', 'Cờ stockout và trạng thái nền từ Chặng 2–3'],
    rules: ['Xử lý theo cả vùng CTKM; chỉ gộp cụm khi dùng chung tập nền hợp lệ', 'Nền tự nhiên dùng trung vị tham chiếu sạch', 'Không dùng max(Q,R): số bán CTKM không được kéo nền lên', 'Vùng thiếu căn cứ phải giữ trạng thái và log kiểm toán'],
    outputs: ['Sức mua tự nhiên của ngày CTKM', 'Ranh giới vùng/cụm và tập tham chiếu', 'Q quan sát riêng để Chặng 12 học hệ số'],
    controls: ['Ngày CTKM đã chuẩn hóa không trở thành nguồn sạch', 'Lưu log vùng, mã CTKM, Q gốc và lý do gộp', 'Không cố phục hồi toàn bộ doanh số có thể xảy ra'],
    documentCoverage: ['§1–4 Vấn đề, mục tiêu, điều kiện, nguyên tắc nền', '§5–8 Ngày sạch, vùng CTKM, mức tự nhiên, nền chưa cân bằng', '§9–11 Bảng quyết định, ví dụ, flowchart', '§12–13 Log và đầu ra'],
  },
  5: {
    purpose: 'Quyết định có lấp phần nền còn thiếu hay không và tổng hợp chuỗi sức mua cơ bản theo chu kỳ.',
    inputs: ['Sức mua cơ bản ngày sau Chặng 3–4', 'Nhãn nguồn clean/stockout/promo/insufficient', 'Lịch chu kỳ cố định Chặng 1'],
    rules: ['Chu kỳ trống theo tài liệu nghĩa là 0 ngày có nền, không đồng nghĩa 0 ngày có bản ghi nguồn; chu kỳ này không được lấp toàn bộ', 'Chu kỳ có ngày đủ nền mới được xét lấp từng ngày thiếu bằng trung vị nguồn sạch', 'Chỉ khóa chu kỳ khi không còn ngày unresolved và không phải empty', 'Y_j là tổng B_t, không cộng sales CTKM thô'],
    outputs: ['Sức mua cơ bản Y_j theo chu kỳ', 'Trạng thái locked/empty/unresolved và phân biệt NO_SOURCE_RECORD với BASELINE_UNRESOLVED', 'Số ngày nguồn, ngày sạch, nâng nền, chuẩn hóa CTKM và lấp kỹ thuật'],
    controls: ['Ngày lấp không làm nguồn tham chiếu cho lần sau', 'Kế thừa cờ nền chưa cân bằng', 'Chỉ chu kỳ khóa mới đi vào phân loại và dự báo'],
    documentCoverage: ['§1–4 Vấn đề, mục tiêu, điều kiện, cột chuẩn', '§5–9 Quy tắc cộng, nguồn lấp, loại chu kỳ, tìm nền, kế thừa cờ', '§10–12 Tổng hợp, ví dụ, flowchart', '§13 Đầu ra'],
  },
  6: {
    purpose: 'Xếp hạng SKU theo giá trị tiêu thụ đã làm sạch để phân biệt mức quan trọng tài chính.',
    inputs: ['Tối đa 24 chu kỳ Y_j đã khóa', 'Đơn giá chuẩn P', 'Danh mục SKU cùng phạm vi xếp hạng'],
    rules: ['Dưới 6 chu kỳ không xếp tự động', 'Năm hóa bằng a_N=1 khi đủ 24, hoặc 24/N khi có 6–23', 'V_năm=Q_năm×P; xếp giảm dần, tính tỷ trọng và lũy kế', 'A đến vùng 80%, C từ 90%, phần giữa là B; giữ ngoại lệ SKU đầu vượt 80%'],
    outputs: ['Nhãn ABC, hạng và tỷ trọng lũy kế', 'Q_năm, V_năm và hệ số năm hóa', 'Trạng thái N/A nếu thiếu dữ liệu'],
    controls: ['Năm hóa chỉ để so sánh ABC, không phải dự báo', 'Không cho SKU N/A vào mẫu số tổng giá trị', 'Lưu căn cứ và phiên xếp hạng'],
    documentCoverage: ['§1–5 Mục tiêu, tiêu chí, giá trị, kỳ dữ liệu, mục đích', '§6–8 Quy trình 8 bước, điểm cắt, kiểm tra', '§9–11 Ví dụ, chính sách, flowchart', '§12 Đầu ra'],
  },
  7: {
    purpose: 'Phân loại nhịp nhu cầu thành đều, dao động, bán thưa hoặc thiếu dữ liệu bằng XYZ/D.',
    inputs: ['Chuỗi Y_j đã khóa', 'n chu kỳ và m chu kỳ có nhu cầu dương'],
    rules: ['n<6 hoặc m=0 → D', 'ADI=n/m; ADI>1,32 → Z', 'Với nhánh còn lại, tính μ và σ quần thể chỉ trên chu kỳ dương', 'CV=σ/μ; CV²≤0,49 → X, còn lại → Y'],
    outputs: ['Nhãn X/Y/Z/D', 'n, m, ADI, μ, σ, CV và CV²', 'Lý do rẽ nhánh đã khóa'],
    controls: ['Thứ tự xét D → Z → X/Y là bắt buộc', 'Không dùng độ lệch chuẩn mẫu', 'Không hồi tố chuỗi Y_j đã khóa'],
    documentCoverage: ['§1–3 Ngữ cảnh, mục tiêu, tổng quan', '§4.4.1–4.4.9 Quy trình và công thức XYZ/D', '§5 Hướng dẫn/khắc phục', '§6 Đầu ra và không hồi tố'],
  },
  8: {
    purpose: 'Biến nhãn ABC và XYZ/D thành chính sách vận hành có thể thực thi.',
    inputs: ['Nhãn ABC Chặng 6', 'Nhãn XYZ/D Chặng 7', 'Vai trò danh mục và bảng chính sách được duyệt'],
    rules: ['Ghép X/Y/Z vào ma trận 9 ô', 'Nhóm D hoặc N/A đi chính sách riêng', 'Gán mức phục vụ và ưu tiên vốn theo đúng ô', 'Vai trò danh mục chỉ điều chỉnh sau ma trận và phải có lý do/phê duyệt'],
    outputs: ['Ô chính sách và phiên bản', 'Mức phục vụ mục tiêu', 'Ưu tiên vốn và điều kiện ngoại lệ'],
    controls: ['Không tính lại ABC/XYZ tại Chặng 8', 'Không gán mạnh chính sách ma trận cho nhóm D', 'Không hồi tố chính sách đã khóa'],
    documentCoverage: ['§1–3 Vấn đề, mục tiêu, dữ liệu', '§4–7 Ma trận, chính sách ô, nhóm D, vai trò danh mục', '§8–10 Quy trình, ví dụ, flowchart', '§11–12 Đầu ra và nguyên tắc khóa'],
  },
  9: {
    purpose: 'Xác nhận mùa vụ năm cho riêng nhóm Y bằng tín hiệu lặp lại theo cùng vị trí chu kỳ.',
    inputs: ['Nhãn Y đã khóa', 'Tối thiểu 48 chu kỳ Y_j khóa', 'Mùa 24 vị trí và thứ tự thời gian'],
    rules: ['Chỉ nhóm Y được xét', 'Chia các vòng đầy đủ 24 vị trí; không tự dùng phần lẻ', 'R_rp=Y_rp/trung bình vòng; S_p là trung bình R_rp', 'Chỉ kết luận cao/thấp khi vừa qua ngưỡng 1,15/0,85 vừa lặp ít nhất 67%'],
    outputs: ['Trạng thái confirmed/not-confirmed/insufficient/not-applicable', 'Hệ số và kết luận từng vị trí', 'Công tắc mở Holt-Winters cho Chặng 11'],
    controls: ['Không dùng sales ngày thô', 'Không nhận một đỉnh đơn lẻ là mùa vụ', 'Không sửa nhãn Y hoặc chuỗi Chặng 5'],
    documentCoverage: ['§1–4 Mục tiêu, không hồi tố, phạm vi, đầu vào', '§5–9 Các bước, công thức, bảng audit, kết luận vị trí/SKU', '§10 Ví dụ', '§11–12 Đầu ra và flowchart'],
  },
  10: {
    purpose: 'Xác định công tắc xu hướng cho nhóm Y chưa có mùa vụ rõ.',
    inputs: ['Nhóm Y và kết quả Chặng 9', '12 chu kỳ khóa gần nhất theo thời gian'],
    rules: ['Chia đúng 3 đoạn × 4 chu kỳ', 'Tính g1 và g2 giữa ba trung bình đoạn', 'Chỉ tăng/giảm khi cả hai cùng vượt ±5% về cùng phía', 'Giới hạn tốc độ dự phóng 15%; trên 25% phải review'],
    outputs: ['Trạng thái up/down/none/insufficient/not-applicable', 'g1, g2 và tốc độ đã chặn', 'Công tắc Holt hoặc SES cho Chặng 11'],
    controls: ['Bỏ qua nếu không phải Y hoặc đã confirmed mùa vụ', 'Không nhận một đoạn tăng đơn lẻ là xu hướng', 'Giữ lý do và cảnh báo giới hạn'],
    documentCoverage: ['§1–3 Vấn đề, mục tiêu, dữ liệu', '§4–7 Cách kiểm tra, kết luận, giới hạn, công tắc', '§8 Đầu ra', '§9 Flowchart'],
  },
  11: {
    purpose: 'Chọn, kiểm tra ngược và khóa mô hình dự báo nền đúng với cấu trúc X/Y/Z/D.',
    inputs: ['Chuỗi Y_j khóa và nhãn ABC–XYZ/D', 'Mùa vụ Chặng 9, xu hướng Chặng 10, chính sách Chặng 8', 'Ngưỡng sai số/khóa mô hình được phê duyệt'],
    rules: ['Giữ thứ tự thời gian; chia TRAIN/TEST, tối ưu chỉ trên TRAIN', 'X: SES/Holt; Y: Holt-Winters, Holt hoặc SES; Z: Croston/nhịp; D: kế hoạch MD/mã tương tự', 'Mọi X/Y phải thử cửa chu kỳ ngắn p=2…12 bằng Pearson trên TRAIN', 'Mô hình mới phải thắng chặt đối chứng trên TEST và qua ngưỡng nhóm mới được khóa'],
    outputs: ['Dự báo nền theo chu kỳ', 'Tên mô hình, tham số và trạng thái khóa', 'RMSE, nRMSE, WAPE, Bias và bằng chứng backtest', 'Nguồn của dự báo tương lai'],
    controls: ['Không tối ưu trên TEST', 'Không dùng Seasonal-naïve chỉ vì r(p) cao', 'Không tự khóa khi ngưỡng chính sách chưa ban hành', 'Không trả dự báo âm'],
    documentCoverage: ['§1–4 Vấn đề, mô hình, chuyển nhánh, quy trình chung', '§5–10 SES, Holt, Holt-Winters, Seasonal-naïve, Croston/nhịp, nhóm D', '§11–13 Backtest, bảng khóa, flowchart', '§14 Đầu ra'],
  },
  12: {
    purpose: 'Học mức tác động CTKM so với nền tự nhiên, không dự báo tương lai ở chặng này.',
    inputs: ['Vùng/mã/loại CTKM lịch sử', 'Q actual trong CTKM', 'Nền tự nhiên Chặng 4–5 và cờ stockout/chồng lấn/lấp nền'],
    rules: ['Chỉ gộp CTKM đủ tương tự về SKU/nhóm, loại, kênh, độ mạnh và thời lượng', 'K=ΣQ_actual/ΣY_base; nền ≤0 thì chặn', '0 mẫu: không tự động; 1–2: tham khảo; từ 3: lấy trung vị K', 'K<1 hoặc bất thường phải review; không đủ dữ liệu → manual/block'],
    outputs: ['Nhóm CTKM tương tự và mẫu đã dùng/loại', 'K đề xuất và số mẫu', 'AUTO_OK/REVIEW/MANUAL_ONLY/BLOCKED'],
    controls: ['Không trộn CTKM khác bản chất', 'Không học tự động từ vùng stockout nặng', 'Không bê nguyên doanh số CTKM lịch sử sang tương lai'],
    documentCoverage: ['§1 Vai trò', '§2–3 Đầu vào và nhóm tương tự', '§4–7 Công thức, cách đọc, chốt nhiều mẫu, tin cậy', '§8 Đầu ra'],
  },
  13: {
    purpose: 'Chuyển dự báo nền thành dự báo cuối bằng kế hoạch CTKM tương lai đã xác nhận.',
    inputs: ['F_base Chặng 11', 'K và trạng thái Chặng 12', 'Kế hoạch CTKM xác nhận và lịch chu kỳ 15 ngày'],
    rules: ['Không có kế hoạch → F_final=F_base', 'CTKM cả chu kỳ → F_base×K', 'CTKM một phần → chỉ nhân phần n/15', 'REVIEW/MANUAL_ONLY cần duyệt; BLOCKED giữ nền; chồng nhiều CTKM không tự nhân chồng'],
    outputs: ['F_final theo chu kỳ', 'Phần tăng/giảm do CTKM', 'K đã dùng và trạng thái áp'],
    controls: ['Không tự đoán CTKM tương lai', 'Không sửa F_base đã khóa', 'Gắn cảnh báo khi hệ số chưa đủ tin cậy'],
    documentCoverage: ['§1 Vai trò', '§2 Đầu vào', '§3 Công thức toàn phần/một phần', '§4–5 Rẽ nhánh và ví dụ', '§6 Đầu ra'],
  },
  14: {
    purpose: 'Tính lượng hàng thực sự còn tự do theo từng mốc thời gian và nhà cung cấp.',
    inputs: ['On-hand theo kho/kênh', 'Reserved/damaged/blocked và commitments', 'Lô inbound, trạng thái xác nhận, ETA, lead time, NCC'],
    rules: ['I_available=onhand−reserved−damaged−blocked', 'Chỉ cộng inbound xác nhận có ETA về kịp mốc', 'I_position,c=I_available,0+Inbound≤c−Commitment≤c', 'Quyết định nhập khẩu ưu tiên cấp SKU–NCC–toàn hệ thống'],
    outputs: ['Tồn khả dụng hiện tại', 'Lịch vị thế tồn và inbound theo ETA', 'Cam kết đã trừ, lead time và cảnh báo dữ liệu'],
    controls: ['Không cộng lô chưa đủ tin cậy', 'Không tính hàng hỏng/cách ly/chưa nhập kho là khả dụng', 'Giữ vị thế âm để thấy thiếu hụt thật'],
    documentCoverage: ['§1–2 Vai trò và bối cảnh', '§3–5 Khái niệm tồn, inbound, vị thế theo thời gian', '§6 Cấp tính', '§7 Đầu ra'],
  },
  15: {
    purpose: 'Tính lớp đệm bảo vệ trước sai số nhu cầu và biến động lead time.',
    inputs: ['F_final và độ bất định nhu cầu', 'Lead time trung bình/độ lệch', 'Mức phục vụ–Z, display minimum, hạn dùng/sức chứa'],
    rules: ['SS=Z×√(LTbar×σd²+Dbar²×σLT²) khi đủ dữ liệu', 'Thiếu sai số dùng độ lệch chuỗi nền; thiếu lead time dùng chính sách và hạ độ tin cậy', 'Nhóm D dùng mức bảo vệ thủ công có duyệt', 'Protection=max(SS,DisplayMin)'],
    outputs: ['SS và Protection', 'Z, Dbar, σd, LTbar, σLT và nguồn', 'Công thức đã dùng cùng cờ thiếu dữ liệu'],
    controls: ['Đồng nhất đơn vị ngày/chu kỳ', 'Không âm thầm cắt SS để vừa vốn, hạn dùng hay kho', 'Ràng buộc phải thành cảnh báo cho Chặng 18/19'],
    documentCoverage: ['§1–2 Vai trò và lý do', '§3–4 Công thức chính/thay thế', '§5–6 Mức phục vụ–Z và display minimum', '§7 Đầu ra'],
  },
  16: {
    purpose: 'Tính số cần mua trước ngân sách, sau khi bảo vệ nhu cầu và tuân thủ MOQ/quy cách.',
    inputs: ['F_final, vị thế tồn, Protection', 'Lead time + review period', 'MOQ, bước thùng, giá mua, NCC, hạn dùng, trạng thái mua'],
    rules: ['CoverWindow=LeadTime+ReviewPeriod', 'D_cover=ΣF_final trong vùng; Q_raw=max(0,D_cover+Protection−I_position)', 'Q_order làm tròn lên theo MOQ/bước thùng', 'Excess_MOQ=Q_order−Q_raw; dư lớn hoặc thiếu master phải cảnh báo'],
    outputs: ['Q_raw và Q_order', 'Giá trị đặt dự kiến', 'Dư do MOQ, vùng bao phủ và lý do không đặt'],
    controls: ['Chưa xét ngân sách ở Chặng 16', 'Không cắt lẻ sai quy cách', 'Không tự phát hành nếu thiếu NCC/giá/MOQ/trạng thái mua'],
    documentCoverage: ['§1–2 Vai trò và đầu vào', '§3–5 Vùng bao phủ, số cần đặt, MOQ', '§6–7 Ví dụ và nhánh xử lý', '§8 Đầu ra'],
  },
  17: {
    purpose: 'Phân bổ ngân sách hữu hạn mà không làm sai dự báo, tồn an toàn hoặc MOQ.',
    inputs: ['Q_order và giá trị đặt', 'Ngân sách kỳ', 'Ưu tiên vốn, rủi ro thiếu, vai trò danh mục, rủi ro MOQ/hạn dùng'],
    rules: ['Chia Rổ 1 phải mua, Rổ 2 nên mua, Rổ 3 có thể hoãn', 'Nếu tổng ≤ ngân sách thì cấp đủ; nếu thiếu thì theo rổ và thứ tự', 'Không cắt lẻ dưới MOQ; dòng chiến lược thiếu tiền chuyển duyệt vượt', 'Chưa có trọng số thì không tự bịa PriorityScore'],
    outputs: ['Q/V được cấp', 'Q bị hoãn/cắt và lý do', 'Rổ, hạng ưu tiên và yêu cầu vượt ngân sách'],
    controls: ['Không sửa F, SS hoặc Q_order', 'Giữ nguyên bội số MOQ', 'Lưu tác động ngân sách để hậu kiểm'],
    documentCoverage: ['§1–2 Vai trò và đầu vào', '§3–4 Ba rổ và điểm ưu tiên', '§5 Quy tắc cấp tiền', '§6 Đầu ra'],
  },
  18: {
    purpose: 'Là cổng cuối quyết định phát hành, chờ duyệt hay không phát hành.',
    inputs: ['Q được cấp và duyệt vượt nếu có', 'NCC, giá, MOQ/quy cách, ETA, trạng thái mua', 'Toàn bộ ngoại lệ từ Chặng 8–17'],
    rules: ['Q_final=Q_funded+Q_approved_over−Q_blocked', 'Q_final không âm, không vượt Q_order nếu không duyệt tăng và không phá MOQ', 'Thiếu master, vượt ngân sách, dư MOQ, tăng bất thường, hạn dùng, CTKM yếu hoặc cắt code phải phân luồng đúng', 'Mọi thay đổi của người duyệt phải lưu trước/sau, người và lý do'],
    outputs: ['Q_final và trạng thái release/review/no-release', 'Danh sách ngoại lệ và lý do', 'Quyết định duyệt cùng dấu vết trước/sau'],
    controls: ['Không gọi Q_order Chặng 16 là số cuối', 'Không tính lại nhu cầu ở cổng phát hành', 'Không giả lập quyết định người duyệt'],
    documentCoverage: ['§1 Vai trò', '§2–3 Định nghĩa và công thức quản trị', '§4 Bộ ngoại lệ', '§5 Ba kết quả', '§6 Đầu ra'],
  },
  19: {
    purpose: 'Đo kết quả thật, tách đúng lớp nguyên nhân và tạo đề xuất cho phiên tương lai.',
    inputs: ['Snapshot dự báo, nguồn hàng, SS, MOQ, ngân sách và quyết định phát hành', 'Actual bán, tồn, nhận hàng, ETA, thiếu hàng và vốn dùng'],
    rules: ['Đo riêng WAPE nền/cuối, Bias, stockout, dư tồn, ETA lệch, tỷ lệ cấp vốn và chờ duyệt', 'Tách nguyên nhân theo Chặng 1–5, 9–11, 12–13, 14, 15, 16, 17, 18', 'Đọc nguyên nhân trước khi đề xuất đổi mô hình/chính sách', 'Mọi thay đổi tạo phiên bản tương lai, không sửa snapshot cũ'],
    outputs: ['Báo cáo sai số, phục vụ, tồn, ETA, MOQ, ngân sách và duyệt', 'Nguyên nhân chính có bằng chứng', 'Đề xuất chính sách/lead time/hệ số/quyền duyệt cho kỳ sau'],
    controls: ['Không quy thiếu hàng mặc định cho dự báo', 'Không sửa ngược F, K, SS, Q hoặc quyết định duyệt', 'Đề xuất phải có truy vết và cần kiểm chứng'],
    documentCoverage: ['§1 Vai trò', '§2 Các lớp nguyên nhân', '§3 Chỉ tiêu bắt buộc', '§4 Quy tắc đọc nguyên nhân', '§5 Không hồi tố', '§6–7 Đầu ra và tham khảo'],
  },
};
