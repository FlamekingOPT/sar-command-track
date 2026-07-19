# Zone Generation Algorithm Quality — Design

**Date:** 2026-07-19
**Status:** Approved (Jack, 2026-07-19).

## Problem

Field review of a live 37-zone WeHo/Beverly Hills/Koreatown search (2026-07-16) surfaced five algorithm-quality issues, all traced to `subdivider.js`/`overpass.js`:

1. A golf course is invisible to the algorithm (only `highway`+`waterway` ways are fetched), so when the block containing it needs local refinement, it falls back to a straight rectangular grid that cuts across the course.
2. Region growth (`mergeBlocksToZones`) is greedy BFS toward a weight target with zero shape objective, producing elongated/notched zones as a side effect.
3. A hard-road-isolated compartment floors at 1 zone (`allocateZoneCounts`'s `max(1, ...)`) even when tiny, and today's runt absorption only reaches across a hard road as an all-or-nothing "last resort," not a judged tradeoff.
4. `mergeBlocksToZones`'s final sweep leaves a graph-isolated tiny zone standing rather than risk erasing real area (the 2026-07-16 park-erasure fix's deliberate tradeoff) — but some of these could still be merged into a better-fitting neighbor if the merge were actually evaluated rather than skipped for lack of a shared edge.
5. A zone border landed on an arbitrary residential street one block off of Vermont Ave, when using Vermont as the split point would have produced a more even division. Not a "snap to named roads" preference — the actual complaint is that greedy growth locked in a worse split than was available, and nothing re-checks after the fact.

Jack wants this addressed with AI-assisted **design** (this document) producing better deterministic heuristics — not an LLM call at zone-generation time. The design should leave room to bolt on an LLM critique/adjustment step later without a rewrite (e.g. as an optional pass after today's output), but that is out of scope to build now.

## Key insight

Issues #2, #3, #4, and #5 are one problem, not four: **once greedy growth glues blocks into a zone, that decision is final.** Nothing ever revisits a border after the fact, even when a neighboring zone, a rounder shape, or a more sensible road would clearly have been better. The fix is a single new mechanism — a scored boundary-refinement pass that runs after today's greedy growth and re-evaluates every zone border — rather than four separate patches.

Issue #1 (feature-blindness) is a separate, independent fix to what the algorithm can *see* before it splits anything.

## Design

### Part A — Feature-aware fetching (issue #1)

Add way queries for `leisure=golf_course|park`, `landuse=cemetery`, and `natural=wood` to both `overpass.js`'s live query and `tools/prefetch-streets.mjs`'s cache-prep query — they must stay in sync (existing tile-scheme requirement). These tags return polygons, not lines; also add `highway=path|footway` (currently excluded from every `DETAIL_LEVELS` tier) so paths inside these features are available for splitting.

`buildBlocks`'s existing local-refinement branch (`targetZoneCount > 0`, the one that already recurses into `buildBlocks` with local street data when a block's effort exceeds its zone share) is extended: when the oversized block overlaps one of these feature polygons, the feature's own boundary ring, plus any internal path/footway ways inside it, are added as edges to that local `polygonize` call. A golf course now splits along its actual shape and cart paths instead of a straight grid line. `gridZones` remains the fallback only when the feature has no internal paths to work with.

Per Jack: the feature does **not** need to stay whole or avoid being split — being included in one zone or split across several is fine. The only requirement is that the resulting shape/border be sensible, which Part B's refinement pass enforces regardless of how the initial split happened.

**Scope limit:** only simple closed-way polygons (the common OSM representation for these tags). Multipolygon relations (rare for golf/park/cemetery, used for shapes with holes) are skipped with a console warning — not a blocker for this iteration.

### Part B — Scored boundary-refinement pass (issues #2, #3, #4, #5)

New function, e.g. `refineZoneBoundaries(regions, blocks, adjacency, weights)`, runs after `mergeBlocksToZones`'s existing growth + runt-absorption produces its initial regions, and before the final multi-part/sliver geometric sweep. It requires block-level adjacency and per-block weights, so it's skipped entirely for grid-fallback boundaries (no street/adjacency data) and for the trivial 1-zone case, matching the existing `polys.length <= 1` guard pattern elsewhere in this file.

**Mechanism:** for every pair of zones sharing a block-level adjacency edge, consider moving each of zone A's blocks that borders zone B over to zone B (and vice versa). Score each candidate move as a weighted sum of:

- **Weight balance** — does the move bring both zones' effort closer to the fair-share target used during growth? (reuses the same `weights`/effort values already computed by `computeBlockEfforts`)
- **Compactness** — isoperimetric quotient `4π·Area/Perimeter²` (1.0 = circle, lower = elongated/notched) computed for both zones before and after the move; the move should raise the average, not lower it.
- **Boundary quality** — the road class nearest the resulting shared border, scored by class (secondary/tertiary tiers score higher than residential/unclassified/no-road-at-all). This reuses `sharedAdjacency`'s existing midpoint-to-line-distance technique, extended to report the nearest road's class rather than just hard/soft.
- **Hard-road-crossing penalty** — a large fixed penalty applied only when the move's justifying adjacency edge is `hard` (motorway/trunk/primary/waterway). This replaces today's binary "never, except as last resort" rule with a continuous tradeoff: a marginal move loses to the penalty, but a move that rescues an isolated floor-locked compartment (issue #3) or merges a standing sliver into a much-better-fitting neighbor (issue #4) can still win if the combined weight-balance and compactness gain is large enough.

A move is applied only if its combined score is clearly positive (threshold constant, tunable — same philosophy as this file's existing `RUNT_FRACTION`/`RUNT_AREA_FRACTION` knobs). After a move, the pass re-scores the borders it touched and continues; it terminates when a full pass over all zone-pair borders finds no more improving move, or when a hard cap on total moves is reached (bounded as a multiple of block count) — a hard cap independent of convergence behavior, so this cannot reproduce the class of hang the 2026-07-16 park-erasure fix hit in `mergeBlocksToZones`.

**Safety constraints on every candidate move**, mirroring this file's existing defensive style:
- The move must not disconnect either zone's remaining blocks (verified by a BFS reachability check over the losing zone's blocks before committing — cheap relative to the geometry operations already done per move).
- The move must not reduce either zone to zero blocks.
- Polygon reconstruction after moves reuses `safeUnion`; a move whose resulting geometry can't be safely unioned is discarded, not forced.

**Data flow change required:** `mergeBlocksToZones` currently discards which blocks belong to which zone once it builds final polygons (`polys = regions.filter(...).map(...)`). It needs to expose the region→block-indices mapping (or run refinement before that flattening step) so Part B can operate on block membership directly rather than re-deriving it from geometry.

## Testing

Extend `subdivider.test.js`/`overpass.test.js` with:
- A synthetic golf-course-shaped feature inside an oversized block, asserting the split follows the feature's boundary/paths rather than a grid.
- A synthetic case mirroring the Vermont Ave scenario (two adjacent zones, an available named-road split that's more even than the current one), asserting refinement moves the border to it.
- A synthetic hard-road-isolated single-block compartment next to a much larger soft-connected zone, asserting refinement merges it when the weight-balance gain clearly outweighs the hard-road penalty, and does NOT merge it when the isolated compartment is legitimately zone-worthy on its own.
- A regression re-run against the real boundaries already used to validate prior fixes — the WeHo/Beverly Hills/Koreatown case (golf course + Vermont Ave) and the dense Westlake case (~174 zones, the one that previously hung in `mergeBlocksToZones`) — confirming no crash, no hang, and a bounded move count.

## Tunable constants (new, alongside this file's existing knobs)

- Composite score weights for weight-balance / compactness / boundary-quality (default equal weighting, field-tuned like everything else in `subdivider.js`).
- Hard-road-crossing penalty magnitude.
- Move-acceptance threshold (minimum positive score to apply a move).
- Max total moves cap (multiple of block count).

## Out of scope

- Any LLM call at zone-generation time. This design produces better deterministic heuristics only; an optional LLM critique/adjustment pass on top of this output is a future addition, not built here.
- OSM multipolygon relations for golf/park/cemetery/wood features (way-only for now).
- Standing-sliver **manual override** UI (Command Center affordance to hand-fix a zone) — that's the separate "manual zone editing" backlog item from the 2026-07-16 handoff review; this design only improves the algorithm's own judgment, not command's ability to override it.
