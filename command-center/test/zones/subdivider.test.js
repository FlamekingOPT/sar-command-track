import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { subdivideZone, subdivideWithBarriers, computeZoneCount, WALKED_RATE_M2_PER_MIN, DRIVEN_RATE_M2_PER_MIN, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS } from '../../src/zones/subdivider.js';

const SQUARE = turf.polygon([[
  [-118.25, 34.05], [-118.20, 34.05], [-118.20, 34.10],
  [-118.25, 34.10], [-118.25, 34.05],
]]);

describe('subdivideZone', () => {
  it('throws for n <= 0', () => {
    expect(() => subdivideZone(SQUARE, 0)).toThrow('n must be positive');
    expect(() => subdivideZone(SQUARE, -1)).toThrow('n must be positive');
  });

  it('returns original polygon unchanged when n = 1', () => {
    const result = subdivideZone(SQUARE, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(SQUARE);
  });

  it('returns approximately n sub-zones for n > 1', () => {
    const result = subdivideZone(SQUARE, 4);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('all sub-zone centroids are inside the original polygon', () => {
    for (const zone of subdivideZone(SQUARE, 6)) {
      expect(turf.booleanPointInPolygon(turf.centroid(zone), SQUARE)).toBe(true);
    }
  });

  it('sub-zones cover at least 90% of original area', () => {
    const result = subdivideZone(SQUARE, 4);
    const subArea = result.reduce((sum, z) => sum + turf.area(z), 0);
    expect(subArea / turf.area(SQUARE)).toBeGreaterThan(0.9);
  });
});

describe('subdivideWithBarriers', () => {
  // Vertical barrier 25% of the way across the square, so a genuine barrier
  // split yields ~25/75 areas — distinguishable from the 50/50 strip fallback.
  const BARRIER_X = -118.2375;

  it('splits along a barrier that ends inside the polygon', () => {
    // Enters from the south but stops at 34.08 — short of the north edge at 34.10
    const line = turf.lineString([
      [BARRIER_X, 34.04],
      [BARRIER_X, 34.06],
      [BARRIER_X, 34.08],
    ]);

    const zones = subdivideWithBarriers(SQUARE, 2, [line]);
    expect(zones).toHaveLength(2);

    const areas = zones.map(z => turf.area(z));
    const smallShare = Math.min(...areas) / turf.area(SQUARE);
    expect(smallShare).toBeGreaterThan(0.1);
    expect(smallShare).toBeLessThan(0.4);

    // The two zones sit on opposite sides of the barrier
    const xs = zones.map(z => turf.centroid(z).geometry.coordinates[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(BARRIER_X);
    expect(xs[1]).toBeGreaterThan(BARRIER_X);
  });

  it('still splits along a barrier that fully crosses the polygon', () => {
    const line = turf.lineString([
      [BARRIER_X, 34.03],
      [BARRIER_X, 34.06],
      [BARRIER_X, 34.09],
      [BARRIER_X, 34.12],
    ]);

    const zones = subdivideWithBarriers(SQUARE, 2, [line]);
    expect(zones).toHaveLength(2);

    const smallShare = Math.min(...zones.map(z => turf.area(z))) / turf.area(SQUARE);
    expect(smallShare).toBeGreaterThan(0.1);
    expect(smallShare).toBeLessThan(0.4);
  });
});

describe('computeZoneCount', () => {
  it('exposes the validated per-minute coverage rates', () => {
    expect(WALKED_RATE_M2_PER_MIN).toBe(1609);
    expect(DRIVEN_RATE_M2_PER_MIN).toBe(10729);
  });

  it('divides boundary area by the walked rate for walked mode', () => {
    const boundaryArea = 30 * WALKED_RATE_M2_PER_MIN * 5; // exactly 5 zones' worth
    expect(computeZoneCount(boundaryArea, 30, 'walked')).toBe(5);
  });

  it('divides boundary area by the driven rate for driven mode', () => {
    const boundaryArea = 20 * DRIVEN_RATE_M2_PER_MIN * 3; // exactly 3 zones' worth
    expect(computeZoneCount(boundaryArea, 20, 'driven')).toBe(3);
  });

  it('rounds to the nearest whole zone', () => {
    // 30 * 1609 = 48270 m2 per zone; 3.4 zones' worth rounds to 3
    expect(computeZoneCount(48270 * 3.4, 30, 'walked')).toBe(3);
  });

  it('never returns less than 1 zone', () => {
    expect(computeZoneCount(10, 30, 'walked')).toBe(1);
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

// A small 4-way intersection: one hard road (simulating a primary highway) running
// north-south, one soft road (a residential street) running east-west, meeting at
// the boundary's center. Streets must be pre-split at the crossing and must extend
// past the padded fetch area on both ends — turf.polygonize requires lines to share
// an exact vertex at every intersection (true of real OSM data; not true of two
// straight lines that only cross geometrically), and a line that dangles inside the
// padded area without reaching its edge can never close a face.
const GRID_BOUNDARY = turf.polygon([[[0, 0], [0.003, 0], [0.003, 0.003], [0, 0.003], [0, 0]]]);
const HARD_VERTICAL = [
  turf.lineString([[0.0015, -0.01], [0.0015, 0.0015]]),
  turf.lineString([[0.0015, 0.0015], [0.0015, 0.013]]),
];
const SOFT_HORIZONTAL = [
  turf.lineString([[-0.01, 0.0015], [0.0015, 0.0015]]),
  turf.lineString([[0.0015, 0.0015], [0.013, 0.0015]]),
];

describe('buildBlocks', () => {
  it('produces 4 quadrant blocks covering 100% of the boundary', () => {
    const { blocks } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(blocks).toHaveLength(4);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeLessThan(1.001);
  });

  it('classifies the shared border across the hard road as hard, and across the soft road as soft', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(adjacency.some(a => a.hard === true)).toBe(true);
    expect(adjacency.some(a => a.hard === false)).toBe(true);
  });

  it('returns a single block covering the whole boundary when no streets are given', () => {
    const { blocks } = buildBlocks(GRID_BOUNDARY, [], []);
    expect(blocks).toHaveLength(1);
    expect(turf.area(blocks[0]) / turf.area(GRID_BOUNDARY)).toBeCloseTo(1, 3);
  });

  it('does not throw on duplicate/near-duplicate hard lines (polygonize edge-ring regression)', () => {
    const nearDuplicate = turf.lineString(
      HARD_VERTICAL[0].geometry.coordinates.map(([x, y]) => [x + 1e-9, y])
    );
    expect(() =>
      buildBlocks(GRID_BOUNDARY, [...HARD_VERTICAL, nearDuplicate, HARD_VERTICAL[0]], SOFT_HORIZONTAL)
    ).not.toThrow();
  });

  it('HARD_HIGHWAYS covers motorway/trunk/primary only', () => {
    expect(HARD_HIGHWAYS).toEqual(['motorway', 'trunk', 'primary']);
  });
});
