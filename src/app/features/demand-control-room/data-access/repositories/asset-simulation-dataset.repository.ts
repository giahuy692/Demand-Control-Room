import { HttpClient } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SIMULATION_DATASET_ASSETS, SimulationDatasetKind, SimulationDatasetRepository } from './simulation-dataset.repository';

@Injectable()
export class AssetSimulationDatasetRepository implements SimulationDatasetRepository {
  constructor(
    private readonly http: HttpClient,
    @Inject(SIMULATION_DATASET_ASSETS)
    private readonly assets: Readonly<Record<SimulationDatasetKind, string>>,
  ) {}

  load(kind: SimulationDatasetKind): Promise<unknown> {
    return firstValueFrom(this.http.get<unknown>(this.assets[kind]));
  }
}
