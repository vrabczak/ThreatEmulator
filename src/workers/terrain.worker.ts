/**
 * Runs GeoTIFF loading, point sampling, and line-of-sight evaluation off the UI thread.
 * Worker state holds one active WGS84 raster and communicates through the typed terrain protocol.
 */

import { fromBlob, type GeoTIFFImage } from 'geotiff';
import { coordinateToPixel } from '../domain/geo';
import {
  calculateTerrainSampleSpacingM,
  evaluateFlatEarthLineOfSight,
  type TerrainSampler
} from '../domain/los';
import type {
  AircraftState,
  LineOfSightOptions,
  TerrainMetadata,
  TerrainSample,
  Threat
} from '../domain/types';
import { RasterBlockCache, type DecodedRasterBlock } from './raster-block-cache';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './terrain-worker-protocol';

const MAX_DECODED_RASTER_CACHE_BYTES = 64 * 1024 * 1024;
const LOS_EVENT_LOOP_YIELD_SAMPLE_COUNT = 128;

let image: GeoTIFFImage | null = null;
let metadata: TerrainMetadata | null = null;
let terrainGeneration = 0;
const cancelled = new Set<string>();
const trackedRequests = new Set<string>();
const rasterBlockCache = new RasterBlockCache(MAX_DECODED_RASTER_CACHE_BYTES);
const pendingRasterBlocks = new Map<string, Promise<DecodedRasterBlock>>();
let lineOfSightQueue = Promise.resolve();

self.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    if (trackedRequests.has(request.id)) {
      cancelled.add(request.id);
    }
    return;
  }

  trackedRequests.add(request.id);
  if (request.type === 'los' || request.type === 'los-batch') {
    // Serialize LOS requests so replacement threat data cannot run beside obsolete terrain work.
    lineOfSightQueue = lineOfSightQueue.then(() => runTrackedRequest(request));
    return;
  }

  void runTrackedRequest(request);
};

async function handleRequest(request: TerrainWorkerRequest): Promise<void> {
  if (request.type === 'cancel' || cancelled.delete(request.id)) {
    return;
  }

  try {
    if (request.type === 'load') {
      terrainGeneration += 1;
      image = null;
      metadata = null;
      rasterBlockCache.clear();
      pendingRasterBlocks.clear();
      const tiff = await fromBlob(request.file);
      image = await tiff.getImage();
      metadata = await readMetadata(request.file, image);
      postIfCurrent(request.id, {
        id: request.id,
        type: 'loaded',
        metadata
      });
      return;
    }

    if (!image || !metadata) {
      throw new Error('GeoTIFF is not loaded.');
    }

    if (request.type === 'sample') {
      const sample = await sampleElevation(request.latitude, request.longitude);
      postIfCurrent(request.id, {
        id: request.id,
        type: 'sampled',
        sample
      });
      return;
    }

    if (request.type === 'los') {
      const requestSampler = createCancellableTerrainSampler(request.id);
      const result = await evaluateFlatEarthLineOfSight(
        request.aircraft,
        request.threat,
        requestSampler,
        withTerrainSampleSpacing(request.aircraft, request.threat, request.options),
        () => cancelled.has(request.id)
      );
      postIfCurrent(request.id, {
        id: request.id,
        type: 'los-result',
        result
      });
      return;
    }

    const results = [];
    const requestSampler = createCancellableTerrainSampler(request.id);
    for (const threat of request.threats) {
      if (cancelled.delete(request.id)) {
        return;
      }

      results.push({
        threatId: threat.id,
        result: await evaluateFlatEarthLineOfSight(
          request.aircraft,
          threat,
          requestSampler,
          withTerrainSampleSpacing(request.aircraft, threat, request.options),
          () => cancelled.has(request.id)
        )
      });
    }
    postIfCurrent(request.id, {
      id: request.id,
      type: 'los-batch-result',
      results
    });
  } catch (error) {
    if (cancelled.delete(request.id)) {
      return;
    }
    postIfCurrent(request.id, {
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown terrain worker error.'
    });
  }
}

function createCancellableTerrainSampler(requestId: string): TerrainSampler {
  let sampleCount = 0;
  return async (latitude, longitude) => {
    sampleCount += 1;
    if (sampleCount % LOS_EVENT_LOOP_YIELD_SAMPLE_COUNT === 0) {
      // Cached reads resolve as microtasks, so yield periodically to receive worker cancel messages.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (cancelled.has(requestId)) {
        throw new Error('Line-of-sight evaluation was canceled.');
      }
    }
    return sampleElevation(latitude, longitude);
  };
}

async function runTrackedRequest(
  request: Exclude<TerrainWorkerRequest, { type: 'cancel' }>
): Promise<void> {
  try {
    await handleRequest(request);
  } finally {
    trackedRequests.delete(request.id);
    cancelled.delete(request.id);
  }
}

async function readMetadata(file: File, loadedImage: GeoTIFFImage): Promise<TerrainMetadata> {
  const bbox = loadedImage.getBoundingBox() as [number, number, number, number];
  const width = loadedImage.getWidth();
  const height = loadedImage.getHeight();
  const warnings: string[] = [];
  const geoKeys = loadedImage.getGeoKeys() as Record<string, unknown>;
  const geographicType = Number(geoKeys.GeographicTypeGeoKey);
  const projectedType = Number(geoKeys.ProjectedCSTypeGeoKey);
  const verticalUnits = Number(geoKeys.VerticalUnitsGeoKey);

  if (Number.isFinite(projectedType) && projectedType > 0) {
    throw new Error(`GeoTIFF uses projected coordinates (${projectedType}); WGS84 geographic coordinates are required.`);
  }

  const isWgs84 =
    geographicType === 4326 ||
    String(geoKeys.GeogCitationGeoKey ?? geoKeys.GTCitationGeoKey ?? '')
      .toLowerCase()
      .includes('wgs');

  if (Number.isFinite(geographicType) && geographicType > 0 && !isWgs84) {
    throw new Error(`GeoTIFF geographic coordinate system ${geographicType} is not WGS84.`);
  }

  if (!Number.isFinite(geographicType) && !isWgs84) {
    warnings.push('GeoTIFF WGS84 metadata is not explicit; coordinates will be treated as WGS84.');
  }

  if (Number.isFinite(verticalUnits) && verticalUnits > 0 && verticalUnits !== 9001) {
    throw new Error(`GeoTIFF vertical units ${verticalUnits} are not meters.`);
  }

  if (!Number.isFinite(verticalUnits)) {
    warnings.push('GeoTIFF elevation unit metadata is not explicit; values will be treated as meters MSL.');
  }

  const noDataValue = await readNoDataValue(loadedImage);
  return {
    fileName: file.name,
    fileSize: file.size,
    width,
    height,
    bbox,
    resolutionDeg: {
      longitude: (bbox[2] - bbox[0]) / width,
      latitude: (bbox[3] - bbox[1]) / height
    },
    samplesPerPixel: loadedImage.getSamplesPerPixel(),
    tileWidth: loadedImage.getTileWidth(),
    tileHeight: loadedImage.getTileHeight(),
    noDataValue,
    isWgs84,
    warnings
  };
}

async function readNoDataValue(loadedImage: GeoTIFFImage): Promise<number | null> {
  const maybeNoData = loadedImage as unknown as {
    getGDALNoData?: () => string | number | null | Promise<string | number | null>;
  };
  const value = maybeNoData.getGDALNoData ? await maybeNoData.getGDALNoData() : null;
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function sampleElevation(latitude: number, longitude: number): Promise<TerrainSample> {
  const loadedImage = image;
  const loadedMetadata = metadata;
  const loadedGeneration = terrainGeneration;
  if (!loadedImage || !loadedMetadata) {
    return {
      status: 'terrain-unavailable',
      reason: 'GeoTIFF is not loaded.'
    };
  }

  const pixel = coordinateToPixel(latitude, longitude, loadedMetadata);
  if (!pixel) {
    return {
      status: 'terrain-unavailable',
      reason: 'Coordinate is outside GeoTIFF coverage.'
    };
  }

  try {
    const rawValue = await readElevationPixel(
      loadedImage,
      pixel.x,
      pixel.y,
      loadedGeneration
    );

    if (!Number.isFinite(rawValue)) {
      return {
        status: 'terrain-unavailable',
        reason: 'Terrain elevation value is not numeric.'
      };
    }

    if (loadedMetadata.noDataValue !== null && Object.is(rawValue, loadedMetadata.noDataValue)) {
      return {
        status: 'terrain-unavailable',
        reason: 'Terrain elevation is NoData at this coordinate.'
      };
    }

    return {
      status: 'ok',
      elevationM: rawValue
    };
  } catch (error) {
    return {
      status: 'terrain-unavailable',
      reason: error instanceof Error ? error.message : 'Unable to read terrain sample.'
    };
  }
}

async function readElevationPixel(
  loadedImage: GeoTIFFImage,
  pixelX: number,
  pixelY: number,
  generation: number
): Promise<number> {
  const blockWidth = loadedImage.getTileWidth();
  const blockHeight = loadedImage.getTileHeight();
  const blockX = Math.floor(pixelX / blockWidth);
  const blockY = Math.floor(pixelY / blockHeight);
  const key = `${generation}:${blockX}:${blockY}`;
  const blockStartX = blockX * blockWidth;
  const blockStartY = blockY * blockHeight;
  const actualWidth = Math.min(blockWidth, loadedImage.getWidth() - blockStartX);
  const actualHeight = Math.min(blockHeight, loadedImage.getHeight() - blockStartY);
  const estimatedByteLength = actualWidth * actualHeight * loadedImage.getSampleByteSize(0);

  // A very large strip must not defeat the cache budget or force a large retained output array.
  if (estimatedByteLength > MAX_DECODED_RASTER_CACHE_BYTES) {
    const raster = await loadedImage.readRasters({
      window: [pixelX, pixelY, pixelX + 1, pixelY + 1],
      samples: [0],
      interleave: true,
      width: 1,
      height: 1
    });
    return Number((raster as unknown as ArrayLike<number>)[0]);
  }

  const block =
    rasterBlockCache.get(key) ??
    (await getOrReadRasterBlock(
      loadedImage,
      key,
      blockStartX,
      blockStartY,
      actualWidth,
      actualHeight,
      generation
    ));
  const localX = pixelX - blockStartX;
  const localY = pixelY - blockStartY;
  return Number(block.values[localY * block.width + localX]);
}

async function getOrReadRasterBlock(
  loadedImage: GeoTIFFImage,
  key: string,
  startX: number,
  startY: number,
  width: number,
  height: number,
  generation: number
): Promise<DecodedRasterBlock> {
  const existingRequest = pendingRasterBlocks.get(key);
  if (existingRequest) {
    return existingRequest;
  }

  // Store the promise immediately so overlapping AGL and LOS reads decode this block only once.
  const blockRequest = (async (): Promise<DecodedRasterBlock> => {
    const raster = await loadedImage.readRasters({
      window: [startX, startY, startX + width, startY + height],
      samples: [0],
      interleave: true
    });
    const values = raster as unknown as ArrayLike<number> & { byteLength?: number };
    const block: DecodedRasterBlock = {
      values,
      width,
      height,
      byteLength: values.byteLength ?? values.length * loadedImage.getSampleByteSize(0)
    };

    // A stale read from a replaced terrain file must never populate the active file's cache.
    if (generation === terrainGeneration && loadedImage === image) {
      rasterBlockCache.set(key, block);
    }
    return block;
  })();
  pendingRasterBlocks.set(key, blockRequest);

  try {
    return await blockRequest;
  } finally {
    if (pendingRasterBlocks.get(key) === blockRequest) {
      pendingRasterBlocks.delete(key);
    }
  }
}

function postIfCurrent(id: string, response: TerrainWorkerResponse): void {
  if (cancelled.has(id)) {
    cancelled.delete(id);
    return;
  }

  self.postMessage(response);
}

function withTerrainSampleSpacing(
  aircraft: AircraftState,
  threat: Threat,
  options?: LineOfSightOptions
): LineOfSightOptions | undefined {
  if (options?.maxSampleSpacingM !== undefined || !metadata) {
    return options;
  }

  // A midpoint latitude gives a representative east-west pixel scale for the complete LOS path.
  const midpointLatitude = (aircraft.latitude + threat.latitude) / 2;
  return {
    ...options,
    maxSampleSpacingM: calculateTerrainSampleSpacingM(metadata, midpointLatitude)
  };
}
