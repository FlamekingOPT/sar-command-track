# Zone Generation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the letter-zone + sub-zone model with a single flat tier of numbered zones, generated from a real street-network graph so every zone edge sits on an actual street.

**Architecture:** `command-center/src/zones/subdivider.js` is rewritten around `turf.polygonize`: fetch the street graph for the drawn boundary plus a 300m margin, turn it into real city blocks, then greedily merge adjacent blocks (never across a hard-tier road) until the target zone count is reached. `SearchDetail.jsx` drives this with a search-time + walked/driven input instead of a raw zone count. Firestore zone docs drop `letter`; the search doc drops `letterZones` entirely.

**Tech Stack:** React 19, Vite, `@turf/turf` v6.5.0, Firebase/Firestore, Vitest.

## Global Constraints

- Test runner is Vitest: `cd command-center && npm test` runs `vitest run`. Run a single file with `npx vitest run test/zones/subdivider.test.js`.
- `@turf/turf` v6.5.0 here uses the **two-argument** form of `intersect`/`union` (`turf.intersect(a, b)`, not the newer FeatureCollection form) — confirmed against the installed package; using the FeatureCollection form throws.
- Telegram bot (`telegram-bot/`) is explicitly out of scope. It will be left referencing `letter` and will not function correctly after this plan ships — that's accepted (Jack, 2026-07-13).
- The web picker's assignment flow (`searcher-app/src/pick/`, `searcher-app/src/firebase/zoneRequests.js`) is also out of scope — it depends on the bot's Admin-SDK-only resolution path (confirmed against `firestore.rules`: `zoneRequests.update` and `searcherLinks` writes are blocked for unauthenticated clients) and needs new claim logic that belongs to a future spec, not a rename. Do not touch those files in this plan.
- No data migration — this is a test/demo environment with no production searches to preserve.
- Spec: `docs/superpowers/specs/2026-07-13-zone-generation-redesign-design.md`.

---

### Task 1: Sizing formula — `computeZoneCount`

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append to end)
- Test: `command-center/test/zones/subdivider.test.js` (append new `describe` block; existing `describe('subdivideZone', ...)` / `describe('subdivideWithBarriers', ...)` blocks stay untouched for now — they're deleted in Task 7 once nothing references the old functions)

**Interfaces:**
- Produces: `WALKED_RATE_M2_PER_MIN` (number), `DRIVEN_RATE_M2_PER_MIN` (number), `computeZoneCount(boundaryAreaM2: number, minutes: number, mode: 'walked' | 'driven') => number` (integer ≥ 1). Task 7 (`SearchDetail.jsx`) calls this directly.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { computeZoneCount, WALKED_RATE_M2_PER_MIN, DRIVEN_RATE_M2_PER_MIN } from '../../src/zones/subdivider.js';

describe('computeZoneCount', () => {
  it('exposes the validated per-minute coverage rates', () => {
    expect(WALKED_RATE_M2_PER_MIN).toBe(1609);
    expect(DRIVEN_RATE_M2_PER_MIN).toBe(10729);
  });

  it('divides boundary area by the walked rate for walked mode', () => {
    const boundaryArea = 30 * WALKED_RATE_M2_PER_MIN * 5; // exactly 5 zones' worth
    expect(computeZoneCount(boundaryArea, 30, 'walked')).toBe(5);
  });

  it('divides boundary area by the driven rate for driven mode', () => {
    const boundaryArea = 20 * DRIVEN_RATE_M2_PER_MIN * 3; // exactly 3 zones' worth
    expect(computeZoneCount(boundaryArea, 20, 'driven')).toBe(3);
  });

  it('rounds to the nearest whole zone', () => {
    // 30 * 1609 = 48270 m2 per zone; 3.4 zones' worth rounds to 3
    expect(computeZoneCount(48270 * 3.4, 30, 'walked')).toBe(3);
  });

  it('never returns less than 1 zone', () => {
    expect(computeZoneCount(10, 30, 'walked')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `computeZoneCount is not a function` (or similar import error)

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
// §1.3 of the design spec — one searcher walking a residential block (3 mph,
// 20m effective sweep width) vs. a vehicle slow-rolling residential streets
// (20 mph, 20m sweep width).
export const WALKED_RATE_M2_PER_MIN = 1609;
export const DRIVEN_RATE_M2_PER_MIN = 10729;

export function computeZoneCount(boundaryAreaM2, minutes, mode) {
  const rate = mode === 'driven' ? DRIVEN_RATE_M2_PER_MIN : WALKED_RATE_M2_PER_MIN;
  const targetAreaM2 = minutes * rate;
  return Math.max(1, Math.round(boundaryAreaM2 / targetAreaM2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS (5 new tests; old `subdivideZone`/`subdivideWithBarriers` tests still pass unchanged)

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): computeZoneCount sizing formula (search time + mode)"
```

---

### Task 2: `paddedBbox` helper

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append)
- Test: `command-center/test/zones/subdivider.test.js` (append)

**Interfaces:**
- Consumes: `@turf/turf` (`turf.bbox`, `turf.destination`) — already a dependency.
- Produces: `BOUNDARY_PAD_METERS` (number, 300), `paddedBbox(boundary: Feature<Polygon>, meters = BOUNDARY_PAD_METERS) => [west, south, east, north]`. Task 3 (`buildBlocks`) calls this.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { paddedBbox, BOUNDARY_PAD_METERS } from '../../src/zones/subdivider.js';

describe('paddedBbox', () => {
  const square = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  it('pads every side outward by ~BOUNDARY_PAD_METERS', () => {
    const [west, south, east, north] = turf.bbox(square);
    const [pWest, pSouth, pEast, pNorth] = paddedBbox(square);

    const westPad = turf.distance([west, south], [pWest, south], { units: 'kilometers' }) * 1000;
    const eastPad = turf.distance([east, south], [pEast, south], { units: 'kilometers' }) * 1000;
    const southPad = turf.distance([west, south], [west, pSouth], { units: 'kilometers' }) * 1000;
    const northPad = turf.distance([west, north], [west, pNorth], { units: 'kilometers' }) * 1000;

    for (const pad of [westPad, eastPad, southPad, northPad]) {
      expect(pad).toBeGreaterThan(BOUNDARY_PAD_METERS - 5);
      expect(pad).toBeLessThan(BOUNDARY_PAD_METERS + 5);
    }
  });

  it('accepts a custom pad distance', () => {
    const [west, south] = turf.bbox(square);
    const [pWest, pSouth] = paddedBbox(square, 100);
    const westPad = turf.distance([west, south], [pWest, south], { units: 'kilometers' }) * 1000;
    expect(westPad).toBeGreaterThan(95);
    expect(westPad).toBeLessThan(105);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `paddedBbox is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
export const BOUNDARY_PAD_METERS = 300;

// Blocks touching the real boundary's edge need their closing cross-street,
// which can sit just outside it — pad the fetch/polygonize area so that street
// is included, then clip back to the real boundary afterward (buildBlocks).
export function paddedBbox(boundary, meters = BOUNDARY_PAD_METERS) {
  const [west, south, east, north] = turf.bbox(boundary);
  const km = meters / 1000;
  const newWest = turf.destination([west, south], km, 270, { units: 'kilometers' }).geometry.coordinates[0];
  const newSouth = turf.destination([west, south], km, 180, { units: 'kilometers' }).geometry.coordinates[1];
  const newEast = turf.destination([east, north], km, 90, { units: 'kilometers' }).geometry.coordinates[0];
  const newNorth = turf.destination([east, north], km, 0, { units: 'kilometers' }).geometry.coordinates[1];
  return [newWest, newSouth, newEast, newNorth];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): paddedBbox helper for street-graph fetch margin"
```

---

### Task 3: `buildBlocks` — street graph to real city blocks

This is the core of the redesign. Read the spec's §1.2 steps 2–5 before implementing — the two subtleties below are easy to get wrong and were only caught by testing against a synthetic fixture:

1. `turf.polygonize` never auto-nodes a line endpoint that lands in the *middle* of another line. A clipped street's endpoint sits exactly on the padded bbox's edge, but a plain 4-corner `turf.bboxPolygon` ring has no vertex there, so the street silently fails to close against the ring. The ring must be built with a vertex at every point a clipped street touches it.
2. The `MAX_PLAUSIBLE_BLOCK_AREA_M2` sanity cap must be checked **after** clipping a face to the real boundary, not before — a face's pre-clip (padded) area is inflated by whatever pad it happens to include, and checking before clipping rejects legitimate blocks.

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append)
- Test: `command-center/test/zones/subdivider.test.js` (append)

**Interfaces:**
- Consumes: `paddedBbox` (Task 2).
- Produces: `HARD_HIGHWAYS` (string array), `buildBlocks(boundary: Feature<Polygon>, hardLines: Feature<LineString>[], softLines: Feature<LineString>[]) => { blocks: Feature<Polygon>[], adjacency: {a: number, b: number, hard: boolean}[] }`. `a`/`b` are indices into `blocks`. Task 4 (`mergeBlocksToZones`) consumes this return shape directly.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { buildBlocks, HARD_HIGHWAYS } from '../../src/zones/subdivider.js';

// A small 4-way intersection: one hard road (simulating a primary highway) running
// north-south, one soft road (a residential street) running east-west, meeting at
// the boundary's center. Streets must be pre-split at the crossing and must extend
// past the padded fetch area on both ends — turf.polygonize requires lines to share
// an exact vertex at every intersection (true of real OSM data; not true of two
// straight lines that only cross geometrically), and a line that dangles inside the
// padded area without reaching its edge can never close a face.
const GRID_BOUNDARY = turf.polygon([[[0, 0], [0.003, 0], [0.003, 0.003], [0, 0.003], [0, 0]]]);
const HARD_VERTICAL = [
  turf.lineString([[0.0015, -0.01], [0.0015, 0.0015]]),
  turf.lineString([[0.0015, 0.0015], [0.0015, 0.013]]),
];
const SOFT_HORIZONTAL = [
  turf.lineString([[-0.01, 0.0015], [0.0015, 0.0015]]),
  turf.lineString([[0.0015, 0.0015], [0.013, 0.0015]]),
];

describe('buildBlocks', () => {
  it('produces 4 quadrant blocks covering 100% of the boundary', () => {
    const { blocks } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(blocks).toHaveLength(4);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeLessThan(1.001);
  });

  it('classifies the shared border across the hard road as hard, and across the soft road as soft', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(adjacency.some(a => a.hard === true)).toBe(true);
    expect(adjacency.some(a => a.hard === false)).toBe(true);
  });

  it('returns a single block covering the whole boundary when no streets are given', () => {
    const { blocks } = buildBlocks(GRID_BOUNDARY, [], []);
    expect(blocks).toHaveLength(1);
    expect(turf.area(blocks[0]) / turf.area(GRID_BOUNDARY)).toBeCloseTo(1, 3);
  });

  it('does not throw on duplicate/near-duplicate hard lines (polygonize edge-ring regression)', () => {
    const nearDuplicate = turf.lineString(
      HARD_VERTICAL[0].geometry.coordinates.map(([x, y]) => [x + 1e-9, y])
    );
    expect(() =>
      buildBlocks(GRID_BOUNDARY, [...HARD_VERTICAL, nearDuplicate, HARD_VERTICAL[0]], SOFT_HORIZONTAL)
    ).not.toThrow();
  });

  it('HARD_HIGHWAYS covers motorway/trunk/primary only', () => {
    expect(HARD_HIGHWAYS).toEqual(['motorway', 'trunk', 'primary']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `buildBlocks is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
export const HARD_HIGHWAYS = ['motorway', 'trunk', 'primary'];
const MAX_PLAUSIBLE_BLOCK_AREA_M2 = 200000;
const HARD_BARRIER_TOLERANCE_M = 6;
const MIN_SHARED_EDGE_M = 3;
const MIN_EDGE_LENGTH_M = 1;
const SNAP_DECIMALS = 6;

function snapLine(line) {
  const seen = [];
  for (const [x, y] of line.geometry.coordinates) {
    const p = [Math.round(x * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS, Math.round(y * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS];
    if (!seen.length || seen[seen.length - 1][0] !== p[0] || seen[seen.length - 1][1] !== p[1]) seen.push(p);
  }
  return seen.length >= 2 ? turf.lineString(seen) : null;
}

function isDegenerate(line) {
  try { return turf.length(line, { units: 'kilometers' }) * 1000 < MIN_EDGE_LENGTH_M; }
  catch { return true; }
}

function clipToBbox(line, bbox) {
  let clipped;
  try { clipped = turf.bboxClip(line, bbox); } catch { return []; }
  if (!clipped.geometry.coordinates.length) return [];
  if (clipped.geometry.type === 'LineString') return clipped.geometry.coordinates.length >= 2 ? [clipped] : [];
  return clipped.geometry.coordinates.filter(c => c.length >= 2).map(c => turf.lineString(c));
}

function ringParam(bbox, [x, y]) {
  const [west, south, east, north] = bbox;
  const w = east - west, h = north - south, tol = 1e-7;
  if (Math.abs(y - south) < tol) return (x - west) / w;
  if (Math.abs(x - east) < tol) return 1 + (y - south) / h;
  if (Math.abs(y - north) < tol) return 2 + (east - x) / w;
  if (Math.abs(x - west) < tol) return 3 + (north - y) / h;
  return null;
}

// polygonize never auto-nodes a line endpoint that lands mid-edge on another
// line (a T-touch) — it only connects lines at coordinates they already share
// exactly. Build the ring's own vertex list from the 4 corners plus every point
// a clipped street touches, so the ring and the streets always share a real node.
function buildNodedRing(bbox, touchPoints) {
  const [west, south, east, north] = bbox;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  const withParams = [...corners, ...touchPoints]
    .map(p => ({ p, t: ringParam(bbox, p) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t);
  const ring = [];
  for (const { p } of withParams) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) ring.push(p);
  }
  ring.push(ring[0]);
  return turf.lineString(ring);
}

function buildEdgeSet(boundary, hardLines, softLines) {
  const bbox = paddedBbox(boundary);
  const clipped = [...hardLines, ...softLines].flatMap(l => clipToBbox(l, bbox));
  const touchPoints = clipped.flatMap(l => {
    const c = l.geometry.coordinates;
    return [c[0], c[c.length - 1]].filter(p => ringParam(bbox, p) !== null);
  });
  const paddedRing = buildNodedRing(bbox, touchPoints);
  let edges = [paddedRing, ...clipped].map(snapLine).filter(Boolean).filter(l => !isDegenerate(l));

  // drop exact-duplicate edges (same endpoints, either direction) — a duplicate
  // edge between the same two nodes produces a degenerate ring polygonize rejects
  const seenKeys = new Set();
  edges = edges.filter(l => {
    const c = l.geometry.coordinates;
    const a = c[0].join(','), b = c[c.length - 1].join(',');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  return { edges, bbox };
}

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

export function buildBlocks(boundary, hardLines, softLines) {
  const { edges, bbox } = buildEdgeSet(boundary, hardLines, softLines);
  const paddedBoundary = turf.bboxPolygon(bbox);
  const rawFaces = turf.polygonize(turf.featureCollection(edges));

  const blocks = rawFaces.features
    .filter(f => {
      try { return turf.booleanPointInPolygon(turf.centroid(f), paddedBoundary) && turf.area(f) > 0; }
      catch { return false; }
    })
    .map(f => { try { return turf.intersect(f, boundary); } catch { return null; } })
    // size cap applies AFTER clipping — see note above buildEdgeSet
    .filter(f => f && turf.area(f) > 1 && turf.area(f) < MAX_PLAUSIBLE_BLOCK_AREA_M2);

  const adjacency = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const adj = sharedAdjacency(blocks[i], blocks[j], hardLines);
      if (adj) adjacency.push({ a: i, b: j, hard: adj.hard });
    }
  }
  return { blocks, adjacency };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS (all 5 new tests, all previously-passing tests still pass)

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): buildBlocks — real city blocks from the street graph via polygonize"
```

---

### Task 4: `mergeBlocksToZones` — merge adjacent blocks to a target count

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append)
- Test: `command-center/test/zones/subdivider.test.js` (append)

**Interfaces:**
- Consumes: the exact `{ blocks, adjacency }` shape `buildBlocks` (Task 3) produces — but this task's own tests use hand-built fixtures, not `buildBlocks`, so it's reviewable independently.
- Produces: `mergeBlocksToZones(blocks: Feature<Polygon>[], adjacency: {a:number,b:number,hard:boolean}[], zoneCount: number) => Feature<Polygon>[]`. Task 5 (`generateZones`) composes this with `buildBlocks`.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { mergeBlocksToZones } from '../../src/zones/subdivider.js';

// Four unit squares in a 2x2 grid: [0][1] on top, [2][3] on bottom.
// 0-1 and 2-3 are horizontally adjacent (soft); 0-2 and 1-3 are vertically
// adjacent (hard) — mirrors a hard road running east-west through the middle.
const SQ = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
const FOUR_BLOCKS = [SQ(0, 1), SQ(1, 1), SQ(0, 0), SQ(1, 0)];
const FOUR_ADJACENCY = [
  { a: 0, b: 1, hard: false },
  { a: 2, b: 3, hard: false },
  { a: 0, b: 2, hard: true },
  { a: 1, b: 3, hard: true },
];

describe('mergeBlocksToZones', () => {
  it('returns blocks unchanged when zoneCount >= block count', () => {
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 4);
    expect(zones).toHaveLength(4);
  });

  it('merges the two soft-adjacent pairs down to 2 zones, never crossing the hard divide', () => {
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    expect(zones).toHaveLength(2);
    // each zone should span the full row (x: 0..2, 1 unit tall) — a row, not a column.
    // (turf.area returns real geodesic m2, not planar "2", so bbox shape is the
    // direct way to check this rather than an area magic number — caught when this
    // assertion actually failed during execution: the original literal-2 comparison
    // was wrong about what turf.area returns for degree-coordinate test fixtures.)
    for (const z of zones) {
      const [minX, minY, maxX, maxY] = turf.bbox(z);
      expect(maxX - minX).toBeCloseTo(2, 5);
      expect(maxY - minY).toBeCloseTo(1, 5);
    }
  });

  it('stops early rather than crossing a hard adjacency', () => {
    // asking for 1 zone is impossible without crossing the hard divide
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 1);
    expect(zones).toHaveLength(2);
  });

  it('covers the same total area as the input blocks', () => {
    const totalBefore = FOUR_BLOCKS.reduce((s, b) => s + turf.area(b), 0);
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    const totalAfter = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(totalAfter).toBeCloseTo(totalBefore, 5);
  });

  it('stops exactly at zoneCount on a long chain, not just when it runs out of soft edges', () => {
    // Regression for a real bug found while verifying this plan: tracking the
    // stop condition off the ever-growing clusters array (which never shrinks —
    // every merge appends a new entry rather than removing the two old ones)
    // instead of the live cluster count let a 6-block chain merge all the way
    // down to 1 zone when 2 were asked for, because "clusters.length > zoneCount"
    // stayed true long after only 2 zones actually remained.
    const chainBlocks = [0, 1, 2, 3, 4, 5].map(x =>
      turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]])
    );
    const chainAdjacency = [0, 1, 2, 3, 4].map(i => ({ a: i, b: i + 1, hard: false }));

    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 2)).toHaveLength(2);
    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 3)).toHaveLength(3);
    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 6)).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `mergeBlocksToZones is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
// Merge adjacent blocks smallest-combined-pair-first until zoneCount is reached.
// Adjacency is tracked by contraction: an edge between two ORIGINAL block indices
// becomes internal (skipped) once both indices map to the same current cluster —
// no re-computation of geometry/lineOverlap is needed after the initial adjacency
// from buildBlocks, since "hard" is a property of a specific real barrier segment
// and survives any merge on either side of it unchanged.
//
// The stop condition tracks the LIVE cluster count (new Set(owner).size), not
// clusters.length — clusters.length only ever grows (each merge appends a new
// entry rather than removing the two it replaces), so checking it against
// zoneCount stays true long after the real number of remaining zones has
// already hit the target, over-merging past it whenever a soft edge happens to
// still connect two live clusters (found via a 6-block chain regression test).
export function mergeBlocksToZones(blocks, adjacency, zoneCount) {
  let clusters = blocks.map(poly => ({ poly, area: turf.area(poly) }));
  let edges = adjacency.map(e => ({ ...e }));
  let owner = blocks.map((_, i) => i);

  while (new Set(owner).size > zoneCount) {
    let best = null;
    for (const e of edges) {
      if (e.hard) continue;
      const ci = owner[e.a], cj = owner[e.b];
      if (ci === cj) continue;
      const combined = clusters[ci].area + clusters[cj].area;
      if (!best || combined < best.combined) best = { ci, cj, combined };
    }
    if (!best) break; // no soft-mergeable pair left — stop early, more zones than requested

    const { ci, cj } = best;
    const merged = turf.union(clusters[ci].poly, clusters[cj].poly);
    const newIndex = clusters.length;
    clusters = [...clusters, { poly: merged, area: turf.area(merged) }];
    owner = owner.map(o => (o === ci || o === cj ? newIndex : o));
    edges = edges.filter(e => owner[e.a] !== owner[e.b]);
  }

  const liveClusterIndices = [...new Set(owner)];
  return liveClusterIndices.map(idx => clusters[idx].poly);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): mergeBlocksToZones — greedy adjacency merge to a target count"
```

---

### Task 5: `generateZones` — end-to-end composition

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append)
- Test: `command-center/test/zones/subdivider.test.js` (append)

**Interfaces:**
- Consumes: `buildBlocks` (Task 3), `mergeBlocksToZones` (Task 4).
- Produces: `generateZones(boundary: Feature<Polygon>, zoneCount: number, hardLines: Feature<LineString>[], softLines: Feature<LineString>[]) => Feature<Polygon>[]`. Task 7 (`SearchDetail.jsx`) calls this as the sole zone-generation entry point.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { generateZones } from '../../src/zones/subdivider.js';

describe('generateZones', () => {
  it('produces exactly zoneCount zones when the graph supports it', () => {
    const zones = generateZones(GRID_BOUNDARY, 4, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(4);
  });

  it('merges down to 2 zones split exactly along the hard road', () => {
    const zones = generateZones(GRID_BOUNDARY, 2, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(2);
    const centroidXs = zones.map(z => turf.centroid(z).geometry.coordinates[0]).sort((a, b) => a - b);
    expect(centroidXs[0]).toBeLessThan(0.0015);
    expect(centroidXs[1]).toBeGreaterThan(0.0015);
  });

  it('stops early at 2 zones when asked for 1 (would require crossing the hard road)', () => {
    const zones = generateZones(GRID_BOUNDARY, 1, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(2);
  });

  it('falls back to a single whole-boundary zone with no street data at all', () => {
    const zones = generateZones(GRID_BOUNDARY, 3, [], []);
    expect(zones).toHaveLength(1);
  });

  it('covers 100% of the boundary', () => {
    const zones = generateZones(GRID_BOUNDARY, 4, HARD_VERTICAL, SOFT_HORIZONTAL);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `generateZones is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
export function generateZones(boundary, zoneCount, hardLines, softLines) {
  const { blocks, adjacency } = buildBlocks(boundary, hardLines, softLines);
  if (!blocks.length) return [boundary];
  return mergeBlocksToZones(blocks, adjacency, zoneCount);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): generateZones — block-graph zone generation entry point"
```

---

### Task 6: `fetchStreetGraph` — Overpass fetch with hard/soft classification

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (append)
- Test: `command-center/test/zones/subdivider.test.js` (append)

**Interfaces:**
- Consumes: `paddedBbox` (Task 2), `HARD_HIGHWAYS` (Task 3), global `fetch`.
- Produces: `fetchStreetGraph(boundary: Feature<Polygon>) => Promise<{ hardLines: Feature<LineString>[], softLines: Feature<LineString>[] }>`. Task 7 (`SearchDetail.jsx`) awaits this before calling `generateZones`.

- [ ] **Step 1: Write the failing test**

Append to `command-center/test/zones/subdivider.test.js`:

```js
import { fetchStreetGraph } from '../../src/zones/subdivider.js';
import { vi, beforeEach, afterEach } from 'vitest';

describe('fetchStreetGraph', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: FAIL — `fetchStreetGraph is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `command-center/src/zones/subdivider.js`:

```js
export async function fetchStreetGraph(boundary) {
  const [west, south, east, north] = paddedBbox(boundary);
  const query = `[out:json][timeout:25];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query });
  const data = await resp.json();

  const hardLines = [];
  const softLines = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    const waterway = el.tags?.waterway;
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), { name: el.tags?.name ?? '' });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
}
```

Note: the test fixture includes a `footway` element to document that it's harmless if present (it isn't queried in practice, but the classifier doesn't special-case it — anything with neither a hard highway tag nor a waterway tag lands in `softLines`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): fetchStreetGraph — padded Overpass fetch with hard/soft classification"
```

---

### Task 7: Rewire `SearchDetail.jsx`, delete the old subdivider code

**Files:**
- Modify: `command-center/src/search/SearchDetail.jsx`
- Modify: `command-center/src/zones/subdivider.js` (delete dead code)
- Modify: `command-center/test/zones/subdivider.test.js` (delete dead tests)
- Modify: `command-center/src/firebase/searches.js` (delete `updateSearchLetterZones` call site — the function itself is removed in Task 10)

**Interfaces:**
- Consumes: `fetchStreetGraph`, `computeZoneCount`, `generateZones` (Tasks 1–6); `createZone` (changes shape in Task 10, but this task already calls it with the new shape).
- Produces: `SearchDetail` no longer renders a letter-zone draw mode or a raw zone-count input.

- [ ] **Step 1: Delete the old subdivider functions and their tests**

In `command-center/src/zones/subdivider.js`, delete these (now-superseded) exports and their internal helpers entirely: `fetchOSMBarriers`, `subdivideWithBarriers`, `subdivideZone`, `cutByBarrier`, `extendPastPolygon`, `mergeToN`, `stripSubdivide`, `lengthInsidePoly`. Nothing else in the codebase references them once Step 2 below lands (`SearchDetail.jsx` is their only consumer).

In `command-center/test/zones/subdivider.test.js`, delete the `describe('subdivideZone', ...)` and `describe('subdivideWithBarriers', ...)` blocks (and the now-unused `SQUARE` fixture at the top of the file, if nothing else in the file still uses it — `buildBlocks`'s `GRID_BOUNDARY` fixture is separate).

- [ ] **Step 2: Rewire `SearchDetail.jsx`**

Replace the full contents of `command-center/src/search/SearchDetail.jsx` with:

```jsx
import { useState, useEffect } from 'react';
import * as turf from '@turf/turf';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { fetchStreetGraph, computeZoneCount, generateZones } from '../zones/subdivider';
import { createZone, updateZoneStatus, watchZones } from '../firebase/zones';
import { updateSearchBoundary, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';

const DAY_ID = 'day-1';

export function SearchDetail({ searchId, volunteers, onBack, onLogout }) {
  const [searchName, setSearchName] = useState('');
  const [searchStatus, setSearchStatus] = useState('setup');
  const [drawMode, setDrawMode] = useState('idle');
  const [boundary, setBoundary] = useState(null);
  const [searchMinutes, setSearchMinutes] = useState(30);
  const [searchMode, setSearchMode] = useState('walked');
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [zones, setZones] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [liveMarkers, setLiveMarkers] = useState([]);

  useEffect(() => watchZones(searchId, DAY_ID, setZones), [searchId]);

  useEffect(() => {
    const stopTracks = watchTracks(searchId, DAY_ID, setTracks);
    const stopMarkers = watchMarkers(searchId, DAY_ID, setLiveMarkers);
    return () => { stopTracks(); stopMarkers(); };
  }, [searchId]);

  useEffect(() => {
    return watchSearch(searchId, search => {
      if (search.name) setSearchName(search.name);
      if (search.status) setSearchStatus(search.status);
      if (search.boundary) setBoundary(search.boundary);
    });
  }, [searchId]);

  const readOnly = searchStatus === 'complete';

  async function handleFeatureDrawn(feature) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      setBoundary(feature.geometry);
      await updateSearchBoundary(searchId, feature.geometry);
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }

  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };

      setGeneratingStatus('Fetching street network…');
      const { hardLines, softLines } = await fetchStreetGraph(boundaryFeature);

      setGeneratingStatus('Generating zones…');
      const zoneCount = computeZoneCount(turf.area(boundaryFeature), searchMinutes, searchMode);
      const zonePolygons = generateZones(boundaryFeature, zoneCount, hardLines, softLines);

      for (let i = 0; i < zonePolygons.length; i++) {
        await createZone(searchId, DAY_ID, { number: i + 1, polygon: zonePolygons[i].geometry });
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
    }
    setGeneratingStatus('');
    setGeneratingZones(false);
  }

  async function handleStatusChange(zoneId, status) {
    await updateZoneStatus(searchId, DAY_ID, zoneId, status);
  }

  async function handleComplete() {
    if (!window.confirm('Complete this search? Volunteers will no longer be able to sign up.')) return;
    await completeSearch(searchId);
    onBack();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Searches</button>
        <span style={{ fontWeight: 700, marginRight: 8 }}>{searchName || 'SAR Command'}</span>

        {/* Step 1: draw boundary */}
        {searchStatus === 'setup' && !boundary && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary' ? '✏ Drawing boundary… (double-click to finish)' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}

        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && zones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: Search time & mode</span>
            <input
              type="number" min={5} max={240} value={searchMinutes}
              onChange={e => setSearchMinutes(Number(e.target.value))}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <span style={{ fontSize: 13, opacity: 0.7 }}>min</span>
            <select
              value={searchMode} onChange={e => setSearchMode(e.target.value)}
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
          </>
        )}

        {/* Step 3: send out */}
        {searchStatus === 'setup' && zones.length > 0 && (
          <button
            onClick={async () => { await publishSearch(searchId); }}
            style={{ background: '#22c55e', padding: '4px 12px', fontWeight: 700 }}>
            Step 3: Send Out Search
          </button>
        )}

        {searchStatus === 'active' && (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>● ACTIVE</span>
            <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
              ■ Complete Search
            </button>
          </>
        )}

        {readOnly && (
          <span style={{ color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>VIEWING COMPLETED SEARCH — READ ONLY</span>
        )}

        <span style={{ flex: 1 }} />
        <button onClick={onLogout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <CommandMap
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundary={boundary}
          zones={zones}
          tracks={tracks}
          liveMarkers={liveMarkers}
        />
        <ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} readOnly={readOnly} />
      </div>
    </div>
  );
}
```

What changed vs. the original, and why:
- `handleFeatureDrawn` no longer takes a `type` param or branches on it — the only thing ever drawn now is the boundary (there's no letter-zone manual-draw mode left to distinguish from).
- `handleGenerateZones` fetches the street graph, computes the zone count from time+mode, calls `generateZones`, and creates each zone with `{ number, polygon }` — no per-letter loop, no `osmBarriers` state (the old barrier-visualization layer is removed along with it in Task 9).
- Step 2's UI asks for search time + mode instead of a raw zone count.
- `letterZones.length` checks become `zones.length` checks (Step 2/3 gating).
- `CommandMap` gets a single `zones` prop instead of `letterZones`/`subZones`/`osmBarriers`.

- [ ] **Step 3: Run the full command-center test suite**

Run: `cd command-center && npm test`
Expected: PASS — all `subdivider.test.js` tests (new ones from Tasks 1–6; old ones deleted in Step 1) pass. `SearchDetail.jsx` has no dedicated test file today, so this step is a regression check on `subdivider.js`, not new coverage for the component.

- [ ] **Step 4: Commit**

```bash
git add command-center/src/search/SearchDetail.jsx command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): wire SearchDetail to block-graph generation, drop letter-zone flow"
```

---

### Task 8: `ZonePanel.jsx` — flat zone list

**Files:**
- Modify: `command-center/src/ui/ZonePanel.jsx`

**Interfaces:**
- Consumes: `zones` prop — each zone now has `{ id, number, polygon, status, assignedTo }` (no `letter`).

- [ ] **Step 1: Replace the file**

Replace the full contents of `command-center/src/ui/ZonePanel.jsx` with:

```jsx
import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned', 'assigned', 'in_progress', 'searched', 'needs_re_search'];

export function ZonePanel({ zones, volunteers = {}, onStatusChange, readOnly = false }) {
  const sorted = [...zones].sort((a, b) => a.number - b.number);

  return (
    <div style={{ width: 280, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
      )}
      {sorted.map(zone => (
        <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontWeight: 700, minWidth: 28 }}>{zone.number}</span>
          <span style={{ flex: 1, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {zone.assignedTo ? (volunteers[zone.assignedTo] ?? zone.assignedTo) : '—'}
          </span>
          <StatusPill status={zone.status} />
          {!readOnly && (
            <select value={zone.status} onChange={e => onStatusChange(zone.id, e.target.value)}
              style={{ fontSize: 11, padding: '1px 4px' }}>
              {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Run the test suite (no dedicated ZonePanel tests exist; this is a build/regression check)**

Run: `cd command-center && npm run build`
Expected: build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add command-center/src/ui/ZonePanel.jsx
git commit -m "feat(cc): ZonePanel renders a flat numbered zone list"
```

---

### Task 9: `CommandMap.jsx` — flat zones layer

**Files:**
- Modify: `command-center/src/map/CommandMap.jsx`

**Interfaces:**
- Consumes: single `zones` prop (replaces `letterZones`/`subZones`/`osmBarriers`) — each zone is `{ id, number, polygon, status }`, `polygon` a GeoJSON geometry.

- [ ] **Step 1: Replace the file**

Replace the full contents of `command-center/src/map/CommandMap.jsx` with:

```jsx
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const STATUS_COLORS = {
  unassigned: '#9ca3af', assigned: '#3b82f6',
  in_progress: '#f59e0b', searched: '#22c55e', needs_re_search: '#ef4444',
};

export function CommandMap({ drawMode, onFeatureDrawn, boundary = null, zones = [], tracks = [], liveMarkers = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);
  const onFeatureDrawnRef = useRef(onFeatureDrawn);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { onFeatureDrawnRef.current = onFeatureDrawn; }, [onFeatureDrawn]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-118.25, 34.05],
      zoom: 11,
    });
    const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true } });
    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('boundary', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-dasharray': [4, 2] } });

      map.addSource('zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#374151', 'line-width': 1.5 } });
      map.addLayer({ id: 'zones-labels', type: 'symbol', source: 'zones',
        layout: {
          'text-field': ['get', 'number'],
          'text-size': 16,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

      map.addSource('tracks', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks',
        paint: { 'line-color': '#16a34a', 'line-width': 3, 'line-opacity': 0.9 } });

      map.addSource('searcher-positions', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'searcher-positions-dot', type: 'circle', source: 'searcher-positions',
        paint: { 'circle-radius': 7, 'circle-color': '#16a34a', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });

      map.addSource('live-markers', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'live-markers-dot', type: 'circle', source: 'live-markers',
        paint: { 'circle-radius': 8, 'circle-color': '#ef4444', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      map.addLayer({ id: 'live-markers-labels', type: 'symbol', source: 'live-markers',
        layout: {
          'text-field': ['get', 'note'],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
        },
        paint: { 'text-color': '#991b1b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    });

    map.on('draw.create', e => {
      onFeatureDrawnRef.current?.(e.features[0]);
      draw.deleteAll();
    });

    mapRef.current = map;
    drawRef.current = draw;
    return () => map.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.changeMode(drawMode === 'idle' ? 'simple_select' : 'draw_polygon');
  }, [drawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('boundary')?.setData(
      boundary
        ? turf.featureCollection([{ type: 'Feature', geometry: boundary, properties: {} }])
        : turf.featureCollection([])
    );
  }, [boundary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('zones')?.setData(
      turf.featureCollection(zones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { number: z.number, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
  }, [zones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const lines = tracks
      .filter(t => t.points?.length >= 2)
      .map(t => turf.lineString(t.points.map(p => [p.lng, p.lat]), { volunteerId: t.volunteerId }));
    map.getSource('tracks')?.setData(turf.featureCollection(lines));
    const positions = tracks
      .filter(t => t.points?.length >= 1)
      .map(t => turf.point(
        [t.points[t.points.length - 1].lng, t.points[t.points.length - 1].lat],
        { volunteerId: t.volunteerId }
      ));
    map.getSource('searcher-positions')?.setData(turf.featureCollection(positions));
  }, [tracks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('live-markers')?.setData(
      turf.featureCollection(liveMarkers.map(m => turf.point([m.lng, m.lat], { note: m.note ?? '' })))
    );
  }, [liveMarkers]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
}
```

What changed vs. the original: `letter-zones-*` and `sub-zones-*` layers collapse into one `zones-*` set (fill/line/label), keyed by `number` instead of `letter`. The `osm-barriers`/`osm-roads`/`osm-waterways` source and layers are removed — that was a debug visualization of `fetchOSMBarriers`'s flat barrier list, which no longer exists in this shape (`fetchStreetGraph` returns two separate `hardLines`/`softLines` arrays); nothing in the spec calls for preserving it, so it's dropped rather than reshaped for a feature nobody asked for. `draw.create`'s handler no longer picks a `type` — there's only one thing left to draw (the boundary).

- [ ] **Step 2: Build check**

Run: `cd command-center && npm run build`
Expected: build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add command-center/src/map/CommandMap.jsx
git commit -m "feat(cc): CommandMap renders one flat numbered zones layer"
```

---

### Task 10: Firestore schema — drop `letter`/`letterZones`

**Files:**
- Modify: `command-center/src/firebase/zones.js`
- Modify: `command-center/src/firebase/searches.js`

**Interfaces:**
- Produces: `createZone(searchId, dayId, { number, polygon }) => Promise<string>` (was `{ letter, number, polygon }`).

- [ ] **Step 1: Update `firebase/zones.js`**

Replace the full contents of `command-center/src/firebase/zones.js` with:

```js
import { collection, doc, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const zonesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'zones');

export async function createZone(searchId, dayId, { number, polygon }) {
  const ref = doc(zonesCol(searchId, dayId));
  await setDoc(ref, {
    number,
    polygon: JSON.stringify(polygon),
    status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateZoneStatus(searchId, dayId, zoneId, status) {
  await updateDoc(doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId), { status });
}

export function watchZones(searchId, dayId, cb) {
  return onSnapshot(zonesCol(searchId, dayId), snap =>
    cb(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        polygon: data.polygon ? JSON.parse(data.polygon) : null,
      };
    }))
  );
}
```

(Only the `createZone` signature and its `setDoc` payload changed — `letter` is gone.)

- [ ] **Step 2: Update `firebase/searches.js`**

Replace the full contents of `command-center/src/firebase/searches.js` with:

```js
import { collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';
import { generateSearchCode } from '../search/searchCode';

export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundary: null,
    code: generateSearchCode(),
  });
  return { id: ref.id };
}

export async function updateSearchBoundary(searchId, boundary) {
  await updateDoc(doc(db, 'searches', searchId), { boundary: JSON.stringify(boundary) });
}

export async function publishSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'active' });
}

export async function completeSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'complete' });
}

export function watchSearches(cb) {
  return onSnapshot(collection(db, 'searches'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function watchSearch(searchId, cb) {
  return onSnapshot(doc(db, 'searches', searchId), snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    cb({
      id: snap.id,
      ...data,
      boundary: data.boundary ? JSON.parse(data.boundary) : null,
    });
  });
}
```

(`letterZones: []` dropped from `createSearch`'s initial doc; `updateSearchLetterZones` removed entirely — Task 7 already stopped calling it; `watchSearch` no longer parses `letterZones`.)

- [ ] **Step 3: Run the full test suite**

Run: `cd command-center && npm test && npm run build`
Expected: all tests PASS, build succeeds

- [ ] **Step 4: Commit**

```bash
git add command-center/src/firebase/zones.js command-center/src/firebase/searches.js
git commit -m "feat(cc): drop letter/letterZones from the Firestore zone and search schema"
```

---

### Task 11: `searcher-app` — fix the assigned-zone label

**Files:**
- Modify: `searcher-app/src/App.jsx:99`

This is the one searcher-app change in scope for this plan (see Global Constraints — the picker itself is explicitly not touched). This line is what a searcher sees on their own device *after* they're already assigned to a zone (via whatever mechanism assigned them); it just needs to read the new flat `number` field instead of `letter`+`number`.

**Interfaces:**
- Consumes: `zone.number` (the zone doc a searcher is assigned to already has this field, per Task 10's schema — no other searcher-app file needs to change for this label fix).

- [ ] **Step 1: Update the label**

In `searcher-app/src/App.jsx`, change line 99 from:

```jsx
        Zone {zone.letter}{zone.number}
```

to:

```jsx
        Zone {zone.number}
```

- [ ] **Step 2: Run the searcher-app test suite**

Run: `cd searcher-app && npm test`
Expected: PASS (this line has no dedicated test; this is a regression check that nothing else broke)

- [ ] **Step 3: Commit**

```bash
git add searcher-app/src/App.jsx
git commit -m "fix(searcher): label an assigned zone by number only, letters are gone"
```

---

## Self-Review Notes

- **Spec coverage:** §1.1 (barrier tiers) → Task 3 (`HARD_HIGHWAYS`). §1.2 steps 1–6 → Tasks 2–5 (`paddedBbox`, `buildBlocks`, `mergeBlocksToZones`, `generateZones`). §1.3 (sizing) → Task 1. §2 (data model) → Task 10. §3 command-center changes → Tasks 7–10 (subdivider.js, SearchDetail.jsx, ZonePanel.jsx, CommandMap.jsx, firebase/*). §3 searcher-app changes → intentionally narrowed to just the label fix (Task 11) per the mid-planning finding that the picker can't be fixed by a rename alone; §4 testing → covered inline per-task rather than as a separate task, matching how Task 3/5's tests already exercise coverage/hard-crossing/early-stop/degenerate-edge behavior the spec's §4 calls for.
- **Placeholder scan:** none found — every step has complete, verified code. The block-graph algorithm in Tasks 3–5 was run end-to-end against synthetic fixtures before being written here; four real bugs it caught are reflected in the code and its comments: `polygonize` never auto-nodes a street touching the boundary ring mid-edge (Task 3, `buildNodedRing`), the size cap must apply after clipping to the real boundary rather than before (Task 3, also a spec correction commit), the merge loop's stop condition must track live cluster count rather than the ever-growing clusters array or it silently over-merges past the target on a long chain (Task 4, caught by the added 6-block chain test), and an initial test-fixture assertion for `fetchStreetGraph` undercounted `softLines` by not accounting for the untagged `footway` fixture element landing there too (Task 6).
- **Type consistency:** `buildBlocks`'s `{ blocks, adjacency }` shape (Task 3) matches what `mergeBlocksToZones` (Task 4) and `generateZones` (Task 5) destructure. `createZone`'s `{ number, polygon }` (Task 10) matches what `SearchDetail.jsx` (Task 7) passes. `zone.number` is used consistently across `ZonePanel.jsx`, `CommandMap.jsx`, and `App.jsx`.
