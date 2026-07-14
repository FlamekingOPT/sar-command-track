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

export async function fetchStreetGraph(boundary, { detail = 'full' } = {}) {
  const bbox = paddedBbox(boundary);
  const data = await queryOverpass(buildQuery(bbox, detail));
  return classifyWays(data.elements);
}
