/**
 * Verifies that asynchronous altitude processing never blocks publication of current GNSS position data.
 * Tests cover missing altitude and a controlled EGM96 grid failure without loading the real grid asset.
 */

import { afterEach, expect, vi } from 'vitest';
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

  it('coalesces terrain samples while preserving the newest GNSS fix', async () => {
    let resolveFirstSample!: (sample: { status: 'ok'; elevationM: number }) => void;
    const firstSample = new Promise<{ status: 'ok'; elevationM: number }>((resolve) => {
      resolveFirstSample = resolve;
    });
    const sampleElevation = vi.fn()
      .mockReturnValueOnce(firstSample)
      .mockResolvedValue({ status: 'ok', elevationM: 302 });
    const controller = new AircraftAltitudeController({
      terrainService: { sampleElevation } as unknown as TerrainService,
      onStateChanged: vi.fn()
    });
    controller.setTerrainMetadata({
      fileName: 'terrain.tif',
      fileSize: 1,
      width: 1,
      height: 1,
      bbox: [13, 49, 15, 51],
      resolutionDeg: { longitude: 1, latitude: 1 },
      samplesPerPixel: 1,
      tileWidth: 1,
      tileHeight: 1,
      noDataValue: null,
      isWgs84: true,
      warnings: []
    });

    const testableController = controller as unknown as {
      latestFixTimestampMs: number;
      scheduleAglRefresh: (state: AircraftState) => void;
    };
    const first = { ...aircraftFix(50, 14, 1_000, 450), gpsAltitudeM: 410 };
    const second = { ...aircraftFix(50.001, 14.001, 2_000, 451), gpsAltitudeM: 411 };
    const third = { ...aircraftFix(50.002, 14.002, 3_000, 452), gpsAltitudeM: 412 };
    testableController.latestFixTimestampMs = third.timestampMs;
    testableController.scheduleAglRefresh(first);
    await vi.waitFor(() => expect(sampleElevation).toHaveBeenCalledTimes(1));
    testableController.scheduleAglRefresh(second);
    testableController.scheduleAglRefresh(third);

    await Promise.resolve();
    expect(sampleElevation).toHaveBeenCalledTimes(1);
    resolveFirstSample({ status: 'ok', elevationM: 300 });

    await vi.waitFor(() => expect(sampleElevation).toHaveBeenCalledTimes(2));
    expect(sampleElevation).toHaveBeenLastCalledWith(50.002, 14.002);
  });
});
