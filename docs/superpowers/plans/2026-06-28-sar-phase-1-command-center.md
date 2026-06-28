# SAR Command & Track — Phase 1: Command Center

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working command center web app where staff can log in, create a search, draw the outer boundary and letter zones, and see auto-generated numbered sub-zones with status management.

**Architecture:** React + Vite SPA, Firebase Firestore as real-time backend, Mapbox GL JS for map and polygon drawing. Turf.js handles all geospatial calculations. No backend server — all reads/writes go browser → Firestore.

**Tech Stack:** React 18, Vite 5, Firebase 10 (Firestore + Auth), Mapbox GL JS 3, @mapbox/mapbox-gl-draw 1.4, @turf/turf 6, Vitest 1

**This is Plan 1 of 4:**
- **Plan 1 (this):** Command Center — login, zone drawing, sub-zone preview
- **Plan 2:** Telegram Bot — /register, /available, zone assignment, DM link
- **Plan 3:** Searcher PWA — tokenized link, GPS tracking, offline
- **Plan 4:** Integration — live tracks on command map, day reset, export

---

## Global Constraints

- Node ≥ 20, npm ≥ 10
- React 18 functional components + hooks only — no class components
- Firebase SDK v10 modular API only — never use the compat layer
- All env vars prefixed `VITE_` (Vite requirement)
- All GeoJSON stored as plain Geometry objects in Firestore (not Feature wrappers)
- Zone IDs: letter zones use letter (e.g. `A`), sub-zones use `{letter}{number}` (e.g. `A1`)
- All tests use Vitest with `describe`/`it`/`expect`
- Project root: `C:\Users\Jack\Desktop\SAR Command\`
- Command center app: `C:\Users\Jack\Desktop\SAR Command\command-center\`

---

## File Map

```
C:\Users\Jack\Desktop\SAR Command\
  .git/
  firestore.rules
  firebase.json
  command-center/
    package.json
    vite.config.js
    index.html
    .env.example
    .gitignore
    src/
      main.jsx                  — React root mount
      App.jsx                   — Auth gate + main layout
      index.css                 — Global reset
      firebase/
        config.js               — Firebase init, exports db + auth
        searches.js             — Firestore CRUD: searches collection
        zones.js                — Firestore CRUD: zones subcollection
      auth/
        useAuth.js              — onAuthStateChanged hook
        LoginPage.jsx           — Email/password form
      map/
        CommandMap.jsx          — Mapbox GL + MapboxDraw
      zones/
        subdivider.js           — subdivideZone(polygon, n)
      search/
        SearchSetup.jsx         — Create new search form
      ui/
        ZonePanel.jsx           — Zone list panel
        StatusPill.jsx          — Zone status badge
    test/
      zones/
        subdivider.test.js
```

---

### Task 1: Project Scaffold + Dependencies

**Files:**
- Create: `command-center/package.json`
- Create: `command-center/vite.config.js`
- Create: `command-center/index.html`
- Create: `command-center/.env.example`
- Create: `command-center/.gitignore`

**Interfaces:**
- Produces: dev server at `http://localhost:5173`, `npm test` command

- [ ] **Step 1: Init git at monorepo root**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git init
```

- [ ] **Step 2: Scaffold Vite + React**

```bash
npm create vite@latest command-center -- --template react
cd command-center
```

- [ ] **Step 3: Install dependencies**

```bash
npm install firebase@^10 mapbox-gl@^3 "@mapbox/mapbox-gl-draw@^1.4" "@turf/turf@^6"
npm install -D vitest@^1 jsdom
```

- [ ] **Step 4: Replace vite.config.js**

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node' },
});
```

- [ ] **Step 5: Add test script to package.json**

Ensure `scripts` in `command-center/package.json` includes:
```json
"test": "vitest run"
```

- [ ] **Step 6: Create .env.example**

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_MAPBOX_TOKEN=
```

- [ ] **Step 7: Create .gitignore**

```
node_modules/
dist/
.env
.env.local
```

- [ ] **Step 8: Verify dev server starts**

```bash
npm run dev
```
Expected: Vite server at `http://localhost:5173` with the default React page.

- [ ] **Step 9: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: scaffold command-center Vite + React project"
```

---

### Task 2: Firebase Config + Firestore Rules

**Files:**
- Create: `command-center/src/firebase/config.js`
- Create: `firestore.rules`
- Create: `firebase.json`

**Interfaces:**
- Produces: `db` (Firestore instance) and `auth` (Auth instance) exported from `firebase/config.js`
- Consumed by: Tasks 3, 6, 7

**Manual prerequisite (one-time):**
1. https://console.firebase.google.com → Create project → name "sar-command"
2. Firestore → Create database → Native mode
3. Authentication → Sign-in methods → Email/Password → Enable
4. Project Settings → Your apps → Add web app → copy config values
5. Copy `.env.example` → `.env`, fill in values

- [ ] **Step 1: Create src/firebase/config.js**

```javascript
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
```

- [ ] **Step 2: Create firestore.rules**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /volunteers/{id} {
      allow read, write: if true;
    }
    match /searches/{searchId} {
      allow read: if true;
      allow write: if request.auth != null;
      match /days/{dayId}/zones/{zoneId} {
        allow read: if true;
        allow write: if request.auth != null;
      }
      match /days/{dayId}/tracks/{volunteerId} {
        allow read: if request.auth != null;
        allow create, update: if true;
      }
      match /days/{dayId}/markers/{markerId} {
        allow read: if true;
        allow create: if true;
        allow update: if request.auth != null;
      }
    }
  }
}
```

- [ ] **Step 3: Create firebase.json**

```json
{
  "firestore": { "rules": "firestore.rules" },
  "hosting": {
    "public": "command-center/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: Firebase config and Firestore rules"
```

---

### Task 3: Auth — Login Page + Route Guard

**Files:**
- Create: `command-center/src/auth/useAuth.js`
- Create: `command-center/src/auth/LoginPage.jsx`
- Modify: `command-center/src/App.jsx`

**Interfaces:**
- Produces: `useAuth()` → `{ user, login, logout }` where `user` is `undefined` (loading), `null` (logged out), or Firebase User (logged in)
- Consumed by: Task 9

- [ ] **Step 1: Create useAuth.js**

```javascript
import { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '../firebase/config';

export function useAuth() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  return {
    user,
    login: (email, password) => signInWithEmailAndPassword(auth, email, password),
    logout: () => signOut(auth),
  };
}
```

- [ ] **Step 2: Create LoginPage.jsx**

```jsx
import { useState } from 'react';
import { useAuth } from './useAuth';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
    } catch {
      setError('Invalid email or password.');
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320 }}>
        <h1 style={{ margin: 0 }}>SAR Command Center</h1>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required autoFocus />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required />
        {error && <p style={{ color: '#ef4444', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign In'}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Replace App.jsx with auth gate**

```jsx
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;
  return <p style={{ padding: 24 }}>Logged in as {user.email}</p>;
}
```

- [ ] **Step 4: Verify in browser**

```bash
npm run dev
```
Confirm: loading flash → login form → wrong creds show error → correct creds show email.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: auth login page and route guard"
```

---

### Task 4: Zone Subdivision Algorithm (TDD)

**Files:**
- Create: `command-center/src/zones/subdivider.js`
- Create: `command-center/test/zones/subdivider.test.js`

**Interfaces:**
- Produces: `subdivideZone(polygon: GeoJSON.Feature<Polygon>, n: number): GeoJSON.Feature<Polygon>[]`
  - Returns ~n sub-polygons covering the input polygon
  - Throws `Error('n must be positive')` when `n <= 0`
  - Returns `[polygon]` unchanged when `n === 1`
- Consumed by: Task 9

- [ ] **Step 1: Write failing tests**

```javascript
// test/zones/subdivider.test.js
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { subdivideZone } from '../../src/zones/subdivider.js';

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
```

- [ ] **Step 2: Run — confirm all 5 fail**

```bash
cd "C:\Users\Jack\Desktop\SAR Command\command-center"
npm test
```
Expected: `Cannot find module '../../src/zones/subdivider.js'`

- [ ] **Step 3: Implement subdivider.js**

```javascript
// src/zones/subdivider.js
import * as turf from '@turf/turf';

export function subdivideZone(polygon, n) {
  if (n <= 0) throw new Error('n must be positive');
  if (n === 1) return [polygon];

  const totalAreaM2 = turf.area(polygon);
  const cellSizeKm = Math.sqrt(totalAreaM2 / n) / 1000;
  const [minX, minY, maxX, maxY] = turf.bbox(polygon);
  const pad = cellSizeKm / 100;
  const bbox = [minX - pad, minY - pad, maxX + pad, maxY + pad];

  const grid = turf.squareGrid(bbox, cellSizeKm, { units: 'kilometers' });
  const minAreaM2 = totalAreaM2 / (n * 10);

  return grid.features
    .map(cell => turf.intersect(cell, polygon))
    .filter(Boolean)
    .filter(cell => turf.area(cell) >= minAreaM2);
}
```

- [ ] **Step 4: Run — confirm all 5 pass**

```bash
npm test
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: zone subdivision algorithm (TDD)"
```

---

### Task 5: Mapbox Map + Zone Drawing

**Files:**
- Create: `command-center/src/map/CommandMap.jsx`

**Interfaces:**
- Produces: `<CommandMap drawMode onFeatureDrawn letterZones subZones />`
  - `drawMode: 'idle' | 'boundary' | 'letter_zone'`
  - `onFeatureDrawn(feature: GeoJSON.Feature, type: 'boundary' | 'letter_zone'): void`
  - `letterZones: Array<{ letter: string, feature: GeoJSON.Feature }>`
  - `subZones: Array<{ id: string, letter: string, number: number, polygon: GeoJSON.Geometry, status: string }>`
- Consumed by: Task 9

**Manual prerequisite:** Get Mapbox token from https://account.mapbox.com → Tokens. Add `VITE_MAPBOX_TOKEN=pk.xxx` to `.env`.

- [ ] **Step 1: Create CommandMap.jsx**

```jsx
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const STATUS_COLORS = {
  unassigned: '#9ca3af', assigned: '#3b82f6',
  in_progress: '#f59e0b', searched: '#22c55e', needs_re_search: '#ef4444',
};

export function CommandMap({ drawMode, onFeatureDrawn, letterZones = [], subZones = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center: [-118.25, 34.05],
      zoom: 11,
    });
    const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true } });
    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('letter-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'letter-zones-fill', type: 'fill', source: 'letter-zones',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'letter-zones-line', type: 'line', source: 'letter-zones',
        paint: { 'line-color': '#1d4ed8', 'line-width': 2 } });

      map.addSource('sub-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'sub-zones-fill', type: 'fill', source: 'sub-zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'sub-zones-line', type: 'line', source: 'sub-zones',
        paint: { 'line-color': '#374151', 'line-width': 1 } });
    });

    map.on('draw.create', e => {
      const type = drawModeRef.current === 'boundary' ? 'boundary' : 'letter_zone';
      onFeatureDrawn?.(e.features[0], type);
      draw.deleteAll();
    });

    mapRef.current = map;
    drawRef.current = draw;
    return () => map.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.changeMode(drawMode === 'idle' ? 'simple_select' : 'draw_polygon');
  }, [drawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('letter-zones')?.setData(
      turf.featureCollection(letterZones.map(z => ({ ...z.feature, properties: { letter: z.letter } })))
    );
  }, [letterZones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('sub-zones')?.setData(
      turf.featureCollection(subZones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { label: `${z.letter}${z.number}`, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
  }, [subZones]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
}
```

- [ ] **Step 2: Smoke test — map renders**

Temporarily in `App.jsx` logged-in branch, render `<CommandMap drawMode="idle" />`. Run `npm run dev`, confirm terrain map appears.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: Mapbox command map with draw tools and zone layers"
```

---

### Task 6: Firestore Searches + Zones Store

**Files:**
- Create: `command-center/src/firebase/searches.js`
- Create: `command-center/src/firebase/zones.js`

**Interfaces:**
- `searches.js` produces:
  - `createSearch({ name: string, date: string }): Promise<{ id: string }>`
  - `updateSearchBoundary(searchId: string, boundary: GeoJSON.Geometry): Promise<void>`
  - `publishSearch(searchId: string): Promise<void>`
  - `watchSearches(cb: (searches: object[]) => void): () => void`
- `zones.js` produces:
  - `createZone(searchId: string, dayId: string, { letter: string, number: number, polygon: GeoJSON.Geometry }): Promise<string>`
  - `updateZoneStatus(searchId: string, dayId: string, zoneId: string, status: string): Promise<void>`
  - `watchZones(searchId: string, dayId: string, cb: (zones: object[]) => void): () => void`
- Consumed by: Tasks 7, 9

- [ ] **Step 1: Create searches.js**

```javascript
import { collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundary: null, letterZones: [],
  });
  return { id: ref.id };
}

export async function updateSearchBoundary(searchId, boundary) {
  await updateDoc(doc(db, 'searches', searchId), { boundary });
}

export async function publishSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'active' });
}

export function watchSearches(cb) {
  return onSnapshot(collection(db, 'searches'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
```

- [ ] **Step 2: Create zones.js**

```javascript
import { collection, doc, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const zonesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'zones');

export async function createZone(searchId, dayId, { letter, number, polygon }) {
  const ref = doc(zonesCol(searchId, dayId));
  await setDoc(ref, {
    letter, number, polygon, status: 'unassigned', assignedTo: null, createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateZoneStatus(searchId, dayId, zoneId, status) {
  await updateDoc(doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId), { status });
}

export function watchZones(searchId, dayId, cb) {
  return onSnapshot(zonesCol(searchId, dayId), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: Firestore searches and zones store"
```

---

### Task 7: Search Setup Form

**Files:**
- Create: `command-center/src/search/SearchSetup.jsx`

**Interfaces:**
- Produces: `<SearchSetup onSearchCreated(searchId: string) />`
- Consumes: `createSearch` from `firebase/searches.js`

- [ ] **Step 1: Create SearchSetup.jsx**

```jsx
import { useState } from 'react';
import { createSearch } from '../firebase/searches';

export function SearchSetup({ onSearchCreated }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { id } = await createSearch({ name, date });
      onSearchCreated(id);
    } catch {
      setError('Failed to create search. Check Firebase config.');
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 360 }}>
        <h2 style={{ margin: 0 }}>New Search</h2>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="Search name (e.g. Mt Wilson 2026-06-28)" required autoFocus />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
        {error && <p style={{ color: '#ef4444', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create Search'}</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: search setup form"
```

---

### Task 8: Zone Panel + Status Pill

**Files:**
- Create: `command-center/src/ui/StatusPill.jsx`
- Create: `command-center/src/ui/ZonePanel.jsx`

**Interfaces:**
- Produces: `<StatusPill status: string />`
- Produces: `<ZonePanel zones: ZoneDoc[] onStatusChange(zoneId: string, status: string) />`
  - `ZoneDoc = { id, letter, number, status, assignedTo }`
- Consumed by: Task 9

- [ ] **Step 1: Create StatusPill.jsx**

```jsx
const CONFIG = {
  unassigned:      { label: 'Unassigned',  color: '#9ca3af' },
  assigned:        { label: 'Assigned',    color: '#3b82f6' },
  in_progress:     { label: 'In Progress', color: '#f59e0b' },
  searched:        { label: 'Searched',    color: '#22c55e' },
  needs_re_search: { label: 'Re-search',   color: '#ef4444' },
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

- [ ] **Step 2: Create ZonePanel.jsx**

```jsx
import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned','assigned','in_progress','searched','needs_re_search'];

export function ZonePanel({ zones, onStatusChange }) {
  const byLetter = zones.reduce((acc, z) => {
    (acc[z.letter] ??= []).push(z);
    return acc;
  }, {});

  return (
    <div style={{ width: 280, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw letter zones on the map.</p>
      )}
      {Object.entries(byLetter).sort().map(([letter, lzones]) => (
        <div key={letter} style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>Zone {letter} — {lzones.length} sub-zone{lzones.length !== 1 ? 's' : ''}</h4>
          {lzones.sort((a, b) => a.number - b.number).map(zone => (
            <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontWeight: 700, minWidth: 28 }}>{zone.letter}{zone.number}</span>
              <span style={{ flex: 1, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {zone.assignedTo ?? '—'}
              </span>
              <select value={zone.status} onChange={e => onStatusChange(zone.id, e.target.value)}
                style={{ fontSize: 11, padding: '1px 4px' }}>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: ZonePanel and StatusPill UI components"
```

---

### Task 9: Wire App Together

**Files:**
- Modify: `command-center/src/App.jsx`
- Create: `command-center/src/index.css`
- Modify: `command-center/src/main.jsx`

- [ ] **Step 1: Create index.css**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #f9fafb; color: #111827; }
input, select, button { font: inherit; }
input { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 12px; width: 100%; }
button { background: #1d4ed8; color: white; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button:hover:not(:disabled) { background: #1e40af; }
```

- [ ] **Step 2: Update main.jsx to import index.css**

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

- [ ] **Step 3: Write final App.jsx**

```jsx
import { useState, useEffect } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';
import { SearchSetup } from './search/SearchSetup';
import { CommandMap } from './map/CommandMap';
import { ZonePanel } from './ui/ZonePanel';
import { subdivideZone } from './zones/subdivider';
import { createZone, updateZoneStatus, watchZones } from './firebase/zones';
import { updateSearchBoundary } from './firebase/searches';

const DAY_ID = 'day-1';

export default function App() {
  const { user, logout } = useAuth();
  const [searchId, setSearchId] = useState(null);
  const [drawMode, setDrawMode] = useState('idle');
  const [letterZones, setLetterZones] = useState([]);
  const [zones, setZones] = useState([]);

  useEffect(() => {
    if (!searchId) return;
    return watchZones(searchId, DAY_ID, setZones);
  }, [searchId]);

  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;
  if (!searchId) return <SearchSetup onSearchCreated={setSearchId} />;

  async function handleFeatureDrawn(feature, type) {
    setDrawMode('idle');
    if (type === 'boundary') {
      await updateSearchBoundary(searchId, feature.geometry);
    } else {
      const letter = String.fromCharCode(65 + letterZones.length); // A, B, C…
      const updated = [...letterZones, { letter, feature }];
      setLetterZones(updated);
      const subZones = subdivideZone(feature, 1);
      for (let i = 0; i < subZones.length; i++) {
        await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
      }
    }
  }

  async function handleStatusChange(zoneId, status) {
    await updateZoneStatus(searchId, DAY_ID, zoneId, status);
  }

  const nextLetter = String.fromCharCode(65 + letterZones.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, marginRight: 8 }}>SAR Command</span>
        <button
          onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
          style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
          {drawMode === 'boundary' ? '✏ Drawing boundary…' : '📍 Draw Boundary'}
        </button>
        <button
          onClick={() => setDrawMode(m => m === 'letter_zone' ? 'idle' : 'letter_zone')}
          style={{ background: drawMode === 'letter_zone' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
          {drawMode === 'letter_zone' ? `✏ Drawing Zone ${nextLetter}…` : `🗺 Add Zone ${nextLetter}`}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={logout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <CommandMap
          drawMode={drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          letterZones={letterZones}
          subZones={zones}
        />
        <ZonePanel zones={zones} onStatusChange={handleStatusChange} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Full smoke test**

```bash
npm run dev
```

Walk through:
1. Login form → sign in → search setup → create search
2. Click "Draw Boundary" → draw polygon → button returns to idle
3. Click "Add Zone A" → draw polygon → Zone A appears in panel with status Unassigned
4. Click "Add Zone B" → draw polygon → Zone B appears
5. Change zone status in panel dropdown → pill updates
6. Firebase console → confirm `searches/{id}/days/day-1/zones` populated

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: 5 tests pass.

- [ ] **Step 6: Final commit**

```bash
cd "C:\Users\Jack\Desktop\SAR Command"
git add .
git commit -m "feat: wire App.jsx — Phase 1 command center complete"
```

---

## Spec Coverage

| Spec section | Covered |
|---|---|
| Firebase + Auth setup | Tasks 2, 3 |
| Command center login | Task 3 |
| Draw outer boundary | Tasks 5, 9 |
| Draw letter zones | Tasks 5, 9 |
| Auto-generate sub-zones | Tasks 4, 9 |
| Zone states + manual status | Tasks 6, 8, 9 |
| Search creation | Task 7 |
| Firestore schema | Tasks 2, 6 |

**Deferred to later plans:** Telegram bot (Plan 2), volunteer sign-up (Plan 2), Searcher PWA + GPS (Plan 3), offline support (Plan 3), live searcher tracks on command map (Plan 4), day reset (Plan 4), export (Plan 4), terrain-aware subdivision (Plan 4 enhancement).
