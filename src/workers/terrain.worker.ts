import { fromBlob, type GeoTIFFImage } from 'geotiff';
import { coordinateToPixel } from '../domain/geo';
import { calculateTerrainSampleSpacingM, evaluateFlatEarthLineOfSight } from '../domain/los';
import type {
  AircraftState,
  LineOfSightOptions,
  TerrainMetadata,
  TerrainSample,
  Threat
} from '../domain/types';
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './terrain-worker-protocol';

let image: GeoTIFFImage | null = null;
let metadata: TerrainMetadata | null = null;
const cancelled = new Set<string>();

self.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  void handleRequest(event.data);
};

async function handleRequest(request: TerrainWorkerRequest): Promise<void> {
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }

  try {
    if (request.type === 'load') {
      image = null;
      metadata = null;
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
      const result = await evaluateFlatEarthLineOfSight(
        request.aircraft,
        request.threat,
        sampleElevation,
        withTerrainSampleSpacing(request.aircraft, request.threat, request.options)
      );
      postIfCurrent(request.id, {
        id: request.id,
        type: 'los-result',
        result
      });
      return;
    }

    const results = [];
    for (const threat of request.threats) {
      if (cancelled.has(request.id)) {
        return;
      }

      results.push({
        threatId: threat.id,
        result: await evaluateFlatEarthLineOfSight(
          request.aircraft,
          threat,
          sampleElevation,
          withTerrainSampleSpacing(request.aircraft, threat, request.options)
        )
      });
    }
    postIfCurrent(request.id, {
      id: request.id,
      type: 'los-batch-result',
      results
    });
  } catch (error) {
    postIfCurrent(request.id, {
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown terrain worker error.'
    });
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
  if (!image || !metadata) {
    return {
      status: 'terrain-unavailable',
      reason: 'GeoTIFF is not loaded.'
    };
  }

  const pixel = coordinateToPixel(latitude, longitude, metadata);
  if (!pixel) {
    return {
      status: 'terrain-unavailable',
      reason: 'Coordinate is outside GeoTIFF coverage.'
    };
  }

  try {
    const raster = await image.readRasters({
      window: [pixel.x, pixel.y, pixel.x + 1, pixel.y + 1],
      samples: [0],
      interleave: true,
      width: 1,
      height: 1
    });
    const rawValue = Number((raster as unknown as ArrayLike<number>)[0]);

    if (!Number.isFinite(rawValue)) {
      return {
        status: 'terrain-unavailable',
        reason: 'Terrain elevation value is not numeric.'
      };
    }

    if (metadata.noDataValue !== null && Object.is(rawValue, metadata.noDataValue)) {
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

  const midpointLatitude = (aircraft.latitude + threat.latitude) / 2;
  return {
    ...options,
    maxSampleSpacingM: calculateTerrainSampleSpacingM(metadata, midpointLatitude)
  };
}
