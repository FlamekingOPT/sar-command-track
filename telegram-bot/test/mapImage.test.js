import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@turf/turf', async () => {
  const actual = await vi.importActual('@turf/turf');
  return { ...actual, simplify: vi.fn(f => f) };
});

import * as turf from '@turf/turf';
import { buildZoneMapUrl } from '../src/mapImage.js';

process.env.MAPBOX_TOKEN = 'TEST_TOKEN';

function triangle(cx, cy) {
  return { type: 'Polygon', coordinates: [[[cx, cy], [cx + 0.01, cy], [cx, cy + 0.01], [cx, cy]]] };
}

// A polygon with thousands of close-together vertices — guaranteed to blow
// the ~8192-char Mapbox URL cap however it's built, regardless of exact
// real-world turf.simplify behavior (which we mock below for determinism).
function hugeCircle() {
  return {
    type: 'Polygon',
    coordinates: [Array.from({ length: 2000 }, (_, i) => {
      const angle = (i / 2000) * 2 * Math.PI;
      return [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
    })],
  };
}

const SEARCH_SMALL = {
  letterZones: [
    { letter: 'A', geometry: triangle(-118.25, 34.05) },
    { letter: 'B', geometry: triangle(-118.20, 34.05) },
  ],
};

beforeEach(() => { turf.simplify.mockClear(); });

describe('buildZoneMapUrl', () => {
  it('includes a labeled pin per letter zone', () => {
    const url = buildZoneMapUrl(SEARCH_SMALL);
    expect(url).toContain('pin-l-a+3b82f6');
    expect(url).toContain('pin-l-b+3b82f6');
  });

  it('includes the access token and boundary overlay for small geometry, without simplifying', () => {
    const url = buildZoneMapUrl(SEARCH_SMALL);
    expect(url).toContain('access_token=TEST_TOKEN');
    expect(url).toContain('geojson(');
    expect(turf.simplify).not.toHaveBeenCalled();
  });

  it('parses letterZones geometry stored as a JSON string', () => {
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: JSON.stringify(triangle(-118.25, 34.05)) }] });
    expect(url).toContain('pin-l-a+3b82f6');
  });

  it('falls back to simplified geometry when the raw URL is too long, keeping the overlay', () => {
    turf.simplify.mockImplementation(() => ({ geometry: triangle(-118.25, 34.05) }));
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: hugeCircle() }] });
    expect(turf.simplify).toHaveBeenCalledTimes(1);
    expect(url).toContain('geojson(');
    expect(url.length).toBeLessThanOrEqual(7000);
  });

  it('drops the overlay to pins-only when even simplified geometry is still too long', () => {
    turf.simplify.mockImplementation(f => f); // no-op: "simplification" doesn't help here
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: hugeCircle() }] });
    expect(url).not.toContain('geojson(');
    expect(url).toContain('pin-l-a+3b82f6');
    expect(url).toContain('access_token=TEST_TOKEN');
  });
});
