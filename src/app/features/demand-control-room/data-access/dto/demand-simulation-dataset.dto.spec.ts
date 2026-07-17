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
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ productCode: 999 })] });
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

  it('sản phẩm trùng id bị chặn', () => {
    const raw = fixtureDataset({ products: [fixtureProduct(), fixtureProduct()], dailyRecords: [fixtureDailyRecord()] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/DUPLICATE_PRODUCT/);
  });

  it('bất biến DEEP_PROMO ⇔ mechanismType ∈ {2,7}: DEEP_PROMO với mechanismType khác bị chặn', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ promotionCode: 101, promotionClass: 'DEEP_PROMO', promotionMechanismType: 1 })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/DEEP_PROMO nhưng promotionMechanismType=1/);
  });

  it('bất biến DEEP_PROMO ⇔ mechanismType ∈ {2,7}: mechanismType=7 mà khai ALWAYS_ON bị chặn', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ promotionCode: 101, promotionClass: 'ALWAYS_ON', promotionMechanismType: 7 })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/phải là DEEP_PROMO/);
  });

  it('NO_PROMOTION kèm promotionCode bị chặn — ngày có CTKM phải mang class thật', () => {
    const raw = fixtureDataset({ dailyRecords: [fixtureDailyRecord({ promotionCode: 101, promotionClass: 'NO_PROMOTION' })] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).toThrowError(/NO_PROMOTION nhưng promotionCode=101/);
  });

  it('mechanismType 2/7 hợp lệ với DEEP_PROMO; ALWAYS_ON hợp lệ với mechanism khác — mock/real cùng một luật', () => {
    const raw = fixtureDataset({
      dailyRecords: [
        fixtureDailyRecord({ date: '2026-05-01', promotionCode: 101, promotionClass: 'DEEP_PROMO', promotionMechanismType: 2 }),
        fixtureDailyRecord({ date: '2026-05-02', promotionCode: 102, promotionClass: 'ALWAYS_ON', promotionMechanismType: 1, openStock: 8, closeStock: 8 }),
      ],
    });
    expect(() => DemandSimulationDatasetDto.fromUnknown(raw)).not.toThrow();
  });

  it('promotion interval mang promotionClass không hợp lệ bị chặn; vắng mặt mặc định DEEP_PROMO (tương thích ngược)', () => {
    const bad = fixtureDataset({ promotionIntervals: [{ sku: null, code: 'KM01', name: null, startDate: '2026-06-01', endDate: '2026-06-10', promotionClass: 'GIẢM_SÂU' }] });
    expect(() => DemandSimulationDatasetDto.fromUnknown(bad)).toThrowError(DataContractError);
    const legacy = fixtureDataset({ promotionIntervals: [{ sku: null, code: 'KM01', name: null, startDate: '2026-06-01', endDate: '2026-06-10' }] });
    expect(DemandSimulationDatasetDto.fromUnknown(legacy).promotionIntervals[0].promotionClass).toBe('DEEP_PROMO');
  });
});
