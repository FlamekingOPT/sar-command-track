import * as turf from '@turf/turf';
import { gridZones } from './grid';

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
const MAX_PLAUSIBLE_BLOCK_AREA_M2 = 200000;
const HARD_BARRIER_TOLERANCE_M = 6;
const MIN_SHARED_EDGE_M = 3;
const MIN_EDGE_LENGTH_M = 1;
const SNAP_DECIMALS = 6;

function snapLine(line) {
  const seen = [];
  for (const [x, y] of line.geometry.coordinates) {
    const p = [Math.round(x * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS, Math.round(y * 10 ** SNAP_DECIMALS) / 10 ** SNAP_DECIMALS];
    if (!seen.length || seen[seen.length - 1][0] !== p[0] || seen[seen.length - 1][1] !== p[1]) seen.push(p);
  }
  return seen.length >= 2 ? turf.lineString(seen) : null;
}

function isDegenerate(line) {
  try { return turf.length(line, { units: 'kilometers' }) * 1000 < MIN_EDGE_LENGTH_M; }
  catch { return true; }
}

function clipToPaddedBbox(line, bbox) {
  let clipped;
  try { clipped = turf.bboxClip(line, bbox); } catch { return []; }
  if (!clipped.geometry.coordinates.length) return [];
  if (clipped.geometry.type === 'LineString') return clipped.geometry.coordinates.length >= 2 ? [clipped] : [];
  return clipped.geometry.coordinates.filter(c => c.length >= 2).map(c => turf.lineString(c));
}

function ringParam(bbox, [x, y]) {
  const [west, south, east, north] = bbox;
  const w = east - west, h = north - south, tol = 1e-7;
  if (Math.abs(y - south) < tol) return (x - west) / w;
  if (Math.abs(x - east) < tol) return 1 + (y - south) / h;
  if (Math.abs(y - north) < tol) return 2 + (east - x) / w;
  if (Math.abs(x - west) < tol) return 3 + (north - y) / h;
  return null;
}

// polygonize never auto-nodes a line endpoint that lands mid-edge on another
// line (a T-touch) — it only connects lines at coordinates they already share
// exactly. Build the ring's own vertex list from the 4 corners plus every point
// a clipped street touches, so the ring and the streets always share a real node.
function buildNodedRing(bbox, touchPoints) {
  const [west, south, east, north] = bbox;
  const corners = [[west, south], [east, south], [east, north], [west, north]];
  const withParams = [...corners, ...touchPoints]
    .map(p => ({ p, t: ringParam(bbox, p) }))
    .filter(x => x.t !== null)
    .sort((a, b) => a.t - b.t);
  const ring = [];
  for (const { p } of withParams) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-9) ring.push(p);
  }
  ring.push(ring[0]);
  return turf.lineString(ring);
}

function buildEdgeSet(boundary, hardLines, softLines) {
  const bbox = paddedBbox(boundary);
  const clipped = [...hardLines, ...softLines].flatMap(l => clipToPaddedBbox(l, bbox));
  const touchPoints = clipped.flatMap(l => {
    const c = l.geometry.coordinates;
    return [c[0], c[c.length - 1]].filter(p => ringParam(bbox, p) !== null);
  });
  const paddedRing = buildNodedRing(bbox, touchPoints);
  let edges = [paddedRing, ...clipped].map(snapLine).filter(Boolean).filter(l => !isDegenerate(l));

  // drop exact-duplicate edges (same endpoints, either direction) — a duplicate
  // edge between the same two nodes produces a degenerate ring polygonize rejects
  const seenKeys = new Set();
  edges = edges.filter(l => {
    const c = l.geometry.coordinates;
    const a = c[0].join(','), b = c[c.length - 1].join(',');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  return { edges, bbox };
}

const BOUNDARY_ROAD_MATCH_TOLERANCE_M = 15;
// Boundary-quality scoring (2026-07-19 spec, Part B): a shared border that
// lands on a real, sizeable road reads better to command than one that cuts
// through the middle of an ordinary block. secondary/tertiary score highest;
// residential/living_street/unclassified score low; no nearby road scores 0.
// Hard classes aren't listed here — a hard-adjacent border is scored by the
// separate hard-road-crossing penalty in refineZoneBoundaries (Task 6), not
// this table.
export const ROAD_CLASS_QUALITY = {
  secondary: 1.0,
  tertiary: 0.7,
  residential: 0.3,
  living_street: 0.3,
  unclassified: 0.2,
};

function nearestRoadClass(point, lines) {
  let best = null, bestD = Infinity;
  for (const line of lines) {
    let d;
    try { d = turf.pointToLineDistance(point, line, { units: 'meters' }); } catch { continue; }
    if (d < bestD) { bestD = d; best = line.properties?.highway ?? null; }
  }
  return bestD <= BOUNDARY_ROAD_MATCH_TOLERANCE_M ? best : null;
}

function sharedAdjacency(polyA, polyB, hardLines, softLines = []) {
  let overlap;
  try {
    overlap = turf.lineOverlap(turf.polygonToLine(polyA), turf.polygonToLine(polyB), { tolerance: 0.003 });
  } catch { return null; }
  if (!overlap?.features?.length) return null;

  const totalLen = overlap.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0) * 1000;
  if (totalLen < MIN_SHARED_EDGE_M) return null;

  let longest = overlap.features[0], longestLen = 0;
  overlap.features.forEach(f => {
    const l = turf.length(f, { units: 'kilometers' });
    if (l > longestLen) { longestLen = l; longest = f; }
  });
  const mid = turf.along(longest, longestLen / 2, { units: 'kilometers' });

  let minD = Infinity;
  for (const h of hardLines) {
    try { minD = Math.min(minD, turf.pointToLineDistance(mid, h, { units: 'meters' })); } catch {}
  }
  const hard = minD < HARD_BARRIER_TOLERANCE_M;
  return { hard, roadClass: hard ? null : nearestRoadClass(mid, softLines) };
}

// Isoperimetric quotient: 1.0 for a circle, lower for elongated/notched
// shapes. Used by refineZoneBoundaries (2026-07-19 spec, Part B, Task 6) to
// score whether a candidate move makes a zone's shape rounder or worse.
export function isoperimetricQuotient(poly) {
  const area = turf.area(poly);
  let perimM;
  try { perimM = turf.length(turf.polygonToLine(poly), { units: 'kilometers' }) * 1000; }
  catch { return 0; }
  return perimM > 0 ? (4 * Math.PI * area) / (perimM * perimM) : 0;
}

// Scored boundary-refinement pass (2026-07-19 spec, Part B). Runs after
// growth + runt absorption produce `regions`, before they're flattened into
// final polygons. Unifies four issues that used to be four separate, cruder
// mechanisms: zero shape objective in growth (#2), the binary "last resort"
// hard-road absorption rule (#3), standing slivers with no graph-reachable
// neighbor (#4), and a greedy split that can't undo an early bad choice, e.g.
// landing one block off of a better arterial (#5, the Vermont Ave case).
//
// Field-confirmed need (2026-07-20): a real 143-zone search produced a zone
// that genuinely crosses the San Diego Freeway via the OLD rule's binary
// "absorb across a hard road as last resort" — a real, walkable pocket of
// streets got folded across an active freeway because it had no soft
// neighbor, without ever weighing whether that was actually a good idea.
const WEIGHT_BALANCE_SCORE_WEIGHT = 1;
const COMPACTNESS_SCORE_WEIGHT = 1;
const BOUNDARY_QUALITY_SCORE_WEIGHT = 1;
const HARD_ROAD_CROSSING_PENALTY = 3;
const MOVE_ACCEPTANCE_THRESHOLD = 0.05;
const MAX_MOVES_PER_BLOCK = 4;

function isConnected(blockIndices, allNeighbors) {
  if (blockIndices.length <= 1) return true;
  const set = new Set(blockIndices);
  const seen = new Set([blockIndices[0]]);
  const queue = [blockIndices[0]];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of allNeighbors[cur] ?? []) {
      if (set.has(nb) && !seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
  }
  return seen.size === blockIndices.length;
}

export function refineZoneBoundaries(regions, blocks, adjacency, weights) {
  const live = regions.filter(r => !r.dead);
  if (live.length < 2) return;

  const allNeighbors = blocks.map(() => []);
  for (const e of adjacency) { allNeighbors[e.a].push(e.b); allNeighbors[e.b].push(e.a); }

  const regionOf = new Array(blocks.length);
  live.forEach(r => r.blocks.forEach(b => { regionOf[b] = r; }));

  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const maxMoves = blocks.length * MAX_MOVES_PER_BLOCK;
  let moves = 0;
  let improved = true;
  while (improved && moves < maxMoves) {
    improved = false;
    for (const e of adjacency) {
      const ra = regionOf[e.a], rb = regionOf[e.b];
      if (!ra || !rb || ra === rb || ra.dead || rb.dead) continue;

      for (const [moving, from, to] of [[e.a, ra, rb], [e.b, rb, ra]]) {
        // One of these two directions can dissolve `from` into `to` (see
        // below) before the *other* direction of this same edge is
        // evaluated — the outer ra.dead/rb.dead check above only runs once
        // per edge, before either direction executes. Without this re-check,
        // the second direction could still merge blocks INTO the just-killed
        // region: `to.blocks` would gain blocks/weight while `to.dead`
        // stayed true, and every block routed there would be silently
        // dropped by `regions.filter(r => !r.dead)` downstream, with no
        // adjacency edge ever able to reach it again (its region is dead, so
        // every edge touching it is skipped by the check above from then on).
        if (from.dead || to.dead) continue;

        const remaining = from.blocks.filter(b => b !== moving);
        if (remaining.length > 0 && !isConnected(remaining, allNeighbors)) continue;

        // Fair share is recomputed against how many LIVE regions would exist
        // after this move — a move that fully dissolves `from` (remaining
        // empty) reduces the effective zone count by one, same as the
        // existing runt-absorption logic already does elsewhere in this file.
        const liveCountBefore = regions.filter(r => !r.dead).length;
        const liveCountAfter = remaining.length > 0 ? liveCountBefore : liveCountBefore - 1;
        const fairShareBefore = totalWeight / liveCountBefore;
        const fairShareAfter = totalWeight / Math.max(1, liveCountAfter);

        const blockWeight = weights[moving];
        const weightDelta =
          (Math.abs(from.weight - fairShareBefore) + Math.abs(to.weight - fairShareBefore)) -
          ((remaining.length > 0 ? Math.abs(from.weight - blockWeight - fairShareAfter) : 0) +
            Math.abs(to.weight + blockWeight - fairShareAfter));

        let compactDelta;
        try {
          const fromPolyBefore = from.blocks.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[from.blocks[0]]);
          const toPolyBefore = to.blocks.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[to.blocks[0]]);
          const toPolyAfter = [...to.blocks, moving].slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[to.blocks[0]]);
          const compactBefore = isoperimetricQuotient(fromPolyBefore) + isoperimetricQuotient(toPolyBefore);
          const compactAfter = remaining.length > 0
            ? isoperimetricQuotient(remaining.slice(1).reduce((p, i) => safeUnion(p, blocks[i]), blocks[remaining[0]])) + isoperimetricQuotient(toPolyAfter)
            : isoperimetricQuotient(toPolyAfter);
          compactDelta = (compactAfter - compactBefore) / 2;
        } catch { continue; }

        const boundaryQuality = e.hard ? 0 : (ROAD_CLASS_QUALITY[e.roadClass] ?? 0);
        const hardPenalty = e.hard ? HARD_ROAD_CROSSING_PENALTY : 0;

        const score =
          WEIGHT_BALANCE_SCORE_WEIGHT * weightDelta +
          COMPACTNESS_SCORE_WEIGHT * compactDelta +
          BOUNDARY_QUALITY_SCORE_WEIGHT * boundaryQuality -
          hardPenalty;

        if (score > MOVE_ACCEPTANCE_THRESHOLD) {
          from.blocks = remaining;
          from.weight -= blockWeight;
          to.blocks = [...to.blocks, moving];
          to.weight += blockWeight;
          regionOf[moving] = to;
          if (remaining.length === 0) from.dead = true;
          moves++;
          improved = true;
        }
      }
    }
  }
}

// maxBlockAreaM2 rejects polygonize artifacts (faces leaking past real
// streets), but it MUST scale with detail level: the 0.2 km² default suits
// full residential detail, while district/city LOD produces legitimately
// km-scale blocks between major roads. A Beverly Hills field test at city
// detail once discarded every real block and kept only sliver-confetti
// because this cap was hard-coded — callers using coarse detail must pass a
// cap sized to their expected zone area.
// A face's mean width: 2·area/perimeter (exact w for a long w×L strip). Road
// medians and interchange gores run 10–25m; real searchable blocks are 40m+.
const MIN_BLOCK_MEAN_WIDTH_M = 25;

// Absolute-area floor for an isolated (no merge partner) thin block. Width
// alone can't distinguish real territory from noise — a winding park path can
// carve off an elongated but substantial-area meadow lobe (real ground, must
// be kept), while true polygonize noise (near-duplicate/self-touching edges)
// is reliably tiny in absolute terms. 500 m² is a 10x25m patch — far below
// any real search-worthy area, far below the ~51,500 m² park-lobe case this
// exists to protect. Dropping only these keeps the isolated-sliver population
// small: at full LOD, NOT dropping any isolated thin block (regardless of
// area) let hundreds of genuine micro-fragments survive into zone-building,
// where the sliver-merge sweep could cascade — a multi-part union re-injects
// small parts that are themselves still "tiny", producing new merge attempts
// faster than it resolves them (field bug 2026-07-16: Westlake, 174 zones,
// mergeBlocksToZones never returned).
const MIN_ISOLATED_SLIVER_AREA_M2 = 500;

function meanWidthM(poly) {
  try {
    const perimM = turf.length(turf.polygonToLine(poly), { units: 'kilometers' }) * 1000;
    return perimM > 0 ? (2 * turf.area(poly)) / perimM : 0;
  } catch { return 0; }
}

function sharedBorderM(a, b) {
  try {
    const ov = turf.lineOverlap(turf.polygonToLine(a), turf.polygonToLine(b), { tolerance: 0.003 });
    return ov.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0) * 1000;
  } catch { return 0; }
}

function bboxesTouch(ba, bb) {
  return ba[0] <= bb[2] && bb[0] <= ba[2] && ba[1] <= bb[3] && bb[1] <= ba[3];
}

// turf.union (polygon-clipping) can throw "Unable to complete output ring" on
// a genuinely malformed polygonize artifact (self-touching/degenerate ring) —
// hit in the field once isolated slivers stopped being silently dropped
// (2026-07-16). NEVER let a merge failure erase area: turf.combine just
// concatenates the two shapes into a MultiPolygon without dissolving their
// shared edge — no boolean topology math, so it doesn't fail the same way.
// The existing "split any MultiPolygon into separate zones" step downstream
// turns the un-dissolved parts into their own zone(s) — one extra zone beats
// a crash or a silent coverage gap.
function safeUnion(a, b) {
  try { return turf.union(a, b); }
  catch {
    try { return turf.combine(turf.featureCollection([a, b])).features[0]; }
    catch { return a; }
  }
}

// Dual carriageways polygonize the strip between their centerlines into a
// sliver face no searcher can be assigned (Beverly Hills field bug: median
// slivers surviving as zones, then getting relabeled onto distant hosts).
// Dissolving them at the BLOCK level — into the neighbor sharing the longest
// border, repeating so median chains fold outward — keeps graph connectivity
// across soft dual carriageways, so zones can still merge over a divided
// secondary road. A sliver with NO neighbor to fold into is kept as its own
// block, NOT dropped by width alone: mean width (2·area/perimeter) catches
// elongated shapes generally, but a winding park path can carve off a
// low-width lobe that still has real, non-negligible area — dropping it
// erased searchable ground from the map outright (field bug 2026-07-16, a
// park with internal trails). It's only dropped if its AREA is also
// negligible (MIN_ISOLATED_SLIVER_AREA_M2) — true polygonize noise, not real
// territory; keeping every isolated thin fragment regardless of area let
// hundreds of full-LOD micro-fragments survive into zone-building, where
// merging them could cascade (see that constant's comment).
function dissolveSlivers(faces) {
  const blocks = [...faces];
  const bboxes = blocks.map(b => turf.bbox(b));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blocks.length; i++) {
      if (meanWidthM(blocks[i]) >= MIN_BLOCK_MEAN_WIDTH_M) continue;
      let best = -1, bestLen = 0, bestIsSliver = true;
      for (let j = 0; j < blocks.length; j++) {
        if (i === j || !bboxesTouch(bboxes[i], bboxes[j])) continue;
        const len = sharedBorderM(blocks[i], blocks[j]);
        if (!len) continue;
        const jSliver = meanWidthM(blocks[j]) < MIN_BLOCK_MEAN_WIDTH_M;
        // prefer any real block over a fellow sliver, then longest border
        if (best === -1 || (bestIsSliver && !jSliver) || (bestIsSliver === jSliver && len > bestLen)) {
          best = j; bestLen = len; bestIsSliver = jSliver;
        }
      }
      if (best === -1) continue; // isolated sliver — dropped below
      try {
        const union = turf.union(blocks[best], blocks[i]);
        blocks[best] = union;
        bboxes[best] = turf.bbox(union);
        blocks.splice(i, 1);
        bboxes.splice(i, 1);
        merged = true;
        break;
      } catch { /* keep both; the zone-level sweep still catches it */ }
    }
  }
  return blocks.filter(b => meanWidthM(b) >= MIN_BLOCK_MEAN_WIDTH_M || turf.area(b) >= MIN_ISOLATED_SLIVER_AREA_M2);
}

// Refine any block whose street effort alone exceeds this multiple of the
// per-zone effort share — it would force an unsplittable oversized zone.
const REFINE_EFFORT_FACTOR = 1;

export function buildBlocks(boundary, hardLines, softLines, {
  maxBlockAreaM2 = MAX_PLAUSIBLE_BLOCK_AREA_M2,
  refineStreets = null,
  targetZoneCount = 0,
  skipAdjacency = false,
  terrainPolygons = [],
  terrainPaths = [],
} = {}) {
  const { edges, bbox } = buildEdgeSet(boundary, hardLines, softLines);
  const paddedBoundary = turf.bboxPolygon(bbox);
  const rawFaces = turf.polygonize(turf.featureCollection(edges));

  const faces = rawFaces.features
    .filter(f => {
      try { return turf.booleanPointInPolygon(turf.centroid(f), paddedBoundary) && turf.area(f) > 0; }
      catch { return false; }
    })
    .map(f => { try { return turf.intersect(f, boundary); } catch { return null; } })
    // a face crossing the boundary twice clips into a MultiPolygon — split it
    // so each contiguous part is its own block with its own adjacency
    .flatMap(f => {
      if (!f) return [];
      return f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map(c => turf.polygon(c)) : [f];
    })
    // size cap applies AFTER clipping — a face's pre-clip (padded) area is
    // inflated by whatever pad it happens to include, so checking before
    // clipping rejects legitimate blocks (found while validating this code)
    .filter(f => f && turf.area(f) > 1 && turf.area(f) < maxBlockAreaM2);

  let blocks = dissolveSlivers(faces);

  // Local LOD refinement: at coarse detail one block between majors can hold a
  // whole dense street grid — since zones are built from whole blocks, that
  // block forces one giant zone over a visibly dense area (Beverly Hills field
  // feedback: 153 street-km in a single block). Any block whose full-detail
  // street effort exceeds a zone's share is re-polygonized with those streets,
  // LOCALLY — sparse areas keep their coarse, fast blocks. A block with open
  // ground and no internal streets (a park) has nothing to re-polygonize with,
  // so it falls back to a plain grid split (same technique as the boundary-
  // wide grid fallback in grid.js) — otherwise it survives as one unsplittable
  // "massive" zone no matter how large (field feedback 2026-07-16).
  if (targetZoneCount > 0 && blocks.length) {
    const streets = refineStreets ?? [];
    const efforts = computeBlockEfforts(blocks, streets);
    const targetEffort = (efforts.reduce((s, e) => s + e, 0) / targetZoneCount) * REFINE_EFFORT_FACTOR;
    const lineBboxes = streets.map(l => turf.bbox(l));
    const terrainBboxes = terrainPolygons.map(t => turf.bbox(t));
    const pathBboxes = terrainPaths.map(p => turf.bbox(p));
    blocks = blocks.flatMap((b, i) => {
      if (efforts[i] <= targetEffort) return [b];
      const bb = turf.bbox(b);
      const local = streets.filter((l, li) => bboxesTouch(lineBboxes[li], bb));

      // A terrain feature (golf/park/cemetery/wood) overlapping this block
      // has a real shape to split along — try it before falling back to a
      // blind grid (2026-07-19 spec, issue #1: a golf course was cut straight
      // through by gridZones because it was invisible to the algorithm).
      const overlappingTerrain = terrainPolygons.filter((t, ti) => {
        if (!bboxesTouch(terrainBboxes[ti], bb)) return false;
        try { return turf.booleanIntersects(t, b); } catch { return false; }
      });
      if (overlappingTerrain.length) {
        const terrainEdges = overlappingTerrain.flatMap(t => {
          try { return [turf.polygonToLine(t)]; } catch { return []; }
        });
        const localPaths = terrainPaths.filter((p, pi) => bboxesTouch(pathBboxes[pi], bb));
        try {
          const terrainSplit = buildBlocks(b, [], [...local, ...terrainEdges, ...localPaths], { maxBlockAreaM2, skipAdjacency: true });
          if (terrainSplit.blocks.length > 1) return terrainSplit.blocks;
        } catch { /* fall through to the plain-street / grid attempts below */ }
      }

      let sub = null;
      try { sub = buildBlocks(b, [], local, { maxBlockAreaM2, skipAdjacency: true }); } catch { /* fall through to grid */ }
      if (sub?.blocks.length > 1) return sub.blocks;
      try {
        const cellCount = Math.max(2, Math.round(efforts[i] / targetEffort));
        const cells = gridZones(b, cellCount);
        return cells.length > 1 ? cells : [b];
      } catch { return [b]; }
    });
  }

  const adjacency = [];
  if (!skipAdjacency) {
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const adj = sharedAdjacency(blocks[i], blocks[j], hardLines, softLines);
        if (adj) adjacency.push({ a: i, b: j, hard: adj.hard, roadClass: adj.roadClass });
      }
    }
  }
  return { blocks, adjacency };
}

// Divide blocks among zoneCount zones by seeded region-growing, balancing a
// blended "search effort" weight per zone: effort = area^BLOCK_EFFORT_EXPONENT.
// Pure block COUNT (exponent 0) let two mega-blocks form one monster zone next
// to sliver zones when block sizes varied 100x (Hancock Park field bug); pure
// AREA (exponent 1) is the old uniform model that ignores density. The square
// root sits between: dense areas still get smaller zones, but a block 100x
// larger only counts 10x more, which bounds the size spread.
//
// Region-growing rather than pairwise cluster merging is deliberate: greedy
// smallest-pair-first merging strands single blocks between already-grown
// neighbors, steered by float noise in equal-area tie-breaks. Growing every
// zone to an explicit per-zone target keeps balance and determinism.
//
// Hard edges (motorway/trunk/primary, waterways) are absent from the adjacency
// lists, so a zone can never grow across one; hard-boxed regions close early
// and the remainder forms extra zones ("more zones than requested rather than
// crossing a hard road", as always).
//
// Finally, runt zones — dramatically lighter than average, i.e. the sliver
// confetti command explicitly doesn't want — are absorbed into their lightest
// soft-adjacent neighbor, even if that lands under the requested count.
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const BLOCK_EFFORT_EXPONENT = 0.5;
const RUNT_FRACTION = 0.25;

// Street length IS search effort: a searcher walks/drives streets, so meters
// of street inside a block is the honest workload measure. sqrt(area) was only
// a proxy for it — fine at full detail (small blocks ≈ dense streets) but
// wrong at city LOD, where block size reflects major-road spacing: one mega
// block over the dense Beverly Hills grid "weighed" less than the same area
// cut fine, producing huge zones over visibly dense areas (field feedback
// 2026-07-15). Open ground (parks, hillsides) is real searchable territory,
// not a discount bin — a park still needs a systematic sweep, arguably a
// denser one with no streets to organize along. Set at the same order as
// typical LA residential density (~0.015-0.02 m/m²) so parks are NOT
// under-weighted relative to streets (field feedback 2026-07-16: a park was
// treated as nearly free, ballooning into one massive zone while real dense
// zones next to it starved down to slivers). Tunable.
export const OPEN_GROUND_M_PER_M2 = 0.018;

// Effort per block = full-detail street meters inside it (each segment counted
// by its midpoint) + the open-ground allowance for the block's area.
export function computeBlockEfforts(blocks, streetLines) {
  const bboxes = blocks.map(b => turf.bbox(b));
  const efforts = blocks.map(b => turf.area(b) * OPEN_GROUND_M_PER_M2);
  for (const line of streetLines ?? []) {
    const coords = line.geometry.coordinates;
    for (let s = 0; s + 1 < coords.length; s++) {
      const [x1, y1] = coords[s], [x2, y2] = coords[s + 1];
      const mid = [(x1 + x2) / 2, (y1 + y2) / 2];
      for (let i = 0; i < blocks.length; i++) {
        const bb = bboxes[i];
        if (mid[0] < bb[0] || mid[0] > bb[2] || mid[1] < bb[1] || mid[1] > bb[3]) continue;
        let inside = false;
        try { inside = turf.booleanPointInPolygon(mid, blocks[i]); } catch {}
        if (!inside) continue;
        efforts[i] += turf.distance([x1, y1], [x2, y2], { units: 'kilometers' }) * 1000;
        break;
      }
    }
  }
  return efforts;
}
// Effort weight is sqrt-sub-additive, so a cluster of tiny median chunks can
// "weigh" like a real block while covering a few percent of an average zone's
// area — weight-only runt detection kept exactly those (Beverly Hills / West
// Adams field bug). A region under this fraction of the average region AREA is
// a runt regardless of weight. Kept well below the ~10x area spread blended
// effort allows, so legitimately small dense-urban zones are never absorbed.
const RUNT_AREA_FRACTION = 0.1;

export function mergeBlocksToZones(blocks, adjacency, zoneCount, { efforts } = {}) {
  if (!blocks.length) return [];
  const areasM2 = blocks.map(b => turf.area(b));
  // efforts (street meters per block, from computeBlockEfforts) is the real
  // workload measure; sqrt(area) remains the fallback for callers without
  // street data (grid fallback, older tests).
  const weights = efforts ?? areasM2.map(a => Math.pow(a, BLOCK_EFFORT_EXPONENT));
  const neighbors = blocks.map(() => []);
  for (const e of adjacency) {
    if (e.hard) continue;
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }

  // Soft-connected compartments get their zone counts allocated UP FRONT by
  // effort share (largest remainder, min 1 — allocateZoneCounts), then regions
  // grow inside each compartment toward its own target. The old global grower
  // seeded compartments in block order: whichever dense compartment happened
  // to come after the requested count was spent swallowed all its effort as
  // ONE giant zone (76 street-km zones over dense grids, field 2026-07-15).
  const parent = blocks.map((_, i) => i);
  const findRoot = i => (parent[i] === i ? i : (parent[i] = findRoot(parent[i])));
  for (const e of adjacency) { if (!e.hard) parent[findRoot(e.a)] = findRoot(e.b); }
  const compByRoot = new Map();
  blocks.forEach((_, i) => {
    const r = findRoot(i);
    if (!compByRoot.has(r)) compByRoot.set(r, []);
    compByRoot.get(r).push(i);
  });
  const comps = [...compByRoot.values()];
  const compWeights = comps.map(c => c.reduce((s, i) => s + weights[i], 0));
  // Proportional share, min 1 — deliberately NOT forced to sum to zoneCount.
  // With more compartments than requested zones, an exact-sum allocation
  // starves the dense compartments to feed every sliver compartment's min-1
  // floor (field: a 76 street-km compartment got ONE zone while 30 slivers
  // each got one too). Extra sliver regions are runts the absorption pass
  // folds; "more zones than requested rather than crossing a hard road"
  // remains the standing tradeoff.
  const totalCompWeight = compWeights.reduce((s, w) => s + w, 0) || 1;
  const compAlloc = compWeights.map(w => Math.max(1, Math.round(zoneCount * w / totalCompWeight)));

  const assigned = new Array(blocks.length).fill(false);
  const regions = [];
  comps.forEach((comp, ci) => {
    const compCount = Math.min(compAlloc[ci], comp.length);
    const baseTarget = compWeights[ci] / compCount;
    let remainingWeight = compWeights[ci];
    let unassigned = comp.length;
    let made = 0;
    while (unassigned > 0) {
      const zonesRemaining = Math.max(1, compCount - made);
      // adaptive target absorbs float noise, but once the planned count is
      // spent it degenerates to "all remaining weight" and the LAST region
      // eats the compartment's leftovers as one giant zone (88 street-km
      // zones, field 2026-07-15). Cap at 1.5x the fair share — leftovers
      // form extra regions that runt absorption folds or that stand as
      // legitimate extra zones.
      const target = Math.min(remainingWeight / zonesRemaining, baseTarget * 1.5);
      // never grow so far that the remaining zones can't get a block each —
      // float noise in geodesic areas otherwise lets a region overshoot its
      // weight target by one block and starve the last zone
      const maxBlocks = unassigned - (zonesRemaining - 1);
      const seed = comp.find(i => !assigned[i]);
      const region = { blocks: [seed], weight: weights[seed], areaM2: areasM2[seed] };
      assigned[seed] = true;
      const queue = [seed];
      while (region.weight < target && region.blocks.length < maxBlocks && queue.length) {
        const cur = queue.shift();
        for (const nb of neighbors[cur]) {
          if (assigned[nb] || region.weight >= target || region.blocks.length >= maxBlocks) continue;
          // a BIG block grabbed at the last moment used to double a zone's
          // workload (25 km target, 51+ km zones in the field) — let it seed
          // its own zone instead. Small blocks may still overshoot slightly;
          // overshoot is bounded by the block's own size (bin-packing rule).
          if (weights[nb] > target * 0.5 && region.weight + weights[nb] > target * 1.2) continue;
          assigned[nb] = true;
          region.blocks.push(nb);
          region.weight += weights[nb];
          region.areaM2 += areasM2[nb];
          queue.push(nb);
        }
      }
      remainingWeight -= region.weight;
      unassigned -= region.blocks.length;
      made += 1;
      regions.push(region);
    }
  });

  // Runt absorption. Threshold is fixed from the initial distribution so the
  // loop terminates and results don't depend on absorption order. Soft
  // neighbors are preferred; a runt with NO live soft neighbor may absorb
  // across a hard edge as a last resort — dual-carriageway medians and
  // hard-road corner cutoffs polygonize into slivers walled by hard edges on
  // every side (Beverly Hills / West Adams field bug: 25 requested → 38
  // built, 16 of them median confetti), and those are artifacts, not
  // searchable territory. Non-runt zones still never cross a hard road.
  //
  // MEDIAN, not mean: one unsplittable outlier region (a park with 100x the
  // area or effort of everything around it) blows out a mean enough that
  // every normal-sized zone next to it looks like a runt by comparison and
  // gets folded together, collapsing the requested count (field feedback
  // 2026-07-16: 25 requested → 15 built). The median resists that outlier.
  const regionOf = new Array(blocks.length);
  regions.forEach((r, ri) => r.blocks.forEach(b => { regionOf[b] = ri; }));
  const runtThreshold = median(regions.map(r => r.weight)) * RUNT_FRACTION;
  const areaThreshold = median(regions.map(r => r.areaM2)) * RUNT_AREA_FRACTION;
  let changed = true;
  while (changed) {
    changed = false;
    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri];
      if (r.dead || (r.weight >= runtThreshold && r.areaM2 >= areaThreshold)) continue;
      let bestSoft = -1, bestHard = -1;
      for (const e of adjacency) {
        const ra = regionOf[e.a], rb = regionOf[e.b];
        if (ra === rb) continue;
        const other = ra === ri ? rb : rb === ri ? ra : -1;
        if (other === -1 || regions[other].dead) continue;
        if (e.hard) {
          if (bestHard === -1 || regions[other].weight < regions[bestHard].weight) bestHard = other;
        } else if (bestSoft === -1 || regions[other].weight < regions[bestSoft].weight) {
          bestSoft = other;
        }
      }
      const bestIdx = bestSoft !== -1 ? bestSoft : bestHard;
      if (bestIdx !== -1) {
        const host = regions[bestIdx];
        host.blocks.push(...r.blocks);
        host.weight += r.weight;
        host.areaM2 += r.areaM2;
        r.blocks.forEach(b => { regionOf[b] = bestIdx; });
        r.dead = true;
        r.blocks = [];
        changed = true;
      }
    }
  }

  let polys = regions
    .filter(r => !r.dead)
    .map(r => r.blocks.slice(1).reduce((poly, i) => safeUnion(poly, blocks[i]), blocks[r.blocks[0]]));

  // A zone must be ONE contiguous polygon — a multi-part zone renders its
  // number on every detached part (duplicate "13"s field bug). Multi-parts
  // sneak in two ways: turf.intersect clips a face crossing the boundary twice
  // into a MultiPolygon block, and turf.union of point-touching pieces can
  // return one. Split them; the sliver sweep below absorbs any tiny parts.
  polys = polys.flatMap(p => p.geometry.type === 'MultiPolygon'
    ? p.geometry.coordinates.map(c => turf.polygon(c))
    : [p]);

  // sharedAdjacency's lineOverlap tolerance can miss a real touch on thin
  // diagonal slivers, leaving a graph-isolated runt that no absorption pass
  // above could reach. Final geometric sweep: fold any still-tiny zone into
  // the zone it shares the most border with. Each successful fold removes one
  // zone; a zone with no real-edge neighbor is left standing (its own small
  // zone) rather than dropped — dropping erased real searchable area (field
  // bug 2026-07-16: a park lobe vanished from the map), so `settled` tracks
  // "already confirmed unmergeable" to keep this loop terminating.
  const settled = new Set();
  while (polys.length > 1) {
    const idx = polys.findIndex(p => turf.area(p) < areaThreshold && !settled.has(p));
    if (idx === -1) break;
    const tiny = polys[idx];
    const rest = polys.filter((_, i) => i !== idx);
    // require a real shared EDGE (lineOverlap length > 0), not just
    // booleanIntersects — two polygons meeting at a single point pass
    // booleanIntersects but turf.union of a point-touch returns a
    // MultiPolygon, which is exactly the duplicate-label bug this sweep
    // exists to prevent.
    let best = -1, bestLen = 0;
    for (let i = 0; i < rest.length; i++) {
      let len = 0;
      try {
        const ov = turf.lineOverlap(turf.polygonToLine(tiny), turf.polygonToLine(rest[i]), { tolerance: 0.01 });
        len = ov.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0);
      } catch {}
      if (len > bestLen) { bestLen = len; best = i; }
    }
    if (best === -1) {
      // touches nothing by a real edge — no safe merge target. Keep it
      // standing rather than erase real area; mark settled so the loop
      // doesn't re-select it forever.
      settled.add(tiny);
      continue;
    }
    const union = safeUnion(rest[best], tiny);
    // safety net: even a real-edge union can occasionally return a
    // MultiPolygon (topology edge cases). Split it rather than keep-only-the-
    // largest-part — that used to discard the smaller part's real area, the
    // same class of bug this whole fix is about. The smaller parts rejoin
    // `polys` and get evaluated on the next pass like anything else.
    if (union.geometry.type === 'MultiPolygon') {
      const parts = [...union.geometry.coordinates]
        .map(c => turf.polygon(c))
        .sort((a, b) => turf.area(b) - turf.area(a));
      rest[best] = parts[0];
      rest.push(...parts.slice(1));
    } else {
      rest[best] = union;
    }
    polys = rest;
  }
  return polys;
}

export function generateZones(boundary, zoneCount, hardLines, softLines) {
  const { blocks, adjacency } = buildBlocks(boundary, hardLines, softLines);
  if (!blocks.length) return [boundary];
  return mergeBlocksToZones(blocks, adjacency, zoneCount);
}
