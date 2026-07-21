import * as turf from '@turf/turf';
import { paddedBbox, HARD_HIGHWAYS } from './subdivider';

// Road-class filter scales with expected zone size (spec §3): big zones don't
// need alley-level edges, and a city-scale query for every residential lane
// over 300 km² is exactly what times out on public Overpass. Coarser roads
// also mean fewer blocks — the right granularity for merging to large zones.
export const DETAIL_LEVELS = {
  full:     'motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified',
  district: 'motorway|trunk|primary|secondary|tertiary',
  city:     'motorway|trunk|primary|secondary',
};
export const DISTRICT_MIN_ZONE_AREA_M2 = 100_000;   // 0.1 km² — tunable
export const CITY_MIN_ZONE_AREA_M2 = 1_000_000;     // 1 km² — tunable

export function selectDetail(boundaryAreaM2, estimatedZoneCount) {
  const avg = boundaryAreaM2 / Math.max(1, estimatedZoneCount);
  if (avg >= CITY_MIN_ZONE_AREA_M2) return 'city';
  if (avg >= DISTRICT_MIN_ZONE_AREA_M2) return 'district';
  return 'full';
}

// Public Overpass cannot reliably answer one huge query (~300 km² boundaries
// repeatedly produced "Couldn't fetch street data" in the field). Split the
// padded bbox into a grid of tiles and query them SEQUENTIALLY — the public
// instances rate-limit parallel requests from one client (spec §3).
export const MAX_FETCH_AREA_M2 = 30_000_000; // ~30 km² per query — tunable

export function tileBboxes(bbox, maxAreaM2) {
  const [west, south, east, north] = bbox;
  const areaM2 = turf.area(turf.bboxPolygon(bbox));
  const tileCount = Math.ceil(areaM2 / maxAreaM2);
  if (tileCount <= 1) return [bbox];
  const cols = Math.ceil(Math.sqrt(tileCount));
  const rows = Math.ceil(tileCount / cols);
  const dx = (east - west) / cols;
  const dy = (north - south) / rows;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push([west + c * dx, south + r * dy, west + (c + 1) * dx, south + (r + 1) * dy]);
    }
  }
  return tiles;
}

// Overpass's public de-facto instance 504s under load reasonably often, and
// its error responses are XML, not JSON — calling resp.json() unconditionally
// throws a confusing SyntaxError instead of a clear "couldn't fetch streets"
// failure (this is exactly what happened in production). Check resp.ok first,
// and fall back to a second public instance before giving up.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 20000;

async function queryOverpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const resp = await fetch(endpoint, { method: 'POST', body: query, signal: controller.signal });
      if (!resp.ok) throw new Error(`Overpass request to ${endpoint} failed (${resp.status})`);
      return await resp.json();
    } catch (err) {
      lastError = err.name === 'AbortError' ? new Error(`Overpass request to ${endpoint} timed out`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Couldn't fetch street data from any Overpass endpoint: ${lastError?.message ?? 'unknown error'}`);
}

// Terrain features (2026-07-19 zone-algorithm-quality spec, issue #1): parks/
// golf courses/cemeteries/wood are invisible to the algorithm without these —
// a block containing one falls back to a blind grid split instead of
// following the feature's real shape (field bug: a golf course cut in half by
// a straight grid line). Fetched at every detail level, not gated by
// DETAIL_LEVELS, since they matter to local refinement regardless of zoning
// LOD. highway=path|footway rides along so a feature's internal paths are
// available too — see buildBlocks' local-refinement branch (Task 3).
function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
  way["leisure"~"golf_course|park"](${south},${west},${north},${east});
  way["landuse"~"cemetery"](${south},${west},${north},${east});
  way["natural"~"wood"](${south},${west},${north},${east});
  way["highway"~"path|footway"](${south},${west},${north},${east});
);
out geom;`;
}

function classifyWays(elements) {
  const hardLines = [];
  const softLines = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    const waterway = el.tags?.waterway;
    // Only real streets/waterways become zoning edges. Terrain features
    // (golf/park/cemetery/wood) and bare paths/footways are classified
    // separately by classifyTerrainFeatures below (2026-07-19 spec, issue #1)
    // — an untagged or terrain-tagged way must not fall through into
    // softLines as if it were an ordinary internal street.
    if (!highway && !waterway) continue;
    // Skip path/footway: these are handled by classifyTerrainFeatures
    if (highway === 'path' || highway === 'footway') continue;
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), {
      name: el.tags?.name ?? '',
      highway: waterway ? 'waterway' : highway,
    });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
}

const TERRAIN_POLYGON_TAGS = { leisure: ['golf_course', 'park'], landuse: ['cemetery'], natural: ['wood'] };

// Builds real polygons/paths for terrain features (2026-07-19 spec, issue #1)
// so buildBlocks' local-refinement branch (Task 3) can split an oversized
// block along a feature's actual shape instead of a blind grid. Way-only: OSM
// multipolygon relations for these tags (shapes with holes) are rare for
// golf/park/cemetery and are skipped with a warning rather than handled — not
// a blocker for this iteration.
export function classifyTerrainFeatures(elements) {
  const terrainPolygons = [];
  const terrainPaths = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    if (highway === 'path' || highway === 'footway') {
      terrainPaths.push(turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat])));
      continue;
    }
    const isTerrainTag = Object.entries(TERRAIN_POLYGON_TAGS)
      .some(([key, vals]) => el.tags?.[key] && vals.includes(el.tags[key]));
    if (!isTerrainTag) continue;
    const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      console.warn(`terrain feature way ${el.id ?? '(anon)'} is not a closed ring (relation-based multipolygon?) — skipped`);
      continue;
    }
    try { terrainPolygons.push(turf.polygon([coords])); }
    catch (err) { console.warn(`terrain feature way ${el.id ?? '(anon)'} failed to build a polygon: ${err.message}`); }
  }
  return { terrainPolygons, terrainPaths };
}

// ---- Street tile cache (spec 2026-07-14 street-tile-cache) ----
// Prefetched full-detail Overpass responses live as static files on our own
// hosting (tools/prefetch-streets.mjs fills them). Searches read those first —
// fast and reliable — and only fall back to live Overpass for tiles the prep
// job hasn't covered. LOD is applied client-side so one cache serves all
// detail levels.
export const TILE_SIZE_DEG = 0.05; // ~25 km² at LA latitude
export const STREET_TILE_BASE = '/street-tiles';

export function cacheTileKeys([west, south, east, north]) {
  const tiles = [];
  const ix0 = Math.floor(west / TILE_SIZE_DEG);
  const ix1 = Math.floor(east / TILE_SIZE_DEG);
  const iy0 = Math.floor(south / TILE_SIZE_DEG);
  const iy1 = Math.floor(north / TILE_SIZE_DEG);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      tiles.push({
        key: `tile_${ix}_${iy}`,
        bbox: [ix * TILE_SIZE_DEG, iy * TILE_SIZE_DEG, (ix + 1) * TILE_SIZE_DEG, (iy + 1) * TILE_SIZE_DEG],
      });
    }
  }
  return tiles;
}

export function filterByDetail(elements, detail) {
  const re = new RegExp(`^(${DETAIL_LEVELS[detail]})$`);
  return elements.filter(el => el.tags?.waterway || re.test(el.tags?.highway ?? ''));
}

export async function fetchStreets(boundary, { detail = 'full', onProgress } = {}) {
  const tiles = cacheTileKeys(paddedBbox(boundary));
  const wayById = new Map();
  for (let i = 0; i < tiles.length; i++) {
    onProgress?.(i, tiles.length);
    let data = null;
    try {
      const resp = await fetch(`${STREET_TILE_BASE}/${tiles[i].key}.json`);
      if (resp.ok) data = await resp.json();
    } catch { /* cache unreachable — fall through to live Overpass */ }
    if (!data) {
      try {
        data = await queryOverpass(buildQuery(tiles[i].bbox, 'full'));
      } catch (err) {
        throw new Error(`Map data unavailable for tile ${i + 1} of ${tiles.length}: ${err.message}`);
      }
    }
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const key = el.id ?? `anon-${wayById.size}`;
      if (!wayById.has(key)) wayById.set(key, el);
    }
  }
  onProgress?.(tiles.length, tiles.length);
  const all = [...wayById.values()];
  // Zone EFFORT is measured in street meters at FULL detail (the cache stores
  // full detail regardless of the zoning LOD) — every street class counts as
  // search workload even when polygonize only sees majors. Waterways aren't
  // streets and are excluded.
  const allStreetLines = all
    .filter(el => el.tags?.highway)
    .map(el => turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat])));
  // Terrain features aren't part of the DETAIL_LEVELS road-class filter at
  // all, so they must be classified from `all` (the pre-filter full-detail
  // list) — filterByDetail would otherwise strip them since they carry
  // neither a highway nor waterway tag.
  return { ...classifyWays(filterByDetail(all, detail)), ...classifyTerrainFeatures(all), allStreetLines };
}

export async function fetchStreetGraph(boundary, { detail = 'full', onProgress } = {}) {
  const bbox = paddedBbox(boundary);
  const tiles = tileBboxes(bbox, MAX_FETCH_AREA_M2);
  // Dedupe by OSM way id: the bbox filter returns any way touching the tile,
  // so a road crossing a tile border comes back from both tiles.
  const wayById = new Map();
  for (let i = 0; i < tiles.length; i++) {
    onProgress?.(i, tiles.length);
    let data;
    try {
      data = await queryOverpass(buildQuery(tiles[i], detail)); // queryOverpass already retries on the fallback endpoint
    } catch (err) {
      throw new Error(`Map data fetch failed on tile ${i + 1} of ${tiles.length}: ${err.message}`);
    }
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const key = el.id ?? `anon-${wayById.size}`;
      if (!wayById.has(key)) wayById.set(key, el);
    }
  }
  onProgress?.(tiles.length, tiles.length);
  const allElements = [...wayById.values()];
  return { ...classifyWays(allElements), ...classifyTerrainFeatures(allElements) };
}
