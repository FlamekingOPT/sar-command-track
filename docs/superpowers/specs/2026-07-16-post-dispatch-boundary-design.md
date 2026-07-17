# Post-Dispatch Supplemental Boundary — Design

**Status:** approved by Jack (2026-07-16), not yet implemented — build in a future session.

## Problem

Command can only add a search boundary while a search is in `setup` status. Once
"Send Out Search" is pressed (status → `active`), the "Add Boundary" button and
the zone-count/Generate-Zones controls disappear entirely — even though a real
field need exists: a witness reports a possible sighting outside the original
boundary, and command wants to add that area to the *same* active search rather
than spin up a whole new one.

## What's already there

Reading `command-center/src/search/SearchDetail.jsx`, most of the underlying
mechanism already works and doesn't need to change:

- `handleGenerateZones` already filters `boundaries` down to `targets` with no
  zones yet (`!zones.some(z => zoneBelongsTo(z, b.id))`) — built for per-boundary
  retry-on-failure, but it works identically for "boundary added later."
- New zone numbers already continue from `max(existing zone numbers) + 1`.
- `handleBoundaryEdited` / `handleBoundaryDeleted` already show a confirmation
  ("Searchers may already be assigned...") specifically when `searchStatus ===
  'active'` — the code was clearly written expecting boundary edits during an
  active search.
- `CommandMap`'s `editable` prop is `!readOnly`, and `readOnly` is only true
  when `status === 'complete'` — the map stays editable while `active`.
- Zones already carry `boundaryId`; the data model has no problem with a
  search having boundaries added at different times.
- Searchers already get new zones live: `PickPage` watches zones via
  `watchZones` (Firestore `onSnapshot`), so a zone from a newly-generated
  boundary appears in the picker grid automatically, no changes needed there.

**The only actual blocker is UI gating**: the "Add Boundary" button
(`SearchDetail.jsx:253`) and the zone-count/Generate section
(`SearchDetail.jsx:265`) are hardcoded to `searchStatus === 'setup'`.

## Design

### 1. UI gating (`SearchDetail.jsx`)

- Change the "Add Boundary" button's guard from `searchStatus === 'setup'` to
  `searchStatus !== 'complete'`.
- Label: keep existing copy ("📍 Step 1: Draw Search Boundary" / "📍 Add
  Boundary") while `setup`. While `active`, show **"+ Add Search Area"**
  instead — signals this is a live supplemental addition, not initial setup,
  and skips the Step 1/2/3 framing that no longer applies.
- Change the zone-count input + Generate Zones button's guard the same way:
  show whenever any boundary has no zones yet, regardless of `setup`/`active`.
- When the button is pressed while `active` (entering supplemental mode),
  reset the zone-count input to a small default (e.g. 5) rather than leaving
  whatever value was last typed during initial setup.

### 2. Generate-zones target math

Today: `remaining = Math.max(1, zoneCount - zones.length)` — this assumes
`zoneCount` is a running total across all boundaries (matches setup-phase UX:
command types one total, splits proportionally across boundaries drawn so
far).

For a supplemental add, `zoneCount` means **zones for the new area only** —
confirmed with Jack, since making command do the subtraction math in their
head mid-search is a bad ask. So:

- While `searchStatus === 'setup'`: keep today's behavior
  (`zoneCount - zones.length`).
- While `searchStatus === 'active'`: use `zoneCount` directly as the target
  (no subtraction).

Following this repo's existing convention of extracting pure logic out of
components for testability (see `src/search/boundaries.js` /
`parseBoundaries` and its test in `test/search/boundaries.test.js`), pull this
into a small exported helper rather than an inline ternary:

```js
// src/search/generateTarget.js
export function resolveGenerateTarget(searchStatus, zoneCount, existingZoneCount) {
  return searchStatus === 'setup'
    ? Math.max(1, zoneCount - existingZoneCount)
    : Math.max(1, zoneCount);
}
```

with a unit test covering both branches and the `Math.max(1, ...)` floor.

No changes needed to the rest of `handleGenerateZones` — per-boundary
fetch/build/merge, effort-based allocation across `targets`, and numbering
continuation already work unmodified.

No Firestore schema change required. Store `createdDuringStatus:
searchStatus` on the new boundary object at the point it's added (cheap, one
field) — useful for later after-action review to distinguish original vs.
supplemental search areas. No UI surfaces this yet; just persist it.

### 3. Picker camera refit (`searcher-app/src/pick/PickMap.jsx`)

Today's `hasFitRef` (added 2026-07-16, same session) is a one-shot boolean:
it fits the camera the first time any zone geometry arrives, then never
again. A zone from a supplementally-added boundary would load into the
Firestore listener same as any other zone, but the picker's camera would
never move to show it.

Fix: replace the boolean with a count.

- Track `lastFitCountRef` = the number of zones-with-geometry that were
  present the last time we fit bounds.
- On each zones update, if `zonesWithGeometry.length > lastFitCountRef.current`,
  recompute the bbox over the full current zone set, call `fitBounds`, and
  update `lastFitCountRef.current` to the new count.
- This covers both the original first-load case (0 → N) and a later
  boundary-add (N → N+k) with the same mechanism.
- Refitting only on **growth** (not on every snapshot) means a searcher just
  marking a zone `searched` — which also re-fires the listener — won't yank
  their camera around.

## Explicitly out of scope

- **Boundary overlap:** if the new area overlaps the original boundary,
  allow it — no clipping, no special handling. Confirmed with Jack: this is a
  rare case in practice (a supplemental area is normally adjacent to or
  outside the original, not overlapping already-searched ground), and
  `boundaryId` already keeps zones distinct in the data model even if their
  polygons happen to overlap on the map.
- **Notifying already-assigned searchers** that the search area expanded —
  not building this now. New zones just appear in the picker for whoever
  opens/refreshes it.

## Testing

- Unit test `resolveGenerateTarget` (both status branches, floor behavior).
- Existing `subdivider.js`/`overpass.js`/generation test suites are
  unaffected — no changes to the generation engine itself.
- `PickMap.jsx`'s refit-on-growth behavior isn't practically unit-testable
  today (no existing PickMap tests — Mapbox GL needs a real canvas/WebGL
  context; same reason the earlier `hasFitRef` fix this session had no test
  either). Verify manually: generate an initial boundary's zones, load the
  picker, then add + generate a second boundary while the picker tab is still
  open, confirm the camera re-fits to include the new zones.
- Manual field-flow check: dispatch a search, add a second boundary, generate
  its zones, confirm they appear in the live picker without a page reload,
  and confirm the original boundary's zones/assignments are untouched.
