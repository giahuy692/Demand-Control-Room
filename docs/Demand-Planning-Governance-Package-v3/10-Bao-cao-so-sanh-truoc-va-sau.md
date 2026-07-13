# Báo cáo so sánh trước và sau điều chỉnh

> File mẫu. Điền sau khi code được sửa và chạy lại cùng snapshot dữ liệu.

## 1. Thông tin phiên

| Trường | Trước | Sau |
|---|---|---|
| Query version | | |
| Engine version | | |
| RunMode | | |
| PortfolioMode | | |
| SKU count | | |
| Processing range | | |

## 2. Chất lượng Chặng 1–5

| Chỉ số | Trước | Sau | Giải thích |
|---|---:|---:|---|
| Ngày scaffold bị hiểu là Sales=0 | | | |
| Chu kỳ đúng 15 ngày lịch | | | |
| Chu kỳ `NO_SOURCE_RECORD` | | | |
| Chu kỳ `BASELINE_UNRESOLVED` | | | |
| Chu kỳ `LOCKED_OBSERVED` | | | |
| Chu kỳ `LOCKED_ADJUSTED` | | | |
| Chu kỳ `LOCKED_FALLBACK` | | |
| SKU có chuỗi CK bị nén sai | | |
| SKU đạt cổng ABC | | |
| SKU đạt cửa sổ XYZ liên tục | | |
| SKU bị `INSUFFICIENT_CONTINUOUS_BASELINE_HISTORY` | | | |
| Ngày CTKM unresolved | | | |
| Ngày stockout unresolved | | | |

## 3. Phân loại

| Chỉ số | Trước | Sau |
|---|---:|---:|
| SKU có ABC official | | |
| SKU chỉ có ABC simulation | | |
| X | | |
| Y | | |
| Z | | |
| D_NEW | | |
| D_NEW/D_TRUE_SHORT_HISTORY | | |
| DemandClass=null do baseline/continuity blocked | | |

## 4. Trạng thái chặng

| Chặng | LOCKED | REVIEW | BLOCKED | NOT_EVALUATED |
|---:|---:|---:|---:|---:|
| 1 | | | | |
| 2 | | | | |
| ... | | | | |
| 19 | | | | |

## 5. Regression SKU thật

Ghi riêng SKU 31054 và các SKU đại diện. Mỗi thay đổi phải liên kết rule và golden test.
