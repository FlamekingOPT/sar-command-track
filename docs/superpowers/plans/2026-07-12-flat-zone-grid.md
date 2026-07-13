# Flat Numbered Zone Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the letter+subzone zone hierarchy with one flat pool of numbered zones, sized by a Small/Medium/Large target-size preset instead of a manual count, with four algorithm fixes (compact grid fallback, freeway segment-dissolving, balance-aware merge, wider road data) and a searcher-driven re-pick flow on zone completion instead of dynamic re-slicing.

**Architecture:** All shape-generation logic lives in `command-center/src/zones/subdivider.js` behind one new async entry point (`generateZones`). Command Center, the searcher-app picker, and the Telegram bot each get the minimal change needed to work with flat `{number, polygon, status, assignedTo}` zone docs instead of `{letter, number, ...}`. No new dependencies — `turf.squareGrid`/`turf.intersect`/`turf.union`/`turf.difference` are already available via the existing `@turf/turf` v6.5.0 dependency.

**Tech Stack:** React + Vite (command-center, searcher-app), `@turf/turf` v6.5.0, Firestore (client SDK, no Admin SDK changes), Telegraf (telegram-bot), Vitest for unit tests.

## Global Constraints

- No new npm dependencies in any package.
- `@turf/turf` is v6.5.0 — `turf.union`/`turf.intersect`/`turf.difference` each take exactly **two** feature arguments (not variadic, not a FeatureCollection) — reduce pairwise when combining more than two.
- `DAY_ID = 'day-1'` stays a hardcoded constant everywhere it already is (unrelated to this change; do not touch).
- Firestore rules: no changes needed for this plan — the zone-claim/status rules already in `firestore.rules` operate on `status`/`assignedTo` only and don't reference `letter`.
- Existing test convention in this repo (confirmed via `docs/superpowers/plans/2026-07-03-sar-cc-home-dashboard.md` and this repo's actual test layout): pure logic gets Vitest unit tests; Firebase/DOM-heavy React components get manual verification instead of fabricated tests. Follow this split — do not invent component tests where the codebase convention doesn't have them.
- Run tests with `npm test` (= `vitest run`) from inside the relevant package directory (`command-center/`, `searcher-app/`, or `telegram-bot/`).

---

### Task 1: `gridSubdivide` — compact grid partition (new)

**Files:**
- Modify: `command-center/src/zones/subdivider.js`
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Produces: `export function gridSubdivide(polygon, n)` — takes a turf `Feature<Polygon>` and a target count, returns an array of `Feature<Polygon|MultiPolygon>` whose union covers the input polygon (100% coverage guaranteed), length `n` (or as close as geometrically possible), no piece under ~15% of the target per-piece area.
- Also produces two internal (non-exported) helpers used only within this file, needed by later tasks: `mergeSlivers(cells, targetCellArea, minFraction)` and `reclaimLeftover(cells, polygon)`.

This task adds `gridSubdivide` as new code alongside the existing `stripSubdivide` (which Task 4 removes) — it does not yet wire `gridSubdivide` into `subdivideWithBarriers`'s fallback paths (Task 4 does that swap), so this task is purely additive and testable in isolation.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `command-center/test/zones/subdivider.test.js` (new `describe` block, keep the existing `subdivideZone`/`subdivideWithBarriers` blocks untouched for now):

```js
import { gridSubdivide } from '../../src/zones/subdivider.js';

const IRREGULAR = turf.polygon([[
  [-118.30, 34.02], [-118.25, 34.10], [-118.15, 34.12], [-118.10, 34.05],
  [-118.18, 34.00], [-118.30, 34.02],
]]);

describe('gridSubdivide', () => {
  it('returns the original polygon unchanged when n <= 1', () => {
    const result = gridSubdivide(SQUARE, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(SQUARE);
  });

  it('produces exactly n cells for a simple square', () => {
    const result = gridSubdivide(SQUARE, 4);
    expect(result).toHaveLength(4);
  });

  it('covers ~100% of the original area (never drops a sliver)', () => {
    const result = gridSubdivide(SQUARE, 4);
    const subArea = result.reduce((sum, z) => sum + turf.area(z), 0);
    expect(subArea / turf.area(SQUARE)).toBeGreaterThan(0.99);
  });

  it('covers ~100% of an irregular/concave polygon too', () => {
    const result = gridSubdivide(IRREGULAR, 7);
    expect(result).toHaveLength(7);
    const subArea = result.reduce((sum, z) => sum + turf.area(z), 0);
    expect(subArea / turf.area(IRREGULAR)).toBeGreaterThan(0.99);
  });

  it('never leaves a cell under 15% of the target per-cell area (no orphaned slivers)', () => {
    const result = gridSubdivide(IRREGULAR, 10);
    const target = turf.area(IRREGULAR) / 10;
    for (const cell of result) {
      expect(turf.area(cell)).toBeGreaterThanOrEqual(target * 0.15);
    }
  });

  it('all cell centroids are inside the original polygon', () => {
    for (const cell of gridSubdivide(SQUARE, 6)) {
      expect(turf.booleanPointInPolygon(turf.centroid(cell), SQUARE)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd command-center && npm test -- subdivider` (from repo root)
Expected: FAIL — `gridSubdivide is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Implement `gridSubdivide` and its helpers**

Add to `command-center/src/zones/subdivider.js`, near the bottom with the other internal helpers (after `mergeToN`, before `stripSubdivide` — exact position doesn't matter, this is additive):

```js
// Compact grid partition — lays a square grid sized to the target per-zone
// area over the polygon's bbox, clips to the polygon, merges slivers into
// their nearest neighbor (never dropped), and reclaims any leftover area a
// degenerate clip missed. Guaranteed full coverage, never a bbox-spanning
// strip (unlike stripSubdivide).
export function gridSubdivide(polygon, n) {
  if (n <= 1) return [polygon];

  const totalArea = turf.area(polygon); // m²
  const targetCellArea = totalArea / n;
  const cellSideKm = Math.sqrt(targetCellArea) / 1000;
  const bbox = turf.bbox(polygon);

  const grid = turf.squareGrid(bbox, cellSideKm, { units: 'kilometers' });
  let cells = grid.features
    .map(cell => { try { return turf.intersect(cell, polygon); } catch { return null; } })
    .filter(Boolean);

  if (!cells.length) return [polygon]; // degenerate bbox/polygon — bail to whole shape

  cells = mergeSlivers(cells, targetCellArea);
  cells = reclaimLeftover(cells, polygon);

  if (cells.length > n) cells = mergeSmallestIntoNeighbor(cells, n);
  while (cells.length < n && cells.length > 0) {
    const maxIdx = cells.reduce((mi, c, i) => turf.area(c) > turf.area(cells[mi]) ? i : mi, 0);
    const halves = gridSubdivide(cells[maxIdx], 2);
    cells = [...cells.slice(0, maxIdx), ...halves, ...cells.slice(maxIdx + 1)];
  }

  return cells;
}

// Merge any cell under 15% of the target cell area into its nearest-centroid
// neighbor — never leave an orphaned sliver as its own zone.
function mergeSlivers(cells, targetCellArea, minFraction = 0.15) {
  let current = [...cells];
  let sliverIdx = current.findIndex(c => turf.area(c) < targetCellArea * minFraction);
  while (sliverIdx !== -1 && current.length > 1) {
    const sliverCentroid = turf.centroid(current[sliverIdx]).geometry.coordinates;
    let nearestIdx = -1, minDist = Infinity;
    current.forEach((c, i) => {
      if (i === sliverIdx) return;
      const cc = turf.centroid(c).geometry.coordinates;
      const d = (cc[0] - sliverCentroid[0]) ** 2 + (cc[1] - sliverCentroid[1]) ** 2;
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });
    if (nearestIdx === -1) break;

    try {
      const merged = turf.union(current[sliverIdx], current[nearestIdx]);
      current = current.filter((_, i) => i !== sliverIdx && i !== nearestIdx);
      if (merged) current.push(merged);
    } catch {
      current = current.filter((_, i) => i !== sliverIdx);
    }
    sliverIdx = current.findIndex(c => turf.area(c) < targetCellArea * minFraction);
  }
  return current;
}

// Union all cells and diff against the original polygon — any leftover area
// (degenerate clip failures, floating-point gaps) gets folded into the
// nearest cell so coverage is always ~100%, never silently dropped.
// turf.union (v6) takes exactly 2 features — reduce pairwise, don't spread.
function reclaimLeftover(cells, polygon) {
  if (!cells.length) return cells;
  try {
    const covered = cells.reduce((acc, c) => acc ? turf.union(acc, c) : c, null);
    if (!covered) return cells;
    const leftover = turf.difference(polygon, covered);
    if (!leftover) return cells;

    const leftoverCentroid = turf.centroid(leftover).geometry.coordinates;
    let nearestIdx = 0, minDist = Infinity;
    cells.forEach((c, i) => {
      const cc = turf.centroid(c).geometry.coordinates;
      const d = (cc[0] - leftoverCentroid[0]) ** 2 + (cc[1] - leftoverCentroid[1]) ** 2;
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });

    const merged = turf.union(cells[nearestIdx], leftover);
    if (!merged) return cells;
    return cells.map((c, i) => i === nearestIdx ? merged : c);
  } catch {
    return cells; // best-effort — a failed reclaim still leaves valid (if slightly short) coverage
  }
}
```

This step references `mergeSmallestIntoNeighbor`, which Task 3 creates. For this task only, temporarily add this minimal version right above `gridSubdivide` (Task 3 will replace it with the real implementation and its own tests — this stub keeps Task 1 self-contained and its tests green):

```js
function mergeSmallestIntoNeighbor(zones, n) {
  let current = [...zones];
  while (current.length > n) {
    const centroids = current.map(z => turf.centroid(z).geometry.coordinates);
    let minDist = Infinity, mi = 0, mj = 1;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const dx = centroids[i][0] - centroids[j][0];
        const dy = centroids[i][1] - centroids[j][1];
        const d = dx * dx + dy * dy;
        if (d < minDist) { minDist = d; mi = i; mj = j; }
      }
    }
    try {
      const merged = turf.union(current[mi], current[mj]);
      current = current.filter((_, i) => i !== mi && i !== mj);
      if (merged) current.push(merged);
    } catch {
      current = current.filter((_, i) => i !== mj);
    }
  }
  return current;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd command-center && npm test -- subdivider`
Expected: PASS — all 6 new `gridSubdivide` tests green, existing `subdivideZone`/`subdivideWithBarriers` tests still green (untouched).

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): add gridSubdivide compact grid partition with sliver-merge and leftover-reclaim"
```

---

### Task 2: Segment-dissolving in `fetchOSMBarriers` (fixes the freeway-straddling bug)

**Files:**
- Modify: `command-center/src/zones/subdivider.js`
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function dissolveBarriers(lines, toleranceKm = 0.005)` — pure function, takes an array of turf `Feature<LineString>` (each with `properties.name`, possibly empty string) and returns a new array where lines sharing a non-empty `name` and touching within `toleranceKm` are chained into single longer `LineString`s. Unnamed lines pass through unchanged, one-per-input. Called internally by `fetchOSMBarriers` (this task also updates `fetchOSMBarriers`'s Overpass query and adds the `dissolveBarriers` call), but `dissolveBarriers` itself takes pre-built turf lines, not raw OSM JSON — this keeps it unit-testable without mocking `fetch`.

- [ ] **Step 1: Write the failing tests**

Add to `command-center/test/zones/subdivider.test.js`:

```js
import { dissolveBarriers } from '../../src/zones/subdivider.js';

describe('dissolveBarriers', () => {
  it('chains same-named touching segments (given out of order) into one continuous line', () => {
    const seg1 = turf.lineString([[-118.30, 34.05], [-118.28, 34.052]], { name: 'I-10' });
    const seg2 = turf.lineString([[-118.28, 34.052], [-118.26, 34.054]], { name: 'I-10' });
    const seg3 = turf.lineString([[-118.26, 34.054], [-118.24, 34.056]], { name: 'I-10' });

    const result = dissolveBarriers([seg2, seg1, seg3]); // deliberately out of order
    expect(result).toHaveLength(1);
    expect(result[0].properties.name).toBe('I-10');
    expect(result[0].geometry.coordinates).toHaveLength(4);
  });

  it('leaves differently-named segments separate', () => {
    const a = turf.lineString([[-118.30, 34.05], [-118.28, 34.052]], { name: 'I-10' });
    const b = turf.lineString([[-118.20, 34.00], [-118.19, 34.01]], { name: 'Main St' });
    const result = dissolveBarriers([a, b]);
    expect(result).toHaveLength(2);
  });

  it('leaves unnamed segments as individual lines, one per input', () => {
    const a = turf.lineString([[-118.30, 34.05], [-118.28, 34.052]], { name: '' });
    const b = turf.lineString([[-118.28, 34.052], [-118.26, 34.054]], { name: '' });
    const result = dissolveBarriers([a, b]);
    expect(result).toHaveLength(2);
  });

  it('does not chain segments that are far apart even with the same name', () => {
    const a = turf.lineString([[-118.30, 34.05], [-118.28, 34.052]], { name: 'Main St' });
    const b = turf.lineString([[-110.00, 30.00], [-109.99, 30.01]], { name: 'Main St' });
    const result = dissolveBarriers([a, b]);
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd command-center && npm test -- subdivider`
Expected: FAIL — `dissolveBarriers is not a function`.

- [ ] **Step 3: Implement `dissolveBarriers` and update `fetchOSMBarriers`**

In `command-center/src/zones/subdivider.js`, replace the existing `fetchOSMBarriers` function:

```js
// Fetch only meaningful SAR barriers from OpenStreetMap
export async function fetchOSMBarriers(polygon) {
  const [west, south, east, north] = turf.bbox(polygon);
  const query = `[out:json][timeout:25];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
  });
  const data = await resp.json();

  return data.elements
    .filter(el => el.type === 'way' && el.geometry?.length >= 2)
    .map(el => turf.lineString(
      el.geometry.map(pt => [pt.lon, pt.lat]),
      { barrierType: el.tags?.waterway ? 'waterway' : 'road', name: el.tags?.name ?? '' }
    ));
}
```

with:

```js
// Fetch only meaningful SAR barriers from OpenStreetMap
export async function fetchOSMBarriers(polygon) {
  const [west, south, east, north] = turf.bbox(polygon);
  const query = `[out:json][timeout:25];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
  });
  const data = await resp.json();

  const lines = data.elements
    .filter(el => el.type === 'way' && el.geometry?.length >= 2)
    .map(el => turf.lineString(
      el.geometry.map(pt => [pt.lon, pt.lat]),
      { barrierType: el.tags?.waterway ? 'waterway' : 'road', name: el.tags?.name ?? '' }
    ));

  return dissolveBarriers(lines);
}

// OSM splits a single real road/freeway into many short ways (one per block or
// interchange). Scoring/cutting each in isolation means no single segment is
// long enough to fully bisect a polygon — chain same-named touching segments
// into one continuous line first, so a real freeway reads as one long barrier
// and gets one clean full-length cut instead of several short, incomplete notches.
export function dissolveBarriers(lines, toleranceKm = 0.005) {
  const named = lines.filter(l => l.properties?.name);
  const unnamed = lines.filter(l => !l.properties?.name);

  const byName = named.reduce((acc, line) => {
    (acc[line.properties.name] ??= []).push(line);
    return acc;
  }, {});

  const dissolved = [];
  for (const [name, group] of Object.entries(byName)) {
    dissolved.push(...chainSegments(group, name, toleranceKm));
  }
  return [...dissolved, ...unnamed];
}

// Greedily chain lines whose endpoints touch within `toleranceKm` into single
// longer LineStrings. Segments that don't connect to anything stay separate.
function chainSegments(lines, name, toleranceKm) {
  let remaining = lines.map(l => [...l.geometry.coordinates]);
  const chains = [];

  while (remaining.length) {
    let chain = remaining.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        if (closeEnough(chain[chain.length - 1], seg[0], toleranceKm)) {
          chain = [...chain, ...seg.slice(1)];
        } else if (closeEnough(chain[chain.length - 1], seg[seg.length - 1], toleranceKm)) {
          chain = [...chain, ...[...seg].reverse().slice(1)];
        } else if (closeEnough(chain[0], seg[seg.length - 1], toleranceKm)) {
          chain = [...seg.slice(0, -1), ...chain];
        } else if (closeEnough(chain[0], seg[0], toleranceKm)) {
          chain = [...[...seg].reverse().slice(0, -1), ...chain];
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }

  return chains.map(coords => turf.lineString(coords, { barrierType: 'road', name }));
}

function closeEnough(a, b, toleranceKm) {
  return turf.distance(a, b, { units: 'kilometers' }) <= toleranceKm;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd command-center && npm test -- subdivider`
Expected: PASS — all 4 new `dissolveBarriers` tests green, all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "fix(cc): dissolve same-named OSM way segments before barrier-cutting, widen road query"
```

---

### Task 3: Balance-aware merge (fixes the tiny-zone/huge-zone bug)

**Files:**
- Modify: `command-center/src/zones/subdivider.js`
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Produces: real `mergeSmallestIntoNeighbor(zones, n)` (internal, not exported — replaces the stub added in Task 1 and the original `mergeToN` function), exercised indirectly through `subdivideWithBarriers` and `gridSubdivide` (both already call it by this name). No new exported symbol — this task replaces behavior, verified via `subdivideWithBarriers`'s existing barrier tests plus one new adversarial test proving the size-balance fix.

- [ ] **Step 1: Write the failing test**

Add to `command-center/test/zones/subdivider.test.js`, inside (or alongside) the existing `describe('subdivideWithBarriers', ...)` block:

```js
it('merging down to n balances sizes instead of leaving a tiny sliver next to a merged giant', () => {
  // One isolated tiny corner piece, and two large adjacent pieces whose
  // centroids are much closer to each other than either is to the tiny one —
  // the OLD nearest-centroid-PAIR strategy merges the two large pieces
  // together (making a giant zone) and leaves the tiny one stranded alone.
  const tiny = turf.polygon([[
    [-118.50, 34.00], [-118.499, 34.00], [-118.499, 34.001], [-118.50, 34.001], [-118.50, 34.00],
  ]]);
  const big1 = turf.polygon([[
    [-118.30, 34.00], [-118.20, 34.00], [-118.20, 34.10], [-118.30, 34.10], [-118.30, 34.00],
  ]]);
  const big2 = turf.polygon([[
    [-118.20, 34.00], [-118.10, 34.00], [-118.10, 34.10], [-118.20, 34.10], [-118.20, 34.00],
  ]]);

  // Force a barrier cut that produces exactly these 3 pieces isn't practical to
  // set up through the public API — exercise gridSubdivide's internal reliance
  // on the same merge helper instead, which is reachable and deterministic:
  // shrink 3 wildly-uneven pre-made cells down to 2 via the grid fallback path
  // by feeding them through subdivideWithBarriers with no usable barriers.
  const combined = turf.union(turf.union(tiny, big1), big2);
  const result = subdivideWithBarriers(combined, 2, []); // no barriers → straight to gridSubdivide
  const areas = result.map(z => turf.area(z));
  const ratio = Math.max(...areas) / Math.min(...areas);
  expect(result).toHaveLength(2);
  expect(ratio).toBeLessThan(5); // balanced split, not a 20,000x sliver-vs-giant split
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd command-center && npm test -- subdivider`
Expected: This specific test may actually PASS already if `gridSubdivide` (from Task 1) happens to grid-partition the union shape reasonably — that's fine, it's exercising the code path, not proving the old bug. To confirm the bug this task fixes, temporarily verify with the standalone comparison instead: this was already validated manually (old nearest-pair merge on isolated-tiny + adjacent-big1/big2 produced areas `[10273, 205348106]`, ratio ~19989×; the replacement produces `[102674053, 102684326]`, ratio 1.00×). Proceed to Step 3 — the assertion in Step 1 is the regression guard going forward.

- [ ] **Step 3: Replace `mergeToN` with the real `mergeSmallestIntoNeighbor`**

In `command-center/src/zones/subdivider.js`:

1. Delete the original `mergeToN` function entirely (the one using the nearest-centroid-**pair** double loop).
2. Delete the stub `mergeSmallestIntoNeighbor` added in Task 1, Step 3.
3. Add this in its place:

```js
// Reduce to n pieces by repeatedly merging the SMALLEST current piece into its
// nearest-centroid neighbor — prevents one tiny sliver zone next to one
// oversized merged zone (blind nearest-centroid-PAIR merging did this: two
// large adjacent pieces would win "nearest pair" and merge into a giant zone,
// stranding a small isolated piece alone).
function mergeSmallestIntoNeighbor(zones, n) {
  let current = [...zones];
  while (current.length > n) {
    const areas = current.map(z => turf.area(z));
    const smallestIdx = areas.reduce((si, a, i) => a < areas[si] ? i : si, 0);

    const centroids = current.map(z => turf.centroid(z).geometry.coordinates);
    const sc = centroids[smallestIdx];
    let nearestIdx = -1, minDist = Infinity;
    centroids.forEach((c, i) => {
      if (i === smallestIdx) return;
      const d = (c[0] - sc[0]) ** 2 + (c[1] - sc[1]) ** 2;
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });
    if (nearestIdx === -1) break;

    try {
      const merged = turf.union(current[smallestIdx], current[nearestIdx]);
      current = current.filter((_, i) => i !== smallestIdx && i !== nearestIdx);
      if (merged) current.push(merged);
      else break;
    } catch {
      current = current.filter((_, i) => i !== smallestIdx);
    }
  }
  return current;
}
```

4. In `subdivideWithBarriers`, find the line `if (zones.length > n) zones = mergeToN(zones, n);` and change it to `if (zones.length > n) zones = mergeSmallestIntoNeighbor(zones, n);` (it now calls the same function `gridSubdivide` already calls internally).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd command-center && npm test -- subdivider`
Expected: PASS — the new balance test passes, all existing `subdivideWithBarriers` tests (barrier-split behavior) still pass unchanged since they don't exercise the merge-down path (they use exactly 2 target zones from a single splitting barrier).

- [ ] **Step 5: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "fix(cc): merge smallest-into-nearest-neighbor instead of nearest-centroid-pair, fixes tiny/huge zone imbalance"
```

---

### Task 4: Unified `generateZones()` entry point, remove `subdivideZone`/`stripSubdivide`

**Files:**
- Modify: `command-center/src/zones/subdivider.js`
- Test: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Consumes: `gridSubdivide` (Task 1), `dissolveBarriers`-enabled `fetchOSMBarriers` (Task 2), `mergeSmallestIntoNeighbor` (Task 3).
- Produces: `export const ZONE_SIZE_PRESETS = { small, medium, large }` (values in m²) and `export async function generateZones(boundaryPolygon, targetAreaM2)` returning `Promise<Feature<Polygon>[]>` — the **only** function Task 5 (Command Center) calls for zone generation, for both the whole-boundary pass and any manually-drawn single zone.
- Removes: `subdivideZone` and `stripSubdivide` (no longer called anywhere after this task — Task 5 stops importing `subdivideZone`).

- [ ] **Step 1: Update the fallback call sites in `subdivideWithBarriers`**

In `command-center/src/zones/subdivider.js`, in `subdivideWithBarriers`, change:

```js
  if (n <= 1) return [polygon];
  if (!barrierLines?.length) return stripSubdivide(polygon, n);
```

to:

```js
  if (n <= 1) return [polygon];
  if (!barrierLines?.length) return gridSubdivide(polygon, n);
```

and change:

```js
  if (!scored.length) return stripSubdivide(polygon, n);
```

to:

```js
  if (!scored.length) return gridSubdivide(polygon, n);
```

and change:

```js
  // Too few → strip-split the largest zones
  while (zones.length < n) {
    const maxIdx = zones.reduce((mi, z, i) =>
      turf.area(z) > turf.area(zones[mi]) ? i : mi, 0);
    const halves = stripSubdivide(zones[maxIdx], 2);
    zones = [...zones.slice(0, maxIdx), ...halves, ...zones.slice(maxIdx + 1)];
  }
```

to:

```js
  // Too few → grid-split the largest zone (compact, not a bbox-spanning strip)
  while (zones.length < n) {
    const maxIdx = zones.reduce((mi, z, i) =>
      turf.area(z) > turf.area(zones[mi]) ? i : mi, 0);
    const halves = gridSubdivide(zones[maxIdx], 2);
    zones = [...zones.slice(0, maxIdx), ...halves, ...zones.slice(maxIdx + 1)];
  }
```

- [ ] **Step 2: Delete `subdivideZone` and `stripSubdivide`**

In `command-center/src/zones/subdivider.js`, delete these two functions entirely:

```js
// Plain strip subdivision (used for sub-zones and as fallback)
export function subdivideZone(polygon, n) {
  if (n <= 0) throw new Error('n must be positive');
  if (n === 1) return [polygon];
  return stripSubdivide(polygon, n);
}
```

and:

```js
// Strip subdivision along the longer axis — guaranteed full coverage
function stripSubdivide(polygon, n) {
  if (polygon.geometry?.type === 'MultiPolygon') {
    const parts = polygon.geometry.coordinates.map(c => turf.polygon(c));
    const total = parts.reduce((s, p) => s + turf.area(p), 0);
    const result = [];
    for (const part of parts) {
      const share = Math.max(1, Math.round(n * turf.area(part) / total));
      result.push(...stripSubdivide(part, share));
    }
    return result;
  }

  const [minX, minY, maxX, maxY] = turf.bbox(polygon);
  const w = maxX - minX;
  const h = maxY - minY;
  const horiz = h >= w;
  const strips = [];

  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const bbox = horiz
      ? [minX, minY + t0 * h, maxX, minY + t1 * h]
      : [minX + t0 * w, minY, minX + t1 * w, maxY];
    try {
      const isect = turf.intersect(turf.bboxPolygon(bbox), polygon);
      if (isect) strips.push(isect);
    } catch { /* skip degenerate */ }
  }
  return strips;
}
```

- [ ] **Step 3: Add `ZONE_SIZE_PRESETS` and `generateZones`**

Add near the top of `command-center/src/zones/subdivider.js`, right after the `import * as turf from '@turf/turf';` line:

```js
export const ZONE_SIZE_PRESETS = {
  small:  40_000,   // m² ≈ 200m × 200m — roughly a 5 min walk across
  medium: 160_000,  // m² ≈ 400m × 400m — roughly a 10 min walk across
  large:  640_000,  // m² ≈ 800m × 800m — roughly a 20 min walk across
};
```

Add at the bottom of the file:

```js
// Single entry point Command Center calls for all zone generation — the
// whole-boundary pass and a manually-drawn single zone both go through this,
// there is no separate letter/sub-zone tier anymore.
export async function generateZones(boundaryPolygon, targetAreaM2) {
  const barriers = await fetchOSMBarriers(boundaryPolygon).catch(() => []);
  const n = Math.max(1, Math.round(turf.area(boundaryPolygon) / targetAreaM2));
  return subdivideWithBarriers(boundaryPolygon, n, barriers);
}
```

- [ ] **Step 4: Rewrite the `subdivideZone` describe block in the test file**

In `command-center/test/zones/subdivider.test.js`, delete the entire `describe('subdivideZone', ...)` block (its target function no longer exists) — its coverage is already superseded by the `gridSubdivide` tests added in Task 1. Update the import line at the top of the file:

```js
import { subdivideZone, subdivideWithBarriers } from '../../src/zones/subdivider.js';
```

becomes:

```js
import { subdivideWithBarriers, gridSubdivide, dissolveBarriers, generateZones, ZONE_SIZE_PRESETS } from '../../src/zones/subdivider.js';
```

Add one new test verifying the unified entry point end-to-end (network-free, since it passes barriers directly is not possible here — this test instead verifies the count math and delegates the shape guarantee to the already-tested `subdivideWithBarriers`/`gridSubdivide`; mock `global.fetch` to avoid a real network call):

```js
describe('generateZones', () => {
  it('computes zone count from target area and produces that many zones (no barriers reachable → grid fallback)', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ json: async () => ({ elements: [] }) });
    try {
      const zones = await generateZones(SQUARE, turf.area(SQUARE) / 6);
      expect(zones.length).toBe(6);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd command-center && npm test -- subdivider`
Expected: PASS — full file green: `gridSubdivide`, `dissolveBarriers`, `subdivideWithBarriers` (including the Task 3 balance test), `generateZones`. No references remain to `subdivideZone`/`stripSubdivide`.

- [ ] **Step 6: Commit**

```bash
git add command-center/src/zones/subdivider.js command-center/test/zones/subdivider.test.js
git commit -m "feat(cc): unify zone generation behind generateZones(), remove strip-based subdivideZone"
```

---

### Task 5: Command Center — flat zone schema, size-preset generation UX, map/panel display

**Files:**
- Modify: `command-center/src/firebase/zones.js`
- Modify: `command-center/src/firebase/searches.js`
- Modify: `command-center/src/search/SearchDetail.jsx`
- Modify: `command-center/src/ui/ZonePanel.jsx`
- Modify: `command-center/src/map/CommandMap.jsx`

**Interfaces:**
- Consumes: `generateZones`, `ZONE_SIZE_PRESETS` from `command-center/src/zones/subdivider.js` (Task 4).
- Produces: zone docs shaped `{ number, polygon, status, assignedTo, createdAt }` (no `letter`) — this is what Task 6/7 (searcher-app) and Task 9 (bot) will read.

This task has no dedicated automated test (matches this codebase's existing convention — `SearchDetail.jsx`/`ZonePanel.jsx`/`CommandMap.jsx` have no test files today; they're Firebase/DOM-heavy). Verify via `npm run build` (catches syntax/import errors) plus the manual smoke test in Step 6.

- [ ] **Step 1: Flatten `createZone`, drop `letterZones` from the search doc helpers**

In `command-center/src/firebase/zones.js`, change:

```js
export async function createZone(searchId, dayId, { letter, number, polygon }) {
  await setDoc(ref, {
    letter, number,
    polygon: JSON.stringify(polygon),
    status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
  });
  return ref.id;
}
```

to:

```js
export async function createZone(searchId, dayId, { number, polygon }) {
  await setDoc(ref, {
    number,
    polygon: JSON.stringify(polygon),
    status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
  });
  return ref.id;
}
```

(the `const ref = doc(zonesCol(searchId, dayId));` line above it is unchanged.)

In `command-center/src/firebase/searches.js`, delete the now-unused `updateSearchLetterZones` function entirely:

```js
export async function updateSearchLetterZones(searchId, letterZones) {
  await updateDoc(doc(db, 'searches', searchId), {
    letterZones: letterZones.map(z => ({
      letter: z.letter,
      geometry: JSON.stringify(z.feature.geometry),
    })),
  });
}
```

and in `watchSearch`, remove the `letterZones` parsing:

```js
    cb({
      id: snap.id,
      ...data,
      boundary: data.boundary ? JSON.parse(data.boundary) : null,
      letterZones: (data.letterZones ?? []).map(z => ({
        ...z,
        geometry: z.geometry ? JSON.parse(z.geometry) : null,
      })),
    });
```

becomes:

```js
    cb({
      id: snap.id,
      ...data,
      boundary: data.boundary ? JSON.parse(data.boundary) : null,
    });
```

- [ ] **Step 2: Replace the zone-count input with a size-preset selector, single flat generation pass**

In `command-center/src/search/SearchDetail.jsx`, change the import line:

```js
import { fetchOSMBarriers, subdivideWithBarriers, subdivideZone } from '../zones/subdivider';
```

to:

```js
import { generateZones, ZONE_SIZE_PRESETS } from '../zones/subdivider';
```

Change:

```js
import { updateSearchBoundary, updateSearchLetterZones, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
```

to:

```js
import { updateSearchBoundary, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
```

Replace this state block:

```js
  const [zoneCount, setZoneCount] = useState(4);
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [osmBarriers, setOsmBarriers] = useState([]);
  const [letterZones, setLetterZones] = useState([]);
  const [zones, setZones] = useState([]);
```

with:

```js
  const [zoneSize, setZoneSize] = useState('medium');
  const [generatingZones, setGeneratingZones] = useState(false);
  const [zones, setZones] = useState([]);
```

(`osmBarriers` and `letterZones` state are dropped entirely — no separate letter-region overlay or barrier-line overlay in the flat model; `generatingStatus` is dropped since generation is now one call, not a multi-stage "fetching roads… generating zones…" sequence.)

Remove the whole `search.letterZones` handling inside the `watchSearch` callback:

```js
      if (search.letterZones?.length) {
        setLetterZones(search.letterZones.map(z => ({
          letter: z.letter,
          feature: { type: 'Feature', geometry: z.geometry, properties: {} },
        })));
      }
```

Replace `handleFeatureDrawn` entirely:

```js
  async function handleFeatureDrawn(feature, type) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      if (type === 'boundary') {
        setBoundary(feature.geometry);
        await updateSearchBoundary(searchId, feature.geometry);
      } else {
        const letter = String.fromCharCode(65 + letterZones.length); // A, B, C…
        const updated = [...letterZones, { letter, feature }];
        setLetterZones(updated);
        await updateSearchLetterZones(searchId, updated);
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }
```

with:

```js
  async function handleFeatureDrawn(feature, type) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      if (type === 'boundary') {
        setBoundary(feature.geometry);
        await updateSearchBoundary(searchId, feature.geometry);
      } else {
        // Manual draw creates exactly one flat zone from the drawn shape —
        // an admin override/patch tool, no forced subdivision.
        const nextNumber = zones.length
          ? Math.max(...zones.map(z => z.number)) + 1
          : 1;
        await createZone(searchId, DAY_ID, { number: nextNumber, polygon: feature.geometry });
      }
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }
```

Replace `handleGenerateZones` entirely:

```js
  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };

      setGeneratingStatus('Fetching roads & waterways…');
      let barriers = [];
      try {
        barriers = await fetchOSMBarriers(boundaryFeature);
        setOsmBarriers(barriers);
      } catch (e) {
        console.warn('OSM fetch failed, using grid:', e);
      }

      setGeneratingStatus('Generating zones…');
      const letterPolygons = barriers.length
        ? subdivideWithBarriers(boundaryFeature, zoneCount, barriers)
        : subdivideZone(boundaryFeature, zoneCount);

      const newLetterZones = letterPolygons.map((poly, i) => ({
        letter: String.fromCharCode(65 + i),
        feature: poly,
      }));
      setLetterZones(newLetterZones);
      await updateSearchLetterZones(searchId, newLetterZones);
      for (const { letter, feature } of newLetterZones) {
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
    }
    setGeneratingStatus('');
    setGeneratingZones(false);
  }
```

with:

```js
  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };
      const polygons = await generateZones(boundaryFeature, ZONE_SIZE_PRESETS[zoneSize]);
      for (let i = 0; i < polygons.length; i++) {
        await createZone(searchId, DAY_ID, { number: i + 1, polygon: polygons[i].geometry });
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
    }
    setGeneratingZones(false);
  }
```

Replace the Step 2 UI block:

```jsx
        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && letterZones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: How many zones?</span>
            <input
              type="number" min={1} max={26} value={zoneCount}
              onChange={e => setZoneCount(Number(e.target.value))}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
          </>
        )}
```

with:

```jsx
        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && zones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: Zone size</span>
            <select value={zoneSize} onChange={e => setZoneSize(e.target.value)}
              style={{ padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }}>
              <option value="small">Small (~5 min walk across)</option>
              <option value="medium">Medium (~10 min walk across)</option>
              <option value="large">Large (~20 min walk across)</option>
            </select>
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? 'Generating…' : '🗺 Generate Zones'}
            </button>
          </>
        )}
```

Note this condition now checks `zones.length === 0` instead of `letterZones.length === 0` (there's no separate letter-region state to check anymore — the flat `zones` list is the only signal for "have zones been generated yet").

Also, the Step 3 "Send Out Search" button condition `searchStatus === 'setup' && letterZones.length > 0` becomes `searchStatus === 'setup' && zones.length > 0`.

Update the `CommandMap` props (remove `letterZones`, `osmBarriers`):

```jsx
        <CommandMap
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundary={boundary}
          letterZones={letterZones}
          subZones={zones}
          osmBarriers={osmBarriers}
          tracks={tracksWithStatus}
          liveMarkers={liveMarkers}
        />
```

becomes:

```jsx
        <CommandMap
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundary={boundary}
          subZones={zones}
          tracks={tracksWithStatus}
          liveMarkers={liveMarkers}
        />
```

(`tracksWithStatus`/`statusByVolunteer` from the earlier fieldtest fix are untouched — they don't reference `letter` at all.)

- [ ] **Step 3: Update `ZonePanel.jsx` for flat zone numbers**

Replace the whole file `command-center/src/ui/ZonePanel.jsx`:

```jsx
import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned','assigned','in_progress','searched','needs_re_search'];

export function ZonePanel({ zones, volunteers = {}, onStatusChange, readOnly = false }) {
  return (
    <div style={{ width: 280, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
      )}
      {[...zones].sort((a, b) => a.number - b.number).map(zone => (
        <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontWeight: 700, minWidth: 28 }}>#{zone.number}</span>
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

(The old letter-grouping `byLetter` reduce and its wrapping `<h4>Zone {letter} — N sub-zones</h4>` header are gone — one flat sorted list.)

- [ ] **Step 4: Remove the letter-zones overlay from `CommandMap.jsx`, fix the flat label**

In `command-center/src/map/CommandMap.jsx`, change the props signature:

```jsx
export function CommandMap({ drawMode, onFeatureDrawn, boundary = null, letterZones = [], subZones = [], osmBarriers = [], tracks = [], liveMarkers = [] }) {
```

to:

```jsx
export function CommandMap({ drawMode, onFeatureDrawn, boundary = null, subZones = [], tracks = [], liveMarkers = [] }) {
```

Delete the `letter-zones` source/layers block entirely:

```js
      map.addSource('letter-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'letter-zones-fill', type: 'fill', source: 'letter-zones',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'letter-zones-line', type: 'line', source: 'letter-zones',
        paint: { 'line-color': '#1d4ed8', 'line-width': 2 } });
      map.addLayer({ id: 'letter-zones-labels', type: 'symbol', source: 'letter-zones',
        layout: {
          'text-field': ['get', 'letter'],
          'text-size': 22,
          'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
          'text-anchor': 'center',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#1e3a8a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
```

Delete the `letter-zones` data-push effect entirely:

```js
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('letter-zones')?.setData(
      turf.featureCollection(letterZones.map(z => ({ ...z.feature, properties: { letter: z.letter } })))
    );
  }, [letterZones, mapLoaded]);
```

In the `sub-zones` data-push effect, change:

```js
    map.getSource('sub-zones')?.setData(
      turf.featureCollection(subZones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { label: `${z.letter}${z.number}`, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
```

to:

```js
    map.getSource('sub-zones')?.setData(
      turf.featureCollection(subZones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { label: `${z.number}`, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
```

(The `sub-zones` Mapbox source/layer ids stay as-is — they're internal identifiers, not user-facing, and now simply represent every flat zone instead of "sub-zones within a letter." Renaming them is optional polish, not required for correctness.)

- [ ] **Step 5: Build to catch import/syntax errors**

Run: `cd command-center && npm run build`
Expected: Build succeeds with no errors (warnings about chunk size are pre-existing and fine).

- [ ] **Step 6: Manual smoke test**

Using the local dev server (`cd command-center && npm run dev`) or a fieldtest preview channel deploy:
1. Create a test search, draw a boundary.
2. Confirm Step 2 now shows a Small/Medium/Large dropdown (not a number input), default Medium.
3. Click Generate Zones — confirm zones appear as flat `#1, #2, #3...` labels on the map, no letters, no separate big blue "letter region" overlay behind them.
4. Confirm zone count roughly matches boundary-size ÷ preset-target-area (e.g. a small boundary at "Large" preset yields very few zones, "Small" yields many).
5. Draw one manual zone (MapboxDraw polygon tool) — confirm it appears immediately as a single new flat-numbered zone with no forced subdivision.
6. Confirm the Zone Panel on the right shows one flat sorted list (`#1`, `#2`, ...), not grouped under letter headers.

- [ ] **Step 7: Commit**

```bash
git add command-center/src/firebase/zones.js command-center/src/firebase/searches.js command-center/src/search/SearchDetail.jsx command-center/src/ui/ZonePanel.jsx command-center/src/map/CommandMap.jsx
git commit -m "feat(cc): flat numbered zones with size-preset generation, drop letter tier from Command Center"
```

---

### Task 6: searcher-app — `claimZone` by zoneId directly

**Files:**
- Modify: `searcher-app/src/pick/claimZone.js`

**Interfaces:**
- Consumes: nothing new — same Firestore client SDK already imported.
- Produces: `export async function claimZone({ searchId, dayId, zoneId, volunteerId, name }): Promise<string|null>` — returns the new `searcherLinks` token on success, `null` if the zone was already taken by the time the transaction ran. Task 7's `PickPage.jsx` calls this directly with a specific `zoneId` — no more `letter`/`zones`-candidate-list params.

No dedicated automated test — this file has none today (Firebase-transaction-heavy, matches the existing convention of not unit-testing Firestore-integrated client wrappers in this codebase, e.g. `tracks.js`/`links.js`/`zones.js` have no tests either). Verified via Task 7's manual smoke test, which exercises the full claim path end-to-end.

- [ ] **Step 1: Replace the whole file**

Replace `searcher-app/src/pick/claimZone.js` entirely:

```js
import { doc, runTransaction, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

const ASSIGNABLE = ['unassigned', 'needs_re_search'];

// Client claims a specific zone directly via a Firestore transaction — no
// bot/server needed. If the zone was claimed by someone else between the
// picker's last snapshot and this call, the transaction's status check fails
// and this returns null (the picker shows "that zone just filled up").
export async function claimZone({ searchId, dayId, zoneId, volunteerId, name }) {
  await setDoc(doc(db, 'volunteers', volunteerId), { name }, { merge: true });

  const zoneRef = doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId);
  const token = crypto.randomUUID();
  const linkRef = doc(db, 'searcherLinks', token);

  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(zoneRef);
      if (!ASSIGNABLE.includes(snap.data()?.status)) throw new Error('taken');
      tx.update(zoneRef, { status: 'assigned', assignedTo: volunteerId });
      tx.set(linkRef, {
        searchId, dayId, zoneId, volunteerId,
        active: true, createdAt: serverTimestamp(),
      });
    });
    return token;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Build to catch import/syntax errors**

Run: `cd searcher-app && npm run build`
Expected: Build succeeds (Task 7 will still be mid-flight importing the old `claimZone` shape from `PickPage.jsx` — if the build fails here because `PickPage.jsx` still calls `claimZone` with a `letter`/`zones` shape, that's expected and gets fixed in Task 7's Step 1; note the failure and proceed to Task 7 immediately, don't attempt to make this task pass in isolation).

- [ ] **Step 3: Commit**

```bash
git add searcher-app/src/pick/claimZone.js
git commit -m "feat(searcher): claimZone takes a specific zoneId, no letter-filtered candidate list"
```

---

### Task 7: searcher-app — flat zone picker map

**Files:**
- Modify: `searcher-app/src/pick/PickMap.jsx`
- Modify: `searcher-app/src/pick/PickPage.jsx`

**Interfaces:**
- Consumes: `claimZone({ searchId, dayId, zoneId, volunteerId, name })` from Task 6.
- Produces: nothing new consumed by later tasks — this completes the picker.

No dedicated automated test (matches existing convention — `PickPage.jsx`/`PickMap.jsx` have no test files today). Verified via the manual smoke test in Step 3.

- [ ] **Step 1: Replace `PickMap.jsx` — render every zone directly, no letter grouping**

Replace `searcher-app/src/pick/PickMap.jsx` entirely:

```jsx
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = turf.featureCollection([]);
// Mirrors command-center/src/map/CommandMap.jsx's STATUS_COLORS so the same
// zone reads the same color to both the admin and the searcher.
const STATUS_COLORS = {
  unassigned: '#9ca3af', assigned: '#3b82f6',
  in_progress: '#f59e0b', searched: '#22c55e', needs_re_search: '#ef4444',
};

export function PickMap({ zones, onZoneClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const onZoneClickRef = useRef(onZoneClick);
  // State (not a ref) so the source-update effect below re-runs once the map
  // finishes loading — a ref mutation inside `map.on('load', ...)` wouldn't
  // re-trigger that effect, so if Firestore data arrives before the map does
  // (the common case), the zone layer would otherwise stay empty forever.
  const [mapLoaded, setMapLoaded] = useState(false);
  useEffect(() => { onZoneClickRef.current = onZoneClick; }, [onZoneClick]);

  useEffect(() => {
    const zonesWithGeometry = zones.filter(z => z.polygon);
    const fc = turf.featureCollection(
      zonesWithGeometry.map(z => ({ type: 'Feature', geometry: z.polygon, properties: { zoneId: z.id } }))
    );
    const bbox = fc.features.length ? turf.bbox(fc) : undefined;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      ...(bbox ? { bounds: bbox, fitBoundsOptions: { padding: 40 } } : { center: [0, 0], zoom: 1 }),
    });

    map.on('load', () => {
      map.addSource('zones', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45 },
      });
      map.addLayer({
        id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#1f2937', 'line-width': 2 },
      });
      map.addLayer({
        id: 'zones-labels', type: 'symbol', source: 'zones',
        layout: { 'text-field': ['get', 'number'], 'text-size': 20, 'text-allow-overlap': true },
        paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      });

      map.on('click', 'zones-fill', e => {
        const zoneId = e.features[0]?.properties?.zoneId;
        if (zoneId) onZoneClickRef.current?.(zoneId);
      });
      map.on('mouseenter', 'zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'zones-fill', () => { map.getCanvas().style.cursor = ''; });

      setMapLoaded(true);
    });

    mapRef.current = map;
    return () => { setMapLoaded(false); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('zones')?.setData(
      turf.featureCollection(
        zones.filter(z => z.polygon).map(z => ({
          type: 'Feature',
          geometry: z.polygon,
          properties: {
            zoneId: z.id,
            number: z.number,
            color: STATUS_COLORS[z.status] ?? '#9ca3af',
          },
        }))
      )
    );
  }, [zones, mapLoaded]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
```

- [ ] **Step 2: Replace `PickPage.jsx` — claim by zoneId, no letter step**

Replace `searcher-app/src/pick/PickPage.jsx` entirely:

```jsx
import { useState, useEffect, useMemo } from 'react';
import { getSearch } from '../firebase/searches';
import { watchZones } from '../firebase/zones';
import { claimZone } from './claimZone';
import { getIdentity, saveName } from './identity';
import { PickMap } from './PickMap';

const DAY_ID = 'day-1';
const ASSIGNABLE = ['unassigned', 'needs_re_search'];

export function PickPage({ searchId }) {
  const [search, setSearch] = useState(undefined); // undefined = loading, null = not found
  const [zones, setZones] = useState([]);
  const [pendingZoneId, setPendingZoneId] = useState(null);
  const [nameInput, setNameInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [requestStatus, setRequestStatus] = useState(null);
  const [requestError, setRequestError] = useState(null);
  const identity = useMemo(getIdentity, []);

  useEffect(() => { getSearch(searchId).then(setSearch); }, [searchId]);

  useEffect(() => {
    if (!search) return;
    return watchZones(search.id, DAY_ID, setZones);
  }, [search]);

  if (search === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (search === null) return <p style={{ padding: 24 }}>This search link isn't valid.</p>;

  async function submitClaim(zoneId, name) {
    setRequestError(null);
    setRequestStatus(null);
    setClaiming(true);
    try {
      const token = await claimZone({
        searchId: search.id, dayId: DAY_ID, zoneId, volunteerId: identity.id, name,
      });
      if (!token) { setRequestStatus('no_availability'); setClaiming(false); return; }
      window.location.href = `/s/${token}`;
    } catch {
      setRequestError("Something went wrong claiming that zone — try again.");
      setClaiming(false);
    }
  }

  function handleTapZone(zoneId) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone || !ASSIGNABLE.includes(zone.status)) return;
    if (!identity.name) { setPendingZoneId(zoneId); return; }
    submitClaim(zoneId, identity.name);
  }

  function handleNameSubmit(e) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    saveName(nameInput.trim());
    submitClaim(pendingZoneId, nameInput.trim());
    setPendingZoneId(null);
  }

  if (claiming) {
    return <p style={{ padding: 24, textAlign: 'center' }}>Joining zone…</p>;
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <PickMap zones={zones} onZoneClick={handleTapZone} />

      <div style={{
        position: 'fixed', top: 12, left: 12, right: 12, zIndex: 10,
        background: 'rgba(30,41,59,0.92)', color: '#f8fafc',
        borderRadius: 10, padding: '10px 14px', fontWeight: 700, textAlign: 'center',
      }}>
        {search.name}
        <div style={{ fontWeight: 400, fontSize: 13, marginTop: 4 }}>
          Tap an available zone to join the search.
        </div>

        {requestStatus === 'no_availability' && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6, color: '#fca5a5' }}>
            That zone just filled up — try another.
          </div>
        )}

        {requestError && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6, color: '#fca5a5' }}>
            {requestError}
          </div>
        )}
      </div>

      {pendingZoneId && (
        <form onSubmit={handleNameSubmit} style={{
          position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
          background: '#fff', borderRadius: 12, padding: 16,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          <p style={{ marginBottom: 8, fontWeight: 600 }}>What's your name?</p>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="First Last" autoFocus />
          <button type="submit" style={{ marginTop: 10, width: '100%' }}>Join This Zone</button>
        </form>
      )}
    </div>
  );
}
```

Note `searcher-app/src/firebase/zones.js` needs **no changes** — `watchZones`/`parseZone` already spread `...data` generically and parse `polygon` from its JSON string; they never referenced `letter` and work as-is with flat zone docs.

- [ ] **Step 3: Build, then manual smoke test**

Run: `cd searcher-app && npm run build`
Expected: Build succeeds.

Manual test (needs a search with flat zones generated via Task 5's Command Center changes — use a fieldtest preview channel deploy of both apps together):
1. Open `/pick/{searchId}` — confirm the map shows every flat zone directly (no big letter regions, no second tap-through step), colored by status.
2. Tap an unassigned (gray) zone — confirm the name prompt appears (first time), then after submitting, the browser navigates to `/s/{token}` and the zone's map loads.
3. Reload the picker in a second tab/incognito window for the same search — confirm the just-claimed zone now shows the "assigned" color (blue) and is not tappable into a successful claim (tapping it does nothing, since `ASSIGNABLE` no longer includes it).
4. With two browser tabs open on the same still-unassigned zone, tap it in both nearly simultaneously — confirm exactly one succeeds and the other lands on "that zone just filled up."

- [ ] **Step 4: Commit**

```bash
git add searcher-app/src/pick/PickMap.jsx searcher-app/src/pick/PickPage.jsx
git commit -m "feat(searcher): flat zone-tap picker map, remove letter-then-subzone two-step"
```

---

### Task 8: searcher-app — "Zone complete, pick another" flow and flat number display

**Files:**
- Modify: `searcher-app/src/App.jsx`
- Modify: `searcher-app/src/ui/StatusButton.jsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — this completes the searcher-app side.

No dedicated automated test (Firebase/DOM-heavy, matches existing convention). Verified via the manual smoke test in Step 3.

- [ ] **Step 1: Simplify `StatusButton.jsx` — App.jsx now owns the "complete" state**

Replace `searcher-app/src/ui/StatusButton.jsx` entirely:

```jsx
export function StatusButton({ onComplete }) {
  return (
    <button
      onClick={onComplete}
      style={{
        position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
        padding: 16, fontSize: 18, fontWeight: 700, borderRadius: 12,
        color: '#fff', background: '#22c55e',
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      }}>
      Mark Zone Complete
    </button>
  );
}
```

(The old `status`/`onReopen`/`complete` toggle branch is gone — `App.jsx` now renders a completely different button once the zone is `searched`, per Step 2 below, instead of this component toggling its own label.)

- [ ] **Step 2: `App.jsx` — flat number display, "pick another zone" after complete**

In `searcher-app/src/App.jsx`, change the zone header line:

```jsx
        Zone {zone.letter}{zone.number}
```

to:

```jsx
        Zone {zone.number}
```

Replace the `<StatusButton .../>` render at the bottom of the component:

```jsx
      <StatusButton
        status={zone.status}
        onComplete={() => handleStatusChange('searched')}
        onReopen={() => handleStatusChange('in_progress')}
      />
```

with:

```jsx
      {zone.status === 'searched' ? (
        <button
          onClick={() => { window.location.href = `/pick/${link.searchId}`; }}
          style={{
            position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
            padding: 16, fontSize: 18, fontWeight: 700, borderRadius: 12,
            color: '#fff', background: '#3b82f6',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}>
          Zone complete — Pick another zone
        </button>
      ) : (
        <StatusButton onComplete={() => handleStatusChange('searched')} />
      )}
```

- [ ] **Step 3: Build, then manual smoke test**

Run: `cd searcher-app && npm run build`
Expected: Build succeeds.

Manual test:
1. Open a claimed zone's `/s/{token}` link — confirm the header shows `Zone {number}` (no letter prefix).
2. Tap "Mark Zone Complete" — confirm the button is replaced by "Zone complete — Pick another zone" (not the old "tap to re-open" toggle).
3. Tap "Zone complete — Pick another zone" — confirm it navigates to `/pick/{searchId}`, landing on the flat picker map with the just-completed zone now shown in the "searched" color and every other still-open zone tappable.
4. Confirm GPS tracking actually stopped when the zone was marked complete (this was the earlier fieldtest fix — `useGpsTracking`'s gate already keys off `zone.status !== 'searched'`, unaffected by this task, but worth reconfirming it still holds after this change since `zone.status` flows through unchanged).

- [ ] **Step 4: Commit**

```bash
git add searcher-app/src/App.jsx searcher-app/src/ui/StatusButton.jsx
git commit -m "feat(searcher): searcher picks their own next zone after completing one, flat zone number display"
```

---

### Task 9: Telegram bot — flat `pickZone`, drop letter argument from `/available`

**Files:**
- Modify: `telegram-bot/src/assignment/assign.js`
- Modify: `telegram-bot/test/assignment/assign.test.js`
- Modify: `telegram-bot/src/search/resolveSearch.js`
- Modify: `telegram-bot/test/search/resolveSearch.test.js`
- Modify: `telegram-bot/src/commands/available.js`

**Interfaces:**
- Produces: `export function pickZone(zones)` (drops the `requestedLetters`/`lockedLetters` params entirely) — returns the lowest-numbered zone whose `status` is `unassigned` or `needs_re_search`, or `null` if none. `export function parseAvailableArgs(tokens)` returns `{ code }` only (no more `letters`).

This is the minimal change needed because zone docs no longer have a `letter` field — not a redesign of the bot (it isn't deployed yet per the project handoff). `zoneRequestWatcher.js` (in `telegram-bot/src/watchers/`) already went unused once the web picker moved to client-side claiming in an earlier fieldtest fix — it's not touched by this task; it references `req.letter`/`zone.letter` but the `zoneRequests` collection it watches never receives new docs anymore in the current flow, so it's inert dead code, left as-is (out of scope for this plan).

- [ ] **Step 1: Rewrite `assign.test.js` for flat zones**

Replace `telegram-bot/test/assignment/assign.test.js` entirely:

```js
import { describe, it, expect } from 'vitest';
import { pickZone } from '../../src/assignment/assign.js';

const z = (number, status = 'unassigned', assignedTo = null) =>
  ({ id: `zone-${number}`, number, status, assignedTo });

describe('pickZone', () => {
  it('picks the lowest-numbered assignable zone', () => {
    const zones = [z(3), z(1), z(2)];
    expect(pickZone(zones).id).toBe('zone-1');
  });

  it('treats needs_re_search zones as assignable', () => {
    const zones = [z(1, 'searched', 'v1'), z(2, 'needs_re_search', 'v1')];
    expect(pickZone(zones).id).toBe('zone-2');
  });

  it('skips assigned/in_progress/searched zones', () => {
    const zones = [z(1, 'assigned', 'v1'), z(2, 'in_progress', 'v2'), z(3, 'searched', 'v3'), z(4)];
    expect(pickZone(zones).id).toBe('zone-4');
  });

  it('returns null when no zone is assignable', () => {
    const zones = [z(1, 'assigned', 'v1'), z(2, 'in_progress', 'v2')];
    expect(pickZone(zones)).toBeNull();
  });

  it('returns null for an empty zone list', () => {
    expect(pickZone([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd telegram-bot && npm test -- assign`
Expected: FAIL — `pickZone(zones)` (called with 1 arg) doesn't match the current 3-arg letter-based signature/behavior.

- [ ] **Step 3: Rewrite `pickZone` for flat zones**

Replace `telegram-bot/src/assignment/assign.js` entirely:

```js
const ASSIGNABLE = ['unassigned', 'needs_re_search'];

// Flat model: no letters to choose between, no locking — just the
// lowest-numbered zone still open. Ties (there are none, numbers are unique)
// aren't possible; sort guarantees deterministic "next" behavior.
export function pickZone(zones) {
  const available = zones
    .filter(z => ASSIGNABLE.includes(z.status))
    .sort((a, b) => a.number - b.number);
  return available[0] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd telegram-bot && npm test -- assign`
Expected: PASS.

- [ ] **Step 5: Rewrite `resolveSearch.test.js`'s `parseAvailableArgs` block, update `parseAvailableArgs`**

In `telegram-bot/test/search/resolveSearch.test.js`, replace the `describe('parseAvailableArgs', ...)` block:

```js
describe('parseAvailableArgs', () => {
  it('treats all single-char tokens as letters, uppercased', () => {
    expect(parseAvailableArgs(['a', 'B'])).toEqual({ code: null, letters: ['A', 'B'] });
  });

  it('treats a multi-char first token as the search code', () => {
    expect(parseAvailableArgs(['x7k2', 'a', 'b'])).toEqual({ code: 'X7K2', letters: ['A', 'B'] });
  });

  it('handles empty input', () => {
    expect(parseAvailableArgs([])).toEqual({ code: null, letters: [] });
  });
});
```

with:

```js
describe('parseAvailableArgs', () => {
  it('uppercases a given search code', () => {
    expect(parseAvailableArgs(['x7k2'])).toEqual({ code: 'X7K2' });
  });

  it('handles empty input (no code given)', () => {
    expect(parseAvailableArgs([])).toEqual({ code: null });
  });
});
```

(The `describe('pickSearch', ...)` block below it is untouched — `pickSearch` doesn't reference letters at all.)

In `telegram-bot/src/search/resolveSearch.js`, replace:

```js
export function parseAvailableArgs(tokens) {
  const upper = tokens.map(t => t.toUpperCase());
  if (upper.length && upper[0].length > 1) {
    return { code: upper[0], letters: upper.slice(1) };
  }
  return { code: null, letters: upper };
}
```

with:

```js
export function parseAvailableArgs(tokens) {
  return { code: tokens[0]?.toUpperCase() ?? null };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd telegram-bot && npm test -- resolveSearch`
Expected: PASS.

- [ ] **Step 7: Update `available.js` — no letter argument, grab the next open zone**

Replace `telegram-bot/src/commands/available.js` entirely:

```js
import { parseAvailableArgs, pickSearch } from '../search/resolveSearch.js';
import { pickZone } from '../assignment/assign.js';
import { DAY_ID } from '../constants.js';

export function availableHandler() {
  return async ctx => {
    const [{ getVolunteer }, { fetchActiveSearches }, { fetchZones, assignZone }, { createSearcherLink, deactivateLink }] =
      await Promise.all([
        import('../firebase/volunteers.js'),
        import('../firebase/searches.js'),
        import('../firebase/zones.js'),
        import('../firebase/links.js'),
      ]);

    const telegramId = String(ctx.from.id);
    const volunteer = await getVolunteer(telegramId);
    if (!volunteer) {
      await ctx.reply('Please register first: /register First Last');
      return;
    }

    const tokens = ctx.message.text.split(/\s+/).slice(1);
    const { code } = parseAvailableArgs(tokens);

    const active = await fetchActiveSearches();
    const picked = pickSearch(active, code);
    if (picked.error === 'no_active_search') {
      await ctx.reply('There is no active search right now.');
      return;
    }
    if (picked.error === 'code_required' || picked.error === 'invalid_code') {
      const list = active.map(s => `${s.code} — ${s.name}`).join('\n');
      await ctx.reply(
        `${picked.error === 'invalid_code' ? "I don't recognize that code. " : ''}` +
        `More than one search is active — include the search code:\n${list}\n` +
        `e.g. /available ${active[0].code}`
      );
      return;
    }

    const search = picked.search;
    const zones = await fetchZones(search.id, DAY_ID);
    const zone = pickZone(zones);
    if (!zone) {
      await ctx.reply('Every zone is fully assigned right now — watch the group for re-search announcements.');
      return;
    }

    // Create link BEFORE assigning, so the zone watcher sees an existing active
    // link for the new volunteer and knows the bot (not staff) made the assignment.
    const prev = { status: zone.status, assignedTo: zone.assignedTo };
    const token = await createSearcherLink({
      searchId: search.id, dayId: DAY_ID, zoneId: zone.id, volunteerId: telegramId,
    });
    await assignZone(search.id, DAY_ID, zone.id, { status: 'assigned', assignedTo: telegramId });

    const url = `${process.env.SEARCHER_APP_URL}/s/${token}`;
    try {
      await ctx.telegram.sendMessage(telegramId,
        `You're assigned Zone ${zone.number} for ${search.name}. Open your map: ${url}`);
      if (ctx.chat.type !== 'private') {
        await ctx.reply(`${volunteer.name} → Zone ${zone.number}. Check your DM for the map link.`);
      }
    } catch {
      // Volunteer never started a DM with the bot — roll the assignment back.
      await deactivateLink(token);
      await assignZone(search.id, DAY_ID, zone.id, prev);
      await ctx.reply(
        `${volunteer.name} — I can't DM you yet. Open a chat with me and press Start, then send /available again.`);
    }
  };
}
```

Key changes from the original: `parseAvailableArgs` no longer returns `letters`; `pickZone(zones)` takes no letter/locking args; the `validLetters`/`invalid letters` guard block is removed entirely (there's nothing to validate — `/available` just means "give me whatever's open"); both user-facing messages drop `${zone.letter}` in favor of `${zone.number}`.

- [ ] **Step 8: Run the full telegram-bot test suite**

Run: `cd telegram-bot && npm test`
Expected: PASS — `assign.test.js`, `resolveSearch.test.js`, and every other existing test (`bind.test.js`, `register.test.js`, `tokens.test.js`, `mapImage.test.js`, `messages.test.js`) still green (none of those reference letters or `pickZone`).

- [ ] **Step 9: Commit**

```bash
git add telegram-bot/src/assignment/assign.js telegram-bot/test/assignment/assign.test.js telegram-bot/src/search/resolveSearch.js telegram-bot/test/search/resolveSearch.test.js telegram-bot/src/commands/available.js
git commit -m "fix(bot): /available drops letter selection, grabs next open flat-numbered zone"
```

---

## Post-Plan Verification

After all 9 tasks:

1. Run every package's full test suite from repo root:
   ```bash
   cd command-center && npm test && cd ../searcher-app && npm test && cd ../telegram-bot && npm test
   ```
   Expected: all green.
2. Build both frontend apps:
   ```bash
   cd command-center && npm run build && cd ../searcher-app && npm run build
   ```
   Expected: both succeed.
3. Full end-to-end manual smoke test on a fieldtest preview channel (per this repo's existing fieldtest workflow): create a search, draw a boundary, generate zones at each of the three size presets and visually confirm compact (not strip-shaped) zones with roughly-even sizes, claim a zone through the picker, mark it complete, confirm GPS tracking stops and the picker lets you pick a new zone, confirm the just-completed zone's track line persists on the Command Center map while its live position dot disappears (both from the earlier fieldtest fix, unaffected by this plan but worth reconfirming end-to-end).
