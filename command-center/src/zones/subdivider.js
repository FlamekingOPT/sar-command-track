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

// Largest-remainder allocation: split `total` zones across boundaries
// proportionally to `weights` (their block counts), minimum 1 each, summing
// exactly to `total`. The only case the sum exceeds `total` is more boundaries
// than requested zones — the min-1 floor wins there by design (spec §1).
export function allocateZoneCounts(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!sum) return weights.map(() => 1);
  const raw = weights.map(w => (total * w) / sum);
  const alloc = raw.map(r => Math.max(1, Math.floor(r)));
  let leftover = total - alloc.reduce((s, a) => s + a, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byRemainder) {
    if (leftover <= 0) break;
    alloc[i] += 1;
    leftover -= 1;
  }
  return alloc;
}

// Zone numbers should read like a page — north rows first, west→east within a
// row — so zone 47 sits next to zone 46 on the map instead of build-order
// lottery numbers. Centroids are banded into ~sqrt(n) latitude rows.
export function orderZonesForNumbering(polys) {
  if (polys.length <= 1) return [...polys];
  const withC = polys.map(p => {
    const [lon, lat] = turf.centroid(p).geometry.coordinates;
    return { p, lon, lat };
  });
  const lats = withC.map(c => c.lat);
  const maxLat = Math.max(...lats), minLat = Math.min(...lats);
  const rows = Math.max(1, Math.round(Math.sqrt(polys.length)));
  const rowH = (maxLat - minLat) / rows || 1;
  const band = lat => Math.min(rows - 1, Math.floor((maxLat - lat) / rowH));
  return withC
    .sort((a, b) => band(a.lat) - band(b.lat) || a.lon - b.lon)
    .map(c => c.p);
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

// maxBlockAreaM2 rejects polygonize artifacts (faces leaking past real
// streets), but it MUST scale with detail level: the 0.2 km² default suits
// full residential detail, while district/city LOD produces legitimately
// km-scale blocks between major roads. A Beverly Hills field test at city
// detail once discarded every real block and kept only sliver-confetti
// because this cap was hard-coded — callers using coarse detail must pass a
// cap sized to their expected zone area.
export function buildBlocks(boundary, hardLines, softLines, { maxBlockAreaM2 = MAX_PLAUSIBLE_BLOCK_AREA_M2 } = {}) {
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
    .filter(f => f && turf.area(f) > 1 && turf.area(f) < maxBlockAreaM2);

  const adjacency = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const adj = sharedAdjacency(blocks[i], blocks[j], hardLines);
      if (adj) adjacency.push({ a: i, b: j, hard: adj.hard });
    }
  }
  return { blocks, adjacency };
}

// Divide blocks among zoneCount zones with EQUAL BLOCK COUNT per zone, by
// seeded region-growing: each zone BFS-grows through soft adjacency until it
// holds ceil(unassigned / zonesRemaining) blocks. Balancing block count
// instead of area is what makes zone sizes track density: dense areas have
// many small blocks, so equal-count zones come out physically small there and
// physically large in sparse areas — the block graph is itself the density
// signal, no extra data needed (2026-07-14 spec).
//
// Region-growing rather than pairwise cluster merging is deliberate: greedy
// smallest-pair-first merging strands single blocks between already-grown
// neighbors (an 8-block chain asked for 4 zones came out 3/1/2/2 — which pair
// merges first among equal-area candidates even came down to float noise in
// turf.area). Growing every zone to an explicit per-zone target makes balance
// hold by construction and keeps the result deterministic.
//
// Hard edges (motorway/trunk/primary, waterways) are simply absent from the
// adjacency lists, so a zone can never grow across one. When hard roads box a
// region in before it reaches its target, the region closes early and the
// remaining blocks form extra zones — same "more zones than requested rather
// than crossing a hard road" semantics as always.
export function mergeBlocksToZones(blocks, adjacency, zoneCount) {
  if (!blocks.length) return [];
  const neighbors = blocks.map(() => []);
  for (const e of adjacency) {
    if (e.hard) continue;
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }

  const assigned = new Array(blocks.length).fill(false);
  const regions = [];
  let unassigned = blocks.length;
  while (unassigned > 0) {
    const zonesRemaining = Math.max(1, zoneCount - regions.length);
    const target = Math.ceil(unassigned / zonesRemaining);
    const seed = assigned.indexOf(false);
    const region = [seed];
    assigned[seed] = true;
    const queue = [seed];
    while (region.length < target && queue.length) {
      const cur = queue.shift();
      for (const nb of neighbors[cur]) {
        if (assigned[nb] || region.length >= target) continue;
        assigned[nb] = true;
        region.push(nb);
        queue.push(nb);
      }
    }
    unassigned -= region.length;
    regions.push(region);
  }

  return regions.map(region =>
    region.slice(1).reduce((poly, i) => turf.union(poly, blocks[i]), blocks[region[0]])
  );
}

export function generateZones(boundary, zoneCount, hardLines, softLines) {
  const { blocks, adjacency } = buildBlocks(boundary, hardLines, softLines);
  if (!blocks.length) return [boundary];
  return mergeBlocksToZones(blocks, adjacency, zoneCount);
}
