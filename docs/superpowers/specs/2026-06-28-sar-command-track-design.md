# Design — SAR Command & Track

**Date:** 2026-06-28 · **Status: DESIGN — not built.**

---

## 0. Overview

A two-part web application for search and rescue operations:

1. **Command Center** — laptop/tablet web app for SAR coordinators to manage searches, assign zones, and monitor all searcher activity in real-time.
2. **Searcher PWA** — mobile-first Progressive Web App for volunteers, accessed via a personal link (no login), with offline GPS tracking.

Volunteers are coordinated via a **Telegram bot** that handles sign-up and zone assignment. The Telegram group invite link can be shared via WhatsApp, Signal, or any other channel.

---

## 1. Architecture

### Stack

| Layer | Technology |
|---|---|
| Command Center frontend | React (web, laptop/tablet) |
| Searcher frontend | React PWA (mobile, offline-capable) |
| Backend / real-time DB | Firebase (Firestore + Auth + Hosting) |
| Map | Mapbox GL JS (terrain layers, polygon drawing, offline tile caching) |
| Telegram bot | Telegraf (Node.js), deployed on Railway or Fly.io |

### Two apps, one backend

Both the Command Center and Searcher PWA read/write the same Firestore database. Firestore live listeners keep the command center map updating in real-time as searchers move. The Telegram bot is a lightweight Node.js server that handles messaging and writes volunteer/assignment data to Firestore.

---

## 2. Zone System

### Letter zones (command-defined)

The command center draws the outer search boundary on the Mapbox map, then draws large letter zones (A, B, C…) within it. Letter zones represent logical areas (e.g. "A = forest/north", "B = riverbank") and are stable for the life of the search.

### Numbered sub-zones (auto-generated)

Each letter zone is subdivided into numbered cells: A1, A2, A3… The number of cells scales dynamically with how many volunteers sign up for that letter. Sub-zones are terrain-aware: the algorithm uses Mapbox terrain data and local features to follow natural cut boundaries (ridgelines, roads, rivers) rather than slicing across them with straight lines.

**Dynamic resizing:** as volunteers claim a letter zone, its sub-zones are recalculated. Volunteers already assigned keep their zone ID; their polygon updates. The command center can **lock** a letter zone once the search begins to prevent further resizing.

### Zone assignment logic

When a volunteer indicates availability for multiple letters (e.g. `/available A B`), they are assigned **one zone** — whichever letter has the greatest need (fewest volunteers relative to zone size). There is no hard cap on volunteers in a letter once every letter has at least one searcher; assignment remains need-driven to ensure coverage and allow extra helpers when all zones are staffed.

If a volunteer replies after a letter is locked, the bot offers the closest available zone to their requested letters, favoring the same letter if just-assigned zones are available.

### Zone states

`Unassigned → Assigned → In Progress → Searched → Needs Re-search`

### Multi-day and manual re-search

A search spans one or more days. Each day resets zone assignments — the bot posts a fresh sign-up message and volunteers re-claim zones. The overall boundary and letter zones persist across days; only the numbered sub-zone assignments reset.

The command center can manually flag any zone as **Needs Re-search** at any time (mid-day or between days), returning it to the assignment pool. This also supports a full manual restart of any area.

---

## 3. Telegram Bot & Volunteer Sign-Up Flow

### One-time setup per volunteer

New volunteers send `/register [First Last]` to the bot when they first join the Telegram group. This stores their name and Telegram ID, enabling the bot to DM them. Registration persists across all future searches — volunteers only do this once.

The Telegram group invite link is a standard URL and can be shared via WhatsApp, Signal, SMS, or any channel. For users without Telegram, the command center also provides an alternative web signup page so they can register and receive their assigned zone link in the browser instead of via Telegram.


### Per-search / per-day sign-up

1. Command center creates a new search (or new day) in the app and publishes it.
2. Bot posts in the Telegram group:
   > 🔍 **Search: [Name] — Day [N]**
   > Available zones: **A** (forest/north), **B** (riverbank), **C** (open field)
   > Reply `/available A B` with the zones you can search. You'll be assigned one zone based on where coverage is needed most.
3. Volunteer replies `/available A B`.
4. Bot assigns them the most-needed sub-zone across their preferred letters (e.g. A3), then DMs them:
   > You're assigned **Zone A3**. Tap your map link: [link]
5. Volunteer taps the link → Searcher PWA opens pre-loaded with their zone. No login required.
6. Command center sees the volunteer appear as an active searcher in real-time.
7. As more volunteers sign up, sub-zones for each letter recalculate until the command center locks the zones.

### Reassignment

If a volunteer can no longer search, the command center can reassign their zone to another volunteer or return it to the unassigned pool.

---

## 4. Searcher App (Phone PWA)

### Access

Opened via a personal tokenized link (no login). The link encodes the volunteer's identity and assigned zone. Accessible from any mobile browser.

### Map view

- Assigned zone highlighted on Mapbox terrain map
- GPS tracking starts automatically on open — path draws on the map in real-time as the volunteer walks
- Coverage shading accumulates as they move, showing what's been searched and what remains within their zone

### Markers / points of interest

Volunteers can drop a pin at any point with a short note (e.g. "last known location clue", "fallen tree — impassable", "hazard"). Markers sync to the command center in real-time.

### Status

A single status button: **In Progress → Zone Complete**. Tapping Complete notifies the command center and marks the zone Searched.

### Offline capability

- App shell and assigned zone's map tiles are pre-cached when the link is first opened (while the volunteer likely still has signal)
- GPS track points queue in IndexedDB and flush to Firestore on reconnect (synced in batches every 10 seconds when online)
- Pins/markers follow the same queue-and-sync pattern
- The volunteer's map remains fully functional with no signal

---

## 5. Command Center

### Authentication

Login-protected via Firebase Auth (email/password). Command center staff only.

### Live map

- All active searchers visible with their GPS tracks and real-time positions
- Coverage shading per zone
- Status pills per zone: Unassigned / Assigned / In Progress / Complete / Needs Re-search
- Markers dropped by searchers appear on the map and in a sidebar feed with notes; can be flagged as significant

### Search setup

- Create a new search: name, date, optional description
- Draw outer boundary on Mapbox (or import KML/GeoJSON from Scribble Maps)
- Draw letter zones within the boundary
- Preview auto-generated sub-zones before publishing
- Publish → bot is notified and posts the sign-up message to the Telegram group

### Zone management

- Live volunteer count per letter zone
- Lock/unlock letter zones (locked zones stop resizing)
- Manually reassign volunteers, flag zones for re-search, add new letter zones mid-search

### Day management

- **New Day** button: clears all zone assignments, keeps boundary and letter zones, bot auto-posts a fresh sign-up message
- Previous days' GPS tracks and markers are retained and visible (togglable by day)

### Export

End-of-search report: full GPS tracks, coverage map, all markers with notes, volunteer activity timeline. Exportable as PDF and GeoJSON.

---

## 6. Data Model (Firestore)

```
volunteers/{volunteerId}
  name            string
  telegramId      string
  registeredAt    timestamp

searches/{searchId}
  name            string
  createdAt       timestamp
  boundary        GeoJSON polygon
  letterZones     GeoJSON FeatureCollection
  status          'setup' | 'active' | 'complete'

searches/{searchId}/days/{dayId}
  date            timestamp
  status          'active' | 'complete'

searches/{searchId}/days/{dayId}/zones/{zoneId}
  letter          string            — 'A', 'B', etc.
  number          int               — 1, 2, 3, etc.
  polygon         GeoJSON polygon
  status          'unassigned' | 'assigned' | 'in_progress' | 'searched' | 'needs_re_search'
  assignedTo      volunteerId | null
  lockedAt        timestamp | null

searches/{searchId}/days/{dayId}/tracks/{volunteerId}
  points          array of {lat, lng, timestamp}   — batched, appended

searches/{searchId}/days/{dayId}/markers/{markerId}
  volunteerId     string
  lat, lng        number
  note            string
  flagged         boolean
  createdAt       timestamp
```

---

## 7. Activation / Build Order

Each phase is independently deployable and testable:

1. **Firebase + auth** — project setup, Firestore schema, command center login
2. **Command center map + zone drawing** — Mapbox integration, outer boundary, letter zones, sub-zone generation
3. **Telegram bot** — `/register`, `/available`, zone assignment logic, DM with link
4. **Searcher PWA** — tokenized link, map view, GPS tracking, zone complete button
5. **Real-time sync** — live command center updates from searcher tracks + markers
6. **Offline support** — service worker, IndexedDB queue, tile pre-caching
7. **Day reset + multi-day** — day management, assignment reset, previous-day track layers
8. **Export** — PDF report, GeoJSON download

---

## 8. Open Decisions (resolve before build)

| Topic | Decision needed |
|---|---|
| Terrain-aware sub-zone algorithm | Use Mapbox Terrain RGB tiles + OpenStreetMap vector features (roads, rivers, ridgelines) as natural cut boundaries when subdividing, or simpler equal-area subdivision as a first pass? |
| Volunteer zone capacity | No hard cap once all letter zones have at least one searcher; assignment should remain need-driven and allow additional volunteers to fill gaps or support existing zones. |
| Bot conflict handling | If a volunteer replies after zones are locked, offer the closest available zone to their requested letter(s), preferring the same letter if just-assigned zones are available. |
| Map tile offline depth | How far offline should pre-caching go — just the assigned zone at street level, or a wider buffer? |
| Scribble Maps import | Yes — support KML/GeoJSON import from Scribble Maps for command center boundary drawing |
