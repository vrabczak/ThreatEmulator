import { buildThreatFromEditor, type ThreatEditorInput } from './threat-editor';

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

  it('rejects a missing or malformed MGRS coordinate', () => {
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs: '' }, null).errors
    ).toContain('MGRS coordinate is required.');
    expect(
      buildThreatFromEditor({ ...coordinateInput, positionMode: 'mgrs', mgrs: 'NOT-MGRS' }, null).errors
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
