/**
 * Wraps the browser Geolocation API and emits normalized aircraft state and watch status.
 * Track state is retained across fixes so brief heading gaps can reuse a recent reliable value.
 */

import {
  deriveTrackFromFixes,
  resolveTrack,
  type PositionFix,
  type ReliableTrack
} from '../domain/track';
import type { AircraftState } from '../domain/types';

export type GeolocationStatus = 'idle' | 'watching' | 'denied' | 'unavailable' | 'error';

/**
 * Owns the browser GNSS watch and translates position callbacks into application aircraft state.
 * Call `start` and `stop` idempotently; position and reliable-track history live for the instance lifetime.
 */
export class GeolocationTracker {
  private watchId: number | null = null;
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

  /** Starts the GNSS watch when browser geolocation is available. */
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

  /** Stops the active GNSS watch and reports the idle state. */
  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
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
}
