# Zone generator quality fixes — design

**Status:** approved in direction, spec under review. Targets `command-center/src/zones/subdivider.js`.

## Why

Zone generation was rolled back to a plain even grid (2026-09-17) because the street-aware generator produced bad zones. On 2026-10-26 Jack evaluated a fresh 35-zone run (street-aware `generateZones`, Beverly Hills) on a live map rater and flagged specific, reproducible defects. This spec turns those findings into concrete code fixes, prioritized by severity for search-and-rescue. Each defect is grounded in the actual generator code and, where possible, in a measurement from the evaluated run.

The evaluated run was produced by `generateZones(boundary, 40, hardLines, softLines)` at district detail over a ~9.6 km² boundary; 35 zones resulted.

## Scope

Fixes P1–P4 below, all in `subdivider.js` (`buildBlocks` / `mergeBlocksToZones` and their helpers). P5 (snap edges to named streets) is noted but deferred — it overlaps the separate barrier-classifier project and is the only finding that needs ML rather than a deterministic fix.

Out of scope: reviving the UI wiring (the generator is currently unwired; the grid path is live). This spec fixes the algorithm; shipping it to production is a separate later decision.

## P1 — Coverage gap (most serious: unsearched ground)

**Finding:** the LA Country Club has no zone. Any area with no internal streets is left uncovered. For SAR this is the worst failure — a missing person could be in open ground that no zone assigns to a searcher.

**Root cause (confirmed):** `subdivider.js:357` filters polygonized faces to `turf.area(f) < maxBlockAreaM2`, dropping over-cap faces. A large streetless region (golf course, park, big lot) polygonizes into ONE huge face that exceeds the cap, so it is dropped *before* the local-refinement step (`:371–411`) whose grid-fallback (`:405–409`) would otherwise fill a streetless block with grid cells. So the over-cap face never reaches the code that would cover it.

This exact fix existed and was lost: the 2026-07-26 commit `4351e13` ("the cap is now a must-refine trigger, not a delete") raised coverage on a real Hollywood Hills boundary from 14.8% to 100.7%. The current rebuilt `subdivider.js` does not have it.

**Fix:** stop dropping over-cap faces. Faces larger than `maxBlockAreaM2` that lie inside the boundary are kept and force-routed into the refinement path, where a streetless one falls back to a grid split (`gridZones`). Keep a guard that still discards true polygonize artifacts (degenerate/near-zero-width faces), but never discard a legitimate large face for size alone. After generation, assert coverage: `area(boundary) − area(union(zones))` should be near zero; a gap is a test failure.

**Risk:** low–moderate. Grid-splitting a genuine artifact produces small artifact cells instead of a coverage hole — the better failure. Must re-verify the cap still rejects the polygonize garbage it was added for.

## P2 — Overlapping zones (correctness)

**Finding:** zones 1 and 2 overlap — zone 2 (~100,000 m²) sits largely inside zone 1 (~220,000 m²). Measured: 12 of zone 2's 51 vertices fall inside zone 1's polygon, and zone 2's bounding box is contained in zone 1's. Zones are unions of disjoint street-blocks, so they must never overlap.

**Root cause (to confirm during implementation):** zones are assembled at `:749–751` as `safeUnion` reductions over each region's blocks, then MultiPolygon parts are split at `:758–760`. Overlap most plausibly enters through (a) block refinement producing overlapping sub-blocks (`gridZones` cells or recursive `buildBlocks` splits at `:378–410`), or (b) a `safeUnion` topology artifact. The contiguity split at `:758` separates disconnected parts but does not prevent two regions' polygons from overlapping.

**Fix:** two parts. (1) Enforce disjointness as a hard invariant: after zone polygons are built, clip each zone against the union of already-emitted zones so no two zones share area (last-writer-loses, or assign shared area to the larger zone — decide in the plan). (2) Investigate and fix the source so the repair pass is a safety net, not a crutch. Add a regression test asserting pairwise-disjoint zones on a fixture that currently overlaps.

**Risk:** moderate. Clipping must not create slivers or drop real area; the clipped-away area must still belong to exactly one zone.

## P3 — Narrow arms (compactness)

**Finding:** systematic. ~8 of 35 zones are stringy — isoperimetric quotient (IQ) below 0.45 vs 0.62 median: zones 1 (0.20), 20 (0.31), 15 (0.36), 8 (0.41), 4 (0.41), 25 (0.43), 3 (0.45), 17 (0.48). Jack rated zone 25 "bad shape — the small arm on top" and flagged zone 20's long arm, confirming the pattern by eye.

**Context:** `mergeBlocksToZones` already uses k-means for compactness (validated median IQ 0.531→0.586 on a real 143-zone boundary) and `isoperimetricQuotient` already exists (`:207`). It is not enough — a fifth of zones still come out stringy.

**Fix (two candidate levers, plan picks one or both):**
1. Block-level: extend the local-refinement trigger (`:378–411`) to also re-split a block whose own IQ is bad, not only when its street-effort exceeds target — the scoped fix proposed in the 2026-09-16 handoff entry, reusing the existing re-polygonize / grid-fallback machinery. Lowest-risk; touches only `buildBlocks`.
2. Zone-level: add a compactness penalty to the k-means assignment so a block join that would make a zone stringy is discouraged. More direct for zone shape; more surface area in the clustering math.

**Fix target:** drive zones below ~0.45 IQ toward the median without distorting the already-good ones. Measure median IQ and count-below-0.45 before/after on the evaluation boundary.

**Risk:** moderate. The clustering is validated math; the block-level lever is the safer starting point.

## P4 — Size imbalance

**Finding:** zone 3 is 381,000 m² (1.5× the 248,000 median, 3rd-largest); zone 7 is 69,000 m² (0.28× median, smallest). Jack rated zone 7 "too small" and commented zone 3 "too large."

**Root cause (confirmed):** `generateZones` (`:817`) calls `mergeBlocksToZones(blocks, adjacency, zoneCount)` WITHOUT `efforts`, so the clustering weights blocks by `area^0.5` (`:657`) rather than real street-effort. `computeBlockEfforts` (`:478`) — which counts street meters plus an open-ground allowance — is used inside `buildBlocks` refinement but never passed to the clustering. So the evaluated zones were balanced by a crude area proxy, not the honest effort measure.

**Fix:** compute `computeBlockEfforts` once and pass it to `mergeBlocksToZones` so zones balance by real search effort. Then re-measure the size spread; if genuine outliers remain, add a soft min/max size guard (split a zone far over target, fold one far under — the runt absorption at `:699–747` already handles the under case, so focus on an over-size split).

**Caveat:** because the evaluated run used area-weighting, part of the observed imbalance may be a harness artifact. The plan's first P4 step is to regenerate with effort weighting and re-measure before adding any new size logic.

**Risk:** low. This is wiring an existing, intended input into the clustering.

## P5 — Edges don't snap to named streets (deferred)

**Finding:** the zone 15 / zone 3 boundary should have followed Alden St; the generator has no "end a zone at this named arterial" concept (only `HARD_HIGHWAYS` = motorway/trunk/primary act as hard barriers). This is the same class as the Vermont Ave finding in the project history.

Deferred: this is where the barrier-classifier project applies — learning which streets should act as zone edges. Not a deterministic fix. Revisit after P1–P4.

## Validation

A throwaway Node harness (like the one built 2026-10-26 under the repo's `command-center`, using an extension-resolving loader) regenerates zones for the evaluation boundary and reports: total coverage %, count of overlapping zone pairs, median IQ and count below 0.45, and the area min/median/max spread. Each fix moves its own metric; none should regress the others. Unit tests in `command-center/test/zones/` cover each fix on a small fixture.

## Order

P1 (coverage) → P2 (overlap) → P4 (effort weighting + size) → P3 (compactness). Coverage and correctness first; compactness last because it is the most tuning-heavy and benefits from the others being settled.
