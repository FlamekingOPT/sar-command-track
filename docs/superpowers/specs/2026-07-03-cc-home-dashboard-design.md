# Design — Command Center Home Dashboard (Plan 5)

**Date:** 2026-07-03 · **Status: APPROVED (verbal, 2026-07-03) — not built.**

Builds on the built Phase 1 Command Center (`command-center/`). Verified against the actual
code (not just the original `2026-06-28-sar-command-track-design.md`), since Phase 1 shipped
with some divergences from that doc — notably, letter-zone locking was never implemented
(`pickZone()` in the bot accepts a `lockedLetters` set but nothing ever populates it), and
`watchSearches()` (plural, all searches) already exists in
`command-center/src/firebase/searches.js:34` but is currently unused.

---

## 0. Overview

Today, `command-center/src/App.jsx` has no home screen: on login it either shows `SearchSetup`
(if no search is selected) or drops straight into the single active/setup search's map+zone
view. There is no way to see past searches, reopen a completed one, or see more than one
search at a time. "Complete Search" (`App.jsx:166-183`) resets all local state to null — the
completed search's data still exists in Firestore, but the UI has no path back to it.

This plan adds a **home dashboard**: a list of every search ever created, with the ability to
open any of them (including completed ones, read-only) into the existing map+zone view, mark
an active search complete without opening it, start a new search, and copy the two volunteer-
facing links a search exposes (once Plan 6 — the comms upgrade — adds them). It also fixes the
zone panel showing raw volunteer IDs instead of names.

Out of scope: anything that requires Plan 6's data (dedicated Telegram groups, invite links,
the web zone picker) to actually exist — those UI affordances degrade gracefully (hidden or
disabled) until Plan 6 ships. Multi-day support, export (PDF/GeoJSON) — future plans.

---

## 1. Architecture

No new top-level folder — this extends `command-center/` in place.

### New/changed files

```
command-center/src/
  App.jsx                 — CHANGED: adds a view switch (home | search detail), no router lib
  home/
    HomeDashboard.jsx      — new: search list, New Search button, per-row actions
    SearchRow.jsx          — new: one row — name, date, status pill, Complete/Open/copy-link buttons
  firebase/
    searches.js            — CHANGED: watchSearches() already exists, now actually used
    volunteers.js           — new: watchVolunteers() — id → {name} map, mirrors bot's collection
  ui/
    ZonePanel.jsx           — CHANGED: resolves assignedTo (a volunteer id) to a name
```

No new dependency. Routing stays state-based (`useState`), consistent with the existing
convention — the app has no `react-router-dom` today and none of the other three sub-apps
(`searcher-app` parses `window.location.pathname` by hand for `/s/{token}`) use a router
either. A dashboard/detail switch is two states, not worth adding a library for.

### View model

`App.jsx` currently has one implicit view, gated by `searchId`. Replace with an explicit
`view` state:

```js
const [view, setView] = useState('home');      // 'home' | 'detail'
const [searchId, setSearchId] = useState(null); // which search is open in 'detail'
```

- `view === 'home'` → render `HomeDashboard`.
- `view === 'detail'` → render the existing map+zone layout (today's `App.jsx` body), scoped
  to `searchId`.
- `HomeDashboard`'s "New Search" button and a row's "Open" both call `setSearchId(id); setView('detail')`.
- A "← Back to searches" link in the detail header calls `setView('home')` (does NOT clear
  `searchId` — so flipping back and forth doesn't lose the in-memory map state, though the
  existing per-search `useEffect`s already re-subscribe cleanly on `searchId` change if it
  does get cleared).
- Reflect `view`/`searchId` in `location.hash` (e.g. `#/search/{id}`) purely so the browser
  back button and page refresh don't dump staff back to the home screen mid-search — read it
  once on mount to set initial state, write it on every `setView`/`setSearchId`. This is a
  small addition, not a full router.

---

## 2. Data Model

No schema changes. Two read paths that already have the data but aren't used yet:

- `searches` collection — `watchSearches(cb)` (`command-center/src/firebase/searches.js:34`)
  already returns every search doc regardless of status. The dashboard is its first caller.
- `volunteers` collection — root-level, keyed by id (today, always a Telegram id — see Plan 6
  for web-registered volunteers using a different id scheme under the same collection).
  Firestore rule already permits `allow read, write: if true` (`firestore.rules:5`). No
  command-center code reads it today; add `watchVolunteers(cb)` returning `{ [id]: name }`.

```js
// command-center/src/firebase/volunteers.js
export function watchVolunteers(cb) {
  return onSnapshot(collection(db, 'volunteers'), snap =>
    cb(Object.fromEntries(snap.docs.map(d => [d.id, d.data().name])))
  );
}
```

---

## 3. Home Dashboard

### Layout

- Header: "SAR Command" + a **+ New Search** button (routes to the existing `SearchSetup`
  flow, unchanged, just reachable from here instead of being the only landing state).
- A list of `SearchRow`s, one per search from `watchSearches()`.
- Sort: `status` priority (`active` first, then `setup`, then `complete`) as primary key,
  `createdAt` descending as secondary — an in-progress search should never be buried below a
  pile of old completed ones.

### `SearchRow`

Each row shows:

| Element | Source | Notes |
|---|---|---|
| Name + date | `search.name`, `search.date` | as entered in `SearchSetup` |
| Status pill | `search.status` | reuse `StatusPill.jsx` (currently zone-status-only; generalize its color map or add a second small variant — trivial, same component shape) |
| **Open** button | — | `setSearchId(search.id); setView('detail')` |
| **Complete** button | — | only rendered when `status === 'active'`; calls `completeSearch(search.id)` directly (already exists, `command-center/src/firebase/searches.js:21`) with the same confirm-dialog UX as today's in-detail Complete button — no need to open the search first just to close it out |
| **Copy invite link** | `search.inviteLink` (Plan 6 field) | rendered only if the field is present on the doc; copies to clipboard, brief "Copied" toast. Absent for any search created/bound before Plan 6 ships, and for searches never bound to a dedicated group |
| **Copy picker link** | derived: `${SEARCHER_APP_URL}/pick/${search.id}` | this URL is constructible today (fixed pattern, no Plan 6 field needed) but the `/pick/{id}` route doesn't exist until Plan 6 ships — show the button but note in a tooltip "requires the web zone picker (Plan 6)" until then, or simply don't render this button until Plan 6 lands. Given the two plans are implemented back-to-back, **hide it until `search.groupChatId` or any Plan-6-only field exists on the search doc**, matching the invite-link behavior, rather than shipping a dead link |

### Detail view (reopening a search)

The existing `App.jsx` body (map + `ZonePanel` + header controls) becomes the `view === 'detail'`
render, generalized to work for **any** status, not just the currently-open one:

- `status === 'complete'` → **read-only**: hide the boundary-draw / generate-zones / publish /
  Complete controls; `ZonePanel`'s per-zone status `<select>` is also hidden (or disabled) —
  reopening a finished search is for review (map, tracks, markers, final zone states), not
  editing history. `CommandMap` and `ZonePanel` already accept their data as props with no
  built-in assumption about status, so this is purely a render-branch in `App.jsx`, not a
  prop-shape change.
- `status === 'setup'` or `'active'` → identical to today's behavior, unchanged.
- Tracks/markers/zones for the reopened search load exactly as they do today
  (`watchZones`/`watchTracks`/`watchMarkers`, all already keyed by `searchId` + the fixed
  `DAY_ID`) — no special-casing needed since those listeners don't care whether the search is
  still active.

### Zone panel volunteer names

`ZonePanel.jsx:24` currently renders `zone.assignedTo ?? '—'` — the raw id (a Telegram numeric
id, or in Plan 6, a web-generated UUID). Change:

```js
// App.jsx passes volunteers down from watchVolunteers()
<ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} />

// ZonePanel.jsx
{volunteers[zone.assignedTo] ?? zone.assignedTo ?? '—'}
```

Falls back to the raw id (not `'—'`) if the id isn't found in `volunteers` — that state means
data inconsistency (a zone assigned to an id with no volunteer doc), which is more useful to
surface visibly than to silently hide behind a dash.

---

## 4. Error Handling

| Situation | Behavior |
|---|---|
| Dashboard's Complete button used on a search with zones still `assigned`/`in_progress` | Same confirm dialog as today — coordinator's call, not blocked by the app |
| Copy-link button clicked before clipboard permission / on an insecure context | `navigator.clipboard.writeText` failure caught, falls back to a visible selectable text field instead of a silent no-op |
| Reopening a search whose `letterZones`/`boundary` are null (abandoned mid-setup) | Detail view renders the same empty-boundary state `SearchSetup`→`App` shows today for a fresh search — no crash, just an empty map |
| `watchVolunteers()` racing zone data on first load | `ZonePanel` falls back to the raw id until the volunteers map populates (listeners fire independently; both are on `onSnapshot`, so this self-corrects within one round-trip, no loading gate needed) |

---

## 5. Testing

Same split as prior phases: pure logic gets unit tests, Firebase/DOM-heavy pieces get manual
verification.

- Unit: search-list sort order (`status` priority + `createdAt` desc) as a pure function
  extracted from `HomeDashboard` (e.g. `sortSearches(searches)`), tested with fixture arrays —
  mirrors how `subdivideZone` and `pickZone` are tested elsewhere in this codebase.
- Manual smoke test: create two searches, publish one, complete the other; confirm the
  dashboard lists both with correct status/sort, reopening the completed one shows its map
  read-only, reopening the active one still allows normal zone-status edits, and the zone
  panel shows volunteer names (not ids) for any test `/available` assignment made during
  Phase 2/3 field testing.

---

## 6. Open Decisions Resolved

| Topic | Decision |
|---|---|
| Routing | Plain `useState` view switch + `location.hash` for back-button/refresh friendliness — no router library, consistent with the rest of the monorepo |
| Reopened completed searches | Read-only (no draw/publish/status-edit controls) — reopening is for review, not re-editing history |
| Copy-link buttons before Plan 6 ships | Hidden (not disabled/dead) until the relevant field (`inviteLink`, or any Plan-6 marker field) exists on the search doc |
| Volunteer name resolution | New root-level `watchVolunteers()` read in Command Center, mirroring the bot's existing `volunteers` collection access pattern — no schema change |
| Unassigned-but-unknown ids in Zone Panel | Show the raw id rather than hiding it behind `'—'`, since that state signals a data problem worth noticing |
