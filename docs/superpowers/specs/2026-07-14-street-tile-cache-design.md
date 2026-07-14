# Street Tile Cache, Grid Fallback & Spatial Numbering — Design

**Date:** 2026-07-14 (same-day follow-up to `2026-07-14-zone-sizing-multiboundary-fetch-design.md`)
**Status:** Approved (Jack, 2026-07-14). Rollout: C (West LA test region) → B (urban basin) now; A (LA County) over the weekend.

## Problem

Field test: a 4-tile boundary failed on tile 4 with both Overpass endpoints timing out. Live Overpass at search time can always fail — search night must not depend on it. Also: zone numbers are assigned in build order and look scattered on the map.

## Jack's idea (adopted)

Pre-run the unreliable part ahead of time, store the result with our own app, and serve searches from that store; grid fallback outside coverage. Implementation stores **raw street data per map tile** (not blocks, not zones): zones vary per search, blocks would need precomputed adjacency, but streets feed the existing pipeline untouched — the cache is literally "the download, done earlier, kept."

## Design

**Tile scheme.** Fixed 0.05°×0.05° grid (~25 km² at LA latitude). Tile key `tile_{ix}_{iy}` where `ix = floor(west/0.05)`, `iy = floor(south/0.05)`. Files at `command-center/public/street-tiles/tile_{ix}_{iy}.json` (gitignored — deployed via Firebase Hosting from whichever machine ran the prep job), each holding the Overpass `{ elements }` response at FULL detail. LOD filtering happens client-side after load, so one cache serves all detail levels.

**Search-time flow** (`fetchStreets(boundary, { detail, onProgress })` — new orchestrating function; the existing live-Overpass `fetchStreetGraph` stays as-is):
1. Padded bbox → covering cache-tile keys.
2. Fetch each from `/street-tiles/…` (same origin, fast, reliable).
3. 404/missing tile → live Overpass query for that tile's bbox (existing `queryOverpass`, both endpoints).
4. Any tile still failing → throw; the caller falls back to **grid zones** for that boundary (with a notice), so generation NEVER produces nothing.
5. Ways deduped by OSM id across tiles; detail filter applied client-side; classification (hard/soft) unchanged.

**Grid fallback.** `gridZones(boundaryFeature, count)`: square cells of area `boundaryArea/count` clipped to the boundary, slivers (<5% of a cell) dropped. Pure turf math — cannot fail. Used when street data is unavailable for a boundary; also the permanent answer outside prefetched coverage.

**Spatial numbering.** `orderZonesForNumbering(polys)`: reading order — centroids banded into `round(sqrt(n))` latitude rows (north first), west→east within a row. Applied across ALL boundaries' zones before numbers are assigned, so numbering sweeps the whole map like a page.

**Prep job.** `tools/prefetch-streets.mjs` (Node ≥18, repo root): `node tools/prefetch-streets.mjs --region westla|basin|county` (or `--bbox w,s,e,n`). Sequential polite queries (2s gap), 5 retries with backoff per tile across both endpoints, skips already-downloaded tiles (resumable), writes into `command-center/public/street-tiles/`. Region presets:
- `westla` (C): -118.50,33.99,-118.32,34.11
- `basin` (B): -118.67,33.70,-118.15,34.33 (~140 tiles)
- `county` (A): -118.95,33.60,-117.65,34.85 (weekend run)

**Allocation with mixed sources.** Street boundaries share the requested total by block count (existing `allocateZoneCounts`); a grid-fallback boundary takes its area-proportional share directly.

**Freshness:** streets barely change; re-run the prep job yearly or when coverage grows. **Out of scope:** self-hosted Overpass, block/adjacency precomputation, searcher-app changes.
