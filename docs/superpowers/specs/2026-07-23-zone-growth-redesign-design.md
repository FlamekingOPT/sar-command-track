# Zone Growth Redesign — Compact-First Clustering — Design

**Date:** 2026-07-23
**Status:** Approved (Jack, 2026-07-23).

## Problem

The 2026-07-19 zone-algorithm-quality spec diagnosed non-compact zones as one of five field-confirmed issues, and its Part B (`refineZoneBoundaries`, a scored post-growth patch) was built and reviewed as the fix. Wiring it into production (Task 7 of `docs/superpowers/plans/2026-07-20-zone-algorithm-quality.md`) surfaced two things:

1. A genuine formula bug in `refineZoneBoundaries`'s weight-balance scoring (recomputing "fair share" against a shrinking region count made it systematically over-merge), only fully exposed once tested against real data.
2. Even after correcting that bug, empirical validation against a real 143-zone West LA search showed the patch approach has a low ceiling: it can only rearrange zones that greedy growth already built badly — it cannot fix a zone that was bad from the moment it was grown.

Jack proposed a different idea during this same session: instead of growing zones outward block-by-block until a target size is hit (today's approach, with zero shape objective), decide the target zones geometrically first — compact, roughly equal in effort — and *then* assign real street-blocks to them. Tested empirically against the same real boundary before writing this spec:

| Metric | Today's growth algorithm | Compact-first clustering (tested) |
|---|---|---|
| Median compactness (isoperimetric quotient, 1.0=circle) | 0.531 | 0.586 |
| Zones below 0.25 compactness | 11 / 143 | 3 / 144 |
| Zones fully containing a motorway segment | 8 / 143 | 7 / 147 |

The motorway-crossing count is essentially unchanged by design, not by oversight — see "Known separate issue" below.

## Known separate issue (out of scope for this spec)

10 of 1324 individual *blocks* were confirmed to already fully contain a motorway segment before any zone-grouping step runs at all — a `buildBlocks`/`turf.polygonize` topology limitation (motorways are grade-separated, so a real motorway way rarely shares an exact vertex with the surface street grid except at interchanges; `polygonize` can only cut along edges that share exact coordinates, so a stretch with no nearby interchange never gets used as a splitting edge). No zone-*grouping* strategy — greedy growth, the k-means approach here, or anything else — can fix a block that was already built wrong. Jack has explicitly accepted this as a known, separate issue ("I can live with the motorway pass") to be fixed independently (candidate fixes were scoped during this session's investigation: a post-hoc validation/repair pass, splitting faces against hard lines directly, or snapping hard-line endpoints before polygonize — not designed in detail here).

## Design

### Architecture

`mergeBlocksToZones` keeps its exact existing signature (`blocks, adjacency, zoneCount, { efforts }`) and return shape (an array of zone `Polygon` features) — no caller changes needed anywhere (`SearchDetail.jsx` and its tests are unaffected). Its outer structure is unchanged:

1. Compartment detection via soft-only adjacency (a compartment is a set of blocks reachable from each other without crossing a hard road) — unchanged.
2. Per-compartment zone-count allocation, proportional to effort share, minimum 1 per compartment — unchanged (same logic already in this function).
3. **Region-forming — replaced.** Today: greedy BFS growth toward a weight target. New: weighted k-means clustering of the compartment's blocks (below).
4. Runt absorption (fold a too-small zone into its best neighbor, preferring soft, falling back across a hard road only as a last resort) — **restored to its original, pre-2026-07-20-session form.** The `bestHard` fallback removed during this session's Task 7 experimentation goes back in unchanged; nothing else replaces its job now that `refineZoneBoundaries` is being removed.
5. Multi-part/sliver geometric cleanup sweep — unchanged.

### The clustering algorithm (replaces step 3 above)

For each compartment, given its allocated zone count `k`:

**Seeding — deterministic, no `Math.random`:**
- First seed: the block with the highest effort weight (tie broken by lowest block index).
- Each subsequent seed (until `k` seeds exist): the not-yet-picked block whose distance to its *nearest* existing seed is largest — farthest-point sampling (ties broken by lowest block index). This spreads seeds across the compartment's shape instead of clustering them together, which is what produced the compact, well-separated result in testing.
- `k <= 1` or a 1-block compartment: skip clustering, return the single trivial cluster (matches this file's existing `length <= 1` guard pattern, e.g. in `orderZonesForNumbering`).

**Assignment + refinement (Lloyd's algorithm):**
- Assign every block to its nearest seed by centroid distance (`turf.centroid`).
- Recompute each cluster's center as the effort-weighted average of its assigned blocks' centroids (a heavy block pulls the center toward itself more than a light one — this is what keeps clusters effort-balanced, not just area-balanced).
- Repeat assignment against the updated centers.
- Terminate when a full pass reassigns nothing, or after **20 iterations** (the cap validated empirically against the real test boundary; a hard cap independent of convergence, matching this file's existing termination-safety philosophy elsewhere).

### After clustering

- **Union into polygons:** each cluster's blocks combine into one zone polygon via the existing `safeUnion` (identical technique already used elsewhere in this file).
- **Non-contiguous clusters get split, not forced together:** nearest-centroid assignment doesn't guarantee every block in a cluster actually touches the others (rare — 3 of 144 clusters in the real test). Any cluster whose blocks aren't all mutually reachable (reusing the same block-adjacency graph, a BFS reachability check) is split into one zone per contiguous part, the same "don't force a disconnected shape into one zone" principle this file already applies to multi-part polygonize artifacts.
- **Runt absorption and the final sliver sweep run exactly as they do today** (see Architecture step 4-5) — both are about geometry/balance problems orthogonal to how blocks got grouped.

### What's removed

`refineZoneBoundaries`, `isConnected`, and its five scoring constants (`WEIGHT_BALANCE_SCORE_WEIGHT`, `COMPACTNESS_SCORE_WEIGHT`, `BOUNDARY_QUALITY_SCORE_WEIGHT`, `HARD_ROAD_CROSSING_PENALTY`, `MOVE_ACCEPTANCE_THRESHOLD`, `MAX_MOVES_PER_BLOCK`) — the entire scored post-growth patch from the 2026-07-19 spec's Part B. Its job (compact, balanced zones) is now done by construction during clustering, not patched after the fact. The `bestHard` removal from the runt-absorption loop (made during this session's Task 7 work, in anticipation of `refineZoneBoundaries` taking over that decision) is reverted alongside it.

### What's kept

- `isoperimetricQuotient` (Task 5, 2026-07-19 plan) — stays exported. Still useful for reporting/comparing shape quality even without a live scoring pass consuming it; this is exactly what produced the compactness numbers in this spec's own validation table.
- The `roadClass` field on adjacency edges (Task 5) — stays, currently has no consumer. Harmless to leave; may feed a future "snap a boundary to a named road" feature.
- Everything from Tasks 1-4 of the 2026-07-20 plan (terrain-aware fetching and block-splitting) — entirely independent of how blocks get grouped into zones, unaffected by this redesign.

## Testing

Extend `subdivider.test.js`:
- Deterministic seeding: identical inputs produce identical cluster assignments across repeated calls (no `Math.random` anywhere in the implementation).
- Effort-weighted balancing: a case with unevenly-weighted blocks (mirroring existing tests like the dense-vs-sparse block scenarios already in this file) confirms clusters balance by effort, not raw block count.
- Non-contiguous cluster splitting: a constructed case where nearest-centroid assignment would group two non-touching blocks together, confirming they emerge as separate zones.
- Hard-road respect: confirms no cluster ever spans two compartments (i.e., never crosses a hard road) — compartments are computed before clustering starts, so this should hold by construction, but needs a regression test given how much this file's history has been shaped by exactly this kind of violation.
- Full existing suite re-run: every current `mergeBlocksToZones`/`generateZones` test should pass with its original (pre-2026-07-20-session) expectations once `bestHard` is restored — including the median-sliver hard-road-absorption tests that Task 7's experimentation temporarily broke.
- Real-boundary regression: re-run against the same reconstructed West LA boundary used for this spec's validation table, confirming compactness/count numbers are in the same range reported above (not necessarily identical, since production block/effort data may differ slightly from the throwaway test harness's reconstructed boundary).

## Out of scope

- Fixing the motorway-crossing bug itself (see "Known separate issue" above) — a future spec.
- Any road-quality/boundary-snapping feature using the now-unused `roadClass` field — future work, not this redesign.
- Renaming `mergeBlocksToZones` to better reflect that it clusters rather than grows/merges — kept the existing name to avoid touching every call site and test reference for a pure rename; the function's doc comment will explain the new mechanism.

## Next session — START HERE

1. Run this spec through `writing-plans` to produce an implementation plan (`docs/superpowers/plans/YYYY-MM-DD-zone-growth-redesign.md`), then execute via `subagent-driven-development`.
2. `command-center/src/zones/subdivider.js` is at the clean Task-6-committed baseline (commit `72d11a9` of the 2026-07-20 plan) — `refineZoneBoundaries`/`isConnected`/its constants exist there and need removing per this spec, not building on top of.
3. Throwaway validation scripts from this session's testing (`command-center/scratch-*.mjs`, untracked, not committed) contain a working prototype of the k-means clustering logic (seeding, Lloyd's iteration, non-contiguous splitting, motorway-crossing check) — useful as a reference for the real implementation, not production-ready code (no error handling for edge cases beyond what was needed to validate the idea, uses `require`-style CommonJS imports for standalone Node execution rather than this project's ES module conventions). Safe to delete once the real implementation lands.
4. The motorway-crossing bug (see "Known separate issue" above) remains open — pick up when Jack prioritizes it, starting with the recommended fix (a post-hoc validation/repair pass) from this session's investigation.
