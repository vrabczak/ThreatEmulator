/**
 * Defines shared threat, aircraft, terrain, line-of-sight, and evaluation contracts.
 * These serializable shapes cross the main-thread/worker boundary and use metric SI units.
 */

export const MAX_CSV_FILE_SIZE_BYTES = 1024 * 1024;

export const REQUIRED_THREAT_COLUMNS = [
  'id',
  'latitude',
  'longitude',
  'range_km'
] as const;

export type RequiredThreatColumn = (typeof REQUIRED_THREAT_COLUMNS)[number];

export interface Threat {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Null makes this a magic threat whose line of sight is always clear. */
  heightAglM: number | null;
  rangeKm: number;
}

export interface InvalidThreatRow {
  rowNumber: number;
  raw: Record<string, string>;
  errors: string[];
}

export interface ThreatCsvResult {
  fileName: string;
  fileSize: number;
  threats: Threat[];
  invalidRows: InvalidThreatRow[];
  errors: string[];
}

export type TrackSource = 'browser' | 'derived' | 'stale' | 'unavailable';

export interface AircraftState {
  latitude: number;
  longitude: number;
  gpsEllipsoidAltitudeM: number | null;
  /** EGM96 orthometric altitude used by AGL and line-of-sight calculations. */
  gpsAltitudeM: number | null;
  gpsAltitudeAccuracyM: number | null;
  gpsAccuracyM: number | null;
  aglM: number | null;
  trackDegrees: number | null;
  trackSource: TrackSource;
  trackAgeMs: number | null;
  timestampMs: number;
}

export interface TerrainMetadata {
  fileName: string;
  fileSize: number;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  resolutionDeg: {
    longitude: number;
    latitude: number;
  };
  samplesPerPixel: number;
  tileWidth: number;
  tileHeight: number;
  noDataValue: number | null;
  isWgs84: boolean;
  warnings: string[];
}

export type TerrainSample =
  | {
      status: 'ok';
      elevationM: number;
    }
  | {
      status: 'terrain-unavailable';
      reason: string;
    };

export interface LineOfSightBlockedAt {
  latitude: number;
  longitude: number;
  terrainElevationM: number;
  sightLineElevationM: number;
  distanceFromThreatM: number;
}

export type LineOfSightResult =
  | {
      status: 'clear';
      sampleCount: number;
    }
  | {
      status: 'blocked';
      sampleCount: number;
      blockedAt: LineOfSightBlockedAt;
    }
  | {
      status: 'terrain-unavailable';
      sampleCount: number;
      reason: string;
    };

export interface LineOfSightBatchResult {
  threatId: string;
  result: LineOfSightResult;
}

export type ThreatState =
  | 'inactive'
  | 'active'
  | 'terrain unavailable'
  | 'aircraft state unavailable'
  | 'invalid';

export interface ThreatEvaluationResult {
  threat: Threat;
  state: ThreatState;
  distanceKm: number | null;
  reason: string;
  lineOfSight?: LineOfSightResult;
}

export interface ThreatEvaluationSummary {
  evaluatedAtMs: number;
  results: ThreatEvaluationResult[];
  active: ThreatEvaluationResult[];
}

export interface TerrainService {
  /**
   * Loads terrain data and makes it active for subsequent requests.
   * @param file - GeoTIFF elevation file.
   * @returns Validated metadata for the loaded terrain.
   * @throws {Error} When the file cannot be decoded or does not meet terrain assumptions.
   */
  loadGeoTiff(file: File): Promise<TerrainMetadata>;

  /**
   * Gets metadata for the currently loaded terrain.
   * @returns Loaded metadata, or `null` when terrain has not been loaded.
   */
  getMetadata(): TerrainMetadata | null;

  /**
   * Samples terrain elevation at a WGS84 position.
   * @param latitude - Latitude in degrees.
   * @param longitude - Longitude in degrees.
   * @returns The elevation sample or a terrain-unavailable reason.
   * @throws {Error} When the terrain provider rejects or cancels the request.
   */
  sampleElevation(latitude: number, longitude: number): Promise<TerrainSample>;

  /**
   * Evaluates terrain line of sight for one threat.
   * @param aircraft - Current aircraft state.
   * @param threat - Threat to evaluate.
   * @param options - Optional sampling controls.
   * @returns The line-of-sight result.
   * @throws {Error} When the terrain provider rejects or cancels the request.
   */
  evaluateLineOfSight(
    aircraft: AircraftState,
    threat: Threat,
    options?: LineOfSightOptions
  ): Promise<LineOfSightResult>;

  /**
   * Evaluates terrain line of sight for multiple threats in one request.
   * @param aircraft - Current aircraft state.
   * @param threats - Threats to evaluate.
   * @param options - Optional sampling controls.
   * @returns Results associated with their threat IDs.
   * @throws {Error} When the terrain provider rejects or cancels the request.
   */
  evaluateLineOfSightBatch(
    aircraft: AircraftState,
    threats: Threat[],
    options?: LineOfSightOptions
  ): Promise<LineOfSightBatchResult[]>;

  /** Cancels all unresolved terrain requests. */
  cancelPending(): void;

  /** Releases worker resources and rejects unresolved terrain requests. */
  dispose(): void;
}

export interface LineOfSightOptions {
  maxSampleSpacingM?: number;
}
