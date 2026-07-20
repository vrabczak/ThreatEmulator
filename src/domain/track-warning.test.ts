/**
 * Verifies track selection, stale-track behavior, clock directions, and warning text.
 * Tests combine the track and warning domain modules with fixed timestamps and positions.
 */

import { deriveTrackFromFixes, resolveTrack } from './track';
import {
  buildThreatWarning,
  clockCodeFromRelativeBearing,
  reconcileActiveThreatOrder
} from './warning';
import type { AircraftState, ThreatEvaluationResult } from './types';

describe('track handling', () => {
  it('uses browser heading first and stale track for 10 seconds', () => {
    const browser = resolveTrack(90, null, null, 1000);
    expect(browser.trackSource).toBe('browser');
    expect(browser.trackDegrees).toBe(90);

    const stale = resolveTrack(null, null, browser.reliableTrack, 10_500);
    expect(stale.trackSource).toBe('stale');
    expect(stale.trackDegrees).toBe(90);

    const expired = resolveTrack(null, null, browser.reliableTrack, 12_000);
    expect(expired.trackSource).toBe('unavailable');
  });

  it('derives track from successive fixes when movement is sufficient', () => {
    const track = deriveTrackFromFixes(
      { latitude: 50, longitude: 14, timestampMs: 0 },
      { latitude: 50, longitude: 14.01, timestampMs: 1000 }
    );

    expect(track).not.toBeNull();
    expect(track as number).toBeGreaterThan(89);
    expect(track as number).toBeLessThan(91);
  });
});

describe('warning call', () => {
  const aircraft: AircraftState = {
    latitude: 50,
    longitude: 14,
    gpsEllipsoidAltitudeM: 600,
    gpsAltitudeM: 600,
    gpsAltitudeAccuracyM: 5,
    gpsAccuracyM: 8,
    aglM: 200,
    trackDegrees: 0,
    trackSource: 'browser',
    trackAgeMs: 0,
    timestampMs: 1000
  };
  const activeResult: ThreatEvaluationResult = {
    threat: {
      id: 'T001',
      name: 'Alpha',
      latitude: 50,
      longitude: 14.1,
      heightAglM: 10,
      rangeKm: 20
    },
    state: 'active',
    distanceKm: 7.2,
    reason: 'Inside range with clear line of sight.'
  };

  it('converts relative bearing to clock code', () => {
    expect(clockCodeFromRelativeBearing(0)).toBe(12);
    expect(clockCodeFromRelativeBearing(90)).toBe(3);
    expect(clockCodeFromRelativeBearing(180)).toBe(6);
    expect(clockCodeFromRelativeBearing(270)).toBe(9);
  });

  it('builds threat warning text', () => {
    expect(buildThreatWarning(activeResult, aircraft)).toBe("THREAT 3 O'CLOCK 7 KM");
    expect(buildThreatWarning(activeResult, { ...aircraft, trackDegrees: null })).toBe(
      'THREAT ALPHA 7 KM TRACK UNAVAILABLE'
    );
    expect(
      buildThreatWarning(
        { ...activeResult, threat: { ...activeResult.threat, name: '' } },
        { ...aircraft, trackDegrees: null }
      )
    ).toBe('THREAT T001 7 KM TRACK UNAVAILABLE');
  });

  it('keeps first-appearance order and appends a reactivated threat', () => {
    const secondResult: ThreatEvaluationResult = {
      ...activeResult,
      threat: { ...activeResult.threat, id: 'T002' }
    };
    const thirdResult: ThreatEvaluationResult = {
      ...activeResult,
      threat: { ...activeResult.threat, id: 'T003' }
    };

    const firstOrder = reconcileActiveThreatOrder([], [activeResult, secondResult]);
    expect(firstOrder).toEqual(['T001', 'T002']);

    const afterThirdAppears = reconcileActiveThreatOrder(firstOrder, [
      secondResult,
      activeResult,
      thirdResult
    ]);
    expect(afterThirdAppears).toEqual(['T001', 'T002', 'T003']);

    const afterFirstDisappears = reconcileActiveThreatOrder(afterThirdAppears, [
      { ...activeResult, state: 'inactive' },
      secondResult,
      thirdResult
    ]);
    expect(afterFirstDisappears).toEqual(['T002', 'T003']);

    const afterFirstReappears = reconcileActiveThreatOrder(afterFirstDisappears, [
      activeResult,
      secondResult,
      thirdResult
    ]);
    expect(afterFirstReappears).toEqual(['T002', 'T003', 'T001']);
  });
});
