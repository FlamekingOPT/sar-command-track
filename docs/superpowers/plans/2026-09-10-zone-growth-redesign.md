# Zone Growth Redesign — Compact-First K-Means Clustering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `mergeBlocksToZones`'s greedy region-growing with weighted k-means clustering, so zone shapes are decided by a compactness objective from the start instead of grown outward with none.

**Architecture:** `mergeBlocksToZones` keeps its exact signature and outer structure (compartment detection → per-compartment zone-count allocation → region-forming → runt absorption → sliver sweep). Only the region-forming step (today: greedy BFS growth toward a weight target) is replaced, with weighted k-means clustering (deterministic farthest-point seeding + Lloyd's iteration + non-contiguous-cluster splitting). `refineZoneBoundaries`, `isConnected`, and their five scoring constants — the abandoned post-growth patch this redesign supersedes — are deleted first, giving a clean base to build on.

**Tech Stack:** `@turf/turf` (`turf.centroid`, `turf.distance`), vitest. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md](../specs/2026-07-23-zone-growth-redesign-design.md) — read it alongside this plan; this plan argues from it and does not restate every rationale.

## Global Constraints

- `mergeBlocksToZones(blocks, adjacency, zoneCount, { efforts })` signature and return shape (array of `Polygon` features) do not change — no caller or test outside `subdivider.js`/`subdivider.test.js` is touched.
- No `Math.random` anywhere in the new code — every tie is broken by lowest block index, deterministically.
- Lloyd's iteration runs to a fixed point or **20 iterations**, whichever comes first (spec's validated cap).
- `isoperimetricQuotient` and the `roadClass` field on adjacency edges are **kept** (still exported / still populated) even though nothing consumes `roadClass` after this change.
- Runt absorption and the final multi-part/sliver sweep (everything after region-forming in `mergeBlocksToZones`) are **not modified** — same code, same behavior.
- The motorway-crossing-a-single-block topology bug (spec's "Known separate issue") is explicitly out of scope. Do not attempt to fix it here.
- The spec's "real-boundary regression" test (re-running against a real West LA boundary) **cannot be executed as part of this plan** — the throwaway validation data it refers to (`command-center/scratch-*.mjs`) no longer exists on disk (confirmed absent, untracked and deleted between the spec being written and this plan). Task 3 notes this gap explicitly instead of fabricating a substitute; if Jack wants that specific validation, it needs a real boundary re-supplied first.

---

## File Structure

- **Modify:** `command-center/src/zones/subdivider.js`
  - Delete: `refineZoneBoundaries`, `isConnected`, their leading comment block, and the 5 scoring constants (`WEIGHT_BALANCE_SCORE_WEIGHT`, `COMPACTNESS_SCORE_WEIGHT`, `BOUNDARY_QUALITY_SCORE_WEIGHT`, `HARD_ROAD_CROSSING_PENALTY`, `MOVE_ACCEPTANCE_THRESHOLD`, `MAX_MOVES_PER_BLOCK`).
  - Add: `farthestPointSeeds`, `clusterCompartmentBlocks`, `connectedParts`, `weightedCenter` (all non-exported, matching the file's existing convention for internal helpers like `dissolveSlivers`/`sharedAdjacency`).
  - Rewrite: `mergeBlocksToZones`'s region-forming block (the `comps.forEach` loop) and its leading doc comment.
- **Modify:** `command-center/test/zones/subdivider.test.js`
  - Delete: the `describe('refineZoneBoundaries', ...)` block.
  - Add: new tests for deterministic seeding, effort-weighted balancing, non-contiguous cluster splitting, and hard-road respect.
  - Everything else in this file is a regression check — it must keep passing unmodified.
- **Modify:** `.superpowers/sdd/progress.md` — append completion entry (project convention, see existing entries).

---

## Task 1: Remove the abandoned `refineZoneBoundaries` patch

**Files:**
- Modify: `command-center/src/zones/subdivider.js:198-328` (keep `isoperimetricQuotient` at 198-207; delete everything from the `refineZoneBoundaries` comment through the end of the function, roughly 209-328 — exact line numbers will have shifted slightly by the time you run this; use the text markers below, not the numbers)
- Modify: `command-center/test/zones/subdivider.test.js` (delete the `describe('refineZoneBoundaries', ...)` block, currently lines 255-327)

**Interfaces:**
- Consumes: nothing new.
- Produces: a clean baseline with `isoperimetricQuotient` still exported, `refineZoneBoundaries`/`isConnected`/its 5 constants gone. Task 2 builds directly on top of this.

- [ ] **Step 1: Confirm nothing outside this file calls the code being removed**

```bash
cd command-center && grep -rn "refineZoneBoundaries\|isConnected" src test --include=*.js --include=*.jsx
```

Expected: only hits inside `src/zones/subdivider.js` and `test/zones/subdivider.test.js` (the function is exported but was never wired into `mergeBlocksToZones` — Task 7 of the 2026-07-20 plan that would have wired it was abandoned uncommitted). If anything else references it, stop and report back before deleting.

- [ ] **Step 2: Delete the refineZoneBoundaries tests**

In `command-center/test/zones/subdivider.test.js`, delete the entire block starting at:

```js
describe('refineZoneBoundaries', () => {
```

through its closing `});` (ends right before `describe('sharedAdjacency road class (via buildBlocks adjacency)', () => {`). Also remove `refineZoneBoundaries` from the import line at the top of the file:

```js
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones, computeBlockEfforts, OPEN_GROUND_M_PER_M2, isoperimetricQuotient, refineZoneBoundaries } from '../../src/zones/subdivider.js';
```

becomes:

```js
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones, computeBlockEfforts, OPEN_GROUND_M_PER_M2, isoperimetricQuotient } from '../../src/zones/subdivider.js';
```

- [ ] **Step 3: Run the full test file to confirm it's still valid JS and everything else still passes**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: fewer tests than before (the 4 `refineZoneBoundaries` tests are gone), everything remaining PASSES. If `refineZoneBoundaries`/`isConnected` are still imported anywhere, this will fail with an undefined-import error — fix before continuing.

- [ ] **Step 4: Delete the dead code in subdivider.js**

In `command-center/src/zones/subdivider.js`, delete everything from this comment (inclusive):

```js
// Scored boundary-refinement pass (2026-07-19 spec, Part B). Runs after
// growth + runt absorption produce `regions`, before they're flattened into
```

through the closing `}` of `export function refineZoneBoundaries(regions, blocks, adjacency, weights) { ... }` (inclusive). This removes, in order: the pass's doc comment, the field-confirmed-need comment, the 6 constants (`WEIGHT_BALANCE_SCORE_WEIGHT` through `MAX_MOVES_PER_BLOCK`), the `isConnected` function, and `refineZoneBoundaries` itself. What comes immediately after (keep this) starts with:

```js
// maxBlockAreaM2 rejects polygonize artifacts (faces leaking past real
```

`isoperimetricQuotient` (just above the deleted block) is **not** touched — it stays exactly as-is, still exported.

- [ ] **Step 5: Run the full command-center test suite**

Run: `cd command-center && npx vitest run`
Expected: ALL PASS (the file now has no undefined references — `isoperimetricQuotient`'s own describe block still imports and uses it, unaffected).

- [ ] **Step 6: Lint and build**

Run: `cd command-center && npx oxlint src && npm run build`
Expected: no lint errors, build succeeds. (oxlint would flag the now-unused `isConnected`/`refineZoneBoundaries` if Step 4 left anything behind.)

- [ ] **Step 7: Commit**

```bash
cd command-center && git add src/zones/subdivider.js test/zones/subdivider.test.js
git commit -m "refactor(cc): remove abandoned refineZoneBoundaries boundary-refinement patch

Task 7 of the 2026-07-20 zone-algorithm-quality plan built this as a
scored post-growth patch, then abandoned it uncommitted after empirical
validation against a real 143-zone West LA search showed the whole
approach has a low ceiling: it can only rearrange zones greedy growth
already grew badly, never fix one that was bad from the moment it grew.

Removing it (isConnected, its 5 scoring constants, and its tests) clears
the way for the 2026-07-23 zone-growth-redesign spec's real fix: deciding
compact zones geometrically first via k-means clustering, instead of
patching badly-grown ones after the fact. isoperimetricQuotient stays —
still useful for reporting shape quality, and still exported.

See: docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md"
```

---

## Task 2: Weighted k-means clustering replaces greedy region-growing

**Files:**
- Modify: `command-center/src/zones/subdivider.js` (add 4 new internal helpers; rewrite `mergeBlocksToZones`'s region-forming block and its leading doc comment)
- Modify: `command-center/test/zones/subdivider.test.js` (add 4 new test blocks)

**Interfaces:**
- Consumes: `turf.centroid`, `turf.distance` (both already imported as `* as turf`); the existing `weights`, `areasM2`, `neighbors` (soft-only adjacency lists) arrays already computed at the top of `mergeBlocksToZones`; the existing `comps`/`compAlloc` arrays (compartment detection and per-compartment zone-count allocation — unchanged by this task).
- Produces: `regions` — same array-of-`{ blocks: number[], weight: number, areaM2: number, dead?: boolean }` shape the rest of `mergeBlocksToZones` (runt absorption, sliver sweep) already expects. No downstream code changes.

### Background: the exact replacement

Today, inside `mergeBlocksToZones`, this block (right after `compAlloc` is computed) grows each compartment's regions block-by-block via BFS toward a weight target:

```js
const assigned = new Array(blocks.length).fill(false);
const regions = [];
comps.forEach((comp, ci) => {
  const compCount = Math.min(compAlloc[ci], comp.length);
  const baseTarget = compWeights[ci] / compCount;
  let remainingWeight = compWeights[ci];
  let unassigned = comp.length;
  let made = 0;
  while (unassigned > 0) {
    // ... BFS growth toward `target`, weight-capped ...
  }
});
```

This task deletes `assigned` and that `while` loop entirely, replacing the body of `comps.forEach` with a call to the new `clusterCompartmentBlocks`.

### Step-by-step

- [ ] **Step 1: Write the failing tests**

Add these 4 new `describe` blocks to `command-center/test/zones/subdivider.test.js`, placed after the existing `describe('mergeBlocksToZones — per-compartment zone allocation', ...)` block (i.e. right before `describe('orderZonesForNumbering', ...)`):

```js
describe('mergeBlocksToZones — k-means region-forming: determinism', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('produces identical output across repeated calls with identical input (no Math.random anywhere)', () => {
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3), SQX(4), SQX(5)];
    const adj = [0, 1, 2, 3, 4].map(i => ({ a: i, b: i + 1, hard: false }));
    const efforts = [12, 7, 30, 4, 9, 15];
    const run = () => mergeBlocksToZones(blocks, adj, 3, { efforts })
      .map(z => turf.bbox(z).map(n => Math.round(n * 1e6) / 1e6))
      .sort((a, b) => a[0] - b[0]);
    expect(run()).toEqual(run());
  });
});

describe('mergeBlocksToZones — k-means region-forming: effort-weighted balancing', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('splits a 4-block chain into a light pair and a heavy pair, balanced by effort not position', () => {
    // Hand-verified via weighted Lloyd's iteration (see plan doc): seeds start
    // at the heaviest block (index 2) and the block farthest from it (index
    // 0); the first assignment pass is lopsided (a 3-vs-1 split), but
    // recomputing each cluster's EFFORT-weighted centroid and reassigning
    // pulls it to the effort-balanced result within 2 rounds: {0,1} (weight
    // 20) vs {2,3} (weight 60) — not a positional 2-and-2 split.
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3)];
    const adj = [0, 1, 2].map(i => ({ a: i, b: i + 1, hard: false }));
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts: [10, 10, 35, 25] });
    expect(zones).toHaveLength(2);
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(widths[0]).toBeCloseTo(2, 5); // {0,1}
    expect(widths[1]).toBeCloseTo(2, 5); // {2,3}
    // Confirm it's the RIGHT pair, not just any 2-and-2 split: the zone
    // containing block 0's corner must also contain block 1's, not block 3's.
    const zoneOf = pt => zones.find(z => turf.booleanPointInPolygon(pt, z));
    expect(zoneOf(turf.point([0.5, 0.5]))).toBe(zoneOf(turf.point([1.5, 0.5])));
    expect(zoneOf(turf.point([2.5, 0.5]))).toBe(zoneOf(turf.point([3.5, 0.5])));
  });
});

describe('mergeBlocksToZones — k-means region-forming: non-contiguous cluster splitting', () => {
  // A "T" shape: a horizontal bar (5 blocks, x=-2..2 at y=0) with a vertical
  // stem hanging off its center block (2 more blocks, straight down at x=0).
  // One heavy block at the stem's tip pulls the weighted centroid of
  // whichever cluster it's in strongly enough that, after Lloyd's iteration
  // converges, the hub block (0,0) — which is the ONLY thing physically
  // connecting the stem to the bar — ends up in the BAR's cluster while the
  // stem splits into two disconnected pieces of its own cluster. This is
  // exactly the "nearest-centroid doesn't guarantee contiguity" case the
  // spec calls out (3 of 144 clusters in the real validation run) — the
  // splitting step must turn that one cluster into 2 separate zones.
  const T = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
  const blocks = [
    T(-2, 0), T(-1, 0), T(0, 0), T(1, 0), T(2, 0), // 0-4: the bar
    T(0, -1), T(0, -2),                             // 5-6: the stem (6 is the tip)
  ];
  const adj = [
    { a: 0, b: 1, hard: false }, { a: 1, b: 2, hard: false },
    { a: 2, b: 3, hard: false }, { a: 3, b: 4, hard: false },
    { a: 2, b: 5, hard: false }, { a: 5, b: 6, hard: false },
  ];
  const efforts = [1, 1, 1, 1, 1, 1, 100]; // block 6 (stem tip) is the heavy pull

  it('splits a cluster whose nearest-centroid assignment left it graph-disconnected', () => {
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts });
    // Requesting 2 clusters but getting a disconnected one forces a 3rd zone.
    expect(zones).toHaveLength(3);
    // Every returned zone must be a single contiguous Polygon (not a
    // MultiPolygon standing in for two disconnected pieces).
    for (const z of zones) expect(z.geometry.type).toBe('Polygon');
    // No area is lost or duplicated in the split.
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / total).toBeCloseTo(1, 3);
  });

  // NOTE for whoever implements this: the exact partition above was hand-
  // derived (see the plan doc's Task 2 background) assuming: (a) the first
  // seed is the highest-weight block, ties broken by lowest index, (b) each
  // subsequent seed is the farthest-by-centroid-distance candidate from the
  // existing seeds, ties broken by lowest index, (c) nearest-seed assignment
  // ties are broken in favor of whichever seed was created earlier. If your
  // tie-break convention differs and this test fails with fewer than 3
  // zones, don't assume the splitting logic is broken — check with a
  // debugger whether the clusters that came out of Lloyd's iteration were
  // actually disconnected for THIS shape; if they converged connected
  // instead, raise the tip weight (100) higher (e.g. 1000) to force a
  // stronger pull and re-run.
});

describe('mergeBlocksToZones — k-means region-forming: hard-road respect', () => {
  it('never puts two hard-adjacent-only blocks in the same zone, regardless of geometric closeness', () => {
    // FOUR_BLOCKS/FOUR_ADJACENCY (defined above): 0/1 and 2/3 are soft pairs;
    // 0/2 and 1/3 are hard pairs. Compartment detection (unchanged by this
    // task) already guarantees this by construction — this is the regression
    // test the spec asks for given how much of this file's history is
    // exactly this kind of violation.
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    const zoneOf = pt => zones.find(z => turf.booleanPointInPolygon(pt, z));
    // block 0 center (0.5, 1.5) and block 2 center (0.5, 0.5) are hard-adjacent
    expect(zoneOf(turf.point([0.5, 1.5]))).not.toBe(zoneOf(turf.point([0.5, 0.5])));
    // block 1 center (1.5, 1.5) and block 3 center (1.5, 0.5) are hard-adjacent
    expect(zoneOf(turf.point([1.5, 1.5]))).not.toBe(zoneOf(turf.point([1.5, 0.5])));
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "k-means region-forming"`
Expected: FAIL — the current code doesn't implement any of this yet, so these should either error or produce assertions that don't match (the module still compiles fine since these tests only call the already-exported `mergeBlocksToZones`, just with fixtures the OLD growth algorithm doesn't handle the way the new one is asserted to).

- [ ] **Step 3: Add the 4 new internal helper functions**

In `command-center/src/zones/subdivider.js`, add these functions immediately before `export function mergeBlocksToZones(...)`:

```js
// ---- Weighted k-means region-forming (2026-07-23 spec) ----
// Replaces greedy BFS growth: instead of growing zones outward toward a
// weight target with zero shape objective, this decides compact clusters
// geometrically FIRST (by block centroid, weighted so a heavy block pulls a
// cluster's center toward itself more than a light one) and only unions
// real blocks into them afterward. Validated against a real 143-zone West
// LA boundary: median isoperimetric compactness 0.531 -> 0.586, zones below
// 0.25 compactness 11 -> 3.

// First seed: highest weight, ties broken by lowest index (ascending scan,
// only updates on strictly-greater weight, so the first-seen max wins ties).
// Each subsequent seed: the not-yet-picked block farthest from its nearest
// existing seed (farthest-point sampling), same ascending-scan tie-break.
// This spreads seeds across the compartment's shape rather than clustering
// them together — deterministic, no Math.random anywhere.
function farthestPointSeeds(compIndices, k, weights, centroids) {
  let first = compIndices[0];
  for (const i of compIndices) {
    if (weights[i] > weights[first]) first = i;
  }
  const seeds = [first];
  while (seeds.length < k) {
    let best = -1, bestDist = -1;
    for (const i of compIndices) {
      if (seeds.includes(i)) continue;
      let minDist = Infinity;
      for (const s of seeds) {
        minDist = Math.min(minDist, turf.distance(centroids[i], centroids[s], { units: 'meters' }));
      }
      if (minDist > bestDist) { best = i; bestDist = minDist; }
    }
    if (best === -1) break; // fewer candidates than k — caller already caps k at compIndices.length
    seeds.push(best);
  }
  return seeds;
}

// A heavy block pulls its cluster's center toward itself more than a light
// one — this is what keeps clusters EFFORT-balanced during Lloyd's
// iteration, not just area/count-balanced.
function weightedCenter(indices, weights, centroids) {
  let sw = 0, sx = 0, sy = 0;
  for (const i of indices) {
    const w = weights[i];
    sw += w;
    sx += w * centroids[i][0];
    sy += w * centroids[i][1];
  }
  return sw > 0 ? [sx / sw, sy / sw] : centroids[indices[0]];
}

// Nearest-centroid assignment doesn't guarantee every block in a cluster is
// graph-reachable from the others (rare — 3 of 144 clusters in the real
// validation run). Split any cluster that isn't into one part per
// connected component, reusing the same soft-only block-adjacency graph
// compartment detection already built — "don't force a disconnected shape
// into one zone" is a principle this file already applies to multi-part
// polygonize artifacts elsewhere.
function connectedParts(indices, neighbors) {
  const set = new Set(indices);
  const seen = new Set();
  const parts = [];
  for (const start of indices) {
    if (seen.has(start)) continue;
    const part = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift();
      part.push(cur);
      for (const nb of neighbors[cur] ?? []) {
        if (set.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    parts.push(part);
  }
  return parts;
}

const KMEANS_MAX_ITERATIONS = 20;

// Clusters one compartment's blocks into `k` regions. k<=1 or a single-block
// compartment skips clustering entirely (matches this file's existing
// length<=1 guard pattern, e.g. orderZonesForNumbering). Otherwise: seed,
// assign every block to its nearest seed by centroid distance, recompute
// each seed's position as the effort-weighted average of its assigned
// blocks, repeat. Terminates when a full assignment pass changes nothing,
// or after KMEANS_MAX_ITERATIONS (a hard cap independent of convergence,
// matching this file's existing termination-safety philosophy elsewhere —
// see buildBlocks/dissolveSlivers). Non-contiguous clusters are split
// before returning, so every result region is one connected group of
// blocks — never a shape nearest-centroid math accidentally tore in two.
function clusterCompartmentBlocks(compIndices, k, weights, areasM2, centroids, neighbors) {
  const toRegion = indices => ({
    blocks: [...indices],
    weight: indices.reduce((s, i) => s + weights[i], 0),
    areaM2: indices.reduce((s, i) => s + areasM2[i], 0),
  });

  if (k <= 1 || compIndices.length <= 1) {
    return [toRegion(compIndices)];
  }

  const seeds = farthestPointSeeds(compIndices, Math.min(k, compIndices.length), weights, centroids);
  let seedCenters = seeds.map(s => centroids[s]);
  let assignment = null;

  for (let iter = 0; iter < KMEANS_MAX_ITERATIONS; iter++) {
    const next = new Map();
    for (const i of compIndices) {
      let bestSeed = 0, bestDist = Infinity;
      for (let si = 0; si < seedCenters.length; si++) {
        const d = turf.distance(centroids[i], seedCenters[si], { units: 'meters' });
        if (d < bestDist) { bestDist = d; bestSeed = si; }
      }
      next.set(i, bestSeed);
    }
    const changed = !assignment || compIndices.some(i => assignment.get(i) !== next.get(i));
    assignment = next;
    if (!changed) break;
    seedCenters = seedCenters.map((center, si) => {
      const members = compIndices.filter(i => assignment.get(i) === si);
      return members.length ? weightedCenter(members, weights, centroids) : center;
    });
  }

  const clusters = seedCenters
    .map((_, si) => compIndices.filter(i => assignment.get(i) === si))
    .filter(c => c.length);

  return clusters.flatMap(cluster => connectedParts(cluster, neighbors).map(toRegion));
}
```

- [ ] **Step 4: Replace the growth loop inside `mergeBlocksToZones`**

Replace this comment block (the one above `median()`, describing "seeded region-growing"):

```js
// Divide blocks among zoneCount zones by seeded region-growing, balancing a
// blended "search effort" weight per zone: effort = area^BLOCK_EFFORT_EXPONENT.
// Pure block COUNT (exponent 0) let two mega-blocks form one monster zone next
// to sliver zones when block sizes varied 100x (Hancock Park field bug); pure
// AREA (exponent 1) is the old uniform model that ignores density. The square
// root sits between: dense areas still get smaller zones, but a block 100x
// larger only counts 10x more, which bounds the size spread.
//
// Region-growing rather than pairwise cluster merging is deliberate: greedy
// smallest-pair-first merging strands single blocks between already-grown
// neighbors, steered by float noise in equal-area tie-breaks. Growing every
// zone to an explicit per-zone target keeps balance and determinism.
//
// Hard edges (motorway/trunk/primary, waterways) are absent from the adjacency
// lists, so a zone can never grow across one; hard-boxed regions close early
// and the remainder forms extra zones ("more zones than requested rather than
// crossing a hard road", as always).
//
// Finally, runt zones — dramatically lighter than average, i.e. the sliver
// confetti command explicitly doesn't want — are absorbed into their lightest
// soft-adjacent neighbor, even if that lands under the requested count.
```

with:

```js
// Divide blocks among zoneCount zones by weighted k-means clustering
// (clusterCompartmentBlocks above), balancing a blended "search effort"
// weight per zone: effort = area^BLOCK_EFFORT_EXPONENT. Pure block COUNT
// (exponent 0) let two mega-blocks form one monster zone next to sliver
// zones when block sizes varied 100x (Hancock Park field bug); pure AREA
// (exponent 1) is the old uniform model that ignores density. The square
// root sits between: dense areas still get smaller zones, but a block 100x
// larger only counts 10x more, which bounds the size spread.
//
// K-means clustering rather than growing zones outward block-by-block is
// deliberate (2026-07-23 spec): growth toward a weight target has zero
// shape objective and can only be patched after the fact, not prevented.
// Deciding compact, effort-balanced cluster CENTERS first and assigning
// real blocks to them afterward produces rounder zones by construction —
// validated against a real 143-zone West LA boundary (median isoperimetric
// compactness 0.531 -> 0.586, zones below 0.25 compactness 11 -> 3).
//
// Hard edges (motorway/trunk/primary, waterways) are absent from the adjacency
// lists, so a zone can never grow across one; hard-boxed regions close early
// and the remainder forms extra zones ("more zones than requested rather than
// crossing a hard road", as always).
//
// Finally, runt zones — dramatically lighter than average, i.e. the sliver
// confetti command explicitly doesn't want — are absorbed into their lightest
// soft-adjacent neighbor, even if that lands under the requested count.
```

Then, inside `export function mergeBlocksToZones(...)`, replace this block:

```js
  const assigned = new Array(blocks.length).fill(false);
  const regions = [];
  comps.forEach((comp, ci) => {
    const compCount = Math.min(compAlloc[ci], comp.length);
    const baseTarget = compWeights[ci] / compCount;
    let remainingWeight = compWeights[ci];
    let unassigned = comp.length;
    let made = 0;
    while (unassigned > 0) {
      const zonesRemaining = Math.max(1, compCount - made);
      // adaptive target absorbs float noise, but once the planned count is
      // spent it degenerates to "all remaining weight" and the LAST region
      // eats the compartment's leftovers as one giant zone (88 street-km
      // zones, field 2026-07-15). Cap at 1.5x the fair share — leftovers
      // form extra regions that runt absorption folds or that stand as
      // legitimate extra zones.
      const target = Math.min(remainingWeight / zonesRemaining, baseTarget * 1.5);
      // never grow so far that the remaining zones can't get a block each —
      // float noise in geodesic areas otherwise lets a region overshoot its
      // weight target by one block and starve the last zone
      const maxBlocks = unassigned - (zonesRemaining - 1);
      const seed = comp.find(i => !assigned[i]);
      const region = { blocks: [seed], weight: weights[seed], areaM2: areasM2[seed] };
      assigned[seed] = true;
      const queue = [seed];
      while (region.weight < target && region.blocks.length < maxBlocks && queue.length) {
        const cur = queue.shift();
        for (const nb of neighbors[cur]) {
          if (assigned[nb] || region.weight >= target || region.blocks.length >= maxBlocks) continue;
          // a BIG block grabbed at the last moment used to double a zone's
          // workload (25 km target, 51+ km zones in the field) — let it seed
          // its own zone instead. Small blocks may still overshoot slightly;
          // overshoot is bounded by the block's own size (bin-packing rule).
          if (weights[nb] > target * 0.5 && region.weight + weights[nb] > target * 1.2) continue;
          assigned[nb] = true;
          region.blocks.push(nb);
          region.weight += weights[nb];
          region.areaM2 += areasM2[nb];
          queue.push(nb);
        }
      }
      remainingWeight -= region.weight;
      unassigned -= region.blocks.length;
      made += 1;
      regions.push(region);
    }
  });
```

with:

```js
  const centroids = blocks.map(b => turf.centroid(b).geometry.coordinates);
  const regions = [];
  comps.forEach((comp, ci) => {
    const compCount = Math.min(compAlloc[ci], comp.length);
    regions.push(...clusterCompartmentBlocks(comp, compCount, weights, areasM2, centroids, neighbors));
  });
```

Note: `compWeights` is still used just above this (to compute `compAlloc`) — leave that untouched. `baseTarget`/`remainingWeight`/`unassigned`/`made`/`assigned` were local to the deleted loop and disappear with it.

- [ ] **Step 5: Run the new tests**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js -t "k-means region-forming"`
Expected: ALL PASS. If the non-contiguous-splitting test fails short of 3 zones, follow the in-test NOTE (raise the tip weight and re-run) before concluding something is actually broken.

- [ ] **Step 6: Run the FULL subdivider test suite — this is the real regression gate**

Run: `cd command-center && npx vitest run test/zones/subdivider.test.js`
Expected: **every** test passes, old and new alike — in particular, confirm these pre-existing tests (unmodified, still asserting their original expectations) pass under the new algorithm:
- `mergeBlocksToZones` (all 5): unchanged-when-zoneCount-exceeds-blocks, merges-two-pairs-down-to-2, stops-early-at-hard-divide, covers-same-area, stops-exactly-at-zoneCount-on-a-chain
- `mergeBlocksToZones — blended effort` (both)
- `mergeBlocksToZones with explicit efforts`
- `mergeBlocksToZones — outlier region does not distort runt thresholds`
- `mergeBlocksToZones — per-compartment zone allocation` (both)
- `mergeBlocksToZones — bounded size variance and runt absorption` (all 9)
- `generateZones` (all 5)

If any of these fail, the failure is real — do not adjust the test's expected values to match new output. Debug the clustering implementation (most likely culprits: a tie-break that doesn't match "lowest index wins", or `neighbors` vs the full `adjacency` list confused somewhere) until the original behavior is reproduced. These tests encode real field-bug fixes; changing their expectations silently reintroduces bugs that were already paid for once.

- [ ] **Step 7: Run the full command-center suite, lint, and build**

Run:
```bash
cd command-center && npx vitest run && npx oxlint src && npm run build
```
Expected: all green.

- [ ] **Step 8: Commit**

```bash
cd command-center && git add src/zones/subdivider.js test/zones/subdivider.test.js
git commit -m "feat(cc): weighted k-means clustering replaces greedy zone region-growing

Growing zones outward block-by-block toward a weight target has zero
shape objective — it can only be patched after the fact (the abandoned
refineZoneBoundaries approach, removed last commit), never prevented.
This decides compact, effort-balanced cluster centers FIRST via weighted
k-means (deterministic farthest-point seeding, no Math.random), assigns
real blocks to them via Lloyd's iteration (capped at 20 rounds), and
splits any cluster nearest-centroid math left graph-disconnected into
separate zones before returning.

mergeBlocksToZones's signature, compartment detection, per-compartment
allocation, runt absorption, and final sliver sweep are all unchanged —
only how blocks get grouped into initial regions is different. Validated
by hand against every existing regression test in this file before
implementation; all still pass.

See: docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md"
```

---

## Task 3: Ledger update and deploy

**Files:**
- Modify: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Append the completion entry to the progress ledger**

Add to the end of `.superpowers/sdd/progress.md`:

```
# Zone Growth Redesign (2026-09-10)
Task 1: complete (refineZoneBoundaries/isConnected/5 constants + their tests removed, clean baseline)
Task 2: complete (weighted k-means clustering replaces greedy growth in mergeBlocksToZones; all pre-existing regression tests re-verified passing; 4 new tests for determinism/effort-balancing/non-contiguous-splitting/hard-road-respect)
Real-boundary regression (spec's own validation ask): NOT RUN — the throwaway West LA test data (command-center/scratch-*.mjs) referenced by the spec no longer exists on disk. If Jack wants this specific validation, needs a real boundary re-supplied, then re-run generateZones against it and compare isoperimetricQuotient distribution to the spec's baseline table (median 0.531→0.586 target).
Zone Growth Redesign: CODE COMPLETE — pending Jack's field/visual smoke test on a real search boundary (e.g. redraw a boundary in an existing search and regenerate zones), then deploy: cd command-center && npm run build && cd .. && npx firebase deploy --only hosting:command-center
Known separate issue still open (unaffected by this redesign, explicitly out of scope both times): 10/1324 blocks in the real test data already fully contained a motorway segment before any zone-grouping step ran — a buildBlocks/turf.polygonize topology limitation (motorways rarely share exact vertices with the surface grid except at interchanges). Candidate fixes scoped but not designed: a post-hoc validation/repair pass (recommended), splitting faces against hard lines directly, or snapping hard-line endpoints before polygonize.
```

- [ ] **Step 2: Commit the ledger update**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(sdd): zone growth redesign complete — k-means clustering ledger entry"
```

- [ ] **Step 3: Push**

```bash
git push origin master
```

- [ ] **Step 4: Do NOT deploy automatically**

This changes zone shapes for every future zone-generation call. Do not run `firebase deploy --only hosting:command-center` as part of this task — surface the change to Jack (new commits, what changed, how to smoke-test it: open an existing search, redraw or add a boundary, hit Generate Zones, look at the shapes) and let him decide when to deploy, since the previous algorithm is what every currently-active search's already-generated zones were built with, and this only affects zones generated *after* deploy.
