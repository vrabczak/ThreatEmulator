/**
 * Evaluates terrain line of sight between threats and the aircraft on a spherical ground path.
 * Terrain elevations and sensor heights are assumed to use meters above mean sea level.
 */

import {
  EARTH_RADIUS_M,
  destinationPoint,
  distanceMeters,
  initialBearingDegrees,
  type LatLon
} from './geo';
import type {
  AircraftState,
  LineOfSightOptions,
  LineOfSightResult,
  TerrainMetadata,
  TerrainSample,
  Threat
} from './types';

export type TerrainSampler = (latitude: number, longitude: number) => Promise<TerrainSample>;

export const DEFAULT_MAX_LOS_SAMPLE_SPACING_M = 50;
const MIN_LOS_SAMPLE_SPACING_M = 1;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Derives horizontal terrain sampling spacing from GeoTIFF angular resolution.
 * @param metadata - Loaded raster metadata containing latitude/longitude resolution.
 * @param latitude - Representative latitude used to scale longitude spacing.
 * @returns Sampling spacing in meters, clamped to at least one meter.
 */
export function calculateTerrainSampleSpacingM(metadata: TerrainMetadata, latitude: number): number {
  const latitudeResolutionDeg = Math.abs(metadata.resolutionDeg.latitude);
  const longitudeResolutionDeg = Math.abs(metadata.resolutionDeg.longitude);
  if (!Number.isFinite(latitudeResolutionDeg) || !Number.isFinite(longitudeResolutionDeg)) {
    return DEFAULT_MAX_LOS_SAMPLE_SPACING_M;
  }

  const latitudeSpacingM = latitudeResolutionDeg * DEGREES_TO_RADIANS * EARTH_RADIUS_M;
  const normalizedLatitude = Math.min(Math.max(latitude, -90), 90);
  // Longitude degrees contract toward the poles, unlike the nearly constant latitude spacing.
  const longitudeSpacingM =
    longitudeResolutionDeg *
    DEGREES_TO_RADIANS *
    EARTH_RADIUS_M *
    Math.abs(Math.cos(normalizedLatitude * DEGREES_TO_RADIANS));
  const validSpacingsM = [latitudeSpacingM, longitudeSpacingM].filter(
    (spacingM) => Number.isFinite(spacingM) && spacingM > 0
  );
  const spacingM = Math.min(...validSpacingsM);

  return validSpacingsM.length > 0
    ? Math.max(spacingM, MIN_LOS_SAMPLE_SPACING_M)
    : DEFAULT_MAX_LOS_SAMPLE_SPACING_M;
}

/**
 * Tests whether terrain intersects the straight sight line from a threat sensor to the aircraft.
 * @param aircraft - Aircraft position and mean-sea-level altitude.
 * @param threat - Threat position, range metadata, and sensor height above local terrain.
 * @param sampler - Asynchronous terrain elevation provider.
 * @param options - Optional upper bound on sample spacing.
 * @returns The line-of-sight status and sampling details.
 * @throws {Error} When the terrain sampler rejects a request.
 */
export async function evaluateFlatEarthLineOfSight(
  aircraft: AircraftState,
  threat: Threat,
  sampler: TerrainSampler,
  options: LineOfSightOptions = {}
): Promise<LineOfSightResult> {
  if (threat.heightAglM === null) {
    return { status: 'clear', sampleCount: 0 };
  }

  if (aircraft.gpsAltitudeM === null) {
    return {
      status: 'terrain-unavailable',
      sampleCount: 0,
      reason: 'Aircraft GPS altitude is unavailable.'
    };
  }

  const threatTerrain = await sampler(threat.latitude, threat.longitude);
  if (threatTerrain.status !== 'ok') {
    return {
      status: 'terrain-unavailable',
      sampleCount: 0,
      reason: `Threat terrain unavailable: ${threatTerrain.reason}`
    };
  }

  const threatLocation: LatLon = threat;
  const aircraftLocation: LatLon = aircraft;
  const totalDistanceM = distanceMeters(threatLocation, aircraftLocation);
  const maxSpacingM = Math.max(options.maxSampleSpacingM ?? DEFAULT_MAX_LOS_SAMPLE_SPACING_M, 1);
  if (totalDistanceM <= maxSpacingM) {
    return { status: 'clear', sampleCount: 1 };
  }

  const steps = Math.max(1, Math.ceil(totalDistanceM / maxSpacingM));
  const bearing = initialBearingDegrees(threatLocation, aircraftLocation);
  const threatSensorAltitudeM = threatTerrain.elevationM + threat.heightAglM;
  let sampleCount = 1;

  for (let index = 1; index < steps; index += 1) {
    const ratio = index / steps;
    const distanceFromThreatM = totalDistanceM * ratio;
    const point = destinationPoint(threatLocation, bearing, distanceFromThreatM);
    const sample = await sampler(point.latitude, point.longitude);
    sampleCount += 1;

    if (sample.status !== 'ok') {
      return {
        status: 'terrain-unavailable',
        sampleCount,
        reason: sample.reason
      };
    }

    // The flat-earth model linearly interpolates MSL altitude along the geodesic ground path.
    const sightLineElevationM =
      threatSensorAltitudeM + (aircraft.gpsAltitudeM - threatSensorAltitudeM) * ratio;
    if (sample.elevationM >= sightLineElevationM) {
      return {
        status: 'blocked',
        sampleCount,
        blockedAt: {
          latitude: point.latitude,
          longitude: point.longitude,
          terrainElevationM: sample.elevationM,
          sightLineElevationM,
          distanceFromThreatM
        }
      };
    }
  }

  return { status: 'clear', sampleCount };
}
