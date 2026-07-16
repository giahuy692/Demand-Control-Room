import { InjectionToken } from '@angular/core';

export type SimulationDatasetKind = 'MOCK' | 'REAL';

/** Map kind → đường dẫn asset. Component/store KHÔNG được biết các đường dẫn này. */
export const SIMULATION_DATASET_ASSETS = new InjectionToken<Readonly<Record<SimulationDatasetKind, string>>>('SIMULATION_DATASET_ASSETS');

/** Cổng lấy payload dataset thô (`unknown`) — chưa parse, chưa validate. */
export abstract class SimulationDatasetRepository {
  abstract load(kind: SimulationDatasetKind): Promise<unknown>;
}
