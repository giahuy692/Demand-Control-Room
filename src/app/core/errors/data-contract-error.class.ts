/**
 * Lỗi HỢP ĐỒNG dữ liệu — payload không đúng shape/kiểu/định dạng đã cam kết
 * (DEMAND-SIMULATION-DATASET-V1). `path` trỏ đúng vị trí phần tử lỗi trong JSON
 * (vd. `salesRecords[12].sales`) để người vận hành sửa nguồn, không sửa app.
 */
export class DataContractError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`[HỢP ĐỒNG DỮ LIỆU] ${path}: ${detail}`);
    this.name = 'DataContractError';
  }
}
