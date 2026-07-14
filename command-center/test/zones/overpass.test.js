import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as turf from '@turf/turf';
import { fetchStreetGraph, selectDetail, DETAIL_LEVELS } from '../../src/zones/overpass.js';

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
    expect(softLines).toHaveLength(3); // residential + tertiary + footway (see note below)
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
    expect(softLines).toHaveLength(3);
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
      expect(softLines).toHaveLength(3);
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
