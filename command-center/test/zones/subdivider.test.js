import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { subdivideZone, subdivideWithBarriers, computeZoneCount, WALKED_RATE_M2_PER_MIN, DRIVEN_RATE_M2_PER_MIN } from '../../src/zones/subdivider.js';

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
