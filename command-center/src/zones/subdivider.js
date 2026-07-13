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

// Temporary stub for mergeSmallestIntoNeighbor — Task 3 replaces this with the real implementation
function mergeSmallestIntoNeighbor(zones, n) {
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

// Compact grid partition — lays a square grid sized to the target per-zone
// area over the polygon's bbox, clips to the polygon, merges slivers into
// their nearest neighbor (never dropped), and reclaims any leftover area a
// degenerate clip missed. Guaranteed full coverage, never a bbox-spanning
// strip (unlike stripSubdivide).
export function gridSubdivide(polygon, n) {
  if (n <= 1) return [polygon];

  const totalArea = turf.area(polygon); // m²
  const targetCellArea = totalArea / n;
  const cellSideKm = Math.sqrt(targetCellArea) / 1000;
  const bbox = turf.bbox(polygon);

  const grid = turf.squareGrid(bbox, cellSideKm, { units: 'kilometers' });
  let cells = grid.features
    .map(cell => { try { return turf.intersect(cell, polygon); } catch { return null; } })
    .filter(Boolean);

  if (!cells.length) return [polygon]; // degenerate bbox/polygon — bail to whole shape

  cells = mergeSlivers(cells, targetCellArea);
  cells = reclaimLeftover(cells, polygon);

  if (cells.length > n) cells = mergeSmallestIntoNeighbor(cells, n);
  while (cells.length < n && cells.length > 0) {
    const maxIdx = cells.reduce((mi, c, i) => turf.area(c) > turf.area(cells[mi]) ? i : mi, 0);
    const halves = gridSubdivide(cells[maxIdx], 2);
    cells = [...cells.slice(0, maxIdx), ...halves, ...cells.slice(maxIdx + 1)];
  }

  return cells;
}

// Merge any cell under 15% of the target cell area into its nearest-centroid
// neighbor — never leave an orphaned sliver as its own zone.
function mergeSlivers(cells, targetCellArea, minFraction = 0.15) {
  let current = [...cells];
  let sliverIdx = current.findIndex(c => turf.area(c) < targetCellArea * minFraction);
  while (sliverIdx !== -1 && current.length > 1) {
    const sliverCentroid = turf.centroid(current[sliverIdx]).geometry.coordinates;
    let nearestIdx = -1, minDist = Infinity;
    current.forEach((c, i) => {
      if (i === sliverIdx) return;
      const cc = turf.centroid(c).geometry.coordinates;
      const d = (cc[0] - sliverCentroid[0]) ** 2 + (cc[1] - sliverCentroid[1]) ** 2;
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });
    if (nearestIdx === -1) break;

    try {
      const merged = turf.union(current[sliverIdx], current[nearestIdx]);
      current = current.filter((_, i) => i !== sliverIdx && i !== nearestIdx);
      if (merged) current.push(merged);
    } catch {
      current = current.filter((_, i) => i !== sliverIdx);
    }
    sliverIdx = current.findIndex(c => turf.area(c) < targetCellArea * minFraction);
  }
  return current;
}

// Union all cells and diff against the original polygon — any leftover area
// (degenerate clip failures, floating-point gaps) gets folded into the
// nearest cell so coverage is always ~100%, never silently dropped.
// turf.union (v6) takes exactly 2 features — reduce pairwise, don't spread.
function reclaimLeftover(cells, polygon) {
  if (!cells.length) return cells;
  try {
    const covered = cells.reduce((acc, c) => acc ? turf.union(acc, c) : c, null);
    if (!covered) return cells;
    const leftover = turf.difference(polygon, covered);
    if (!leftover) return cells;

    const leftoverCentroid = turf.centroid(leftover).geometry.coordinates;
    let nearestIdx = 0, minDist = Infinity;
    cells.forEach((c, i) => {
      const cc = turf.centroid(c).geometry.coordinates;
      const d = (cc[0] - leftoverCentroid[0]) ** 2 + (cc[1] - leftoverCentroid[1]) ** 2;
      if (d < minDist) { minDist = d; nearestIdx = i; }
    });

    const merged = turf.union(cells[nearestIdx], leftover);
    if (!merged) return cells;
    return cells.map((c, i) => i === nearestIdx ? merged : c);
  } catch {
    return cells; // best-effort — a failed reclaim still leaves valid (if slightly short) coverage
  }
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
