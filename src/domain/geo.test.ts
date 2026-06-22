import {
  coordinateToPixel,
  distanceMeters,
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
});
