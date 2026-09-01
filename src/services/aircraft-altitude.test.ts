/**
 * Verifies that asynchronous altitude processing never blocks publication of current GNSS position data.
 * Tests cover missing altitude and a controlled EGM96 grid failure without loading the real grid asset.
 */

import { afterEach, vi } from 'vitest';
import type { AircraftState, TerrainService } from '../domain/types';
import { AircraftAltitudeController } from './aircraft-altitude';

function aircraftFix(
  latitude: number,
  longitude: number,
  timestampMs: number,
  gpsEllipsoidAltitudeM: number | null = null
): AircraftState {
  return {
    latitude,
    longitude,
    gpsEllipsoidAltitudeM,
    gpsAltitudeM: null,
    gpsAltitudeAccuracyM: null,
    gpsAccuracyM: 4,
    aglM: null,
    trackDegrees: 90,
    trackSource: 'browser',
    trackAgeMs: 0,
    timestampMs
  };
}

describe('AircraftAltitudeController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes every GNSS fix when GPS altitude is unavailable', () => {
    const onStateChanged = vi.fn();
    const controller = new AircraftAltitudeController({
      terrainService: {} as TerrainService,
      onStateChanged
    });
    const first = aircraftFix(50, 14, 1_000);
    const second = aircraftFix(50.001, 14.002, 2_000);

    controller.acceptFix(first);
    controller.acceptFix(second);

    expect(controller.aircraftState).toEqual(second);
    expect(controller.terrainReason).toBe('Aircraft GPS altitude is unavailable.');
    expect(onStateChanged).toHaveBeenCalledTimes(2);
  });

  it('publishes a newer fix while EGM96 conversion is pending or fails', async () => {
    let rejectGridLoad = (_reason: Error): void => {
      throw new Error('EGM96 grid load has not started.');
    };
    const gridResponse = new Promise<Response>((_resolve, reject) => {
      rejectGridLoad = reject;
    });
    vi.stubGlobal('fetch', vi.fn(() => gridResponse));
    const controller = new AircraftAltitudeController({
      terrainService: {} as TerrainService,
      onStateChanged: vi.fn()
    });
    const first = aircraftFix(50, 14, 1_000, 450);
    const second = aircraftFix(50.001, 14.002, 2_000, 451);

    controller.acceptFix(first);
    controller.acceptFix(second);

    expect(controller.aircraftState).toEqual(second);
    rejectGridLoad(new Error('Grid unavailable.'));
    await vi.waitFor(() => expect(controller.terrainReason).toBe('Grid unavailable.'));
    expect(controller.aircraftState).toEqual(second);
  });
});
