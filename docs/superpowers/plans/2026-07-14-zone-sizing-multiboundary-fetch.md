# Zone Sizing, Multiple Boundaries & Fetch Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command sets a total zone count; zones size themselves by density (equal block count per zone); searches support multiple editable boundaries; Overpass fetches become reliable at city scale via road-class level-of-detail and tile chunking.

**Architecture:** The shipped block-graph pipeline (`fetchStreetGraph → buildBlocks → mergeBlocksToZones → createZones`) is preserved. `mergeBlocksToZones` switches its balance metric from area to block count. Overpass code moves to a new `src/zones/overpass.js` gaining a detail parameter and tiled fetching. The search doc's `boundary` becomes a `boundaries` array (read shim keeps legacy searches working); zones gain a `boundaryId`. `SearchDetail.jsx` orchestrates per-boundary fetch → cross-boundary allocation → per-boundary merge.

**Tech Stack:** React 19 + Vite, @turf/turf 6.5, Mapbox GL + @mapbox/mapbox-gl-draw 1.5, Firebase Firestore (client SDK), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-zone-sizing-multiboundary-fetch-design.md`

## Global Constraints

- Work in the local clone `C:\Users\Jack\dev\sar-command-track` — NEVER the Google Drive copy (Drive sync fights npm).
- All code changes are in `command-center/`; `searcher-app/` and `telegram-bot/` are untouched (verified: searcher-app never reads `boundary`).
- No Firestore data migration: legacy searches storing `boundary` must keep working via a read shim. No `firestore.rules` changes needed (zone create/delete already requires auth; search writes already require auth).
- turf 6.5 API: `turf.union(a, b)` takes two positional polygons (not a FeatureCollection).
- Tests: `npm test` (vitest run) inside `command-center/`. Lint: `npm run lint` (oxlint).
- PowerShell gotcha from the handoff: run build steps one at a time; do not chain `cd a && npm run build && cd ..`.
- Commit after every task. No zone-count caps anywhere: ceilings are physical (zones ≤ blocks) and `createZones`'s existing 500-write batching.
- Constants (tunable, from spec): district LOD ≥ 0.1 km² avg zone, city LOD ≥ 1 km² avg zone, max fetch area per Overpass query ~30 km².

---

### Task 1: Equal-block-count merging in `mergeBlocksToZones`

**Files:**
- Modify: `command-center/src/zones/subdivider.js:163-202` (the `mergeBlocksToZones` function and its comment)
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `mergeBlocksToZones(blocks, adjacency, zoneCount)` — signature unchanged; merge preference is now smallest combined **block count** (tie-break: smallest combined area). All existing call sites and tests keep working.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
describe('mergeBlocksToZones — equal block count (density-varying zone sizes)', () => {
  // A row of 8 soft-adjacent blocks: six 1-unit-wide "downtown" blocks followed
  // by two 4-unit-wide "hillside" blocks. Equal-AREA merging packs the small
  // blocks together long before touching the big ones; equal-BLOCK-COUNT
  // merging must yield 4 zones of 2 blocks each — three small zones covering
  // the dense side, one big zone covering the sparse side.
  const widths = [1, 1, 1, 1, 1, 1, 4, 4];
  const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
  const rowBlocks = widths.map((w, i) =>
    turf.polygon([[[xs[i], 0], [xs[i + 1], 0], [xs[i + 1], 1], [xs[i], 1], [xs[i], 0]]])
  );
  const rowAdjacency = [0, 1, 2, 3, 4, 5, 6].map(i => ({ a: i, b: i + 1, hard: false }));

  it('balances block count per zone: dense side gets small zones, sparse side big ones', () => {
    const zones = mergeBlocksToZones(rowBlocks, rowAdjacency, 4);
    expect(zones).toHaveLength(4);
    const zoneWidths = zones
      .map(z => { const b = turf.bbox(z); return b[2] - b[0]; })
      .sort((a, b) => a - b);
    expect(zoneWidths[0]).toBeCloseTo(2, 5);
    expect(zoneWidths[1]).toBeCloseTo(2, 5);
    expect(zoneWidths[2]).toBeCloseTo(2, 5);
    expect(zoneWidths[3]).toBeCloseTo(8, 5);
  });

  it('still covers 100% of the input area', () => {
    const before = rowBlocks.reduce((s, b) => s + turf.area(b), 0);
    const zones = mergeBlocksToZones(rowBlocks, rowAdjacency, 4);
    const after = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(after / before).toBeCloseTo(1, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `command-center/`): `npm test -- test/zones/subdivider.test.js`
Expected: the new `balances block count per zone` test FAILS (area-based merging produces a zone of width 6 or similar, not 2/2/2/8). All pre-existing tests still pass.

- [ ] **Step 3: Implement block-count balancing**

In `command-center/src/zones/subdivider.js`, replace the `mergeBlocksToZones` function AND the comment block directly above it (currently lines 163-202) with:

```js
// Merge adjacent blocks smallest-combined-BLOCK-COUNT-first (tie-break:
// smallest combined area) until zoneCount is reached. Balancing block count
// instead of area is what makes zone sizes track density: dense areas have
// many small blocks, so equal-count zones come out physically small there and
// physically large in sparse areas — the block graph is itself the density
// signal, no extra data needed (2026-07-14 spec).
//
// Adjacency is tracked by contraction: an edge between two ORIGINAL block
// indices becomes internal (skipped) once both indices map to the same current
// cluster — no re-computation of geometry/lineOverlap is needed after the
// initial adjacency from buildBlocks, since "hard" is a property of a specific
// real barrier segment and survives any merge on either side of it unchanged.
//
// The stop condition tracks the LIVE cluster count (new Set(owner).size), not
// clusters.length — clusters.length only ever grows (each merge appends a new
// entry rather than removing the two it replaces), so checking it against
// zoneCount stays true long after the real number of remaining zones has
// already hit the target, over-merging past it whenever a soft edge happens to
// still connect two live clusters (found via a 6-block chain regression test).
export function mergeBlocksToZones(blocks, adjacency, zoneCount) {
  let clusters = blocks.map(poly => ({ poly, area: turf.area(poly), count: 1 }));
  let edges = adjacency.map(e => ({ ...e }));
  let owner = blocks.map((_, i) => i);

  while (new Set(owner).size > zoneCount) {
    let best = null;
    for (const e of edges) {
      if (e.hard) continue;
      const ci = owner[e.a], cj = owner[e.b];
      if (ci === cj) continue;
      const count = clusters[ci].count + clusters[cj].count;
      const area = clusters[ci].area + clusters[cj].area;
      if (!best || count < best.count || (count === best.count && area < best.area)) {
        best = { ci, cj, count, area };
      }
    }
    if (!best) break; // no soft-mergeable pair left — stop early, more zones than requested

    const { ci, cj } = best;
    const merged = turf.union(clusters[ci].poly, clusters[cj].poly);
    const newIndex = clusters.length;
    clusters = [...clusters, { poly: merged, area: turf.area(merged), count: best.count }];
    owner = owner.map(o => (o === ci || o === cj ? newIndex : o));
    edges = edges.filter(e => owner[e.a] !== owner[e.b]);
  }

  const liveClusterIndices = [...new Set(owner)];
  return liveClusterIndices.map(idx => clusters[idx].poly);
}
```

- [ ] **Step 4: Run the full subdivider suite to verify all pass**

Run: `npm test -- test/zones/subdivider.test.js`
Expected: ALL tests PASS, including the pre-existing FOUR_BLOCKS, chain-regression, and generateZones tests (they use equal-sized blocks, where count-balancing and area-balancing agree).

- [ ] **Step 5: Commit**

```bash
git add test/zones/subdivider.test.js src/zones/subdivider.js
git commit -m "feat(cc): merge blocks to zones by equal block count, not area"
```

---

### Task 2: Cross-boundary allocation — `allocateZoneCounts`

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (add export near `computeZoneCount`)
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `allocateZoneCounts(total, weights)` → `number[]` — largest-remainder proportional split of `total` across `weights` (block counts per boundary), minimum 1 each, summing exactly to `total` (unless the min-1 floor with more boundaries than `total` forces the sum above it). Task 7 calls this.

- [ ] **Step 1: Write the failing tests**

Append to `command-center/test/zones/subdivider.test.js` (add `allocateZoneCounts` to the import at the top of the file):

```js
describe('allocateZoneCounts', () => {
  it('splits proportionally by block count and sums exactly to the total', () => {
    // 14 zones across a 100-block boundary and a 9-block boundary:
    // raw shares 12.84 / 1.16 → floors 12 / 1, leftover 1 goes to the
    // largest fractional remainder (the 100-block boundary) → 13 / 1.
    expect(allocateZoneCounts(14, [100, 9])).toEqual([13, 1]);
  });

  it('always sums exactly to the total across awkward splits', () => {
    for (const [total, weights] of [[150, [70, 40, 12]], [7, [3, 3, 3]], [10, [1, 1, 1, 1]]]) {
      const alloc = allocateZoneCounts(total, weights);
      expect(alloc.reduce((s, a) => s + a, 0)).toBe(total);
    }
  });

  it('gives every boundary at least 1 zone', () => {
    expect(allocateZoneCounts(5, [1000, 1])).toEqual([4, 1]);
  });

  it('handles all-zero weights by giving 1 each', () => {
    expect(allocateZoneCounts(3, [0, 0])).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/zones/subdivider.test.js`
Expected: FAIL with `allocateZoneCounts is not a function` (undefined import).

- [ ] **Step 3: Implement**

In `command-center/src/zones/subdivider.js`, add directly below `computeZoneCount`:

```js
// Largest-remainder allocation: split `total` zones across boundaries
// proportionally to `weights` (their block counts), minimum 1 each, summing
// exactly to `total`. The only case the sum exceeds `total` is more boundaries
// than requested zones — the min-1 floor wins there by design (spec §1).
export function allocateZoneCounts(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return weights.map(() => 1);
  const raw = weights.map(w => (total * w) / sum);
  const alloc = raw.map(r => Math.max(1, Math.floor(r)));
  let leftover = total - alloc.reduce((s, a) => s + a, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    alloc[i] += 1;
    leftover -= 1;
  }
  return alloc;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/zones/subdivider.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/zones/subdivider.test.js src/zones/subdivider.js
git commit -m "feat(cc): largest-remainder zone allocation across boundaries"
```

---

### Task 3: Extract `overpass.js` with level-of-detail road filtering

**Files:**
- Create: `command-center/src/zones/overpass.js`
- Modify: `command-center/src/zones/subdivider.js` (delete the Overpass section, currently lines 210-260)
- Modify: `command-center/src/search/SearchDetail.jsx:5` (import `fetchStreetGraph` from the new module)
- Create: `command-center/test/zones/overpass.test.js` (move the `fetchStreetGraph` describe block out of `subdivider.test.js`, plus new LOD tests)

**Interfaces:**
- Consumes: `paddedBbox`, `HARD_HIGHWAYS` from `./subdivider` (both already exported).
- Produces:
  - `fetchStreetGraph(boundary, { detail = 'full' } = {})` → `Promise<{ hardLines, softLines }>` (same return shape as today; `detail` is new).
  - `selectDetail(boundaryAreaM2, estimatedZoneCount)` → `'full' | 'district' | 'city'`.
  - `DETAIL_LEVELS`, `DISTRICT_MIN_ZONE_AREA_M2 = 100_000`, `CITY_MIN_ZONE_AREA_M2 = 1_000_000` constants.

- [ ] **Step 1: Create the new test file with moved + new tests**

Create `command-center/test/zones/overpass.test.js`. Move the entire `describe('fetchStreetGraph', …)` block (currently `subdivider.test.js:205-290`) into it verbatim — including its `okResponse`/`gatewayTimeoutResponse` fixtures and the `boundary` polygon — changing only the import line, and append the new LOD tests:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as turf from '@turf/turf';
import { fetchStreetGraph, selectDetail, DETAIL_LEVELS, DISTRICT_MIN_ZONE_AREA_M2, CITY_MIN_ZONE_AREA_M2 } from '../../src/zones/overpass.js';

// … the moved describe('fetchStreetGraph', …) block goes here, unchanged …

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
```

Delete the moved `describe('fetchStreetGraph', …)` block (and its now-unused `fetchStreetGraph` import) from `test/zones/subdivider.test.js`.

- [ ] **Step 2: Run to verify the new file fails**

Run: `npm test`
Expected: `overpass.test.js` FAILS (module `src/zones/overpass.js` doesn't exist); `subdivider.test.js` still PASSES.

- [ ] **Step 3: Create `src/zones/overpass.js`**

Cut the entire Overpass section out of `subdivider.js` (the comment starting "Overpass's public de-facto instance 504s…", `OVERPASS_ENDPOINTS`, `OVERPASS_TIMEOUT_MS`, `queryOverpass`, and `fetchStreetGraph` — currently lines 210-260) and build the new module around it:

```js
import * as turf from '@turf/turf';
import { paddedBbox, HARD_HIGHWAYS } from './subdivider';

// Road-class filter scales with expected zone size (spec §3): big zones don't
// need alley-level edges, and a city-scale query for every residential lane
// over 300 km² is exactly what times out on public Overpass. Coarser roads
// also mean fewer blocks — the right granularity for merging to large zones.
export const DETAIL_LEVELS = {
  full:     'motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified',
  district: 'motorway|trunk|primary|secondary|tertiary',
  city:     'motorway|trunk|primary|secondary',
};
export const DISTRICT_MIN_ZONE_AREA_M2 = 100_000;   // 0.1 km² — tunable
export const CITY_MIN_ZONE_AREA_M2 = 1_000_000;     // 1 km² — tunable

export function selectDetail(boundaryAreaM2, estimatedZoneCount) {
  const avg = boundaryAreaM2 / Math.max(1, estimatedZoneCount);
  if (avg >= CITY_MIN_ZONE_AREA_M2) return 'city';
  if (avg >= DISTRICT_MIN_ZONE_AREA_M2) return 'district';
  return 'full';
}

// Overpass's public de-facto instance 504s under load reasonably often, and
// its error responses are XML, not JSON — calling resp.json() unconditionally
// throws a confusing SyntaxError instead of a clear "couldn't fetch streets"
// failure (this is exactly what happened in production). Check resp.ok first,
// and fall back to a second public instance before giving up.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 20000;

async function queryOverpass(query) {
  // … moved verbatim from subdivider.js …
}

function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;
}

function classifyWays(elements) {
  const hardLines = [];
  const softLines = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    const waterway = el.tags?.waterway;
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), { name: el.tags?.name ?? '' });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
}

export async function fetchStreetGraph(boundary, { detail = 'full' } = {}) {
  const bbox = paddedBbox(boundary);
  const data = await queryOverpass(buildQuery(bbox, detail));
  return classifyWays(data.elements);
}
```

In `subdivider.js`, delete the moved section (nothing in `subdivider.js` used it internally — `generateZones` takes lines as arguments). In `SearchDetail.jsx`, change line 5 to import `fetchStreetGraph` from `'../zones/overpass'` (keep the other imports from `'../zones/subdivider'`).

- [ ] **Step 4: Run all tests + lint**

Run: `npm test` then `npm run lint`
Expected: all PASS in both files, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/zones/overpass.js src/zones/subdivider.js src/search/SearchDetail.jsx test/zones/overpass.test.js test/zones/subdivider.test.js
git commit -m "feat(cc): extract Overpass module with level-of-detail road filtering"
```

---

### Task 4: Tile chunking for oversized fetch areas

**Files:**
- Modify: `command-center/src/zones/overpass.js`
- Test: `command-center/test/zones/overpass.test.js`

**Interfaces:**
- Consumes: Task 3's module.
- Produces:
  - `tileBboxes(bbox, maxAreaM2)` → `Array<[west, south, east, north]>` — grid split of a bbox so each tile is ≤ maxAreaM2 (returns `[bbox]` when already small enough).
  - `MAX_FETCH_AREA_M2 = 30_000_000` constant.
  - `fetchStreetGraph(boundary, { detail, onProgress } = {})` — `onProgress(done, total)` fires per tile; ways deduped by OSM id across tiles; a tile that fails both endpoints throws `Map data fetch failed on tile N of M: …`.

- [ ] **Step 1: Write the failing tests**

Append to `command-center/test/zones/overpass.test.js` (add `tileBboxes`, `MAX_FETCH_AREA_M2` to the import):

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/zones/overpass.test.js`
Expected: FAIL — `tileBboxes` not exported; tiling tests see a single fetch call.

- [ ] **Step 3: Implement tiling in `overpass.js`**

Add below `selectDetail`:

```js
// Public Overpass cannot reliably answer one huge query (~300 km² boundaries
// repeatedly produced "Couldn't fetch street data" in the field). Split the
// padded bbox into a grid of tiles and query them SEQUENTIALLY — the public
// instances rate-limit parallel requests from one client (spec §3).
export const MAX_FETCH_AREA_M2 = 30_000_000; // ~30 km² per query — tunable

export function tileBboxes(bbox, maxAreaM2) {
  const [west, south, east, north] = bbox;
  const areaM2 = turf.area(turf.bboxPolygon(bbox));
  const tileCount = Math.ceil(areaM2 / maxAreaM2);
  if (tileCount <= 1) return [bbox];
  const cols = Math.ceil(Math.sqrt(tileCount));
  const rows = Math.ceil(tileCount / cols);
  const dx = (east - west) / cols;
  const dy = (north - south) / rows;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push([west + c * dx, south + r * dy, west + (c + 1) * dx, south + (r + 1) * dy]);
    }
  }
  return tiles;
}
```

Replace `fetchStreetGraph` with the tiled version:

```js
export async function fetchStreetGraph(boundary, { detail = 'full', onProgress } = {}) {
  const bbox = paddedBbox(boundary);
  const tiles = tileBboxes(bbox, MAX_FETCH_AREA_M2);
  // Dedupe by OSM way id: the bbox filter returns any way touching the tile,
  // so a road crossing a tile border comes back from both tiles.
  const wayById = new Map();
  for (let i = 0; i < tiles.length; i++) {
    onProgress?.(i, tiles.length);
    let data;
    try {
      data = await queryOverpass(buildQuery(tiles[i], detail)); // queryOverpass already retries on the fallback endpoint
    } catch (err) {
      throw new Error(`Map data fetch failed on tile ${i + 1} of ${tiles.length}: ${err.message}`);
    }
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const key = el.id ?? `anon-${wayById.size}`;
      if (!wayById.has(key)) wayById.set(key, el);
    }
  }
  onProgress?.(tiles.length, tiles.length);
  return classifyWays([...wayById.values()]);
}
```

Note: `classifyWays` no longer needs its own `el.type`/`el.geometry` guard duplicated, but leaving it in place is harmless and keeps the single-tile fixtures (no `id` field) working via the `anon-` fallback key.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: ALL PASS — including the moved single-tile `fetchStreetGraph` tests (a small boundary produces exactly 1 tile, preserving old behavior: same query body, same fallback-endpoint semantics, same abort timeout).

- [ ] **Step 5: Commit**

```bash
git add src/zones/overpass.js test/zones/overpass.test.js
git commit -m "feat(cc): tile oversized Overpass fetches with progress + way dedupe"
```

---

### Task 5: Firestore layer — boundaries array, legacy shim, zone boundaryId

**Files:**
- Create: `command-center/src/search/boundaries.js`
- Modify: `command-center/src/firebase/searches.js`
- Modify: `command-center/src/firebase/zones.js`
- Test: `command-center/test/search/boundaries.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `parseBoundaries(data)` → `Array<{ id: string, geometry }>` (pure, firebase-free — lives in `src/search/boundaries.js` so it can be unit-tested without initializing Firebase).
  - `updateSearchBoundaries(searchId, boundaries)` — stores `boundaries` as one JSON string (same storage convention as the old `boundary`).
  - `watchSearch` callback now includes `boundaries` (array, via shim). The legacy `boundary` field also remains emitted (first boundary's geometry) until Task 7 removes its last consumer.
  - `createZones(searchId, dayId, zones)` — items are now `{ number, polygon, boundaryId }`; `boundaryId` stored on each zone doc (searcher-app ignores it harmlessly).
  - `deleteZonesForBoundary(searchId, dayId, boundaryId)` → deletes that boundary's zones in batches of 500.

- [ ] **Step 1: Write the failing shim test**

Create `command-center/test/search/boundaries.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseBoundaries } from '../../src/search/boundaries.js';

const GEOM = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };

describe('parseBoundaries', () => {
  it('parses the new boundaries array field', () => {
    const data = { boundaries: JSON.stringify([{ id: 'b1', geometry: GEOM }]) };
    expect(parseBoundaries(data)).toEqual([{ id: 'b1', geometry: GEOM }]);
  });

  it('shims a legacy single boundary into a one-element array', () => {
    const data = { boundary: JSON.stringify(GEOM) };
    expect(parseBoundaries(data)).toEqual([{ id: 'legacy-1', geometry: GEOM }]);
  });

  it('returns an empty array when neither field is set', () => {
    expect(parseBoundaries({})).toEqual([]);
    expect(parseBoundaries({ boundary: null, boundaries: null })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/search/boundaries.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the shim module**

Create `command-center/src/search/boundaries.js`:

```js
// Legacy searches store a single `boundary` (stringified geometry); newer ones
// store `boundaries` (stringified array of {id, geometry}). Normalize both to
// the array shape so nothing downstream ever sees the legacy field. Kept
// firebase-free so it's unit-testable without initializing the app.
export function parseBoundaries(data) {
  if (data.boundaries) return JSON.parse(data.boundaries);
  if (data.boundary) return [{ id: 'legacy-1', geometry: JSON.parse(data.boundary) }];
  return [];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- test/search/boundaries.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into `searches.js` and `zones.js`**

In `command-center/src/firebase/searches.js`:
- Add import: `import { parseBoundaries } from '../search/boundaries';`
- In `createSearch`, change `boundary: null` to `boundaries: null`.
- Add below `updateSearchBoundary` (leave the old function in place — `SearchDetail.jsx` still imports it until Task 7):

```js
export async function updateSearchBoundaries(searchId, boundaries) {
  await updateDoc(doc(db, 'searches', searchId), { boundaries: JSON.stringify(boundaries) });
}
```

- Replace the `watchSearch` callback body:

```js
export function watchSearch(searchId, cb) {
  return onSnapshot(doc(db, 'searches', searchId), snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const boundaries = parseBoundaries(data);
    cb({
      id: snap.id,
      ...data,
      boundaries,
      // legacy field kept until SearchDetail switches over (Task 7 removes it)
      boundary: boundaries[0]?.geometry ?? null,
    });
  });
}
```

In `command-center/src/firebase/zones.js`:
- Extend the import: `import { collection, doc, getDocs, updateDoc, onSnapshot, serverTimestamp, writeBatch } from 'firebase/firestore';`
- In `createZones`, change the destructure and doc body:

```js
    for (const { number, polygon, boundaryId } of zones.slice(i, i + 500)) {
      batch.set(doc(col), {
        number,
        polygon: JSON.stringify(polygon),
        boundaryId: boundaryId ?? null,
        status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
      });
    }
```

- Add:

```js
// Regenerating or editing one boundary must replace only ITS zones — other
// boundaries' zones (and any searcher assignments on them) stay intact.
// Filtered client-side, not with where('boundaryId','==',…): legacy zones have
// NO boundaryId field at all (Firestore where can't match a missing field), so
// they're attributed to the shim boundary 'legacy-1' here. Zone counts are a
// few hundred at most — one full read is fine.
export async function deleteZonesForBoundary(searchId, dayId, boundaryId) {
  const snap = await getDocs(zonesCol(searchId, dayId));
  const refs = snap.docs
    .filter(d => (d.data().boundaryId ?? 'legacy-1') === boundaryId)
    .map(d => d.ref);
  while (refs.length) {
    const batch = writeBatch(db);
    refs.splice(0, 500).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}
```

- [ ] **Step 6: Full test run + lint + build**

Run: `npm test`, `npm run lint`, `npm run build`
Expected: all tests PASS, no lint errors, build succeeds (nothing imports the new functions yet; the app still runs on the legacy `boundary` path emitted by the shim).

- [ ] **Step 7: Commit**

```bash
git add src/search/boundaries.js src/firebase/searches.js src/firebase/zones.js test/search/boundaries.test.js
git commit -m "feat(cc): boundaries array with legacy shim; zones carry boundaryId"
```

---

### Task 6: CommandMap — multiple boundaries, drawn and editable via Mapbox Draw

**Files:**
- Modify: `command-center/src/map/CommandMap.jsx`

**Interfaces:**
- Consumes: nothing new (Mapbox Draw 1.5 already installed; its default `simple_select` → click-to-select → `direct_select` vertex editing is built in).
- Produces — new prop contract (Task 7 is the only consumer):
  - `boundaries` (`Array<{id, geometry}>`, default `[]`) replaces `boundary`.
  - `editable` (bool, default `false`): when true, boundaries live inside Mapbox Draw (selectable, vertex-draggable, trash-deletable); when false they render read-only on the existing `boundary` geojson source.
  - `onFeatureDrawn(feature)` — unchanged (fires on `draw.create`).
  - `onBoundaryEdited({ id, geometry })` — fires per feature on `draw.update` (vertex drag or move).
  - `onBoundaryDeleted(id)` — fires per feature on `draw.delete` (Draw's trash control).

- [ ] **Step 1: Change the prop signature and callback refs**

In `command-center/src/map/CommandMap.jsx`, change the component signature (line 15) to:

```jsx
export function CommandMap({ drawMode, onFeatureDrawn, boundaries = [], editable = false, onBoundaryEdited, onBoundaryDeleted, zones = [], tracks = [], liveMarkers = [] }) {
```

Add refs alongside the existing `onFeatureDrawnRef` pattern (after line 28):

```jsx
  const onBoundaryEditedRef = useRef(onBoundaryEdited);
  const onBoundaryDeletedRef = useRef(onBoundaryDeleted);
  useEffect(() => { onBoundaryEditedRef.current = onBoundaryEdited; }, [onBoundaryEdited]);
  useEffect(() => { onBoundaryDeletedRef.current = onBoundaryDeleted; }, [onBoundaryDeleted]);
```

- [ ] **Step 2: Rewire the Draw event handlers**

Replace the `draw.create` handler (lines 87-90) with — note `draw.deleteAll()` is REMOVED (the sync effect below reconciles Draw against the `boundaries` prop; deleting here would wipe the other boundaries):

```jsx
    map.on('draw.create', e => {
      onFeatureDrawnRef.current?.(e.features[0]);
    });
    map.on('draw.update', e => {
      for (const f of e.features) onBoundaryEditedRef.current?.({ id: String(f.id), geometry: f.geometry });
    });
    map.on('draw.delete', e => {
      for (const f of e.features) onBoundaryDeletedRef.current?.(String(f.id));
    });
```

- [ ] **Step 3: Replace the single-boundary sync effect with a boundaries/editable one**

Replace the effect at lines 103-111 with:

```jsx
  // Boundaries live INSIDE Mapbox Draw while editable (giving click-to-select
  // and vertex editing for free); on completed searches they render read-only
  // on the plain geojson source. draw.set is idempotent — echoing the prop
  // back after a create/update round-trips through the parent without flicker
  // because feature ids are stable.
  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw || !mapLoaded) return;
    const features = boundaries.map(b => ({ type: 'Feature', id: b.id, geometry: b.geometry, properties: {} }));
    if (editable) {
      draw.set({ type: 'FeatureCollection', features });
      map.getSource('boundary')?.setData(turf.featureCollection([]));
    } else {
      draw.set({ type: 'FeatureCollection', features: [] });
      map.getSource('boundary')?.setData(turf.featureCollection(
        boundaries.map(b => ({ type: 'Feature', geometry: b.geometry, properties: {} }))
      ));
    }
  }, [boundaries, editable, mapLoaded]);
```

- [ ] **Step 4: Verify build + lint (no unit tests possible — mapbox-gl needs a real WebGL canvas, not jsdom)**

Run: `npm run lint` then `npm run build`
Expected: no errors. (`SearchDetail.jsx` still passes `boundary=` which is now an unknown prop — harmless for one task; Task 7 switches it. Functional verification happens in Task 7's manual checklist.)

- [ ] **Step 5: Commit**

```bash
git add src/map/CommandMap.jsx
git commit -m "feat(cc): CommandMap renders multiple boundaries with Draw-based editing"
```

---

### Task 7: SearchDetail — zone count input, suggester, multi-boundary generation

**Files:**
- Modify: `command-center/src/search/SearchDetail.jsx` (imports, state, handlers, toolbar JSX, CommandMap props)
- Modify: `command-center/src/firebase/searches.js` (remove now-unused `updateSearchBoundary` and the legacy `boundary` emission in `watchSearch`)

**Interfaces:**
- Consumes: `allocateZoneCounts`, `mergeBlocksToZones`, `buildBlocks`, `computeZoneCount` from `../zones/subdivider`; `fetchStreetGraph`, `selectDetail` from `../zones/overpass`; `updateSearchBoundaries` from `../firebase/searches`; `createZones`, `deleteZonesForBoundary` from `../firebase/zones`; Task 6's CommandMap props.
- Produces: the user-facing behavior. No new exports.

- [ ] **Step 1: Update imports and state**

Replace lines 5-7 imports with:

```jsx
import { fetchStreetGraph, selectDetail } from '../zones/overpass';
import { computeZoneCount, allocateZoneCounts, buildBlocks, mergeBlocksToZones } from '../zones/subdivider';
import { createZones, updateZoneStatus, watchZones, deleteZonesForBoundary } from '../firebase/zones';
import { updateSearchBoundaries, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
```

Replace the `boundary` state (line 16) with:

```jsx
  const [boundaries, setBoundaries] = useState([]);
  const [zoneCount, setZoneCount] = useState(1);
  const [countTouched, setCountTouched] = useState(false);
  const [generateNotice, setGenerateNotice] = useState('');
```

(keep `searchMinutes`/`searchMode` — they drive the suggester). In the `watchSearch` effect (line 41), replace `if (search.boundary) setBoundary(search.boundary);` with:

```jsx
      setBoundaries(search.boundaries ?? []);
```

- [ ] **Step 2: Add the suggester + boundary handlers**

Add below the `tracksWithStatus` line (line 52):

```jsx
  // Legacy zones predate boundaryId — the shim calls their boundary 'legacy-1',
  // so a missing boundaryId is attributed there. Keeps "does this boundary have
  // zones?" true for old searches.
  const zoneBelongsTo = (z, boundaryId) => (z.boundaryId ?? 'legacy-1') === boundaryId;

  const totalAreaM2 = boundaries.reduce(
    (s, b) => s + turf.area({ type: 'Feature', geometry: b.geometry, properties: {} }), 0);

  // Time+mode is a SUGGESTER now (spec §1): changing it always refills the
  // count field; adding/editing boundaries refills only until command has
  // typed a count of their own.
  useEffect(() => {
    if (!countTouched && totalAreaM2 > 0) {
      setZoneCount(computeZoneCount(totalAreaM2, searchMinutes, searchMode));
    }
  }, [totalAreaM2]); // eslint-disable-line react-hooks/exhaustive-deps

  function applySuggestedCount(minutes, mode) {
    setCountTouched(false);
    if (totalAreaM2 > 0) setZoneCount(computeZoneCount(totalAreaM2, minutes, mode));
  }

  async function handleBoundaryEdited(updated) {
    if (readOnly) return;
    const hasZones = zones.some(z => zoneBelongsTo(z, updated.id));
    if (hasZones && searchStatus === 'active'
        && !window.confirm("Searchers may already be assigned to this boundary's zones. Editing deletes its zones — continue?")) {
      setBoundaries(prev => [...prev]); // re-sync the map back to the stored shape
      return;
    }
    const next = boundaries.map(b => (b.id === updated.id ? { ...b, geometry: updated.geometry } : b));
    setBoundaries(next);
    await updateSearchBoundaries(searchId, next);
    if (hasZones) await deleteZonesForBoundary(searchId, DAY_ID, updated.id);
  }

  async function handleBoundaryDeleted(boundaryId) {
    if (readOnly) return;
    const hasZones = zones.some(z => zoneBelongsTo(z, boundaryId));
    if (hasZones && searchStatus === 'active'
        && !window.confirm("Searchers may already be assigned to this boundary's zones. Deleting removes them — continue?")) {
      setBoundaries(prev => [...prev]);
      return;
    }
    const next = boundaries.filter(b => b.id !== boundaryId);
    setBoundaries(next);
    await updateSearchBoundaries(searchId, next);
    if (hasZones) await deleteZonesForBoundary(searchId, DAY_ID, boundaryId);
  }
```

Replace `handleFeatureDrawn` (lines 54-63) with:

```jsx
  async function handleFeatureDrawn(feature) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      const next = [...boundaries, { id: String(feature.id ?? crypto.randomUUID()), geometry: feature.geometry }];
      setBoundaries(next);
      await updateSearchBoundaries(searchId, next);
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }
```

- [ ] **Step 3: Replace `handleGenerateZones` with the multi-boundary orchestrator**

Replace lines 65-87 with:

```jsx
  async function handleGenerateZones() {
    if (!boundaries.length) return;
    setGeneratingZones(true);
    setGenerateError('');
    setGenerateNotice('');
    const failures = [];
    try {
      // Per-boundary retry for free: only boundaries with no zones yet are
      // (re)generated, and the requested total is reduced by what already exists.
      const targets = boundaries
        .map(b => ({ ...b, feature: { type: 'Feature', geometry: b.geometry, properties: {} } }))
        .filter(b => !zones.some(z => zoneBelongsTo(z, b.id)));
      if (!targets.length) { setGeneratingZones(false); return; }
      const remaining = Math.max(1, zoneCount - zones.length);

      // Fetch + polygonize per boundary — smaller queries, independent failures.
      // LOD needs a PRE-fetch estimate (block counts don't exist yet), so the
      // estimate splits `remaining` by area; the real allocation below uses
      // actual block counts (spec §3).
      const totalTargetArea = targets.reduce((s, t) => s + turf.area(t.feature), 0);
      const built = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const areaM2 = turf.area(t.feature);
        const estAlloc = Math.max(1, Math.round(remaining * areaM2 / totalTargetArea));
        const label = targets.length > 1 ? ` (boundary ${i + 1} of ${targets.length})` : '';
        try {
          setGeneratingStatus(`Fetching map data…${label}`);
          const { hardLines, softLines } = await fetchStreetGraph(t.feature, {
            detail: selectDetail(areaM2, estAlloc),
            onProgress: (done, total) => {
              if (total > 1) setGeneratingStatus(`Fetching map data…${label} tile ${Math.min(done + 1, total)}/${total}`);
            },
          });
          setGeneratingStatus(`Building blocks…${label}`);
          const { blocks, adjacency } = buildBlocks(t.feature, hardLines, softLines);
          built.push({ ...t, blocks, adjacency });
        } catch (err) {
          console.error(`fetch/build failed for boundary ${t.id}:`, err);
          failures.push(`Boundary ${i + 1}: ${err.message}`);
        }
      }

      if (built.length) {
        const alloc = allocateZoneCounts(remaining, built.map(b => Math.max(1, b.blocks.length)));
        setGeneratingStatus('Generating zones…');
        let nextNumber = zones.reduce((m, z) => Math.max(m, z.number), 0) + 1;
        const toCreate = [];
        const noStreets = [];
        built.forEach((b, i) => {
          // clamp: a zone is never smaller than one block (spec §1)
          const clamped = Math.min(alloc[i], Math.max(1, b.blocks.length));
          const polys = b.blocks.length ? mergeBlocksToZones(b.blocks, b.adjacency, clamped) : [b.feature];
          if (!b.blocks.length) noStreets.push(b.id);
          for (const p of polys) toCreate.push({ number: nextNumber++, polygon: p.geometry, boundaryId: b.id });
        });
        setGeneratingStatus(`Saving ${toCreate.length} zones…`);
        await createZones(searchId, DAY_ID, toCreate);
        if (noStreets.length) {
          setGenerateNotice(`${noStreets.length} boundar${noStreets.length === 1 ? 'y' : 'ies'} had no mapped streets — each became a single zone.`);
        }
        if (toCreate.length !== remaining && !failures.length) {
          setGenerateNotice(n => `${n} Generated ${toCreate.length} zones (requested ${remaining} — limited by available blocks or hard-road divides).`.trim());
        }
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
      failures.push(err.message);
    }
    if (failures.length) {
      setGenerateError(`${failures.join(' — ')}. Other boundaries' zones were saved; press Generate again to retry just the failed ones.`);
    }
    setGeneratingStatus('');
    setGeneratingZones(false);
  }
```

- [ ] **Step 4: Update the toolbar JSX and CommandMap props**

Replace the Step 1 button block (lines 123-130) with — boundary drawing stays available for the whole `setup` phase, not just before the first boundary:

```jsx
        {/* Step 1: draw one or more boundaries */}
        {searchStatus === 'setup' && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary'
              ? '✏ Drawing boundary… (double-click to finish)'
              : boundaries.length ? '📍 Add Boundary' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}
```

Replace the Step 2 block (lines 132-157) with — count field is primary; min/mode inputs refill it; the block stays visible while any boundary lacks zones so a failed boundary can be retried:

```jsx
        {/* Step 2: zone count (time+mode suggests, command decides) */}
        {searchStatus === 'setup' && boundaries.length > 0
          && boundaries.some(b => !zones.some(z => zoneBelongsTo(z, b.id))) && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: Zones</span>
            <input
              type="number" min={1} value={zoneCount}
              onChange={e => { setCountTouched(true); setZoneCount(Math.max(1, Number(e.target.value))); }}
              style={{ width: 64, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <span style={{ fontSize: 13, opacity: 0.7 }}>suggest by</span>
            <input
              type="number" min={5} max={240} value={searchMinutes}
              onChange={e => { const v = Number(e.target.value); setSearchMinutes(v); applySuggestedCount(v, searchMode); }}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <span style={{ fontSize: 13, opacity: 0.7 }}>min</span>
            <select
              value={searchMode}
              onChange={e => { setSearchMode(e.target.value); applySuggestedCount(searchMinutes, e.target.value); }}
              style={{ padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }}>
              <option value="walked">Walked</option>
              <option value="driven">Driven</option>
            </select>
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
            {generateError && <span style={{ color: '#fca5a5', fontSize: 13 }}>{generateError}</span>}
            {generateNotice && <span style={{ color: '#fcd34d', fontSize: 13 }}>{generateNotice}</span>}
          </>
        )}
```

Replace the CommandMap invocation (lines 188-195) with:

```jsx
        <CommandMap
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundaries={boundaries}
          editable={!readOnly}
          onBoundaryEdited={handleBoundaryEdited}
          onBoundaryDeleted={handleBoundaryDeleted}
          zones={zones}
          tracks={tracksWithStatus}
          liveMarkers={liveMarkers}
        />
```

- [ ] **Step 5: Remove the legacy single-boundary path**

In `command-center/src/firebase/searches.js`: delete the `updateSearchBoundary` function, and delete the `boundary: boundaries[0]?.geometry ?? null,` line (and its comment) from `watchSearch` — `boundaries` is now the only shape emitted.

- [ ] **Step 6: Tests, lint, build**

Run: `npm test`, `npm run lint`, `npm run build`
Expected: all PASS / no errors.

- [ ] **Step 7: Manual smoke test (dev server + Firebase emulator not configured — use the real dev project flow)**

Run `npm run dev` in `command-center/` and verify against a throwaway search:
1. Create a search → draw TWO separate small boundaries a few blocks apart → both persist after a page reload (Firestore round-trip).
2. Click a boundary → click again → drag a vertex → shape updates and persists on reload.
3. Draw-tool trash deletes a selected boundary.
4. Set zone count to e.g. 6 → Generate → zones appear across both boundaries, numbered continuously, none crossing a hard road; the denser boundary got more zones.
5. Change minutes/mode → count field refills; type a custom count → boundary edits no longer overwrite it.
6. Open a PRE-EXISTING search (legacy `boundary` field) → its boundary renders and its zones still display.
7. Delete the throwaway search.

- [ ] **Step 8: Commit**

```bash
git add src/search/SearchDetail.jsx src/firebase/searches.js
git commit -m "feat(cc): count-driven multi-boundary zone generation with per-boundary retry"
```

---

### Task 8: Full verification, deploy, field validation

**Files:** none created — verification only.

- [ ] **Step 1: Full test suite + lint**

In `command-center/`: `npm test` then `npm run lint`
Expected: all tests PASS (subdivider, overpass, boundaries, sortSearches, searchCode), no lint errors.

- [ ] **Step 2: Build both apps (one at a time — PowerShell cd-chaining gotcha)**

```
cd C:\Users\Jack\dev\sar-command-track\command-center
npm run build
cd C:\Users\Jack\dev\sar-command-track\searcher-app
npm run build
```
Expected: both builds succeed.

- [ ] **Step 3: City-scale fetch check (the original blocker)**

In the dev server, draw one large boundary (~50-100 km²) and generate with a count around 30-50. Expected: LOD selects district/city detail, progress shows tile counts if chunked, generation completes without "Couldn't fetch street data". This was impossible before this change.

- [ ] **Step 4: Push and deploy (with Jack)**

`git push`, then per the handoff cheatsheet: `firebase deploy --only hosting,firestore:rules` from the repo root (CLI is authorized on this machine as of 2026-07-14). Hard-refresh (`Ctrl+Shift+R`) the Command Center after deploying — the browser aggressively caches the old bundle.

- [ ] **Step 5: Field validation — Jeanne Missing (with Jack)**

Recreate the Jeanne Missing search area (Jack has the Scribble Maps reference), request 150 zones, and compare: small zones in dense areas, large in sparse, ~2-3 km² average, generation completes. Tune `DISTRICT_MIN_ZONE_AREA_M2` / `CITY_MIN_ZONE_AREA_M2` / `MAX_FETCH_AREA_M2` if the fetch or granularity disappoints — they're constants in `src/zones/overpass.js` for exactly this reason.

- [ ] **Step 6: Update the Drive handoff doc**

Update `G:\My Drive\SAR\SAR-Command-Track-Handoff.md`: mark the zone-sizing model, editable/multiple boundaries, and fetch-reliability items as done; record any tuning-constant changes from Step 5; note the bot is now stale against `boundaryId`-carrying zones too (still optional, still deferred).
