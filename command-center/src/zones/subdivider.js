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
  if (n <= 1) return [polygon];
  return stripSubdivide(polygon, n);
}

// ── internals ─────────────────────────────────────────────────────────────────

// Cut a polygon along a road/waterway line using a 1m buffer + difference.
// Returns 2 parts if the line actually crosses; otherwise returns the original.
function cutByBarrier(polygon, line) {
  try {
    if (!turf.booleanIntersects(line, polygon)) return [polygon];

    // 10m buffer creates a thin strip along the road — enough for difference to split
    const strip = turf.buffer(line, 0.01, { units: 'kilometers' });
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
