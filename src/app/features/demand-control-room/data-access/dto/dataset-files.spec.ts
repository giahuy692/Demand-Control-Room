import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DailyHistoryRecordDto } from './daily-history-record.dto';
import { DemandSimulationDatasetDto } from './demand-simulation-dataset.dto';
import { ProductDto } from './product.dto';

/**
 * §12.2/§12.9–10 — HAI file dataset runtime thật sự trên đĩa phải qua được đúng
 * DTO factory mà app dùng lúc nạp. Test này đọc file đã build (npm run data:build);
 * fail ở đây = asset đang ship hỏng, không phải lỗi logic.
 */
describe('mock.dataset.json + real.dataset.json qua DemandSimulationDatasetDto', () => {
  it.each([
    ['src/assets/demand-planning/datasets/mock.dataset.json', 'MOCK'],
    ['src/assets/demand-planning/datasets/real.dataset.json', 'REAL'],
  ] as const)('%s → cây class instance đầy đủ (%s)', (path, kind) => {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const dto = DemandSimulationDatasetDto.fromUnknown(parsed);
    expect(dto.datasetKind).toBe(kind);
    expect(dto.products.length).toBeGreaterThan(0);
    expect(dto.dailyRecords.length).toBeGreaterThan(0);
    // Toàn bộ record được instantiate thành class — không có object thô lọt qua.
    expect(dto.products.every(product => product instanceof ProductDto)).toBe(true);
    expect(dto.dailyRecords.every(record => record instanceof DailyHistoryRecordDto)).toBe(true);
  });
});
