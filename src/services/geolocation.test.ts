/**
 * Verifies GNSS freshness rules and the browser-position watchdog.
 * A controllable Geolocation API double supplies fixes while Vitest fake timers advance silence periods.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GNSS_FIX_STALE_TIMEOUT_MS,
  GeolocationTracker,
  isGnssFixFresh,
  type GeolocationStatus
} from './geolocation';

describe('GNSS freshness', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('accepts only fixes within the configured age limit', () => {
    expect(isGnssFixFresh(10_000, 24_999)).toBe(true);
    expect(isGnssFixFresh(10_000, 25_000)).toBe(true);
    expect(isGnssFixFresh(10_000, 25_001)).toBe(false);
    expect(isGnssFixFresh(Number.NaN, 10_000)).toBe(false);
  });

  it('reports a stale watch and recovers when another fix arrives', async () => {
    vi.useFakeTimers();
    let publishPosition = (_position: GeolocationPosition): void => {
      throw new Error('Geolocation watch has not started.');
    };
    const clearWatch = vi.fn();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    });
    vi.stubGlobal('navigator', {
      geolocation: {
        watchPosition: vi.fn((onPosition: (position: GeolocationPosition) => void) => {
          publishPosition = onPosition;
          return 7;
        }),
        clearWatch
      }
    });
    const statuses: GeolocationStatus[] = [];
    const tracker = new GeolocationTracker(
      vi.fn(),
      (status) => statuses.push(status)
    );

    tracker.start();
    const fix = {
      coords: {
        latitude: 50,
        longitude: 14,
        altitude: null,
        accuracy: 4,
        altitudeAccuracy: null,
        heading: null,
        speed: null
      },
      timestamp: 1_000
    } as GeolocationPosition;
    publishPosition(fix);

    await vi.advanceTimersByTimeAsync(GNSS_FIX_STALE_TIMEOUT_MS);
    expect(statuses.at(-1)).toBe('stale');

    publishPosition({
      ...fix,
      timestamp: 2_000
    });
    expect(statuses.at(-1)).toBe('watching');

    tracker.stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
    expect(statuses.at(-1)).toBe('idle');
  });
});
