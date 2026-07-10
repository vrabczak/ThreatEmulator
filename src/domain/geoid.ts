import egm96GridUrl from 'egm96/WW15MGH.DAC?url';

const GRID_INTERVAL_DEGREES = 0.25;
const GRID_ROWS = 721;
const GRID_COLUMNS = 1440;
const GRID_SIZE_BYTES = GRID_ROWS * GRID_COLUMNS * Int16Array.BYTES_PER_ELEMENT;

export type GeoidGridReader = (row: number, column: number) => number;

export function interpolateEgm96GeoidHeightM(
  latitude: number,
  longitude: number,
  readHeightM: GeoidGridReader
): number {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('Latitude and longitude must be finite WGS84 coordinates.');
  }

  const normalizedLongitude = ((longitude % 360) + 360) % 360;
  const rowPosition = (90 - latitude) / GRID_INTERVAL_DEGREES;
  const columnPosition = normalizedLongitude / GRID_INTERVAL_DEGREES;
  const topRow = Math.min(Math.floor(rowPosition), GRID_ROWS - 1);
  const bottomRow = Math.min(topRow + 1, GRID_ROWS - 1);
  const leftColumn = Math.floor(columnPosition) % GRID_COLUMNS;
  const rightColumn = (leftColumn + 1) % GRID_COLUMNS;
  const latitudeFraction = rowPosition - topRow;
  const longitudeFraction = columnPosition - Math.floor(columnPosition);

  const top =
    readHeightM(topRow, leftColumn) * (1 - longitudeFraction) +
    readHeightM(topRow, rightColumn) * longitudeFraction;
  const bottom =
    readHeightM(bottomRow, leftColumn) * (1 - longitudeFraction) +
    readHeightM(bottomRow, rightColumn) * longitudeFraction;

  return top * (1 - latitudeFraction) + bottom * latitudeFraction;
}

export function ellipsoidHeightToMslM(ellipsoidHeightM: number, geoidHeightM: number): number {
  return ellipsoidHeightM - geoidHeightM;
}

export class Egm96GeoidModel {
  private gridPromise: Promise<DataView> | null = null;

  async geoidHeightM(latitude: number, longitude: number): Promise<number> {
    const grid = await this.loadGrid();
    return interpolateEgm96GeoidHeightM(
      latitude,
      longitude,
      (row, column) => grid.getInt16((row * GRID_COLUMNS + column) * 2, false) / 100
    );
  }

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
