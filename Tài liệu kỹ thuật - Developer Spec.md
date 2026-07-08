# Tài liệu kỹ thuật cho lập trình viên — Demand Planning & Replenishment Governance

> **Nguồn nghiệp vụ gốc:** `Tài liệu giải pháp - Demand Planning & Replenishment Governance.md` (tài liệu giải pháp).
> **Mục đích:** đặc tả kỹ thuật đầy đủ để lập trình viên xây dựng một hệ thống mô phỏng/triển khai **đúng tuyệt đối** hành trình 19 chặng của tài liệu giải pháp.
> **Quy ước:** mọi quy tắc trong tài liệu này đều truy vết về mục tương ứng của tài liệu giải pháp (ghi chú dạng `[C4 §6.1]` = Chặng 4, mục 6.1). Khi có mâu thuẫn, **tài liệu giải pháp là chuẩn**.

---

## 0. Phạm vi và nguyên tắc bất biến

### 0.1. Phạm vi

| Pha | Chặng | Nội dung |
|---|---|---|
| Pha 1 — Clean data | 1–5 | Khoảng lịch sử → đánh dấu stockout → nâng nền stockout → đưa CTKM về nền → gom chu kỳ 15 ngày |
| Pha 2 — Phân loại | 6–8 | ABC theo giá trị tiêu thụ, XYZ/D theo độ đều/độ thưa, ma trận chính sách |
| Pha 3 — Dự báo | 9–13 | Mùa vụ (Y), xu hướng (Y), chọn & chạy mô hình nền, học hệ số KM, áp CTKM tương lai |
| Pha 4 — Nguồn hàng | 14 | Lịch nguồn hàng và vị thế tồn |
| Pha 5 — Dự trữ & số mua | 15–16 | Tồn kho an toàn, số đặt chưa xét ngân sách + làm tròn MOQ |
| Pha 6 — Ngân sách & học lại | 17–19 | Phân bổ ngân sách, duyệt ngoại lệ & phát hành, đo kết quả |

Website mô phỏng hiện thực hóa **Chặng 1–15**; Chặng 16–19 được đặc tả để triển khai tiếp.

### 0.2. Nguyên tắc bất biến (áp dụng cho MỌI chặng)

1. **Không hồi tố:** kết quả chặng trước đã khóa thì chặng sau không tính lại, không lọc lại, không sửa ngược. Phát hiện sai → tạo phiên/phiên bản mới. `[C9 §2, C19]`
2. **Giá trị 0 là dữ liệu thật.** Ngày **không có bản ghi** không được suy diễn thành bán = 0, tồn = 0 hay stockout. `[C1 §3]`
3. **Chỉ một cột được cộng vào chu kỳ:** `Sức mua cơ bản cấp ngày`. Không bao giờ cộng số bán CTKM thô. `[C5 §4]`
4. **Ngày đã qua xử lý (nâng nền stockout, CTKM về nền, lấp nền kỹ thuật) không được làm nguồn tham chiếu cho ngày khác.** `[C5 §6]`
5. **Mọi ngưỡng là tham số chính sách có phiên bản** (xem §2). Không đổi ngưỡng giữa phiên. `[C7 §4.8, C8 §12]`
6. **Mọi bước phải ghi log kiểm toán** đủ để người vận hành tái lập kết quả (xem log spec từng chặng).

---

## 1. Mô hình dữ liệu

### 1.1. `DailyRecord` — bản ghi ngày (đầu vào POS/ERP + kết quả Pha 1)

```ts
interface DailyRecord {
  sku: string;              // mã hàng
  location: string;         // nơi bán
  date: string;             // ISO yyyy-mm-dd
  openStock: number;        // tồn đầu ngày
  closeStock: number;       // tồn cuối ngày
  sales: number;            // số bán ghi nhận trong ngày (trường bán chính, KHÔNG tách KM)
  firstReceiptHour: string|null; // giờ nhập đầu tiên "HH:mm" nếu có, lấy từ trường giờ nhập trên phiếu nhập đầu tiên trong ngày
  promoCode: string|null;   // mã CTKM nếu ngày thuộc vùng CTKM

  // Kết quả Chặng 2
  isStockout: boolean;
  stockoutReason: string|null;   // 'late-receipt' | 'empty-all-day'

  // Kết quả Chặng 3/4/5
  baseDemand: number|null;       // SỨC MUA CƠ BẢN CẤP NGÀY — cột duy nhất được cộng vào chu kỳ
  baseSource: 'clean'            // ngày sạch quan sát
    | 'stockout-lifted'          // stockout đã nâng nền (C3)
    | 'promo-normalized'         // CTKM đã đưa về mức bán tự nhiên (C4)
    | 'technical-fill'           // lấp nền kỹ thuật (C5)
    | 'insufficient'             // không đủ căn cứ
    | 'promo-defer';             // (trạng thái trung gian C3) chờ C4
  balanceStatus: 'balanced'      // nền cân bằng tốt
    | 'temporary'                // TẠM · KIỂM TRA (chưa cân bằng, sẽ xét lại kỳ sau)
    | 'fixed'                    // KHÔNG CÂN BẰNG CỐ ĐỊNH (giới hạn lịch sử đã đóng)
    | 'insufficient' | null;
  refBefore: {date:string, value:number}[]; // ngày sạch phía trước đã dùng
  refAfter:  {date:string, value:number}[]; // ngày sạch phía sau đã dùng
  refMedian: number|null;
  selectionReason: string;       // lý do chọn tập nền (log bắt buộc C4 §12)
}
```

### 1.2. `CycleRecord` — chu kỳ 15 ngày (đầu ra Chặng 5)

```ts
interface CycleRecord {
  sku: string; location: string;
  cycleIndex: number;          // thứ tự chu kỳ trong khung lịch phiên (1-based)
  dateStart: string; dateEnd: string;
  days: number;                // số ngày lịch trong chu kỳ (=cycleLength trừ chu kỳ biên)
  baseDemand: number;          // Σ baseDemand ngày — CHỈ hợp lệ khi locked=true
  locked: boolean;             // true ⇔ đủ 15 ngày có sức mua cơ bản đủ căn cứ (sau lấp nền)
  emptyCycle: boolean;         // true ⇔ 0 ngày đủ căn cứ → không lấp, không dùng để học
  cleanDays: number;           // ngày sạch quan sát
  stockoutLiftedDays: number;  // ngày stockout đã nâng nền
  promoNormalizedDays: number; // ngày CTKM đã đưa về nền
  technicalFillDays: number;   // ngày lấp nền kỹ thuật
  unresolvedDays: number;      // ngày còn thiếu căn cứ (nếu >0 ⇒ locked=false)
  reviewDays: number;          // ngày mang dấu TẠM · KIỂM TRA
  rawSalesTotal: number;       // Σ sales gốc (chỉ để kiểm toán/C12)
  promoCodes: string[];        // mã CTKM xuất hiện trong chu kỳ (cho C12)
  seasonRound: number;         // vòng mùa vụ (1-based) — gán từ lịch phiên
  seasonPosition: number;      // vị trí mùa vụ 1..24
}
```

**Bắt buộc:** các chặng 6, 7, 9, 10, 11 **chỉ đọc chu kỳ `locked=true`**. Chu kỳ trống/không lấp đủ không tạo tín hiệu học. `[C5 §7]`

### 1.3. Các cấu trúc khác

```ts
interface Classification { sku: string; abc: 'A'|'B'|'C'|'N/A'; abcStatus: 'full'|'annualized'|'not-rated';
  xyz: 'X'|'Y'|'Z'|'D'; adi: number|null; cv2: number|null; nCycles: number; mDemandCycles: number; }

interface Policy { cell: string;               // 'AX'..'CZ' hoặc 'D'
  serviceLevel: number;                        // % mức phục vụ mục tiêu
  capitalPriority: string; policyVersion: string; }

interface SeasonalityResult { status: 'confirmed'|'no-clear-season'|'insufficient-structure'|'not-applicable';
  positions: { position: number; coefficient: number|null; repeatRate: number; verdict: 'LẶP CAO'|'LẶP THẤP'|'CHƯA RÕ' }[];
  roundsUsed: number; allowHoltWinters: boolean; }

interface TrendResult { status: 'up'|'down'|'none'|'insufficient'; g1: number; g2: number;
  cappedRate: number|null; warning: string|null; }

interface ForecastResult { model: 'SES'|'Holt'|'Holt-Winters'|'Croston'|'PulseRhythm'|'PurchasePlan'|'SimilarSku'|'Exception';
  params: Record<string, number>;              // alpha, beta, gamma | D, Q | hệ số quy đổi
  baseForecast: number[];                      // dự báo NỀN theo chu kỳ tương lai (chưa áp CTKM)
  backtest: { rmse: number; nrmse: number|null; wape: number|null; bias: number|null;
              hitRate?: number; missedPulses?: number; falsePulses?: number };  // chỉ tiêu Z bổ sung
  lockStatus: 'locked'|'review'|'temporary'|'exception'; lockReason: string; }

interface PromoFactor { groupKey: string;      // SKU|location|promoType
  factor: number; sampleCount: number;
  confidence: 'auto'|'low'|'suggest-only'|'none'; excluded: {region: string, reason: string}[]; }

interface SupplyPosition { milestones: { date: string; label: string;
  onHand: number; confirmedInbound: number; committed: number; freeStock: number }[]; }

interface SafetyStockResult { z: number; serviceLevel: number; dBar: number; sigmaD: number;
  ltBarCycles: number; sigmaLtCycles: number; ss: number; formula: 'full'|'reduced'|'policy';
  sigmaDSource: 'backtest'|'cycle-std'; warnings: string[]; }
```

---

## 2. Bảng tham số chính sách (mặc định + nguồn)

| # | Tham số | Mặc định | Chặng | Ghi chú |
|---|---|---:|---|---|
| P01 | Số năm lịch sử chuẩn | 3 | C1 | mốc khuyến nghị mùa vụ, không phải cổng chặn |
| P02 | Độ dài chu kỳ kế hoạch | 15 ngày | C1 | |
| P03 | Giờ quy định nhập hàng | 10:00 | C2 | so với `firstReceiptHour` |
| P04 | Bán kính tìm nền lớp 1 | ±7 ngày | C3/C4/C5 | |
| P05 | Bán kính tìm nền tối đa | ±24 ngày | C3/C4/C5 | |
| P06 | Số ngày sạch tối thiểu để tính nền | 3 | C3/C4/C5 | <3 → THIẾU CĂN CỨ |
| P07 | Trần số ngày tham chiếu | 14 | C3/C4/C5 | trần, không phải mục tiêu |
| P08 | k cân bằng tối đa mỗi phía | 7 | C3/C4 | `k = min(trước, sau, 7)` |
| P09 | Ngày sạch một phía cho cụm CTKM sát cận dưới | 14 | C4 §6.1 | |
| P10 | Điều kiện gộp cụm CTKM sát nhau | Không đủ ngày sạch để tạo nền riêng hợp lệ | C4 §6.1 | Không dùng ngưỡng cứng; nếu các CTKM sát nhau làm hệ thống không tạo được tập ngày sạch riêng theo quy tắc C4 thì coi như một cụm CTKM. |
| P11 | Cửa sổ đánh giá ABC & XYZ | 24 chu kỳ khóa gần nhất | C6/C7 | |
| P12 | Số chu kỳ khóa tối thiểu (ABC & XYZ) | 6 | C6/C7 | <6 → N/A (ABC) / D (XYZ) |
| P13 | Điểm cắt A (giá trị lũy kế) | ≤ 80% | C6 §7.1 | khung tham khảo 70–80% |
| P14 | Điểm cắt C (giá trị lũy kế) | >= 90% | C6 §7.2 | C bắt đầu khi tỷ trọng lũy kế đạt từ 90% trở lên. |
| P15 | Ngưỡng ADI | 1,32 | C7 | |
| P16 | Ngưỡng CV² | 0,49 | C7 | độ lệch chuẩn **quần thể** (mẫu số m) |
| P17 | Ma trận mức phục vụ | AX 97 · AY 95 · AZ 92 · BX 95 · BY 92 · BZ 88 · CX 90 · CY 85 · CZ 80 (%) | C8 §5 | |
| P18 | Ngưỡng lệch mùa vụ δ | 15% | C9 | cao ≥1,15; thấp ≤0,85 |
| P19 | Tỷ lệ lặp tín hiệu tối thiểu | 67% | C9 | |
| P20 | Số vòng tối thiểu kiểm tra lặp | 2 vòng (=48 CK khóa) | C9 | |
| P21 | Cửa sổ xu hướng | 12 CK khóa gần nhất, 3 đoạn × 4 | C10 | |
| P22 | Ngưỡng xu hướng | ±5% cả g₁ và g₂ | C10 | |
| P23 | Giới hạn an toàn xu hướng | 15% (cảnh báo >15%, cần xem xét >25%) | C10 §6 | |
| P24 | Tỷ lệ tập kiểm tra ngược | 20% cuối chuỗi (tối thiểu 1 CK) | C11 | chia theo thời gian, không trộn |
| P25 | Ngưỡng WAPE/Bias theo ô ABC×XYZ | bảng minh họa mô phỏng (phải hậu kiểm) | C11 §11.5 | |
| P26 | Số lần CTKM tối thiểu để tự khóa hệ số KM | 3 | C12 | 2 = tin cậy thấp; 1 = chỉ gợi ý |
| P27 | Hệ số KM sàn tự động | 1,00 | C12 §7 | K<1 → đặt 1 hoặc chuyển kiểm tra |
| P28 | Bảng Z theo mức phục vụ | 80%→0,84 · 85%→1,04 · 88%→1,17 · 90%→1,28 · 92%→1,41 · 95%→1,65 · 97%→1,88 · 97,5%→1,96 · 99%→2,33 | C15 §5.1 | nội suy chuẩn normal |
| P29 | Lead time mô phỏng | 120 ± 18 ngày (→ 8 ± 1,2 chu kỳ) | C15 §4 | mô phỏng nhập khẩu 3–6 tháng |

Mỗi tham số khi triển khai thật phải có `policyVersion`, phạm vi áp dụng, ngày hiệu lực; thay đổi chỉ áp dụng từ phiên sau.

---

## 3. Đặc tả thuật toán từng chặng

### Chặng 1 — Khoảng lịch sử & chia chu kỳ `[C1]`

**Input:** `runDate`, P01, P02, dữ liệu bán/tồn đã chốt.

```text
planYear     = YEAR(runDate)
historyStart = date(planYear - P01, 1, 1)
historyEnd   = runDate - 1 day
totalDays    = historyEnd - historyStart + 1
numCycles    = floor(totalDays / P02)      // chu kỳ LỊCH CỐ ĐỊNH đánh số từ historyStart
remainder    = totalDays - numCycles*P02   // ngày dư ở biên: giữ để kiểm toán, KHÔNG tạo chu kỳ học
```

Quy tắc chọn dữ liệu: chỉ lấy bản ghi trong `[historyStart, historyEnd]`; SKU có dữ liệu một phần vẫn xử lý phần đang có; **không ép đủ 3 năm**; gắn mỗi bản ghi vào đúng ngày lịch và đúng chu kỳ lịch. Vòng mùa vụ/vị trí mùa vụ được gán từ lịch chu kỳ này (24 vị trí/vòng).

**Output:** khung lịch phiên, lịch chu kỳ cố định, `numCycles`, `remainder`, dữ liệu ngày trong khoảng.

**Test:** run 01/06/2026 → [01/01/2023, 31/05/2026], 1247 ngày, 83 CK, dư 2. Run 01/01/2027 → 1096 ngày, 73 CK, dư 1. `[C1 §6]`

### Chặng 2 — Đánh dấu stockout `[C2]`

Chỉ **đúng 2 điều kiện**, không thêm heuristic nào khác:

```text
isStockout = (openStock == 0 AND closeStock >  0 AND firstReceiptHour != null AND firstReceiptHour > P03)
          OR (openStock == 0 AND closeStock == 0 AND sales == 0)
```

Ghi `stockoutReason`. Chặng 2 **không** bù, không ước lượng, không phân loại thêm.

### Chặng 3 — Sức mua cơ bản cho ngày KHÔNG CTKM có stockout `[C3]`

Bảng quyết định:

| Ngày | Xử lý |
|---|---|
| Không CTKM, không stockout | `baseDemand = sales`, source `clean` |
| Không CTKM, có stockout | tìm nền tham chiếu (thuật toán dưới) |
| CTKM (dù có stockout) | `promo-defer` → bàn giao nguyên trạng cho Chặng 4 |

**Thuật toán chọn tập nền (dùng chung C3/C4/C5):**

```text
function selectReferences(idxBefore, idxAfter, stopAtPromoBoundary):
  1. Quét ngày SẠCH QUAN SÁT (không CTKM, không stockout, không lấp nền kỹ thuật,
     không phải ngày đã nâng/đưa về nền) trong bán kính P04 mỗi phía.
     Nếu stopAtPromoBoundary: dừng quét khi đụng ngày CTKM (ranh giới CTKM liền kề). [C4 §6]
  2. Nếu min(trước, sau) < 2 HOẶC trước ≠ sau: mở rộng bán kính dần đến P05.
  3. k = min(|trước|, |sau|, P08)
     Nếu k ≥ 2: chọn k ngày GẦN NHẤT mỗi phía → status='balanced' (cắt phía dư). [C3 §6.4]
  4. Ngược lại: gom các ngày sạch gần nhất (≤ P07). Nếu ≥ P06 (3) ngày → status='temporary'.
  5. Nếu < 3 ngày → status='insufficient' (không tự tạo nền).
```

**Phân loại nhãn chưa cân bằng** `[C3 §8, C4 §8]`: `temporary` được nâng cấp thành `fixed` (KHÔNG CÂN BẰNG CỐ ĐỊNH) khi điểm cần bù nằm sát **cận dưới** lịch sử đã đóng (không thể có thêm quá khứ) hoặc bị CTKM liền kề chặn vĩnh viễn; giữ `temporary` (TẠM · KIỂM TRA) khi nằm gần **cận trên**/ngày hiện tại (tương lai sẽ có thêm ngày sạch).

**Tính nền:**

```text
refMedian  = Median(giá trị các ngày tham chiếu)        // ≥3 ngày
baseDemand = max(sales, refMedian)                       // C3 KHÔNG làm giảm số bán thật
```

**Test:** ví dụ §9.1: refs 18,20,21,19 → median 19,5 → max(8; 19,5)=19,5 (balanced). §9.2: refs 17,18,20 → 18 (temporary).

### Chặng 4 — Đưa ngày CTKM về mức bán tự nhiên `[C4]`

1. **Dựng vùng CTKM:** chuỗi ngày liên tiếp cùng `promoCode` = 1 run. Các run sát nhau đến mức **không có đủ ngày sạch nằm giữa để tạo nền riêng hợp lệ theo quy tắc Chặng 4** → gộp thành **cụm CTKM** và xử lý như một CTKM kéo dài. `[C4 §6.1]`
2. **Tìm nền quanh vùng/cụm:** `selectReferences(firstIdx, lastIdx, stopAtPromoBoundary=true)` — không bao giờ lấy ngày bên kia một CTKM khác; không lấy ngày bên trong vùng.
3. **Cụm sát cận dưới lịch sử:** nếu chỉ có nguồn một phía — cần **≥ P09 (14) ngày sạch một phía** → dùng 14 ngày đó, nhãn `fixed`; không đủ → `insufficient`. `[C4 §6.1, ví dụ §10.5]`
4. **Gán nền:**

```text
naturalLevel = Median(refs)          // KHÔNG dùng max(sales, median) — sales CTKM là số méo cao [C4 §7]
∀ ngày trong vùng: baseDemand = naturalLevel; baseSource='promo-normalized'
```

5. Giữ nguyên `sales` + `promoCode` cho Chặng 12 học hệ số KM.
6. Log bắt buộc: SKU, nơi bán, mã CTKM, mã cụm, ngày bắt đầu/kết thúc vùng & cụm, refs trước/sau, số ngày mỗi phía, CTKM liền kề chặn, lý do chọn k, loại chưa cân bằng, ngày bị loại + lý do, mức bán tự nhiên. `[C4 §12]`

**Test:** ví dụ §10.4 (FLASH20 chặn bởi BEAUTY): trước có 6 sạch, sau-trước-BEAUTY có 4 → k=4, mảng 5,5,7,6 + 6,6,5,5 → median 5,5, balanced.

### Chặng 5 — Lấp nền & tổng hợp chu kỳ `[C5]`

```text
∀ chu kỳ theo LỊCH CHU KỲ CỐ ĐỊNH của phiên:
  đủ căn cứ = số ngày có baseDemand hợp lệ
  if đủ căn cứ == 0:            emptyCycle=true; locked=false   // KHÔNG lấp toàn bộ
  elif đủ căn cứ == days:        locked=true
  else: ∀ ngày thiếu/không đủ căn cứ:
        refs = selectReferences(i, i, stopAtPromoBoundary=false)
        // nguồn CHỈ là ngày sạch quan sát (isObservedCleanDay); ≥3 ngày → Median
        if ok: baseDemand=median; baseSource='technical-fill'; needsReview=true
        locked = (không còn ngày thiếu)
  if locked: baseDemandCycle = Σ baseDemand; ghi đủ bộ đếm kiểm toán (§1.2)
```

- Ngày lấp nền kỹ thuật được cộng vào chu kỳ của nó nhưng **không** làm nguồn cho ngày khác.
- Dấu `TẠM · KIỂM TRA` kế thừa lên chu kỳ (`reviewDays>0` ⇒ chu kỳ cần kiểm tra lại) nhưng **không** làm chu kỳ mất `locked`. `[C5 §9]`
- **Từ đây:** mọi chặng sau chỉ học từ chu kỳ `locked=true`.

### Chặng 6 — ABC theo giá trị tiêu thụ năm hóa `[C6]`

```text
N = số chu kỳ ĐÃ KHÓA trong cửa sổ P11 (24 CK khóa gần nhất)
if N < 6:  abc='N/A' (not-rated — chính sách hàng mới/tương đồng)
else:
  hệ số năm hóa = (N >= 24) ? 1 : 24/N
  sảnLượngNămHóa = Σ baseDemandCycle(N chu kỳ khóa) × hệ số
  giáTrịNămHóa   = sảnLượngNămHóa × đơn giá chuẩn (KHÔNG dùng giá KM)
Sắp giảm dần theo giáTrịNămHóa (bảng ABC riêng, không phá bảng gốc)
→ %giá trị, %lũy kế
A: lũy kế ≤ P13 (80%);  C: lũy kế >= P14 (90%);  B: còn lại
Kiểm tra logic: tổng mã khớp; %giá trị A>B>C; số lượng A<B<C (tham khảo, không cứng)
```

Thứ tự ưu tiên khi dữ liệu lệch chuẩn Pareto: (1) đúng tổng số mã, (2) giá trị A>B>C, (3) bản chất A cao nhất/C thấp nhất, (4) mới xét tỷ lệ số lượng. `[C6 §8]`

**Test:** ví dụ §9 — 5 SKU → B001,A001=A; C001=B (lũy kế 88,57%); D001,E001=C vì dòng D001 làm lũy kế đạt từ 90% trở lên.
⚠️ Lưu ý biên: quy tắc thực thi là `lũy kế >= 90%` thì bắt đầu nhóm C. Nếu dữ liệu ví dụ tạo ra dòng đúng 90,00%, dòng đó thuộc nhóm C.

### Chặng 7 — XYZ/D theo độ đều & độ thưa `[C7]`

```text
chuỗi = baseDemandCycle của các chu kỳ ĐÃ KHÓA trong cửa sổ 24 CK; n = |chuỗi|
if n < 6           → D
m = #{x_i > 0};  if m == 0 → D
ADI = n / m;     if ADI > 1,32 → Z
y = các x_i > 0
μ = mean(y);  σ = sqrt( Σ(y−μ)² / m )        // QUẦN THỂ: chia m, không m−1 [C7 §4.4.7]
CV² = (σ/μ)²
CV² ≤ 0,49 → X;  ngược lại → Y
```

Lưu lâu dài: nhãn, n, m, ADI, μ, σ, CV, CV², trạng thái đủ căn cứ, phiên bản chính sách.

**Test:** chuỗi `0,0,30,0,0,25` → n=6, m=2, ADI=3 → Z. Chuỗi y=30,25 → μ=27,5; σ=2,5; CV²≈0,0083.

### Chặng 8 — Ma trận chính sách ABC × XYZ `[C8]`

- X/Y/Z → ô 9 ô, mức phục vụ + ưu tiên vốn theo P17.
- **D không vào ma trận** — chính sách riêng (kế hoạch Thu mua / mã tương tự / duyệt ngoại lệ).
- Vai trò danh mục chỉ điều chỉnh nhẹ SAU ma trận, có lý do + log.

### Chặng 9 — Kiểm tra mùa vụ (CHỈ nhóm Y) `[C9]`

Điều kiện tiên quyết: chuỗi chu kỳ khóa + `seasonRound` + `seasonPosition` (m=24). Thiếu → `insufficient-structure`, không suy đoán.

```text
∀ vòng r: x̄_r = mean(baseDemandCycle các CK khóa thuộc vòng r)
R_{r,p} = x_{r,p} / x̄_r
Nhãn tạm mỗi vòng: Cao nếu R ≥ 1+δ (1,15); Thấp nếu R ≤ 1−δ (0,85); còn lại Trung tính
S_p = mean(R_{r,p} theo r)
Vị trí kết luận LẶP CAO  ⇔ S_p ≥ 1,15 VÀ tỷ lệ vòng nhãn 'Cao'  ≥ 67%   // CẢ HAI điều kiện [C9 §8]
Vị trí kết luận LẶP THẤP ⇔ S_p ≤ 0,85 VÀ tỷ lệ vòng nhãn 'Thấp' ≥ 67%
Cấp SKU: cần ≥ P20 (2 vòng, ~48 CK khóa) mới tự kết luận;
  có ≥1 vị trí LẶP CAO/LẶP THẤP → 'Có mùa vụ đủ căn cứ' (mở quyền THỬ Holt-Winters)
  ngược lại → 'Không có mùa vụ rõ' → sang Chặng 10
```

Bắt buộc xuất **bảng kiểm toán 24 vị trí** dạng `sứcMua / tỷLệ` theo từng vòng + hệ số vị trí + tỷ lệ lặp + kết luận. Lưu ý: 100% trung tính vẫn là `CHƯA RÕ`. `[C9 §7.3]`

### Chặng 10 — Kiểm tra xu hướng & công tắc mô hình (CHỈ nhóm Y) `[C10]`

```text
if có mùa vụ đủ căn cứ (C9) → công tắc = Holt-Winters (không xét xu hướng)
elif < 12 CK khóa gần nhất → công tắc = SES/nền ổn định (tin cậy thấp)
else:
  12 CK cuối chia 3 đoạn × 4; Ȳ₁,Ȳ₂,Ȳ₃
  g₁=(Ȳ₂−Ȳ₁)/Ȳ₁; g₂=(Ȳ₃−Ȳ₂)/Ȳ₂
  (g₁≥5% AND g₂≥5%) → tăng; (g₁≤−5% AND g₂≤−5%) → giảm; else → không xu hướng
  |xu hướng| ≤15% giữ nguyên; 15–25% cắt về 15% + cảnh báo; >25% cắt về 15% + 'cần xem xét'
  có xu hướng → Holt; không → SES/nền ổn định
```

### Chặng 11 — Chọn & chạy mô hình dự báo nền `[C11]`

**Quy tắc chuyển nhánh — CHỈ dựa trên đầu ra C7/C9/C10, tuyệt đối không dùng metadata ngoài pipeline:**

| Điều kiện | Nhánh |
|---|---|
| X, không xu hướng rõ | SES |
| X, có xu hướng rõ VÀ backtest Holt tốt hơn SES | Holt |
| Y, mùa vụ đủ căn cứ (C9) | Holt-Winters |
| Y, không mùa vụ, có xu hướng (C10) | Holt |
| Y, không mùa vụ, không xu hướng | SES/nền ổn định |
| Z, khoảng cách phát sinh không ổn định đủ căn cứ | Croston bình quân |
| Z, ≥3 lần phát sinh và khoảng cách phát sinh ổn định | Mô hình nhịp phát sinh; quy mô lấy trung vị và phải kiểm tra sai số quy mô |
| D | Kế hoạch Thu mua / mượn mã tương tự / ngoại lệ |

Kiểm tra xu hướng cho nhóm X dùng đúng thuật toán Chặng 10 (12 CK/3 đoạn/±5%) rồi so backtest Holt vs SES; Holt không tốt hơn → SES. `[C11 §3, §6.6]`

**Quy trình chung:** chia tập học/tập kiểm tra theo thời gian (P24), tối ưu tham số CHỈ trên tập học, đánh giá ngoài mẫu, chặn dự báo âm về 0.

**Tối ưu tham số theo tài liệu giải pháp `[C11 §4.1–4.8]`:**

| Mô hình | Cơ chế được phép dùng trong ERP | Giới hạn cần kiểm soát |
|---|---|---|
| SES | Grid Search thô 0,1→0,9, sau đó kiểm tra mịn quanh điểm tốt nhất. | 9 lần thử thô vì chỉ có một hệ số `alpha`. |
| Croston cơ bản | Grid Search thô 0,1→0,9, sau đó kiểm tra mịn quanh `alpha` tốt nhất. | Chỉ chạy khi logic Croston đúng và đã kiểm tra nhịp phát sinh. |
| Holt | Grid Search trên `alpha,beta`; nếu mỗi hệ số thử 9 mức thì có 81 tổ hợp thô. | Nên ràng buộc `beta <= alpha`. |
| Holt-Winters | Grid Search trên `alpha,beta,gamma` chỉ dùng như fallback/đối chứng. | 729 tổ hợp thô nếu mỗi hệ số thử 9 mức; không thay thế hoàn toàn thư viện ETS chuẩn. |

Quy tắc refine: nếu điểm tốt nhất là `0,30`, thử vùng quanh điểm đó, ví dụ `0,25 → 0,35` với bước `0,01`, hoặc vùng hẹp hơn `0,28; 0,29; 0,30; 0,31; 0,32`. Sau khi chọn tham số trên tập học, không được chỉnh tiếp bằng tập kiểm tra.

Với Holt-Winters/ETS đầy đủ, hướng chuẩn vẫn là forecasting service hoặc thư viện thống kê có tối ưu trạng thái ban đầu. Grid Search chỉ là cơ chế triển khai ban đầu, fallback hoặc đối chứng nội bộ.

**SES** `[C11 §5]`: `L₁=Y₁; F_t=L_{t−1}; L_t=αY_t+(1−α)L_{t−1}; F_{t+k}=L_t`.
**Holt** `[C11 §6]`: `L₂=Y₂; T₂=Y₂−Y₁; F_t=L_{t−1}+T_{t−1}; L_t=αY_t+(1−α)(L_{t−1}+T_{t−1}); T_t=β(L_t−L_{t−1})+(1−β)T_{t−1}; F_{t+k}=L_t+kT_t` (áp giới hạn xu hướng 15% khi dự phóng).
**Holt-Winters** `[C11 §7]`: m=24; S_i ban đầu = Y_i/mean(mùa 1); `L_{m+1}=Y_{m+1}/S₁; T_{m+1}=Y_{m+1}/S₁ − Y_m/S_m`; cập nhật L→T→S; `F_{t+k}=(L_t+kT_t)×S_{vị trí}`; cần ≥ 2m dữ liệu; vị trí tương lai không có S hợp lệ → cần xem xét.
**Croston** `[C11 §8.5]`:
```text
Khởi tạo: cần ≥2 lần phát sinh. Z = Y tại lần phát sinh 1; P₁ = t₂ − t₁ (khoảng cách GIỮA 2 lần).
CẤM dùng "số chu kỳ từ đầu chuỗi đến lần phát sinh đầu tiên" làm P. F=null trước khi đủ căn cứ.
Y_t = 0: không cập nhật Z, P; tăng bộ đếm q; F giữ nguyên.
Y_t > 0: Z=αY_t+(1−α)Z; P=αI_t+(1−α)P (I_t = q); F=Z/P. Đầu ra là BÌNH QUÂN/chu kỳ.
```
**Nhịp phát sinh** `[C11 §8.6]`: T={t₁..t_r}; d_j=t_j−t_{j−1}; điều kiện tối thiểu là r≥3 và khoảng cách phát sinh ổn định theo chính sách đã duyệt. Bản kiểm soát chặt nhất có thể yêu cầu mọi d_j bằng nhau. `D=Median(d); Q=Median(Y_{t_j})`; `F_{t+h}=Q nếu (t+h−t_r) mod D == 0, ngược lại 0`. Nếu bắt đúng chu kỳ nhưng quy mô phát sinh sai lớn, không khóa tự động; chuyển xem xét quy mô hoặc fallback theo Chặng 11.
**Nhóm D** `[C11 §9]`: (1) kế hoạch Thu mua: F = số lượng kỳ vọng hoặc hệ số × nền danh mục; hệ số điều chỉnh sau chu kỳ đầu = thực tế/dự báo; (2) mượn mã tương tự: F = nền mã tương tự × hệ số quy đổi (có người duyệt, điểm tương đồng, log).

**Chỉ tiêu bắt buộc trên tập kiểm tra** `[C11 §11.3]`:
`RMSE=√(Σe²/n)`; `nRMSE=RMSE/Ȳ (Ȳ>0)`; `WAPE=Σ|e|/ΣY (ΣY>0)`; `Bias=Σ(F−Y)/ΣY`. Nhóm Z thêm: tỷ lệ bắt đúng chu kỳ phát sinh, số lần bỏ lỡ, số lần phát sinh giả, WAPE riêng chu kỳ Y>0. Ȳ=0/ΣY=0 → không chia 0, chuyển chỉ tiêu bán thưa.

**Khóa mô hình:** đạt ngưỡng WAPE & |Bias| của ô ABC×XYZ → `locked`; WAPE đạt nhưng Bias vượt → `review`; WAPE ≤ 1,5×ngưỡng → `temporary`; hơn nữa → `exception`. Dự báo âm → chặn 0 + đánh dấu.

### Chặng 12 — Hệ số KM từ CTKM lịch sử `[C12]`

```text
∀ vùng CTKM lịch sử (từ C4, cấp ngày):
  N_CTKM = Σ baseDemand (ngày trong vùng, sau khi C4 đưa về nền)   // nền tự nhiên vùng
  Q_actual = Σ sales (ngày trong vùng)                              // số bán ghi nhận
  if N_CTKM ≤ 0 hoặc thiếu căn cứ → loại, ghi lý do
  if vùng có stockout nghiêm trọng → loại khỏi mẫu học (log)
  K_history = Q_actual / N_CTKM
Gom theo nhóm tương tự (SKU + nơi bán + loại CTKM):
  ≥3 lần → K_locked = Median(K_i), confidence='auto'
  2 lần  → median/mean, confidence='low'
  1 lần  → chỉ gợi ý ('suggest-only'), 0 lần → none
Giới hạn an toàn: K<1 → đặt 1,00 (P27) hoặc chuyển kiểm tra; K quá cao → cắt trần + duyệt C18
```

**Test:** §8 — K = 1,50; 1,40; 1,50 → median 1,50.

### Chặng 13 — Áp kế hoạch CTKM tương lai `[C13]`

```text
∀ chu kỳ tương lai c:
  không có kế hoạch CTKM đã xác nhận → F_final = F_base
  có kế hoạch nhưng K không đủ tin cậy & không có hệ số thủ công duyệt → F_final=F_base + đưa vào 'cần duyệt'
  CTKM cả chu kỳ:   F_final = F_base × K
  CTKM n ngày/15:   F_KM = F_base × n/15;  F_nonKM = F_base − F_KM
                    F_final = F_nonKM + F_KM × K
```

Không bê số bán CTKM lịch sử sang tương lai; hệ số nhân vào **nền tương lai**.
**Test:** §6 — nền 150, 5 ngày KM, K=1,5 → 100 + 50×1,5 = 175.

### Chặng 14 — Lịch nguồn hàng & vị thế tồn `[C14]`

```text
∀ mốc thời gian t (gửi đơn, tàu đi, tàu đến, hàng về kho, mốc bổ sung kế tiếp):
  I_free(t) = onHand + Σ inbound XÁC NHẬN về trước t − Σ cam kết trước t
Lô chưa có ngày về kho → KHÔNG cộng vào hàng tự do; ghi 'chưa đủ căn cứ nguồn hàng' → C18.
```

**Test:** 100 + 50 − 30 = 120.

### Chặng 15 — Tồn kho an toàn `[C15]`

```text
Quy đổi đơn vị: LT̄_cycle = LT̄_day/15; σ_LT,cycle = σ_LT,day/15   // BẮT BUỘC cùng đơn vị chu kỳ
Z  = tra bảng P28 theo mức phục vụ (từ Chặng 8)
D̄  = mean(F_final các chu kỳ trong vùng cần bảo vệ)               // từ C13, KHÔNG từ doanh số thô
σ_d = stdev MẪU (n−1) của sai số backtest e_c = Y_c − F_c          // ưu tiên;
      fallback = stdev của baseDemandCycle (chu kỳ khóa) + ghi 'tin cậy thấp hơn'
SS_full    = Z × sqrt( LT̄×σ_d² + D̄²×σ_LT² )                       // công thức CHÍNH THỨC
SS_reduced = Z × σ_d × sqrt(LT̄)                                    // chỉ khi σ_LT=0 theo ngoại lệ đã duyệt
Cảnh báo (không tự cắt): vượt trần tồn / hạn dùng / vốn / sức chứa → C17/C18
```

**Test:** §6 — Z=1,65; D̄=120; σ_d=30; LT̄=8; σ_LT=1,2 → 8×900=7 200; 14 400×1,44=20 736; √27 936≈167,14; SS≈275,78→276. Rút gọn chỉ cho 140 → chứng minh phải dùng công thức đầy đủ.

### Chặng 16 — Số đặt trước ngân sách & làm tròn MOQ `[C16]` *(chưa mô phỏng)*

```text
Q_raw   = max(0, D_cover + SS − I_free)
Q_order = ceil(Q_raw / MOQ) × MOQ;  dư = Q_order − Q_raw (cảnh báo nếu vượt ngưỡng)
Thiếu MOQ/quy cách → không phát hành tự động.
```
Test: 500+90−220=370 → ceil(370/24)×24=384, dư 14.

### Chặng 17 — Phân bổ ngân sách `[C17]` *(chưa mô phỏng)*

`P = w₁·S_ABC/XYZ + w₂·S_danhmục + w₃·S_thiếuhàng + w₄·S_leadtime`; đủ ngân sách → cấp hết; thiếu → sắp theo P giảm dần, cấp đến hết; dòng không đủ MOQ không phát hành phần lẻ; log dòng cắt/hoãn.

### Chặng 18 — Duyệt ngoại lệ & phát hành `[C18]` *(chưa mô phỏng)*

3 nhánh: không phát hành (Q=0) / chờ bổ sung-chờ duyệt (thiếu thông tin, dư MOQ vượt ngưỡng, tăng bất thường, hạn dùng ngắn, hệ số KM tin cậy thấp, vượt ngân sách) / phát hành. Không tính lại số đặt.

### Chặng 19 — Đo kết quả & đề xuất kỳ sau `[C19]` *(chưa mô phỏng)*

Đo sai số theo lớp nguyên nhân (dữ liệu nền / phân loại / dự báo / nguồn hàng / tồn an toàn / MOQ / ngân sách / duyệt); `WAPE = Σ|A−F|/ΣA × 100%`; chỉ tạo đề xuất phiên bản tương lai, không sửa ngược.

---

## 4. Hợp đồng bàn giao giữa các chặng (tóm tắt)

| Từ → Đến | Dữ liệu | Ràng buộc |
|---|---|---|
| C1 → C2..C5 | khung lịch, lịch chu kỳ cố định, dữ liệu ngày | không đổi nhịp chu kỳ theo số bản ghi |
| C2 → C3 | isStockout + lý do | chỉ 2 điều kiện |
| C3 → C4 | baseDemand ngày không CTKM; danh sách ngày CTKM `promo-defer` | ngày CTKM chưa có nền |
| C4 → C5 | baseDemand ngày CTKM + nhãn nguồn `promo-normalized` | nhãn nguồn không được xóa |
| C5 → C6..C11 | CycleRecord `locked` | chặng sau chỉ đọc locked |
| C6,C7 → C8 | abc, xyz | D ngoài ma trận |
| C8 → C15/C17/C18 | serviceLevel, ưu tiên vốn | có phiên bản chính sách |
| C9,C10 → C11 | công tắc mô hình nhóm Y | C11 không tự lọc lại chuỗi |
| C11 → C13,C15 | baseForecast + lockStatus | chưa áp CTKM |
| C12 → C13 | K + confidence | K<1 → sàn 1,0 |
| C13 → C15,C16 | F_final | C15 không tính lại CTKM |
| C14 → C15,C16 | I_free theo mốc, LT̄, σ_LT | lô chưa xác nhận không cộng |
| C15 → C16,C17 | SS + cảnh báo | không tự cắt vì vốn |

---

## 5. Yêu cầu giao diện mô phỏng (để "nhìn thấy từng bước")

1. Mỗi chặng hiển thị: **Đầu vào → Quy tắc (công thức đúng tài liệu) → Phép tính thế số → Kết quả → Trạng thái khóa/kiểm toán**.
2. Bảng kiểm toán cấp ngày (Pha 1): click 1 dòng kết quả → highlight ngày méo + ngày tham chiếu trước/sau.
3. Bảng chu kỳ hiển thị trạng thái `locked / trống / không đủ căn cứ`, số ngày theo từng nguồn.
4. Chặng 9: bảng 24 vị trí × vòng dạng `sứcMua / tỷLệ`.
5. Chặng 11: bảng học từng chu kỳ (L, T, S, F kèm công thức thế số ở tooltip), phân kỳ TRAIN/TEST, 4 chỉ tiêu sai số + ngưỡng + trạng thái khóa.
6. Chặng 12–15: bảng hệ số KM từng vùng, bảng áp CTKM từng chu kỳ tương lai, bảng vị thế tồn theo mốc, bảng thế số SS.

## 6. Bộ kiểm thử chấp nhận (acceptance tests)

| # | Chặng | Kịch bản | Kỳ vọng |
|---|---|---|---|
| T01 | 1 | run 01/06/2026 | 1247 ngày, 83 CK, dư 2 |
| T02 | 2 | openStock=0, closeStock>0, firstReceipt 13:00 (>10:00) | stockout |
| T03 | 2 | openStock=0, closeStock=0, sales=0 | stockout (không ngoại lệ theo loại SKU) |
| T04 | 3 | refs 18,20,21,19; sales=8 | nền 19,5, balanced |
| T05 | 3 | chỉ 3 ngày trước 17,18,20 | nền 18, temporary |
| T06 | 4 | FLASH20 bị BEAUTY chặn, 6 trước/4 sau | k=4, median 5,5, balanced |
| T07 | 4 | sales CTKM 43 > nền 21,5 | baseDemand = 21,5 (KHÔNG max) |
| T08 | 5 | chu kỳ 0 ngày căn cứ | emptyCycle, không lấp, không dùng |
| T09 | 5 | chu kỳ thiếu 2 ngày, lấp được | locked, technicalFillDays=2 |
| T10 | 6 | 5 SKU ví dụ §9; C bắt đầu khi lũy kế >=90% | A={B001,A001}; B={C001}; C={D001,E001} |
| T11 | 7 | 0,0,30,0,0,25 | Z (ADI=3) |
| T12 | 7 | y=30,25 | σ=2,5 (chia m) |
| T13 | 9 | 3 vòng ratio 1.45/1.50/1.40 | LẶP CAO, S=1,45 |
| T14 | 9 | 3 vòng trung tính 1.13/1.09/1.10 | CHƯA RÕ dù lặp 100% |
| T15 | 10 | g₁=7%, g₂=30% | xu hướng tăng, cắt 15%, cần xem xét |
| T16 | 11 | Croston: phát sinh đầu tại CK3 | F=null trước lần 2; P đầu = t₂−t₁ |
| T17 | 11 | 93 mỗi 3 CK từ CK3, r≥3 | nhịp D=3, Q=93; CK21=93, CK19,20=0 |
| T18 | 12 | K=1,5/1,4/1,5 | K_locked=1,5 auto |
| T19 | 13 | nền 150, KM 5/15 ngày, K=1,5 | F_final=175 |
| T20 | 14 | 100+50−30 | I_free=120 |
| T21 | 15 | ví dụ §6 | SS=276; rút gọn=140 |

## 7. Ghi chú sai lệch đã phát hiện trong tài liệu giải pháp

Xem file `Báo cáo rà soát và đề xuất.md` — các điểm cần chủ sở hữu tài liệu quyết định (đánh số thiếu mục, bảng bàn giao lệch số chặng, ràng buộc α mâu thuẫn giữa C11 §5.3 và §5.5, v.v.). **Tài liệu giải pháp không được tự ý sửa.**

## 8. Nhánh 11XY-SN — Seasonal-naïve chu kỳ lặp ngắn (đồng bộ theo Tài liệu giải pháp C11 mục 8, cập nhật 2026-07-06)

> Lịch sử: mục này ban đầu là "Sửa đổi C11 §8.7" theo Đề xuất D.4-1 (bản vá phạm vi mô phỏng). Tài liệu giải pháp nay đã ban hành đặc tả chính thức tại **C11 mục 8 (nhánh 11XY-SN)**; nội dung dưới đây theo đúng đặc tả đó và thay thế bản vá cũ.

1. **Cửa kiểm tra đặt sau MỌI nhánh X/Y** [C11 sơ đồ mục 13]: kể cả khi nhánh đang thắng là Holt hoặc Holt-Winters, không chỉ nhánh SES mặc định.
2. **Dò chu kỳ lặp** [C11 §8.5]: trên đúng tập TRAIN, tính **tương quan Pearson giữa dãy A = Y_{p+1..T} và dãy B = Y_{1..T−p}** (hai trung bình riêng Ā/B̄, mẫu số `√(ΣA²·ΣB²)`) cho `p ∈ [2..12]`, chỉ xét p đủ 2 vòng lặp (`2p ≤ n_TRAIN`). Chọn `p* = argmax r(p)`; **gần như hòa → ưu tiên p nhỏ** (dung sai khởi điểm 0,05) [C11 §8.8]. Toàn bộ danh sách r(p) đã thử được lưu làm bằng chứng (`rpScan`) [C11 §8.12].
3. **Điều kiện kích hoạt**: `r(p*) ≥ 0,60` (ngưỡng khởi điểm đề xuất của tài liệu, chưa phải ngưỡng phê duyệt) [C11 §8.7].
4. **Mô hình** [C11 §8.9]: `Fₜ = Yₜ₋ₚ*`; **F = null trong p\* chu kỳ đầu** (chưa có vòng lặp trước — không dự báo khi thiếu căn cứ). Tương lai lặp mẫu p\* giá trị cuối; **chu kỳ nguồn được sao chép** của từng F tương lai được lưu (`futureSources`) [C11 §8.12].
5. **Điều kiện chọn** [C11 §8.10]: WAPE TEST của Seasonal-naïve phải **nhỏ hơn CHẶT** WAPE TEST của **mô hình đối chứng đang thắng** của nhánh (SES/Holt/Holt-Winters tùy bối cảnh); hòa hoặc thua → giữ mô hình đối chứng [SN-08]. Nếu **TEST < 3 chu kỳ** → gắn cờ `ĐỘ TIN CẬY THẤP — KHÔNG DÙNG ĐỂ SO MÔ HÌNH TỰ ĐỘNG`, SN chỉ tính sai số tham khảo, giữ đối chứng [C11 §8.10, mục 12, SN-04].
6. **Quy tắc thắng chung đi kèm** [C11 §4.3 bước 7, §4.5]: Holt phải thắng SES (cả nhánh Y-xu hướng); Holt-Winters phải thắng Holt/SES; thua → fallback đúng thứ tự HW → Holt → SES. SES tối ưu α trong miền `0,05 ≤ α ≤ 0,5` [C11 §5.5]; Holt/HW ràng buộc `β ≤ α`, HW thêm `γ ≤ 1−α` [C11 §4.2].
7. Trạng thái khóa vẫn tuân P25 (REVIEW cho đến khi ngưỡng chính thức được ban hành). Không áp dụng cho nhóm Z (mục 9 nhóm Z) và nhóm D.

Ca kiểm thử bắt buộc: SN-01..SN-10 [C11 §8.13] cài tại `forecast-models.spec.ts` (SN-06/SN-07 ngoài phạm vi mô phỏng — chuỗi vào C11 là chu kỳ locked liền mạch từ C5, có ghi chú skip kèm lý do). Số liệu kiểm chứng tại `Báo cáo rà soát và đề xuất.md` Phần D.
