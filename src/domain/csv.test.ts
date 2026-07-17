import { parseDecimal, parseThreatCsvText, serializeThreatCsv } from './csv';
import type { Threat } from './types';

describe('parseThreatCsvText', () => {
  it('parses semicolon CSV with dot and comma decimals', () => {
    const result = parseThreatCsvText(`id;name;latitude;longitude;height_agl_m;range_km
T001;Alpha;50.1;14.2;12;25
T002;Bravo;50,2;14,3;0;12,5
T003;Charlie;50.3;14.4;0;0`);

    expect(result.errors).toEqual([]);
    expect(result.invalidRows).toEqual([]);
    expect(result.threats).toHaveLength(3);
    expect(result.threats[1]).toMatchObject({
      latitude: 50.2,
      longitude: 14.3,
      rangeKm: 12.5
    });
    expect(result.threats[2].rangeKm).toBe(0);
  });

  it('reports wrong delimiter and missing columns', () => {
    const result = parseThreatCsvText(`id,name,latitude,longitude,height_agl_m,range_km
T001,Alpha,50.1,14.2,12,25`);

    expect(result.errors).toContain('CSV must use a semicolon delimiter.');
    expect(result.errors.some((error) => error.includes('Missing required CSV columns'))).toBe(true);
  });

  it('keeps invalid rows separate from valid threats', () => {
    const result = parseThreatCsvText(`id;name;latitude;longitude;height_agl_m;range_km
T001;Alpha;50.1;14.2;12;25
T002;Bad;91;14.3;-1;-0.1`);

    expect(result.threats).toHaveLength(1);
    expect(result.invalidRows).toHaveLength(1);
    expect(result.invalidRows[0].errors).toEqual([
      'latitude must be a decimal number between -90 and 90.',
      'height_agl_m must be greater than or equal to 0.',
      'range_km must be greater than or equal to 0.'
    ]);
  });

  it('creates magic threats when height AGL is blank or the column is absent', () => {
    const blankHeight = parseThreatCsvText(`id;name;latitude;longitude;height_agl_m;range_km
T001;Magic;50.1;14.2;;25`);
    const absentColumn = parseThreatCsvText(`id;name;latitude;longitude;range_km
T002;Also magic;50.2;14.3;10`);

    expect(blankHeight.errors).toEqual([]);
    expect(blankHeight.invalidRows).toEqual([]);
    expect(blankHeight.threats[0].heightAglM).toBeNull();
    expect(absentColumn.errors).toEqual([]);
    expect(absentColumn.invalidRows).toEqual([]);
    expect(absentColumn.threats[0].heightAglM).toBeNull();
  });

  it('accepts a blank description or a CSV without the name column', () => {
    const blankName = parseThreatCsvText(`id;name;latitude;longitude;range_km
T001;;50.1;14.2;25`);
    const absentColumn = parseThreatCsvText(`id;latitude;longitude;range_km
T002;50.2;14.3;10`);

    expect(blankName.errors).toEqual([]);
    expect(blankName.invalidRows).toEqual([]);
    expect(blankName.threats[0].name).toBe('');
    expect(absentColumn.errors).toEqual([]);
    expect(absentColumn.invalidRows).toEqual([]);
    expect(absentColumn.threats[0].name).toBe('');
  });
});

describe('parseDecimal', () => {
  it('accepts dot and comma decimal separators', () => {
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal('12,5')).toBe(12.5);
  });
});

describe('serializeThreatCsv', () => {
  it('exports the current threats in the decimal-degree CSV schema', () => {
    const threats: Threat[] = [
      {
        id: 'T001',
        name: 'Alpha; "mobile"',
        latitude: 50.0755,
        longitude: 14.4378,
        heightAglM: 12,
        rangeKm: 25
      },
      {
        id: 'T002',
        name: '',
        latitude: 50.1,
        longitude: 14.2,
        heightAglM: null,
        rangeKm: 5
      }
    ];

    const csv = serializeThreatCsv(threats);

    expect(csv).toContain('id;name;latitude;longitude;height_agl_m;range_km');
    expect(csv).toContain('T001;"Alpha; ""mobile""";50.0755;14.4378;12;25');
    expect(csv).toContain('T002;;50.1;14.2;;5');
    const parsed = parseThreatCsvText(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.invalidRows).toEqual([]);
    expect(parsed.threats).toEqual(threats);
  });
});
