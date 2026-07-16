import { provideHttpClient } from '@angular/common/http';
import { EnvironmentProviders, Provider } from '@angular/core';
import { AssetSimulationDatasetRepository } from './data-access/repositories/asset-simulation-dataset.repository';
import { SIMULATION_DATASET_ASSETS, SimulationDatasetRepository } from './data-access/repositories/simulation-dataset.repository';

/** Wiring của feature Demand Control Room — nơi DUY NHẤT biết đường dẫn asset dataset. */
export function provideDemandControlRoom(): (Provider | EnvironmentProviders)[] {
  return [
    provideHttpClient(),
    {
      provide: SIMULATION_DATASET_ASSETS,
      useValue: {
        MOCK: 'assets/demand-planning/datasets/mock.dataset.json',
        REAL: 'assets/demand-planning/datasets/real.dataset.json',
      },
    },
    AssetSimulationDatasetRepository,
    { provide: SimulationDatasetRepository, useExisting: AssetSimulationDatasetRepository },
  ];
}
