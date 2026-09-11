import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as turf from '@turf/turf';
import { fetchStreetGraph, fetchStreets, selectDetail, DETAIL_LEVELS, tileBboxes, cacheTileKeys, filterByDetail, MAX_FETCH_AREA_M2, TILE_SIZE_DEG, STREET_TILE_BASE, classifyTerrainFeatures } from '../../src/zones/overpass.js';

describe('fetchStreetGraph', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  const okResponse = () => ({
    ok: true,
    json: () => Promise.resolve({
      elements: [
        { type: 'way', tags: { highway: 'primary', name: 'Main St' }, geometry: [{ lat: 34.005, lon: -118.295 }, { lat: 34.006, lon: -118.294 }] },
        { type: 'way', tags: { highway: 'residential', name: 'Elm St' }, geometry: [{ lat: 34.003, lon: -118.297 }, { lat: 34.004, lon: -118.296 }] },
        { type: 'way', tags: { waterway: 'river' }, geometry: [{ lat: 34.001, lon: -118.298 }, { lat: 34.002, lon: -118.299 }] },
        { type: 'way', tags: { highway: 'tertiary', name: 'Airdrome St' }, geometry: [{ lat: 34.007, lon: -118.293 }, { lat: 34.008, lon: -118.292 }] },
        { type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: 34.009, lon: -118.291 }, { lat: 34.010, lon: -118.290 }] },
      ],
    }),
  });
  // Overpass's public instance returns an XML error body (not JSON) on a
  // gateway timeout — .json() on this throws a SyntaxError if called blindly,
  // which is what actually happened in production (504 under load).
  const gatewayTimeoutResponse = () => ({
    ok: false,
    status: 504,
    json: () => Promise.reject(new SyntaxError("Unexpected token '<', \"<?xml vers\"... is not valid JSON")),
  });

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(okResponse());
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('classifies motorway/trunk/primary and waterways as hard, everything else fetched as soft', async () => {
    const { hardLines, softLines } = await fetchStreetGraph(boundary);
    expect(hardLines).toHaveLength(2); // primary + river
    expect(softLines).toHaveLength(2); // residential + tertiary (footway classified to terrainPaths instead)
  });

  it('queries Overpass with a padded bbox and both barrier tiers', async () => {
    await fetchStreetGraph(boundary);
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain('motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified');
    expect(options.body).toContain('river|canal|stream');
  });

  it('falls back to the second Overpass endpoint when the first returns a non-ok status', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(gatewayTimeoutResponse())
      .mockResolvedValueOnce(okResponse());

    const { hardLines, softLines } = await fetchStreetGraph(boundary);
    expect(hardLines).toHaveLength(2);
    expect(softLines).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when every Overpass endpoint fails', async () => {
    global.fetch = vi.fn().mockResolvedValue(gatewayTimeoutResponse());
    await expect(fetchStreetGraph(boundary)).rejects.toThrow();
  });

  it('aborts a hung request instead of waiting forever, and fails over to the next endpoint', async () => {
    // Regression for a real bug: an oversized boundary's Overpass request can
    // just hang (no response, no error) rather than cleanly failing, and the
    // original code had no client-side timeout — the UI sat on "Fetching
    // street network…" forever with no way out but a page refresh.
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn()
        .mockImplementationOnce((url, { signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }))
        .mockResolvedValueOnce(okResponse());

      const resultPromise = fetchStreetGraph(boundary);
      await vi.advanceTimersByTimeAsync(20000);
      const { hardLines, softLines } = await resultPromise;

      expect(hardLines).toHaveLength(2);
      expect(softLines).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('selectDetail', () => {
  it('full detail for neighborhood-scale zones (avg < 0.1 km²)', () => {
    expect(selectDetail(500_000, 10)).toBe('full'); // 0.05 km² avg
  });
  it('district detail for 0.1–1 km² zones', () => {
    expect(selectDetail(5_000_000, 10)).toBe('district'); // 0.5 km² avg
  });
  it('city detail for zones over 1 km² (Jeanne Missing scale)', () => {
    expect(selectDetail(300_000_000, 150)).toBe('city'); // 2 km² avg
  });
  it('guards against a zero zone count', () => {
    expect(selectDetail(300_000_000, 0)).toBe('city');
  });
});

describe('fetchStreetGraph level of detail', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ elements: [] }) });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('defaults to the full residential-level query', async () => {
    await fetchStreetGraph(boundary);
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain(DETAIL_LEVELS.full);
  });

  it('drops residential roads at district detail', async () => {
    await fetchStreetGraph(boundary, { detail: 'district' });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain('motorway|trunk|primary|secondary|tertiary');
    expect(options.body).not.toContain('residential');
  });

  it('fetches only major roads at city detail, keeping waterways', async () => {
    await fetchStreetGraph(boundary, { detail: 'city' });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain('motorway|trunk|primary|secondary');
    expect(options.body).not.toContain('tertiary');
    expect(options.body).toContain('river|canal|stream');
  });
});

describe('buildQuery terrain-feature and path tags', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ elements: [] }) });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('always requests golf/park/cemetery/wood polygons and path/footway ways, regardless of detail', async () => {
    await fetchStreetGraph(boundary, { detail: 'city' });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain('leisure"~"golf_course|park');
    expect(options.body).toContain('landuse"~"cemetery');
    expect(options.body).toContain('natural"~"wood');
    expect(options.body).toContain('highway"~"path|footway');
  });
});

describe('classifyWays road class tagging and terrain filtering', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        elements: [
          { type: 'way', tags: { highway: 'primary', name: 'Main St' }, geometry: [{ lat: 34.005, lon: -118.295 }, { lat: 34.006, lon: -118.294 }] },
          { type: 'way', tags: { highway: 'residential', name: 'Elm St' }, geometry: [{ lat: 34.003, lon: -118.297 }, { lat: 34.004, lon: -118.296 }] },
          { type: 'way', tags: { waterway: 'river' }, geometry: [{ lat: 34.001, lon: -118.298 }, { lat: 34.002, lon: -118.299 }] },
          { type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: 34.009, lon: -118.291 }, { lat: 34.010, lon: -118.290 }] },
        ],
      }),
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('tags each classified line with its road class (or "waterway")', async () => {
    const { hardLines, softLines } = await fetchStreetGraph(boundary);
    const primary = hardLines.find(l => l.properties.name === 'Main St');
    expect(primary.properties.highway).toBe('primary');
    const river = hardLines.find(l => l.properties.name === undefined || l.properties.name === '');
    expect(river.properties.highway).toBe('waterway');
    const residential = softLines.find(l => l.properties.name === 'Elm St');
    expect(residential.properties.highway).toBe('residential');
  });

  it('does not classify a bare footway as a street line', async () => {
    const { hardLines, softLines } = await fetchStreetGraph(boundary);
    const all = [...hardLines, ...softLines];
    expect(all.some(l => l.properties.highway === 'footway')).toBe(false);
  });
});

describe('classifyTerrainFeatures', () => {
  const closedRing = [
    { lat: 34.00, lon: -118.30 }, { lat: 34.00, lon: -118.29 },
    { lat: 34.01, lon: -118.29 }, { lat: 34.01, lon: -118.30 }, { lat: 34.00, lon: -118.30 },
  ];

  it('builds a polygon from a closed golf_course/park/cemetery/wood way', () => {
    const els = [
      { type: 'way', id: 1, tags: { leisure: 'golf_course' }, geometry: closedRing },
      { type: 'way', id: 2, tags: { leisure: 'park' }, geometry: closedRing },
      { type: 'way', id: 3, tags: { landuse: 'cemetery' }, geometry: closedRing },
      { type: 'way', id: 4, tags: { natural: 'wood' }, geometry: closedRing },
    ];
    const { terrainPolygons } = classifyTerrainFeatures(els);
    expect(terrainPolygons).toHaveLength(4);
    for (const p of terrainPolygons) expect(p.geometry.type).toBe('Polygon');
  });

  it('extracts path/footway ways as terrainPaths, not as polygons', () => {
    const els = [{ type: 'way', id: 5, tags: { highway: 'path' }, geometry: closedRing.slice(0, 2) }];
    const { terrainPaths, terrainPolygons } = classifyTerrainFeatures(els);
    expect(terrainPaths).toHaveLength(1);
    expect(terrainPolygons).toHaveLength(0);
  });

  it('skips a non-closed terrain way (relation-based multipolygon) with a warning, does not throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const openRing = closedRing.slice(0, 4); // deliberately not closed
    const els = [{ type: 'way', id: 6, tags: { leisure: 'park' }, geometry: openRing }];
    expect(() => classifyTerrainFeatures(els)).not.toThrow();
    const { terrainPolygons } = classifyTerrainFeatures(els);
    expect(terrainPolygons).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('ignores a way with no terrain or path tag entirely', () => {
    const els = [{ type: 'way', id: 7, tags: { amenity: 'hospital' }, geometry: closedRing }];
    const { terrainPolygons, terrainPaths } = classifyTerrainFeatures(els);
    expect(terrainPolygons).toHaveLength(0);
    expect(terrainPaths).toHaveLength(0);
  });
});

describe('tileBboxes', () => {
  it('returns the bbox unchanged when it is under the max area', () => {
    const small = [-118.30, 34.00, -118.29, 34.01]; // ~1 km²
    expect(tileBboxes(small, MAX_FETCH_AREA_M2)).toEqual([small]);
  });

  it('splits an oversized bbox into a grid that tiles it exactly', () => {
    const big = [-118.5, 33.9, -118.2, 34.15]; // ~770 km²
    const tiles = tileBboxes(big, MAX_FETCH_AREA_M2);
    expect(tiles.length).toBeGreaterThanOrEqual(Math.ceil(770_000_000 / MAX_FETCH_AREA_M2));
    // tiles cover the bbox: min of mins and max of maxes reconstruct it
    expect(Math.min(...tiles.map(t => t[0]))).toBeCloseTo(big[0], 9);
    expect(Math.min(...tiles.map(t => t[1]))).toBeCloseTo(big[1], 9);
    expect(Math.max(...tiles.map(t => t[2]))).toBeCloseTo(big[2], 9);
    expect(Math.max(...tiles.map(t => t[3]))).toBeCloseTo(big[3], 9);
  });
});

describe('fetchStreetGraph tiling', () => {
  const bigBoundary = turf.polygon([[
    [-118.5, 33.9], [-118.2, 33.9], [-118.2, 34.15], [-118.5, 34.15], [-118.5, 33.9],
  ]]);
  const wayFixture = (id) => ({
    type: 'way', id, tags: { highway: 'primary' },
    geometry: [{ lat: 34.0, lon: -118.4 }, { lat: 34.01, lon: -118.39 }],
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches once per tile, reports progress, and dedupes ways spanning tiles', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ elements: [wayFixture(42)] }), // same way id from every tile
    });
    const progress = [];
    const { hardLines } = await fetchStreetGraph(bigBoundary, {
      detail: 'city',
      onProgress: (done, total) => progress.push([done, total]),
    });
    const expectedTiles = global.fetch.mock.calls.length;
    expect(expectedTiles).toBeGreaterThan(1); // one call per tile (all succeed first try)
    expect(hardLines).toHaveLength(1); // way 42 deduped across every tile
    expect(progress[progress.length - 1]).toEqual([expectedTiles, expectedTiles]);
  });

  it('names the failing tile when a tile fails on every endpoint', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ elements: [] }) }) // tile 1 ok
      .mockResolvedValue({ ok: false, status: 504, json: () => Promise.reject(new SyntaxError('xml')) }); // tile 2+ fails, both endpoints
    await expect(fetchStreetGraph(bigBoundary, { detail: 'city' }))
      .rejects.toThrow(/tile 2 of \d+/);
  });
});

describe('cacheTileKeys', () => {
  it('covers a bbox with 0.05-degree tiles keyed by grid index', () => {
    const tiles = cacheTileKeys([-118.31, 34.01, -118.24, 34.06]);
    // lon -118.31..-118.24 spans indices -2367..-2365 (3 cols); lat 34.01..34.06 spans 680..681 (2 rows)
    expect(tiles).toHaveLength(6);
    expect(tiles[0].key).toMatch(/^tile_-?\d+_-?\d+$/);
    // every tile bbox is TILE_SIZE_DEG on each side and they cover the input
    for (const t of tiles) {
      expect(t.bbox[2] - t.bbox[0]).toBeCloseTo(TILE_SIZE_DEG, 9);
      expect(t.bbox[3] - t.bbox[1]).toBeCloseTo(TILE_SIZE_DEG, 9);
    }
    expect(Math.min(...tiles.map(t => t.bbox[0]))).toBeLessThanOrEqual(-118.31);
    expect(Math.max(...tiles.map(t => t.bbox[2]))).toBeGreaterThanOrEqual(-118.24);
  });
});

describe('filterByDetail', () => {
  const els = [
    { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { type: 'way', id: 2, tags: { highway: 'primary' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { type: 'way', id: 3, tags: { waterway: 'river' }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
  ];
  it('keeps only matching road classes plus waterways', () => {
    const city = filterByDetail(els, 'city');
    expect(city.map(e => e.id)).toEqual([2, 3]);
    expect(filterByDetail(els, 'full').map(e => e.id)).toEqual([1, 2, 3]);
  });
});

describe('fetchStreets (cache-first)', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);
  const cachedElements = [
    { type: 'way', id: 7, tags: { highway: 'primary' }, geometry: [{ lat: 34.005, lon: -118.295 }, { lat: 34.006, lon: -118.294 }] },
    { type: 'way', id: 8, tags: { highway: 'residential' }, geometry: [{ lat: 34.003, lon: -118.297 }, { lat: 34.004, lon: -118.296 }] },
  ];

  afterEach(() => { vi.restoreAllMocks(); });

  it('serves entirely from cache tiles without touching Overpass', async () => {
    global.fetch = vi.fn(url => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: cachedElements }) });
      }
      throw new Error(`unexpected non-cache fetch: ${url}`);
    });
    const { hardLines, softLines } = await fetchStreets(boundary);
    expect(hardLines).toHaveLength(1);
    expect(softLines).toHaveLength(1);
    for (const [url] of global.fetch.mock.calls) {
      expect(String(url)).toContain(STREET_TILE_BASE);
    }
  });

  it('falls back to live Overpass only for missing tiles', async () => {
    global.fetch = vi.fn(url => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: cachedElements }) });
    });
    const { hardLines } = await fetchStreets(boundary);
    expect(hardLines).toHaveLength(1);
    const overpassCalls = global.fetch.mock.calls.filter(([url]) => !String(url).startsWith(STREET_TILE_BASE));
    expect(overpassCalls.length).toBeGreaterThan(0);
  });

  it('returns full-detail allStreetLines even when the detail filter is coarse', async () => {
    // Zone EFFORT is measured by real street length (walked/driven meters),
    // which needs every street class even when polygonize only uses majors —
    // the cache has full detail either way. Waterways are not streets.
    global.fetch = vi.fn(url => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [
          ...cachedElements,
          { type: 'way', id: 9, tags: { waterway: 'river' }, geometry: [{ lat: 34.001, lon: -118.298 }, { lat: 34.002, lon: -118.299 }] },
        ] }) });
      }
      throw new Error('unexpected');
    });
    const { softLines, allStreetLines } = await fetchStreets(boundary, { detail: 'city' });
    expect(softLines).toHaveLength(0);        // residential filtered from zoning lines
    expect(allStreetLines).toHaveLength(2);   // primary + residential, no waterway
  });

  it('applies the detail filter to cached full-detail data', async () => {
    global.fetch = vi.fn(url => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: cachedElements }) });
      }
      throw new Error('unexpected');
    });
    const { hardLines, softLines } = await fetchStreets(boundary, { detail: 'city' });
    expect(hardLines).toHaveLength(1); // primary kept
    expect(softLines).toHaveLength(0); // residential filtered out
  });

  it('aborts a stalled cache-tile fetch instead of hanging zone generation forever', async () => {
    // A plain fetch() has no built-in timeout. Simulate a cache request that
    // never settles on its own — it should only reject once our code aborts
    // it, then fall through to live Overpass rather than hanging indefinitely.
    vi.useFakeTimers();
    global.fetch = vi.fn((url, options) => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: cachedElements }) });
    });
    const pending = fetchStreets(boundary);
    // Advance well beyond one tile's timeout in case the boundary maps to
    // more than one cache tile — each gets its own sequential 8s timer.
    await vi.advanceTimersByTimeAsync(40000);
    const { hardLines } = await pending;
    expect(hardLines).toHaveLength(1);
    vi.useRealTimers();
  });

  it('throws naming the tile when cache misses and Overpass fails', async () => {
    global.fetch = vi.fn(url => {
      if (String(url).startsWith(STREET_TILE_BASE)) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
      }
      return Promise.resolve({ ok: false, status: 504, json: () => Promise.reject(new SyntaxError('xml')) });
    });
    await expect(fetchStreets(boundary)).rejects.toThrow(/tile 1 of \d+/);
  });
});
