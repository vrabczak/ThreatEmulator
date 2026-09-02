/**
 * Publishes current GNSS aircraft data and derives an evaluation snapshot from every third fix.
 * EGM96 conversion and terrain requests may finish out of order, so the latest selected snapshot always wins.
 */

import { calculateAgl, resolveTerrainElevationM } from '../domain/altitude';
import { Egm96GeoidModel } from '../domain/geoid';
import type { AircraftState, TerrainMetadata, TerrainSample, TerrainService } from '../domain/types';

export interface AircraftAltitudeControllerOptions {
  terrainService: TerrainService;
  onStateChanged: () => void;
}

/**
 * Owns the latest display state and the less-frequent snapshot used by threat evaluation.
 * Raw position data is published immediately, while MSL altitude and AGL are refreshed from every third fix.
 */
export class AircraftAltitudeController {
  private readonly geoidModel = new Egm96GeoidModel();
  private aircraft: AircraftState | null = null;
  private evaluationAircraft: AircraftState | null = null;
  private terrainMetadata: TerrainMetadata | null = null;
  private latestFixTimestampMs: number | null = null;
  private selectedFixTimestampMs: number | null = null;
  private fixCount = 0;
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
   * Gets the last fully processed third GNSS fix used as an immutable threat-evaluation snapshot.
   * @returns The selected aircraft state with converted altitude and current AGL, or `null` before it is ready.
   */
  public get evaluationAircraftState(): AircraftState | null {
    return this.evaluationAircraft;
  }

  /**
   * Gets the current terrain sampling or altitude-conversion warning.
   * @returns A user-facing reason, or `null` when altitude processing is current.
   */
  public get terrainReason(): string | null {
    return this.lastTerrainReason;
  }

  /**
   * Accepts a raw browser GNSS fix and processes altitude and AGL for every third fix.
   * @param state - Normalized aircraft state containing ellipsoid altitude.
   * @returns Nothing.
   */
  public acceptFix(state: AircraftState): void {
    this.latestFixTimestampMs = state.timestampMs;
    this.fixCount += 1;
    // Position, accuracy, and track refresh on every browser fix. Derived values remain stable until
    // the next selected fix finishes, preventing the UI and evaluator from alternating through nulls.
    this.aircraft = {
      ...state,
      gpsAltitudeM: this.aircraft?.gpsAltitudeM ?? null,
      aglM: this.aircraft?.aglM ?? null
    };
    this.options.onStateChanged();

    if (this.fixCount % 3 !== 0) {
      return;
    }

    this.selectedFixTimestampMs = state.timestampMs;
    if (state.gpsEllipsoidAltitudeM === null) {
      this.evaluationAircraft = state;
      this.aircraft = { ...this.aircraft, gpsAltitudeM: null, aglM: null };
      this.lastTerrainReason = 'Aircraft GPS altitude is unavailable.';
      this.options.onStateChanged();
      return;
    }
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
    this.evaluationAircraft = null;
    this.queuedAglState = null;
    if (this.aircraft) {
      this.aircraft = { ...this.aircraft, aglM: null };
    }
    this.options.onStateChanged();
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
      if (this.selectedFixTimestampMs === state.timestampMs) {
        this.lastTerrainReason =
          error instanceof Error ? error.message : 'Unable to convert GPS altitude to MSL.';
        this.options.onStateChanged();
      }
      return;
    }

    // Non-selected fixes may arrive while conversion runs; only a newer third fix supersedes this snapshot.
    if (this.selectedFixTimestampMs !== state.timestampMs) {
      return;
    }

    const convertedState: AircraftState = {
      ...state,
      gpsAltitudeM: gpsAltitudeMslM,
      aglM: calculateAgl(gpsAltitudeMslM, this.lastTerrainElevationM)
    };
    this.aircraft = {
      ...(this.aircraft ?? state),
      gpsAltitudeM: convertedState.gpsAltitudeM,
      aglM: convertedState.aglM
    };
    this.lastTerrainReason =
      this.lastTerrainElevationM === null
        ? null
        : 'Using last retrieved terrain elevation while the current lookup completes.';
    this.options.onStateChanged();
    if (this.terrainMetadata) {
      this.scheduleAglRefresh(convertedState);
    } else {
      this.evaluationAircraft = convertedState;
    }
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
      if (queuedState && queuedState.timestampMs === this.selectedFixTimestampMs) {
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
    // Intermediate display fixes do not supersede a selected snapshot; only the next third fix does.
    if (this.selectedFixTimestampMs !== state.timestampMs) {
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

    this.evaluationAircraft = {
      ...state,
      aglM: calculateAgl(state.gpsAltitudeM, terrainElevationM)
    };
    this.aircraft = {
      ...(this.aircraft ?? state),
      gpsAltitudeM: this.evaluationAircraft.gpsAltitudeM,
      aglM: this.evaluationAircraft.aglM
    };
    this.options.onStateChanged();
  }
}
