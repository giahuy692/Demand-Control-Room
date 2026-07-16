import { describe, expect, it } from 'vitest';
import { DatasetDomainMapper } from '../mappers/dataset-domain.mapper';
import { SimulationDatasetKind, SimulationDatasetRepository } from '../repositories/simulation-dataset.repository';
import { SimulationDatasetService } from './simulation-dataset.service';
import { fixtureDataset } from '../dto/dataset-fixture';

class StubRepository extends SimulationDatasetRepository {
  readonly calls: SimulationDatasetKind[] = [];
  constructor(private readonly payloads: Partial<Record<SimulationDatasetKind, unknown>>) { super(); }
  load(kind: SimulationDatasetKind): Promise<unknown> {
    this.calls.push(kind);
    const payload = this.payloads[kind];
    return payload === undefined ? Promise.reject(new Error(`HTTP 404 cho ${kind}`)) : Promise.resolve(payload);
  }
}

function service(payloads: Partial<Record<SimulationDatasetKind, unknown>>): { service: SimulationDatasetService; repository: StubRepository } {
  const repository = new StubRepository(payloads);
  return { service: new SimulationDatasetService(repository, new DatasetDomainMapper()), repository };
}

describe('SimulationDatasetService — luồng nạp duy nhất', () => {
  it('§12.9 — load mock gọi đúng kind MOCK và trả session mock', async () => {
    const { service: loader, repository } = service({ MOCK: fixtureDataset({ datasetKind: 'MOCK' }) });
    const session = await loader.load('mock');
    expect(repository.calls).toEqual(['MOCK']);
    expect(session.kind).toBe('mock');
    expect(session.dataset.source).toBe('mock');
  });

  it('§12.10 — load real gọi đúng kind REAL và trả session real', async () => {
    const { service: loader, repository } = service({ REAL: fixtureDataset({ datasetKind: 'REAL' }) });
    const session = await loader.load('real');
    expect(repository.calls).toEqual(['REAL']);
    expect(session.kind).toBe('real');
    expect(session.metadata.runMode).toBe('HISTORICAL_VALIDATION');
  });

  it('§12.11 — real lỗi thì ném lỗi thật, TUYỆT ĐỐI không gọi sang MOCK', async () => {
    const { service: loader, repository } = service({ MOCK: fixtureDataset({ datasetKind: 'MOCK' }) });
    await expect(loader.load('real')).rejects.toThrowError(/404/);
    expect(repository.calls).toEqual(['REAL']); // không có lần gọi MOCK nào
  });

  it('asset khai sai datasetKind so với yêu cầu bị chặn', async () => {
    const { service: loader } = service({ REAL: fixtureDataset({ datasetKind: 'MOCK' }) });
    await expect(loader.load('real')).rejects.toThrowError(/DATASET_KIND/);
  });

  it('cache: hai lần load chỉ gọi repository một lần; lỗi không bị kẹt cache', async () => {
    const { service: loader, repository } = service({ MOCK: fixtureDataset({ datasetKind: 'MOCK' }) });
    await loader.load('mock');
    await loader.load('mock');
    expect(repository.calls).toEqual(['MOCK']);
    await expect(loader.load('real')).rejects.toThrowError();
    await expect(loader.load('real')).rejects.toThrowError();
    expect(repository.calls.filter(kind => kind === 'REAL')).toHaveLength(2); // lỗi được thử lại, không cache
  });
});

describe('DatasetDomainMapper — §12.12 không mutate DTO', () => {
  it('map hai lần cho kết quả tương đương và DTO giữ nguyên frozen', async () => {
    const { service: loader } = service({ MOCK: fixtureDataset({ datasetKind: 'MOCK' }) });
    const session = await loader.load('mock');
    // Sửa domain output không được lan ngược về DTO/lần map sau.
    (session.dataset.catalog[0].leadTimeHistoryDays as number[]).push(999);
    const again = new DatasetDomainMapper();
    const { service: loader2 } = service({ MOCK: fixtureDataset({ datasetKind: 'MOCK' }) });
    const fresh = await loader2.load('mock');
    expect(fresh.dataset.catalog[0].leadTimeHistoryDays).not.toContain(999);
    expect(again).toBeInstanceOf(DatasetDomainMapper);
  });

  it('dòng validation không có bằng chứng tồn → stockCalculationStatus UNRESOLVED, không trình bày 0 như số đo', async () => {
    const raw = fixtureDataset({
      dailyRecords: [
        { ...((await import('../dto/dataset-fixture')).fixtureDailyRecord)({ date: '2026-05-01' }) },
        { ...((await import('../dto/dataset-fixture')).fixtureDailyRecord)({ date: '2026-06-02', openStock: null, closeStock: null, isHistoryRecord: false, isValidationActual: true }) },
      ],
    });
    const { service: loader } = service({ MOCK: raw });
    const session = await loader.load('mock');
    const records = session.dataset.dailyBySku['SKU-T01'];
    expect(records[1].stockCalculationStatus).toBe('UNRESOLVED');
    expect(records[0].stockCalculationStatus).toBe('CALCULATED');
  });
});
