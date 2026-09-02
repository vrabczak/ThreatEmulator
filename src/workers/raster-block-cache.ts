/**
 * Provides a byte-bounded LRU cache for decoded GeoTIFF raster blocks.
 * Entries contain only band-zero samples and are owned by the terrain worker that loaded them.
 */

export interface DecodedRasterBlock {
  values: ArrayLike<number>;
  width: number;
  height: number;
  byteLength: number;
}

/**
 * Retains recently used decoded raster blocks without allowing terrain data to grow without bound.
 * Reading an entry promotes it, while insertion evicts least-recently-used entries as necessary.
 */
export class RasterBlockCache {
  private readonly entries = new Map<string, DecodedRasterBlock>();
  private cachedBytes = 0;

  /**
   * Creates an empty cache with a fixed byte budget.
   * @param maxBytes - Maximum combined byte length of retained raster blocks.
   * @throws {RangeError} When the budget is not a positive finite integer.
   */
  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Raster block cache size must be a positive safe integer.');
    }
  }

  /**
   * Retrieves and promotes a decoded raster block.
   * @param key - Raster-generation and block-coordinate cache key.
   * @returns The cached block, or `undefined` when it is not retained.
   */
  get(key: string): DecodedRasterBlock | undefined {
    const block = this.entries.get(key);
    if (!block) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, block);
    return block;
  }

  /**
   * Retains a decoded block and evicts older blocks to remain within the byte budget.
   * @param key - Raster-generation and block-coordinate cache key.
   * @param block - Decoded band-zero raster values and their dimensions.
   * @returns `true` when the block was retained, or `false` when it exceeds the complete budget.
   * @throws {RangeError} When the block byte length is invalid.
   */
  set(key: string, block: DecodedRasterBlock): boolean {
    if (!Number.isSafeInteger(block.byteLength) || block.byteLength < 0) {
      throw new RangeError('Decoded raster block byte length must be a non-negative safe integer.');
    }
    if (block.byteLength > this.maxBytes) {
      return false;
    }

    this.remove(key);
    while (this.cachedBytes + block.byteLength > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.remove(oldestKey);
    }

    this.entries.set(key, block);
    this.cachedBytes += block.byteLength;
    return true;
  }

  /**
   * Removes every decoded raster block, such as when a new terrain model is loaded.
   * @returns Nothing.
   */
  clear(): void {
    this.entries.clear();
    this.cachedBytes = 0;
  }

  /**
   * Reports the memory represented by retained decoded arrays.
   * @returns Combined byte length of all cached blocks.
   */
  get byteLength(): number {
    return this.cachedBytes;
  }

  /**
   * Reports how many decoded raster blocks are currently retained.
   * @returns Number of cached blocks.
   */
  get size(): number {
    return this.entries.size;
  }

  private remove(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) {
      return;
    }

    this.entries.delete(key);
    this.cachedBytes -= existing.byteLength;
  }
}
