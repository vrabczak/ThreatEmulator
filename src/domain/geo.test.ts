import {
  coordinateToPixel,
  distanceMeters,
  formatThreatRange,
  initialBearingDegrees,
  relativeBearingDegrees
} from './geo';

describe('geo calculations', () => {
  it('calculates distance in meters', () => {
    const distance = distanceMeters(
      { latitude: 50, longitude: 14 },
      { latitude: 50.01, longitude: 14 }
    );

    expect(distance).toBeGreaterThan(1100);
    expect(distance).toBeLessThan(1120);
  });

  it('calculates bearing and relative bearing', () => {
    const bearing = initialBearingDegrees(
      { latitude: 50, longitude: 14 },
      { latitude: 50, longitude: 15 }
    );

    expect(bearing).toBeGreaterThan(89);
    expect(bearing).toBeLessThan(91);
    expect(relativeBearingDegrees(350, 10)).toBe(20);
  });

  it('converts coordinates to north-up raster pixels', () => {
    const pixel = coordinateToPixel(49.5, 14.5, {
      bbox: [14, 49, 15, 50],
      width: 100,
      height: 100
    });

    expect(pixel).toEqual({ x: 50, y: 50 });
    expect(coordinateToPixel(48, 14.5, { bbox: [14, 49, 15, 50], width: 100, height: 100 })).toBeNull();
  });

  it('formats threat ranges using display buckets', () => {
    expect(formatThreatRange(0)).toBe('100 m');
    expect(formatThreatRange(0.04)).toBe('100 m');
    expect(formatThreatRange(0.24)).toBe('200 m');
    expect(formatThreatRange(0.95)).toBe('1 km');
    expect(formatThreatRange(1.26)).toBe('1.5 km');
    expect(formatThreatRange(2.49)).toBe('2 km');
    expect(formatThreatRange(2.5)).toBe('3 km');
    expect(formatThreatRange(7.2)).toBe('7 km');
    expect(formatThreatRange(7.5)).toBe('8 km');
  });
});
