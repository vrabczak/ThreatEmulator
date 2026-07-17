import {
  formatThreatRange,
  initialBearingDegrees,
  relativeBearingDegrees,
  type LatLon
} from './geo';
import type { AircraftState, ThreatEvaluationResult } from './types';

export function clockCodeFromRelativeBearing(relativeBearing: number): number {
  const clock = Math.round(relativeBearing / 30);
  return clock === 0 || clock === 12 ? 12 : clock;
}

export function clockCodeForThreat(aircraft: AircraftState, threat: LatLon): number | null {
  if (aircraft.trackDegrees === null) {
    return null;
  }

  const bearingToThreat = initialBearingDegrees(aircraft, threat);
  return clockCodeFromRelativeBearing(relativeBearingDegrees(aircraft.trackDegrees, bearingToThreat));
}

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
