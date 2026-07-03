# Design — Searcher PWA (Plan 3)

**Date:** 2026-07-02 · **Status: APPROVED 2026-07-03 — not built.** Implementation plan: `docs/superpowers/plans/2026-07-03-sar-phase-3-searcher-pwa.md`

Builds on `docs/superpowers/specs/2026-06-28-sar-command-track-design.md` (§4, §6, §8) and implements **Plan 3** referenced in `docs/superpowers/plans/2026-06-28-sar-phase-1-command-center.md`.

---

## 0. Overview

A mobile-first Progressive Web App for volunteer searchers. Opened via a personal tokenized link (no login) sent by the Telegram bot, it shows the volunteer's assigned zone, tracks their GPS path, lets them drop marker pins, and provides a single status button (In Progress → Zone Complete). It reads/writes the same Firestore database as the Command Center and Telegram bot.

Signal conditions are "mostly good, brief gaps" (parking garages, dense buildings, elevators) — not hours-long wilderness blackout. Offline support targets that use case specifically (see §4).

Out of scope: the Telegram bot itself (Plan 2), Command Center live-track display and export (Plan 4), true multi-hour offline capability for remote wilderness (potential future enhancement, not needed now).

---

## 1. Architecture

### Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite (PWA) |
| PWA / offline tooling | `vite-plugin-pwa` (Workbox-based service worker) |
| Map | Mapbox GL JS (same as Command Center) |
| Data access | Firebase client SDK (Firestore) — no Firebase Auth; identity comes from the link token instead |
| Hosting | Firebase Hosting, as a **second hosting site** in the same Firebase project (Command Center keeps its own site) |

### Repo structure

New top-level folder in the existing monorepo:

```
sar-command-track/
  command-center/          (existing, unchanged)
  telegram-bot/            (Plan 2, separate spec)
  searcher-app/            (new)
    package.json
    vite.config.js         — includes vite-plugin-pwa config
    src/
      main.jsx
      App.jsx               — resolves token from URL, loads zone, renders map + controls
      firebase/
        config.js           — Firebase client SDK init (same project, no auth)
        links.js            — resolveLink(token) → { searchId, dayId, zoneId, volunteerId }
        zones.js            — watchZone, updateZoneStatus
        tracks.js           — queueTrackPoint, flushQueuedPoints
        markers.js          — createMarker
      map/
        SearcherMap.jsx      — Mapbox GL, zone boundary, live path, coverage shading
        tilePrefetch.js      — pre-fetches zone-bbox tiles on load for offline caching
      gps/
        useGpsTracking.js    — watchPosition wrapper, writes to local queue
        offlineQueue.js      — IndexedDB queue for track points + markers, flushes every 10s
      ui/
        StatusButton.jsx     — In Progress / Zone Complete toggle
        MarkerForm.jsx        — drop-pin-with-note UI
    test/
      map/
        tilePrefetch.test.js
      gps/
        offlineQueue.test.js
```

---

## 2. Link / Token Scheme

New top-level Firestore collection:

```
searcherLinks/{token}
  searchId        string
  dayId           string
  zoneId          string
  volunteerId     string
  active          boolean
  createdAt       timestamp
```

- `token` is a short random opaque string (URL: `https://<searcher-app-host>/s/{token}`).
- Created by the Telegram bot (Admin SDK) at assignment time.
- On reassignment/release, the bot sets the old token's `active: false` and creates a new one for the new assignment — old links stop working immediately, no dangling access.
- The app's only job with the token is: look up this doc, then load the referenced zone. No other identity mechanism (no login, no passwords).

### Firestore rules change needed

```
match /searcherLinks/{token} {
  allow read: if true;   // app must resolve the token client-side
  allow write: if false; // only ever written by the bot via Admin SDK, which bypasses rules
}
```

Additionally, the existing rule for zone writes (`firestore.rules`, current phase-1 version) requires `request.auth != null`, which the Searcher PWA — by design — never has. The **status field update** (In Progress → Zone Complete) needs to be writable by unauthenticated clients, matching the trust model already used for `tracks` and `markers` (both already allow unauthenticated `create`/`update`). Updated rule:

```
match /days/{dayId}/zones/{zoneId} {
  allow read: if true;
  allow update: if request.auth != null || request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);
  allow create, delete: if request.auth != null;
}
```

This keeps zone *creation* (drawing new zones) staff-only, while letting the Searcher app flip only the `status` field without login — consistent with the existing open-trust model for a closed, trusted volunteer group.

---

## 3. Map, GPS & Coverage

- Map style: `mapbox://styles/mapbox/streets-v12` — matches the Command Center (also switched to Streets), since searches are mostly urban and street names/addresses/buildings matter more than terrain contours.
- On load, `SearcherMap` centers on the zone boundary (highlighted) using the zone's polygon from `searchId/days/dayId/zones/zoneId`.
- `useGpsTracking` starts `navigator.geolocation.watchPosition` immediately on mount (after permission grant) — no manual "start" action.
- Each GPS reading is pushed to `offlineQueue` (IndexedDB) immediately; a timer flushes the queue to `tracks/{volunteerId}.points` (array append) every 10 seconds when online.
- The walked path renders as a line on the map from all points seen so far (local queue + already-synced points combined, so the line never "jumps" on reconnect).
- Coverage shading: a buffered line (turf.js buffer around the path so far) rendered as a translucent fill, giving a visual sense of ground covered within the zone.

---

## 4. Offline Strategy

**Map tiles (Approach A — service worker tile caching, chosen over static-image and full-offline-package alternatives):**

1. On load, `tilePrefetch.js` computes the XYZ tile coordinates covering the zone's bounding box at the zoom levels the app will realistically use (e.g. 14–17).
2. It issues a `fetch()` for each tile URL once, while the device still has signal. This isn't visible to the user — no map panning trick, just background requests.
3. The service worker (configured via `vite-plugin-pwa`, Workbox `CacheFirst` runtime caching strategy matching Mapbox tile URL patterns) caches each response as it's fetched.
4. When offline, Mapbox GL JS requests tiles exactly as it always does — the service worker serves them from cache transparently. The map stays fully interactive (pan/zoom) with no special offline UI mode.

**GPS points & markers:**

- Both are written to an IndexedDB queue first, always — never directly to Firestore. This makes online and offline behavior identical from the app's point of view: writes always succeed locally and are eventually synced.
- A background interval (every 10s) attempts to flush the queue to Firestore; entries stay queued until the write succeeds, then are cleared.
- This also naturally covers the "phone dies / tab closed mid-search" case (§6): reopening the same link re-reads the zone and any not-yet-synced queue entries from IndexedDB and resumes.

**App shell:** standard Workbox precaching (via `vite-plugin-pwa`) caches the app's own JS/CSS/HTML on first load, so the app itself (not just the map) keeps working offline.

---

## 5. Markers & Status

- `MarkerForm`: tap-to-drop a pin, add a short text note, submit. Goes through the same offline queue as GPS points.
- `StatusButton`: single toggle, "In Progress" ↔ "Zone Complete". Writes directly to the zone doc's `status` field (via the queue, same offline-safe path). Command Center sees the change in real time via its existing `watchZones` listener — no separate notification path needed.

---

## 6. Error Handling

| Situation | Behavior |
|---|---|
| Location permission denied | Clear message explaining GPS is required, with a button to re-prompt for permission |
| Invalid or inactive token (expired/reassigned link) | Friendly "this link is no longer active" message — no zone data loads |
| Two volunteers on the same zone (edge case) | Both see the same map/zone; whichever taps "Zone Complete" first marks it done for both |
| Phone dies / tab closed mid-search | Reopening the same link re-resolves the token, reloads the zone, and resumes from whatever's still queued locally in IndexedDB |
| Reassignment mid-search | Old token set `active: false` by the bot; new link DMed to the volunteer per the Plan 2 spec |

---

## 7. Testing

Pure-logic pieces get the same TDD treatment as `subdivideZone` in Phase 1:
- `tilePrefetch.js` — given a zone polygon and zoom range, computes the correct set of XYZ tile coordinates (unit tested, no real network calls).
- `offlineQueue.js` — enqueue/flush/retry-on-failure logic (unit tested against a fake IndexedDB/fake Firestore write).

GPS tracking, real offline behavior, and PWA installability are not meaningfully unit-testable — verified via manual smoke test on an actual phone: open the link, walk around outside, enable airplane mode mid-walk, confirm the map and path keep working, drop a pin, disable airplane mode and confirm the queued pin/points sync, mark the zone complete.

---

## 8. Open Decisions Resolved

| Topic | Decision |
|---|---|
| Offline map tile strategy | Service worker caching of individually pre-fetched zone-bbox tiles (Approach A), not static images or a full offline-map-package pipeline |
| Map tile offline depth | Just the assigned zone's bounding box, at the zoom levels the app actually uses (14–17) — not a wider buffer |
| Hosting | Second Firebase Hosting site in the same project, separate from Command Center |
| Identity | Token-based (via `searcherLinks` collection), no Firebase Auth |
| Firestore rules | Zone `status` field updatable without auth (matches existing trust model for tracks/markers); zone create/delete remains staff-only |
| Map style | Streets (`streets-v12`), not Outdoors/terrain — searches are mostly urban. Command Center updated to match (was `outdoors-v12`, now `streets-v12`) |
