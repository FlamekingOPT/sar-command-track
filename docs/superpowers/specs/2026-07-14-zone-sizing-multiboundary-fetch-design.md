# Zone Sizing, Multiple Boundaries & Fetch Reliability — Design

**Date:** 2026-07-14
**Status:** Approved (brainstormed with Jack; sizing model validated via interactive simulation)
**Supersedes:** the time+mode-only sizing model in `2026-07-13-zone-generation-redesign` (the block-graph algorithm itself is unchanged and remains the foundation)

## Problem

Field-testing against a real city-scale search ("Jeanne Missing": ~150 variable-sized zones averaging 2–3 km² over ~300 km² of the LA basin) exposed three gaps:

1. **Sizing:** the time+mode formula produces uniform block-scale zones — right for a neighborhood, wrong for a city. Real searches use command-chosen zone counts with sizes varying by area difficulty/density.
2. **One boundary only:** real searches aren't one contiguous shape; boundaries also can't be edited after drawing.
3. **Fetch reliability:** public Overpass cannot return a full street network for ~300 km² — queries time out ("Couldn't fetch street data"). The block-graph approach depends on this fetch succeeding.

## Design decisions (settled)

- Support **both** one big boundary (via chunking) and multiple smaller boundaries. (Option C)
- Sizing input is **both**: a primary "Number of zones" count field, with the existing time+mode controls demoted to a suggester that pre-fills the count. (Option B)
- Across boundaries, command enters **one total count, auto-split** proportionally by block count. (Option A)
- **Editable boundaries are bundled** into this round of work. (Option A)
- No artificial cap on zone count. Ceilings are physical (zones ≤ blocks) and existing plumbing (`createZones` batches of 500) only.

## Section 1: Zone sizing

**UI.** The generate panel's primary input is **Number of zones** (free-entry integer). Time + walked/driven controls remain but only recalculate a *suggested* count into the field via the existing `computeZoneCount`; command can overwrite it. The value in the field is what gets generated.

**Algorithm.** `mergeBlocksToZones` changes its merge target from equal *area* to equal *block count*. After polygonizing into blocks, target = `totalBlocks / N` blocks per zone; merge adjacent blocks — still never across hard roads (motorway/trunk/primary) or waterways — balancing block count per zone. Dense street grid → many small blocks → physically small zones; sparse areas → few huge blocks → physically big zones. The block graph is the density signal; no new data source.

**Multi-boundary allocation.** With boundaries B1..Bk and total count N, each boundary receives `N × (its block count / total block count)`, rounded largest-remainder so allocations sum exactly to N, minimum 1 per boundary. Generation runs independently per boundary.

**Clamp.** If a boundary's allocation exceeds its block count, clamp to block count (a zone is never smaller than one block) and tell command the actual number generated.

**Validation of the model.** An interactive simulation (dense grid vs. sparse area split by a hard road) confirmed the desired behavior: equal-block-count merging sends ~all zones to the dense side as small zones and leaves few, huge zones on the sparse side; the old equal-area merge splits 50/50 uniformly. Jack approved the sizing behavior on 2026-07-14.

## Section 2: Multiple boundaries + editing

**Data model.** Search doc field `boundary` (single polygon) → `boundaries` (array of `{id, polygon}`). Backward-compatible read shim: a legacy `boundary` is treated as `boundaries: [boundary]`; old searches and their zones keep working untouched.

**Drawing.** After drawing one boundary the draw tool stays active; command draws additional boundaries freely (no limit). Clicking a boundary selects it; selected boundaries can be deleted.

**Editing.** Re-expose Mapbox Draw's edit mode: click a boundary → drag vertices. Allowed freely in `setup`. Editing a boundary invalidates that boundary's zones (regenerated on next Generate). After Send Out, edits require an explicit confirm warning (searchers may be assigned).

**Generation.** One total count (Section 1). Streets are fetched **per boundary** — separate, smaller Overpass queries. Each boundary builds its own block graph; allocation is proportional by block count; generation runs per boundary. A fetch failure in one boundary fails only that boundary (per-boundary retry); other boundaries' zones are unaffected.

## Section 3: Fetch reliability

Two layered mechanisms on top of per-boundary fetching:

**Level of detail (primary).** The Overpass road-class filter scales with expected zone size. Since the final block-count allocation (Section 1) can't exist until after the fetch, LOD uses a pre-fetch **estimate**: the total count split across boundaries proportionally by *area*, giving `estimatedAvgZoneArea = boundaryArea / estimatedAllocation`. The estimate only has to land in the right order-of-magnitude band:

| Avg zone area | Scale | Fetch |
|---|---|---|
| < ~0.1 km² | neighborhood | everything (as today) |
| ~0.1–1 km² | district | motorway → tertiary (drop residential/service) |
| > ~1 km² | city | motorway/trunk/primary/secondary + waterways only |

Thresholds are tunable constants. Trade-off is deliberate: big zones don't need alley-level edges, and coarser roads yield fewer blocks — the right granularity for merging to large zones. City-scale filtering turns a timeout-scale query into one that returns in seconds.

**Tile chunking (safety net).** If a boundary's fetch area still exceeds a threshold (~30 km², tunable) after LOD filtering, split its bounding box into a grid of tiles and query Overpass per tile **sequentially** (public Overpass rate-limits parallel requests). Dedupe ways spanning tiles by OSM id; stitch into one street set before polygonizing. A failed tile retries once against the fallback endpoint; if it still fails, abort that boundary's generation with a message naming which part failed — never produce zones with a silent hole.

**Order:** LOD first (usually makes chunking unnecessary); chunk only when the filtered query is still too big. Progress UI shows fetch progress ("Fetching map data… tile 3/9") instead of the current opaque wait-then-error.

## Section 4: Error handling & edge cases

- **Zero-block boundary** (water/empty land, or coarse LOD finds no roads): the whole boundary becomes one zone, with a notice. Never a silent failure.
- **Count clamp:** see Section 1.
- **Allocation rounding:** largest-remainder; always sums exactly to the requested total.
- **Partial multi-boundary failure:** independent generation per boundary; search is usable with partial zones while retrying the failed boundary.
- **Regeneration:** re-running Generate deletes and replaces only the affected boundary's zones. Invalidated zone tokens are acceptable in `setup`; after Send Out, regeneration requires a confirm warning (consistent with the edit rule).
- **Legacy searches:** read shim per Section 2.
- **Overpass hard-down** (both endpoints, retries exhausted): clean error scoped to the boundary, with tile-level detail ("tiles 1–8 fetched, tile 9 failed — retry?").

## Section 5: Testing

- **Unit:** proportional allocation (largest-remainder sums to N, min 1, clamp), LOD threshold selection, tile splitter (tile count, cross-tile way dedupe).
- **Integration** (existing fixture pattern): full generate pipeline against canned OSM fixtures — dense grid, sparse, and mixed. Assert: exact zone count, roughly equal block counts per zone, no zone crosses a hard road, 100% coverage, no slivers.
- **Field validation:** re-run the Jeanne Missing boundary at count 150 and compare against the real Scribble Maps zones — small downtown zones, big hillside zones, ~2–3 km² average.

## Out of scope

- Telegram bot reconciliation (still assumes `letter`-keyed zones; web picker is the primary sign-up path).
- Any change to the sign-up/claim flow, GPS tracking, or the shipped block-graph polygonization itself.
