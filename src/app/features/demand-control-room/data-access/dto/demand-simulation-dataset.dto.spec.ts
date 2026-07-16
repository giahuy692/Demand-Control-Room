import { describe, expect, it } from 'vitest';
import { DataContractError } from '../../../../core/errors/data-contract-error.class';
import { DataQualityError } from '../../../../core/errors/data-quality-error.class';
import { DailyHistoryRecordDto } from './daily-history-record.dto';
import { DemandSimulationDatasetDto } from './demand-simulation-dataset.dto';
import { ProductDto } from './product.dto';
import { fixtureDailyRecord, fixtureDataset, fixtureProduct } from './dataset-fixture';

describe('DemandSimulationDatasetDto — hợp đồng DEMAND-SIMULATION-DATASET-V1', () => {
  it('§12.1 — JSON object thuần KHÔNG tự là class; chỉ fromUnknown tạo instance', () => {
    const raw = fixtureDataset();
    expect(raw instanceof DemandSimulationDatasetDto).toBe(false);
    const dto = DemandSimulationDatasetDto.fromUnknown(raw);
    expect(dto).toBeInstanceOf(DemandSimulationDatasetDto);
    expect(Object.isFrozen(dto)).toBe(true);
  });

  it('§12.2 — MOCK và REAL đi qua CÙNG factory, đều thành cây class instance', () => {
    for (const kind of ['MOCK', 'REAL'] as const) {
      const dto = DemandSimulationDatasetDto.fromUnknown(fixtureDataset({ datasetKind: kind }));
      expect(dto.datasetKind).toBe(kind);
      expect(dto.products[0]).toBeInstanceOf(ProductDto);
      expect(dto.dailyRecords[0]).toBeInstanceOf(DailyHistoryRecordDto);
    }
  });

  it('§12.3 — null khác 0: hasSalesRecord=false đòi sales=null ở cả hai chiều', () => {
    const zeroInsteadOfNull = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ sales: 0, hasSalesRecord: false })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(zeroInsteadOfNull)).toThrowError(/bất biến null\/0/);
    const nullWithFlag = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ sales: null, hasSalesRecord: true })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(nullWithFlag)).toThrowError(DataContractError);
    const legitNull = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ sales: null, hasSalesRecord: false })] });
    expect(DemandSimulationDatasetDto.fromUnknown(legitNull).dailyRecords[0].sales).toBeNull();
  });

  it('§12.4 — boolean "0"/"1" dạng chuỗi bị từ chối (hợp đồng V1 chỉ nhận boolean JSON)', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ hasSalesRecord: '1' })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(DataContractError);
  });

  it('§12.5 — ngày sai định dạng/không có thật bị chặn kèm path', () => {
    for (const bad of ['2026-6-1', '2026-02-30', '01/06/2026']) {
      const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ date: bad })] });
      expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/dailyRecords\[0\]\.date/);
    }
  });

  it('§12.6 — trùng khóa sku+date bị chặn, không giữ-bản-ghi-cuối', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord(), fixtureDailyRecord()] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/DUPLICATE_DAILY_KEY/);
  });

  it('§12.7 — contract version lạ dừng ngay, không đoán cấu trúc', () => {
    const raw = fixtureDataset({ root: { contractVersion: 'DEMAND-SIMULATION-DATASET-V2' } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/DEMAND-SIMULATION-DATASET-V1/);
  });

  it('§12.8 — NaN/Infinity bị chặn (payload 1e999 parse thành Infinity)', () => {
    const raw = JSON.parse(JSON.stringify(fixtureDataset()).replace('"openStock":10', '"openStock":1e999')) as unknown;
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/hữu hạn/);
  });

  it('§3.9 — gate đối soát tồn FAIL chặn nạp dataset, kể cả MOCK', () => {
    const raw = fixtureDataset({ metadata: { qualityGates: { stockReconciliation: 'FAIL', stockMismatchSkuCount: 3 } } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(DataQualityError);
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/3 SKU lệch tồn/);
  });

  it('§3.7 — REAL: runDate vượt watermark nguồn bị chặn, không tự lùi RunDate', () => {
    const raw = fixtureDataset({ datasetKind: 'REAL', metadata: { runDate: '2026-07-01', sourceWatermarks: { sales: '2026-06-15', stock: '2026-06-20' } } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/RUN_DATE_WATERMARK/);
  });

  it('§3.10 — REAL bắt buộc GLOBAL_WINDOW và HISTORICAL_VALIDATION', () => {
    const preScaffolded = fixtureDataset({ datasetKind: 'REAL', metadata: { calendarScaffold: 'PRESCAFFOLDED' } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(preScaffolded)).toThrowError(/CALENDAR_SCAFFOLD/);
    const planning = fixtureDataset({ datasetKind: 'REAL', metadata: { runMode: 'PLANNING_SIMULATION' } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(planning)).toThrowError(/RUN_MODE/);
  });

  it('§3.14 — dòng ngày mang SKU không có trong products bị chặn', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ sku: 'SKU-KHONG-TON-TAI' })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/UNKNOWN_SKU/);
  });

  it('§3.15 — metadata rowCounts lệch thực tế bị chặn (file đứt giữa chừng)', () => {
    const raw = fixtureDataset({ metadata: { rowCounts: { dailyRecords: 99, products: 1 } } });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/ROW_COUNT/);
  });

  it('§3.13 — promotion interval có startDate > endDate bị chặn', () => {
    const raw = fixtureDataset({ promotionIntervals: [{ sku: null, code: 'KM01', name: null, startDate: '2026-06-10', endDate: '2026-06-01' }] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(DataContractError);
  });

  it('§3.12 — dòng isValidationActual trước runDate bị chặn', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ date: '2026-05-01', isHistoryRecord: false, isValidationActual: true })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/VALIDATION_WINDOW/);
  });

  it('sản phẩm trùng id bị chặn', () => {
    const raw = fixtureDataset({ products: [fixtureProduct(), fixtureProduct()], dailyRecords: [fixtureDailyRecord()] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/DUPLICATE_PRODUCT/);
  });
});
