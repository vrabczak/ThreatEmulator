/**
 * Verifies live threat-change and emulator-run coordination without constructing browser UI controllers.
 * Bare application instances exercise the real private orchestration methods with controlled terrain promises.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AircraftState,
  LineOfSightBatchResult,
  TerrainMetadata,
  TerrainService,
  Threat
} from './domain/types';

vi.mock('./ui/map-controller', () => ({ MapController: vi.fn() }));

import { ThreatEmulatorApp } from './threat-emulator-app';

type TestableThreatEmulatorApp = {
  threats: Threat[];
  threatsModified: boolean;
  threatRevision: number;
  emulatorRunRevision: number;
  emulatorActive: boolean;
  evaluationInFlight: boolean;
  lastEvaluation: unknown;
  activeThreatOrder: string[];
  terrainService: TerrainService;
  terrainController: { metadata: TerrainMetadata | null };
  aircraftAltitudeController: {
    aircraftState: AircraftState | null;
    evaluationAircraftState: AircraftState | null;
  };
  commitThreatChange: (message: string) => void;
  evaluateNow: () => Promise<void>;
  render: () => void;
  setMessage: (message: string, tone: string) => void;
};

const threat: Threat = {
  id: 'T001',
  name: 'Alpha',
  latitude: 50,
  longitude: 14.1,
  heightAglM: 10,
  rangeKm: 20
};

const aircraft: AircraftState = {
  latitude: 50,
  longitude: 14,
  gpsEllipsoidAltitudeM: 500,
  gpsAltitudeM: 500,
  gpsAltitudeAccuracyM: null,
  gpsAccuracyM: null,
  aglM: null,
  trackDegrees: null,
  trackSource: 'unavailable',
  trackAgeMs: null,
  timestampMs: Date.now()
};

const metadata: TerrainMetadata = {
  fileName: 'terrain.tif',
  fileSize: 1024,
  width: 100,
  height: 100,
  bbox: [14, 49, 15, 50],
  resolutionDeg: { longitude: 0.01, latitude: 0.01 },
  samplesPerPixel: 1,
  tileWidth: 100,
  tileHeight: 100,
  noDataValue: null,
  isWgs84: true,
  warnings: []
};

describe('ThreatEmulatorApp evaluation lifecycle', () => {
  it('cancels stale LOS work before requesting evaluation of an edited threat list', () => {
    const events: string[] = [];
    const app = Object.create(ThreatEmulatorApp.prototype) as TestableThreatEmulatorApp;
    Object.assign(app, {
      threats: [threat],
      threatsModified: false,
      threatRevision: 4,
      emulatorActive: true,
      lastEvaluation: { stale: true },
      activeThreatOrder: ['T001'],
      terrainService: {
        cancelEvaluation: () => events.push('evaluation canceled')
      } as unknown as TerrainService,
      evaluateNow: vi.fn(async () => {
        events.push('evaluation requested');
      }),
      render: vi.fn(),
      setMessage: vi.fn()
    });

    app.commitThreatChange('Threat T001 updated.');

    expect(app.threatRevision).toBe(5);
    expect(app.lastEvaluation).toBeNull();
    expect(events).toEqual(['evaluation canceled', 'evaluation requested']);
  });

  it('starts a fresh evaluation when an older run settles after rapid Stop and Start', async () => {
    let resolveFirst!: (results: LineOfSightBatchResult[]) => void;
    let resolveSecond!: (results: LineOfSightBatchResult[]) => void;
    const firstBatch = new Promise<LineOfSightBatchResult[]>((resolve) => {
      resolveFirst = resolve;
    });
    const secondBatch = new Promise<LineOfSightBatchResult[]>((resolve) => {
      resolveSecond = resolve;
    });
    const evaluateLineOfSightBatch = vi.fn()
      .mockReturnValueOnce(firstBatch)
      .mockReturnValueOnce(secondBatch);
    const terrainService = {
      getMetadata: () => metadata,
      evaluateLineOfSightBatch,
      evaluateLineOfSight: vi.fn()
    } as unknown as TerrainService;
    const app = Object.create(ThreatEmulatorApp.prototype) as TestableThreatEmulatorApp;
    Object.assign(app, {
      threats: [threat],
      threatRevision: 1,
      emulatorRunRevision: 1,
      emulatorActive: true,
      evaluationInFlight: false,
      evaluationTimer: null,
      countdownTimer: null,
      lastEvaluation: null,
      activeThreatOrder: [],
      geolocationStatus: 'tracking',
      geolocationMessage: 'GNSS position current.',
      terrainService,
      terrainController: { metadata },
      aircraftAltitudeController: {
        aircraftState: aircraft,
        evaluationAircraftState: aircraft
      },
      render: vi.fn(),
      setMessage: vi.fn()
    });

    const firstEvaluation = app.evaluateNow();
    await vi.waitFor(() => expect(evaluateLineOfSightBatch).toHaveBeenCalledTimes(1));

    // Simulate Stop followed by Start before the canceled evaluation's promise settles.
    app.emulatorRunRevision = 3;
    resolveFirst([{ threatId: threat.id, result: { status: 'clear', sampleCount: 1 } }]);
    await firstEvaluation;

    await vi.waitFor(() => expect(evaluateLineOfSightBatch).toHaveBeenCalledTimes(2));

    app.emulatorActive = false;
    app.emulatorRunRevision = 4;
    resolveSecond([{ threatId: threat.id, result: { status: 'clear', sampleCount: 1 } }]);
    await vi.waitFor(() => expect(app.evaluationInFlight).toBe(false));
  });
});
