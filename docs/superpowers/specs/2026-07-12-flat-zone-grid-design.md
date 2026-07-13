# Design — Flat Numbered Zone Grid (replaces letter/subzone hierarchy)

**Date:** 2026-07-12 · **Status: APPROVED (verbal, 2026-07-12) — not built.**

Supersedes the letter+subzone model from `2026-06-28-sar-command-track-design.md`. Builds on
the built Phase 1/2/3 system (Command Center, Telegram bot, Searcher PWA) plus the in-flight
fieldtest fixes (tracking-stop-on-complete, client-side zone claiming without the bot). Also
folds in and supersedes handoff open issue #1 ("sub-zone road-snapping") — this design replaces
that problem's context (letter zones vs. sub-zones) entirely, so issue #1 is resolved by this
work rather than built separately.

---

## 0. Overview

### Problems being fixed

1. **Zone shapes are unrealistic.** `subdivideZone`/`stripSubdivide` cuts bbox-spanning strips
   across the polygon's longer axis. On a diagonal or irregular boundary this produces long
   thin zones stretching across the whole search area (observed directly in fieldtest
   screenshots) — the opposite of "an area someone can search without crossing into unrelated
   territory."
2. **Sub-zones have zero road-awareness.** Letter zones attempt real-road snapping
   (`subdivideWithBarriers`); sub-zones (A1–A4 etc.) never do — always raw strips.
3. **Uneven zone sizes.** `mergeToN` merges whichever two pieces have the nearest centroids,
   with no regard for resulting size — observed producing one tiny zone (A) next to one
   oversized zone (D) from the same generation pass.
4. **Major roads don't reliably split zones.** OSM represents a long freeway as many short way
   segments (split at every interchange/ramp). Each is scored/cut independently by its own
   length-inside-polygon, so no single segment wins a full bisecting cut — observed as a zone
   straddling both sides of the 10 freeway.
5. **Zone count is a manual, upfront-committed guess.** The admin types a zone count before
   knowing how many searchers will actually show up. Too few zones and volunteers wait; too
   many and each zone is oddly tiny for a boundary that size.
6. **Letters add a hierarchy layer that doesn't serve the goal.** Two-tier (letter → sub-zone)
   selection exists to keep sub-groups manageable, but adds a picker step and doubles the
   splitting logic (once for letters, once inside each letter) without making zones more
   realistic.

### The shift

Replace the letter+subzone hierarchy with **one flat pool of numbered zones** covering the
whole boundary, sized by a **target size preset** (Small/Medium/Large) instead of a manual
count — however many zones of that size fit the boundary is however many get created. Zone
*shape* generation gets four correctness fixes (compact-grid fallback, segment-dissolving,
balance-aware merge, wider road data) so zones end at real block edges and stay reasonably
even in size. Searchers pick their own zone from a flat map, and pick their own *next* zone
again after marking one complete — no automatic reassignment logic needed at all.

Out of scope: true dynamic re-slicing of remaining unclaimed area as headcount changes
(considered and rejected — see §7); Telegram `/available`'s full redesign (gets the minimal
change required since letters disappear, nothing more); multi-day support.

---

## 1. Architecture

No new top-level folders. Changes concentrated in three existing areas:

```
command-center/src/
  zones/subdivider.js       — CHANGED: gridSubdivide (new), segment-dissolving, balance-aware
                               merge, broadened OSM query; subdivideZone/stripSubdivide removed
  search/SearchDetail.jsx   — CHANGED: single flat generation pass, size-preset selector
                               replaces zone-count input, manual-draw path simplified
  ui/ZonePanel.jsx          — CHANGED: zone.number instead of zone.letter+zone.number
  firebase/zones.js         — CHANGED: createZone drops `letter`, adds flat `number`

searcher-app/src/
  pick/PickPage.jsx         — CHANGED: flat zone map, no letter step, letterAvailability removed
  pick/PickMap.jsx          — CHANGED: renders all zone polygons directly (was: letter regions)
  pick/claimZone.js         — CHANGED: claims by zoneId directly, no letter filter
  App.jsx                   — CHANGED: "Zone complete" shows a "Pick another zone" button
                               instead of a terminal state

telegram-bot/src/
  commands/available.js     — CHANGED (minimal): drops letter argument, grabs next open zone
```

---

## 2. Data Model

`searches/{searchId}` doc: **drop `letterZones` field entirely.** No replacement top-level
region data — the flat zones themselves are the only geometry below the boundary.

`searches/{searchId}/days/{dayId}/zones/{zoneId}` doc, new shape:

```js
{
  number: 7,                 // flat sequential display number, replaces letter+number
  polygon: '<GeoJSON string>',
  status: 'unassigned',      // unassigned | assigned | in_progress | searched | needs_re_search
  assignedTo: null,
  createdAt: <serverTimestamp>,
}
```

No `letter` field. `createZone` (`command-center/src/firebase/zones.js`) signature becomes
`createZone(searchId, dayId, { number, polygon })`.

Firestore rules: the existing zone-update rule (from the current fieldtest branch, permitting
an unauthenticated client to flip `status`+`assignedTo` from an assignable state to `assigned`)
needs no change — it doesn't reference `letter` at all.

---

## 3. Zone-Shape Algorithm (`subdivider.js`)

### 3.1 `gridSubdivide(polygon, n)` — new, compact fallback

Replaces `stripSubdivide` everywhere it's currently called. Uses `turf.squareGrid` (already
available via the existing `@turf/turf` dependency — no new library):

1. Compute `cellSize = Math.sqrt(turf.area(polygon) / n)` (meters).
2. `turf.squareGrid(turf.bbox(polygon), cellSize / 1000, { units: 'kilometers' })` over the
   polygon's bbox.
3. Clip each grid cell to the polygon via `turf.intersect`; skip degenerate results (try/catch,
   matching the file's existing defensive style).
4. **Sliver merge:** any cell under ~15% of the target cell area (`turf.area(polygon)/n`) merges
   into its nearest-centroid neighbor via `turf.union` — repeat until no slivers remain. Slivers
   are never dropped.
5. **Leftover reclaim:** union all cells, `turf.difference(polygon, unionOfCells)` — if any area
   remains uncovered (degenerate clip failures, floating-point gaps), merge it into the nearest
   cell by centroid. This guarantees 100% coverage even on pathological geometry.
6. If cell count still isn't exactly `n` after merging, reuse the balance-aware merge (§3.3) to
   bring it down, or recursively grid-split the largest remaining cell to bring it up.

### 3.2 Segment-dissolving (fixes the freeway-straddling bug)

In `fetchOSMBarriers`, before scoring/cutting: group returned way features by their OSM `name`
tag (features with no name are left as individual lines — they're typically short local stubs
already). Within each name group, chain segments whose endpoints touch or nearly touch
(tolerance ~5m) into single continuous `LineString`s via coordinate concatenation. A freeway
split into a dozen short OSM ways with the same name now reads as one long line, scores highest
in `subdivideWithBarriers`'s existing length-inside-polygon ranking, and gets one clean
full-length cut instead of several short, incomplete notches.

### 3.3 Balance-aware merge (fixes tiny-A/huge-D)

`mergeToN`'s current nearest-centroid-pair strategy is replaced: while `zones.length > n`,
repeatedly take the **smallest** current zone by area and merge it into its nearest-centroid
neighbor (not an arbitrary nearest pair). This directly prevents a small leftover corner piece
from surviving as its own zone while two normal-sized pieces get merged into an oversized one.

### 3.4 Broadened OSM query

`fetchOSMBarriers`'s Overpass query adds `residential|living_street|unclassified` to the
existing `highway` filter (`motorway|trunk|primary|secondary|tertiary`). Needed because flat
zones are smaller on average than the old letter zones were, so residential streets are now
frequently the relevant nearby boundary, not just arterials.

### 3.5 Single flat entry point

New async helper, the only thing `SearchDetail.jsx` calls for generation:

```js
export async function generateZones(boundaryPolygon, targetAreaM2) {
  const barriers = await fetchOSMBarriers(boundaryPolygon).catch(() => []);
  const n = Math.max(1, Math.round(turf.area(boundaryPolygon) / targetAreaM2));
  return subdivideWithBarriers(boundaryPolygon, n, barriers); // barrier-first, gridSubdivide fallback
}
```

`subdivideWithBarriers` keeps its existing barrier-first structure; both its fallback call
sites (insufficient barriers; "too few pieces" loop) swap `stripSubdivide` → `gridSubdivide`.
`subdivideZone`/`stripSubdivide` are deleted once no caller remains.

### 3.6 Size presets

```js
export const ZONE_SIZE_PRESETS = {
  small:  40_000,   // m² ≈ 200m × 200m — roughly a 5 min walk across
  medium: 160_000,  // m² ≈ 400m × 400m — roughly a 10 min walk across
  large:  640_000,  // m² ≈ 800m × 800m — roughly a 20 min walk across
};
```

Tunable constants, not exposed as raw numbers to the admin — the dropdown shows the three
labels only.

---

## 4. Command Center — Generation UX

`SearchDetail.jsx`:

- The zone-count `<input type="number">` (Step 2) is replaced with a Small/Medium/Large
  `<select>` (default Medium).
- `handleGenerateZones` becomes a single call: `generateZones(boundary, ZONE_SIZE_PRESETS[size])`
  → loop `createZone` for each resulting polygon with a sequential `number` (1..N) — no letter
  loop, no per-letter subzone loop.
- `handleFeatureDrawn`'s manual-draw path (admin hand-draws one zone with MapboxDraw) creates
  exactly **one** flat zone from the drawn shape directly — no forced 4-way split. This remains
  useful as an admin override/patch tool (e.g., manually add one zone to cover a gap after
  automatic generation).
- `ZonePanel.jsx`: `zone.letter}{zone.number` display becomes `Zone {zone.number}`.

---

## 5. Searcher-App — Picker & Claim

- `PickMap.jsx`: renders every zone polygon directly (colored by status, same status-color
  convention as `CommandMap`), instead of rendering big letter regions and drilling into
  sub-zones on a second tap. One tap = one zone.
- `claimZone.js`: same Firestore-transaction claim logic already built for the bot-free picker
  (read zone, verify `ASSIGNABLE` status, write `status: 'assigned'` + `assignedTo`, create the
  `searcherLinks` doc) — simplified to take a specific `zoneId` instead of filtering candidates
  by `letter`.
- `PickPage.jsx`: `letterAvailability` helper removed entirely — zones list drives the map
  directly; tapping an unclaimed zone polygon calls `claimZone({ zoneId, ... })`.

---

## 6. Completion → Re-Pick Flow

No auto-continue/nearest-zone logic. When a searcher taps **Complete** in `App.jsx`
(`StatusButton`'s `onComplete`), after the zone status write succeeds, show a **"Zone complete —
Pick another zone"** button in place of the status button. Tapping it navigates to
`/pick/{searchId}` — the same flat picker screen used for initial sign-up, now showing whatever
zones are still unclaimed. The searcher chooses their own next zone, same as their first. Zero
new assignment/distance logic; 100% reuse of the existing picker and claim transaction.

---

## 7. Rejected Alternative — Dynamic Re-Slicing

Considered: re-partition the *remaining unclaimed* area into more, smaller pieces automatically
as more searchers sign up (so 15 volunteers against an initial 10-zone grid would trigger a
reflow instead of 5 people waiting). Rejected as this pass's approach because it requires:
touching only unclaimed zones while leaving already-assigned/in-progress zones geometrically
untouched (a searcher's phone already renders a fixed boundary — can't reshape it mid-search);
a Firestore transaction guarding against a resize racing a simultaneous claim; and a decision
about trigger cadence (every signup? every N? manual?). The flat/size-preset + searcher-picks-
own-next-zone model achieves the same practical goal (nobody idle, finer granularity available)
with none of that risk, by starting small enough upfront and letting zones be a consumable pool
rather than a fixed one-per-person assignment. Revisit only if field use shows the flat-pool
model still leaves people waiting.

---

## 8. Error Handling

| Situation | Behavior |
|---|---|
| `gridSubdivide` grid cell fails to clip (degenerate geometry) | Skipped via try/catch; leftover-reclaim pass (§3.1.5) folds any resulting gap into the nearest cell — coverage is never silently lost |
| No barriers returned at all (Overpass down/timeout) | `subdivideWithBarriers` falls straight to `gridSubdivide` for the whole boundary — same as today's existing fallback behavior, just compact instead of strips |
| Admin picks a size preset larger than the whole boundary | `n = Math.max(1, ...)` — always at least one zone (the whole boundary), same as today's `n <= 1` short-circuit |
| Searcher taps "Pick another zone" but every zone is now `assigned`/`searched` | Same `no_availability`/"just filled up" messaging the picker already shows today — no special case needed, it's the same map/claim flow |
| A hand-drawn manual zone overlaps an existing auto-generated zone | Not validated/prevented — same as today's behavior for manual letter-zone drawing; admin is trusted to draw sensibly, consistent with the existing "open trust model" note in `firestore.rules` |

---

## 9. Testing

- `subdivider.test.js`: rewritten for the flat single-pass API. Keep the existing coverage
  checks (≥90%/full coverage, centroids inside, ~n count) against `gridSubdivide` directly (not
  through the removed `subdivideZone`). Add: segment-dissolving test (multiple same-named short
  segments treated as one continuous barrier and producing one clean bisecting cut); balance-
  merge test (a deliberately lopsided barrier-cut input ends up with less size disparity after
  merge than a naive nearest-centroid-pair merge would produce); full-coverage-on-irregular-
  polygon test (concave/diagonal boundary, verify no gaps via total-area comparison).
- Picker: any existing `claimZone`/`PickPage` tests updated for zoneId-based claiming instead
  of letter-based; `letterAvailability` tests removed (function deleted).

---

## 10. Open Decisions Resolved

| Topic | Decision |
|---|---|
| Letters vs. flat numbers | Flat numbers — letters/sub-zone hierarchy removed entirely |
| Zone count | Derived from a Small/Medium/Large target-size preset, not a manual count |
| Uneven zone shapes/sizes | Fixed at the algorithm level: `gridSubdivide` compact fallback, segment-dissolving, balance-aware smallest-into-nearest merge, broadened road data |
| Handling more searchers than zones | Searcher-driven re-pick after completing a zone (no auto-continue, no dynamic re-slicing) — rejected alternative documented in §7 |
| Auto-continue zone selection | N/A — searchers pick their own next zone from the flat picker map, no system-side nearest-zone logic |
| Manual zone drawing | Still supported, now creates exactly one flat zone per drawn shape (no forced subdivision) |
| Telegram `/available` | Drops its letter argument, grabs the next open numbered zone — minimal change, not a redesign (bot not yet deployed per handoff) |
