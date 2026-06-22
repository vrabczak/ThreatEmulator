import { parseDecimal, parseThreatCsvText } from './csv';

describe('parseThreatCsvText', () => {
  it('parses semicolon CSV with dot and comma decimals', () => {
    const result = parseThreatCsvText(`id;name;latitude;longitude;height_agl_m;range_km
T001;Alpha;50.1;14.2;12;25
T002;Bravo;50,2;14,3;0;12,5`);

    expect(result.errors).toEqual([]);
    expect(result.invalidRows).toEqual([]);
    expect(result.threats).toHaveLength(2);
    expect(result.threats[1]).toMatchObject({
      latitude: 50.2,
      longitude: 14.3,
      rangeKm: 12.5
    });
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
T002;Bad;91;14.3;-1;0`);

    expect(result.threats).toHaveLength(1);
    expect(result.invalidRows).toHaveLength(1);
    expect(result.invalidRows[0].errors).toEqual([
      'latitude must be a decimal number between -90 and 90.',
      'height_agl_m must be greater than or equal to 0.',
      'range_km must be greater than 0.'
    ]);
  });
});

describe('parseDecimal', () => {
  it('accepts dot and comma decimal separators', () => {
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal('12,5')).toBe(12.5);
  });
});
