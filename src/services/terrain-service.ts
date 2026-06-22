import type {
  AircraftState,
  LineOfSightOptions,
  LineOfSightBatchResult,
  LineOfSightResult,
  TerrainMetadata,
  TerrainSample,
  TerrainService,
  Threat
} from '../domain/types';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from '../workers/terrain-worker-protocol';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export type TerrainWorkerFactory = () => Worker;

export class WorkerTerrainService implements TerrainService {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private metadata: TerrainMetadata | null = null;
  private requestCounter = 0;

  constructor(workerFactory: TerrainWorkerFactory = createDefaultTerrainWorker) {
    this.worker = workerFactory();
    this.worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    };
  }

  async loadGeoTiff(file: File): Promise<TerrainMetadata> {
    const metadata = await this.request<TerrainMetadata>({
      id: this.nextId(),
      type: 'load',
      file
    });
    this.metadata = metadata;
    return metadata;
  }

  getMetadata(): TerrainMetadata | null {
    return this.metadata;
  }

  sampleElevation(latitude: number, longitude: number): Promise<TerrainSample> {
    return this.request<TerrainSample>({
      id: this.nextId(),
      type: 'sample',
      latitude,
      longitude
    });
  }

  evaluateLineOfSight(
    aircraft: AircraftState,
    threat: Threat,
    options?: LineOfSightOptions
  ): Promise<LineOfSightResult> {
    return this.request<LineOfSightResult>({
      id: this.nextId(),
      type: 'los',
      aircraft,
      threat,
      options
    });
  }

  evaluateLineOfSightBatch(
    aircraft: AircraftState,
    threats: Threat[],
    options?: LineOfSightOptions
  ): Promise<LineOfSightBatchResult[]> {
    return this.request<LineOfSightBatchResult[]>({
      id: this.nextId(),
      type: 'los-batch',
      aircraft,
      threats,
      options
    });
  }

  cancelPending(): void {
    for (const [id, pending] of this.pending.entries()) {
      this.worker.postMessage({ id, type: 'cancel' } satisfies TerrainWorkerRequest);
      pending.reject(new Error('Terrain request was canceled.'));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.cancelPending();
    this.worker.terminate();
  }

  private request<T>(message: TerrainWorkerRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      this.worker.postMessage(message);
    });
  }

  private handleWorkerMessage(message: TerrainWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
      return;
    }

    if (message.type === 'loaded') {
      pending.resolve(message.metadata);
      return;
    }

    if (message.type === 'sampled') {
      pending.resolve(message.sample);
      return;
    }

    if (message.type === 'los-result') {
      pending.resolve(message.result);
      return;
    }

    pending.resolve(message.results);
  }

  private nextId(): string {
    this.requestCounter += 1;
    return `terrain-${this.requestCounter}`;
  }
}

function createDefaultTerrainWorker(): Worker {
  return new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' });
}
