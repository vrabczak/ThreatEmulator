/**
 * Builds concise cockpit-style warning text from threat geometry and evaluation state.
 * Bearing calculations use the aircraft's resolved true track and shared geodesy helpers.
 */

import {
  formatThreatRange,
  initialBearingDegrees,
  relativeBearingDegrees,
  type LatLon
} from './geo';
import type { AircraftState, ThreatEvaluationResult } from './types';

/**
 * Converts a clockwise relative bearing into a 12-hour clock direction.
 * @param relativeBearing - Relative bearing in degrees.
 * @returns An integer clock code from 1 through 12.
 */
export function clockCodeFromRelativeBearing(relativeBearing: number): number {
  const clock = Math.round(relativeBearing / 30);
  return clock === 0 || clock === 12 ? 12 : clock;
}

/**
 * Calculates a threat's clock direction relative to aircraft track.
 * @param aircraft - Current aircraft state.
 * @param threat - Threat position.
 * @returns A clock code, or `null` when aircraft track is unavailable.
 */
export function clockCodeForThreat(aircraft: AircraftState, threat: LatLon): number | null {
  if (aircraft.trackDegrees === null) {
    return null;
  }

  const bearingToThreat = initialBearingDegrees(aircraft, threat);
  return clockCodeFromRelativeBearing(relativeBearingDegrees(aircraft.trackDegrees, bearingToThreat));
}

/**
 * Builds one warning call for an active threat.
 * @param result - Active threat evaluation, or `null` when none is active.
 * @param aircraft - Current aircraft state used for relative direction.
 * @returns Uppercase warning text suitable for a warning row.
 */
export function buildThreatWarning(
  result: ThreatEvaluationResult | null,
  aircraft: AircraftState | null
): string {
  if (!result || result.state !== 'active' || result.distanceKm === null) {
    return 'NO ACTIVE THREAT';
  }

  const rangeText = formatThreatRange(result.distanceKm).toUpperCase();
  const threatLabel = (result.threat.name || result.threat.id).toUpperCase();

  if (!aircraft || aircraft.trackDegrees === null) {
    return `THREAT ${threatLabel} ${rangeText} TRACK UNAVAILABLE`;
  }

  const clock = clockCodeForThreat(aircraft, result.threat);
  if (clock === null) {
    return `THREAT ${threatLabel} ${rangeText} TRACK UNAVAILABLE`;
  }

  return `THREAT ${clock} O'CLOCK ${rangeText}`;
}

/**
 * Retains active threats in first-appearance order and appends newly active threats.
 * IDs removed during an inactive evaluation are appended if they later reactivate.
 * @param previousOrder - Active threat IDs ordered by their prior first appearance.
 * @param results - Latest evaluation results in configured threat-list order.
 * @returns Active threat IDs in warning-row display order.
 */
export function reconcileActiveThreatOrder(
  previousOrder: readonly string[],
  results: readonly ThreatEvaluationResult[]
): string[] {
  const activeIds = new Set(
    results.filter((result) => result.state === 'active').map((result) => result.threat.id)
  );
  const nextOrder = previousOrder.filter((id) => activeIds.has(id));
  const retainedIds = new Set(nextOrder);

  // Evaluation order is the deterministic tie-breaker when threats first activate together.
  for (const result of results) {
    const id = result.threat.id;
    if (result.state === 'active' && !retainedIds.has(id)) {
      nextOrder.push(id);
      retainedIds.add(id);
    }
  }

  return nextOrder;
}
