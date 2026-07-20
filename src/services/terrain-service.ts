/**
 * Provides the main-thread TerrainService implementation backed by a dedicated web worker.
 * Requests are correlated by generated IDs; pending promises remain owned until reply or cancellation.
 */

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

/**
 * Coordinates typed terrain requests with the GeoTIFF worker and caches loaded metadata.
 * The worker lives from construction until `dispose`; cancellation rejects every unresolved promise.
 */
export class WorkerTerrainService implements TerrainService {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private metadata: TerrainMetadata | null = null;
  private requestCounter = 0;

  /**
   * Creates the service and attaches its worker response handler.
   * @param workerFactory - Factory used to create the terrain worker, injectable for tests.
   * @throws {Error} When the worker factory cannot construct a worker.
   */
  constructor(workerFactory: TerrainWorkerFactory = createDefaultTerrainWorker) {
    this.worker = workerFactory();
    this.worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    };
  }

  /**
   * Loads a GeoTIFF in the worker and caches its validated metadata.
   * @param file - GeoTIFF file selected by the user.
   * @returns Metadata for the active terrain file.
   * @throws {Error} When the worker cannot load or validate the file.
   */
  async loadGeoTiff(file: File): Promise<TerrainMetadata> {
    const metadata = await this.request<TerrainMetadata>({
      id: this.nextId(),
      type: 'load',
      file
    });
    this.metadata = metadata;
    return metadata;
  }

  /**
   * Gets metadata for the currently loaded terrain.
   * @returns Loaded metadata, or `null` before a successful load.
   */
  getMetadata(): TerrainMetadata | null {
    return this.metadata;
  }

  /**
   * Samples terrain elevation at a WGS84 coordinate in the worker.
   * @param latitude - Latitude in degrees.
   * @param longitude - Longitude in degrees.
   * @returns The elevation sample or an unavailable reason.
   * @throws {Error} When the request is canceled or the worker reports an error.
   */
  sampleElevation(latitude: number, longitude: number): Promise<TerrainSample> {
    return this.request<TerrainSample>({
      id: this.nextId(),
      type: 'sample',
      latitude,
      longitude
    });
  }

  /**
   * Evaluates terrain line of sight for one threat in the worker.
   * @param aircraft - Current aircraft state.
   * @param threat - Threat to evaluate.
   * @param options - Optional sampling controls.
   * @returns The line-of-sight result.
   * @throws {Error} When the request is canceled or the worker reports an error.
   */
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

  /**
   * Evaluates terrain line of sight for multiple threats in one worker request.
   * @param aircraft - Current aircraft state.
   * @param threats - Threats to evaluate.
   * @param options - Optional sampling controls.
   * @returns Results associated with their threat IDs.
   * @throws {Error} When the request is canceled or the worker reports an error.
   */
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

  /** Cancels and rejects every unresolved worker request. */
  cancelPending(): void {
    for (const [id, pending] of this.pending.entries()) {
      this.worker.postMessage({ id, type: 'cancel' } satisfies TerrainWorkerRequest);
      pending.reject(new Error('Terrain request was canceled.'));
    }
    this.pending.clear();
  }

  /** Terminates the worker after canceling unresolved requests. */
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
