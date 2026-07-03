import { FormulaBlock, SimulationPolicy, SkuPipelineState, StageNumber } from './models';

const f = (title: string, expression: string, source: string): FormulaBlock => ({ title, expression, source });

const METRICS = [
  f('RMSE', String.raw`\operatorname{RMSE}=\sqrt{\frac{1}{n}\sum_{t=1}^{n}(Y_t-F_t)^2}`, 'C11 §10.3'),
  f('nRMSE', String.raw`\operatorname{nRMSE}=\frac{\operatorname{RMSE}}{\overline{Y}},\qquad \overline{Y}>0`, 'C11 §10.3'),
  f('WAPE và Bias', String.raw`\operatorname{WAPE}=\frac{\sum_{t=1}^{n}|Y_t-F_t|}{\sum_{t=1}^{n}Y_t},\qquad \operatorname{Bias}=\frac{\sum_{t=1}^{n}(F_t-Y_t)}{\sum_{t=1}^{n}Y_t}`, 'C11 §10.3'),
];

function stage11ModelFormulas(state: Readonly<SkuPipelineState> | null): FormulaBlock[] {
  switch (state?.forecast?.model) {
    case 'SES': return [
      f('Khởi tạo SES', String.raw`L_1=Y_1`, 'C11 §5'),
      f('Cập nhật mức nền', String.raw`F_t=L_{t-1},\qquad L_t=\alpha Y_t+(1-\alpha)L_{t-1}`, 'C11 §5'),
      f('Dự báo nhiều bước', String.raw`F_{t+k}=L_t`, 'C11 §5'), ...METRICS,
    ];
    case 'Holt': return [
      f('Khởi tạo Holt', String.raw`L_2=Y_2,\qquad T_2=Y_2-Y_1`, 'C11 §6'),
      f('Cập nhật mức và xu hướng', String.raw`L_t=\alpha Y_t+(1-\alpha)(L_{t-1}+T_{t-1}),\quad T_t=\beta(L_t-L_{t-1})+(1-\beta)T_{t-1}`, 'C11 §6'),
      f('Dự báo Holt', String.raw`F_t=L_{t-1}+T_{t-1},\qquad F_{t+k}=L_t+kT_t`, 'C11 §6'), ...METRICS,
    ];
    case 'Holt-Winters': return [
      f('Khởi tạo mùa vụ', String.raw`S_i=\frac{Y_i}{\operatorname{mean}(Y_1,\ldots,Y_m)},\qquad m=24`, 'C11 §7'),
      f('Cập nhật Holt-Winters', String.raw`L_t=\alpha\frac{Y_t}{S_{t-m}}+(1-\alpha)(L_{t-1}+T_{t-1})`, 'C11 §7.4'),
      f('Cập nhật mùa vụ', String.raw`S_t=\gamma\frac{Y_t}{L_t}+(1-\gamma)S_{t-m}`, 'C11 §7.4'),
      f('Dự báo Holt-Winters', String.raw`F_{t+k}=(L_t+kT_t)S_{t-m+k}`, 'C11 §7.5'), ...METRICS,
    ];
    case 'Croston': return [
      f('Khoảng cách khởi tạo', String.raw`P_1=t_2-t_1`, 'C11 §8.5'),
      f('Cập nhật khi phát sinh', String.raw`Z_t=\alpha Y_t+(1-\alpha)Z_{t-1},\qquad P_t=\alpha I_t+(1-\alpha)P_{t-1}`, 'C11 §8.5'),
      f('Dự báo bình quân Croston', String.raw`F_t=\frac{Z_t}{P_t},\qquad F_{t+k}=\frac{Z_t}{P_t}`, 'C11 §8.5'), ...METRICS,
    ];
    case 'PulseRhythm': return [
      f('Khoảng cách phát sinh', String.raw`d_j=t_j-t_{j-1},\qquad D=\operatorname{Median}(d_2,\ldots,d_r)`, 'C11 §8.6'),
      f('Quy mô phát sinh', String.raw`Q=\operatorname{Median}(Y_{t_1},Y_{t_2},\ldots,Y_{t_r})`, 'C11 §8.6'),
      f('Dự báo theo nhịp', String.raw`F_{t+h}=\begin{cases}Q,&(t+h-t_r)\bmod D=0\\0,&\text{ngược lại}\end{cases}`, 'C11 §8.6'), ...METRICS,
    ];
    case 'PurchasePlan': return [
      f('Kế hoạch Thu mua', String.raw`F_c=Q_c^{\mathrm{expected}}\quad\text{hoặc}\quad F_c=k_{\mathrm{plan}}\,B_c^{\mathrm{category}}`, 'C11 §9'),
      f('Mượn mã tương tự', String.raw`F_c=F_c^{\mathrm{similar\ SKU}}\times k_{\mathrm{conversion}}`, 'C11 §9'),
    ];
    default: return [f('Chọn công thức theo nhánh', String.raw`\mathrm{Model}=g(XYZ,\,Seasonality,\,Trend,\,Backtest)`, 'C11 §3'), ...METRICS];
  }
}

export function getStageFormulas(stage: StageNumber, state: Readonly<SkuPipelineState> | null, policy: SimulationPolicy): FormulaBlock[] {
  switch (stage) {
    case 1: return [
      f('Năm lập kế hoạch', String.raw`Y_{\mathrm{plan}}=\operatorname{YEAR}(D_{\mathrm{run}})`, 'C1 §4.1'),
      f('Biên lịch sử', String.raw`D_{\mathrm{start}}=\operatorname{DATE}(Y_{\mathrm{plan}}-${policy.historyYears},1,1),\qquad D_{\mathrm{end}}=D_{\mathrm{run}}-1`, 'C1 §4.2–4.3'),
      f('Tổng ngày lịch', String.raw`D=D_{\mathrm{end}}-D_{\mathrm{start}}+1`, 'C1 §4.4'),
      f('Chia chu kỳ cố định', String.raw`N=\left\lfloor\frac{D}{M}\right\rfloor,\qquad r=D-NM,\qquad M=${policy.cycleLength}`, 'C1 §4.5'),
    ];
    case 2: return [f('Hai điều kiện stockout', String.raw`SO_t=(O_t=0\land C_t>0\land h_t>h_0)\lor(O_t=0\land C_t=0\land Q_t=0)`, 'C2 §4')];
    case 3: return [
      f('Số ngày cân bằng mỗi phía', String.raw`k=\min(n_{\mathrm{before}},n_{\mathrm{after}},7)`, 'C3 §6.4'),
      f('Mức nền tham chiếu', String.raw`R_t=\operatorname{Median}\!\left(B_d\mid d\in\mathcal{R}_t^{\mathrm{clean}}\right)`, 'C3 §7'),
      f('Sức mua cơ bản ngày stockout', String.raw`B_t=\max(Q_t,R_t)`, 'C3 §7'),
    ];
    case 4: return [
      f('Số ngày cân bằng quanh CTKM', String.raw`k=\min(n_{\mathrm{before}},n_{\mathrm{after}},7)`, 'C4 §6'),
      f('Mức bán tự nhiên CTKM', String.raw`N_r=\operatorname{Median}\!\left(B_d\mid d\in\mathcal{R}_r^{\mathrm{clean}}\right)`, 'C4 §7'),
      f('Sức mua cơ bản ngày CTKM', String.raw`B_t=N_r,\qquad \forall t\in r_{\mathrm{promo}}`, 'C4 §7'),
    ];
    case 5: return [
      f('Lấp nền kỹ thuật', String.raw`B_t^{\mathrm{fill}}=\operatorname{Median}\!\left(B_d\mid d\in\mathcal{R}_t^{\mathrm{observed\ clean}}\right)`, 'C5 §8'),
      f('Tổng hợp chu kỳ', String.raw`Y_j=\sum_{d=1}^{M}B_{j,d},\qquad M=${policy.cycleLength}`, 'C5 §10'),
      f('Điều kiện khóa', String.raw`locked_j\Longleftrightarrow unresolved_j=0\ \land\ empty_j=\mathrm{false}`, 'C5 §7'),
    ];
    case 6: return [
      f('Hệ số chuẩn hóa năm', String.raw`a_N=\begin{cases}1,&N\ge24\\\frac{24}{N},&6\le N<24\\\text{không xếp tự động},&N<6\end{cases}`, 'C6 §4.1 · ký hiệu kỹ thuật a_N cho Hệ số chuẩn hóa năm'),
      f('Sản lượng năm hóa', String.raw`Q_{\mathrm{annual}}=\left(\sum_{j=1}^{N}Y_j\right)a_N`, 'C6 §4.1'),
      f('Giá trị tiêu thụ năm hóa', String.raw`V_{\mathrm{annual}}=Q_{\mathrm{annual}}P_{\mathrm{standard}}`, 'C6 §4.1'),
      f('Tỷ trọng giá trị', String.raw`s_i=\frac{V_i}{\sum_{k\in\mathcal E}V_k}`, 'C6 §6 bước 4 · E là tập SKU có N ≥ 6'),
      f('Tỷ trọng lũy kế', String.raw`S_r=\sum_{i=1}^{r}s_i`, 'C6 §6 bước 6'),
      f('Điểm cắt ABC', String.raw`ABC=\begin{cases}A,&r=1\ \text{hoặc}\ S_r\le0.80\\B,&0.80<S_r<0.90\\C,&S_r\ge0.90\end{cases}`, 'C6 §7 · SKU đứng đầu vượt 80% vẫn giữ A và ghi ngoại lệ tập trung'),
    ];
    case 7: return [
      f('Dữ liệu đầu vào', String.raw`\mathbf{x}=(x_1,x_2,\ldots,x_n),\qquad x_i=Y_i^{\mathrm{locked}}`, 'C7 §4.4.1'),
      f('Số chu kỳ có nhu cầu (m)', String.raw`m=\sum_{i=1}^{n}\mathbb{1}(x_i>0)`, 'C7 §4.4.2'),
      f('Khoảng cách phát sinh (ADI)', String.raw`\operatorname{ADI}=\frac{n}{m}`, 'C7 §4.4.3'),
      f('Nhánh bán thưa Z', String.raw`\operatorname{ADI}>1.32\Rightarrow Z`, 'C7 §4.4.4'),
      f('Lọc chu kỳ có nhu cầu', String.raw`\mathbf{x}^{+}=\{x_i\mid x_i>0\}`, 'C7 §4.4.5'),
      f('Sức mua trung bình (μ)', String.raw`\mu=\frac{1}{m}\sum_{x_i\in\mathbf{x}^{+}}x_i`, 'C7 §4.4.6'),
      f('Độ lệch chuẩn quần thể (σ)', String.raw`\sigma=\sqrt{\frac{1}{m}\sum_{x_i\in\mathbf{x}^{+}}(x_i-\mu)^2}`, 'C7 §4.4.7 · mẫu số m sau khi lọc chu kỳ dương'),
      f('Hệ số biến thiên và bình phương', String.raw`\operatorname{CV}=\frac{\sigma}{\mu},\qquad \operatorname{CV}^{2}=\left(\frac{\sigma}{\mu}\right)^2`, 'C7 §4.4.8'),
      f('Điều kiện X/Y/Z/D', String.raw`D:(n<6\lor m=0);\quad Z:\operatorname{ADI}>1.32;\quad X:\operatorname{CV}^2\le0.49;\quad Y:\operatorname{CV}^2>0.49`, 'C7 §4.4.9'),
    ];
    case 8: return [f('Tra chính sách', String.raw`(ServiceLevel,Priority)=\operatorname{Matrix}(ABC,XYZ),\qquad D\notin\operatorname{Matrix}_{3\times3}`, 'C8 §5')];
    case 9: return [
      f('Trung bình mỗi vòng', String.raw`\bar{x}_r=\frac{1}{m}\sum_{p=1}^{m}x_{r,p},\qquad m=24`, 'C9 §6'),
      f('Tỷ lệ theo vị trí', String.raw`R_{r,p}=\frac{x_{r,p}}{\bar{x}_r}`, 'C9 §6'),
      f('Hệ số mùa vụ vị trí', String.raw`S_p=\frac{1}{q}\sum_{r=1}^{q}R_{r,p}`, 'C9 §6'),
      f('Điều kiện lặp cao', String.raw`S_p\ge1+\delta\ \land\ \frac{\#\{r:R_{r,p}\ge1+\delta\}}{q}\ge67\%`, 'C9 §6'),
    ];
    case 10: return [
      f('Mức đổi đoạn 1→2', String.raw`g_1=\frac{\bar{Y}_2-\bar{Y}_1}{\bar{Y}_1}`, 'C10 §4'),
      f('Mức đổi đoạn 2→3', String.raw`g_2=\frac{\bar{Y}_3-\bar{Y}_2}{\bar{Y}_2}`, 'C10 §4'),
    ];
    case 11: return stage11ModelFormulas(state);
    case 12: return [
      f('Nền tự nhiên vùng CTKM', String.raw`N_{\mathrm{CTKM}}=\sum_{d\in\mathcal{P}}Y_d^{\mathrm{base}}`, 'C12 §5.1'),
      f('Số bán ghi nhận vùng CTKM', String.raw`Q_{\mathrm{CTKM}}^{\mathrm{actual}}=\sum_{d\in\mathcal{P}}Q_d^{\mathrm{actual}}`, 'C12 §5.2'),
      f('Hệ số KM lịch sử', String.raw`K_{\mathrm{KM}}^{\mathrm{history}}=\frac{Q_{\mathrm{CTKM}}^{\mathrm{actual}}}{N_{\mathrm{CTKM}}}`, 'C12 §5.3'),
      f('Hệ số KM khóa', String.raw`K_{\mathrm{KM}}^{\mathrm{locked}}=\operatorname{Median}(K_{\mathrm{KM},1}^{\mathrm{history}},\ldots,K_{\mathrm{KM},r}^{\mathrm{history}})`, 'C12 §6'),
    ];
    case 13: return [
      f('Nền thuộc ngày CTKM', String.raw`F_{c,\mathrm{KM}}^{\mathrm{base}}=F_c^{\mathrm{base}}\frac{n_{\mathrm{CTKM},c}}{M},\qquad M=${policy.cycleLength}`, 'C13 §5.3'),
      f('Nền ngoài CTKM', String.raw`F_{c,\mathrm{nonKM}}^{\mathrm{base}}=F_c^{\mathrm{base}}-F_{c,\mathrm{KM}}^{\mathrm{base}}`, 'C13 §5.3'),
      f('Dự báo cuối', String.raw`F_c^{\mathrm{final}}=F_{c,\mathrm{nonKM}}^{\mathrm{base}}+F_{c,\mathrm{KM}}^{\mathrm{base}}K_{\mathrm{KM}}`, 'C13 §5.3'),
    ];
    case 14: return [f('Hàng tự do tại mốc t', String.raw`I_t^{\mathrm{free}}=I_t^{\mathrm{on\ hand}}+Q_{\le t}^{\mathrm{confirmed\ inbound}}-Q_{\le t}^{\mathrm{committed}}`, 'C14 §4.2')];
    case 15: return [
      f('Tồn kho an toàn đầy đủ', String.raw`SS=Z\sqrt{\overline{LT}\,\sigma_d^2+\overline{D}^{\,2}\sigma_{LT}^2}`, 'C15 §3'),
      f('Quy đổi lead time', String.raw`\overline{LT}_{\mathrm{cycle}}=\frac{\overline{LT}_{\mathrm{day}}}{M},\qquad \sigma_{LT,\mathrm{cycle}}=\frac{\sigma_{LT,\mathrm{day}}}{M},\qquad M=${policy.cycleLength}`, 'C15 §4'),
      f('Công thức rút gọn — chỉ khi σLT=0', String.raw`SS=Z\sigma_d\sqrt{\overline{LT}}`, 'C15 §7'),
    ];
    case 16: return [
      f('Số cần trước làm tròn', String.raw`Q_{\mathrm{raw}}=\max\!\left(0,D_{\mathrm{cover}}+SS-I_{\mathrm{free}}\right)`, 'C16 §4.2'),
      f('Số đặt sau MOQ', String.raw`Q_{\mathrm{order}}=\left\lceil\frac{Q_{\mathrm{raw}}}{MOQ}\right\rceil MOQ`, 'C16 §4.2'),
      f('Phần dư do MOQ', String.raw`Q_{\mathrm{surplus}}=Q_{\mathrm{order}}-Q_{\mathrm{raw}}`, 'C16 §4.2'),
    ];
    case 17: return [
      f('Giá trị đặt', String.raw`V_i=Q_{\mathrm{order},i}\,P_{\mathrm{purchase},i}`, 'C17 §2–4'),
      f('Điểm ưu tiên khởi điểm', String.raw`P=w_1S_{\mathrm{ABC/XYZ}}+w_2S_{\mathrm{category}}+w_3S_{\mathrm{stockout}}+w_4S_{\mathrm{lead\ time}}`, 'C17 §4.2 · chỉ dùng khi trọng số đã được duyệt'),
    ];
    case 18: return [
      f('Cổng phát hành', String.raw`Release_i=(Q_{\mathrm{funded},i}>0)\land Complete_i\land\neg Exception_i`, 'C18 §3–4'),
    ];
    case 19: return [
      f('WAPE sau kỳ', String.raw`\operatorname{WAPE}=\frac{\sum_{t=1}^{n}|A_t-F_t|}{\sum_{t=1}^{n}A_t}`, 'C19 §4.2'),
    ];
  }
}
