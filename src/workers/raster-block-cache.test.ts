/**
 * Verifies byte-bound enforcement, least-recently-used eviction, replacement, and reset behavior.
 * Tests use small array-like blocks so cache policy is independent of GeoTIFF decoding.
 */

import { RasterBlockCache, type DecodedRasterBlock } from './raster-block-cache';

describe('RasterBlockCache', () => {
  it('evicts the least recently used block while preserving a promoted block', () => {
    const cache = new RasterBlockCache(8);
    const first = createBlock(4, 1);
    const second = createBlock(4, 2);
    const third = createBlock(4, 3);

    cache.set('first', first);
    cache.set('second', second);
    expect(cache.get('first')).toBe(first);

    cache.set('third', third);

    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('first')).toBe(first);
    expect(cache.get('third')).toBe(third);
    expect(cache.byteLength).toBe(8);
    expect(cache.size).toBe(2);
  });

  it('updates byte accounting when an existing key is replaced', () => {
    const cache = new RasterBlockCache(8);

    cache.set('tile', createBlock(6, 1));
    cache.set('tile', createBlock(2, 2));

    expect(cache.byteLength).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('does not retain a block larger than the complete budget', () => {
    const cache = new RasterBlockCache(4);
    const retained = createBlock(4, 1);
    cache.set('retained', retained);

    expect(cache.set('oversized', createBlock(5, 2))).toBe(false);
    expect(cache.get('retained')).toBe(retained);
    expect(cache.get('oversized')).toBeUndefined();
    expect(cache.byteLength).toBe(4);
  });

  it('clears all retained blocks and byte accounting', () => {
    const cache = new RasterBlockCache(8);
    cache.set('tile', createBlock(4, 1));

    cache.clear();

    expect(cache.get('tile')).toBeUndefined();
    expect(cache.byteLength).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('rejects invalid budgets and block sizes', () => {
    expect(() => new RasterBlockCache(0)).toThrow(RangeError);
    const cache = new RasterBlockCache(8);

    expect(() => cache.set('invalid', createBlock(-1, 1))).toThrow(RangeError);
  });
});

function createBlock(byteLength: number, value: number): DecodedRasterBlock {
  return {
    values: [value],
    width: 1,
    height: 1,
    byteLength
  };
}
