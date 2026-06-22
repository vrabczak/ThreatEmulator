import { distanceMeters, initialBearingDegrees, normalizeDegrees, type LatLon } from './geo';
import type { TrackSource } from './types';

export interface PositionFix extends LatLon {
  timestampMs: number;
}

export interface ReliableTrack {
  degrees: number;
  timestampMs: number;
}

export interface ResolvedTrack {
  trackDegrees: number | null;
  trackSource: TrackSource;
  trackAgeMs: number | null;
  reliableTrack: ReliableTrack | null;
}

export const DEFAULT_TRACK_STALE_MS = 10_000;
export const DEFAULT_MIN_DERIVED_TRACK_DISTANCE_M = 5;

export function isValidHeading(heading: number | null | undefined): heading is number {
  return typeof heading === 'number' && Number.isFinite(heading) && heading >= 0 && heading <= 360;
}

export function deriveTrackFromFixes(
  previous: PositionFix | null,
  current: PositionFix,
  minDistanceM = DEFAULT_MIN_DERIVED_TRACK_DISTANCE_M
): number | null {
  if (!previous) {
    return null;
  }

  const distanceM = distanceMeters(previous, current);
  if (distanceM < minDistanceM) {
    return null;
  }

  return initialBearingDegrees(previous, current);
}

export function resolveTrack(
  browserHeading: number | null | undefined,
  derivedHeading: number | null,
  previousReliable: ReliableTrack | null,
  nowMs: number,
  maxStaleMs = DEFAULT_TRACK_STALE_MS
): ResolvedTrack {
  if (isValidHeading(browserHeading)) {
    const degrees = normalizeDegrees(browserHeading);
    return {
      trackDegrees: degrees,
      trackSource: 'browser',
      trackAgeMs: 0,
      reliableTrack: { degrees, timestampMs: nowMs }
    };
  }

  if (derivedHeading !== null && Number.isFinite(derivedHeading)) {
    const degrees = normalizeDegrees(derivedHeading);
    return {
      trackDegrees: degrees,
      trackSource: 'derived',
      trackAgeMs: 0,
      reliableTrack: { degrees, timestampMs: nowMs }
    };
  }

  if (previousReliable) {
    const ageMs = nowMs - previousReliable.timestampMs;
    if (ageMs >= 0 && ageMs <= maxStaleMs) {
      return {
        trackDegrees: previousReliable.degrees,
        trackSource: 'stale',
        trackAgeMs: ageMs,
        reliableTrack: previousReliable
      };
    }
  }

  return {
    trackDegrees: null,
    trackSource: 'unavailable',
    trackAgeMs: null,
    reliableTrack: previousReliable
  };
}
