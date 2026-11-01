import * as turf from '@turf/turf';

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

// Zone numbers snake across the map — north row west→east, next row east→west
// — so consecutive numbers stay physically adjacent even across row breaks
// (straight page order teleported the sequence to the far west at every new
// row; field feedback 2026-07-15). Centroids are banded into ~sqrt(n) rows.
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
    .sort((a, b) => {
      const ba = band(a.lat), bb = band(b.lat);
      if (ba !== bb) return ba - bb;
      return ba % 2 === 0 ? a.lon - b.lon : b.lon - a.lon;
    })
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
