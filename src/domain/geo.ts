/**
 * Provides spherical-geodesy, raster-coordinate, and distance-formatting helpers.
 * Calculations assume WGS84 latitude/longitude degrees and a mean spherical Earth radius.
 */

export const EARTH_RADIUS_M = 6371008.8;

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface RasterBoundsTransform {
  bbox: [number, number, number, number];
  width: number;
  height: number;
}

export interface PixelCoordinate {
  x: number;
  y: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/**
 * Normalizes an angle to the half-open range from 0 (inclusive) to 360 (exclusive).
 * @param degrees - Angle in degrees.
 * @returns The normalized angle in degrees.
 */
export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Calculates great-circle distance between two WGS84 positions using the haversine formula.
 * @param from - Starting position.
 * @param to - Destination position.
 * @returns Distance in meters.
 */
export function distanceMeters(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  // The haversine form avoids the precision loss of spherical cosine distance at short ranges.
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculates the initial true bearing from one WGS84 position to another.
 * @param from - Starting position.
 * @param to - Destination position.
 * @returns Bearing in normalized degrees.
 */
export function initialBearingDegrees(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return normalizeDegrees(toDegrees(Math.atan2(y, x)));
}

/**
 * Expresses a target bearing clockwise relative to a reference bearing.
 * @param referenceDegrees - Reference bearing in degrees.
 * @param targetDegrees - Target bearing in degrees.
 * @returns Relative bearing in normalized degrees.
 */
export function relativeBearingDegrees(referenceDegrees: number, targetDegrees: number): number {
  return normalizeDegrees(targetDegrees - referenceDegrees);
}

/**
 * Projects a WGS84 position along a great-circle bearing and distance.
 * @param from - Starting position.
 * @param bearingDegrees - True bearing in degrees.
 * @param distanceM - Travel distance in meters.
 * @returns The projected WGS84 position.
 */
export function destinationPoint(
  from: LatLon,
  bearingDegrees: number,
  distanceM: number
): LatLon {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);

  // Solve the direct great-circle problem on the same spherical model used for distances.
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: toDegrees(lat2),
    longitude: normalizeLongitude(toDegrees(lon2))
  };
}

/**
 * Normalizes longitude to the half-open range from -180 (inclusive) to 180 (exclusive).
 * @param longitude - Longitude in degrees.
 * @returns The normalized longitude in degrees.
 */
export function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * Maps a WGS84 coordinate to a north-up raster pixel.
 * @param latitude - Latitude in degrees.
 * @param longitude - Longitude in degrees.
 * @param transform - Raster bounds and dimensions.
 * @returns A clamped pixel coordinate, or `null` when the coordinate or transform is invalid.
 */
export function coordinateToPixel(
  latitude: number,
  longitude: number,
  transform: RasterBoundsTransform
): PixelCoordinate | null {
  const [minLon, minLat, maxLon, maxLat] = transform.bbox;
  if (
    longitude < minLon ||
    longitude > maxLon ||
    latitude < minLat ||
    latitude > maxLat ||
    transform.width <= 0 ||
    transform.height <= 0
  ) {
    return null;
  }

  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  if (lonSpan <= 0 || latSpan <= 0) {
    return null;
  }

  const rawX = Math.floor(((longitude - minLon) / lonSpan) * transform.width);
  // Raster rows increase southward, so Y is measured down from the northern bound.
  const rawY = Math.floor(((maxLat - latitude) / latSpan) * transform.height);

  return {
    x: Math.min(Math.max(rawX, 0), transform.width - 1),
    y: Math.min(Math.max(rawY, 0), transform.height - 1)
  };
}

/**
 * Formats a distance with one decimal place for status text.
 * @param distanceKm - Distance in kilometers.
 * @returns The numeric distance text without a unit.
 */
export function formatKilometers(distanceKm: number): string {
  return distanceKm.toFixed(1);
}

const DISPLAY_RANGE_BUCKETS_KM = [
  0.1,
  0.2,
  0.3,
  0.4,
  0.5,
  0.6,
  0.7,
  0.8,
  0.9,
  1,
  1.5,
  2
] as const;
const RANGE_BUCKET_TIE_EPSILON = 1e-12;

/**
 * Formats a distance using the threat-warning display buckets.
 * @param distanceKm - Distance in kilometers.
 * @returns A rounded distance with meters or kilometers as appropriate.
 */
export function formatThreatRange(distanceKm: number): string {
  const bucketKm = displayRangeBucketKm(distanceKm);
  if (bucketKm < 1) {
    return `${Math.round(bucketKm * 1000)} m`;
  }
  return `${Number.isInteger(bucketKm) ? bucketKm.toFixed(0) : bucketKm.toFixed(1)} km`;
}

/**
 * Selects the nearest threat-warning display bucket, rounding exact ties upward.
 * @param distanceKm - Distance in kilometers; non-finite and negative values are treated as zero.
 * @returns The selected display bucket in kilometers.
 */
export function displayRangeBucketKm(distanceKm: number): number {
  const normalizedDistanceKm = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : 0;
  const kilometerFloor = Math.floor(normalizedDistanceKm);
  const kilometerCeil = Math.ceil(normalizedDistanceKm);
  const candidates = new Set<number>(DISPLAY_RANGE_BUCKETS_KM);

  if (kilometerFloor >= 3) {
    candidates.add(kilometerFloor);
  }
  if (kilometerCeil >= 3) {
    candidates.add(kilometerCeil);
  }

  let closestBucketKm: number = DISPLAY_RANGE_BUCKETS_KM[0];
  for (const candidate of candidates) {
    const currentDelta = Math.abs(normalizedDistanceKm - closestBucketKm);
    const candidateDelta = Math.abs(normalizedDistanceKm - candidate);
    // Exact midpoints round outward so warnings do not understate distance at a bucket boundary.
    if (
      candidateDelta < currentDelta - RANGE_BUCKET_TIE_EPSILON ||
      (Math.abs(candidateDelta - currentDelta) <= RANGE_BUCKET_TIE_EPSILON &&
        candidate > closestBucketKm)
    ) {
      closestBucketKm = candidate;
    }
  }

  return closestBucketKm;
}
