# Street Tile Cache, Grid Fallback & Spatial Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Searches never depend on live Overpass: street data is prefetched into static hosting tiles; missing/failed data degrades to grid zones; zone numbers read like a page.

**Architecture:** New `fetchStreets` in `overpass.js` (cache tiles → live Overpass per missing tile → throw); `gridZones` in new `src/zones/grid.js`; `orderZonesForNumbering` in `subdivider.js`; `SearchDetail` catches street failure per boundary → grid fallback + notice, and numbers all zones spatially. Node prep script downloads tiles resumably.

**Tech Stack:** unchanged (turf 6.5, vitest, Node ≥18 for the script).

**Spec:** `docs/superpowers/specs/2026-07-14-street-tile-cache-design.md`

## Global Constraints

- Same as the previous plan (local clone, command-center only, no data migration, commit per task).
- `command-center/public/street-tiles/` is **gitignored**; the prep job populates it per machine before deploy.
- Existing `fetchStreetGraph` tests must keep passing unmodified (live-Overpass path unchanged).

---

### Task 1: `orderZonesForNumbering` (spatial reading order)

**Files:** Modify `command-center/src/zones/subdivider.js`; test `command-center/test/zones/subdivider.test.js`.

**Produces:** `orderZonesForNumbering(polys)` → same polys, sorted north-rows-first, west→east within each of `round(sqrt(n))` latitude bands.

Steps: failing test (3×3 grid of squares fed shuffled → expect reading order); implement (centroids via `turf.centroid`, band index `Math.min(rows-1, Math.floor((maxLat - lat) / rowH))`, sort by `[band, lon]`); pass; commit `feat(cc): number zones in map reading order`.

### Task 2: `gridZones` fallback

**Files:** Create `command-center/src/zones/grid.js`; test `command-center/test/zones/grid.test.js`.

**Produces:** `gridZones(boundaryFeature, count)` → `Feature<Polygon>[]`, ~count cells clipped to boundary, slivers < 5% of cell area dropped, never empty (min: the boundary itself).

Steps: failing tests (square boundary count 4 → 4 cells covering ~100%; irregular boundary → all cells within boundary, none tiny; count 1 → boundary itself); implement with `turf.squareGrid` over bbox with `cellSide = Math.sqrt(area/count)` (meters→km, `units: 'kilometers'`), `turf.intersect` clip, area filter, fallback `[boundaryFeature]` if nothing survives; pass; commit `feat(cc): grid-zone fallback when street data is unavailable`.

### Task 3: `fetchStreets` cache-first loader

**Files:** Modify `command-center/src/zones/overpass.js`; test `command-center/test/zones/overpass.test.js`.

**Produces:**
- `cacheTileKeys(bbox)` → `[{ key, bbox }]` covering 0.05° tiles; `TILE_SIZE_DEG = 0.05`, `STREET_TILE_BASE = '/street-tiles'`.
- `filterByDetail(elements, detail)` → ways whose highway matches `DETAIL_LEVELS[detail]` (waterways always kept).
- `fetchStreets(boundary, { detail='full', onProgress })` → `{ hardLines, softLines }`: per tile try `fetch(`${STREET_TILE_BASE}/${key}.json`)`; on !ok fall back to `queryOverpass(buildQuery(tileBbox, 'full'))`; on failure throw `Map data unavailable for tile N of M: …`; dedupe by way id; apply `filterByDetail`; classify.

Steps: failing tests (mock fetch: cache URLs hit → no Overpass call; one cache miss → Overpass URL called for that tile only; both fail → throws with tile info; detail filter drops residential from cached full data); implement; all tests incl. old `fetchStreetGraph` suite pass; commit `feat(cc): cache-first street loading from hosted tiles`.

### Task 4: SearchDetail wiring — fallback + numbering

**Files:** Modify `command-center/src/search/SearchDetail.jsx`.

Changes: import `fetchStreets` (replacing `fetchStreetGraph` usage) and `gridZones`, `orderZonesForNumbering`. Per-target try/catch: on street failure push `{ ...t, gridPolys: gridZones(t.feature, estAlloc) }` instead of a hard failure (notice: "Boundary N: street data unavailable — used grid zones."). Collect ALL polys (street-merged + grid) with their boundaryIds, then `orderZonesForNumbering` across the whole set, then assign `nextNumber++` in that order, then `createZones`. Verify: `npm test`, lint, build. Commit `feat(cc): grid fallback per boundary + page-order zone numbering`.

### Task 5: Prep script + region C download

**Files:** Create `tools/prefetch-streets.mjs`; modify `.gitignore` (add `command-center/public/street-tiles/`).

Script: presets from spec; per tile skip-if-exists, `[out:json][timeout:60]` full-detail query, 5 attempts alternating endpoints with 10s·attempt backoff, 2s inter-tile delay, progress log `tile 12/24 (skipped|ok 1.2MB|retry 3)`. Run `node tools/prefetch-streets.mjs --region westla`; verify tile files exist and parse. Commit script (not tiles).

### Task 6: Verification + region B

- Full suite + lint + build both apps.
- Dev-server smoke: West LA boundary generates from cache (instant, no Overpass); boundary outside coverage in a broken-network sim → grid zones + notice; numbers read west→east, north→south.
- Kick off `--region basin` in the background (~140 tiles, polite pacing → under an hour wall-clock); report total size.
- Deploy decision + handoff doc update with Jack (county run documented for the weekend).
