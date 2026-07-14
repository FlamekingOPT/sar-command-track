import * as turf from '@turf/turf';

// Grid fallback (spec 2026-07-14 street-tile-cache): when street data is
// unavailable for a boundary — live Overpass down AND no prefetched tiles —
// zones degrade to a plain square grid clipped to the boundary. Pure turf
// math, no network, cannot fail; the letter-zone-era reliability with the
// new numbering. Slivers under 5% of a cell get merged away by dropping them
// (their area is covered by rounding of neighbors' clip, acceptable for a
// fallback path).
const MIN_CELL_FRACTION = 0.05;

export function gridZones(boundaryFeature, count) {
  if (count <= 1) return [boundaryFeature];
  const areaM2 = turf.area(boundaryFeature);
  const cellSideKm = Math.sqrt(areaM2 / count) / 1000;
  if (!(cellSideKm > 0)) return [boundaryFeature];

  // Not turf.squareGrid: it only places cells that fit WHOLLY inside the bbox,
  // leaving uncovered margins at the east/north edges. Divide the bbox into
  // cols×rows cells that tile it exactly instead.
  const [west, south, east, north] = turf.bbox(boundaryFeature);
  const widthKm = turf.distance([west, south], [east, south], { units: 'kilometers' });
  const heightKm = turf.distance([west, south], [west, north], { units: 'kilometers' });
  const cols = Math.max(1, Math.round(widthKm / cellSideKm));
  const rows = Math.max(1, Math.round(heightKm / cellSideKm));
  const dx = (east - west) / cols;
  const dy = (north - south) / rows;

  const zones = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = turf.bboxPolygon([west + c * dx, south + r * dy, west + (c + 1) * dx, south + (r + 1) * dy]);
      let clipped;
      try { clipped = turf.intersect(cell, boundaryFeature); } catch { clipped = null; }
      if (clipped && turf.area(clipped) > turf.area(cell) * MIN_CELL_FRACTION) zones.push(clipped);
    }
  }
  return zones.length ? zones : [boundaryFeature];
}
