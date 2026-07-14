import * as turf from '@turf/turf';

// Fetch only meaningful SAR barriers from OpenStreetMap
export async function fetchOSMBarriers(polygon) {
  const [west, south, east, north] = turf.bbox(polygon);
  const query = `[out:json][timeout:25];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
  });
  const data = await resp.json();

  return data.elements
    .filter(el => el.type === 'way' && el.geometry?.length >= 2)
    .map(el => turf.lineString(
      el.geometry.map(pt => [pt.lon, pt.lat]),
      { barrierType: el.tags?.waterway ? 'waterway' : 'road', name: el.tags?.name ?? '' }
    ));
}

// Main export: split using actual road/waterway geometry, fall back to strips
export function subdivideWithBarriers(polygon, n, barrierLines) {
  if (n <= 1) return [polygon];
  if (!barrierLines?.length) return stripSubdivide(polygon, n);

  // Only use barriers that run meaningfully through the polygon (>50m inside)
  const scored = barrierLines
    .map(line => ({ line, score: lengthInsidePoly(line, polygon) }))
    .filter(s => s.score > 0.05)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return stripSubdivide(polygon, n);

  // Apply each barrier — split every current zone it crosses
  let zones = [polygon];
  for (const { line } of scored) {
    const next = [];
    for (const zone of zones) {
      next.push(...cutByBarrier(zone, line));
    }
    zones = next;
    if (zones.length >= n * 3) break; // don't over-fragment
  }

  // Too many pieces → merge nearest-centroid pairs down to n
  if (zones.length > n) zones = mergeToN(zones, n);

  // Too few → strip-split the largest zones
  while (zones.length < n) {
    const maxIdx = zones.reduce((mi, z, i) =>
      turf.area(z) > turf.area(zones[mi]) ? i : mi, 0);
    const halves = stripSubdivide(zones[maxIdx], 2);
    zones = [...zones.slice(0, maxIdx), ...halves, ...zones.slice(maxIdx + 1)];
  }

  return zones;
}

// Plain strip subdivision (used for sub-zones and as fallback)
export function subdivideZone(polygon, n) {
  if (n <= 0) throw new Error('n must be positive');
  if (n === 1) return [polygon];
  return stripSubdivide(polygon, n);
}

// ── internals ─────────────────────────────────────────────────────────────────

// Cut a polygon along a road/waterway line using a 1m buffer + difference.
// Returns 2 parts if the line actually crosses; otherwise returns the original.
function cutByBarrier(polygon, line) {
  try {
    if (!turf.booleanIntersects(line, polygon)) return [polygon];

    // OSM ways are frequently split into short segments at intersections, so a
    // segment's endpoint often lands inside the polygon instead of past its
    // edge. Buffering+differencing a line that stops mid-polygon only carves a
    // dead-end notch (stays a single Polygon) instead of a full split, so
    // extend both ends past the polygon along their local bearing first.
    const extended = extendPastPolygon(line, polygon);

    // 10m buffer creates a thin strip along the road — enough for difference to split
    const strip = turf.buffer(extended, 0.01, { units: 'kilometers' });
    if (!strip) return [polygon];

    const cut = turf.difference(polygon, strip);
    if (!cut) return [polygon];

    if (cut.geometry.type === 'MultiPolygon') {
      const totalArea = turf.area(polygon);
      const parts = cut.geometry.coordinates
        .map(coords => turf.polygon(coords))
        .filter(p => turf.area(p) > totalArea * 0.04); // drop tiny road-edge slivers
      return parts.length >= 2 ? parts : [polygon];
    }

    return [polygon]; // line didn't actually split it (runs along edge, etc.)
  } catch {
    return [polygon];
  }
}

// Extend both ends of a line along their local bearing until past the
// polygon's bbox, so buffering it always cuts clean through.
function extendPastPolygon(line, polygon) {
  const coords = line.geometry.coordinates;
  if (coords.length < 2) return line;

  // bbox diagonal is the farthest any interior endpoint can be from the edge
  const [west, south, east, north] = turf.bbox(polygon);
  const reach = turf.distance([west, south], [east, north], { units: 'kilometers' });

  const startBearing = turf.bearing(coords[1], coords[0]);
  const endBearing = turf.bearing(coords[coords.length - 2], coords[coords.length - 1]);
  const newStart = turf.destination(coords[0], reach, startBearing, { units: 'kilometers' });
  const newEnd = turf.destination(coords[coords.length - 1], reach, endBearing, { units: 'kilometers' });

  return turf.lineString(
    [newStart.geometry.coordinates, ...coords, newEnd.geometry.coordinates],
    line.properties
  );
}

// Merge zones pairwise by nearest centroid until we have n zones
function mergeToN(zones, n) {
  let current = [...zones];
  while (current.length > n) {
    const centroids = current.map(z => turf.centroid(z).geometry.coordinates);

    let minDist = Infinity, mi = 0, mj = 1;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const dx = centroids[i][0] - centroids[j][0];
        const dy = centroids[i][1] - centroids[j][1];
        const d = dx * dx + dy * dy;
        if (d < minDist) { minDist = d; mi = i; mj = j; }
      }
    }

    try {
      const merged = turf.union(current[mi], current[mj]);
      current = current.filter((_, i) => i !== mi && i !== mj);
      if (merged) current.push(merged);
    } catch {
      current = current.filter((_, i) => i !== mj);
    }
  }
  return current;
}

// Strip subdivision along the longer axis — guaranteed full coverage
function stripSubdivide(polygon, n) {
  if (polygon.geometry?.type === 'MultiPolygon') {
    const parts = polygon.geometry.coordinates.map(c => turf.polygon(c));
    const total = parts.reduce((s, p) => s + turf.area(p), 0);
    const result = [];
    for (const part of parts) {
      const share = Math.max(1, Math.round(n * turf.area(part) / total));
      result.push(...stripSubdivide(part, share));
    }
    return result;
  }

  const [minX, minY, maxX, maxY] = turf.bbox(polygon);
  const w = maxX - minX;
  const h = maxY - minY;
  const horiz = h >= w;
  const strips = [];

  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const bbox = horiz
      ? [minX, minY + t0 * h, maxX, minY + t1 * h]
      : [minX + t0 * w, minY, minX + t1 * w, maxY];
    try {
      const isect = turf.intersect(turf.bboxPolygon(bbox), polygon);
      if (isect) strips.push(isect);
    } catch { /* skip degenerate */ }
  }
  return strips;
}

function lengthInsidePoly(line, polygon) {
  try {
    const pts = line.geometry.coordinates.filter(c =>
      turf.booleanPointInPolygon(turf.point(c), polygon)
    );
    return pts.length >= 2
      ? turf.length(turf.lineString(pts), { units: 'kilometers' })
      : 0;
  } catch { return 0; }
}

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
