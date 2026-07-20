/**
 * Derives and stabilizes aircraft track from browser headings and successive position fixes.
 * Helpers depend on spherical geodesy and preserve a recent reliable track for short GNSS gaps.
 */

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

/**
 * Tests whether a browser heading can be used as a track measurement.
 * @param heading - Candidate heading in degrees.
 * @returns Whether the value is finite and within the browser heading range.
 */
export function isValidHeading(heading: number | null | undefined): heading is number {
  return typeof heading === 'number' && Number.isFinite(heading) && heading >= 0 && heading <= 360;
}

/**
 * Derives track from two position fixes when their separation is large enough to be reliable.
 * @param previous - Previous fix, or `null` when no history exists.
 * @param current - Current position fix.
 * @param minDistanceM - Minimum displacement required before deriving a bearing.
 * @returns The derived true track in degrees, or `null` when displacement is insufficient.
 */
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

/**
 * Chooses the best available track and carries recent reliable track through brief gaps.
 * @param browserHeading - Heading reported by the browser Geolocation API.
 * @param derivedHeading - Heading derived from consecutive position fixes.
 * @param previousReliable - Most recent reliable track, if any.
 * @param nowMs - Timestamp used to age a retained track.
 * @param maxStaleMs - Maximum age at which the retained track remains usable.
 * @returns Resolved track data plus the reliable track to retain for the next fix.
 */
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
