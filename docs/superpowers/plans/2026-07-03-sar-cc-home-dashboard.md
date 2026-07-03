# SAR Command & Track — CC Home Dashboard (Plan 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Command Center a home screen that lists every search ever created (not just the one currently in local state), lets staff reopen any of them — read-only once complete — mark an active one complete without opening it, start a new one, and see volunteer names instead of raw ids in the zone panel.

**Architecture:** Extends `command-center/` in place, no new folder or dependency. Adds a `view` state (`'home' | 'detail'`) to `App.jsx` plus `location.hash` sync for refresh/back-button friendliness — no router library, matching the rest of the monorepo. The existing single-search map+zone body is extracted verbatim out of `App.jsx` into a new `SearchDetail` component, mounted with `key={searchId}` so React resets all its local state automatically on every reopen instead of the old code's six manual `setX(null)` calls. `HomeDashboard` is the new landing view, backed by `watchSearches()` — a function that already exists in this codebase but has had zero callers until now.

**Tech Stack:** React 19, Vite (current), Firebase JS SDK 10 (Firestore + Auth, unchanged), @turf/turf 6 / Mapbox GL JS 3 (unchanged, only consumed via existing `CommandMap`), Vitest 1

**This is Plan 5**, building on the built Phase 1 Command Center. Companion Plan 6 (comms upgrade) writes the `inviteLink`/`groupChatId` fields this plan's copy-link buttons read — Plan 6 is not required for this plan to ship; those buttons simply stay hidden until Plan 6 lands.

**Spec:** `docs/superpowers/specs/2026-07-03-cc-home-dashboard-design.md`

## Global Constraints

- Repo root on this machine: `C:\Users\Jack\dev\sar-command-track` (never work in the Google Drive copy)
- Node ≥ 20, npm ≥ 10; React functional components + hooks only; Firebase modular API only
- **No router library** — `view` state + manual `location.hash` parsing only, per the spec's routing decision
- Geometry fields in Firestore are JSON strings (`boundary`, `letterZones[].geometry`, `zone.polygon`) — already handled by existing `firebase/searches.js` / `firebase/zones.js`, unchanged by this plan
- Day ID hardcoded `'day-1'` — after Task 3, this constant lives only in `SearchDetail.jsx` (its sole remaining consumer)
- Search statuses: `'setup' | 'active' | 'complete'` (unchanged). Zone statuses: `'unassigned' | 'assigned' | 'in_progress' | 'searched' | 'needs_re_search'` (unchanged)
- Copy-link buttons on a search row must be **hidden**, not disabled, until the corresponding field (`inviteLink`, `groupChatId`) actually exists on that search's doc — never render a dead link
- All tests: Vitest `describe`/`it`/`expect` under `command-center/test/`, mirroring the `src/` path (matches `test/search/searchCode.test.js`, `test/zones/subdivider.test.js`)
- Command Center dev server port 5173 (unchanged)
- Git commits from repo root; identity already configured (Yechiel Kessler)

---

## File Map

```
sar-command-track/
  command-center/
    .env.example                     (modified — adds VITE_SEARCHER_APP_URL)
    .env                             (modified locally only, not committed — same var, real value)
    src/
      App.jsx                        (rewritten — home/detail view switch, hash sync, volunteers watcher)
      firebase/
        volunteers.js                (new — watchVolunteers)
      home/
        sortSearches.js              (new, TDD)
        HomeDashboard.jsx            (new)
        SearchRow.jsx                (new — Open/Complete/copy-link buttons)
      search/
        SearchDetail.jsx             (new — today's App.jsx map+zone body, extracted, read-only when complete)
      ui/
        StatusPill.jsx               (modified — adds setup/active/complete to the color map)
        ZonePanel.jsx                (modified — volunteer-name lookup, readOnly prop)
    test/
      home/
        sortSearches.test.js         (new)
```

---

### Task 1: Search List Sort Order (TDD)

**Files:**
- Create: `command-center/src/home/sortSearches.js`
- Test: `command-center/test/home/sortSearches.test.js`

**Interfaces:**
- Produces: `sortSearches(searches: Array<{ id, status, createdAt }>): Array<search>` — pure, does not mutate its input. Sort key: `status` priority (`active` → `setup` → `complete` → anything else last), then `createdAt` descending within a status group. A `createdAt` of `null`/`undefined` (a doc whose `serverTimestamp()` hasn't resolved yet) sorts as the newest.
- Consumed by: Task 3 (`HomeDashboard`)

- [ ] **Step 1: Write failing tests**

```javascript
// command-center/test/home/sortSearches.test.js
import { describe, it, expect } from 'vitest';
import { sortSearches } from '../../src/home/sortSearches.js';

function ts(ms) {
  return { toMillis: () => ms }; // mimics a Firestore Timestamp
}

describe('sortSearches', () => {
  it('orders active before setup before complete', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
      { id: 's', status: 'setup', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['a', 's', 'c']);
  });

  it('orders newer createdAt first within the same status', () => {
    const searches = [
      { id: 'old', status: 'active', createdAt: ts(100) },
      { id: 'new', status: 'active', createdAt: ts(200) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats a missing createdAt as the most recent', () => {
    const searches = [
      { id: 'has-timestamp', status: 'active', createdAt: ts(999999) },
      { id: 'just-created', status: 'active', createdAt: null },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['just-created', 'has-timestamp']);
  });

  it('accepts plain millisecond numbers for createdAt', () => {
    const searches = [
      { id: 'old', status: 'setup', createdAt: 100 },
      { id: 'new', status: 'setup', createdAt: 200 },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['new', 'old']);
  });

  it('treats an unknown status as lowest priority', () => {
    const searches = [
      { id: 'weird', status: 'archived', createdAt: ts(1) },
      { id: 'done', status: 'complete', createdAt: ts(1) },
    ];
    expect(sortSearches(searches).map(s => s.id)).toEqual(['done', 'weird']);
  });

  it('does not mutate the input array', () => {
    const searches = [
      { id: 'c', status: 'complete', createdAt: ts(1) },
      { id: 'a', status: 'active', createdAt: ts(1) },
    ];
    const before = [...searches];
    sortSearches(searches);
    expect(searches).toEqual(before);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sortSearches.js**

```javascript
// command-center/src/home/sortSearches.js
const STATUS_ORDER = { active: 0, setup: 1, complete: 2 };

export function sortSearches(searches) {
  return [...searches].sort((a, b) => {
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    return millis(b.createdAt) - millis(a.createdAt);
  });
}

function statusRank(status) {
  return STATUS_ORDER[status] ?? 3;
}

function millis(createdAt) {
  if (!createdAt) return Infinity; // no server timestamp yet — just created, treat as newest
  return typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : createdAt;
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npm test
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center/src/home/sortSearches.js command-center/test/home/sortSearches.test.js
git commit -m "feat(cc): search list sort order (TDD) — active, then setup, then complete"
```

---

### Task 2: Volunteer Name Lookup

**Files:**
- Create: `command-center/src/firebase/volunteers.js`
- Modify: `command-center/src/ui/ZonePanel.jsx` (whole file)
- Modify: `command-center/src/App.jsx:10` (add import), `:27` (add state), `:32` (add effect), `:200` (pass new prop) — current file, before Task 3's rewrite replaces it

**Interfaces:**
- Produces: `watchVolunteers(cb: (volunteers: { [id: string]: string }) => void): () => void` — live `id → name` map from the root `volunteers` collection
- Produces (ZonePanel): now takes `volunteers: { [id]: string } = {}` and `readOnly: boolean = false` props (the latter unused until Task 3, defaulted off so this task's behavior is unchanged when `readOnly` isn't passed)
- Consumed by: Task 3 (`SearchDetail`, `App.jsx`'s rewrite)

- [ ] **Step 1: Create volunteers.js**

```javascript
// command-center/src/firebase/volunteers.js
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './config';

export function watchVolunteers(cb) {
  return onSnapshot(collection(db, 'volunteers'), snap =>
    cb(Object.fromEntries(snap.docs.map(d => [d.id, d.data().name])))
  );
}
```

- [ ] **Step 2: Replace ZonePanel.jsx**

```jsx
// command-center/src/ui/ZonePanel.jsx
import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned','assigned','in_progress','searched','needs_re_search'];

export function ZonePanel({ zones, volunteers = {}, onStatusChange, readOnly = false }) {
  const byLetter = zones.reduce((acc, z) => {
    (acc[z.letter] ??= []).push(z);
    return acc;
  }, {});

  return (
    <div style={{ width: 280, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
      )}
      {Object.entries(byLetter).sort().map(([letter, lzones]) => (
        <div key={letter} style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>Zone {letter} — {lzones.length} sub-zone{lzones.length !== 1 ? 's' : ''}</h4>
          {lzones.sort((a, b) => a.number - b.number).map(zone => (
            <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontWeight: 700, minWidth: 28 }}>{zone.letter}{zone.number}</span>
              <span style={{ flex: 1, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {zone.assignedTo ? (volunteers[zone.assignedTo] ?? zone.assignedTo) : '—'}
              </span>
              <StatusPill status={zone.status} />
              {!readOnly && (
                <select value={zone.status} onChange={e => onStatusChange(zone.id, e.target.value)}
                  style={{ fontSize: 11, padding: '1px 4px' }}>
                  {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire the watcher into the current App.jsx**

In `command-center/src/App.jsx`, add the import after the existing `firebase/live` import (currently line 10):

```javascript
import { watchVolunteers } from './firebase/volunteers';
```

Add state after the existing `liveMarkers` state (currently line 27):

```javascript
const [volunteers, setVolunteers] = useState({});
```

Add a new effect immediately after that (this one has no dependency on `searchId` — volunteers are global):

```javascript
useEffect(() => watchVolunteers(setVolunteers), []);
```

Change the `ZonePanel` usage (currently line 200) from:

```jsx
<ZonePanel zones={zones} onStatusChange={handleStatusChange} />
```

to:

```jsx
<ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} />
```

- [ ] **Step 4: Manual verification**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm run dev
```

1. Log in, create a test search ("Plan 5 smoke test"), draw a small boundary, generate zones.
2. In the Firebase console, open `searches/{that search's id}/days/day-1/zones` and edit one zone doc: set `assignedTo` to `"smoke-test-id"`.
3. In the Firebase console, create a doc `volunteers/smoke-test-id` with field `name: "Test Volunteer"`.
4. Back in the Command Center (no reload needed — both are live listeners), confirm that zone's row in the Zone Panel now shows **"Test Volunteer"** instead of `smoke-test-id`.
5. Edit a different zone's `assignedTo` to `"unknown-id"` (no matching volunteer doc) — confirm it falls back to showing the raw id `unknown-id`, not a blank or `—`.

- [ ] **Step 5: Run tests and commit**

```bash
npm test
```
Expected: 6 tests pass (Task 1's — this task added no new pure logic).

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center/src/firebase/volunteers.js command-center/src/ui/ZonePanel.jsx command-center/src/App.jsx
git commit -m "feat(cc): resolve volunteer ids to names in the zone panel"
```

---

### Task 3: Home Dashboard + Search Detail Extraction

**Files:**
- Create: `command-center/src/home/HomeDashboard.jsx`
- Create: `command-center/src/home/SearchRow.jsx`
- Create: `command-center/src/search/SearchDetail.jsx`
- Modify: `command-center/src/ui/StatusPill.jsx` (whole file)
- Modify: `command-center/src/App.jsx` (whole file — replaces Task 2's edits)

**Interfaces:**
- Produces: `<HomeDashboard onOpen(id) onNewSearch() onLogout() />`
- Produces: `<SearchRow search onOpen() />` — no copy-link buttons yet (Task 4 adds them)
- Produces: `<SearchDetail searchId volunteers onBack() onLogout() />` — the entire map+zone body that used to live directly in `App.jsx`; renders read-only (no draw/generate/publish/complete controls, `ZonePanel`'s status dropdown hidden) when the search's status is `'complete'`
- Consumes: `watchSearches`, `completeSearch` (`firebase/searches.js`, already exist), `watchVolunteers` (Task 2), `sortSearches` (Task 1), everything `SearchDetail` needs from `firebase/zones.js`, `firebase/searches.js`, `firebase/live.js`, `zones/subdivider.js`, `map/CommandMap.jsx`, `ui/ZonePanel.jsx` — identical imports to the old `App.jsx`
- Consumed by: Task 4 (`SearchRow` gets copy-link buttons added)

- [ ] **Step 1: Generalize StatusPill's color map**

```jsx
// command-center/src/ui/StatusPill.jsx
const CONFIG = {
  unassigned:      { label: 'Unassigned',  color: '#9ca3af' },
  assigned:        { label: 'Assigned',    color: '#3b82f6' },
  in_progress:     { label: 'In Progress', color: '#f59e0b' },
  searched:        { label: 'Searched',    color: '#22c55e' },
  needs_re_search: { label: 'Re-search',   color: '#ef4444' },
  setup:           { label: 'Setup',       color: '#f59e0b' },
  active:          { label: 'Active',      color: '#22c55e' },
  complete:        { label: 'Complete',    color: '#6b7280' },
};

export function StatusPill({ status }) {
  const { label, color } = CONFIG[status] ?? { label: status, color: '#9ca3af' };
  return (
    <span style={{ background: color, color: '#fff', borderRadius: 12,
      padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
      {label}
    </span>
  );
}
```

- [ ] **Step 2: Create SearchDetail.jsx (extracted from the old App.jsx body)**

```jsx
// command-center/src/search/SearchDetail.jsx
import { useState, useEffect } from 'react';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { fetchOSMBarriers, subdivideWithBarriers, subdivideZone } from '../zones/subdivider';
import { createZone, updateZoneStatus, watchZones } from '../firebase/zones';
import { updateSearchBoundary, updateSearchLetterZones, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';

const DAY_ID = 'day-1';

export function SearchDetail({ searchId, volunteers, onBack, onLogout }) {
  const [searchName, setSearchName] = useState('');
  const [searchStatus, setSearchStatus] = useState('setup');
  const [drawMode, setDrawMode] = useState('idle');
  const [boundary, setBoundary] = useState(null);
  const [zoneCount, setZoneCount] = useState(4);
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [osmBarriers, setOsmBarriers] = useState([]);
  const [letterZones, setLetterZones] = useState([]);
  const [zones, setZones] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [liveMarkers, setLiveMarkers] = useState([]);

  useEffect(() => watchZones(searchId, DAY_ID, setZones), [searchId]);

  useEffect(() => {
    const stopTracks = watchTracks(searchId, DAY_ID, setTracks);
    const stopMarkers = watchMarkers(searchId, DAY_ID, setLiveMarkers);
    return () => { stopTracks(); stopMarkers(); };
  }, [searchId]);

  useEffect(() => {
    return watchSearch(searchId, search => {
      if (search.name) setSearchName(search.name);
      if (search.status) setSearchStatus(search.status);
      if (search.boundary) setBoundary(search.boundary);
      if (search.letterZones?.length) {
        setLetterZones(search.letterZones.map(z => ({
          letter: z.letter,
          feature: { type: 'Feature', geometry: z.geometry, properties: {} },
        })));
      }
    });
  }, [searchId]);

  const readOnly = searchStatus === 'complete';

  async function handleFeatureDrawn(feature, type) {
    setDrawMode('idle');
    try {
      if (type === 'boundary') {
        setBoundary(feature.geometry);
        await updateSearchBoundary(searchId, feature.geometry);
      } else {
        const letter = String.fromCharCode(65 + letterZones.length); // A, B, C…
        const updated = [...letterZones, { letter, feature }];
        setLetterZones(updated);
        await updateSearchLetterZones(searchId, updated);
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }

  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };

      setGeneratingStatus('Fetching roads & waterways…');
      let barriers = [];
      try {
        barriers = await fetchOSMBarriers(boundaryFeature);
        setOsmBarriers(barriers);
      } catch (e) {
        console.warn('OSM fetch failed, using grid:', e);
      }

      setGeneratingStatus('Generating zones…');
      const letterPolygons = barriers.length
        ? subdivideWithBarriers(boundaryFeature, zoneCount, barriers)
        : subdivideZone(boundaryFeature, zoneCount);

      const newLetterZones = letterPolygons.map((poly, i) => ({
        letter: String.fromCharCode(65 + i),
        feature: poly,
      }));
      setLetterZones(newLetterZones);
      await updateSearchLetterZones(searchId, newLetterZones);
      for (const { letter, feature } of newLetterZones) {
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
    }
    setGeneratingStatus('');
    setGeneratingZones(false);
  }

  async function handleStatusChange(zoneId, status) {
    await updateZoneStatus(searchId, DAY_ID, zoneId, status);
  }

  async function handleComplete() {
    if (!window.confirm('Complete this search? Volunteers will no longer be able to sign up.')) return;
    await completeSearch(searchId);
    onBack();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Searches</button>
        <span style={{ fontWeight: 700, marginRight: 8 }}>{searchName || 'SAR Command'}</span>

        {/* Step 1: draw boundary */}
        {searchStatus === 'setup' && !boundary && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary' ? '✏ Drawing boundary… (double-click to finish)' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}

        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && letterZones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: How many zones?</span>
            <input
              type="number" min={1} max={26} value={zoneCount}
              onChange={e => setZoneCount(Number(e.target.value))}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
          </>
        )}

        {/* Step 3: send out */}
        {searchStatus === 'setup' && letterZones.length > 0 && (
          <button
            onClick={async () => { await publishSearch(searchId); }}
            style={{ background: '#22c55e', padding: '4px 12px', fontWeight: 700 }}>
            Step 3: Send Out Search
          </button>
        )}

        {searchStatus === 'active' && (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>● ACTIVE</span>
            <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
              ■ Complete Search
            </button>
          </>
        )}

        {readOnly && (
          <span style={{ color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>VIEWING COMPLETED SEARCH — READ ONLY</span>
        )}

        <span style={{ flex: 1 }} />
        <button onClick={onLogout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <CommandMap
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundary={boundary}
          letterZones={letterZones}
          subZones={zones}
          osmBarriers={osmBarriers}
          tracks={tracks}
          liveMarkers={liveMarkers}
        />
        <ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} readOnly={readOnly} />
      </div>
    </div>
  );
}
```

(`readOnly` also forces `CommandMap`'s `drawMode` to `'idle'` even if stale local state said otherwise — belt-and-suspenders, since the draw-boundary button is already hidden once `searchStatus !== 'setup'`.)

- [ ] **Step 3: Create SearchRow.jsx**

```jsx
// command-center/src/home/SearchRow.jsx
import { StatusPill } from '../ui/StatusPill';
import { completeSearch } from '../firebase/searches';

export function SearchRow({ search, onOpen }) {
  async function handleComplete(e) {
    e.stopPropagation();
    if (!window.confirm(`Complete "${search.name}"? Volunteers will no longer be able to sign up.`)) return;
    await completeSearch(search.id);
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, cursor: 'pointer',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{search.name}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{search.date}</div>
      </div>
      <StatusPill status={search.status} />
      {search.status === 'active' && (
        <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
          Complete
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create HomeDashboard.jsx**

```jsx
// command-center/src/home/HomeDashboard.jsx
import { useState, useEffect } from 'react';
import { watchSearches } from '../firebase/searches';
import { sortSearches } from './sortSearches';
import { SearchRow } from './SearchRow';

export function HomeDashboard({ onOpen, onNewSearch, onLogout }) {
  const [searches, setSearches] = useState([]);

  useEffect(() => watchSearches(setSearches), []);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>SAR Command</h1>
        <span style={{ flex: 1 }} />
        <button onClick={onNewSearch} style={{ background: '#3b82f6', padding: '8px 16px', fontWeight: 700 }}>
          + New Search
        </button>
        <button onClick={onLogout} style={{ background: '#334155', color: '#fff', padding: '8px 16px' }}>
          Sign Out
        </button>
      </div>
      {searches.length === 0 && (
        <p style={{ color: '#9ca3af' }}>No searches yet. Click "+ New Search" to start one.</p>
      )}
      {sortSearches(searches).map(search => (
        <SearchRow key={search.id} search={search} onOpen={() => onOpen(search.id)} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Replace App.jsx**

```jsx
// command-center/src/App.jsx
import { useState, useEffect } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';
import { SearchSetup } from './search/SearchSetup';
import { SearchDetail } from './search/SearchDetail';
import { HomeDashboard } from './home/HomeDashboard';
import { watchVolunteers } from './firebase/volunteers';

function parseHash() {
  const match = location.hash.match(/^#\/search\/(.+)$/);
  return match ? match[1] : null;
}

export default function App() {
  const { user, logout } = useAuth();
  const [view, setView] = useState('home'); // 'home' | 'detail'
  const [searchId, setSearchId] = useState(() => parseHash());
  const [volunteers, setVolunteers] = useState({});

  useEffect(() => {
    if (parseHash()) setView('detail');
  }, []);

  useEffect(() => {
    location.hash = (view === 'detail' && searchId) ? `#/search/${searchId}` : '#/';
  }, [view, searchId]);

  useEffect(() => watchVolunteers(setVolunteers), []);

  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;

  function openSearch(id) {
    setSearchId(id);
    setView('detail');
  }

  function goHome() {
    setView('home');
  }

  if (view === 'home') {
    return <HomeDashboard onOpen={openSearch} onNewSearch={() => openSearch(null)} onLogout={logout} />;
  }

  if (!searchId) {
    return <SearchSetup onSearchCreated={openSearch} />;
  }

  return <SearchDetail key={searchId} searchId={searchId} volunteers={volunteers} onBack={goHome} onLogout={logout} />;
}
```

- [ ] **Step 6: Manual verification**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm run dev
```

1. Log in — lands on the **Home** dashboard (not a bare "New Search" form). If any searches already exist in Firestore (e.g. the 2026-07-03 field-test search), they're listed, sorted active-first.
2. Click **+ New Search** → the familiar name/date form appears → create one → lands directly in its (empty) map view with a **← Searches** link in the header.
3. Click **← Searches** → back on Home, the new search now appears in the list with status **Setup**.
4. Click that row (not its buttons) → reopens the same search, exactly where it was left (no boundary yet).
5. Draw a boundary, generate zones, **Step 3: Send Out Search** → status flips to **Active**; go back home → row now shows an **Active** pill and a **Complete** button.
6. Click **Complete** directly from the dashboard row (without opening it) → confirm dialog → status flips to **Complete**, row updates in place, no navigation happened.
7. Click that now-complete row to reopen it → map and zone panel render, but there is no draw/generate/publish/complete control anywhere, the header shows **VIEWING COMPLETED SEARCH — READ ONLY**, and the Zone Panel's status dropdowns are gone (only the color pill remains).
8. Refresh the browser while inside a detail view (`#/search/{id}` in the address bar) → lands back in that same search's detail view, not Home.

- [ ] **Step 7: Run tests and commit**

```bash
npm test
```
Expected: 6 tests pass (unchanged from Task 1 — this task is UI wiring, no new pure logic).

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center/src
git commit -m "feat(cc): home dashboard listing all searches, reopen-any-search with read-only completed view"
```

---

### Task 4: Copy Invite/Picker Links

**Files:**
- Modify: `command-center/src/home/SearchRow.jsx` (whole file)
- Modify: `command-center/.env.example`
- Modify: `command-center/.env` (local only, not committed)

**Interfaces:**
- Produces: two new buttons on `SearchRow`, each rendered only when the search doc already has the field it needs (`inviteLink`, `groupChatId` — both written by the Plan 6 bot, absent on every search until Plan 6 ships)
- Reads: `import.meta.env.VITE_SEARCHER_APP_URL` (new env var) to build the picker link

- [ ] **Step 1: Add VITE_SEARCHER_APP_URL**

`command-center/.env.example` — add a line:
```
VITE_SEARCHER_APP_URL=
```

`command-center/.env` — add the real deployed value:
```
VITE_SEARCHER_APP_URL=https://sar-searcher.web.app
```

- [ ] **Step 2: Replace SearchRow.jsx**

```jsx
// command-center/src/home/SearchRow.jsx
import { StatusPill } from '../ui/StatusPill';
import { completeSearch } from '../firebase/searches';

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this link:', text));
  } else {
    window.prompt('Copy this link:', text);
  }
}

export function SearchRow({ search, onOpen }) {
  async function handleComplete(e) {
    e.stopPropagation();
    if (!window.confirm(`Complete "${search.name}"? Volunteers will no longer be able to sign up.`)) return;
    await completeSearch(search.id);
  }

  function handleCopyInvite(e) {
    e.stopPropagation();
    copyToClipboard(search.inviteLink);
  }

  function handleCopyPicker(e) {
    e.stopPropagation();
    copyToClipboard(`${import.meta.env.VITE_SEARCHER_APP_URL}/pick/${search.id}`);
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, cursor: 'pointer',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{search.name}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{search.date}</div>
      </div>
      <StatusPill status={search.status} />
      {search.inviteLink && (
        <button onClick={handleCopyInvite} style={{ background: '#334155', padding: '4px 10px', fontSize: 12 }}>
          Copy Invite Link
        </button>
      )}
      {search.groupChatId && (
        <button onClick={handleCopyPicker} style={{ background: '#334155', padding: '4px 10px', fontSize: 12 }}>
          Copy Picker Link
        </button>
      )}
      {search.status === 'active' && (
        <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
          Complete
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Manual verification**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm run dev
```

1. On the Home dashboard, confirm **no** row shows a "Copy Invite Link" or "Copy Picker Link" button — no search has those fields yet (Plan 6 not built).
2. In the Firebase console, open any test search doc and add two fields: `inviteLink: "https://t.me/+testinvite"`, `groupChatId: "-100123456789"`.
3. Back in the dashboard (live listener, no reload needed), that row now shows both buttons.
4. Click **Copy Invite Link** → paste somewhere (Notepad, a chat box) → confirms it pasted `https://t.me/+testinvite` exactly.
5. Click **Copy Picker Link** → paste → confirms it pasted `https://sar-searcher.web.app/pick/{that search's id}` (the real id, matching the row's search).
6. Remove the two test fields from the Firebase console doc afterward, to leave real data clean.

- [ ] **Step 4: Run tests and commit**

```bash
npm test
```
Expected: 6 tests pass.

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center/src/home/SearchRow.jsx command-center/.env.example
git commit -m "feat(cc): copy invite/picker links on each search row (hidden until Plan 6 fields exist)"
```

---

### Task 5: Full Smoke Test + Handoff Update

**Files:** none new — end-to-end verification and documentation.

- [ ] **Step 1: Full lifecycle smoke test**

With `npm run dev` running in `command-center/`:

1. From Home, create two searches: "Smoke A" and "Smoke B".
2. Publish "Smoke A" (draw boundary, generate zones, Send Out Search) so it's **Active**. Leave "Smoke B" in **Setup**.
3. Go to Home — confirm sort order is **Smoke A (Active)** above **Smoke B (Setup)**, regardless of creation order.
4. Complete "Smoke A" from its row's Complete button (without opening it) — confirm it moves to the bottom of the list (Complete sorts last) and its pill turns gray.
5. Open "Smoke A" (now complete) — confirm the read-only banner, no editable controls, map and whatever zones it had still render correctly.
6. Open "Smoke B" (still setup) — confirm it's still fully editable (draw/generate/publish all present).
7. If the 2026-07-03 field-test search still exists in this Firestore project, open it from Home and confirm its zone panel shows the real volunteer's name (not a raw Telegram id) for the zone that was assigned during that field test.
8. Delete "Smoke A" and "Smoke B" test docs from the Firebase console afterward (`searches/{id}` and their `days/day-1/zones` subcollection) to avoid cluttering the real search list.

- [ ] **Step 2: Update the handoff doc**

Edit `G:\My Drive\SAR\SAR-Command-Track-Handoff.md`:
- Mark Plan 5 (CC home dashboard) as **built** under "What's built and working."
- Move it out of "What's designed but NOT yet built."
- Update "Resume here (next session)" to point at Plan 6 (comms upgrade) as the next implementation target, referencing `docs/superpowers/plans/2026-07-03-sar-comms-upgrade.md` once that plan is written.

- [ ] **Step 3: Final commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add -A
git commit -m "docs: mark Plan 5 (CC home dashboard) built in the handoff doc"
```

---

## Spec Coverage

| Spec section | Covered |
|---|---|
| §1 New/changed files, no router, `view` state model | Tasks 3, 4 |
| §2 `watchVolunteers()`, no schema change | Task 2 |
| §3 Home dashboard layout, `+ New Search`, sort order | Tasks 1, 3 |
| §3 `SearchRow` — Open, Complete, copy invite/picker links | Tasks 3, 4 |
| §3 Detail view generalized to any status, read-only when complete | Task 3 |
| §3 Zone panel volunteer names, raw-id fallback | Task 2 |
| §4 Error handling: confirm dialogs, clipboard fallback, empty-boundary reopen, watcher race | Tasks 3, 4 (clipboard fallback); the confirm dialog and empty-boundary cases are inherent to the extracted/reused code, verified in Task 3/5's manual checks |
| §5 Unit test for sort order; manual end-to-end smoke test | Tasks 1, 5 |
| §6 Open decisions (hash routing, read-only reopen, hidden-not-disabled links, volunteer lookup, raw-id fallback) | Tasks 2, 3, 4 |

**Deferred:** everything gated on Plan 6 fields (`inviteLink`, `groupChatId`) actually being populated by a real bound group — this plan only makes the UI ready to show them.
