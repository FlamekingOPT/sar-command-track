import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { allocateZoneCounts, orderZonesForNumbering, paddedBbox, BOUNDARY_PAD_METERS, buildBlocks, HARD_HIGHWAYS, mergeBlocksToZones, generateZones, computeBlockEfforts, OPEN_GROUND_M_PER_M2, isoperimetricQuotient, connectedParts } from '../../src/zones/subdivider.js';

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
  turf.lineString([[0.0015, -0.01], [0.0015, 0.0015]], { highway: 'motorway' }),
  turf.lineString([[0.0015, 0.0015], [0.0015, 0.013]], { highway: 'motorway' }),
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

  it('refines a block whose street effort alone exceeds one zone share', () => {
    // At city LOD a single block between majors can hold a whole dense grid
    // (153 street-km in one Beverly Hills block, field feedback 2026-07-15) —
    // zones are whole blocks, so no balancing can split it. Blocks whose
    // effort exceeds the per-zone share must be re-polygonized with the
    // full-detail streets, locally, leaving sparse blocks coarse.
    const denseStreets = [
      turf.lineString([[0.0005, -0.01], [0.0005, 0.013]]),
      turf.lineString([[0.0010, -0.01], [0.0010, 0.013]]),
    ]; // both inside the LEFT half only
    const coarse = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, []);
    expect(coarse.blocks).toHaveLength(2); // baseline: left | right of the hard road
    const { blocks } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, [], {
      refineStreets: denseStreets,
      targetZoneCount: 3,
    });
    expect(blocks.length).toBe(4); // left split into 3 columns, right untouched
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
  });

  it('grid-subdivides an oversized block that has no internal streets to refine with', () => {
    // A large park has no streets, so refineStreets can never split it via
    // buildBlocks recursion (zero edges = one unchanged block). Field bug:
    // it survived as ONE unsplittable "massive" zone regardless of size.
    // It must fall back to a plain grid split, like the boundary-wide grid
    // fallback (grid.js) does when there's no street data at all.
    const BIG = turf.polygon([[[0, 0], [0.03, 0], [0.03, 0.03], [0, 0.03], [0, 0]]]); // ~3.3km square, no streets
    const { blocks } = buildBlocks(BIG, [], [], {
      maxBlockAreaM2: turf.area(BIG) * 2, // don't let the plausibility cap reject it
      refineStreets: [], // no streets anywhere — this block can't be split by roads
      targetZoneCount: 6,
    });
    // (refineStreets is deliberately [] not omitted — even zero streets must
    // still trigger the grid-subdivision fallback for an oversized block)
    expect(blocks.length).toBeGreaterThan(1);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(BIG)).toBeGreaterThan(0.999);
  });

  it('splits an oversized block along a golf-course feature instead of a blind grid', () => {
    // A golf-course polygon fills the right half of an oversized, streetless
    // block. With no internal streets to refine with, the old behavior fell
    // back to gridZones — a straight rectangular cut with no regard for the
    // feature's shape (field bug 2026-07-16, 2026-07-19 spec issue #1).
    // Passing the feature's own ring as a local edge must make the split
    // follow it instead.
    const BIG = turf.polygon([[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]]); // ~2.2km square, no streets
    const golfCourse = turf.polygon([[[0.01, 0], [0.02, 0], [0.02, 0.02], [0.01, 0.02], [0.01, 0]]]); // right half
    const { blocks } = buildBlocks(BIG, [], [], {
      maxBlockAreaM2: turf.area(BIG) * 2,
      refineStreets: [],
      targetZoneCount: 2,
      terrainPolygons: [golfCourse],
    });
    expect(blocks.length).toBeGreaterThan(1);
    const matchesGolfCourse = blocks.some(b => {
      let inter;
      try { inter = turf.intersect(b, golfCourse); } catch { return false; }
      return inter && turf.area(inter) / turf.area(golfCourse) > 0.95;
    });
    expect(matchesGolfCourse).toBe(true);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(BIG)).toBeGreaterThan(0.999);
  });

  it('still falls back to gridZones when the terrain feature covers the whole block and has no internal paths', () => {
    // A terrain polygon identical to the block itself has no residual area to
    // form a second block from — its own ring can't split it. Must still fall
    // back to grid, matching pre-existing behavior.
    const BIG = turf.polygon([[[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]]]);
    const { blocks } = buildBlocks(BIG, [], [], {
      maxBlockAreaM2: turf.area(BIG) * 2,
      refineStreets: [],
      targetZoneCount: 3,
      terrainPolygons: [BIG],
    });
    expect(blocks.length).toBeGreaterThan(1);
  });

  it('keeps an isolated thin-but-real-area sliver instead of erasing it (real park coverage gap)', () => {
    // Field bug (2026-07-16 screenshot, a Kenneth Hahn / Baldwin Hills-style
    // park): a winding internal path carved off an elongated meadow lobe with
    // a low width/perimeter ratio (mean width under MIN_BLOCK_MEAN_WIDTH_M)
    // but real, non-negligible area — and because it had no bboxesTouch
    // neighbor to merge into, dissolveSlivers's final filter DROPPED it
    // outright. That's real searchable ground vanishing from the map, not
    // just an oddly-sized zone. dissolveSlivers must only fold slivers into a
    // neighbor when one exists; an isolated one — however thin by the width
    // metric — must be KEPT (not deleted) so its area survives into a zone.
    const thinLobe = turf.polygon([[
      [0, 0], [0.002, 0], [0.002, 0.00016], [0.02, 0.00016], [0.02, 0], [0.022, 0], [0.022, 0.00032], [0, 0.00032], [0, 0],
    ]]); // ~2.2km long, ~20m mean width (2*area/perimeter) — under the 25m
        // sliver cutoff, but 51,500 m² of real area, not a negligible artifact
    expect(turf.area(thinLobe)).toBeGreaterThan(50_000); // not a negligible artifact
    // no other blocks at all — nothing for it to merge into
    const { blocks } = buildBlocks(thinLobe, [], []);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(thinLobe)).toBeGreaterThan(0.999);
  });

  it('dissolves a dual-carriageway median sliver into a neighbor block', () => {
    // Two parallel hard lines ~22m apart — a divided road. The strip between
    // the centerlines polygonizes into a face no searcher can be assigned
    // (Beverly Hills field bug: median slivers becoming zones, then getting
    // relabeled onto distant hosts). It must be folded into a real block, so
    // only 2 blocks remain, still covering ~100% of the boundary.
    const DUAL_HARD = [
      turf.lineString([[0.0014, -0.01], [0.0014, 0.013]]),
      turf.lineString([[0.0016, -0.01], [0.0016, 0.013]]),
    ];
    const { blocks, adjacency } = buildBlocks(GRID_BOUNDARY, DUAL_HARD, []);
    expect(blocks).toHaveLength(2);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(GRID_BOUNDARY)).toBeGreaterThan(0.999);
    // the two sides remain adjacent (across the carriageway) and hard
    expect(adjacency).toHaveLength(1);
    expect(adjacency[0].hard).toBe(true);
  });

  it('keeps graph connectivity across a SOFT dual carriageway after median dissolve', () => {
    // Secondary roads at coarse LOD are soft but still often divided. Folding
    // the median at the BLOCK level must leave the two sides soft-adjacent, so
    // zones can still merge across the road.
    const DUAL_SOFT = [
      turf.lineString([[0.0014, -0.01], [0.0014, 0.013]]),
      turf.lineString([[0.0016, -0.01], [0.0016, 0.013]]),
    ];
    const { blocks, adjacency } = buildBlocks(GRID_BOUNDARY, [], DUAL_SOFT);
    expect(blocks).toHaveLength(2);
    expect(adjacency).toHaveLength(1);
    expect(adjacency[0].hard).toBe(false);
    const zones = mergeBlocksToZones(blocks, adjacency, 1);
    expect(zones).toHaveLength(1);
  });
});

describe('isoperimetricQuotient', () => {
  it('scores a square higher than a thin sliver of similar area', () => {
    const squarish = turf.polygon([[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]]);
    const sliver = turf.polygon([[[0, 0], [0.05, 0], [0.05, 0.0005], [0, 0.0005], [0, 0]]]);
    expect(isoperimetricQuotient(squarish)).toBeGreaterThan(isoperimetricQuotient(sliver));
    expect(isoperimetricQuotient(squarish)).toBeGreaterThan(0.7);
  });
});

describe('sharedAdjacency road class (via buildBlocks adjacency)', () => {
  it('reports the soft road class nearest a soft-adjacent border', () => {
    const classedSoft = [
      turf.lineString([[-0.01, 0.0015], [0.0015, 0.0015]], { highway: 'tertiary' }),
      turf.lineString([[0.0015, 0.0015], [0.013, 0.0015]], { highway: 'tertiary' }),
    ];
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, classedSoft);
    const softEdge = adjacency.find(a => a.hard === false);
    expect(softEdge.roadClass).toBe('tertiary');
  });

  it('reports a null road class when the fixture lines carry no highway property', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    const softEdge = adjacency.find(a => a.hard === false);
    expect(softEdge.roadClass).toBeNull();
  });

  it('reports a null road class on a hard-adjacent border (scored separately by the hard-road penalty)', () => {
    const { adjacency } = buildBlocks(GRID_BOUNDARY, HARD_VERTICAL, SOFT_HORIZONTAL);
    const hardEdge = adjacency.find(a => a.hard === true);
    expect(hardEdge.roadClass).toBeNull();
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

describe('mergeBlocksToZones — blended effort (density-varying zone sizes)', () => {
  // A row of 8 soft-adjacent blocks: six 1-unit-wide "downtown" blocks followed
  // by two 4-unit-wide "hillside" blocks. Blended effort (area^0.5) groups the
  // dense side into 3-block zones while each huge block stands alone —
  // density-varying sizes WITHOUT the monster-zone blowup that pure
  // block-count balancing produced (2 huge blocks = one 8-wide zone).
  const widths = [1, 1, 1, 1, 1, 1, 4, 4];
  const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
  const rowBlocks = widths.map((w, i) =>
    turf.polygon([[[xs[i], 0], [xs[i + 1], 0], [xs[i + 1], 1], [xs[i], 1], [xs[i], 0]]])
  );
  const rowAdjacency = [0, 1, 2, 3, 4, 5, 6].map(i => ({ a: i, b: i + 1, hard: false }));

  it('groups dense small blocks together while huge blocks stand alone', () => {
    const zones = mergeBlocksToZones(rowBlocks, rowAdjacency, 4);
    expect(zones).toHaveLength(4);
    const zoneWidths = zones
      .map(z => { const b = turf.bbox(z); return b[2] - b[0]; })
      .sort((a, b) => a - b);
    expect(zoneWidths[0]).toBeCloseTo(3, 5);
    expect(zoneWidths[1]).toBeCloseTo(3, 5);
    expect(zoneWidths[2]).toBeCloseTo(4, 5);
    expect(zoneWidths[3]).toBeCloseTo(4, 5);
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


describe('computeBlockEfforts', () => {
  const SQ1 = turf.polygon([[[0, 0], [0.003, 0], [0.003, 0.003], [0, 0.003], [0, 0]]]);   // ~330m square
  const SQ2 = turf.polygon([[[0.003, 0], [0.006, 0], [0.006, 0.003], [0.003, 0.003], [0.003, 0]]]);

  it('weights blocks by the street length inside them', () => {
    // A dense residential grid inside block 1, nothing inside block 2. Open
    // ground now costs about as much as typical residential street density
    // (2026-07-16: parks are searchable, not discounted), so a fair
    // comparison needs a genuinely dense grid, not a couple of lines.
    const streets = Array.from({ length: 8 }, (_, i) => {
      const y = 0.0002 + i * 0.0003;
      return turf.lineString([[0.0002, y], [0.0028, y]]);
    });
    const [e1, e2] = computeBlockEfforts([SQ1, SQ2], streets);
    expect(e1).toBeGreaterThan(e2 * 1.5);
  });

  it('gives a street-less block an open-ground floor proportional to its area', () => {
    const [e1, e2] = computeBlockEfforts([SQ1, SQ2], []);
    expect(e2).toBeCloseTo(turf.area(SQ2) * OPEN_GROUND_M_PER_M2, 5);
    expect(e2).toBeGreaterThan(0);
    expect(e1 / e2).toBeCloseTo(turf.area(SQ1) / turf.area(SQ2), 3);
  });

  it('assigns a street crossing both blocks to each by the segment midpoints', () => {
    const crossing = [turf.lineString([[0.0005, 0.0015], [0.0025, 0.0015], [0.0035, 0.0015], [0.0055, 0.0015]])];
    const [e1, e2] = computeBlockEfforts([SQ1, SQ2], crossing);
    const floor1 = turf.area(SQ1) * OPEN_GROUND_M_PER_M2;
    const floor2 = turf.area(SQ2) * OPEN_GROUND_M_PER_M2;
    expect(e1).toBeGreaterThan(floor1); // got its segments
    expect(e2).toBeGreaterThan(floor2);
  });
});

describe('mergeBlocksToZones — extreme weight skew on a 1-D chain (k-means trade-off)', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('yields a positional 2-2 split rather than isolating the heavy block, unlike the old greedy-growth algorithm', () => {
    // 4 EQUAL-AREA blocks in a soft chain; block 0 holds 10x the street length
    // of any other single block. Under the OLD greedy-weight-target-growth
    // algorithm this isolated block 0 into its own zone (a clean 1-vs-3 split
    // by weight). Under k-means (2026-07-23 redesign) seed 1 is still block 0
    // (highest weight) but seed 2 is the FARTHEST block by distance (block 3,
    // not chosen by weight) — nearest-centroid assignment plus weighted Lloyd's
    // refinement converges to a positional 2-vs-2 split instead, since block 0's
    // huge weight barely moves its cluster's centroid once block 1 joins it.
    // This is an accepted trade-off of the new algorithm for extreme (10x+)
    // weight skew on a near-1-D chain, not a bug — see docs/superpowers/specs/
    // 2026-07-23-zone-growth-redesign-design.md and the plan's ledger.
    //
    // NOTE: this fixture no longer distinguishes "with efforts" from "without"
    // — skewed efforts, uniform efforts, and no efforts option at all all
    // converge to the same [2,2] split for THIS specific shape (verified).
    // Real efforts-change-the-outcome coverage lives in the
    // 'k-means region-forming: effort-weighted balancing' describe block
    // below, which uses a shape where the effort-weighted centroid pull
    // actually flips the partition.
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3)];
    const adj = [0, 1, 2].map(i => ({ a: i, b: i + 1, hard: false }));
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts: [30_000, 3_000, 3_000, 3_000] });
    expect(zones).toHaveLength(2);
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(widths[0]).toBeCloseTo(2, 5);
    expect(widths[1]).toBeCloseTo(2, 5);
  });
});

describe('mergeBlocksToZones — outlier region does not distort runt thresholds', () => {
  const SQW = (x, w) => turf.polygon([[[x, 0], [x + w, 0], [x + w, 1], [x, 1], [x, 0]]]);

  it('does not fold legitimately-sized zones into each other because one huge region skews the average', () => {
    // Field bug (2026-07-16): a large low-street-density block (a park) forms
    // ONE outsized, unsplittable region. The runt/area thresholds averaged
    // AREA and WEIGHT across ALL regions in the compartment — that huge
    // region inflated the average enough that every normal small zone next
    // to it looked like a runt by comparison, and they got folded together,
    // collapsing 25 requested zones down to 15. The threshold must resist
    // one outlier — median, not mean.
    const hugeBlock = SQW(0, 500);           // effort/area both huge
    const smallBlocks = [1, 2, 3, 4, 5].map(x => SQW(x, 1)); // 5 ordinary 1-wide blocks
    const blocks = [hugeBlock, ...smallBlocks];
    const adj = [0, 1, 2, 3, 4].map(i => ({ a: i, b: i + 1, hard: false }));
    const efforts = [500, 1, 1, 1, 1, 1];
    const zones = mergeBlocksToZones(blocks, adj, 6, { efforts });
    // the huge block stands alone; the 5 ordinary blocks must survive as
    // their own zones too, not get swallowed into 1-2 mega zones
    expect(zones.length).toBeGreaterThanOrEqual(5);
  });
});

describe('mergeBlocksToZones — per-compartment zone allocation', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('does not grow a region far past its effort target when a huge block is adjacent', () => {
    // A near-target-weight neighbor added at the last moment used to double a
    // zone's workload (25 km target, 51+ km zones in the field). The grower
    // must skip a block that would blow the target by >20% — that block seeds
    // its own zone instead.
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3)];
    const adj = [0, 1, 2].map(i => ({ a: i, b: i + 1, hard: false }));
    // total 80, 2 zones, target 40: greedy would take 10+10+35=55 (1.4x)
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts: [10, 10, 35, 25] });
    expect(zones).toHaveLength(2);
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(widths[0]).toBeCloseTo(2, 5); // [10,10] zone
    expect(widths[1]).toBeCloseTo(2, 5); // [35,25] zone
  });

  it('gives a dense hard-boxed compartment its effort share of zones, regardless of seed order', () => {
    // Three isolated single-block compartments come FIRST in block order, then
    // a dense 6-block chain holding 75% of the effort. The old global grower
    // spent the requested count on the early compartments and dumped the whole
    // dense chain into ONE zone (76 street-km zones, field feedback
    // 2026-07-15). Per-compartment allocation must split the chain instead.
    const blocks = [SQX(0), SQX(2), SQX(4), SQX(10), SQX(11), SQX(12), SQX(13), SQX(14), SQX(15)];
    const adj = [3, 4, 5, 6, 7].map(i => ({ a: i, b: i + 1, hard: false }));
    const efforts = [20, 20, 20, 30, 30, 30, 30, 30, 30];
    const zones = mergeBlocksToZones(blocks, adj, 4, { efforts });
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    // dense chain must be split — no zone may span the whole 6-block chain
    expect(widths[widths.length - 1]).toBeLessThanOrEqual(3.01);
  });
});

describe('mergeBlocksToZones — k-means region-forming: determinism', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('produces identical output across repeated calls with identical input (no Math.random anywhere)', () => {
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3), SQX(4), SQX(5)];
    const adj = [0, 1, 2, 3, 4].map(i => ({ a: i, b: i + 1, hard: false }));
    const efforts = [12, 7, 30, 4, 9, 15];
    const run = () => mergeBlocksToZones(blocks, adj, 3, { efforts })
      .map(z => turf.bbox(z).map(n => Math.round(n * 1e6) / 1e6))
      .sort((a, b) => a[0] - b[0]);
    expect(run()).toEqual(run());
  });
});

describe('mergeBlocksToZones — k-means region-forming: effort-weighted balancing', () => {
  const SQX = x => turf.polygon([[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]);

  it('splits a 4-block chain into a light pair and a heavy pair, balanced by effort not position', () => {
    // Hand-verified via weighted Lloyd's iteration (see plan doc): seeds start
    // at the heaviest block (index 2) and the block farthest from it (index
    // 0); the first assignment pass is lopsided (a 3-vs-1 split), but
    // recomputing each cluster's EFFORT-weighted centroid and reassigning
    // pulls it to the effort-balanced result within 2 rounds: {0,1} (weight
    // 20) vs {2,3} (weight 60) — not a positional 2-and-2 split.
    const blocks = [SQX(0), SQX(1), SQX(2), SQX(3)];
    const adj = [0, 1, 2].map(i => ({ a: i, b: i + 1, hard: false }));
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts: [10, 10, 35, 25] });
    expect(zones).toHaveLength(2);
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(widths[0]).toBeCloseTo(2, 5); // {0,1}
    expect(widths[1]).toBeCloseTo(2, 5); // {2,3}
    // Confirm it's the RIGHT pair, not just any 2-and-2 split: the zone
    // containing block 0's corner must also contain block 1's, not block 3's.
    const zoneOf = pt => zones.find(z => turf.booleanPointInPolygon(pt, z));
    expect(zoneOf(turf.point([0.5, 0.5]))).toBe(zoneOf(turf.point([1.5, 0.5])));
    expect(zoneOf(turf.point([2.5, 0.5]))).toBe(zoneOf(turf.point([3.5, 0.5])));
  });
});

describe('mergeBlocksToZones — k-means region-forming: branching-shape regression (Y-shape)', () => {
  // A "Y" shape: a hub block at the origin with three arms — a LONG east arm
  // (4 blocks, with a heavy weight on its far tip) and two short single-block
  // arms, one northwest and one southwest of the hub. The hub is the ONLY
  // thing connecting the NW and SW arms to each other or to the east arm.
  //
  // This fixture was found EMPIRICALLY by running the real implementation
  // (mergeBlocksToZones) against a batch of candidate shapes — plus-shapes
  // with unequal arms, a two-cluster-plus-bridge shape, an L-shape, and this
  // Y-shape — and checking which ones actually produced zones.length >
  // zoneCount. A prior hand-derived T-shape fixture (bar + 2-block stem) was
  // traced by hand and believed to disconnect, but running the real code
  // showed it always converges to a contiguous bar/stem split, for any tip
  // weight up to 1,000,000 — the hand math had an error.
  //
  // IMPORTANT — corrected 2026-09-11 (fix-round-2): this fixture does NOT
  // exercise connectedParts. Instrumenting the real pipeline showed Lloyd's
  // iteration converges to two clusters that are BOTH already
  // graph-connected on their own — connectedParts never splits anything
  // here. The observed zones.length === 3 instead comes from an entirely
  // different, pre-existing mechanism: the two converged regions are
  // unbalanced enough that runt absorption folds them into one region; that
  // merged region's blocks touch each other at only a single corner point,
  // so turf.union produces a MultiPolygon; and the file's PRE-EXISTING (not
  // part of this task) multi-part sweep further down mergeBlocksToZones
  // splits that MultiPolygon into 3 separate zones. So this test is still
  // legitimate, valuable regression coverage — it proves k-means + runt
  // absorption + the point-touch MultiPolygon sweep together still produce
  // valid single-Polygon zones with conserved area for a real branching
  // compartment shape — it just isn't proof that connectedParts fires. See
  // the 'connectedParts — non-contiguous group splitting' describe block
  // below for direct, isolated coverage of that logic.
  const SQ = (x, y) => turf.polygon([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
  const blocks = [
    SQ(0, 0),                                // 0: hub
    SQ(1, 0), SQ(2, 0), SQ(3, 0), SQ(4, 0),  // 1-4: long east arm (4 is the tip)
    SQ(-1, 1),                                // 5: short NW arm
    SQ(-1, -1),                               // 6: short SW arm
  ];
  const adj = [
    { a: 0, b: 1, hard: false }, { a: 1, b: 2, hard: false },
    { a: 2, b: 3, hard: false }, { a: 3, b: 4, hard: false },
    { a: 0, b: 5, hard: false },
    { a: 0, b: 6, hard: false },
  ];
  const efforts = [1, 1, 1, 1, 50, 1, 1]; // block 4 (east arm tip) is the heavy pull

  it('produces valid single-Polygon zones with conserved area for a branching compartment (via runt absorption + point-touch MultiPolygon sweep, not connectedParts)', () => {
    const zones = mergeBlocksToZones(blocks, adj, 2, { efforts });
    // Requesting 2 zones but getting a 3rd from the point-touch MultiPolygon
    // sweep described above.
    expect(zones).toHaveLength(3);
    // Every returned zone must be a single contiguous Polygon (not a
    // MultiPolygon standing in for two disconnected pieces).
    for (const z of zones) expect(z.geometry.type).toBe('Polygon');
    // No area is lost or duplicated in the split.
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / total).toBeCloseTo(1, 3);
  });
});

describe('connectedParts — non-contiguous group splitting', () => {
  // Direct, isolated unit coverage of the BFS-reachability splitting logic
  // clusterCompartmentBlocks uses when a k-means cluster's members aren't
  // all graph-adjacent. Added 2026-09-11 (fix-round-2): the Y-shape test
  // above was believed to exercise this path but, per instrumentation of the
  // real pipeline, does not — Lloyd's iteration on that fixture converges to
  // two already-connected clusters. Two attempts at finding a fixture that
  // organically drives connectedParts to split a cluster through the full
  // seeding+Lloyd's-iteration pipeline failed; planar block-adjacency graphs
  // combined with nearest-centroid Voronoi-style partitioning proved
  // strongly resistant to producing genuine disconnection on synthetic
  // grid/branching shapes. Per the spec's own Testing section ("a
  // CONSTRUCTED case where nearest-centroid assignment WOULD group two
  // non-touching blocks together"), this constructs the disconnected input
  // directly instead.
  it('splits a manually-constructed disconnected set of indices into its connected components', () => {
    // Indices 0 and 1 are mutually reachable (an edge connects them); indices
    // 2 and 3 are also mutually reachable; but NOTHING connects {0,1} to {2,3}.
    const neighbors = [[1], [0], [3], [2]]; // 0<->1, 2<->3, no cross-links
    const parts = connectedParts([0, 1, 2, 3], neighbors).map(p => [...p].sort((a, b) => a - b));
    parts.sort((a, b) => a[0] - b[0]);
    expect(parts).toEqual([[0, 1], [2, 3]]);
  });

  it('returns one component when everything is reachable', () => {
    const neighbors = [[1], [0, 2], [1]];
    const parts = connectedParts([0, 1, 2], neighbors);
    expect(parts).toHaveLength(1);
    expect([...parts[0]].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('does not let a BFS walk outside the tested index set via a neighbor that belongs to another group', () => {
    // Block 2 is a real neighbor of both 1 and 3 in the full graph, but is NOT
    // part of the group being split ([0,1,3]) — it belongs to some other
    // cluster. The containment guard (set.has(nb)) must stop the BFS from
    // walking through it, or [0,1] and [3] would incorrectly merge into one
    // component via the "back door" of block 2's real adjacency.
    const neighbors = [[1], [0, 2], [1, 3], [2]];
    const parts = connectedParts([0, 1, 3], neighbors).map(p => [...p].sort((a, b) => a - b));
    parts.sort((a, b) => a[0] - b[0]);
    expect(parts).toEqual([[0, 1], [3]]);
  });
});

describe('mergeBlocksToZones — k-means region-forming: hard-road respect', () => {
  it('never puts two hard-adjacent-only blocks in the same zone, regardless of geometric closeness', () => {
    // FOUR_BLOCKS/FOUR_ADJACENCY (defined above): 0/1 and 2/3 are soft pairs;
    // 0/2 and 1/3 are hard pairs. Compartment detection (unchanged by this
    // task) already guarantees this by construction — this is the regression
    // test the spec asks for given how much of this file's history is
    // exactly this kind of violation.
    const zones = mergeBlocksToZones(FOUR_BLOCKS, FOUR_ADJACENCY, 2);
    const zoneOf = pt => zones.find(z => turf.booleanPointInPolygon(pt, z));
    // block 0 center (0.5, 1.5) and block 2 center (0.5, 0.5) are hard-adjacent
    expect(zoneOf(turf.point([0.5, 1.5]))).not.toBe(zoneOf(turf.point([0.5, 0.5])));
    // block 1 center (1.5, 1.5) and block 3 center (1.5, 0.5) are hard-adjacent
    expect(zoneOf(turf.point([1.5, 1.5]))).not.toBe(zoneOf(turf.point([1.5, 0.5])));
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

describe('buildBlocks at coarse detail (large legitimate blocks)', () => {
  // At district/city LOD only major roads are fetched, so real blocks are
  // km-scale — far past the old hard-coded 0.2 km² "implausible" cap that was
  // tuned for full residential detail. Regression for a field bug: a Beverly
  // Hills boundary at city detail produced only sliver-confetti zones because
  // every real block was discarded as "too big".
  const BIG = turf.polygon([[[0, 0], [0.03, 0], [0.03, 0.03], [0, 0.03], [0, 0]]]); // ~3.3km square
  const HARD_V = [
    turf.lineString([[0.015, -0.01], [0.015, 0.015]]),
    turf.lineString([[0.015, 0.015], [0.015, 0.04]]),
  ];
  const SOFT_H = [
    turf.lineString([[-0.01, 0.015], [0.015, 0.015]]),
    turf.lineString([[0.015, 0.015], [0.04, 0.015]]),
  ];

  it('discards km-scale blocks under the default cap (documents the old behavior)', () => {
    const { blocks } = buildBlocks(BIG, HARD_V, SOFT_H);
    expect(blocks.length).toBe(0);
  });

  it('keeps km-scale blocks when maxBlockAreaM2 is raised for coarse detail', () => {
    const quadrantArea = turf.area(BIG) / 4;
    const { blocks } = buildBlocks(BIG, HARD_V, SOFT_H, { maxBlockAreaM2: quadrantArea * 4 });
    expect(blocks).toHaveLength(4);
    const covered = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(covered / turf.area(BIG)).toBeGreaterThan(0.999);
  });
});

describe('mergeBlocksToZones — bounded size variance and runt absorption', () => {
  const SQW = (x, w) => turf.polygon([[[x, 0], [x + w, 0], [x + w, 1], [x, 1], [x, 0]]]);

  it('does not let one zone dwarf the others when block sizes vary wildly', () => {
    // 6 small (1-wide) + 2 huge (4-wide) blocks in a soft chain, 4 zones.
    // Pure block-count balancing pairs the two huge blocks into one 8-wide
    // monster zone (field bug: "1 massive zone + slivers"). Blended effort
    // must keep each huge block as its own zone instead.
    const widths = [1, 1, 1, 1, 1, 1, 4, 4];
    const xs = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
    const blocks = widths.map((w, i) => SQW(xs[i], w));
    const adj = [0, 1, 2, 3, 4, 5, 6].map(i => ({ a: i, b: i + 1, hard: false }));
    const zones = mergeBlocksToZones(blocks, adj, 4);
    expect(zones).toHaveLength(4);
    const zw = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(zw[3]).toBeLessThanOrEqual(4.01); // no zone wider than a single huge block
    expect(zw[0]).toBeGreaterThanOrEqual(2.99); // dense side groups small blocks
  });

  it('absorbs sliver zones into a soft neighbor instead of emitting them', () => {
    // two normal blocks + one tiny sliver, 3 zones requested: a sliver-only
    // zone is exactly what command does NOT want — expect 2 zones, the sliver
    // folded into a neighbor.
    const blocks = [SQW(0, 1), SQW(1, 1), SQW(2, 0.01)];
    const adj = [{ a: 0, b: 1, hard: false }, { a: 1, b: 2, hard: false }];
    const zones = mergeBlocksToZones(blocks, adj, 3);
    expect(zones).toHaveLength(2);
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / total).toBeCloseTo(1, 3);
  });

  it('absorbs a hard-isolated sliver across the hard edge as a last resort', () => {
    // Field bug (2026-07-15, Beverly Hills / West Adams, 25 requested → 38 built):
    // dual-carriageway medians and hard-road corner cutoffs polygonize into
    // slivers walled by hard edges on EVERY side. With absorption restricted to
    // soft edges they survived as confetti zones. A median strip is a polygonize
    // artifact, not searchable territory — folding it across the carriageway is
    // right; "never cross a hard road" still holds for every non-runt zone.
    const blocks = [SQW(0, 1), SQW(1, 0.01)];
    const adj = [{ a: 0, b: 1, hard: true }];
    const zones = mergeBlocksToZones(blocks, adj, 2);
    expect(zones).toHaveLength(1);
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(turf.area(zones[0]) / total).toBeCloseTo(1, 3);
  });

  it('prefers a soft neighbor over a hard one when absorbing a sliver', () => {
    // sliver B sits between A (soft edge) and C (hard edge) — it must fold
    // into A, leaving C untouched across the hard road.
    const blocks = [SQW(0, 1), SQW(1, 0.01), SQW(1.01, 1)];
    const adj = [
      { a: 0, b: 1, hard: false },
      { a: 1, b: 2, hard: true },
    ];
    const zones = mergeBlocksToZones(blocks, adj, 3);
    expect(zones).toHaveLength(2);
    const widths = zones.map(z => { const b = turf.bbox(z); return b[2] - b[0]; }).sort((a, b) => a - b);
    expect(widths[0]).toBeCloseTo(1, 3);    // C alone
    expect(widths[1]).toBeCloseTo(1.01, 3); // A + sliver
  });

  it('absorbs a sliver CLUSTER whose sqrt-inflated effort weight dodges the weight check', () => {
    // sqrt weighting is sub-additive: six tiny median chunks together "weigh"
    // as much as a small real block while covering ~3% of the average zone's
    // AREA. Weight-only runt detection kept exactly these (field bug follow-up,
    // same Beverly Hills / West Adams search) — the area check must catch them.
    const big = SQW(0, 1);
    const slivers = [0, 1, 2, 3, 4, 5].map(i => SQW(1 + i * 0.005, 0.005));
    const blocks = [big, ...slivers];
    const adj = [
      { a: 0, b: 1, hard: true }, // big | first sliver: the carriageway
      ...[1, 2, 3, 4, 5].map(i => ({ a: i, b: i + 1, hard: false })),
    ];
    const zones = mergeBlocksToZones(blocks, adj, 2);
    expect(zones).toHaveLength(1);
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(turf.area(zones[0]) / total).toBeCloseTo(1, 3);
  });

  it('splits a multi-part block into one contiguous zone per part', () => {
    // turf.intersect can clip a face crossing the boundary twice into a
    // MultiPolygon "block". If that survives into a zone, the zone's number
    // renders on every detached part (duplicate "7"s / "13"s field bug).
    // Every emitted zone must be a single contiguous Polygon.
    const twoParts = turf.multiPolygon([
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[3, 0], [4, 0], [4, 1], [3, 1], [3, 0]]],
    ]);
    const zones = mergeBlocksToZones([twoParts], [], 2);
    expect(zones).toHaveLength(2);
    for (const z of zones) expect(z.geometry.type).toBe('Polygon');
  });

  it('keeps a tiny zone standing (not merged, not dropped) when it touches nothing', () => {
    // Field bug history: the nearest-centroid fallback used to union a
    // detached sliver into a zone it never touched (duplicate "13"s field
    // bug) — fixed by not merging. Then dropping it outright erased real
    // area (2026-07-16 park-lobe field bug) — a tiny zone with no geometric
    // neighbor is neither teleported NOR deleted; it stands as its own zone.
    const blocks = [SQW(0, 1), SQW(3, 0.01)]; // gap between them — nothing shared
    const zones = mergeBlocksToZones(blocks, [], 2);
    expect(zones).toHaveLength(2);
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    const covered = zones.reduce((s, z) => s + turf.area(z), 0);
    expect(covered / total).toBeCloseTo(1, 3);
  });

  it('keeps a zone standing rather than union-merging a single-point touch into a MultiPolygon', () => {
    // Two squares meeting only at a shared corner point pass booleanIntersects
    // but have zero shared EDGE length — turf.union of a point-touch returns a
    // MultiPolygon (Westlake field regression: multiPart went 0 -> 1 after
    // adding this sweep). A point-touch must be treated as "no safe merge
    // target": leave both zones standing, not unioned, not dropped.
    const tiny = turf.polygon([[[1, 1], [1.01, 1], [1.01, 1.01], [1, 1.01], [1, 1]]]);
    const big = SQW(0, 1); // corner (1,1) touches tiny's corner (1,1) — point only
    const zones = mergeBlocksToZones([big, tiny], [], 2);
    expect(zones).toHaveLength(2);
    for (const z of zones) expect(z.geometry.type).toBe('Polygon');
  });

  it('folds a graph-isolated runt into its geometric neighbor when adjacency missed the touch', () => {
    // sharedAdjacency's lineOverlap tolerance can miss a real touch on thin
    // diagonal slivers, leaving a runt zone no graph absorption can reach
    // (the last surviving 0.0156 km² sliver in the Beverly Hills field bug).
    // The final geometric sweep must fold it into the zone it touches.
    const blocks = [SQW(0, 1), SQW(1, 0.01)];
    const zones = mergeBlocksToZones(blocks, [], 2); // adjacency empty: graph-isolated
    expect(zones).toHaveLength(1);
    const total = blocks.reduce((s, b) => s + turf.area(b), 0);
    expect(turf.area(zones[0]) / total).toBeCloseTo(1, 3);
  });

  it('keeps a non-runt hard-boxed compartment as its own zone', () => {
    // two normal-sized blocks separated by a hard road: neither is a runt,
    // so the hard road stays absolute and we get 2 zones even asking for 1.
    const blocks = [SQW(0, 1), SQW(1, 1)];
    const adj = [{ a: 0, b: 1, hard: true }];
    expect(mergeBlocksToZones(blocks, adj, 1)).toHaveLength(2);
  });
});
