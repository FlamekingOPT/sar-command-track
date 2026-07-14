import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { computeZoneCount, allocateZoneCounts, orderZonesForNumbering, WALKED_RATE_M2_PER_MIN, DRIVEN_RATE_M2_PER_MIN, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones } from '../../src/zones/subdivider.js';

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

// Four unit squares in a 2x2 grid: [0][1] on top, [2][3] on bottom.
// 0-1 and 2-3 are horizontally adjacent (soft); 0-2 and 1-3 are vertically
// adjacent (hard) — mirrors a hard road running east-west through the middle.
const SQ = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
const FOUR_BLOCKS = [SQ(0, 1), SQ(1, 1), SQ(0, 0), SQ(1, 0)];
const FOUR_ADJACENCY = [
  { a: 0, b: 1, hard: false },
  { a: 2, b: 3, hard: false },
  { a: 0, b: 2, hard: true },
  { a: 1, b: 3, hard: true },
];

describe('mergeBlocksToZones', () => {
  it('returns blocks unchanged when zoneCount >= block count', () => {
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 4);
    expect(zones).toHaveLength(4);
  });

  it('merges the two soft-adjacent pairs down to 2 zones, never crossing the hard divide', () => {
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    expect(zones).toHaveLength(2);
    // each zone should span the full row (x: 0..2, 1 unit tall) — a row, not a column.
    // (turf.area returns real geodesic m2, not planar "2", so bbox shape is the
    // direct way to check this rather than an area magic number.)
    for (const z of zones) {
      const [minX, minY, maxX, maxY] = turf.bbox(z);
      expect(maxX - minX).toBeCloseTo(2, 5);
      expect(maxY - minY).toBeCloseTo(1, 5);
    }
  });

  it('stops early rather than crossing a hard adjacency', () => {
    // asking for 1 zone is impossible without crossing the hard divide
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 1);
    expect(zones).toHaveLength(2);
  });

  it('covers the same total area as the input blocks', () => {
    const totalBefore = FOUR_BLOCKS.reduce((s, b) => s + turf.area(b), 0);
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    const totalAfter = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(totalAfter).toBeCloseTo(totalBefore, 5);
  });

  it('stops exactly at zoneCount on a long chain, not just when it runs out of soft edges', () => {
    // Regression for a real bug found while verifying this plan: tracking the
    // stop condition off the ever-growing clusters array (which never shrinks —
    // every merge appends a new entry rather than removing the two old ones)
    // instead of the live cluster count let a 6-block chain merge all the way
    // down to 1 zone when 2 were asked for, because "clusters.length > zoneCount"
    // stayed true long after only 2 zones actually remained.
    const chainBlocks = [0, 1, 2, 3, 4, 5].map(x =>
      turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]])
    );
    const chainAdjacency = [0, 1, 2, 3, 4].map(i => ({ a: i, b: i + 1, hard: false }));

    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 2)).toHaveLength(2);
    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 3)).toHaveLength(3);
    expect(mergeBlocksToZones(chainBlocks, chainAdjacency, 6)).toHaveLength(6);
  });
});

describe('mergeBlocksToZones — equal block count (density-varying zone sizes)', () => {
  // A row of 8 soft-adjacent blocks: six 1-unit-wide "downtown" blocks followed
  // by two 4-unit-wide "hillside" blocks. Equal-AREA merging packs the small
  // blocks together long before touching the big ones; equal-BLOCK-COUNT
  // merging must yield 4 zones of 2 blocks each — three small zones covering
  // the dense side, one big zone covering the sparse side.
  const widths = [1, 1, 1, 1, 1, 1, 4, 4];
  const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
  const rowBlocks = widths.map((w, i) =>
    turf.polygon([[[xs[i], 0], [xs[i + 1], 0], [xs[i + 1], 1], [xs[i], 1], [xs[i], 0]]])
  );
  const rowAdjacency = [0, 1, 2, 3, 4, 5, 6].map(i => ({ a: i, b: i + 1, hard: false }));

  it('balances block count per zone: dense side gets small zones, sparse side big ones', () => {
    const zones = mergeBlocksToZones(rowBlocks, rowAdjacency, 4);
    expect(zones).toHaveLength(4);
    const zoneWidths = zones
      .map(z => { const b = turf.bbox(z); return b[2] - b[0]; })
      .sort((a, b) => a - b);
    expect(zoneWidths[0]).toBeCloseTo(2, 5);
    expect(zoneWidths[1]).toBeCloseTo(2, 5);
    expect(zoneWidths[2]).toBeCloseTo(2, 5);
    expect(zoneWidths[3]).toBeCloseTo(8, 5);
  });

  it('still covers 100% of the input area', () => {
    const before = rowBlocks.reduce((s, b) => s + turf.area(b), 0);
    const zones = mergeBlocksToZones(rowBlocks, rowAdjacency, 4);
    const after = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(after / before).toBeCloseTo(1, 3);
  });
});

describe('generateZones', () => {
  it('produces exactly zoneCount zones when the graph supports it', () => {
    const zones = generateZones(GRID_BOUNDARY, 4, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(4);
  });

  it('merges down to 2 zones split exactly along the hard road', () => {
    const zones = generateZones(GRID_BOUNDARY, 2, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(2);
    const centroidXs = zones.map(z => turf.centroid(z).geometry.coordinates[0]).sort((a, b) => a - b);
    expect(centroidXs[0]).toBeLessThan(0.0015);
    expect(centroidXs[1]).toBeGreaterThan(0.0015);
  });

  it('stops early at 2 zones when asked for 1 (would require crossing the hard road)', () => {
    const zones = generateZones(GRID_BOUNDARY, 1, HARD_VERTICAL, SOFT_HORIZONTAL);
    expect(zones).toHaveLength(2);
  });

  it('falls back to a single whole-boundary zone with no street data at all', () => {
    const zones = generateZones(GRID_BOUNDARY, 3, [], []);
    expect(zones).toHaveLength(1);
  });

  it('covers 100% of the boundary', () => {
    const zones = generateZones(GRID_BOUNDARY, 4, HARD_VERTICAL, SOFT_HORIZONTAL);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
  });
});


describe('orderZonesForNumbering', () => {
  // 3x3 grid of unit squares, fed in shuffled order. Reading order = north row
  // first, west→east within a row: centroids (lat 2.5, lon 0.5/1.5/2.5), then
  // lat 1.5 row, then lat 0.5 row.
  const cell = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
  const shuffled = [cell(1, 1), cell(2, 2), cell(0, 0), cell(2, 0), cell(0, 2), cell(1, 0), cell(2, 1), cell(0, 1), cell(1, 2)];

  it('orders zones like reading a page: north rows first, west to east', () => {
    const ordered = orderZonesForNumbering(shuffled);
    const key = p => {
      const [lon, lat] = turf.centroid(p).geometry.coordinates;
      return `${Math.floor(lon)},${Math.floor(lat)}`;
    };
    expect(ordered.map(key)).toEqual([
      '0,2', '1,2', '2,2',
      '0,1', '1,1', '2,1',
      '0,0', '1,0', '2,0',
    ]);
  });

  it('returns the same polygons, just reordered', () => {
    const ordered = orderZonesForNumbering(shuffled);
    expect(ordered).toHaveLength(9);
    for (const p of shuffled) expect(ordered).toContain(p);
  });
});
