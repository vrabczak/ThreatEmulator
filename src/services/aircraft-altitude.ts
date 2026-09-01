/**
 * Publishes current GNSS aircraft data and coordinates asynchronous altitude and terrain processing.
 * EGM96 conversion and terrain requests may finish out of order, so the latest GNSS timestamp always wins.
 */

import { calculateAgl, resolveTerrainElevationM } from '../domain/altitude';
import { Egm96GeoidModel } from '../domain/geoid';
import type { AircraftState, TerrainMetadata, TerrainSample, TerrainService } from '../domain/types';

export interface AircraftAltitudeControllerOptions {
  terrainService: TerrainService;
  onStateChanged: () => void;
}

/**
 * Owns the latest aircraft state and its terrain-elevation fallback.
 * Raw position data is published immediately, while converted altitude is applied only to the matching latest fix.
 */
export class AircraftAltitudeController {
  private readonly geoidModel = new Egm96GeoidModel();
  private aircraft: AircraftState | null = null;
  private terrainMetadata: TerrainMetadata | null = null;
  private latestFixTimestampMs: number | null = null;
  private lastTerrainElevationM: number | null = null;
  private lastTerrainReason: string | null = null;
  private aglRefreshInFlight = false;
  private queuedAglState: AircraftState | null = null;

  /**
   * Creates the altitude controller with the terrain service shared by threat evaluation.
   * @param options - Terrain dependency and redraw notification callback.
   */
  public constructor(private readonly options: AircraftAltitudeControllerOptions) {}

  /**
   * Gets the latest aircraft state available for rendering and evaluation.
   * @returns The latest raw or fully converted GNSS state.
   */
  public get aircraftState(): AircraftState | null {
    return this.aircraft;
  }

  /**
   * Gets the current terrain sampling or altitude-conversion warning.
   * @returns A user-facing reason, or `null` when altitude processing is current.
   */
  public get terrainReason(): string | null {
    return this.lastTerrainReason;
  }

  /**
   * Accepts a raw browser GNSS fix and starts its asynchronous EGM96 conversion.
   * @param state - Normalized aircraft state containing ellipsoid altitude.
   * @returns Nothing.
   */
  public acceptFix(state: AircraftState): void {
    this.latestFixTimestampMs = state.timestampMs;
    // Position, accuracy, and track must never wait for optional altitude conversion.
    this.aircraft = state;
    this.lastTerrainReason =
      state.gpsEllipsoidAltitudeM === null ? 'Aircraft GPS altitude is unavailable.' : null;
    this.options.onStateChanged();
    void this.convertAltitudeToMsl(state);
  }

  /**
   * Replaces the terrain context used for AGL and clears elevation cached from the previous terrain.
   * @param metadata - Loaded terrain metadata, or `null` while terrain is absent or being replaced.
   * @returns Nothing.
   */
  public setTerrainMetadata(metadata: TerrainMetadata | null): void {
    this.terrainMetadata = metadata;
    this.lastTerrainElevationM = null;
    this.lastTerrainReason = null;
    if (this.aircraft) {
      this.aircraft = { ...this.aircraft, aglM: null };
    }
    this.options.onStateChanged();
    if (metadata && this.aircraft) {
      this.scheduleAglRefresh(this.aircraft);
    }
  }

  private async convertAltitudeToMsl(state: AircraftState): Promise<void> {
    if (state.gpsEllipsoidAltitudeM === null) {
      return;
    }

    let gpsAltitudeMslM: number;
    try {
      gpsAltitudeMslM = await this.geoidModel.ellipsoidHeightToMslM(
        state.gpsEllipsoidAltitudeM,
        state.latitude,
        state.longitude
      );
    } catch (error) {
      if (
        this.latestFixTimestampMs === state.timestampMs &&
        this.aircraft?.timestampMs === state.timestampMs
      ) {
        this.lastTerrainReason =
          error instanceof Error ? error.message : 'Unable to convert GPS altitude to MSL.';
        this.options.onStateChanged();
      }
      return;
    }

    // Geoid loading/conversion is asynchronous; a newer GNSS fix must always win this race.
    if (this.latestFixTimestampMs !== state.timestampMs) {
      return;
    }

    const convertedState: AircraftState = {
      ...state,
      gpsAltitudeM: gpsAltitudeMslM,
      aglM: calculateAgl(gpsAltitudeMslM, this.lastTerrainElevationM)
    };
    this.aircraft = convertedState;
    this.lastTerrainReason =
      this.lastTerrainElevationM === null
        ? null
        : 'Using last retrieved terrain elevation while the current lookup completes.';
    this.options.onStateChanged();
    this.scheduleAglRefresh(convertedState);
  }

  private scheduleAglRefresh(state: AircraftState): void {
    if (!this.terrainMetadata || state.gpsAltitudeM === null) {
      return;
    }

    if (this.aglRefreshInFlight) {
      // GNSS can update faster than GeoTIFF reads. Keep only the newest pending position so obsolete
      // aircraft samples cannot compete with the periodic LOS calculation in the shared worker.
      this.queuedAglState = state;
      return;
    }

    this.aglRefreshInFlight = true;
    void this.refreshAgl(state).finally(() => {
      this.aglRefreshInFlight = false;
      const queuedState = this.queuedAglState;
      this.queuedAglState = null;
      if (queuedState && queuedState.timestampMs === this.latestFixTimestampMs) {
        this.scheduleAglRefresh(queuedState);
      }
    });
  }

  private async refreshAgl(state: AircraftState): Promise<void> {
    if (!this.terrainMetadata || state.gpsAltitudeM === null) {
      return;
    }

    let sample: TerrainSample;
    try {
      sample = await this.options.terrainService.sampleElevation(state.latitude, state.longitude);
    } catch (error) {
      sample = {
        status: 'terrain-unavailable',
        reason: error instanceof Error ? error.message : 'Unable to read aircraft terrain elevation.'
      };
    }
    // Terrain sampling can finish out of order, so never apply AGL to a newer aircraft fix.
    if (this.aircraft?.timestampMs !== state.timestampMs) {
      return;
    }

    const terrainElevationM = resolveTerrainElevationM(sample, this.lastTerrainElevationM);
    if (sample.status === 'ok') {
      this.lastTerrainElevationM = sample.elevationM;
      this.lastTerrainReason = null;
    } else if (this.lastTerrainElevationM !== null) {
      this.lastTerrainReason = `${sample.reason} Using last retrieved terrain elevation.`;
    } else {
      this.lastTerrainReason = sample.reason;
    }

    this.aircraft = {
      ...state,
      aglM: calculateAgl(state.gpsAltitudeM, terrainElevationM)
    };
    this.options.onStateChanged();
  }
}
