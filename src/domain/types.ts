export const MAX_CSV_FILE_SIZE_BYTES = 1024 * 1024;

export const REQUIRED_THREAT_COLUMNS = [
  'id',
  'name',
  'latitude',
  'longitude',
  'height_agl_m',
  'range_km'
] as const;

export type RequiredThreatColumn = (typeof REQUIRED_THREAT_COLUMNS)[number];

export interface Threat {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  heightAglM: number;
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
  primary: ThreatEvaluationResult | null;
}

export interface TerrainService {
  loadGeoTiff(file: File): Promise<TerrainMetadata>;
  getMetadata(): TerrainMetadata | null;
  sampleElevation(latitude: number, longitude: number): Promise<TerrainSample>;
  evaluateLineOfSight(
    aircraft: AircraftState,
    threat: Threat,
    options?: LineOfSightOptions
  ): Promise<LineOfSightResult>;
  evaluateLineOfSightBatch(
    aircraft: AircraftState,
    threats: Threat[],
    options?: LineOfSightOptions
  ): Promise<LineOfSightBatchResult[]>;
  cancelPending(): void;
  dispose(): void;
}

export interface LineOfSightOptions {
  maxSampleSpacingM?: number;
}
