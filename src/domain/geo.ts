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

export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function distanceMeters(from: LatLon, to: LatLon): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

export function relativeBearingDegrees(referenceDegrees: number, targetDegrees: number): number {
  return normalizeDegrees(targetDegrees - referenceDegrees);
}

export function destinationPoint(
  from: LatLon,
  bearingDegrees: number,
  distanceM: number
): LatLon {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);

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

export function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

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
  const rawY = Math.floor(((maxLat - latitude) / latSpan) * transform.height);

  return {
    x: Math.min(Math.max(rawX, 0), transform.width - 1),
    y: Math.min(Math.max(rawY, 0), transform.height - 1)
  };
}

export function formatKilometers(distanceKm: number): string {
  return distanceKm.toFixed(1);
}
