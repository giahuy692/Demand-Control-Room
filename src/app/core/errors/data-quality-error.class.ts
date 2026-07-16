/**
 * Lỗi CHẤT LƯỢNG dữ liệu — payload đúng shape nhưng vi phạm bất biến nghiệp vụ
 * chéo bản ghi (trùng khóa, lệch cohort, gate đối soát FAIL, ngoài watermark…).
 * Không bao giờ được tự sửa (null→0, bỏ record, fallback mock) — chỉ báo lỗi thật.
 */
export class DataQualityError extends Error {
  constructor(readonly gate: string, detail: string) {
    super(`[CHẤT LƯỢNG DỮ LIỆU][${gate}] ${detail}`);
    this.name = 'DataQualityError';
  }
}
