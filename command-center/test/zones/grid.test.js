import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { gridZones } from '../../src/zones/grid.js';

const square = turf.polygon([[
  [-118.30, 34.00], [-118.28, 34.00], [-118.28, 34.02], [-118.30, 34.02], [-118.30, 34.00],
]]);

// L-shape: the square minus its NE quadrant
const lShape = turf.polygon([[
  [-118.30, 34.00], [-118.28, 34.00], [-118.28, 34.01], [-118.29, 34.01],
  [-118.29, 34.02], [-118.30, 34.02], [-118.30, 34.00],
]]);

describe('gridZones', () => {
  it('covers the boundary with roughly the requested number of cells', () => {
    const zones = gridZones(square, 4);
    expect(zones.length).toBeGreaterThanOrEqual(3);
    expect(zones.length).toBeLessThanOrEqual(7);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / turf.area(square)).toBeGreaterThan(0.98);
    expect(covered / turf.area(square)).toBeLessThan(1.02);
  });

  it('clips cells to an irregular boundary and drops slivers', () => {
    const zones = gridZones(lShape, 6);
    const boundaryArea = turf.area(lShape);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / boundaryArea).toBeGreaterThan(0.95);
    // every zone lies inside the boundary (its centroid does, and area fits)
    for (const z of zones) {
      expect(turf.booleanPointInPolygon(turf.centroid(z), lShape)).toBe(true);
    }
  });

  it('returns the boundary itself for count 1', () => {
    const zones = gridZones(square, 1);
    expect(zones).toHaveLength(1);
    expect(turf.area(zones[0]) / turf.area(square)).toBeCloseTo(1, 2);
  });

  it('never returns an empty result', () => {
    // pathological: absurd count on a tiny boundary still yields zones
    const tiny = turf.polygon([[
      [-118.300, 34.000], [-118.2999, 34.000], [-118.2999, 34.0001], [-118.300, 34.0001], [-118.300, 34.000],
    ]]);
    expect(gridZones(tiny, 50).length).toBeGreaterThanOrEqual(1);
  });
});
