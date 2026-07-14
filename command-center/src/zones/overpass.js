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

function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
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
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), { name: el.tags?.name ?? '' });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
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
  return classifyWays(filterByDetail([...wayById.values()], detail));
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
  return classifyWays([...wayById.values()]);
}
