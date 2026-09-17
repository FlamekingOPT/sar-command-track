import { describe, it, expect } from 'vitest';
import { parseGeocodeResponse } from '../../src/map/geocode.js';

describe('parseGeocodeResponse', () => {
  it('extracts lat/lng and place name from the first feature', () => {
    const json = {
      features: [
        { center: [-118.4695, 34.0195], place_name: '1234 Main St, Los Angeles, CA' },
        { center: [-73.9857, 40.7484], place_name: 'A different, further-down result' },
      ],
    };
    expect(parseGeocodeResponse(json, '1234 Main St')).toEqual({
      address: '1234 Main St',
      lat: 34.0195,
      lng: -118.4695,
      placeName: '1234 Main St, Los Angeles, CA',
    });
  });

  it('throws when no feature is found', () => {
    expect(() => parseGeocodeResponse({ features: [] }, 'nowhere')).toThrow(/nowhere/);
    expect(() => parseGeocodeResponse({}, 'nowhere')).toThrow(/nowhere/);
  });
});
