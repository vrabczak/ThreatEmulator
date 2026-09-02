/**
 * Verifies that terrain-worker point sampling reuses decoded GeoTIFF blocks and resets them on load.
 * GeoTIFF decoding and the worker global are replaced with deterministic in-memory test doubles.
 */

import type { TerrainWorkerRequest, TerrainWorkerResponse } from './terrain-worker-protocol';

const { fromBlobMock } = vi.hoisted(() => ({ fromBlobMock: vi.fn() }));

vi.mock('geotiff', () => ({
  fromBlob: fromBlobMock
}));

describe('terrain worker raster block cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    fromBlobMock.mockReset();
  });

  it('decodes a shared block once and clears it before a replacement load', async () => {
    const readRasters = vi.fn(async (options: { window: number[] }) => {
      const width = options.window[2] - options.window[0];
      const height = options.window[3] - options.window[1];
      return new Int16Array(width * height).fill(123);
    });
    const image = createImage(readRasters);
    fromBlobMock.mockResolvedValue({ getImage: async () => image });
    const worker = await loadWorker();

    worker.send({ id: 'load-1', type: 'load', file: {} as File });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(1));

    worker.send({ id: 'sample-1', type: 'sample', latitude: 49.9, longitude: 14.1 });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(2));
    worker.send({ id: 'sample-2', type: 'sample', latitude: 49.8, longitude: 14.2 });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(3));

    expect(readRasters).toHaveBeenCalledTimes(1);
    expect(readRasters).toHaveBeenCalledWith({
      window: [0, 0, 256, 256],
      samples: [0],
      interleave: true
    });
    expect(worker.responses()[1]).toMatchObject({
      id: 'sample-1',
      type: 'sampled',
      sample: { status: 'ok', elevationM: 123 }
    });
    expect(worker.responses()[2]).toMatchObject({
      id: 'sample-2',
      type: 'sampled',
      sample: { status: 'ok', elevationM: 123 }
    });

    worker.send({ id: 'load-2', type: 'load', file: {} as File });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(4));
    worker.send({ id: 'sample-3', type: 'sample', latitude: 49.9, longitude: 14.1 });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(5));

    expect(readRasters).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping reads for the same raster block', async () => {
    let resolveRaster: ((raster: Int16Array) => void) | undefined;
    const readRasters = vi.fn(
      () =>
        new Promise<Int16Array>((resolve) => {
          resolveRaster = resolve;
        })
    );
    fromBlobMock.mockResolvedValue({ getImage: async () => createImage(readRasters) });
    const worker = await loadWorker();

    worker.send({ id: 'load', type: 'load', file: {} as File });
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(1));
    worker.send({ id: 'sample-1', type: 'sample', latitude: 49.9, longitude: 14.1 });
    worker.send({ id: 'sample-2', type: 'sample', latitude: 49.8, longitude: 14.2 });

    await vi.waitFor(() => expect(readRasters).toHaveBeenCalledTimes(1));
    resolveRaster?.(new Int16Array(256 * 256).fill(321));
    await vi.waitFor(() => expect(worker.responses()).toHaveLength(3));

    expect(worker.responses().slice(1)).toEqual([
      {
        id: 'sample-1',
        type: 'sampled',
        sample: { status: 'ok', elevationM: 321 }
      },
      {
        id: 'sample-2',
        type: 'sampled',
        sample: { status: 'ok', elevationM: 321 }
      }
    ]);
  });
});

function createImage(readRasters: ReturnType<typeof vi.fn>) {
  return {
    getBoundingBox: () => [14, 49, 15, 50],
    getWidth: () => 512,
    getHeight: () => 512,
    getGeoKeys: () => ({ GeographicTypeGeoKey: 4326, VerticalUnitsGeoKey: 9001 }),
    getSamplesPerPixel: () => 1,
    getTileWidth: () => 256,
    getTileHeight: () => 256,
    getSampleByteSize: () => 2,
    getGDALNoData: () => null,
    readRasters
  };
}

async function loadWorker(): Promise<{
  send: (request: TerrainWorkerRequest) => void;
  responses: () => TerrainWorkerResponse[];
}> {
  const posted: TerrainWorkerResponse[] = [];
  const workerScope = {
    onmessage: null as ((event: MessageEvent<TerrainWorkerRequest>) => void) | null,
    postMessage: (response: TerrainWorkerResponse) => posted.push(response)
  };
  vi.stubGlobal('self', workerScope);
  await import('./terrain.worker');

  return {
    send(request): void {
      workerScope.onmessage?.({ data: request } as MessageEvent<TerrainWorkerRequest>);
    },
    responses: () => posted
  };
}
