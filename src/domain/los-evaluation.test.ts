/**
 * Verifies terrain sampling, line-of-sight states, AGL fallback, and threat prioritization.
 * Tests use deterministic aircraft/threat fixtures and an in-memory TerrainService double.
 */

import { calculateAgl, evaluateThreats, resolveTerrainElevationM } from './evaluation';
import {
  calculateTerrainSampleSpacingM,
  evaluateFlatEarthLineOfSight,
  type TerrainSampler
} from './los';
import type {
  AircraftState,
  LineOfSightOptions,
  LineOfSightResult,
  TerrainMetadata,
  TerrainSample,
  TerrainService,
  Threat
} from './types';

const aircraft: AircraftState = {
  latitude: 50,
  longitude: 14.02,
  gpsEllipsoidAltitudeM: 500,
  gpsAltitudeM: 500,
  gpsAltitudeAccuracyM: 5,
  gpsAccuracyM: 8,
  aglM: 120,
  trackDegrees: 90,
  trackSource: 'browser',
  trackAgeMs: 0,
  timestampMs: 1000
};

const closeThreat: Threat = {
  id: 'T001',
  name: 'Close',
  latitude: 50,
  longitude: 14,
  heightAglM: 20,
  rangeKm: 5
};

describe('line of sight', () => {
  it('derives sample spacing from GeoTIFF resolution', () => {
    const spacingM = calculateTerrainSampleSpacingM(createTerrainMetadata(), 60);

    expect(spacingM).toBeGreaterThan(55);
    expect(spacingM).toBeLessThan(56);
  });

  it('returns clear when terrain is below the sight line', async () => {
    const sampler: TerrainSampler = async () => ({ status: 'ok', elevationM: 100 });

    const result = await evaluateFlatEarthLineOfSight(aircraft, closeThreat, sampler, {
      maxSampleSpacingM: 1000
    });

    expect(result.status).toBe('clear');
  });

  it('returns clear when aircraft range is closer than sample spacing', async () => {
    let sampleCount = 0;
    const sampler: TerrainSampler = async () => {
      sampleCount += 1;
      return sampleCount === 1
        ? { status: 'ok', elevationM: 100 }
        : { status: 'ok', elevationM: 1000 };
    };

    const result = await evaluateFlatEarthLineOfSight(
      {
        ...aircraft,
        longitude: 14.0001
      },
      closeThreat,
      sampler,
      { maxSampleSpacingM: 100 }
    );

    expect(result.status).toBe('clear');
    expect(sampleCount).toBe(1);
  });

  it('returns blocked when terrain reaches the sight line', async () => {
    const sampler: TerrainSampler = async (latitude, longitude) => {
      if (longitude > 14 && longitude < 14.02) {
        return { status: 'ok', elevationM: 450 };
      }
      return { status: 'ok', elevationM: 100 };
    };

    const result = await evaluateFlatEarthLineOfSight(aircraft, closeThreat, sampler, {
      maxSampleSpacingM: 1000
    });

    expect(result.status).toBe('blocked');
  });

  it('ignores GPS altitude accuracy and blocks at the precise sight-line height', async () => {
    const sampler: TerrainSampler = async (_latitude, longitude) => {
      if (longitude > 14 && longitude < 14.02) {
        return { status: 'ok', elevationM: 310 };
      }
      return { status: 'ok', elevationM: 100 };
    };

    const result = await evaluateFlatEarthLineOfSight(
      { ...aircraft, gpsAltitudeAccuracyM: 4.2 },
      closeThreat,
      sampler,
      { maxSampleSpacingM: 1000 }
    );

    expect(result.status).toBe('blocked');
  });

  it('returns terrain unavailable for missing samples', async () => {
    const sampler: TerrainSampler = async () => ({
      status: 'terrain-unavailable',
      reason: 'outside coverage'
    });

    const result = await evaluateFlatEarthLineOfSight(aircraft, closeThreat, sampler);

    expect(result.status).toBe('terrain-unavailable');
  });

  it('always returns clear for a magic threat without sampling terrain', async () => {
    let sampleCount = 0;
    const result = await evaluateFlatEarthLineOfSight(
      { ...aircraft, gpsAltitudeM: null },
      { ...closeThreat, heightAglM: null },
      async () => {
        sampleCount += 1;
        return { status: 'terrain-unavailable', reason: 'outside coverage' };
      }
    );

    expect(result).toEqual({ status: 'clear', sampleCount: 0 });
    expect(sampleCount).toBe(0);
  });
});

describe('threat evaluation', () => {
  it('calculates AGL altitude', () => {
    expect(calculateAgl(600, 450)).toBe(150);
    expect(calculateAgl(null, 450)).toBeNull();
    expect(calculateAgl(460, 450)).toBeCloseTo(15.24, 2);
    expect(calculateAgl(400, 450)).toBeCloseTo(15.24, 2);
  });

  it('uses the last retrieved aircraft terrain elevation when a new sample is unavailable', () => {
    expect(resolveTerrainElevationM({ status: 'ok', elevationM: 420 }, 400)).toBe(420);
    expect(
      resolveTerrainElevationM(
        { status: 'terrain-unavailable', reason: 'outside coverage' },
        400
      )
    ).toBe(400);
    expect(
      resolveTerrainElevationM(
        { status: 'terrain-unavailable', reason: 'outside coverage' },
        null
      )
    ).toBeNull();
  });

  it('prioritizes the closest active threat', async () => {
    const terrain = createMockTerrainService({ status: 'clear', sampleCount: 3 });
    const fartherThreat = { ...closeThreat, id: 'T002', name: 'Farther', longitude: 14.06, rangeKm: 10 };

    const result = await evaluateThreats([fartherThreat, closeThreat], aircraft, terrain, {
      maxLosSampleSpacingM: 1000
    });

    expect(result.results).toHaveLength(2);
    expect(result.primary?.threat.id).toBe('T001');
  });

  it('marks out-of-range threats inactive before LOS', async () => {
    const terrain = createMockTerrainService({ status: 'clear', sampleCount: 3 });
    const result = await evaluateThreats([{ ...closeThreat, rangeKm: 0.1 }], aircraft, terrain);

    expect(result.results[0].state).toBe('inactive');
  });

  it('assumes clear LOS and only applies range when no elevation model is loaded', async () => {
    const terrain = createMockTerrainService({
      status: 'blocked',
      sampleCount: 1,
      blockedAt: {
        latitude: 50,
        longitude: 14.01,
        terrainElevationM: 500,
        sightLineElevationM: 400,
        distanceFromThreatM: 500
      }
    });
    terrain.evaluateLineOfSight = async () => {
      throw new Error('LOS should not be evaluated without an elevation model.');
    };
    terrain.evaluateLineOfSightBatch = async () => {
      throw new Error('LOS batch should not be evaluated without an elevation model.');
    };

    const outOfRangeThreat = { ...closeThreat, id: 'T002', rangeKm: 0.1 };
    const result = await evaluateThreats([closeThreat, outOfRangeThreat], aircraft, terrain);

    expect(result.results[0]).toMatchObject({
      state: 'active',
      lineOfSight: { status: 'clear', sampleCount: 0 }
    });
    expect(result.results[0].reason).toContain('line of sight is assumed clear');
    expect(result.results[1]).toMatchObject({
      state: 'inactive',
      lineOfSight: { status: 'clear', sampleCount: 0 }
    });
    expect(result.primary?.threat.id).toBe('T001');
  });

  it('does not create false warnings when terrain is unavailable', async () => {
    const terrain = createMockTerrainService({
      status: 'terrain-unavailable',
      sampleCount: 0,
      reason: 'outside coverage'
    }, createTerrainMetadata());
    const result = await evaluateThreats([closeThreat], aircraft, terrain);

    expect(result.primary).toBeNull();
    expect(result.results[0].state).toBe('terrain unavailable');
  });

  it('activates an in-range magic threat without GPS altitude or terrain LOS', async () => {
    let evaluatedThreatCount = 0;
    const terrain = createMockTerrainService(
      {
        status: 'blocked',
        sampleCount: 1,
        blockedAt: {
          latitude: 50,
          longitude: 14.01,
          terrainElevationM: 500,
          sightLineElevationM: 400,
          distanceFromThreatM: 500
        }
      },
      createTerrainMetadata(),
      undefined,
      (threats) => {
        evaluatedThreatCount += threats.length;
      }
    );

    const result = await evaluateThreats(
      [{ ...closeThreat, heightAglM: null }],
      { ...aircraft, gpsAltitudeM: null },
      terrain
    );

    expect(result.results[0]).toMatchObject({
      state: 'active',
      lineOfSight: { status: 'clear', sampleCount: 0 }
    });
    expect(result.results[0].reason).toContain('magic threat');
    expect(evaluatedThreatCount).toBe(0);
  });

  it('uses GeoTIFF resolution as the default LOS sample spacing', async () => {
    let capturedOptions: LineOfSightOptions | undefined;
    const terrain = createMockTerrainService(
      { status: 'clear', sampleCount: 3 },
      createTerrainMetadata(),
      (options) => {
        capturedOptions = options;
      }
    );

    await evaluateThreats([closeThreat], aircraft, terrain);

    expect(capturedOptions?.maxSampleSpacingM).toBeGreaterThan(71);
    expect(capturedOptions?.maxSampleSpacingM).toBeLessThan(72);
  });
});

function createMockTerrainService(
  lineOfSight: LineOfSightResult,
  metadata: TerrainMetadata | null = null,
  onBatchOptions?: (options: LineOfSightOptions | undefined) => void,
  onBatchThreats?: (threats: Threat[]) => void
): TerrainService {
  return {
    async loadGeoTiff(): Promise<TerrainMetadata> {
      throw new Error('not implemented');
    },
    getMetadata(): TerrainMetadata | null {
      return metadata;
    },
    async sampleElevation(): Promise<TerrainSample> {
      return { status: 'ok', elevationM: 100 };
    },
    async evaluateLineOfSight(): Promise<LineOfSightResult> {
      return lineOfSight;
    },
    async evaluateLineOfSightBatch(
      _aircraft: AircraftState,
      threats: Threat[],
      options?: LineOfSightOptions
    ): Promise<Array<{ threatId: string; result: LineOfSightResult }>> {
      onBatchOptions?.(options);
      onBatchThreats?.(threats);
      return threats.map((threat) => ({ threatId: threat.id, result: lineOfSight }));
    },
    cancelPending(): void {},
    dispose(): void {}
  };
}

function createTerrainMetadata(): TerrainMetadata {
  return {
    fileName: 'terrain.tif',
    fileSize: 1024,
    width: 1000,
    height: 1000,
    bbox: [14, 49, 15, 50],
    resolutionDeg: { longitude: 0.001, latitude: 0.001 },
    samplesPerPixel: 1,
    tileWidth: 256,
    tileHeight: 256,
    noDataValue: null,
    isWgs84: true,
    warnings: []
  };
}
