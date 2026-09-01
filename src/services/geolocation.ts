/**
 * Wraps the browser Geolocation API and emits normalized aircraft state, freshness, and watch status.
 * Track state is retained across fixes, and a watchdog reports when position updates silently stop.
 */

import {
  deriveTrackFromFixes,
  resolveTrack,
  type PositionFix,
  type ReliableTrack
} from '../domain/track';
import type { AircraftState } from '../domain/types';

export const GNSS_FIX_STALE_TIMEOUT_MS = 15_000;

export type GeolocationStatus =
  | 'idle'
  | 'watching'
  | 'stale'
  | 'denied'
  | 'unavailable'
  | 'error';

/**
 * Tests whether a GNSS timestamp is recent enough for live threat evaluation.
 * @param timestampMs - Browser geolocation timestamp in epoch milliseconds.
 * @param nowMs - Current epoch time used for the comparison.
 * @param maxAgeMs - Maximum accepted fix age.
 * @returns `true` when the timestamp is finite and no older than the configured limit.
 */
export function isGnssFixFresh(
  timestampMs: number,
  nowMs = Date.now(),
  maxAgeMs = GNSS_FIX_STALE_TIMEOUT_MS
): boolean {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || maxAgeMs < 0) {
    return false;
  }
  return Math.max(0, nowMs - timestampMs) <= maxAgeMs;
}

/**
 * Owns the browser GNSS watch and translates position callbacks into application aircraft state.
 * Call `start` and `stop` idempotently; a page-lifetime watchdog detects silent update loss.
 */
export class GeolocationTracker {
  private watchId: number | null = null;
  private staleTimer: number | null = null;
  private previousFix: PositionFix | null = null;
  private reliableTrack: ReliableTrack | null = null;

  /**
   * Creates a tracker that reports aircraft and status updates through callbacks.
   * @param onState - Receives each normalized aircraft state.
   * @param onStatus - Receives watch lifecycle and error status changes.
   */
  constructor(
    private readonly onState: (state: AircraftState) => void,
    private readonly onStatus: (status: GeolocationStatus, message: string) => void
  ) {}

  /**
   * Starts the GNSS watch when browser geolocation is available.
   * @returns Nothing.
   */
  start(): void {
    if (!('geolocation' in navigator)) {
      this.onStatus('unavailable', 'Browser geolocation is not available.');
      return;
    }

    if (this.watchId !== null) {
      return;
    }

    this.onStatus('watching', 'Waiting for GNSS fix.');
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => this.handleError(error),
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10_000
      }
    );
  }

  /**
   * Stops the active GNSS watch, freshness watchdog, and reports the idle state.
   * @returns Nothing.
   */
  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.clearStaleTimer();
    this.onStatus('idle', 'GNSS watch stopped.');
  }

  private handlePosition(position: GeolocationPosition): void {
    const currentFix: PositionFix = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      timestampMs: position.timestamp
    };
    const derivedTrack = deriveTrackFromFixes(this.previousFix, currentFix);
    const resolvedTrack = resolveTrack(
      position.coords.heading,
      derivedTrack,
      this.reliableTrack,
      position.timestamp
    );
    this.reliableTrack = resolvedTrack.reliableTrack;
    this.previousFix = currentFix;
    this.armStaleTimer();

    this.onState({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      gpsEllipsoidAltitudeM: position.coords.altitude,
      gpsAltitudeM: null,
      gpsAltitudeAccuracyM: position.coords.altitudeAccuracy,
      gpsAccuracyM: position.coords.accuracy,
      aglM: null,
      trackDegrees: resolvedTrack.trackDegrees,
      trackSource: resolvedTrack.trackSource,
      trackAgeMs: resolvedTrack.trackAgeMs,
      timestampMs: position.timestamp
    });
    this.onStatus('watching', 'GNSS watch active.');
  }

  private handleError(error: GeolocationPositionError): void {
    this.clearStaleTimer();
    if (error.code === error.PERMISSION_DENIED) {
      this.onStatus('denied', 'GNSS permission denied.');
      return;
    }

    if (error.code === error.POSITION_UNAVAILABLE) {
      this.onStatus('unavailable', 'Aircraft position unavailable.');
      return;
    }

    this.onStatus('error', error.message || 'Unable to read GNSS position.');
  }

  private armStaleTimer(): void {
    this.clearStaleTimer();
    this.staleTimer = window.setTimeout(() => {
      this.staleTimer = null;
      this.onStatus(
        'stale',
        `GNSS position is stale: no update received for ${GNSS_FIX_STALE_TIMEOUT_MS / 1000} seconds.`
      );
    }, GNSS_FIX_STALE_TIMEOUT_MS);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) {
      window.clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }
}
