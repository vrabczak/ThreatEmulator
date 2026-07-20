/**
 * Validates threat-editor input and resolves coordinate, MGRS, or aircraft-relative placement.
 * Parsing depends on shared decimal/geodesy helpers and the third-party MGRS converter.
 */

import { toPoint as mgrsToPoint } from 'mgrs';
import { parseDecimal } from './csv';
import { destinationPoint } from './geo';
import type { LatLon } from './geo';
import type { Threat } from './types';

const MGRS_PATTERN = /^(?:0?[1-9]|[1-5]\d|60)[C-HJ-NP-X][A-HJ-NP-Z][A-HJ-NP-V](?:\d{2}){0,5}$/;

export type ThreatPositionMode = 'coordinates' | 'mgrs' | 'relative';

export interface ThreatEditorInput {
  id: string;
  name: string;
  heightAglM: string;
  rangeKm: string;
  positionMode: ThreatPositionMode;
  latitude: string;
  longitude: string;
  mgrs: string;
  bearingDegrees: string;
  distanceKm: string;
}

export type ThreatEditorResult = { threat: Threat; errors: [] } | { errors: string[] };

/**
 * Validates editor fields and builds a normalized threat definition.
 * @param input - Raw strings and selected position mode from the editor form.
 * @param aircraftPosition - Current aircraft position for relative placement.
 * @param existingIds - Threat IDs that the new or edited threat must not duplicate.
 * @returns A threat with no errors, or all validation errors found in the input.
 */
export function buildThreatFromEditor(
  input: ThreatEditorInput,
  aircraftPosition: LatLon | null,
  existingIds: Iterable<string> = []
): ThreatEditorResult {
  const errors: string[] = [];
  const id = input.id.trim();
  const name = input.name.trim();
  const heightAglText = input.heightAglM.trim();
  const heightAglM = heightAglText ? parseDecimal(heightAglText) : null;
  const rangeKm = parseDecimal(input.rangeKm);

  if (!id) {
    errors.push('ID is required.');
  } else if ([...existingIds].some((existingId) => existingId === id)) {
    errors.push(`ID "${id}" is already in use.`);
  }
  if (heightAglText && (heightAglM === null || heightAglM < 0)) {
    errors.push('Height AGL must be a number greater than or equal to 0.');
  }
  if (rangeKm === null || rangeKm < 0) {
    errors.push('Range must be a number greater than or equal to 0.');
  }

  const location = resolveEditorLocation(input, aircraftPosition);
  if ('errors' in location) {
    errors.push(...location.errors);
  }

  if (errors.length > 0 || !('location' in location)) {
    return { errors };
  }

  return {
    threat: {
      id,
      name,
      latitude: location.location.latitude,
      longitude: location.location.longitude,
      heightAglM,
      rangeKm: rangeKm as number
    },
    errors: []
  };
}

function resolveEditorLocation(
  input: ThreatEditorInput,
  aircraftPosition: LatLon | null
): { location: LatLon } | { errors: string[] } {
  if (input.positionMode === 'mgrs') {
    const mgrs = input.mgrs.replace(/\s/g, '').toUpperCase();
    if (!mgrs) {
      return { errors: ['MGRS coordinate is required.'] };
    }

    // The converter partially accepts malformed coordinates, so validate the complete MGRS grammar first.
    if (!MGRS_PATTERN.test(mgrs)) {
      return { errors: ['MGRS coordinate is invalid.'] };
    }

    try {
      const [longitude, latitude] = mgrsToPoint(mgrs);
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return { errors: ['MGRS coordinate is invalid.'] };
      }
      return { location: { latitude, longitude } };
    } catch {
      return { errors: ['MGRS coordinate is invalid.'] };
    }
  }

  if (input.positionMode === 'relative') {
    const bearingDegrees = parseDecimal(input.bearingDegrees);
    const distanceKm = parseDecimal(input.distanceKm);
    const errors: string[] = [];

    if (!aircraftPosition) {
      errors.push('An aircraft GNSS position is required for relative placement.');
    }
    if (bearingDegrees === null || bearingDegrees < 0 || bearingDegrees > 360) {
      errors.push('Bearing must be between 0 and 360 degrees.');
    }
    if (distanceKm === null || distanceKm < 0) {
      errors.push('Distance must be a number greater than or equal to 0.');
    }
    if (errors.length > 0) {
      return { errors };
    }

    return {
      location: destinationPoint(
        aircraftPosition as LatLon,
        bearingDegrees as number,
        (distanceKm as number) * 1000
      )
    };
  }

  const latitude = parseDecimal(input.latitude);
  const longitude = parseDecimal(input.longitude);
  const errors: string[] = [];
  if (latitude === null || latitude < -90 || latitude > 90) {
    errors.push('Latitude must be between -90 and 90.');
  }
  if (longitude === null || longitude < -180 || longitude > 180) {
    errors.push('Longitude must be between -180 and 180.');
  }
  return errors.length > 0
    ? { errors }
    : { location: { latitude: latitude as number, longitude: longitude as number } };
}
