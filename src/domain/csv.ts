import Papa from 'papaparse';
import {
  MAX_CSV_FILE_SIZE_BYTES,
  REQUIRED_THREAT_COLUMNS,
  type InvalidThreatRow,
  type Threat,
  type ThreatCsvResult
} from './types';

type CsvRow = Record<string, string>;

export async function parseThreatCsvFile(file: File): Promise<ThreatCsvResult> {
  if (file.size > MAX_CSV_FILE_SIZE_BYTES) {
    return {
      fileName: file.name,
      fileSize: file.size,
      threats: [],
      invalidRows: [],
      errors: [`CSV file is ${(file.size / 1024 / 1024).toFixed(1)} MB; maximum supported size is 1 MB.`]
    };
  }

  return parseThreatCsvText(await file.text(), file.name, file.size);
}

export function parseThreatCsvText(
  text: string,
  fileName = 'inline.csv',
  fileSize = new Blob([text]).size
): ThreatCsvResult {
  const errors: string[] = [];
  const invalidRows: InvalidThreatRow[] = [];
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';

  if (!firstLine.includes(';')) {
    errors.push('CSV must use a semicolon delimiter.');
  }

  const parsed = Papa.parse<CsvRow>(text, {
    delimiter: ';',
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim()
  });

  for (const parseError of parsed.errors) {
    errors.push(`CSV parse error on row ${parseError.row ?? 'unknown'}: ${parseError.message}`);
  }

  const presentColumns = new Set(parsed.meta.fields ?? []);
  const missingColumns = REQUIRED_THREAT_COLUMNS.filter((column) => !presentColumns.has(column));
  if (missingColumns.length > 0) {
    errors.push(`Missing required CSV columns: ${missingColumns.join(', ')}.`);
  }

  if (errors.length > 0 && missingColumns.length > 0) {
    return { fileName, fileSize, threats: [], invalidRows, errors };
  }

  const threats: Threat[] = [];
  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2;
    const validation = validateThreatRow(row);
    if (!('threat' in validation)) {
      invalidRows.push({
        rowNumber,
        raw: row,
        errors: validation.errors
      });
      return;
    }

    threats.push(validation.threat);
  });

  return { fileName, fileSize, threats, invalidRows, errors };
}

function validateThreatRow(row: CsvRow): { threat: Threat; errors: [] } | { errors: string[] } {
  const errors: string[] = [];
  const id = normalizeText(row.id);
  const name = normalizeText(row.name);
  const latitude = parseDecimal(row.latitude);
  const longitude = parseDecimal(row.longitude);
  const heightAglM = parseDecimal(row.height_agl_m);
  const rangeKm = parseDecimal(row.range_km);

  if (!id) {
    errors.push('id is required.');
  }
  if (!name) {
    errors.push('name is required.');
  }
  if (latitude === null || latitude < -90 || latitude > 90) {
    errors.push('latitude must be a decimal number between -90 and 90.');
  }
  if (longitude === null || longitude < -180 || longitude > 180) {
    errors.push('longitude must be a decimal number between -180 and 180.');
  }
  if (heightAglM === null || heightAglM < 0) {
    errors.push('height_agl_m must be greater than or equal to 0.');
  }
  if (rangeKm === null || rangeKm <= 0) {
    errors.push('range_km must be greater than 0.');
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    threat: {
      id,
      name,
      latitude: latitude as number,
      longitude: longitude as number,
      heightAglM: heightAglM as number,
      rangeKm: rangeKm as number
    },
    errors: []
  };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseDecimal(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
