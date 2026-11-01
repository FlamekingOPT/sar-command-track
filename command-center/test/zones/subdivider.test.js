import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, HARD_HIGHWAYS } from '../../src/zones/subdivider.js';

describe('allocateZoneCounts', () => {
  it('splits proportionally by block count and sums exactly to the total', () => {
    // 14 zones across a 100-block boundary and a 9-block boundary:
    // raw shares 12.84 / 1.16 → floors 12 / 1, leftover 1 goes to the
    // largest fractional remainder (the 100-block boundary) → 13 / 1.
    expect(allocateZoneCounts(14, [100, 9])).toEqual([13, 1]);
  });

  it('always sums exactly to the total across awkward splits', () => {
    for (const [total, weights] of [[150, [70, 40, 12]], [7, [3, 3, 3]], [10, [1, 1, 1, 1]]]) {
      const alloc = allocateZoneCounts(total, weights);
      expect(alloc.reduce((s, a) => s + a, 0)).toBe(total);
    }
  });

  it('gives every boundary at least 1 zone', () => {
    expect(allocateZoneCounts(5, [1000, 1])).toEqual([4, 1]);
  });

  it('handles all-zero weights by giving 1 each', () => {
    expect(allocateZoneCounts(3, [0, 0])).toEqual([1, 1]);
  });
});

describe('paddedBbox', () => {
  const square = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  it('pads every side outward by ~BOUNDARY_PAD_METERS', () => {
    const [west, south, east, north] = turf.bbox(square);
    const [pWest, pSouth, pEast, pNorth] = paddedBbox(square);

    const westPad = turf.distance([west, south], [pWest, south], { units: 'kilometers' }) * 1000;
    const eastPad = turf.distance([east, south], [pEast, south], { units: 'kilometers' }) * 1000;
    const southPad = turf.distance([west, south], [west, pSouth], { units: 'kilometers' }) * 1000;
    const northPad = turf.distance([west, north], [west, pNorth], { units: 'kilometers' }) * 1000;

    for (const pad of [westPad, eastPad, southPad, northPad]) {
      expect(pad).toBeGreaterThan(BOUNDARY_PAD_METERS - 5);
      expect(pad).toBeLessThan(BOUNDARY_PAD_METERS + 5);
    }
  });

  it('accepts a custom pad distance', () => {
    const [west, south] = turf.bbox(square);
    const [pWest, pSouth] = paddedBbox(square, 100);
    const westPad = turf.distance([west, south], [pWest, south], { units: 'kilometers' }) * 1000;
    expect(westPad).toBeGreaterThan(95);
    expect(westPad).toBeLessThan(105);
  });
});

describe('HARD_HIGHWAYS', () => {
  it('covers motorway/trunk/primary only', () => {
    expect(HARD_HIGHWAYS).toEqual(['motorway', 'trunk', 'primary']);
  });
});

describe('orderZonesForNumbering', () => {
  // 3x3 grid of unit squares, fed in shuffled order. Reading order = north row
  // first, west→east within a row: centroids (lat 2.5, lon 0.5/1.5/2.5), then
  // lat 1.5 row, then lat 0.5 row.
  const cell = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
  const shuffled = [cell(1, 1), cell(2, 2), cell(0, 0), cell(2, 0), cell(0, 2), cell(1, 0), cell(2, 1), cell(0, 1), cell(1, 2)];

  it('orders zones in a serpentine: north row west→east, next row east→west, …', () => {
    // Straight page order teleports the number sequence across the whole map
    // at every row break (…3 ends far east, 4 restarts far west). Serpentine
    // keeps consecutive numbers physically adjacent — command can point at
    // zone 7 and know 6 and 8 are next door (field feedback 2026-07-15).
    const ordered = orderZonesForNumbering(shuffled);
    const key = p => {
      const [lon, lat] = turf.centroid(p).geometry.coordinates;
      return `${Math.floor(lon)},${Math.floor(lat)}`;
    };
    expect(ordered.map(key)).toEqual([
      '0,2', '1,2', '2,2',
      '2,1', '1,1', '0,1',
      '0,0', '1,0', '2,0',
    ]);
  });

  it('returns the same polygons, just reordered', () => {
    const ordered = orderZonesForNumbering(shuffled);
    expect(ordered).toHaveLength(9);
    for (const p of shuffled) expect(ordered).toContain(p);
  });
});
