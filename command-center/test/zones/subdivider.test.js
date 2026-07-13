import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { subdivideZone, subdivideWithBarriers, gridSubdivide } from '../../src/zones/subdivider.js';

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

const IRREGULAR = turf.polygon([[
  [-118.30, 34.02], [-118.25, 34.10], [-118.15, 34.12], [-118.10, 34.05],
  [-118.18, 34.00], [-118.30, 34.02],
]]);

describe('gridSubdivide', () => {
  it('returns the original polygon unchanged when n <= 1', () => {
    const result = gridSubdivide(SQUARE, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(SQUARE);
  });

  it('produces exactly n cells for a simple square', () => {
    const result = gridSubdivide(SQUARE, 4);
    expect(result).toHaveLength(4);
  });

  it('covers ~100% of the original area (never drops a sliver)', () => {
    const result = gridSubdivide(SQUARE, 4);
    const subArea = result.reduce((sum, z) => sum + turf.area(z), 0);
    expect(subArea / turf.area(SQUARE)).toBeGreaterThan(0.99);
  });

  it('covers ~100% of an irregular/concave polygon too', () => {
    const result = gridSubdivide(IRREGULAR, 7);
    expect(result).toHaveLength(7);
    const subArea = result.reduce((sum, z) => sum + turf.area(z), 0);
    expect(subArea / turf.area(IRREGULAR)).toBeGreaterThan(0.99);
  });

  it('never leaves a cell under 15% of the target per-cell area (no orphaned slivers)', () => {
    const result = gridSubdivide(IRREGULAR, 10);
    const target = turf.area(IRREGULAR) / 10;
    for (const cell of result) {
      expect(turf.area(cell)).toBeGreaterThanOrEqual(target * 0.15);
    }
  });

  it('all cell centroids are inside the original polygon', () => {
    for (const cell of gridSubdivide(SQUARE, 6)) {
      expect(turf.booleanPointInPolygon(turf.centroid(cell), SQUARE)).toBe(true);
    }
  });
});
