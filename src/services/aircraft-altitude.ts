/**
 * Coordinates asynchronous aircraft altitude conversion and terrain-based AGL sampling.
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
 * Owns the latest fully converted aircraft state and its terrain-elevation fallback.
 * Raw fixes become evaluable only after EGM96 conversion, and terrain changes invalidate cached AGL state.
 */
export class AircraftAltitudeController {
  private readonly geoidModel = new Egm96GeoidModel();
  private aircraft: AircraftState | null = null;
  private terrainMetadata: TerrainMetadata | null = null;
  private latestFixTimestampMs: number | null = null;
  private lastTerrainElevationM: number | null = null;
  private lastTerrainReason: string | null = null;

  /**
   * Creates the altitude controller with the terrain service shared by threat evaluation.
   * @param options - Terrain dependency and redraw notification callback.
   */
  public constructor(private readonly options: AircraftAltitudeControllerOptions) {}

  /**
   * Gets the latest aircraft state that is safe to use for rendering and evaluation.
   * @returns The latest fully converted state, or the first raw state while its conversion is pending.
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
    // Keep the last fully converted state evaluable while this newer fix is converted to MSL.
    this.aircraft ??= state;
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
      void this.refreshAgl(this.aircraft);
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
      if (this.latestFixTimestampMs === state.timestampMs && this.aircraft?.gpsAltitudeM === null) {
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
    await this.refreshAgl(convertedState);
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
