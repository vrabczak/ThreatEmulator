/**
 * Converts GNSS ellipsoid heights to mean sea level with the bundled EGM96 geoid grid.
 * The grid is fetched through Vite as a big-endian, quarter-degree DAC asset and cached per model.
 */

import egm96GridUrl from 'egm96/WW15MGH.DAC?url';

const GRID_INTERVAL_DEGREES = 0.25;
const GRID_ROWS = 721;
const GRID_COLUMNS = 1440;
const GRID_SIZE_BYTES = GRID_ROWS * GRID_COLUMNS * Int16Array.BYTES_PER_ELEMENT;

export type GeoidGridReader = (row: number, column: number) => number;

/**
 * Bilinearly interpolates an EGM96 geoid height from neighboring quarter-degree grid posts.
 * @param latitude - WGS84 latitude in degrees.
 * @param longitude - WGS84 longitude in degrees; values wrap around the antimeridian.
 * @param readHeightM - Callback that returns a grid-post height in meters.
 * @returns Interpolated geoid height in meters.
 * @throws {RangeError} When latitude or longitude is non-finite, or latitude is outside [-90, 90].
 */
export function interpolateEgm96GeoidHeightM(
  latitude: number,
  longitude: number,
  readHeightM: GeoidGridReader
): number {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('Latitude and longitude must be finite WGS84 coordinates.');
  }

  // EGM96 rows run north-to-south while columns wrap eastward across the antimeridian.
  const normalizedLongitude = ((longitude % 360) + 360) % 360;
  const rowPosition = (90 - latitude) / GRID_INTERVAL_DEGREES;
  const columnPosition = normalizedLongitude / GRID_INTERVAL_DEGREES;
  const topRow = Math.min(Math.floor(rowPosition), GRID_ROWS - 1);
  const bottomRow = Math.min(topRow + 1, GRID_ROWS - 1);
  const leftColumn = Math.floor(columnPosition) % GRID_COLUMNS;
  const rightColumn = (leftColumn + 1) % GRID_COLUMNS;
  const latitudeFraction = rowPosition - topRow;
  const longitudeFraction = columnPosition - Math.floor(columnPosition);

  // Interpolate east-west on both bounding rows, then north-south between those results.
  const top =
    readHeightM(topRow, leftColumn) * (1 - longitudeFraction) +
    readHeightM(topRow, rightColumn) * longitudeFraction;
  const bottom =
    readHeightM(bottomRow, leftColumn) * (1 - longitudeFraction) +
    readHeightM(bottomRow, rightColumn) * longitudeFraction;

  return top * (1 - latitudeFraction) + bottom * latitudeFraction;
}

/**
 * Converts an ellipsoid height to orthometric mean-sea-level height.
 * @param ellipsoidHeightM - Height above the reference ellipsoid in meters.
 * @param geoidHeightM - EGM96 geoid separation in meters.
 * @returns Orthometric height above mean sea level in meters.
 */
export function ellipsoidHeightToMslM(ellipsoidHeightM: number, geoidHeightM: number): number {
  return ellipsoidHeightM - geoidHeightM;
}

/**
 * Lazily loads and queries the bundled EGM96 grid for altitude conversion.
 * A single in-flight or fulfilled grid promise is retained for the lifetime of each instance.
 */
export class Egm96GeoidModel {
  private gridPromise: Promise<DataView> | null = null;

  /**
   * Looks up the interpolated geoid separation at a WGS84 position.
   * @param latitude - WGS84 latitude in degrees.
   * @param longitude - WGS84 longitude in degrees.
   * @returns Geoid separation in meters.
   * @throws {Error} When the grid cannot be fetched or has an unexpected byte length.
   * @throws {RangeError} When the coordinates are invalid.
   */
  async geoidHeightM(latitude: number, longitude: number): Promise<number> {
    const grid = await this.loadGrid();
    return interpolateEgm96GeoidHeightM(
      latitude,
      longitude,
      (row, column) => grid.getInt16((row * GRID_COLUMNS + column) * 2, false) / 100
    );
  }

  /**
   * Converts a GNSS ellipsoid height to EGM96 mean-sea-level height at a position.
   * @param ellipsoidHeightM - Height above the reference ellipsoid in meters.
   * @param latitude - WGS84 latitude in degrees.
   * @param longitude - WGS84 longitude in degrees.
   * @returns Orthometric height above mean sea level in meters.
   * @throws {Error} When the grid cannot be loaded or the coordinates are invalid.
   */
  async ellipsoidHeightToMslM(
    ellipsoidHeightM: number,
    latitude: number,
    longitude: number
  ): Promise<number> {
    return ellipsoidHeightToMslM(
      ellipsoidHeightM,
      await this.geoidHeightM(latitude, longitude)
    );
  }

  private loadGrid(): Promise<DataView> {
    this.gridPromise ??= fetch(egm96GridUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load EGM96 geoid grid (${response.status}).`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (buffer.byteLength !== GRID_SIZE_BYTES) {
          throw new Error(
            `Invalid EGM96 geoid grid size (${buffer.byteLength} bytes; expected ${GRID_SIZE_BYTES}).`
          );
        }
        return new DataView(buffer);
      });

    return this.gridPromise;
  }
}
