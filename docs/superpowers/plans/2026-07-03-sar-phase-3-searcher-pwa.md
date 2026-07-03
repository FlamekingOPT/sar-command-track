# SAR Command & Track — Phase 3: Searcher PWA

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mobile Searcher PWA volunteers open from a tokenized link: shows their assigned zone on an offline-capable map, tracks their GPS path with coverage shading, lets them drop marker pins, and flips zone status In Progress → Zone Complete.

**Architecture:** React + Vite PWA in a new `searcher-app/` folder. No login — the URL token resolves to a `searcherLinks/{token}` doc that names the zone. All writes (GPS points, markers, status) go to an IndexedDB queue first and flush to Firestore every 10 s, so online and offline behave identically. Map tiles for the zone's bounding box are pre-fetched on load and served offline by a Workbox service worker. Deployed as a second Firebase Hosting site in the same project.

**Tech Stack:** React 19, Vite (current), vite-plugin-pwa (Workbox), Mapbox GL JS 3 (`streets-v12`), Firebase JS SDK 10 (Firestore only, no Auth), @turf/turf 6, idb 8, Vitest 1, fake-indexeddb (tests)

**This is Plan 3 of 4** (Plan 1: Command Center — built; Plan 2: Telegram Bot; Plan 4: Integration).

**Spec:** `docs/superpowers/specs/2026-07-02-searcher-pwa-design.md`

## Global Constraints

- Repo root on this machine: `C:\Users\Jack\dev\sar-command-track` (never work in the Google Drive copy)
- Node ≥ 20, npm ≥ 10; React functional components + hooks only; Firebase modular API only
- **Geometry fields in Firestore are JSON strings** — `zone.polygon` must be `JSON.parse`d on read (matches `command-center/src/firebase/zones.js`). Never write geometry from this app.
- Day ID hardcoded `day-1` — but the app never hardcodes it: `dayId` always comes from the resolved link doc
- The app writes exactly three things, all via the offline queue: track points (`tracks/{volunteerId}.points` arrayUnion), markers (`markers` addDoc), and the zone `status` field. **It never writes any other zone field** — the Firestore rules in Task 2 enforce this (status-only unauthenticated updates).
- Zone status values used here: opening the app sets `in_progress`; the Complete button sets `searched`; re-open sets `in_progress` again
- Map style: `mapbox://styles/mapbox/streets-v12` (matches Command Center)
- Tile prefetch zooms: 14–17, zone bounding box only (spec §8)
- Env vars: same `VITE_FIREBASE_*` + `VITE_MAPBOX_TOKEN` values as `command-center/.env` (public client config)
- Dev server port 5174 (5173 is the Command Center's)
- Pure logic (`token.js`, `map/tileMath.js`) must not import `firebase/config.js`; tests import pure modules directly
- All tests: Vitest `describe`/`it`/`expect` under `searcher-app/test/`
- Git commits from repo root; identity already configured (Yechiel Kessler)

---

## File Map

```
sar-command-track/
  firestore.rules                    (modified — searcherLinks + status-only zone updates)
  firebase.json                      (modified — two hosting targets)
  .firebaserc                        (new — project + hosting target mapping)
  searcher-app/                      (all new)
    package.json
    vite.config.js                   — react + VitePWA (manifest, Mapbox runtime caching)
    index.html
    .env                             (gitignored) / .env.example
    .gitignore
    public/icon.svg                  — PWA icon
    src/
      main.jsx
      App.jsx                        — token → link → zone → map + controls state machine
      index.css
      firebase/
        config.js                    — Firestore init with persistent local cache, no Auth
        token.js                     — parseToken (pure)
        links.js                     — resolveLink(token)
        zones.js                     — getZone, watchZone, updateZoneStatus
        tracks.js                    — appendTrackPoints
        markers.js                   — createMarker
      map/
        tileMath.js                  — lngLatToTile, tilesForBbox, tileUrlsFromTemplate (pure)
        tilePrefetch.js              — prefetchZoneTiles(map, bbox)
        SearcherMap.jsx              — zone boundary, path, coverage, markers, tap-to-pin
      gps/
        offlineQueue.js              — IndexedDB queue primitives
        sync.js                      — startSync: 10 s flush loop, batches track points
        useGpsTracking.js            — watchPosition → queue + local state
      ui/
        StatusButton.jsx
        MarkerForm.jsx
    test/
      firebase/token.test.js
      map/tileMath.test.js
      gps/offlineQueue.test.js
```

---

### Task 1: Scaffold searcher-app + PWA Config

**Files:**
- Create: `searcher-app/` via Vite scaffold, then `vite.config.js`, `.env.example`, `.env`, `.gitignore`, `public/icon.svg`, `index.html` (modify scaffold's), `src/index.css`
- Delete: scaffold's `src/App.css`, `src/assets/`

**Interfaces:**
- Produces: dev server at `http://localhost:5174`, `npm test`, service worker with Mapbox `CacheFirst` runtime caching + app-shell precache
- Consumed by: all later tasks

- [ ] **Step 1: Scaffold Vite + React**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
npm create vite@latest searcher-app -- --template react
cd searcher-app
```

- [ ] **Step 2: Install dependencies**

```bash
npm install firebase@^10 mapbox-gl@^3 "@turf/turf@^6" idb@^8
npm install -D vitest@^1.6 vite-plugin-pwa@latest fake-indexeddb@^6
```

(`vite-plugin-pwa@latest` — pick whatever ships with support for the scaffolded Vite major; if npm reports a peer-dependency conflict, use the newest version whose peer range includes the installed Vite.)

- [ ] **Step 3: Replace vite.config.js**

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'SAR Searcher',
        short_name: 'SAR',
        start_url: '/',
        display: 'standalone',
        theme_color: '#1e293b',
        background_color: '#ffffff',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Serve cached Mapbox responses (style, tiles, glyphs, sprites) when offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mapbox',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { port: 5174 },
  test: { environment: 'node' },
});
```

- [ ] **Step 4: Create public/icon.svg**

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#1e293b"/>
  <circle cx="50" cy="50" r="28" fill="none" stroke="#f59e0b" stroke-width="8"/>
  <line x1="50" y1="10" x2="50" y2="30" stroke="#f59e0b" stroke-width="8" stroke-linecap="round"/>
  <line x1="50" y1="70" x2="50" y2="90" stroke="#f59e0b" stroke-width="8" stroke-linecap="round"/>
  <line x1="10" y1="50" x2="30" y2="50" stroke="#f59e0b" stroke-width="8" stroke-linecap="round"/>
  <line x1="70" y1="50" x2="90" y2="50" stroke="#f59e0b" stroke-width="8" stroke-linecap="round"/>
</svg>
```

(SVG icon keeps the plan asset-free. Note: some Android launchers prefer PNG for install banners; acceptable for MVP since the app is opened via link, not installed.)

- [ ] **Step 5: Replace index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <meta name="theme-color" content="#1e293b" />
    <title>SAR Searcher</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create src/index.css, clean scaffold**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body { font-family: system-ui, sans-serif; overscroll-behavior: none; }
input, button { font: inherit; }
input { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 12px; width: 100%; }
button { border: none; border-radius: 8px; padding: 10px 14px; cursor: pointer; background: #1d4ed8; color: #fff; }
button:disabled { opacity: 0.5; }
```

Delete `src/App.css` and `src/assets/`. Replace `src/main.jsx`:

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

And temporarily replace `src/App.jsx` (real version arrives in Task 9):

```jsx
export default function App() {
  return <p style={{ padding: 24 }}>SAR Searcher — scaffold OK</p>;
}
```

- [ ] **Step 7: Create .env.example, .env, .gitignore**

`.env.example`:
```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_MAPBOX_TOKEN=
```

`.env`: copy the filled values from `command-center/.env` (same Firebase project, same Mapbox token).

`.gitignore`:
```
node_modules/
dist/
dev-dist/
.env
.env.local
```

- [ ] **Step 8: Add test script and verify**

Ensure `searcher-app/package.json` scripts include `"test": "vitest run"`. Then:

```bash
npm run dev
```
Expected: `http://localhost:5174` shows "SAR Searcher — scaffold OK".

```bash
npm test
```
Expected: exits reporting no test files found.

- [ ] **Step 9: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): scaffold PWA with Workbox Mapbox caching"
```

---

### Task 2: Firestore Rules + Second Hosting Site

**Files:**
- Modify: `firestore.rules` (whole file below)
- Modify: `firebase.json` (whole file below)
- Create: `.firebaserc`

**Interfaces:**
- Produces: deployed rules allowing `searcherLinks` reads and unauthenticated status-only zone updates; hosting targets `command-center` and `searcher`
- Consumed by: Tasks 3, 6 (rules must be live before unauthenticated reads/writes work), Task 10 (deploy)

**Manual prerequisites (one-time):**
1. Install firebase CLI if missing (`npm install -g firebase-tools`), then `firebase login` with the account that owns `sar-trackhatzolah`.
2. Firebase Console → Hosting (main page, not inside a site) → the site list at the bottom → **Add another site** → name it `sar-searcher` (if the name is taken globally, use `sar-searcher-hatzolah` and use that name in `.firebaserc` below). Per the handoff doc: the last attempt landed inside the *default* site's setup wizard — the "Add another site" button is on the Hosting dashboard's site list, not in the wizard.

- [ ] **Step 1: Replace firestore.rules**

Adds the `searcherLinks` block and splits the zone `write` rule into status-only-update vs. staff-only create/delete (spec §2). Everything else is unchanged from Phase 1.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /volunteers/{id} {
      allow read, write: if true;
    }
    match /searcherLinks/{token} {
      allow read: if true;   // the app resolves tokens client-side
      allow write: if false; // written only by the bot via Admin SDK (bypasses rules)
    }
    match /searches/{searchId} {
      allow read: if true;
      allow write: if request.auth != null;
      match /days/{dayId}/zones/{zoneId} {
        allow read: if true;
        allow update: if request.auth != null
          || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);
        allow create, delete: if request.auth != null;
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

- [ ] **Step 2: Replace firebase.json**

```json
{
  "firestore": { "rules": "firestore.rules" },
  "hosting": [
    {
      "target": "command-center",
      "public": "command-center/dist",
      "ignore": ["firebase.json", "**/.*", "**/node_modules/**"]
    },
    {
      "target": "searcher",
      "public": "searcher-app/dist",
      "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
      "rewrites": [{ "source": "**", "destination": "/index.html" }]
    }
  ]
}
```

(The `rewrites` block makes `/s/{token}` URLs serve the SPA.)

- [ ] **Step 3: Create .firebaserc**

```json
{
  "projects": { "default": "sar-trackhatzolah" },
  "targets": {
    "sar-trackhatzolah": {
      "hosting": {
        "command-center": ["sar-trackhatzolah"],
        "searcher": ["sar-searcher"]
      }
    }
  }
}
```

(Replace `sar-searcher` with the actual site name created in the manual prerequisite if different.)

- [ ] **Step 4: Deploy rules and verify targets**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
firebase deploy --only firestore:rules
firebase target
```
Expected: rules deploy succeeds; `firebase target` lists both hosting targets. (This is a live rules deploy, not just a commit — spec calls it out explicitly.)

- [ ] **Step 5: Verify Command Center hosting still deploys**

```bash
cd command-center && npm run build && cd ..
firebase deploy --only hosting:command-center
```
Expected: deploys to the original site URL, page loads.

- [ ] **Step 6: Commit**

```bash
git add firestore.rules firebase.json .firebaserc
git commit -m "feat: searcherLinks rules, status-only zone updates, second hosting site"
```

---

### Task 3: Firebase Init + Token Parsing + Link Resolution (TDD)

**Files:**
- Create: `searcher-app/src/firebase/config.js`
- Create: `searcher-app/src/firebase/token.js`
- Create: `searcher-app/test/firebase/token.test.js`
- Create: `searcher-app/src/firebase/links.js`

**Interfaces:**
- Produces: `db` (Firestore with persistent local cache — cached reads survive offline reloads) from `config.js`
- Produces: `parseToken(pathname: string): string | null` (pure)
- Produces: `resolveLink(token: string): Promise<{ searchId, dayId, zoneId, volunteerId } | null>` — `null` for missing OR inactive links
- Consumed by: Task 9 (App)

- [ ] **Step 1: Write failing token tests**

```javascript
// searcher-app/test/firebase/token.test.js
import { describe, it, expect } from 'vitest';
import { parseToken } from '../../src/firebase/token.js';

describe('parseToken', () => {
  it('extracts the token from /s/{token}', () => {
    expect(parseToken('/s/AbC123_-xYz9')).toBe('AbC123_-xYz9');
  });

  it('tolerates a trailing slash', () => {
    expect(parseToken('/s/AbC123_-xYz9/')).toBe('AbC123_-xYz9');
  });

  it('returns null for the root path', () => {
    expect(parseToken('/')).toBeNull();
  });

  it('returns null for /s/ with no token', () => {
    expect(parseToken('/s/')).toBeNull();
  });

  it('returns null for tokens with invalid characters', () => {
    expect(parseToken('/s/abc$%^')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement token.js**

```javascript
// searcher-app/src/firebase/token.js
export function parseToken(pathname) {
  const match = pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run — confirm pass**

```bash
npm test
```
Expected: 5 tests pass.

- [ ] **Step 5: Create config.js**

```javascript
// searcher-app/src/firebase/config.js
import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
// Persistent cache: link + zone docs read once stay readable if the app
// reloads while offline (spec §4 / §6 "phone dies mid-search").
export const db = initializeFirestore(app, { localCache: persistentLocalCache() });
```

- [ ] **Step 6: Create links.js**

```javascript
// searcher-app/src/firebase/links.js
import { doc, getDoc } from 'firebase/firestore';
import { db } from './config';

export async function resolveLink(token) {
  const snap = await getDoc(doc(db, 'searcherLinks', token));
  if (!snap.exists() || !snap.data().active) return null;
  const { searchId, dayId, zoneId, volunteerId } = snap.data();
  return { searchId, dayId, zoneId, volunteerId };
}
```

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): Firebase init with persistent cache, token parsing, link resolution"
```

---

### Task 4: Offline Queue (TDD)

**Files:**
- Create: `searcher-app/src/gps/offlineQueue.js`
- Create: `searcher-app/test/gps/offlineQueue.test.js`

**Interfaces:**
- Produces:
  - `enqueue(type: 'trackPoint' | 'marker' | 'status', payload: object): Promise<number>` — returns entry id
  - `pendingEntries(): Promise<Array<{ id, type, payload, synced: 0 }>>` — unsynced only, insertion order
  - `allEntries(): Promise<Array<entry>>` — synced + unsynced (path rendering after reload)
  - `markSynced(ids: number[]): Promise<void>`
  - `_resetForTests(): void` — clears the cached DB handle
- Entries are never deleted — synced ones are kept so the walked path survives reloads (spec §3/§6)
- Consumed by: Tasks 6, 7, 9

- [ ] **Step 1: Write failing tests**

```javascript
// searcher-app/test/gps/offlineQueue.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { enqueue, pendingEntries, allEntries, markSynced, _resetForTests } from '../../src/gps/offlineQueue.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh DB per test
  _resetForTests();
});

describe('offlineQueue', () => {
  it('enqueued entries appear as pending', async () => {
    await enqueue('trackPoint', { lat: 34.05, lng: -118.25, timestamp: 1 });
    const pending = await pendingEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('trackPoint');
    expect(pending[0].payload.lat).toBe(34.05);
  });

  it('markSynced removes entries from pending but keeps them in allEntries', async () => {
    const id1 = await enqueue('trackPoint', { lat: 1, lng: 2, timestamp: 1 });
    await enqueue('marker', { lat: 3, lng: 4, note: 'backpack' });
    await markSynced([id1]);

    expect(await pendingEntries()).toHaveLength(1);
    expect((await pendingEntries())[0].type).toBe('marker');
    expect(await allEntries()).toHaveLength(2);
  });

  it('preserves insertion order', async () => {
    await enqueue('trackPoint', { timestamp: 1 });
    await enqueue('trackPoint', { timestamp: 2 });
    await enqueue('trackPoint', { timestamp: 3 });
    const pending = await pendingEntries();
    expect(pending.map(e => e.payload.timestamp)).toEqual([1, 2, 3]);
  });

  it('markSynced ignores unknown ids', async () => {
    await enqueue('status', { status: 'searched' });
    await markSynced([9999]);
    expect(await pendingEntries()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement offlineQueue.js**

```javascript
// searcher-app/src/gps/offlineQueue.js
import { openDB } from 'idb';

let dbPromise;

function queueDb() {
  dbPromise ??= openDB('sar-searcher', 1, {
    upgrade(db) {
      const store = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      store.createIndex('synced', 'synced');
    },
  });
  return dbPromise;
}

export async function enqueue(type, payload) {
  const db = await queueDb();
  return db.add('queue', { type, payload, synced: 0, createdAt: Date.now() });
}

export async function pendingEntries() {
  const db = await queueDb();
  return db.getAllFromIndex('queue', 'synced', 0);
}

export async function allEntries() {
  const db = await queueDb();
  return db.getAll('queue');
}

export async function markSynced(ids) {
  const db = await queueDb();
  const tx = db.transaction('queue', 'readwrite');
  for (const id of ids) {
    const entry = await tx.store.get(id);
    if (entry) {
      entry.synced = 1;
      await tx.store.put(entry);
    }
  }
  await tx.done;
}

export function _resetForTests() {
  dbPromise = undefined;
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 9 tests pass (5 token + 4 queue).

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): IndexedDB offline queue (TDD)"
```

---

### Task 5: Tile Math (TDD) + Prefetch Runtime

**Files:**
- Create: `searcher-app/src/map/tileMath.js`
- Create: `searcher-app/test/map/tileMath.test.js`
- Create: `searcher-app/src/map/tilePrefetch.js`

**Interfaces:**
- Produces (pure, `tileMath.js`):
  - `lngLatToTile(lng: number, lat: number, z: number): { x, y, z }` — Web Mercator XYZ
  - `tilesForBbox(bbox: [minX, minY, maxX, maxY], zooms?: number[]): Array<{ x, y, z }>` (default zooms `[14, 15, 16, 17]`)
  - `tileUrlsFromTemplate(template: string, tiles): string[]` — fills `{z}/{x}/{y}` placeholders
- Produces (`tilePrefetch.js`): `prefetchZoneTiles(map: mapboxgl.Map, bbox): Promise<void>` — background-fetches every zone tile once so the service worker caches them (spec §4 Approach A)
- Consumed by: Task 8 (SearcherMap calls prefetch on load)

- [ ] **Step 1: Write failing tests**

```javascript
// searcher-app/test/map/tileMath.test.js
import { describe, it, expect } from 'vitest';
import { lngLatToTile, tilesForBbox, tileUrlsFromTemplate } from '../../src/map/tileMath.js';

describe('lngLatToTile', () => {
  it('maps the null island at z1 to tile 1,1', () => {
    expect(lngLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('maps the top-left of the world to tile 0,0', () => {
    expect(lngLatToTile(-180, 85.05, 2)).toEqual({ x: 0, y: 0, z: 2 });
  });

  it('x grows east, y grows south', () => {
    const west = lngLatToTile(-118.3, 34.05, 14);
    const east = lngLatToTile(-118.2, 34.05, 14);
    const north = lngLatToTile(-118.25, 34.10, 14);
    const south = lngLatToTile(-118.25, 34.00, 14);
    expect(east.x).toBeGreaterThan(west.x);
    expect(south.y).toBeGreaterThan(north.y);
  });
});

describe('tilesForBbox', () => {
  const BBOX = [-118.26, 34.04, -118.24, 34.06]; // ~2km urban zone

  it('returns tiles for every requested zoom', () => {
    const tiles = tilesForBbox(BBOX, [14, 15]);
    expect(tiles.some(t => t.z === 14)).toBe(true);
    expect(tiles.some(t => t.z === 15)).toBe(true);
  });

  it('covers all four bbox corners at each zoom', () => {
    const tiles = tilesForBbox(BBOX, [16]);
    const corners = [
      lngLatToTile(BBOX[0], BBOX[1], 16), lngLatToTile(BBOX[0], BBOX[3], 16),
      lngLatToTile(BBOX[2], BBOX[1], 16), lngLatToTile(BBOX[2], BBOX[3], 16),
    ];
    for (const c of corners) {
      expect(tiles.some(t => t.x === c.x && t.y === c.y && t.z === 16)).toBe(true);
    }
  });

  it('tile count roughly quadruples per zoom level', () => {
    const z15 = tilesForBbox(BBOX, [15]).length;
    const z17 = tilesForBbox(BBOX, [17]).length;
    expect(z17).toBeGreaterThan(z15 * 4);
  });
});

describe('tileUrlsFromTemplate', () => {
  it('substitutes z/x/y into the template', () => {
    const urls = tileUrlsFromTemplate(
      'https://api.mapbox.com/v4/composite/{z}/{x}/{y}.vector.pbf?access_token=T',
      [{ x: 2810, y: 6541, z: 14 }]
    );
    expect(urls).toEqual(['https://api.mapbox.com/v4/composite/14/2810/6541.vector.pbf?access_token=T']);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement tileMath.js**

```javascript
// searcher-app/src/map/tileMath.js

export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.floor(((lng + 180) / 360) * n));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  );
  return { x: Math.max(0, x), y: Math.max(0, y), z };
}

export function tilesForBbox([minX, minY, maxX, maxY], zooms = [14, 15, 16, 17]) {
  const tiles = [];
  for (const z of zooms) {
    const topLeft = lngLatToTile(minX, maxY, z);
    const bottomRight = lngLatToTile(maxX, minY, z);
    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      for (let y = topLeft.y; y <= bottomRight.y; y++) {
        tiles.push({ x, y, z });
      }
    }
  }
  return tiles;
}

export function tileUrlsFromTemplate(template, tiles) {
  return tiles.map(t =>
    template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y)
  );
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 16 tests pass.

- [ ] **Step 5: Implement tilePrefetch.js**

```javascript
// searcher-app/src/map/tilePrefetch.js
import mapboxgl from 'mapbox-gl';
import { tilesForBbox, tileUrlsFromTemplate } from './tileMath.js';

// Fetches every tile covering the zone bbox once, in small batches, while the
// device still has signal. The Workbox CacheFirst route caches the responses;
// offline, Mapbox GL requests tiles as usual and the SW serves them (spec §4).
export async function prefetchZoneTiles(map, bbox, zooms = [14, 15, 16, 17]) {
  const tiles = tilesForBbox(bbox, zooms);
  const sources = Object.values(map.getStyle().sources)
    .filter(s => s.type === 'vector' && s.url?.startsWith('mapbox://'));

  for (const source of sources) {
    const tilesetId = source.url.replace('mapbox://', '');
    try {
      const tileJson = await fetch(
        `https://api.mapbox.com/v4/${tilesetId}.json?secure&access_token=${mapboxgl.accessToken}`
      ).then(r => r.json());
      const template = tileJson.tiles?.[0];
      if (!template) continue;
      await fetchInBatches(tileUrlsFromTemplate(template, tiles));
    } catch {
      // No signal or Mapbox hiccup — tiles already viewed are still cached.
    }
  }
}

async function fetchInBatches(urls, batchSize = 10) {
  for (let i = 0; i < urls.length; i += batchSize) {
    await Promise.allSettled(urls.slice(i, i + batchSize).map(u => fetch(u)));
  }
}
```

(Glyph/sprite/style requests are cached by the same Workbox route as the map first renders. Labels at not-yet-visited zooms may miss offline — acceptable per spec's "brief gaps" target.)

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): zone tile math (TDD) and background tile prefetch"
```

---

### Task 6: Firestore Write Modules + Sync Loop

**Files:**
- Create: `searcher-app/src/firebase/zones.js`
- Create: `searcher-app/src/firebase/tracks.js`
- Create: `searcher-app/src/firebase/markers.js`
- Create: `searcher-app/src/gps/sync.js`

**Interfaces:**
- Produces (`zones.js`):
  - `getZone({ searchId, dayId, zoneId }): Promise<{ id, letter, number, status, assignedTo, polygon: GeoJSON.Geometry } | null>` — **polygon is JSON.parsed here**
  - `watchZone({ searchId, dayId, zoneId }, cb): () => void` — live status updates
  - `updateZoneStatus({ searchId, dayId, zoneId, status }): Promise<void>` — the app's only zone write (status field only, per rules)
- Produces (`tracks.js`): `appendTrackPoints({ searchId, dayId, volunteerId, points: Array<{lat, lng, timestamp}> }): Promise<void>`
- Produces (`markers.js`): `createMarker({ searchId, dayId, volunteerId, lat, lng, note }): Promise<void>`
- Produces (`sync.js`): `startSync(linkCtx: { searchId, dayId, zoneId, volunteerId }, intervalMs = 10000): () => void` — flushes the queue every 10 s (track points batched into one write), returns a stop function
- Consumed by: Task 9

- [ ] **Step 1: Create zones.js**

```javascript
// searcher-app/src/firebase/zones.js
import { doc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import { db } from './config';

const zoneDoc = ({ searchId, dayId, zoneId }) =>
  doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId);

function parseZone(snap) {
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    polygon: data.polygon ? JSON.parse(data.polygon) : null, // stored as JSON string
  };
}

export async function getZone(ref) {
  const snap = await getDoc(zoneDoc(ref));
  return snap.exists() ? parseZone(snap) : null;
}

export function watchZone(ref, cb) {
  return onSnapshot(zoneDoc(ref), snap => {
    if (snap.exists()) cb(parseZone(snap));
  });
}

export async function updateZoneStatus({ searchId, dayId, zoneId, status }) {
  await updateDoc(zoneDoc({ searchId, dayId, zoneId }), { status });
}
```

- [ ] **Step 2: Create tracks.js**

```javascript
// searcher-app/src/firebase/tracks.js
import { doc, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from './config';

export async function appendTrackPoints({ searchId, dayId, volunteerId, points }) {
  const ref = doc(db, 'searches', searchId, 'days', dayId, 'tracks', volunteerId);
  await setDoc(ref, { points: arrayUnion(...points) }, { merge: true });
}
```

- [ ] **Step 3: Create markers.js**

```javascript
// searcher-app/src/firebase/markers.js
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createMarker({ searchId, dayId, volunteerId, lat, lng, note }) {
  await addDoc(collection(db, 'searches', searchId, 'days', dayId, 'markers'), {
    volunteerId, lat, lng, note, createdAt: serverTimestamp(),
  });
}
```

- [ ] **Step 4: Create sync.js**

```javascript
// searcher-app/src/gps/sync.js
import { pendingEntries, markSynced } from './offlineQueue';
import { appendTrackPoints } from '../firebase/tracks';
import { createMarker } from '../firebase/markers';
import { updateZoneStatus } from '../firebase/zones';

// Entries that fail stay queued and retry on the next tick (spec §4).
export async function flushOnce(linkCtx) {
  const entries = await pendingEntries();
  if (!entries.length) return 0;
  const done = [];

  // All pending track points go up as ONE arrayUnion write.
  const trackEntries = entries.filter(e => e.type === 'trackPoint');
  if (trackEntries.length) {
    try {
      await appendTrackPoints({ ...linkCtx, points: trackEntries.map(e => e.payload) });
      done.push(...trackEntries.map(e => e.id));
    } catch { /* retry next tick */ }
  }

  for (const entry of entries.filter(e => e.type !== 'trackPoint')) {
    try {
      if (entry.type === 'marker') await createMarker({ ...linkCtx, ...entry.payload });
      else if (entry.type === 'status') await updateZoneStatus({ ...linkCtx, status: entry.payload.status });
      done.push(entry.id);
    } catch { /* retry next tick */ }
  }

  if (done.length) await markSynced(done);
  return done.length;
}

export function startSync(linkCtx, intervalMs = 10000) {
  flushOnce(linkCtx).catch(() => {});
  const id = setInterval(() => flushOnce(linkCtx).catch(() => {}), intervalMs);
  return () => clearInterval(id);
}
```

- [ ] **Step 5: Run tests (nothing broken) and commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm test
```
Expected: 16 tests pass. (`sync.js` is thin I/O over the queue primitives tested in Task 4; exercised in the Task 10 smoke test.)

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): Firestore write modules and 10s offline-safe sync loop"
```

---

### Task 7: GPS Tracking Hook

**Files:**
- Create: `searcher-app/src/gps/useGpsTracking.js`

**Interfaces:**
- Produces: `useGpsTracking(enabled: boolean): { position, points, error, retry }`
  - `position: { lat, lng, timestamp } | null` — latest fix
  - `points: Array<{ lat, lng, timestamp }>` — full path (IndexedDB history + live), for map rendering
  - `error: null | 'denied' | 'unavailable' | 'unsupported'`
  - `retry(): void` — re-requests permission after denial (spec §6)
- Every fix is enqueued as a `trackPoint` immediately; sync (Task 6) uploads
- Consumed by: Task 9

- [ ] **Step 1: Create useGpsTracking.js**

```javascript
// searcher-app/src/gps/useGpsTracking.js
import { useEffect, useState, useCallback } from 'react';
import { enqueue, allEntries } from './offlineQueue';

export function useGpsTracking(enabled) {
  const [position, setPosition] = useState(null);
  const [points, setPoints] = useState([]);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  // Reload the full path from IndexedDB once, so the line never resets
  // when the tab is reopened mid-search (spec §6).
  useEffect(() => {
    allEntries().then(entries => {
      const prior = entries.filter(e => e.type === 'trackPoint').map(e => e.payload);
      if (prior.length) setPoints(prev => [...prior, ...prev]);
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setError('unsupported');
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      pos => {
        setError(null);
        const point = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          timestamp: Date.now(),
        };
        setPosition(point);
        setPoints(prev => [...prev, point]);
        enqueue('trackPoint', point);
      },
      err => setError(err.code === 1 ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  return { position, points, error, retry };
}
```

- [ ] **Step 2: Run tests (nothing broken) and commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm test
```
Expected: 16 tests pass (browser-API hook — verified on a phone in Task 10, per spec §7).

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): GPS tracking hook with queue writes and permission retry"
```

---

### Task 8: SearcherMap Component

**Files:**
- Create: `searcher-app/src/map/SearcherMap.jsx`

**Interfaces:**
- Produces: `<SearcherMap zonePolygon points markers onMapTap />`
  - `zonePolygon: GeoJSON.Geometry` (already parsed) — zone boundary, map fits to it on load
  - `points: Array<{ lat, lng, timestamp }>` — renders path line + 20 m coverage buffer + current-position dot
  - `markers: Array<{ lat, lng, note }>` — dropped pins
  - `onMapTap(lngLat: { lng, lat }): void` — tap anywhere on the map (drives MarkerForm)
- Calls `prefetchZoneTiles` once after map load (Task 5)
- Consumed by: Task 9

- [ ] **Step 1: Create SearcherMap.jsx**

```jsx
// searcher-app/src/map/SearcherMap.jsx
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import { prefetchZoneTiles } from './tilePrefetch';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = turf.featureCollection([]);

export function SearcherMap({ zonePolygon, points = [], markers = [], onMapTap }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const onMapTapRef = useRef(onMapTap);
  useEffect(() => { onMapTapRef.current = onMapTap; }, [onMapTap]);

  useEffect(() => {
    const bbox = turf.bbox({ type: 'Feature', geometry: zonePolygon, properties: {} });
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      bounds: bbox,
      fitBoundsOptions: { padding: 40 },
    });

    map.on('load', () => {
      map.addSource('zone', { type: 'geojson', data: { type: 'Feature', geometry: zonePolygon, properties: {} } });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zone',
        paint: { 'line-color': '#1d4ed8', 'line-width': 3 } });

      map.addSource('coverage', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'coverage-fill', type: 'fill', source: 'coverage',
        paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.25 } });

      map.addSource('path', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'path-line', type: 'line', source: 'path',
        paint: { 'line-color': '#16a34a', 'line-width': 3 } });

      map.addSource('markers', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'markers-dots', type: 'circle', source: 'markers',
        paint: { 'circle-radius': 8, 'circle-color': '#ef4444', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

      map.addSource('position', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'position-dot', type: 'circle', source: 'position',
        paint: { 'circle-radius': 7, 'circle-color': '#1d4ed8', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });

      loadedRef.current = true;
      prefetchZoneTiles(map, bbox); // fire-and-forget: cache zone tiles while we have signal
    });

    map.on('click', e => onMapTapRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat }));

    mapRef.current = map;
    return () => { loadedRef.current = false; map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Path + coverage + current position
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (points.length >= 2) {
      const line = turf.lineString(points.map(p => [p.lng, p.lat]));
      map.getSource('path')?.setData(line);
      map.getSource('coverage')?.setData(turf.buffer(line, 0.02, { units: 'kilometers' }));
    }
    if (points.length >= 1) {
      const last = points[points.length - 1];
      map.getSource('position')?.setData(turf.point([last.lng, last.lat]));
    }
  }, [points]);

  // Markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    map.getSource('markers')?.setData(
      turf.featureCollection(markers.map(m => turf.point([m.lng, m.lat], { note: m.note })))
    );
  }, [markers]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
```

(Note: the `loadedRef` guard means points/markers arriving before `load` are skipped; the next state change after load re-renders them. The GPS interval makes that at most a few seconds — acceptable.)

- [ ] **Step 2: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): zone map with path, coverage shading, markers, tap-to-pin"
```

---

### Task 9: UI Components + App Wiring

**Files:**
- Create: `searcher-app/src/ui/StatusButton.jsx`
- Create: `searcher-app/src/ui/MarkerForm.jsx`
- Modify: `searcher-app/src/App.jsx` (replace the Task 1 placeholder entirely)

**Interfaces:**
- Produces: `<StatusButton status onComplete onReopen />` — `status` is the zone's live status; shows "Mark Zone Complete" unless `status === 'searched'`
- Produces: `<MarkerForm location onSave(note) onCancel />`
- Consumes: everything from Tasks 3–8

- [ ] **Step 1: Create StatusButton.jsx**

```jsx
// searcher-app/src/ui/StatusButton.jsx
export function StatusButton({ status, onComplete, onReopen }) {
  const complete = status === 'searched';
  return (
    <button
      onClick={complete ? onReopen : onComplete}
      style={{
        position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
        padding: 16, fontSize: 18, fontWeight: 700, borderRadius: 12,
        color: '#fff', background: complete ? '#6b7280' : '#22c55e',
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
      }}>
      {complete ? '✓ Zone Complete — tap to re-open' : 'Mark Zone Complete'}
    </button>
  );
}
```

- [ ] **Step 2: Create MarkerForm.jsx**

```jsx
// searcher-app/src/ui/MarkerForm.jsx
import { useState } from 'react';

export function MarkerForm({ location, onSave, onCancel }) {
  const [note, setNote] = useState('');
  return (
    <div style={{
      position: 'fixed', bottom: 88, left: 16, right: 16, zIndex: 10,
      background: '#fff', borderRadius: 12, padding: 16,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      <p style={{ marginBottom: 8, fontWeight: 600 }}>
        Drop a marker at {location.lat.toFixed(5)}, {location.lng.toFixed(5)}?
      </p>
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Note (e.g. backpack found)"
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => onSave(note)} style={{ flex: 1, background: '#ef4444' }}>Drop Marker</button>
        <button onClick={onCancel} style={{ flex: 1, background: '#6b7280' }}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace App.jsx**

```jsx
// searcher-app/src/App.jsx
import { useState, useEffect, useRef } from 'react';
import { parseToken } from './firebase/token';
import { resolveLink } from './firebase/links';
import { getZone, watchZone } from './firebase/zones';
import { enqueue } from './gps/offlineQueue';
import { startSync } from './gps/sync';
import { useGpsTracking } from './gps/useGpsTracking';
import { SearcherMap } from './map/SearcherMap';
import { StatusButton } from './ui/StatusButton';
import { MarkerForm } from './ui/MarkerForm';

function Message({ children }) {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <p style={{ fontSize: 17, color: '#374151' }}>{children}</p>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState('loading'); // loading | invalid | ready
  const [link, setLink] = useState(null);        // { searchId, dayId, zoneId, volunteerId }
  const [zone, setZone] = useState(null);
  const [pinLocation, setPinLocation] = useState(null);
  const [localMarkers, setLocalMarkers] = useState([]);
  const startedRef = useRef(false);

  const { points, error: gpsError, retry } = useGpsTracking(state === 'ready');

  // Resolve token → link → zone
  useEffect(() => {
    const token = parseToken(window.location.pathname);
    if (!token) { setState('invalid'); return; }
    (async () => {
      try {
        const resolved = await resolveLink(token);
        if (!resolved) { setState('invalid'); return; }
        const zoneDoc = await getZone(resolved);
        if (!zoneDoc?.polygon) { setState('invalid'); return; }
        setLink(resolved);
        setZone(zoneDoc);
        setState('ready');
      } catch {
        setState('invalid'); // offline first-open with nothing cached also lands here
      }
    })();
  }, []);

  // Live zone updates + sync loop + one-time "in progress" flip
  useEffect(() => {
    if (state !== 'ready' || !link) return;
    const stopWatch = watchZone(link, setZone);
    const stopSync = startSync(link);
    if (!startedRef.current) {
      startedRef.current = true;
      if (zone?.status === 'assigned') enqueue('status', { status: 'in_progress' });
    }
    return () => { stopWatch(); stopSync(); };
  }, [state, link]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === 'loading') return <Message>Loading your zone…</Message>;
  if (state === 'invalid') return <Message>This link is no longer active. Ask command for a new one via /available in the group.</Message>;

  function handleSaveMarker(note) {
    const marker = { lat: pinLocation.lat, lng: pinLocation.lng, note };
    enqueue('marker', marker);
    setLocalMarkers(prev => [...prev, marker]);
    setPinLocation(null);
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <SearcherMap
        zonePolygon={zone.polygon}
        points={points}
        markers={localMarkers}
        onMapTap={setPinLocation}
      />

      <div style={{
        position: 'fixed', top: 12, left: 12, right: 12, zIndex: 10,
        background: 'rgba(30,41,59,0.92)', color: '#f8fafc',
        borderRadius: 10, padding: '10px 14px', fontWeight: 700, textAlign: 'center',
      }}>
        Zone {zone.letter}{zone.number}
        {gpsError === 'denied' && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6 }}>
            GPS permission is required to track your search.{' '}
            <button onClick={retry} style={{ padding: '4px 10px', fontSize: 13 }}>Enable GPS</button>
          </div>
        )}
      </div>

      {pinLocation && (
        <MarkerForm
          location={pinLocation}
          onSave={handleSaveMarker}
          onCancel={() => setPinLocation(null)}
        />
      )}

      <StatusButton
        status={zone.status}
        onComplete={() => enqueue('status', { status: 'searched' })}
        onReopen={() => enqueue('status', { status: 'in_progress' })}
      />
    </div>
  );
}
```

- [ ] **Step 4: Desktop smoke test**

With the Command Center dev server also running and a search active (zones exist), create a test link doc by hand: Firebase console → `searcherLinks` collection → add doc with id `testtoken1234`, fields `searchId` (a real search id), `dayId: "day-1"`, `zoneId` (a real zone doc id), `volunteerId: "smoke-test"`, `active: true`.

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm run dev
```

Open `http://localhost:5174/s/testtoken1234` in a browser (allow location):
1. Zone boundary renders, map fitted to it, "Zone A1"-style header shows.
2. Blue position dot appears; after moving (or with devtools sensor location override), a green path + translucent coverage buffer draws.
3. Tap the map → MarkerForm → save → red dot appears; Firebase console shows the marker doc within ~10 s.
4. "Mark Zone Complete" → Command Center zone panel flips that zone to `searched` in real time; button changes to re-open state.
5. Open `http://localhost:5174/s/bogus` → "no longer active" message.
6. Set the link doc `active: false` → reload the real link → "no longer active".

- [ ] **Step 5: Run all tests**

```bash
npm test
```
Expected: 16 tests pass.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add searcher-app
git commit -m "feat(searcher): status button, marker form, app wiring — PWA feature-complete on desktop"
```

---

### Task 10: Build, Deploy, Phone Smoke Test

**Files:** none new — build + deploy + verification.

- [ ] **Step 1: Production build**

```bash
cd "C:\Users\Jack\dev\sar-command-track\searcher-app"
npm run build
```
Expected: `dist/` contains `sw.js` (or `workbox-*.js`) and `manifest.webmanifest` alongside the app bundle — confirms the PWA plugin ran.

- [ ] **Step 2: Deploy to the second hosting site**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
firebase deploy --only hosting:searcher
```
Expected: deploys to `https://sar-searcher.web.app` (or the actual site name from Task 2).

- [ ] **Step 3: Point the bot at the real URL**

Update `SEARCHER_APP_URL` to the deployed URL in `telegram-bot/.env` (local) and the Railway service variables (production, if Plan 2 is deployed). Restart the bot.

- [ ] **Step 4: Real-phone smoke test (spec §7)**

Full end-to-end on an actual phone:
1. In the test Telegram group: `/available A` → bot DMs a link → tap it → zone loads on the phone, GPS permission prompt → allow.
2. Walk around outside for a couple of minutes — path line and coverage shading grow; Command Center (on a laptop) shows the zone `in_progress`.
3. **Enable airplane mode.** Keep walking: map still pans/zooms within the zone (cached tiles), path keeps growing, drop a marker with a note — all works offline.
4. Disable airplane mode. Within ~10 s the queued points and the marker appear in the Firebase console (`tracks/{volunteerId}`, `markers`).
5. Kill the browser tab, reopen the same link — zone reloads, previous path still drawn (IndexedDB history).
6. Tap **Mark Zone Complete** → Command Center flips the zone to `searched` in real time.

- [ ] **Step 5: Update the handoff doc and commit**

Mark Plan 3 as built/deployed in `G:\My Drive\SAR\SAR-Command-Track-Handoff.md` (record the searcher site URL).

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add -A
git commit -m "feat(searcher): production deploy to second hosting site — Phase 3 complete"
```

---

## Spec Coverage

| Spec section | Covered |
|---|---|
| §1 Stack (React/Vite PWA, vite-plugin-pwa, Mapbox, no Auth, 2nd hosting site) | Tasks 1, 2 |
| §1 Repo structure `searcher-app/` | Tasks 1, 3–9 |
| §2 Token scheme + resolveLink, inactive link handling | Task 3, Task 9 (invalid state) |
| §2 Firestore rules (`searcherLinks`, status-only zone update) | Task 2 |
| §3 Streets style, zone-centered map, boundary highlight | Task 8 |
| §3 GPS watchPosition on mount, no manual start | Tasks 7, 9 |
| §3 Points → IndexedDB immediately, 10 s flush | Tasks 4, 6, 7 |
| §3 Path line from local + synced points (never jumps) | Tasks 4 (entries kept), 7 (history reload), 8 (render) |
| §3 Coverage shading (turf buffer) | Task 8 |
| §4 Tile prefetch of zone bbox, zooms 14–17, SW CacheFirst | Tasks 1 (Workbox route), 5 |
| §4 GPS/markers always queue-first, identical on/offline | Tasks 4, 6 |
| §4 App-shell precache | Task 1 (vite-plugin-pwa default precache) |
| §5 MarkerForm (tap-drop pin + note, offline queue) | Tasks 6, 9 |
| §5 StatusButton In Progress ↔ Zone Complete, CC sees live | Tasks 6, 9 |
| §6 Permission denied message + re-prompt | Tasks 7, 9 |
| §6 Invalid/inactive token message | Tasks 3, 9 |
| §6 Two volunteers same zone (both see zone, first Complete wins) | Follows from shared zone doc + watchZone (no extra code) |
| §6 Phone dies / tab closed → reopen resumes | Tasks 3 (persistent cache), 4 (entries kept), 7 (history reload) |
| §6 Reassignment mid-search (old token inactive) | Bot side (Plan 2 Task 8); app shows invalid-link message on reload |
| §7 Testing: TDD tileMath + offlineQueue; phone smoke test | Tasks 4, 5, 10 |

**Deferred:** Command Center display of live tracks/markers (Plan 4), multi-day track layers (Plan 4), wilderness-grade multi-hour offline (explicitly out of scope).
