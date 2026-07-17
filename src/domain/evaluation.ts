import { distanceMeters, formatKilometers } from './geo';
import { DEFAULT_MAX_LOS_SAMPLE_SPACING_M, calculateTerrainSampleSpacingM } from './los';
import type {
  AircraftState,
  LineOfSightResult,
  TerrainMetadata,
  TerrainSample,
  TerrainService,
  Threat,
  ThreatEvaluationResult,
  ThreatEvaluationSummary
} from './types';

export interface ThreatEvaluationOptions {
  maxLosSampleSpacingM?: number;
  nowMs?: number;
}

export const MINIMUM_CALCULATED_AGL_M = 15;
export const LOW_AGL_FALLBACK_M = 50 / 3.280839895;

export async function evaluateThreats(
  threats: Threat[],
  aircraft: AircraftState | null,
  terrain: TerrainService,
  options: ThreatEvaluationOptions = {}
): Promise<ThreatEvaluationSummary> {
  const evaluatedAtMs = options.nowMs ?? Date.now();
  const terrainMetadata = terrain.getMetadata();
  const results: Array<ThreatEvaluationResult | null> = [];
  const pendingLos: Array<{ index: number; threat: Threat; distanceKm: number }> = [];

  for (const [index, threat] of threats.entries()) {
    if (!aircraft || (aircraft.gpsAltitudeM === null && threat.heightAglM !== null)) {
      results[index] = {
        threat,
        state: 'aircraft state unavailable',
        distanceKm: null,
        reason: !aircraft
          ? 'Aircraft GNSS position is unavailable.'
          : 'Aircraft GPS altitude is unavailable.'
      };
      continue;
    }

    const distanceKm = distanceMeters(aircraft, threat) / 1000;
    if (distanceKm > threat.rangeKm) {
      results[index] = {
        threat,
        state: 'inactive',
        distanceKm,
        reason: `Outside range (${formatKilometers(distanceKm)} km > ${formatKilometers(threat.rangeKm)} km).`,
        ...(threat.heightAglM === null || !terrainMetadata
          ? { lineOfSight: { status: 'clear' as const, sampleCount: 0 } }
          : {})
      };
      continue;
    }

    if (threat.heightAglM === null) {
      results[index] = {
        threat,
        state: 'active',
        distanceKm,
        reason: 'Inside range; magic threat line of sight is always clear.',
        lineOfSight: { status: 'clear', sampleCount: 0 }
      };
      continue;
    }

    pendingLos.push({ index, threat, distanceKm });
  }

  if (aircraft && aircraft.gpsAltitudeM !== null && pendingLos.length > 0) {
    if (!terrainMetadata) {
      for (const pending of pendingLos) {
        results[pending.index] = {
          threat: pending.threat,
          state: 'active',
          distanceKm: pending.distanceKm,
          reason: 'Inside range; no elevation model is loaded, so line of sight is assumed clear.',
          lineOfSight: { status: 'clear', sampleCount: 0 }
        };
      }
    } else {
      const losOptions = {
        maxSampleSpacingM:
          options.maxLosSampleSpacingM ??
          deriveTerrainSampleSpacingM(terrainMetadata, aircraft, pendingLos)
      };
      const batchResults = await terrain.evaluateLineOfSightBatch(
        aircraft,
        pendingLos.map((pending) => pending.threat),
        losOptions
      );
      const losByThreatId = new Map(batchResults.map((item) => [item.threatId, item.result]));

      for (const pending of pendingLos) {
        const lineOfSight =
          losByThreatId.get(pending.threat.id) ??
          (await terrain.evaluateLineOfSight(aircraft, pending.threat, losOptions));
        results[pending.index] = resultFromLineOfSight(
          pending.threat,
          pending.distanceKm,
          lineOfSight
        );
      }
    }
  }

  const finalResults = results.filter((result): result is ThreatEvaluationResult => result !== null);
  const primary =
    finalResults
      .filter((result) => result.state === 'active' && result.distanceKm !== null)
      .sort((left, right) => (left.distanceKm as number) - (right.distanceKm as number))[0] ?? null;

  return { evaluatedAtMs, results: finalResults, primary };
}

function deriveTerrainSampleSpacingM(
  metadata: TerrainMetadata | null,
  aircraft: AircraftState,
  pendingLos: Array<{ threat: Threat }>
): number {
  if (!metadata) {
    return DEFAULT_MAX_LOS_SAMPLE_SPACING_M;
  }

  const spacingM = pendingLos.reduce((currentSpacingM, pending) => {
    const midpointLatitude = (aircraft.latitude + pending.threat.latitude) / 2;
    return Math.min(currentSpacingM, calculateTerrainSampleSpacingM(metadata, midpointLatitude));
  }, Number.POSITIVE_INFINITY);

  return Number.isFinite(spacingM) ? spacingM : DEFAULT_MAX_LOS_SAMPLE_SPACING_M;
}

export function calculateAgl(gpsAltitudeM: number | null, terrainElevationM: number | null): number | null {
  if (gpsAltitudeM === null || terrainElevationM === null) {
    return null;
  }

  const calculatedAglM = gpsAltitudeM - terrainElevationM;
  return calculatedAglM < MINIMUM_CALCULATED_AGL_M ? LOW_AGL_FALLBACK_M : calculatedAglM;
}

export function resolveTerrainElevationM(
  sample: TerrainSample,
  lastRetrievedElevationM: number | null
): number | null {
  return sample.status === 'ok' ? sample.elevationM : lastRetrievedElevationM;
}

function resultFromLineOfSight(
  threat: Threat,
  distanceKm: number,
  lineOfSight: LineOfSightResult
): ThreatEvaluationResult {
  if (lineOfSight.status === 'terrain-unavailable') {
    return {
      threat,
      state: 'terrain unavailable',
      distanceKm,
      reason: lineOfSight.reason,
      lineOfSight
    };
  }

  if (lineOfSight.status === 'blocked') {
    return {
      threat,
      state: 'inactive',
      distanceKm,
      reason: 'Line of sight is blocked by terrain.',
      lineOfSight
    };
  }

  return {
    threat,
    state: 'active',
    distanceKm,
    reason: 'Inside range with clear line of sight.',
    lineOfSight
  };
}
