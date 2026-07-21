# Zone Generation Algorithm Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zone generation see park/golf/cemetery/wood terrain when splitting oversized blocks, and add a post-growth scored boundary-refinement pass that fixes non-compact shapes, hard-road-isolated runts, standing slivers, and greedy-growth split mismatches — the five issues from `docs/superpowers/specs/2026-07-19-zone-algorithm-quality-design.md`, field-confirmed 2026-07-20 (zone 95 genuinely crossing the 405 freeway in a real 143-zone search).

**Architecture:** Two independent additions to the existing street→blocks→zones pipeline (`overpass.js` → `subdivider.js`). Part A (Tasks 1-4) teaches the Overpass fetch layer and `buildBlocks`'s local-refinement branch to see terrain-feature polygons instead of falling back to a blind grid. Part B (Tasks 5-7) adds `refineZoneBoundaries`, a new scored local-search pass inside `mergeBlocksToZones` that runs after today's greedy growth + runt absorption and re-evaluates every zone border by weight-balance, shape compactness, road-class quality, and a hard-road-crossing penalty — replacing the old binary "last resort" hard-road rule with a continuous tradeoff.

**Tech Stack:** Vanilla JS (ES modules), `@turf/turf` for geometry, Vitest for tests. No new dependencies.

## Global Constraints

- Never work in the Drive copy (`G:\My Drive\SAR\sar-command-track`) — only `C:\Users\Jack\dev\sar-command-track`. Drive sync fights npm.
- Follow this repo's existing style in `subdivider.js`/`overpass.js`: exported pure functions with a one-paragraph "why" comment above non-obvious constants, internal helpers left unexported (tested indirectly through the public functions that use them) UNLESS the file's own convention already exports something purely for testability (`computeBlockEfforts`, `allocateZoneCounts`, `orderZonesForNumbering`, `paddedBbox` all are) — `isoperimetricQuotient` and `refineZoneBoundaries` follow that same testability-export pattern.
- All new tunable constants go in `subdivider.js` alongside the existing ones (`OPEN_GROUND_M_PER_M2`, `RUNT_FRACTION`, etc.) with the same "field-tuned, not derived" framing.
- Every task ends with `cd command-center && npx vitest run` passing in full (not just the new test file) — this pipeline has a documented history of one change quietly breaking a different test file's assumptions.
- `tools/prefetch-streets.mjs` has no test suite today (confirmed — it's a standalone ops script) and this plan does not add one; verify its query change by direct string inspection instead.

---

## Operational note (read before Task 1, act on it after Task 1 ships)

The 702 county-wide tiles already downloaded to `command-center/public/street-tiles/` were fetched with the OLD query (no terrain/path tags). `prefetch-streets.mjs` is resumable by **file existence**, not content completeness — re-running it after Task 1 will skip every already-downloaded tile and silently keep them missing terrain data forever. After Task 1 ships, Jack needs to delete the existing tile directory contents (or a targeted subset) and re-run the prefetch before Part A's terrain-awareness does anything useful in production. This is **not** a task in this plan (it's an ops/deploy decision, not code) — just don't forget it exists.

---

### Task 1: Add terrain-feature and path/footway tags to both Overpass queries

**Files:**
- Modify: `command-center/src/zones/overpass.js:76-83` (`buildQuery`)
- Modify: `tools/prefetch-streets.mjs:61-66` (`query`)
- Test: `command-center/test/zones/overpass.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildQuery(bbox, detail)` — same signature, larger query string. No exported symbol changes.

- [ ] **Step 1: Write the failing test**

Add to `command-center/test/zones/overpass.test.js`, right after the existing `describe('fetchStreetGraph level of detail', ...)` block (after line 137):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js -t "terrain-feature"`
Expected: FAIL — `options.body` does not contain `'leisure"~"golf_course|park'`.

- [ ] **Step 3: Implement — extend `buildQuery` in `overpass.js`**

Replace lines 76-83:

```js
function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;
}
```

with:

```js
// Terrain features (2026-07-19 zone-algorithm-quality spec, issue #1): parks/
// golf courses/cemeteries/wood are invisible to the algorithm without these —
// a block containing one falls back to a blind grid split instead of
// following the feature's real shape (field bug: a golf course cut in half by
// a straight grid line). Fetched at every detail level, not gated by
// DETAIL_LEVELS, since they matter to local refinement regardless of zoning
// LOD. highway=path|footway rides along so a feature's internal paths are
// available too — see buildBlocks' local-refinement branch (Task 3).
function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
  way["leisure"~"golf_course|park"](${south},${west},${north},${east});
  way["landuse"~"cemetery"](${south},${west},${north},${east});
  way["natural"~"wood"](${south},${west},${north},${east});
  way["highway"~"path|footway"](${south},${west},${north},${east});
);
out geom;`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js -t "terrain-feature"`
Expected: PASS

- [ ] **Step 5: Manually update the cache-prep script to match**

`tools/prefetch-streets.mjs` has no test suite (standalone Node script, confirmed no existing test file references it). Replace lines 61-66:

```js
const query = ([west, south, east, north]) => `[out:json][timeout:60];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;
```

with:

```js
// Keep in sync with command-center/src/zones/overpass.js's buildQuery — the
// cache tile scheme requires identical tag coverage (2026-07-19 zone-
// algorithm-quality spec, issue #1: terrain features + internal paths).
const query = ([west, south, east, north]) => `[out:json][timeout:60];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
  way["leisure"~"golf_course|park"](${south},${west},${north},${east});
  way["landuse"~"cemetery"](${south},${west},${north},${east});
  way["natural"~"wood"](${south},${west},${north},${east});
  way["highway"~"path|footway"](${south},${west},${north},${east});
);
out geom;`;
```

Verify by reading the two query strings side by side — every `way[...]` clause in `overpass.js`'s new `buildQuery` (except the `${DETAIL_LEVELS[detail]}` interpolation, which `prefetch-streets.mjs` intentionally hardcodes to the `full` tier since it always prefetches full detail) must appear in `prefetch-streets.mjs`'s `query`.

- [ ] **Step 6: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all tests PASS (no regressions from the added query clauses — nothing else parses `buildQuery`'s output at this point).

- [ ] **Step 7: Commit**

```bash
git add command-center/src/zones/overpass.js tools/prefetch-streets.mjs command-center/test/zones/overpass.test.js
git commit -m "feat(cc): fetch terrain features and paths for zone splitting"
```

---

### Task 2: Classify terrain features separately from streets; tag street lines with their road class

**Files:**
- Modify: `command-center/src/zones/overpass.js:85-96` (`classifyWays`), `:129-162` (`fetchStreets`), `:164-186` (`fetchStreetGraph`)
- Test: `command-center/test/zones/overpass.test.js`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `classifyTerrainFeatures(elements) → { terrainPolygons: Feature<Polygon>[], terrainPaths: Feature<LineString>[] }` (new export). `classifyWays(elements)` unchanged signature, but each returned line now carries `properties.highway` (the road class, or `'waterway'`). `fetchStreets(...)` and `fetchStreetGraph(...)` results gain `terrainPolygons`/`terrainPaths` fields alongside `hardLines`/`softLines`.

- [ ] **Step 1: Write the failing tests**

Add to `command-center/test/zones/overpass.test.js`, right after the new `describe('buildQuery terrain-feature and path tags', ...)` block from Task 1:

```js
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
```

Update the import line at the top of the test file (line 3) to add the new export:

```js
import { fetchStreetGraph, fetchStreets, selectDetail, DETAIL_LEVELS, tileBboxes, cacheTileKeys, filterByDetail, MAX_FETCH_AREA_M2, TILE_SIZE_DEG, STREET_TILE_BASE, classifyTerrainFeatures } from '../../src/zones/overpass.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js -t "classify"`
Expected: FAIL — `classifyTerrainFeatures` is not exported yet; `properties.highway` is `undefined` on existing lines.

- [ ] **Step 3: Implement — `classifyWays` road-class tagging + skip untagged ways**

Replace lines 85-96:

```js
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
```

with:

```js
function classifyWays(elements) {
  const hardLines = [];
  const softLines = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    const waterway = el.tags?.waterway;
    // Only real streets/waterways become zoning edges. Terrain features
    // (golf/park/cemetery/wood) and bare paths/footways are classified
    // separately by classifyTerrainFeatures below (2026-07-19 spec, issue #1)
    // — an untagged or terrain-tagged way must not fall through into
    // softLines as if it were an ordinary internal street. Path/footway ways
    // in particular must NOT also land in softLines: they're only meant to
    // be available scoped to a terrain feature's local split (Task 3), not as
    // ordinary internal streets fragmenting every block city-wide.
    if (!highway && !waterway) continue;
    if (highway === 'path' || highway === 'footway') continue;
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), {
      name: el.tags?.name ?? '',
      highway: waterway ? 'waterway' : highway,
    });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
}

const TERRAIN_POLYGON_TAGS = { leisure: ['golf_course', 'park'], landuse: ['cemetery'], natural: ['wood'] };

// Builds real polygons/paths for terrain features (2026-07-19 spec, issue #1)
// so buildBlocks' local-refinement branch (Task 3) can split an oversized
// block along a feature's actual shape instead of a blind grid. Way-only: OSM
// multipolygon relations for these tags (shapes with holes) are rare for
// golf/park/cemetery and are skipped with a warning rather than handled — not
// a blocker for this iteration.
export function classifyTerrainFeatures(elements) {
  const terrainPolygons = [];
  const terrainPaths = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    if (highway === 'path' || highway === 'footway') {
      terrainPaths.push(turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat])));
      continue;
    }
    const isTerrainTag = Object.entries(TERRAIN_POLYGON_TAGS)
      .some(([key, vals]) => el.tags?.[key] && vals.includes(el.tags[key]));
    if (!isTerrainTag) continue;
    const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      console.warn(`terrain feature way ${el.id ?? '(anon)'} is not a closed ring (relation-based multipolygon?) — skipped`);
      continue;
    }
    try { terrainPolygons.push(turf.polygon([coords])); }
    catch (err) { console.warn(`terrain feature way ${el.id ?? '(anon)'} failed to build a polygon: ${err.message}`); }
  }
  return { terrainPolygons, terrainPaths };
}
```

- [ ] **Step 4: Wire `classifyTerrainFeatures` into `fetchStreets` and `fetchStreetGraph`**

In `fetchStreets` (around line 161), replace:

```js
  return { ...classifyWays(filterByDetail(all, detail)), allStreetLines };
```

with:

```js
  // Terrain features aren't part of the DETAIL_LEVELS road-class filter at
  // all, so they must be classified from `all` (the pre-filter full-detail
  // list) — filterByDetail would otherwise strip them since they carry
  // neither a highway nor waterway tag.
  return { ...classifyWays(filterByDetail(all, detail)), ...classifyTerrainFeatures(all), allStreetLines };
```

In `fetchStreetGraph` (around line 185), replace:

```js
  return classifyWays([...wayById.values()]);
```

with:

```js
  const allElements = [...wayById.values()];
  return { ...classifyWays(allElements), ...classifyTerrainFeatures(allElements) };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js`
Expected: all PASS, including the new `classifyWays road class tagging` and `classifyTerrainFeatures` describes.

- [ ] **Step 6: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all PASS, WITH one deliberate exception: the three pre-existing `fetchStreetGraph` tests whose fixture includes a footway way (`'classifies motorway/trunk/primary and waterways as hard, everything else fetched as soft'` and the two Overpass-fallback/timeout tests that share the same fixture) currently assert `softLines` has length 3, including that footway. Per the corrected `classifyWays` above (which now excludes `highway === 'path' || 'footway'`, not just untagged/terrain-tagged ways — this exclusion was missing from an earlier draft of this plan and is corrected here), the footway no longer lands in `softLines` at all. Update those three assertions from `toHaveLength(3)` to `toHaveLength(2)` as part of this task — this is an intentional behavior change (a footway must only be available via `terrainPaths`, scoped to terrain-feature splitting, never as an ordinary internal street fragmenting every block city-wide), not a regression to avoid.

- [ ] **Step 7: Commit**

```bash
git add command-center/src/zones/overpass.js command-center/test/zones/overpass.test.js
git commit -m "feat(cc): classify terrain features separately, tag street lines with road class"
```

---

### Task 3: `buildBlocks` splits an oversized block along a terrain feature instead of a blind grid

**Files:**
- Modify: `command-center/src/zones/subdivider.js:286-355` (`buildBlocks`)
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: nothing new (terrain polygons/paths are plain turf Features, same shape as `classifyTerrainFeatures`'s output from Task 2, but this task's test constructs them directly — no import coupling to overpass.js).
- Produces: `buildBlocks(boundary, hardLines, softLines, { ..., terrainPolygons, terrainPaths })` — two new optional options, default `[]`. Return shape unchanged (`{ blocks, adjacency }`).

- [ ] **Step 1: Write the failing tests**

Add to `command-center/test/zones/subdivider.test.js`, inside the `describe('buildBlocks', ...)` block, after the existing `'grid-subdivides an oversized block that has no internal streets to refine with'` test (after line 147):

```js
  it('splits an oversized block along a golf-course feature instead of a blind grid', () => {
    // A golf-course polygon fills the right half of an oversized, streetless
    // block. With no internal streets to refine with, the old behavior fell
    // back to gridZones — a straight rectangular cut with no regard for the
    // feature's shape (field bug 2026-07-16, 2026-07-19 spec issue #1).
    // Passing the feature's own ring as a local edge must make the split
    // follow it instead.
    const BIG = turf.polygon([[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]]); // ~2.2km square, no streets
    const golfCourse = turf.polygon([[[0.01, 0], [0.02, 0], [0.02, 0.02], [0.01, 0.02], [0.01, 0]]]); // right half
    const { blocks } = buildBlocks(BIG, [], [], {
      maxBlockAreaM2: turf.area(BIG) * 2,
      refineStreets: [],
      targetZoneCount: 2,
      terrainPolygons: [golfCourse],
    });
    expect(blocks.length).toBeGreaterThan(1);
    const matchesGolfCourse = blocks.some(b => {
      let inter;
      try { inter = turf.intersect(b, golfCourse); } catch { return false; }
      return inter && turf.area(inter) / turf.area(golfCourse) > 0.95;
    });
    expect(matchesGolfCourse).toBe(true);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(BIG)).toBeGreaterThan(0.999);
  });

  it('still falls back to gridZones when the terrain feature covers the whole block and has no internal paths', () => {
    // A terrain polygon identical to the block itself has no residual area to
    // form a second block from — its own ring can't split it. Must still fall
    // back to grid, matching pre-existing behavior.
    const BIG = turf.polygon([[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]]);
    const { blocks } = buildBlocks(BIG, [], [], {
      maxBlockAreaM2: turf.area(BIG) * 2,
      refineStreets: [],
      targetZoneCount: 3,
      terrainPolygons: [BIG],
    });
    expect(blocks.length).toBeGreaterThan(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "golf-course"`
Expected: FAIL — `buildBlocks` doesn't accept/use `terrainPolygons` yet, so the golf-course area doesn't get preserved as its own block; `matchesGolfCourse` is `false`.

- [ ] **Step 3: Implement — extend `buildBlocks`' options and refinement branch**

Replace the `buildBlocks` function signature (line 286-291):

```js
export function buildBlocks(boundary, hardLines, softLines, {
  maxBlockAreaM2 = MAX_PLAUSIBLE_BLOCK_AREA_M2,
  refineStreets = null,
  targetZoneCount = 0,
  skipAdjacency = false,
} = {}) {
```

with:

```js
export function buildBlocks(boundary, hardLines, softLines, {
  maxBlockAreaM2 = MAX_PLAUSIBLE_BLOCK_AREA_M2,
  refineStreets = null,
  targetZoneCount = 0,
  skipAdjacency = false,
  terrainPolygons = [],
  terrainPaths = [],
} = {}) {
```

Replace the local-refinement branch (lines 325-343):

```js
  if (targetZoneCount > 0 && blocks.length) {
    const streets = refineStreets ?? [];
    const efforts = computeBlockEfforts(blocks, streets);
    const targetEffort = (efforts.reduce((s, e) => s + e, 0) / targetZoneCount) * REFINE_EFFORT_FACTOR;
    const lineBboxes = streets.map(l => turf.bbox(l));
    blocks = blocks.flatMap((b, i) => {
      if (efforts[i] <= targetEffort) return [b];
      const bb = turf.bbox(b);
      const local = streets.filter((l, li) => bboxesTouch(lineBboxes[li], bb));
      let sub = null;
      try { sub = buildBlocks(b, [], local, { maxBlockAreaM2, skipAdjacency: true }); } catch { /* fall through to grid */ }
      if (sub?.blocks.length > 1) return sub.blocks;
      try {
        const cellCount = Math.max(2, Math.round(efforts[i] / targetEffort));
        const cells = gridZones(b, cellCount);
        return cells.length > 1 ? cells : [b];
      } catch { return [b]; }
    });
  }
```

with:

```js
  if (targetZoneCount > 0 && blocks.length) {
    const streets = refineStreets ?? [];
    const efforts = computeBlockEfforts(blocks, streets);
    const targetEffort = (efforts.reduce((s, e) => s + e, 0) / targetZoneCount) * REFINE_EFFORT_FACTOR;
    const lineBboxes = streets.map(l => turf.bbox(l));
    const terrainBboxes = terrainPolygons.map(t => turf.bbox(t));
    const pathBboxes = terrainPaths.map(p => turf.bbox(p));
    blocks = blocks.flatMap((b, i) => {
      if (efforts[i] <= targetEffort) return [b];
      const bb = turf.bbox(b);
      const local = streets.filter((l, li) => bboxesTouch(lineBboxes[li], bb));

      // A terrain feature (golf/park/cemetery/wood) overlapping this block
      // has a real shape to split along — try it before falling back to a
      // blind grid (2026-07-19 spec, issue #1: a golf course was cut straight
      // through by gridZones because it was invisible to the algorithm).
      const overlappingTerrain = terrainPolygons.filter((t, ti) => {
        if (!bboxesTouch(terrainBboxes[ti], bb)) return false;
        try { return turf.booleanIntersects(t, b); } catch { return false; }
      });
      if (overlappingTerrain.length) {
        const terrainEdges = overlappingTerrain.flatMap(t => {
          try { return [turf.polygonToLine(t)]; } catch { return []; }
        });
        const localPaths = terrainPaths.filter((p, pi) => bboxesTouch(pathBboxes[pi], bb));
        try {
          const terrainSplit = buildBlocks(b, [], [...local, ...terrainEdges, ...localPaths], { maxBlockAreaM2, skipAdjacency: true });
          if (terrainSplit.blocks.length > 1) return terrainSplit.blocks;
        } catch { /* fall through to the plain-street / grid attempts below */ }
      }

      let sub = null;
      try { sub = buildBlocks(b, [], local, { maxBlockAreaM2, skipAdjacency: true }); } catch { /* fall through to grid */ }
      if (sub?.blocks.length > 1) return sub.blocks;
      try {
        const cellCount = Math.max(2, Math.round(efforts[i] / targetEffort));
        const cells = gridZones(b, cellCount);
        return cells.length > 1 ? cells : [b];
      } catch { return [b]; }
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "golf-course"`
Expected: PASS. Also re-run the pre-existing `'grid-subdivides an oversized block that has no internal streets to refine with'` test (no `terrainPolygons` passed at all, defaults to `[]`) to confirm it's unaffected: `npx vitest run test/zones/subdivider.test.js -t "grid-subdivides"` — PASS.

- [ ] **Step 5: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): split oversized blocks along terrain features, not a blind grid"
```

---

### Task 4: Wire terrain features through `SearchDetail.jsx`

**Files:**
- Modify: `command-center/src/search/SearchDetail.jsx:131-149`

**Interfaces:**
- Consumes: `fetchStreets(...)`'s `terrainPolygons`/`terrainPaths` fields (Task 2), `buildBlocks(...)`'s `terrainPolygons`/`terrainPaths` options (Task 3).
- Produces: nothing new for later tasks — this is the last Part A integration point.

There is no existing automated test coverage for `SearchDetail.jsx` (confirmed: no test file references it, no `SearchDetail.test.js` exists — this component's generation flow is verified manually via the dev server, consistent with how every other change to this flow in this codebase's history has been checked). This task is verified by full-suite re-run + a manual read, not a new test.

- [ ] **Step 1: Thread `terrainPolygons`/`terrainPaths` from fetch through to `buildBlocks`**

In `command-center/src/search/SearchDetail.jsx`, replace lines 131-136:

```jsx
          const { hardLines, softLines, allStreetLines } = await fetchStreets(t.feature, {
            detail: selectDetail(areaM2, estAlloc),
            onProgress: (done, total) => {
              if (total > 1) setGeneratingStatus(`Fetching map data…${label} tile ${Math.min(done + 1, total)}/${total}`);
            },
          });
```

with:

```jsx
          const { hardLines, softLines, allStreetLines, terrainPolygons, terrainPaths } = await fetchStreets(t.feature, {
            detail: selectDetail(areaM2, estAlloc),
            onProgress: (done, total) => {
              if (total > 1) setGeneratingStatus(`Fetching map data…${label} tile ${Math.min(done + 1, total)}/${total}`);
            },
          });
```

Replace lines 143-149:

```jsx
          const { blocks, adjacency } = buildBlocks(t.feature, hardLines, softLines, {
            maxBlockAreaM2,
            // blocks holding more than one zone's share of streets get locally
            // re-polygonized at full detail so dense areas can split
            refineStreets: allStreetLines,
            targetZoneCount: estAlloc,
          });
```

with:

```jsx
          const { blocks, adjacency } = buildBlocks(t.feature, hardLines, softLines, {
            maxBlockAreaM2,
            // blocks holding more than one zone's share of streets get locally
            // re-polygonized at full detail so dense areas can split
            refineStreets: allStreetLines,
            targetZoneCount: estAlloc,
            terrainPolygons,
            terrainPaths,
          });
```

- [ ] **Step 2: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all PASS (this file has no direct test coverage, but confirm nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add command-center/src/search/SearchDetail.jsx
git commit -m "feat(cc): wire terrain features from fetch into block generation"
```

Part A (feature-aware fetching) is now complete and shippable on its own.

---

### Task 5: Compactness metric + road-class-aware `sharedAdjacency`

**Files:**
- Modify: `command-center/src/zones/subdivider.js:64-69` (constants), `:147-169` (`sharedAdjacency`), `:345-353` (`buildBlocks` adjacency loop)
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: `line.properties.highway` set by Task 2's `classifyWays` change (this task's own tests construct lines with that property directly, no import coupling).
- Produces: `isoperimetricQuotient(poly) → number` (new export, used by Task 6). `sharedAdjacency`'s callers now get `{ hard, roadClass }` per edge — `buildBlocks`'s returned `adjacency` array entries gain a `roadClass` field (`string | null`) alongside the existing `hard` boolean, consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `command-center/test/zones/subdivider.test.js`, right after the `describe('buildBlocks', ...)` block closes (after line 204, before the `FOUR_BLOCKS`/`FOUR_ADJACENCY` fixtures):

```js
describe('isoperimetricQuotient', () => {
  it('scores a square higher than a thin sliver of similar area', () => {
    const squarish = turf.polygon([[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]);
    const sliver = turf.polygon([[[0, 0], [0.05, 0], [0.05, 0.0005], [0, 0.0005], [0, 0]]]);
    expect(isoperimetricQuotient(squarish)).toBeGreaterThan(isoperimetricQuotient(sliver));
    expect(isoperimetricQuotient(squarish)).toBeGreaterThan(0.7);
  });
});

describe('sharedAdjacency road class (via buildBlocks adjacency)', () => {
  it('reports the soft road class nearest a soft-adjacent border', () => {
    const classedSoft = [
      turf.lineString([[-0.01, 0.0015], [0.0015, 0.0015]], { highway: 'tertiary' }),
      turf.lineString([[0.0015, 0.0015], [0.013, 0.0015]], { highway: 'tertiary' }),
    ];
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, classedSoft);
    const softEdge = adjacency.find(a => a.hard === false);
    expect(softEdge.roadClass).toBe('tertiary');
  });

  it('reports a null road class when the fixture lines carry no highway property', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    const softEdge = adjacency.find(a => a.hard === false);
    expect(softEdge.roadClass).toBeNull();
  });

  it('reports a null road class on a hard-adjacent border (scored separately by the hard-road penalty)', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    const hardEdge = adjacency.find(a => a.hard === true);
    expect(hardEdge.roadClass).toBeNull();
  });
});
```

Update the import line at the top of the test file (line 3) to add `isoperimetricQuotient`:

```js
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones, computeBlockEfforts, OPEN_GROUND_M_PER_M2, isoperimetricQuotient } from '../../src/zones/subdivider.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "isoperimetricQuotient"`
Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "road class"`
Expected: FAIL — `isoperimetricQuotient` isn't exported yet; `adjacency` entries have no `roadClass` field (`undefined`, not `'tertiary'`/`null`).

- [ ] **Step 3: Implement — `isoperimetricQuotient`, `nearestRoadClass`, extend `sharedAdjacency`**

After the existing `meanWidthM` function and before `sharedBorderM` (around line 202), no — place these new helpers right after `sharedAdjacency` is defined is wrong since `sharedAdjacency` itself needs `nearestRoadClass`. Insert **before** `sharedAdjacency` (before line 147):

```js
const BOUNDARY_ROAD_MATCH_TOLERANCE_M = 15;
// Boundary-quality scoring (2026-07-19 spec, Part B): a shared border that
// lands on a real, sizeable road reads better to command than one that cuts
// through the middle of an ordinary block. secondary/tertiary score highest;
// residential/living_street/unclassified score low; no nearby road scores 0.
// Hard classes aren't listed here — a hard-adjacent border is scored by the
// separate hard-road-crossing penalty in refineZoneBoundaries (Task 6), not
// this table.
export const ROAD_CLASS_QUALITY = {
  secondary: 1.0,
  tertiary: 0.7,
  residential: 0.3,
  living_street: 0.3,
  unclassified: 0.2,
};

function nearestRoadClass(point, lines) {
  let best = null, bestD = Infinity;
  for (const line of lines) {
    let d;
    try { d = turf.pointToLineDistance(point, line, { units: 'meters' }); } catch { continue; }
    if (d < bestD) { bestD = d; best = line.properties?.highway ?? null; }
  }
  return bestD <= BOUNDARY_ROAD_MATCH_TOLERANCE_M ? best : null;
}
```

Replace `sharedAdjacency` (lines 147-169):

```js
function sharedAdjacency(polyA, polyB, hardLines) {
  let overlap;
  try {
    overlap = turf.lineOverlap(turf.polygonToLine(polyA), turf.polygonToLine(polyB), { tolerance: 0.003 });
  } catch { return null; }
  if (!overlap?.features?.length) return null;

  const totalLen = overlap.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0) * 1000;
  if (totalLen < MIN_SHARED_EDGE_M) return null;

  let longest = overlap.features[0], longestLen = 0;
  overlap.features.forEach(f => {
    const l = turf.length(f, { units: 'kilometers' });
    if (l > longestLen) { longestLen = l; longest = f; }
  });
  const mid = turf.along(longest, longestLen / 2, { units: 'kilometers' });

  let minD = Infinity;
  for (const h of hardLines) {
    try { minD = Math.min(minD, turf.pointToLineDistance(mid, h, { units: 'meters' })); } catch {}
  }
  return { hard: minD < HARD_BARRIER_TOLERANCE_M };
}
```

with:

```js
function sharedAdjacency(polyA, polyB, hardLines, softLines = []) {
  let overlap;
  try {
    overlap = turf.lineOverlap(turf.polygonToLine(polyA), turf.polygonToLine(polyB), { tolerance: 0.003 });
  } catch { return null; }
  if (!overlap?.features?.length) return null;

  const totalLen = overlap.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0) * 1000;
  if (totalLen < MIN_SHARED_EDGE_M) return null;

  let longest = overlap.features[0], longestLen = 0;
  overlap.features.forEach(f => {
    const l = turf.length(f, { units: 'kilometers' });
    if (l > longestLen) { longestLen = l; longest = f; }
  });
  const mid = turf.along(longest, longestLen / 2, { units: 'kilometers' });

  let minD = Infinity;
  for (const h of hardLines) {
    try { minD = Math.min(minD, turf.pointToLineDistance(mid, h, { units: 'meters' })); } catch {}
  }
  const hard = minD < HARD_BARRIER_TOLERANCE_M;
  return { hard, roadClass: hard ? null : nearestRoadClass(mid, softLines) };
}

// Isoperimetric quotient: 1.0 for a circle, lower for elongated/notched
// shapes. Used by refineZoneBoundaries (2026-07-19 spec, Part B, Task 6) to
// score whether a candidate move makes a zone's shape rounder or worse.
export function isoperimetricQuotient(poly) {
  const area = turf.area(poly);
  let perimM;
  try { perimM = turf.length(turf.polygonToLine(poly), { units: 'kilometers' }) * 1000; }
  catch { return 0; }
  return perimM > 0 ? (4 * Math.PI * area) / (perimM * perimM) : 0;
}
```

Update the adjacency-computation loop inside `buildBlocks` (around line 345-353) to pass `softLines` through:

```js
  const adjacency = [];
  if (!skipAdjacency) {
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const adj = sharedAdjacency(blocks[i], blocks[j], hardLines);
        if (adj) adjacency.push({ a: i, b: j, hard: adj.hard });
      }
    }
  }
```

becomes:

```js
  const adjacency = [];
  if (!skipAdjacency) {
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const adj = sharedAdjacency(blocks[i], blocks[j], hardLines, softLines);
        if (adj) adjacency.push({ a: i, b: j, hard: adj.hard, roadClass: adj.roadClass });
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "isoperimetricQuotient"`
Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "road class"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all PASS — the existing adjacency shape assertions (e.g. `expect(adjacency.some(a => a.hard === true)).toBe(true)`) only check the `hard` field and are unaffected by the new `roadClass` field being present alongside it.

- [ ] **Step 6: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): add isoperimetric compactness metric and road-class-aware adjacency"
```

---

### Task 6: `refineZoneBoundaries` — the scored boundary-refinement pass

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (new constants + new function, placed after `mergeBlocksToZones`'s existing runt-absorption code, before its polygon-flattening step — see Task 7 for exact insertion point; this task adds the function standalone and tests it directly, Task 7 wires the call site)
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: `isoperimetricQuotient` (Task 5), `safeUnion` (existing, line 224), region shape `{ blocks: number[], weight: number, areaM2: number, dead?: boolean }` (matches `mergeBlocksToZones`'s existing internal `regions` array exactly).
- Produces: `refineZoneBoundaries(regions, blocks, adjacency, weights) → void` (new export, mutates `regions` in place — same mutation style `mergeBlocksToZones`'s existing runt-absorption loop already uses on this same array). Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Add to `command-center/test/zones/subdivider.test.js`, right after the `describe('sharedAdjacency road class ...', ...)` block from Task 5:

```js
describe('refineZoneBoundaries', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('moves a block across a well-classed road when it improves balance (Vermont Ave scenario)', () => {
    // 2026-07-19 spec issue #5: "a zone border landed on an arbitrary
    // residential street one block off of Vermont Ave, when using Vermont as
    // the split point would have produced a more even division." Region A
    // starts with 3 blocks (weight 30) vs region B's 1 block (weight 10) — a
    // better-classed road sits between blocks 1 and 2, which would give a
    // perfectly even 20/20 split instead.
    const blocksArr = [SQX(0), SQX(1), SQX(2), SQX(3)];
    const adjacency = [
      { a: 0, b: 1, hard: false, roadClass: null },
      { a: 1, b: 2, hard: false, roadClass: 'tertiary' },
      { a: 2, b: 3, hard: false, roadClass: null },
    ];
    const weights = [10, 10, 10, 10];
    const regions = [
      { blocks: [0, 1, 2], weight: 30, areaM2: 3, dead: false },
      { blocks: [3], weight: 10, areaM2: 1, dead: false },
    ];
    refineZoneBoundaries(regions, blocksArr, adjacency, weights);
    const sorted = regions.map(r => [...r.blocks].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
    expect(sorted[0]).toEqual([0, 1]);
    expect(sorted[1]).toEqual([2, 3]);
  });

  it('rescues a hard-road-isolated compartment into a neighbor when the balance gain clearly outweighs the penalty (issue #3 / the zone-95 field case)', () => {
    // A single tiny block is walled off by a hard road, with a much larger
    // region on the other side as its only possible merge target. Confirmed
    // field bug (2026-07-20): the OLD binary "last resort" rule always merges
    // in this situation even when the isolated block is real, walkable
    // territory — producing a zone a searcher can't complete without crossing
    // an active freeway (zone 95 / San Diego Freeway in a real 143-zone
    // search). The continuous score must still allow a beneficial rescue like
    // this one — a 1-block region is far below any reasonable fair share.
    const blocksArr = [SQX(0), SQX(1), SQX(2)];
    const adjacency = [{ a: 0, b: 1, hard: true, roadClass: null }, { a: 1, b: 2, hard: false, roadClass: null }];
    const weights = [10, 40, 40];
    const regions = [
      { blocks: [0], weight: 10, areaM2: 1, dead: false },
      { blocks: [1, 2], weight: 80, areaM2: 2, dead: false },
    ];
    refineZoneBoundaries(regions, blocksArr, adjacency, weights);
    const nonEmpty = regions.filter(r => r.blocks.length);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0].blocks.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('does NOT merge an isolated hard-boxed compartment that is legitimately zone-worthy on its own', () => {
    // Same hard-road topology, but both sides are already at a comfortable,
    // roughly-equal size — merging would just make one zone twice the size of
    // the other for no real balance gain, so the hard-road penalty must win.
    const blocksArr = [SQX(0), SQX(1)];
    const adjacency = [{ a: 0, b: 1, hard: true, roadClass: null }];
    const weights = [40, 40];
    const regions = [
      { blocks: [0], weight: 40, areaM2: 1, dead: false },
      { blocks: [1], weight: 40, areaM2: 1, dead: false },
    ];
    refineZoneBoundaries(regions, blocksArr, adjacency, weights);
    expect(regions[0].blocks).toEqual([0]);
    expect(regions[1].blocks).toEqual([1]);
  });

  it('does nothing with fewer than 2 live regions', () => {
    const blocksArr = [SQX(0)];
    const regions = [{ blocks: [0], weight: 10, areaM2: 1, dead: false }];
    expect(() => refineZoneBoundaries(regions, blocksArr, [], [10])).not.toThrow();
    expect(regions[0].blocks).toEqual([0]);
  });
});
```

Update the import line (line 3) once more to add `refineZoneBoundaries`:

```js
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones, computeBlockEfforts, OPEN_GROUND_M_PER_M2, isoperimetricQuotient, refineZoneBoundaries } from '../../src/zones/subdivider.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "refineZoneBoundaries"`
Expected: FAIL — `refineZoneBoundaries` is not exported / not defined yet.

- [ ] **Step 3: Implement `refineZoneBoundaries`**

Add this after `sharedAdjacency`/`isoperimetricQuotient` (from Task 5) and before the `dissolveSlivers` function (before line ~248, i.e. anywhere after `safeUnion` is defined at line 224 and before `mergeBlocksToZones` at line 435 — placing it right after `isoperimetricQuotient` keeps compactness-related code together):

```js
// Scored boundary-refinement pass (2026-07-19 spec, Part B). Runs after
// growth + runt absorption produce `regions`, before they're flattened into
// final polygons. Unifies four issues that used to be four separate, cruder
// mechanisms: zero shape objective in growth (#2), the binary "last resort"
// hard-road absorption rule (#3), standing slivers with no graph-reachable
// neighbor (#4), and a greedy split that can't undo an early bad choice, e.g.
// landing one block off of a better arterial (#5, the Vermont Ave case).
//
// Field-confirmed need (2026-07-20): a real 143-zone search produced a zone
// that genuinely crosses the San Diego Freeway via the OLD rule's binary
// "absorb across a hard road as last resort" — a real, walkable pocket of
// streets got folded across an active freeway because it had no soft
// neighbor, without ever weighing whether that was actually a good idea.
const WEIGHT_BALANCE_SCORE_WEIGHT = 1;
const COMPACTNESS_SCORE_WEIGHT = 1;
const BOUNDARY_QUALITY_SCORE_WEIGHT = 1;
const HARD_ROAD_CROSSING_PENALTY = 3;
const MOVE_ACCEPTANCE_THRESHOLD = 0.05;
const MAX_MOVES_PER_BLOCK = 4;

function isConnected(blockIndices, allNeighbors) {
  if (blockIndices.length <= 1) return true;
  const set = new Set(blockIndices);
  const seen = new Set([blockIndices[0]]);
  const queue = [blockIndices[0]];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of allNeighbors[cur] ?? []) {
      if (set.has(nb) && !seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
  }
  return seen.size === blockIndices.length;
}

export function refineZoneBoundaries(regions, blocks, adjacency, weights) {
  const live = regions.filter(r => !r.dead);
  if (live.length < 2) return;

  const allNeighbors = blocks.map(() => []);
  for (const e of adjacency) { allNeighbors[e.a].push(e.b); allNeighbors[e.b].push(e.a); }

  const regionOf = new Array(blocks.length);
  live.forEach(r => r.blocks.forEach(b => { regionOf[b] = r; }));

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const maxMoves = blocks.length * MAX_MOVES_PER_BLOCK;
  let moves = 0;
  let improved = true;
  while (improved && moves < maxMoves) {
    improved = false;
    for (const e of adjacency) {
      const ra = regionOf[e.a], rb = regionOf[e.b];
      if (!ra || !rb || ra === rb || ra.dead || rb.dead) continue;

      for (const [moving, from, to] of [[e.a, ra, rb], [e.b, rb, ra]]) {
        const remaining = from.blocks.filter(b => b !== moving);
        if (remaining.length > 0 && !isConnected(remaining, allNeighbors)) continue;

        // Fair share is recomputed against how many LIVE regions would exist
        // after this move — a move that fully dissolves `from` (remaining
        // empty) reduces the effective zone count by one, same as the
        // existing runt-absorption logic already does elsewhere in this file.
        const liveCountBefore = regions.filter(r => !r.dead).length;
        const liveCountAfter = remaining.length > 0 ? liveCountBefore : liveCountBefore - 1;
        const fairShareBefore = totalWeight / liveCountBefore;
        const fairShareAfter = totalWeight / Math.max(1, liveCountAfter);

        const blockWeight = weights[moving];
        const weightDelta =
          (Math.abs(from.weight - fairShareBefore) + Math.abs(to.weight - fairShareBefore)) -
          ((remaining.length > 0 ? Math.abs(from.weight - blockWeight - fairShareAfter) : 0) +
            Math.abs(to.weight + blockWeight - fairShareAfter));

        let compactDelta;
        try {
          const fromPolyBefore = from.blocks.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[from.blocks[0]]);
          const toPolyBefore = to.blocks.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[to.blocks[0]]);
          const toPolyAfter = [...to.blocks, moving].slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[to.blocks[0]]);
          const compactBefore = isoperimetricQuotient(fromPolyBefore) + isoperimetricQuotient(toPolyBefore);
          const compactAfter = remaining.length > 0
            ? isoperimetricQuotient(remaining.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[remaining[0]])) + isoperimetricQuotient(toPolyAfter)
            : isoperimetricQuotient(toPolyAfter);
          compactDelta = (compactAfter - compactBefore) / 2;
        } catch { continue; }

        const boundaryQuality = e.hard ? 0 : (ROAD_CLASS_QUALITY[e.roadClass] ?? 0);
        const hardPenalty = e.hard ? HARD_ROAD_CROSSING_PENALTY : 0;

        const score =
          WEIGHT_BALANCE_SCORE_WEIGHT * weightDelta +
          COMPACTNESS_SCORE_WEIGHT * compactDelta +
          BOUNDARY_QUALITY_SCORE_WEIGHT * boundaryQuality -
          hardPenalty;

        if (score > MOVE_ACCEPTANCE_THRESHOLD) {
          from.blocks = remaining;
          from.weight -= blockWeight;
          to.blocks = [...to.blocks, moving];
          to.weight += blockWeight;
          regionOf[moving] = to;
          if (remaining.length === 0) from.dead = true;
          moves++;
          improved = true;
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "refineZoneBoundaries"`
Expected: PASS on all 4 new tests. If the Vermont-Ave test fails to converge to exactly `[0,1]`/`[2,3]`, add a temporary `console.log(regions)` after the `refineZoneBoundaries` call to inspect intermediate state, check the score sign for the `{a:2,b:3}` edge specifically (it should be strongly positive, ~20), and verify `MOVE_ACCEPTANCE_THRESHOLD` (0.05) isn't being cleared by a sign error in `weightDelta`.

- [ ] **Step 5: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all PASS (this function isn't wired into `mergeBlocksToZones` yet — Task 7 does that — so no other test can be affected yet).

- [ ] **Step 6: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): add refineZoneBoundaries scored boundary-refinement pass"
```

---

### Task 7: Wire `refineZoneBoundaries` into `mergeBlocksToZones`

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (the `mergeBlocksToZones` function, insertion point right before its polygon-flattening step)
- Test: `command-center/test/zones/subdivider.test.js` (regression pass — no new tests required by the spec beyond what Task 6 already added, since the mechanism itself is now fully tested; this task's job is to prove it doesn't break anything already passing)

**Interfaces:**
- Consumes: `refineZoneBoundaries` (Task 6).
- Produces: `mergeBlocksToZones`'s public return shape is unchanged (still an array of `Polygon` Features) — the new pass runs entirely inside, invisible to callers.

- [ ] **Step 1: Locate the insertion point and make the change**

In `command-center/src/zones/subdivider.js`, find the end of the runt-absorption `while (changed) { ... }` loop inside `mergeBlocksToZones` (it ends right before the comment `// A zone must be ONE contiguous polygon...` and the line `let polys = regions...`). Insert the call immediately after the runt-absorption loop closes and before `let polys = regions`:

```js
  let polys = regions
    .filter(r => !r.dead)
    .map(r => r.blocks.slice(1).reduce((poly, i) => safeUnion(poly, blocks[i]), blocks[r.blocks[0]]));
```

becomes:

```js
  refineZoneBoundaries(regions, blocks, adjacency, weights);

  let polys = regions
    .filter(r => !r.dead)
    .map(r => r.blocks.slice(1).reduce((poly, i) => safeUnion(poly, blocks[i]), blocks[r.blocks[0]]));
```

(`regions`, `blocks`, `adjacency`, and `weights` are all already in scope at this point in `mergeBlocksToZones` — no new parameters needed.)

- [ ] **Step 2: Run the full test suite**

Run: `cd command-center && npx vitest run`

Expected: all PASS. This is the highest-risk step in the plan — `refineZoneBoundaries` now runs on every existing `mergeBlocksToZones` test fixture, not just the three hand-built scenarios from Task 6. If any pre-existing test in the `mergeBlocksToZones` describe blocks (lines ~218-644) unexpectedly fails:

1. Read the failing test's assertion and the actual zones produced.
2. Determine whether `refineZoneBoundaries` found a move that genuinely improves the composite score but disagrees with what the test hard-codes as "correct" (in which case the test's fixture may need a `roadClass`/weight adjustment to remove an incidental tie, since these older fixtures were written before boundary-quality/compactness scoring existed and may contain an unintentional near-tie that the new scoring now breaks differently than growth alone did) — or a genuine bug in `refineZoneBoundaries` (e.g. a sign error, or a missed `dead` check).
3. If it's an incidental near-tie in an old fixture: adjust `MOVE_ACCEPTANCE_THRESHOLD` upward slightly (e.g. `0.05` → `0.5`) rather than changing the old test, and re-run the full suite again. Document the new value's justification in the constant's comment.
4. If it's a genuine bug in the new code: fix `refineZoneBoundaries` directly and re-run.

Do not proceed to Step 3 until `npx vitest run` is fully green.

- [ ] **Step 3: Manual sanity check — bounded move count on a large fixture**

Run this ad hoc check to confirm the move cap actually bounds runtime on a larger synthetic case (mirroring the real-world scale concern from the 2026-07-16 hang bug this file's history references):

```bash
cd command-center && node -e "
const { mergeBlocksToZones } = require('./src/zones/subdivider.js');
" 2>&1 || echo "(expected: this file is an ES module — use a quick vitest-based check instead, see below)"
```

Since `subdivider.js` is an ES module, add a temporary throwaway test instead (do not commit it — delete after checking):

```js
it.skip('TEMP: does not exceed the move cap on a 200-block chain', () => {
  const chain = Array.from({ length: 200 }, (_, x) => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]));
  const adj = Array.from({ length: 199 }, (_, i) => ({ a: i, b: i + 1, hard: false, roadClass: null }));
  const weights = Array.from({ length: 200 }, () => 10 + Math.random() * 5);
  const zones = mergeBlocksToZones(chain, adj, 20, { efforts: weights });
  expect(zones.length).toBeGreaterThan(0);
});
```

Temporarily change `it.skip` to `it`, run `npx vitest run test/zones/subdivider.test.js -t "TEMP"`, confirm it completes quickly (well under a second) and doesn't hang, then delete this test entirely (it used `Math.random`, which is fine for a throwaway manual check but must not be committed — this repo's tests are deterministic).

- [ ] **Step 4: Commit**

```bash
git add command-center/src/zones/subdivider.js
git commit -m "feat(cc): run boundary refinement after growth in mergeBlocksToZones"
```

Part B is now complete. The full zone-algorithm-quality spec is implemented.

---

### Task 8: Manual verification against real boundaries

**Files:** none (verification only, no code changes expected — if this task finds a real bug, fix it in the relevant file from Tasks 1-7 and re-run this task's checks)

This spec's own testing section calls for "a regression re-run against the real boundaries already used to validate prior fixes." Those boundaries aren't fixtured in the test suite (they're real GPS-drawn shapes in a live Command Center search) — verify via the dev server, which is how every prior fix in this pipeline's history was field-validated.

- [ ] **Step 1: Start the dev server**

```bash
cd command-center && npm run dev
```

Open `http://localhost:5173`, log in, open (or recreate) the real 143-zone West LA search (`Bind: Z5CJ`, or a similar Hollywood-to-Venice-scale boundary) that surfaced the field evidence in the spec.

- [ ] **Step 2: Regenerate zones and check for the specific confirmed issues**

Regenerate zones for that search (or a similarly-scaled fresh one). Using the same JS-console technique used to confirm the original findings (pull `window` → React fiber → Mapbox `zones` source `_data`, per the field-validation session), check:

- No zone polygon contains a full segment of a `motorway`-tagged way from the cached street tiles (the zone-95/405 case must not recur).
- Compactness (`4π·Area/Perimeter²`) across all zones should show noticeably fewer zones under 0.2 than the pre-fix baseline (zone 86 was 0.039; the fixed run should not reproduce anything that extreme without a genuine geometric reason).
- No standing sliver under ~1,000 m² unless it's genuinely isolated (no real touching neighbor at all).

- [ ] **Step 2: Confirm no hang or crash on the WeHo/Beverly Hills/Koreatown-style boundary**

Recreate (or reuse, if still present) the original 37-zone WeHo/Beverly Hills/Koreatown boundary from the 2026-07-16 review that first surfaced the golf-course and Vermont Ave issues. Generate zones, confirm:

- Generation completes without hanging (should be seconds, matching prior field tests' timings).
- The golf course area no longer shows a straight grid cut through it.
- Zero console errors during generation.

- [ ] **Step 3: Confirm no hang on the dense Westlake-style boundary**

Recreate (or reuse) the ~174-zone dense Westlake boundary referenced repeatedly in this file's history as the hang-prone case. Generate zones, confirm completion within a similar timeframe to before this plan's changes (no new hang introduced by `refineZoneBoundaries`'s move loop).

- [ ] **Step 4: Report findings**

If all three checks pass cleanly, this plan is done — no further action. If any check surfaces a new problem, note it precisely (which zone, which check, what was expected vs. observed) and treat it as a new bug to fix in the relevant task's code before considering this plan complete — do not ship with a known regression.

---

## Self-review notes (writing-plans skill's own checklist, already applied above)

- **Spec coverage:** Part A (issue #1) → Tasks 1-4. Part B (issues #2/#3/#4/#5, unified) → Tasks 5-7. Testing section's four bullet points → Task 3's golf-course test, Task 6's Vermont-Ave and hard-road-rescue tests, Task 8's real-boundary regression. Tunable constants section → all four introduced with the same names/framing (`ROAD_CLASS_QUALITY`, `HARD_ROAD_CROSSING_PENALTY`, `MOVE_ACCEPTANCE_THRESHOLD`, `MAX_MOVES_PER_BLOCK`). Out-of-scope items (LLM calls, multipolygon relations, manual override UI) — none of this plan's tasks touch them, confirmed.
- **Type consistency:** `terrainPolygons`/`terrainPaths` named identically across Tasks 2, 3, 4. `roadClass` named identically across Tasks 2 (implicit, via `properties.highway`), 5, 6. `refineZoneBoundaries(regions, blocks, adjacency, weights)` signature identical in Task 6's definition and Task 7's call site.
- **Placeholder scan:** no TBD/TODO; every step has real, complete code.
