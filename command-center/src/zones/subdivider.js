import * as turf from '@turf/turf';

// §1.3 of the design spec — one searcher walking a residential block (3 mph,
// 20m effective sweep width) vs. a vehicle slow-rolling residential streets
// (20 mph, 20m sweep width).
export const WALKED_RATE_M2_PER_MIN = 1609;
export const DRIVEN_RATE_M2_PER_MIN = 10729;

export function computeZoneCount(boundaryAreaM2, minutes, mode) {
  const rate = mode === 'driven' ? DRIVEN_RATE_M2_PER_MIN : WALKED_RATE_M2_PER_MIN;
  const targetAreaM2 = minutes * rate;
  return Math.max(1, Math.round(boundaryAreaM2 / targetAreaM2));
}

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

// Zone numbers should read like a page — north rows first, west→east within a
// row — so zone 47 sits next to zone 46 on the map instead of build-order
// lottery numbers. Centroids are banded into ~sqrt(n) latitude rows.
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
    .sort((a, b) => band(a.lat) - band(b.lat) || a.lon - b.lon)
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

function sharedAdjacency(polyA, polyB, hardLines) {
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
  return { hard: minD < HARD_BARRIER_TOLERANCE_M };
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

// Dual carriageways polygonize the strip between their centerlines into a
// sliver face no searcher can be assigned (Beverly Hills field bug: median
// slivers surviving as zones, then getting relabeled onto distant hosts).
// Dissolving them at the BLOCK level — into the neighbor sharing the longest
// border, repeating so median chains fold outward — keeps graph connectivity
// across soft dual carriageways, so zones can still merge over a divided
// secondary road. Slivers that touch nothing are artifacts and are dropped.
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
  return blocks.filter(b => meanWidthM(b) >= MIN_BLOCK_MEAN_WIDTH_M);
}

export function buildBlocks(boundary, hardLines, softLines, { maxBlockAreaM2 = MAX_PLAUSIBLE_BLOCK_AREA_M2 } = {}) {
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

  const blocks = dissolveSlivers(faces);

  const adjacency = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const adj = sharedAdjacency(blocks[i], blocks[j], hardLines);
      if (adj) adjacency.push({ a: i, b: j, hard: adj.hard });
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
export const BLOCK_EFFORT_EXPONENT = 0.5;
const RUNT_FRACTION = 0.25;
// Effort weight is sqrt-sub-additive, so a cluster of tiny median chunks can
// "weigh" like a real block while covering a few percent of an average zone's
// area — weight-only runt detection kept exactly those (Beverly Hills / West
// Adams field bug). A region under this fraction of the average region AREA is
// a runt regardless of weight. Kept well below the ~10x area spread blended
// effort allows, so legitimately small dense-urban zones are never absorbed.
const RUNT_AREA_FRACTION = 0.1;

export function mergeBlocksToZones(blocks, adjacency, zoneCount) {
  if (!blocks.length) return [];
  const areasM2 = blocks.map(b => turf.area(b));
  const weights = areasM2.map(a => Math.pow(a, BLOCK_EFFORT_EXPONENT));
  const neighbors = blocks.map(() => []);
  for (const e of adjacency) {
    if (e.hard) continue;
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }

  const assigned = new Array(blocks.length).fill(false);
  const regions = [];
  let remainingWeight = weights.reduce((s, w) => s + w, 0);
  let unassigned = blocks.length;
  while (unassigned > 0) {
    const zonesRemaining = Math.max(1, zoneCount - regions.length);
    const target = remainingWeight / zonesRemaining;
    // never grow so far that the remaining zones can't get a block each —
    // float noise in geodesic areas otherwise lets a region overshoot its
    // weight target by one block and starve the last zone
    const maxBlocks = unassigned - (zonesRemaining - 1);
    const seed = assigned.indexOf(false);
    const region = { blocks: [seed], weight: weights[seed], areaM2: areasM2[seed] };
    assigned[seed] = true;
    const queue = [seed];
    while (region.weight < target && region.blocks.length < maxBlocks && queue.length) {
      const cur = queue.shift();
      for (const nb of neighbors[cur]) {
        if (assigned[nb] || region.weight >= target || region.blocks.length >= maxBlocks) continue;
        assigned[nb] = true;
        region.blocks.push(nb);
        region.weight += weights[nb];
        region.areaM2 += areasM2[nb];
        queue.push(nb);
      }
    }
    remainingWeight -= region.weight;
    unassigned -= region.blocks.length;
    regions.push(region);
  }

  // Runt absorption. Threshold is fixed from the initial average so the loop
  // terminates and results don't depend on absorption order. Soft neighbors are
  // preferred; a runt with NO live soft neighbor may absorb across a hard edge
  // as a last resort — dual-carriageway medians and hard-road corner cutoffs
  // polygonize into slivers walled by hard edges on every side (Beverly Hills /
  // West Adams field bug: 25 requested → 38 built, 16 of them median confetti),
  // and those are artifacts, not searchable territory. Non-runt zones still
  // never cross a hard road.
  const regionOf = new Array(blocks.length);
  regions.forEach((r, ri) => r.blocks.forEach(b => { regionOf[b] = ri; }));
  const runtThreshold = (regions.reduce((s, r) => s + r.weight, 0) / regions.length) * RUNT_FRACTION;
  const areaThreshold = (regions.reduce((s, r) => s + r.areaM2, 0) / regions.length) * RUNT_AREA_FRACTION;
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
    .map(r => r.blocks.slice(1).reduce((poly, i) => turf.union(poly, blocks[i]), blocks[r.blocks[0]]));

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
  // the zone it shares the most border with (nearest centroid as fallback).
  // Each fold removes one zone, so this terminates.
  while (polys.length > 1) {
    const idx = polys.findIndex(p => turf.area(p) < areaThreshold);
    if (idx === -1) break;
    const tiny = polys[idx];
    const rest = polys.filter((_, i) => i !== idx);
    let best = -1, bestLen = -1;
    for (let i = 0; i < rest.length; i++) {
      let touches = false;
      try { touches = turf.booleanIntersects(tiny, rest[i]); } catch {}
      if (!touches) continue;
      let len = 0;
      try {
        const ov = turf.lineOverlap(turf.polygonToLine(tiny), turf.polygonToLine(rest[i]), { tolerance: 0.01 });
        len = ov.features.reduce((s, f) => s + turf.length(f, { units: 'kilometers' }), 0);
      } catch {}
      if (len > bestLen) { bestLen = len; best = i; }
    }
    if (best === -1) {
      // touches nothing — an artifact, not territory. Dropping beats merging
      // into a distant host: a detached union renders as a multi-part zone
      // whose number appears on every part (duplicate-label field bug).
      polys = rest;
      continue;
    }
    try { rest[best] = turf.union(rest[best], tiny); } catch { break; }
    polys = rest;
  }
  return polys;
}

export function generateZones(boundary, zoneCount, hardLines, softLines) {
  const { blocks, adjacency } = buildBlocks(boundary, hardLines, softLines);
  if (!blocks.length) return [boundary];
  return mergeBlocksToZones(blocks, adjacency, zoneCount);
}
