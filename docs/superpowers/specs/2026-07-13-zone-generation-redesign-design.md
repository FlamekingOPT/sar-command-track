# Design — Zone Generation Redesign: Flat Numbered Zones from Real City Blocks

**Date:** 2026-07-13 · **Status: APPROVED (verbal, 2026-07-13) — not built.**

Replaces the letter-zone + sub-zone model (`A`, `A1`..`A4`, `B`, `B1`..`B4`, …) shipped in
Phase 1 (`2026-06-28-sar-command-track-design.md`) with a single flat tier of numbered zones
(`1`, `2`, `3`, …). Supersedes the original ask ("fix sub-zone road-snapping," Open Issue #1 in
the 2026-07-12 handoff) — that issue is moot once sub-zones don't exist.

First of three specs for this redesign:
- **Spec A (this doc):** the generation algorithm and the data-model/UI changes it requires.
- **Spec B (not yet written):** command staff can mark a sub-area "hot spot" for a more
  thorough (walked, smaller-zone) search than the rest of the boundary (default: driven).
- **Spec C (not yet written):** searcher-app flow where finishing a zone returns the searcher
  to the picker to self-claim another, instead of a dead end.

Telegram bot (`telegram-bot/`) is explicitly **out of scope** for all three specs per Jack
2026-07-13 ("keep the bot on the sidelines for now"). It currently assumes `letter`-keyed zones
throughout (`messages.js`, `mapImage.js`, `zoneRequestWatcher.js`, etc.) and **will be broken/
stale after Spec A ships.** That's accepted; reconciling the bot is a future, separate pass.

---

## 0. Overview

Today, `handleGenerateZones` (`command-center/src/search/SearchDetail.jsx`) draws a boundary,
splits it into a fixed number of **letter zones** (`subdivideWithBarriers`), then splits each
letter zone into a fixed **4 sub-zones** (`subdivideZone`, plain geometric strips — Open Issue
#1). Searchers are assigned at the sub-zone level; the web picker
(`searcher-app/src/pick/PickPage.jsx`) only lets them pick at the **letter** level, and the
Telegram bot's `zoneRequestWatcher` resolves that into an actual sub-zone.

This two-tier model, and the strip/buffer-cut geometry underneath it, is being replaced
entirely. Three problems drove this, discovered in that order while validating the original
narrower "fix sub-zone road-snapping" ask against real OSM data for 90035 (Los Angeles):

1. **Buffer-and-difference cuts don't sit on real streets.** The existing `cutByBarrier`
   approach — buffer a line, subtract it from the polygon — produces a *synthetic* cut that,
   once you extend a short OSM way fragment out to clear the polygon (`extendPastPolygon`),
   can run straight through the middle of a block with no relationship to where the pavement
   actually is. Rendered against a real basemap for 90035, this was directly visible: overlay
   lines that didn't correspond to anything on the map.
2. **OSM's `highway=tertiary` tag doesn't mean "highway."** The classification used for "never
   cross a major highway" (motorway/trunk/primary/secondary/**tertiary**) pulled in Airdrome
   Street — a 25 mph residential collector with sidewalks on both sides — as a hard,
   un-crossable barrier. That's not what "major highway" means for a foot search.
3. **Dropping slivers loses area; letters+sub-zones is a coarser tier than needed.** Once
   staff described the actual target ("more even zones, no gaps, no slivers, no crossing major
   highways, natural breaks along blocks" — Jack 2026-07-13), plus a real hand-drawn zone-map
   reference showing zone edges traced exactly along street centerlines, it became clear the
   letter/sub-zone split wasn't the right shape for the problem at all.

## 1. Algorithm — block-graph assembly

Replace buffer-and-difference entirely. Treat the real street network as a planar graph —
intersections are nodes, the street segments between them are edges — and let the graph's
faces be the zones' building blocks. Every zone edge is therefore always a real street, by
construction; no buffering, no synthetic cuts, no possibility of misalignment.

### 1.1 Barrier tiers

- **Hard** (never crossed by a zone, no exceptions): `highway` in `motorway|trunk|primary`, or
  any `waterway` in `river|canal|stream`.
- **Soft** (ordinary block edges, freely merged across): everything else fetched —
  `secondary|tertiary|residential|living_street|unclassified`.

(`tertiary` is soft, not hard — see problem 2 above. `secondary` is soft too: a search team can
walk across a two-lane secondary road same as a tertiary one. Only genuine arterials/highways
and water are hard.)

### 1.2 Steps

1. **Fetch with margin.** Query Overpass for all `highway`/`waterway` ways (both tiers) inside
   the drawn search boundary **expanded by ~300m** on every side. A block touching the real
   boundary's edge needs its closing cross-street for `polygonize` to close that face, and that
   street can sit just outside the boundary itself.
2. **Node the graph.** Clip every fetched way to the padded bbox (`turf.bboxClip`), snap all
   coordinates to ~11cm precision (round to 6 decimal degrees), and drop degenerate edges (<1m
   long) and exact-duplicate edges (same two endpoints either direction). `turf.polygonize`'s
   edge-ring assembly is brittle against near-duplicate floating-point coordinates and duplicate
   edges between the same two nodes — both cause it to throw (`Each LinearRing of a Polygon must
   have 4 or more Positions`) or silently misbehave.

   `turf.polygonize` also never auto-nodes a line endpoint that lands in the *middle* of another
   line — a clipped street's endpoint sits exactly on the padded bbox's edge, but a plain
   4-corner bbox ring has no vertex there, so that street silently fails to close against the
   ring at all (confirmed directly: a boundary ring plus a single line touching its edge
   mid-span produces 1 face, not a split). The padded boundary edge must therefore be built as a
   ring whose vertex list is the 4 corners **plus every point where a clipped street touches
   it**, sorted around the perimeter — not a plain `turf.bboxPolygon` ring.
3. **Polygonize into blocks.** Add that noded padded-boundary ring as one more edge, run
   `turf.polygonize` on the full edge set, and keep the resulting faces whose centroid falls
   inside the padded boundary.
4. **Clip back to the real boundary, then size-check.** Intersect (`turf.intersect`) every kept
   face against the actual drawn boundary (not the padded one) *before* applying any size
   sanity check — a face's padded, pre-clip area is inflated by however much of the boundary pad
   it happens to include, so checking size before clipping rejects legitimate blocks (found
   while validating this exact code: a real ~28,000 m² block came out ~218,000 m² pre-clip on a
   small test boundary, well past a 200,000 m² cap that was meant to catch only the
   whole-padded-area spurious face). After clipping, drop anything still above ~200,000 m² —
   `polygonize` can emit a spurious face spanning most/all of the padded bbox when the street
   network doesn't fully close into small loops (dangling ends); no real city block in dense
   residential terrain comes anywhere close to that size even before clipping. Interior blocks
   pass through the clip unchanged; blocks straddling the real edge get trimmed to their portion
   inside it. This pad-clip-filter ordering is what makes coverage of the real boundary hit
   100% — skipping the pad-then-clip and just fetching/polygonizing the exact boundary directly
   leaves real gaps near the edge (validated: 61.8% coverage without the pad, 100% with it).
5. **Build block adjacency.** For every pair of blocks, find their shared border via
   `turf.lineOverlap(polygonToLine(a), polygonToLine(b), {tolerance: 0.003})` (3m tolerance).
   Ignore touches under 3m (corner-touching, not a real shared edge). Classify the adjacency
   **hard** if the shared border's midpoint sits within 6m of any hard-tier line, else **soft**.
6. **Merge blocks into zones.** Starting with every block as its own zone, repeatedly find the
   *soft*-adjacent pair of zones with the smallest combined area and `turf.union` them, until
   the target zone count is reached. Never consider a hard-adjacent pair. If no soft-adjacent
   pair remains before reaching the target count, stop early — more, smaller zones than
   requested is correct behavior when major roads chop the area into more pieces than the
   target; a hard-cross zone is never acceptable as an alternative. Recomputing all-pairs
   adjacency from scratch every merge is O(block_count³) — fine at the tens-to-low-hundreds of
   blocks a typical drawn search boundary produces (validated: 86 blocks merged to 8 zones,
   sub-second); revisit with incremental adjacency updates only if a real boundary turns out
   large enough to make this slow in practice.
7. **Number the zones** `1..N` in the order they're finalized (or any stable order — display
   order doesn't need to mean anything spatially).

Validated on real 90035 OSM data at N=8: 100% coverage, zone sizes 131,809–221,191 m² (1.7×
spread, down from an 14–40× spread with the old buffer-cut approaches), zero zone edges off a
real street.

### 1.3 Sizing — target zone count from search time + mode

Per Jack 2026-07-13: staff choose an estimated search time and whether the zone will be
**walked** or **driven**, not a raw zone count.

- Walked: 3 mph, 20m effective sweep width → **1,609 m²/minute**
  (one searcher walking a residential block, covering both sides of the street plus yards).
- Driven: 20 mph, 20m effective sweep width → **10,729 m²/minute**
  (a vehicle slow-rolling residential streets, driver+passenger scanning both sides).

```
target_zone_area_m2 = search_minutes * rate(mode)
zone_count = max(1, round(boundary_area_m2 / target_zone_area_m2))
```

This spec covers only the **uniform, whole-boundary** case: one time + one mode for the entire
search, producing one `zone_count` fed into §1.2 step 6. Per-area overrides (a hot-spot region
searched more thoroughly than the rest) are Spec B — that requires running block-merging
independently per region and is deferred, not because the formula changes, but because
combining differently-sized regions without leaving a gap or a hard-crossing zone at their
shared edge needs its own design pass.

## 2. Data model changes

**`searches/{searchId}` doc** — drop `letterZones` entirely. No replacement field; zones live
only in the `zones` sub-collection now (there's no second coarser tier to mirror at the search
level).

**`searches/{searchId}/days/{dayId}/zones/{zoneId}` doc** — drop `letter`; `number` becomes the
zone's only identifier (was previously scoped within a letter, e.g. `A1`, `A2`; now global,
e.g. `1`..`N`). Everything else (`polygon`, `status`, `assignedTo`, `createdAt`) is unchanged.

```diff
- { letter: 'A', number: 1, polygon, status, assignedTo, createdAt }
+ { number: 1, polygon, status, assignedTo, createdAt }
```

No migration needed for existing search docs — this is a test/demo environment with no
production searches to preserve (per project state; confirm with Jack before deploy if that's
changed).

## 3. UI changes

### `command-center/`

- **`src/zones/subdivider.js`** — replaced wholesale. Remove `subdivideWithBarriers`,
  `subdivideZone`, `cutByBarrier`, `extendPastPolygon`, `mergeToN`, `stripSubdivide`,
  `lengthInsidePoly`, `fetchOSMBarriers`. New exports implement §1.2 (fetch-with-margin,
  polygonize, clip, adjacency, greedy merge) as the sole zone-generation entry point, taking a
  boundary + zone count and returning flat numbered zone polygons directly (no letter tier in
  the return shape at all).
- **`src/search/SearchDetail.jsx`** — `handleGenerateZones` calls the new generator directly
  with the boundary + a zone count derived from §1.3's formula; drop the letter-zone loop and
  the per-letter `subdivideZone(feature, 4)` sub-loop entirely. `handleFeatureDrawn`'s
  manual-letter-zone draw path is removed — there is no letter tier left to hand-draw into; a
  drawn boundary always goes through `handleGenerateZones`. Replace the `zoneCount` number
  input with a search-time input (minutes) + a walked/driven mode toggle; compute `zone_count`
  from §1.3 and pass it to generation.
- **`src/ui/ZonePanel.jsx`** — flat list sorted by `number`, no per-letter grouping headers.
  Label changes from `${zone.letter}${zone.number}` to `Zone ${zone.number}`.
- **`src/map/CommandMap.jsx`** — rename the `letter-zones-*` source/layers to a single
  `zones-*` set; label expression changes from `['get','letter']` to `['get','number']`; drop
  the `subZones`/`letterZones` prop split in favor of one `zones` prop.
- **`src/firebase/searches.js`** — drop `updateSearchLetterZones` and the `letterZones` parse
  in `watchSearch`/`createSearch`.
- **`src/firebase/zones.js`** — `createZone({ number, polygon })`, drop `letter` param.

### `searcher-app/`

Mechanical rename only in this spec — the *new* self-pick-after-completion behavior is Spec C,
but the picker has to keep working once letters are gone, so:

- **`src/pick/PickPage.jsx`** / **`src/pick/PickMap.jsx`** — `letterAvailability` → flat
  per-zone availability keyed by `number`; tapping a zone submits that exact zone number
  directly (no letter→sub-zone resolution needed anymore, since there's no coarser tier to
  resolve — this also means the bot's `zoneRequestWatcher` resolution step it depended on for
  the web-picker path is no longer necessary, but changing that watcher is bot work, out of
  scope here per the sidelining decision).
- **`src/App.jsx`** — label `Zone {zone.letter}{zone.number}` → `Zone {zone.number}`.
- **`src/firebase/zoneRequests.js`** — `createRequest({ searchId, letter, ... })` →
  `createRequest({ searchId, number, ... })`.
- **`src/firebase/searches.js`** — drop the `letterZones` parse in `watchSearch`/equivalent, if
  present (mirrors the command-center change).

## 4. Testing

- **Unit tests for the new `subdivider.js`**, using synthetic line networks (small hand-built
  grids of LineStrings) rather than live Overpass calls: verify 100% coverage, zero
  hard-barrier crossings, merge-count convergence to target `N` (and correct early-stop
  behavior when `N` isn't reachable without a hard crossing), and the degenerate-edge/duplicate
  -edge filtering from §1.2 step 2 (regression tests for the exact `polygonize` crash found
  during validation).
- **Sizing formula unit tests**: the §1.3 formula against known inputs/outputs for both modes.
- Existing `subdivider.test.js` gets rewritten against the new API; nothing from the old
  buffer-cut implementation carries over.
- Manual smoke test: real search boundary in the Command Center, Generate Zones, confirm on
  the live Mapbox map that zone edges sit on real streets (same check performed manually
  during design validation, now a one-time manual pass rather than the whole validation
  method).

## Appendix — validation methodology notes

Kept for whoever implements this, since these were non-obvious and easy to reintroduce:

- **Mapbox GL / Static Images API uses 512px tiles, not the classic 256px slippy-map tile
  size** used by Google/Bing/OSM raster tiles. A world-pixel Mercator projection written
  against the classic 256px convention is off by a factor of 2 in scale at the same zoom
  number — this produced the first "lines aren't on the map" symptom during rendering
  validation before the algorithm itself was even in question. Not relevant to the production
  algorithm (which never rasterizes), but relevant if anyone builds further map-based tooling
  against this code.
- The 90035 validation data and scripts are throwaway (`scratchpad/`, not committed) — this
  spec's numbers (100% coverage, 1.7× size spread, etc.) are the result, not a fixture to keep
  in sync.
