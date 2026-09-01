/**
 * Verifies request correlation, cancellation, and worker lifecycle in WorkerTerrainService.
 * A synchronous fake Worker exposes posted protocol messages and injects typed responses.
 */

import { WorkerTerrainService } from './terrain-service';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from '../workers/terrain-worker-protocol';

/**
 * Minimal controllable Worker test double for the terrain-service protocol.
 * Posted messages remain available until each test responds; termination state is retained.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<TerrainWorkerResponse>) => void) | null = null;
  readonly posted: TerrainWorkerRequest[] = [];
  terminated = false;

  /**
   * Records a message sent by the service.
   * @param message - Typed terrain-worker request.
   */
  postMessage(message: TerrainWorkerRequest): void {
    this.posted.push(message);
  }

  /** Marks the fake worker as terminated. */
  terminate(): void {
    this.terminated = true;
  }

  /**
   * Delivers a typed worker response to the service handler.
   * @param response - Response to expose as message-event data.
   */
  emit(response: TerrainWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<TerrainWorkerResponse>);
  }
}

describe('WorkerTerrainService', () => {
  it('loads GeoTIFF metadata through the worker protocol', async () => {
    const fake = new FakeWorker();
    const service = new WorkerTerrainService(() => fake as unknown as Worker);
    const file = new File(['abc'], 'terrain.tif');
    const promise = service.loadGeoTiff(file);

    expect(fake.posted[0]).toMatchObject({ type: 'load', file });
    fake.emit({
      id: fake.posted[0].id,
      type: 'loaded',
      metadata: {
        fileName: 'terrain.tif',
        fileSize: 3,
        width: 10,
        height: 10,
        bbox: [14, 49, 15, 50],
        resolutionDeg: { longitude: 0.1, latitude: 0.1 },
        samplesPerPixel: 1,
        tileWidth: 10,
        tileHeight: 10,
        noDataValue: null,
        isWgs84: true,
        warnings: []
      }
    });

    await expect(promise).resolves.toMatchObject({ fileName: 'terrain.tif' });
    expect(service.getMetadata()?.width).toBe(10);
  });

  it('cancels pending terrain requests', async () => {
    const fake = new FakeWorker();
    const service = new WorkerTerrainService(() => fake as unknown as Worker);
    const promise = service.sampleElevation(50, 14);

    service.cancelPending();

    await expect(promise).rejects.toThrow('canceled');
    expect(fake.posted[1]).toMatchObject({ type: 'cancel', id: fake.posted[0].id });
  });

  it('cancels LOS evaluation without interrupting an aircraft elevation sample', async () => {
    const fake = new FakeWorker();
    const service = new WorkerTerrainService(() => fake as unknown as Worker);
    const samplePromise = service.sampleElevation(50, 14);
    const evaluationPromise = service.evaluateLineOfSightBatch(
      {
        latitude: 50,
        longitude: 14,
        gpsEllipsoidAltitudeM: 500,
        gpsAltitudeM: 500,
        gpsAltitudeAccuracyM: null,
        gpsAccuracyM: null,
        aglM: null,
        trackDegrees: null,
        trackSource: 'unavailable',
        trackAgeMs: null,
        timestampMs: 1
      },
      [{
        id: 'T001',
        name: 'Alpha',
        latitude: 50,
        longitude: 14.1,
        heightAglM: 10,
        rangeKm: 20
      }]
    );
    const sampleRequest = fake.posted[0];
    const evaluationRequest = fake.posted[1];

    service.cancelEvaluation();

    await expect(evaluationPromise).rejects.toThrow('evaluation was canceled');
    expect(fake.posted[2]).toMatchObject({ type: 'cancel', id: evaluationRequest.id });
    expect(fake.posted).not.toContainEqual(expect.objectContaining({ type: 'cancel', id: sampleRequest.id }));

    fake.emit({
      id: sampleRequest.id,
      type: 'sampled',
      sample: { status: 'ok', elevationM: 320 }
    });
    await expect(samplePromise).resolves.toEqual({ status: 'ok', elevationM: 320 });
  });

  it('evaluates LOS batches through the worker protocol', async () => {
    const fake = new FakeWorker();
    const service = new WorkerTerrainService(() => fake as unknown as Worker);
    const aircraft = {
      latitude: 50,
      longitude: 14,
      gpsEllipsoidAltitudeM: 500,
      gpsAltitudeM: 500,
      gpsAltitudeAccuracyM: null,
      gpsAccuracyM: null,
      aglM: null,
      trackDegrees: null,
      trackSource: 'unavailable' as const,
      trackAgeMs: null,
      timestampMs: 1
    };
    const threat = {
      id: 'T001',
      name: 'Alpha',
      latitude: 50,
      longitude: 14.1,
      heightAglM: 10,
      rangeKm: 20
    };
    const promise = service.evaluateLineOfSightBatch(aircraft, [threat], {
      maxSampleSpacingM: 50
    });

    expect(fake.posted[0]).toMatchObject({ type: 'los-batch', threats: [threat] });
    fake.emit({
      id: fake.posted[0].id,
      type: 'los-batch-result',
      results: [{ threatId: 'T001', result: { status: 'clear', sampleCount: 3 } }]
    });

    await expect(promise).resolves.toEqual([
      { threatId: 'T001', result: { status: 'clear', sampleCount: 3 } }
    ]);
  });
});
