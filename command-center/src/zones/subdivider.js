import * as turf from '@turf/turf';

// §1.3 of the design spec — one searcher walking a residential block (3 mph,
// 20m effective sweep width) vs. a vehicle slow-rolling residential streets
// (20 mph, 20m sweep width).
export const WALKED_RATE_M2_PER_MIN = 1609;
export const DRIVEN_RATE_M2_PER_MIN = 10729;

export function computeZoneCount(boundaryAreaM2, minutes, mode) {
  const rate = mode === 'driven' ? DRIVEN_RATE_M2_PER_MIN : WALKED_RATE_M2_PER_MIN;
  const targetAreaM2 = minutes * rate;
  return Math.max(1, Math.round(boundaryAreaM2 / targetAreaM2));
}

export const BOUNDARY_PAD_METERS = 300;

// Blocks touching the real boundary's edge need their closing cross-street,
// which can sit just outside it — pad the fetch/polygonize area so that street
// is included, then clip back to the real boundary afterward (buildBlocks).
export function paddedBbox(boundary, meters = BOUNDARY_PAD_METERS) {
  const [west, south, east, north] = turf.bbox(boundary);
  const km = meters / 1000;
  const newWest = turf.destination([west, south], km, 270, { units: 'kilometers' }).geometry.coordinates[0];
  const newSouth = turf.destination([west, south], km, 180, { units: 'kilometers' }).geometry.coordinates[1];
  const newEast = turf.destination([east, north], km, 90, { units: 'kilometers' }).geometry.coordinates[0];
  const newNorth = turf.destination([east, north], km, 0, { units: 'kilometers' }).geometry.coordinates[1];
  return [newWest, newSouth, newEast, newNorth];
}

export const HARD_HIGHWAYS = ['motorway', 'trunk', 'primary'];
const MAX_PLAUSIBLE_BLOCK_AREA_M2 = 200000;
const HARD_BARRIER_TOLERANCE_M = 6;
const MIN_SHARED_EDGE_M = 3;
const MIN_EDGE_LENGTH_M = 1;
const SNAP_DECIMALS = 6;

function snapLine(line) {
  const seen = [];
  for (const [x, y] of line.geometry.coordinates) {
    const p = [Math.round(x * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS, Math.round(y * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS];
    if (!seen.length || seen[seen.length - 1][0] !== p[0] || seen[seen.length - 1][1] !== p[1]) seen.push(p);
  }
  return seen.length >= 2 ? turf.lineString(seen) : null;
}

function isDegenerate(line) {
  try { return turf.length(line, { units: 'kilometers' }) * 1000 < MIN_EDGE_LENGTH_M; }
  catch { return true; }
}

function clipToPaddedBbox(line, bbox) {
  let clipped;
  try { clipped = turf.bboxClip(line, bbox); } catch { return []; }
  if (!clipped.geometry.coordinates.length) return [];
  if (clipped.geometry.type === 'LineString') return clipped.geometry.coordinates.length >= 2 ? [clipped] : [];
  return clipped.geometry.coordinates.filter(c => c.length >= 2).map(c => turf.lineString(c));
}

function ringParam(bbox, [x, y]) {
  const [west, south, east, north] = bbox;
  const w = east - west, h = north - south, tol = 1e-7;
  if (Math.abs(y - south) < tol) return (x - west) / w;
  if (Math.abs(x - east) < tol) return 1 + (y - south) / h;
  if (Math.abs(y - north) < tol) return 2 + (east - x) / w;
  if (Math.abs(x - west) < tol) return 3 + (north - y) / h;
  return null;
}

// polygonize never auto-nodes a line endpoint that lands mid-edge on another
// line (a T-touch) — it only connects lines at coordinates they already share
// exactly. Build the ring's own vertex list from the 4 corners plus every point
// a clipped street touches, so the ring and the streets always share a real node.
function buildNodedRing(bbox, touchPoints) {
  const [west, south, east, north] = bbox;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  const withParams = [...corners, ...touchPoints]
    .map(p => ({ p, t: ringParam(bbox, p) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t);
  const ring = [];
  for (const { p } of withParams) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) ring.push(p);
  }
  ring.push(ring[0]);
  return turf.lineString(ring);
}

function buildEdgeSet(boundary, hardLines, softLines) {
  const bbox = paddedBbox(boundary);
  const clipped = [...hardLines, ...softLines].flatMap(l => clipToPaddedBbox(l, bbox));
  const touchPoints = clipped.flatMap(l => {
    const c = l.geometry.coordinates;
    return [c[0], c[c.length - 1]].filter(p => ringParam(bbox, p) !== null);
  });
  const paddedRing = buildNodedRing(bbox, touchPoints);
  let edges = [paddedRing, ...clipped].map(snapLine).filter(Boolean).filter(l => !isDegenerate(l));

  // drop exact-duplicate edges (same endpoints, either direction) — a duplicate
  // edge between the same two nodes produces a degenerate ring polygonize rejects
  const seenKeys = new Set();
  edges = edges.filter(l => {
    const c = l.geometry.coordinates;
    const a = c[0].join(','), b = c[c.length - 1].join(',');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  return { edges, bbox };
}

function sharedAdjacency(polyA, polyB, hardLines) {
  let overlap;
  try {
    overlap = turf.lineOverlap(turf.polygonToLine(polyA), turf.polygonToLine(polyB), { tolerance: 0.003 });
  } catch { return null; }
  if (!overlap?.features?.length) return null;

  const totalLen = overlap.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0) * 1000;
  if (totalLen < MIN_SHARED_EDGE_M) return null;

  let longest = overlap.features[0], longestLen = 0;
  overlap.features.forEach(f => {
    const l = turf.length(f, { units: 'kilometers' });
    if (l > longestLen) { longestLen = l; longest = f; }
  });
  const mid = turf.along(longest, longestLen / 2, { units: 'kilometers' });

  let minD = Infinity;
  for (const h of hardLines) {
    try { minD = Math.min(minD, turf.pointToLineDistance(mid, h, { units: 'meters' })); } catch {}
  }
  return { hard: minD < HARD_BARRIER_TOLERANCE_M };
}

export function buildBlocks(boundary, hardLines, softLines) {
  const { edges, bbox } = buildEdgeSet(boundary, hardLines, softLines);
  const paddedBoundary = turf.bboxPolygon(bbox);
  const rawFaces = turf.polygonize(turf.featureCollection(edges));

  const blocks = rawFaces.features
    .filter(f => {
      try { return turf.booleanPointInPolygon(turf.centroid(f), paddedBoundary) && turf.area(f) > 0; }
      catch { return false; }
    })
    .map(f => { try { return turf.intersect(f, boundary); } catch { return null; } })
    // size cap applies AFTER clipping — a face's pre-clip (padded) area is
    // inflated by whatever pad it happens to include, so checking before
    // clipping rejects legitimate blocks (found while validating this code)
    .filter(f => f && turf.area(f) > 1 && turf.area(f) < MAX_PLAUSIBLE_BLOCK_AREA_M2);

  const adjacency = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const adj = sharedAdjacency(blocks[i], blocks[j], hardLines);
      if (adj) adjacency.push({ a: i, b: j, hard: adj.hard });
    }
  }
  return { blocks, adjacency };
}

// Merge adjacent blocks smallest-combined-pair-first until zoneCount is reached.
// Adjacency is tracked by contraction: an edge between two ORIGINAL block indices
// becomes internal (skipped) once both indices map to the same current cluster —
// no re-computation of geometry/lineOverlap is needed after the initial adjacency
// from buildBlocks, since "hard" is a property of a specific real barrier segment
// and survives any merge on either side of it unchanged.
//
// The stop condition tracks the LIVE cluster count (new Set(owner).size), not
// clusters.length — clusters.length only ever grows (each merge appends a new
// entry rather than removing the two it replaces), so checking it against
// zoneCount stays true long after the real number of remaining zones has
// already hit the target, over-merging past it whenever a soft edge happens to
// still connect two live clusters (found via a 6-block chain regression test).
export function mergeBlocksToZones(blocks, adjacency, zoneCount) {
  let clusters = blocks.map(poly => ({ poly, area: turf.area(poly) }));
  let edges = adjacency.map(e => ({ ...e }));
  let owner = blocks.map((_, i) => i);

  while (new Set(owner).size > zoneCount) {
    let best = null;
    for (const e of edges) {
      if (e.hard) continue;
      const ci = owner[e.a], cj = owner[e.b];
      if (ci === cj) continue;
      const combined = clusters[ci].area + clusters[cj].area;
      if (!best || combined < best.combined) best = { ci, cj, combined };
    }
    if (!best) break; // no soft-mergeable pair left — stop early, more zones than requested

    const { ci, cj } = best;
    const merged = turf.union(clusters[ci].poly, clusters[cj].poly);
    const newIndex = clusters.length;
    clusters = [...clusters, { poly: merged, area: turf.area(merged) }];
    owner = owner.map(o => (o === ci || o === cj ? newIndex : o));
    edges = edges.filter(e => owner[e.a] !== owner[e.b]);
  }

  const liveClusterIndices = [...new Set(owner)];
  return liveClusterIndices.map(idx => clusters[idx].poly);
}

export function generateZones(boundary, zoneCount, hardLines, softLines) {
  const { blocks, adjacency } = buildBlocks(boundary, hardLines, softLines);
  if (!blocks.length) return [boundary];
  return mergeBlocksToZones(blocks, adjacency, zoneCount);
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

export async function fetchStreetGraph(boundary) {
  const [west, south, east, north] = paddedBbox(boundary);
  const query = `[out:json][timeout:25];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

  const data = await queryOverpass(query);

  const hardLines = [];
  const softLines = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway;
    const waterway = el.tags?.waterway;
    const line = turf.lineString(el.geometry.map(pt => [pt.lon, pt.lat]), { name: el.tags?.name ?? '' });
    (waterway || HARD_HIGHWAYS.includes(highway) ? hardLines : softLines).push(line);
  }
  return { hardLines, softLines };
}
