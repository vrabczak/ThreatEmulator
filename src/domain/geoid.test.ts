/**
 * Verifies EGM96 interpolation, longitude wrapping, and ellipsoid-to-MSL conversion.
 * Tests inject small synthetic grid readers instead of loading the bundled geoid asset.
 */

import { ellipsoidHeightToMslM, interpolateEgm96GeoidHeightM } from './geoid';

describe('EGM96 geoid conversion', () => {
  it('bilinearly interpolates between grid posts', () => {
    const result = interpolateEgm96GeoidHeightM(89.875, 0.125, (row, column) => {
      if (row === 0 && column === 0) return 10;
      if (row === 0 && column === 1) return 20;
      if (row === 1 && column === 0) return 30;
      if (row === 1 && column === 1) return 40;
      throw new Error(`Unexpected grid post ${row},${column}`);
    });

    expect(result).toBe(25);
  });

  it('wraps negative longitude across the antimeridian', () => {
    const result = interpolateEgm96GeoidHeightM(90, -0.125, (_row, column) =>
      column === 1439 ? 20 : 40
    );

    expect(result).toBe(30);
  });

  it('converts ellipsoidal height to orthometric MSL height', () => {
    expect(ellipsoidHeightToMslM(500, 42.5)).toBe(457.5);
    expect(ellipsoidHeightToMslM(500, -25)).toBe(525);
  });
});
