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
    const third = aircraftFix(50.002, 14.004, 3_000);

    controller.acceptFix(first);
    controller.acceptFix(second);
    controller.acceptFix(third);

    expect(controller.aircraftState).toEqual(third);
    expect(controller.evaluationAircraftState).toEqual(third);
    expect(controller.terrainReason).toBe('Aircraft GPS altitude is unavailable.');
    expect(onStateChanged).toHaveBeenCalledTimes(4);
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
    const third = aircraftFix(50.002, 14.004, 3_000, 452);
    const fourth = aircraftFix(50.003, 14.006, 4_000, 453);

    controller.acceptFix(first);
    controller.acceptFix(second);
    controller.acceptFix(third);
    controller.acceptFix(fourth);

    expect(controller.aircraftState).toEqual(fourth);
    rejectGridLoad(new Error('Grid unavailable.'));
    await vi.waitFor(() => expect(controller.terrainReason).toBe('Grid unavailable.'));
    expect(controller.aircraftState).toEqual(fourth);
  });

  it('derives altitude, AGL, and the evaluation snapshot only from every third fix', async () => {
    const sampleElevation = vi.fn().mockResolvedValue({ status: 'ok', elevationM: 300 });
    const controller = new AircraftAltitudeController({
      terrainService: { sampleElevation } as unknown as TerrainService,
      onStateChanged: vi.fn()
    });
    const convertAltitude = vi.fn().mockResolvedValue(420);
    (controller as unknown as {
      geoidModel: { ellipsoidHeightToMslM: typeof convertAltitude };
    }).geoidModel.ellipsoidHeightToMslM = convertAltitude;
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

    controller.acceptFix(aircraftFix(50, 14, 1_000, 450));
    controller.acceptFix(aircraftFix(50.001, 14.001, 2_000, 451));
    expect(convertAltitude).not.toHaveBeenCalled();
    expect(sampleElevation).not.toHaveBeenCalled();
    expect(controller.evaluationAircraftState).toBeNull();

    controller.acceptFix(aircraftFix(50.002, 14.002, 3_000, 452));
    await vi.waitFor(() => expect(controller.evaluationAircraftState?.timestampMs).toBe(3_000));
    expect(convertAltitude).toHaveBeenCalledTimes(1);
    expect(sampleElevation).toHaveBeenCalledTimes(1);
    expect(controller.evaluationAircraftState).toMatchObject({
      latitude: 50.002,
      longitude: 14.002,
      gpsAltitudeM: 420,
      aglM: 120
    });
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
      selectedFixTimestampMs: number;
      scheduleAglRefresh: (state: AircraftState) => void;
    };
    const first = { ...aircraftFix(50, 14, 1_000, 450), gpsAltitudeM: 410 };
    const second = { ...aircraftFix(50.001, 14.001, 2_000, 451), gpsAltitudeM: 411 };
    const third = { ...aircraftFix(50.002, 14.002, 3_000, 452), gpsAltitudeM: 412 };
    testableController.selectedFixTimestampMs = third.timestampMs;
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
