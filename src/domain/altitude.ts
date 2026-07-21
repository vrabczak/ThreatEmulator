/**
 * Provides stateless aircraft-altitude calculations and terrain-sample fallback selection.
 * Inputs are orthometric/terrain elevations in meters; the configured low-AGL display fallback is preserved.
 */

import type { TerrainSample } from './types';

export const MINIMUM_CALCULATED_AGL_M = 15;
export const LOW_AGL_FALLBACK_M = 50 / 3.280839895;

/**
 * Calculates aircraft height above terrain with the configured low-altitude fallback.
 * @param gpsAltitudeM - Aircraft orthometric altitude in meters.
 * @param terrainElevationM - Terrain elevation in meters MSL.
 * @returns Height AGL in meters, the low-altitude fallback, or `null` when an input is missing.
 */
export function calculateAgl(gpsAltitudeM: number | null, terrainElevationM: number | null): number | null {
  if (gpsAltitudeM === null || terrainElevationM === null) {
    return null;
  }

  const calculatedAglM = gpsAltitudeM - terrainElevationM;
  return calculatedAglM < MINIMUM_CALCULATED_AGL_M ? LOW_AGL_FALLBACK_M : calculatedAglM;
}

/**
 * Retains the last valid aircraft terrain elevation when a new terrain sample is unavailable.
 * @param sample - Latest terrain sampling result.
 * @param lastRetrievedElevationM - Previously retrieved valid elevation, if any.
 * @returns The latest valid elevation or the supplied fallback.
 */
export function resolveTerrainElevationM(
  sample: TerrainSample,
  lastRetrievedElevationM: number | null
): number | null {
  return sample.status === 'ok' ? sample.elevationM : lastRetrievedElevationM;
}
