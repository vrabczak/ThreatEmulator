import { buildThreatFromEditor, type ThreatEditorInput } from './threat-editor';
import { distanceMeters } from './geo';

const coordinateInput: ThreatEditorInput = {
  id: 'T100',
  name: 'Manual threat',
  heightAglM: '12',
  rangeKm: '4.5',
  positionMode: 'coordinates',
  latitude: '50,1',
  longitude: '14.2',
  mgrs: '',
  bearingDegrees: '',
  distanceKm: ''
};

describe('buildThreatFromEditor', () => {
  it('builds a threat from WGS84 coordinates', () => {
    const result = buildThreatFromEditor(coordinateInput, null);

    expect(result).toEqual({
      threat: {
        id: 'T100',
        name: 'Manual threat',
        latitude: 50.1,
        longitude: 14.2,
        heightAglM: 12,
        rangeKm: 4.5
      },
      errors: []
    });
  });

  it('places a threat by true bearing and distance from the aircraft', () => {
    const result = buildThreatFromEditor(
      {
        ...coordinateInput,
        positionMode: 'relative',
        bearingDegrees: '90',
        distanceKm: '10'
      },
      { latitude: 50, longitude: 14 }
    );

    expect('threat' in result).toBe(true);
    if ('threat' in result) {
      expect(result.threat.latitude).toBeCloseTo(50, 3);
      expect(result.threat.longitude).toBeGreaterThan(14.13);
      expect(result.threat.longitude).toBeLessThan(14.15);
    }
  });

  it('converts an MGRS coordinate to fixed WGS84 coordinates', () => {
    const result = buildThreatFromEditor(
      { ...coordinateInput, positionMode: 'mgrs', mgrs: '33U VR 59772 47176' },
      null
    );

    expect('threat' in result).toBe(true);
    if ('threat' in result) {
      expect(result.threat.latitude).toBeCloseTo(50.0755, 4);
      expect(result.threat.longitude).toBeCloseTo(14.4378, 4);
    }
  });

  it.each([
    ['33UVR', 100_000],
    ['33U VR 5 4', 10_000],
    ['33UVR5947', 1_000],
    ['33U VR 597 471', 100],
    ['33UVR59774717', 10],
    ['33U VR 59772 47176', 1]
  ])('accepts variable MGRS precision: %s', (mgrs, gridSizeM) => {
    const result = buildThreatFromEditor(
      { ...coordinateInput, positionMode: 'mgrs', mgrs },
      null
    );

    expect('threat' in result).toBe(true);
    if ('threat' in result) {
      expect(
        distanceMeters(
          { latitude: result.threat.latitude, longitude: result.threat.longitude },
          { latitude: 50.0755, longitude: 14.4378 }
        )
      ).toBeLessThan(gridSizeM);
    }
  });

  it.each([
    '33UVR5977247176',
    '33u vr 59772 47176',
    '  33U   VR   59772   47176  ',
    '33U\tVR\t59772\t47176'
  ])('accepts MGRS regardless of case and whitespace: %j', (mgrs) => {
    const result = buildThreatFromEditor(
      { ...coordinateInput, positionMode: 'mgrs', mgrs },
      null
    );

    expect(result).toMatchObject({
      threat: {
        latitude: expect.closeTo(50.0755, 4),
        longitude: expect.closeTo(14.4378, 4)
      },
      errors: []
    });
  });

  it('rejects a missing or malformed MGRS coordinate', () => {
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs: '' }, null).errors
    ).toContain('MGRS coordinate is required.');
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs: ' \t ' }, null)
        .errors
    ).toContain('MGRS coordinate is required.');
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs: 'NOT-MGRS' }, null).errors
    ).toContain('MGRS coordinate is invalid.');
  });

  it.each([
    ['33UVR5977247176junk', 'non-numeric suffix'],
    ['33UVR597724717612', 'more than five digits per coordinate'],
    ['33UVR1234567', 'uneven easting and northing precision'],
    ['00UVR5977247176', 'zone zero'],
    ['61UVR5977247176', 'zone above 60'],
    ['33IVR5977247176', 'forbidden latitude band']
  ])('rejects invalid MGRS input with a %s (%s)', (mgrs) => {
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs }, null).errors
    ).toContain('MGRS coordinate is invalid.');
  });

  it('creates a magic threat when height AGL is blank', () => {
    const result = buildThreatFromEditor({ ...coordinateInput, heightAglM: '  ' }, null);

    expect(result).toMatchObject({
      threat: { heightAglM: null },
      errors: []
    });
  });

  it('accepts a blank description', () => {
    const result = buildThreatFromEditor({ ...coordinateInput, name: '  ' }, null);

    expect(result).toMatchObject({
      threat: { id: 'T100', name: '' },
      errors: []
    });
  });

  it('requires an aircraft position for relative placement', () => {
    const result = buildThreatFromEditor(
      { ...coordinateInput, positionMode: 'relative', bearingDegrees: '45', distanceKm: '2' },
      null
    );

    expect(result.errors).toContain('An aircraft GNSS position is required for relative placement.');
  });

  it('validates fields and rejects duplicate IDs', () => {
    const result = buildThreatFromEditor(
      { ...coordinateInput, latitude: '91', heightAglM: '-1' },
      null,
      ['T100']
    );

    expect(result.errors).toEqual([
      'ID "T100" is already in use.',
      'Height AGL must be a number greater than or equal to 0.',
      'Latitude must be between -90 and 90.'
    ]);
  });
});
