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
 * Builds the primary warning displayed for the closest active threat.
 * @param result - Primary threat evaluation, or `null` when none is active.
 * @param aircraft - Current aircraft state used for relative direction.
 * @returns Uppercase warning text suitable for the primary warning banner.
 */
export function buildPrimaryWarning(
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
