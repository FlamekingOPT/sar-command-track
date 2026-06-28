import * as turf from '@turf/turf';

/**
 * Divide a GeoJSON polygon feature into approximately n sub-zone features.
 * Uses a square grid clipped to the polygon shape.
 * @param {GeoJSON.Feature<GeoJSON.Polygon>} polygon
 * @param {number} n
 * @returns {GeoJSON.Feature<GeoJSON.Polygon>[]}
 */
export function subdivideZone(polygon, n) {
  if (n <= 0) throw new Error('n must be positive');
  if (n === 1) return [polygon];

  const totalAreaM2 = turf.area(polygon);
  const cellSizeKm = Math.sqrt(totalAreaM2 / n) / 1000;
  const [minX, minY, maxX, maxY] = turf.bbox(polygon);
  const pad = cellSizeKm / 100;
  const bbox = [minX - pad, minY - pad, maxX + pad, maxY + pad];

  const grid = turf.squareGrid(bbox, cellSizeKm, { units: 'kilometers' });
  const minAreaM2 = totalAreaM2 / (n * 10);

  return grid.features
    .map(cell => turf.intersect(cell, polygon))
    .filter(Boolean)
    .filter(cell => turf.area(cell) >= minAreaM2);
}
