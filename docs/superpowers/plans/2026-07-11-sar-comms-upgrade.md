# Comms Upgrade — Per-Search Telegram Groups + Web Zone Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-search dedicated Telegram groups (bound via `/bind`), a rich map-image announcement in the permanent hub group, and a tap-to-claim web zone picker at `sar-searcher.web.app/pick/{searchId}` — all funneling into the bot's existing `pickZone`/`assignZone` assignment logic so there's exactly one place that decides who gets which zone.

**Architecture:** Extends the already-built `telegram-bot/` (Telegraf, Firebase Admin SDK, long polling) and `searcher-app/` (React PWA) without touching `command-center/` — its Plan 5 dashboard already has copy-link buttons wired to the fields this plan writes (`search.inviteLink`, `search.groupChatId`). New Firestore collection `zoneRequests` is the bridge between the web picker and the bot's assignment code.

**Tech Stack:** Node.js + Telegraf + firebase-admin (bot), React 19 + Vite + Firebase client SDK (searcher-app), `@turf/turf` (new bot dependency, centroid + simplify), Vitest for all tests.

## Global Constraints

- Node ≥ 20, npm ≥ 10 (existing convention, both apps).
- `DAY_ID = 'day-1'` is fixed everywhere until Plan 4 (multi-day) lands — do not parameterize it in this plan.
- The bot's *only* code path that writes a zone document's `status`/`assignedTo` is `telegram-bot/src/firebase/zones.js`'s `assignZone()` — this plan's new `zoneRequestWatcher.js` must call it, never write a zone doc directly.
- GeoJSON geometry stored on Firestore documents (`searches.letterZones[].geometry`, zone `polygon`) is stored as a **JSON string**, not a raw object — always `JSON.parse` on read, `JSON.stringify` on write. Confirmed in `command-center/src/firebase/searches.js` and `searcher-app/src/firebase/zones.js`.
- React: functional components + hooks only, inline styles (no CSS framework) — matches every existing component in both apps.
- All new Vitest tests use `describe`/`it`/`expect` and live under each app's own `test/` folder, mirroring its `src/` structure.
- Firestore-touching modules (anything importing `db` from `firebase/config.js`) are **not** unit tested in this codebase — every existing `firebase/*.js` file in both apps is untested except pure-logic ones (`tokens.js`, `token.js`). Only pure-logic modules (parsers, URL builders, id generators) get Vitest coverage; Firestore/Telegram-touching code is verified in the final manual smoke test. Follow this convention — do not invent new test infrastructure (e.g. Firestore emulator) for this plan.

**One manual prerequisite, not a task below (do this before Task 15's smoke test):** `command-center/.env`'s `VITE_SEARCHER_APP_URL` is currently empty — set it to `https://sar-searcher.web.app` (or `http://localhost:5174` for local dev) so the dashboard's "Copy Picker Link" button produces a working URL. This is a pre-existing gap, not something this plan's code touches.

---

### Task 1: Firestore Rules — `zoneRequests` Collection

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: a `zoneRequests` collection where anyone can read/create, only the bot (Admin SDK, bypasses rules) can update.
- Consumed by: Task 7 (bot watcher writes), Task 13 (searcher-app reads/creates).

- [ ] **Step 1: Add the rule block**

Open `firestore.rules`. Add this block as a new top-level `match`, alongside the existing `volunteers` and `searcherLinks` blocks (not nested under `searches`):

```
    match /zoneRequests/{requestId} {
      allow read: if true;    // the picker page polls its own request doc
      allow create: if true;  // open trust model, same as tracks/markers today
      allow update: if false; // only the bot (Admin SDK, bypasses rules) resolves a request
    }
```

The full file should now read:

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
    match /zoneRequests/{requestId} {
      allow read: if true;    // the picker page polls its own request doc
      allow create: if true;  // open trust model, same as tracks/markers today
      allow update: if false; // only the bot (Admin SDK, bypasses rules) resolves a request
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

- [ ] **Step 2: Deploy the rule**

Run: `firebase deploy --only firestore:rules`
Expected: `✔ Deploy complete!` — if this fails with an auth error, run `firebase login` first.

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat: firestore rule for zoneRequests collection"
```

---

### Task 2: Generalize Volunteer Identity (Bot)

**Files:**
- Modify: `telegram-bot/src/firebase/volunteers.js`
- Modify: `telegram-bot/src/commands/register.js`

**Interfaces:**
- Produces: `saveVolunteer({ id: string, name: string, telegramId?: string|null }): Promise<void>` (was `saveVolunteer({ telegramId, name })`)
- Consumed by: Task 7's `zoneRequestWatcher.js` (web volunteers, no Telegram id)

- [ ] **Step 1: Generalize `saveVolunteer`**

Replace the contents of `telegram-bot/src/firebase/volunteers.js`:

```javascript
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function getVolunteer(id) {
  const snap = await db.doc(`volunteers/${id}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function saveVolunteer({ id, name, telegramId = null }) {
  await db.doc(`volunteers/${id}`).set({
    name,
    telegramId,
    registeredAt: FieldValue.serverTimestamp(),
  });
}
```

- [ ] **Step 2: Update the one call site**

In `telegram-bot/src/commands/register.js`, find:

```javascript
    await saveVolunteer({ telegramId, name });
```

Replace with:

```javascript
    await saveVolunteer({ id: telegramId, name, telegramId });
```

- [ ] **Step 3: Run the existing test suite to confirm nothing broke**

Run: `cd telegram-bot && npm test`
Expected: all existing tests pass (this change has no dedicated new test — `volunteers.js` is Firestore-touching and untested per convention; `register.test.js` only covers `parseRegisterName`, unaffected).

- [ ] **Step 4: Commit**

```bash
git add telegram-bot/src/firebase/volunteers.js telegram-bot/src/commands/register.js
git commit -m "feat(bot): generalize saveVolunteer to accept any volunteer id"
```

---

### Task 3: `/bind` Command

**Files:**
- Modify: `telegram-bot/src/firebase/searches.js`
- Create: `telegram-bot/src/commands/bind.js`
- Create: `telegram-bot/test/commands/bind.test.js`
- Modify: `telegram-bot/src/index.js`

**Interfaces:**
- Produces: `fetchBindableSearches(): Promise<Search[]>`, `bindGroup(searchId, { groupChatId, inviteLink }): Promise<void>` in `firebase/searches.js`
- Produces: `parseBindArgs(text: string): { code: string|null }`, `bindHandler(): (ctx) => Promise<void>` in `commands/bind.js`
- Consumes: `pickSearch` from `search/resolveSearch.js` (existing, unchanged)

- [ ] **Step 1: Add search-binding helpers**

Append to `telegram-bot/src/firebase/searches.js` (keep the existing `fetchActiveSearches`/`markAnnounced`):

```javascript
export async function fetchBindableSearches() {
  const snap = await db.collection('searches').where('status', 'in', ['setup', 'active']).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function bindGroup(searchId, { groupChatId, inviteLink }) {
  await db.doc(`searches/${searchId}`).update({ groupChatId, inviteLink, inviteLinkRevoked: false });
}
```

- [ ] **Step 2: Write the failing test for `parseBindArgs`**

Create `telegram-bot/test/commands/bind.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { parseBindArgs } from '../../src/commands/bind.js';

describe('parseBindArgs', () => {
  it('extracts and uppercases the code', () => {
    expect(parseBindArgs('/bind x7k2')).toEqual({ code: 'X7K2' });
  });

  it('handles the @botname group form', () => {
    expect(parseBindArgs('/bind@SarTrackBot x7k2')).toEqual({ code: 'X7K2' });
  });

  it('returns null code when none given', () => {
    expect(parseBindArgs('/bind')).toEqual({ code: null });
    expect(parseBindArgs('/bind   ')).toEqual({ code: null });
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd telegram-bot && npx vitest run test/commands/bind.test.js`
Expected: FAIL with "Cannot find module '../../src/commands/bind.js'"

- [ ] **Step 4: Implement `bind.js`**

Create `telegram-bot/src/commands/bind.js`:

```javascript
export function parseBindArgs(text) {
  const tokens = text.replace(/^\/bind(@\w+)?/i, '').trim().split(/\s+/).filter(Boolean);
  return { code: tokens[0]?.toUpperCase() ?? null };
}

export function bindHandler() {
  return async ctx => {
    const { fetchBindableSearches, bindGroup } = await import('../firebase/searches.js');
    const { pickSearch } = await import('../search/resolveSearch.js');

    const { code } = parseBindArgs(ctx.message.text);
    const bindable = await fetchBindableSearches();
    const picked = pickSearch(bindable, code);

    if (picked.error === 'no_active_search') {
      await ctx.reply('No search is ready to bind right now — create one in the Command Center first.');
      return;
    }
    if (picked.error === 'code_required' || picked.error === 'invalid_code') {
      const list = bindable.map(s => `${s.code} — ${s.name}`).join('\n');
      await ctx.reply(
        `${picked.error === 'invalid_code' ? "I don't recognize that code. " : ''}` +
        `More than one search is bindable — include the code:\n${list}\ne.g. /bind ${bindable[0].code}`
      );
      return;
    }

    const search = picked.search;
    let inviteLink;
    try {
      const result = await ctx.telegram.createChatInviteLink(ctx.chat.id, { name: search.name });
      inviteLink = result.invite_link;
    } catch {
      await ctx.reply('I need to be a group admin with "Invite Users via Link" permission before I can bind this group. Promote me, then send /bind again.');
      return;
    }

    await bindGroup(search.id, { groupChatId: String(ctx.chat.id), inviteLink });
    await ctx.reply(`Bound to **${search.name}**. Sign-ups happen here from now on.`, { parse_mode: 'Markdown' });
  };
}
```

- [ ] **Step 5: Run to confirm the test passes**

Run: `cd telegram-bot && npx vitest run test/commands/bind.test.js`
Expected: 3 tests pass.

- [ ] **Step 6: Register the command in `index.js`**

In `telegram-bot/src/index.js`, add the import near the top:

```javascript
import { bindHandler } from './commands/bind.js';
```

And register it alongside the other commands:

```javascript
bot.command('bind', bindHandler());
```

(Place this line directly after `bot.command('available', availableHandler());`.)

- [ ] **Step 7: Verify index.js still parses**

Run: `cd telegram-bot && node --check src/index.js`
Expected: no output (syntax OK). This does not require live credentials.

- [ ] **Step 8: Commit**

```bash
git add telegram-bot/src/firebase/searches.js telegram-bot/src/commands/bind.js telegram-bot/test/commands/bind.test.js telegram-bot/src/index.js
git commit -m "feat(bot): /bind command — binds a Telegram group to a search"
```

---

### Task 4: `mapImage.js` — Mapbox Static Images URL Builder (TDD)

**Files:**
- Create: `telegram-bot/src/mapImage.js`
- Create: `telegram-bot/test/mapImage.test.js`
- Modify: `telegram-bot/package.json`

**Interfaces:**
- Produces: `buildZoneMapUrl(search: { letterZones: Array<{letter, geometry}> }): string`
- Consumed by: Task 6's `searchWatcher.js`

- [ ] **Step 1: Add the `@turf/turf` dependency**

Run: `cd telegram-bot && npm install @turf/turf@^6.5.0`
Expected: `package.json`'s `dependencies` now includes `"@turf/turf": "^6.5.0"` and `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `telegram-bot/test/mapImage.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@turf/turf', async () => {
  const actual = await vi.importActual('@turf/turf');
  return { ...actual, simplify: vi.fn(f => f) };
});

import * as turf from '@turf/turf';
import { buildZoneMapUrl } from '../src/mapImage.js';

process.env.MAPBOX_TOKEN = 'TEST_TOKEN';

function triangle(cx, cy) {
  return { type: 'Polygon', coordinates: [[[cx, cy], [cx + 0.01, cy], [cx, cy + 0.01], [cx, cy]]] };
}

// A polygon with thousands of close-together vertices — guaranteed to blow
// the ~8192-char Mapbox URL cap however it's built, regardless of exact
// real-world turf.simplify behavior (which we mock below for determinism).
function hugeCircle() {
  return {
    type: 'Polygon',
    coordinates: [Array.from({ length: 2000 }, (_, i) => {
      const angle = (i / 2000) * 2 * Math.PI;
      return [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
    })],
  };
}

const SEARCH_SMALL = {
  letterZones: [
    { letter: 'A', geometry: triangle(-118.25, 34.05) },
    { letter: 'B', geometry: triangle(-118.20, 34.05) },
  ],
};

beforeEach(() => { turf.simplify.mockClear(); });

describe('buildZoneMapUrl', () => {
  it('includes a labeled pin per letter zone', () => {
    const url = buildZoneMapUrl(SEARCH_SMALL);
    expect(url).toContain('pin-l-a+3b82f6');
    expect(url).toContain('pin-l-b+3b82f6');
  });

  it('includes the access token and boundary overlay for small geometry, without simplifying', () => {
    const url = buildZoneMapUrl(SEARCH_SMALL);
    expect(url).toContain('access_token=TEST_TOKEN');
    expect(url).toContain('geojson(');
    expect(turf.simplify).not.toHaveBeenCalled();
  });

  it('parses letterZones geometry stored as a JSON string', () => {
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: JSON.stringify(triangle(-118.25, 34.05)) }] });
    expect(url).toContain('pin-l-a+3b82f6');
  });

  it('falls back to simplified geometry when the raw URL is too long, keeping the overlay', () => {
    turf.simplify.mockImplementation(() => ({ geometry: triangle(-118.25, 34.05) }));
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: hugeCircle() }] });
    expect(turf.simplify).toHaveBeenCalledTimes(1);
    expect(url).toContain('geojson(');
    expect(url.length).toBeLessThanOrEqual(7000);
  });

  it('drops the overlay to pins-only when even simplified geometry is still too long', () => {
    turf.simplify.mockImplementation(f => f); // no-op: "simplification" doesn't help here
    const url = buildZoneMapUrl({ letterZones: [{ letter: 'A', geometry: hugeCircle() }] });
    expect(url).not.toContain('geojson(');
    expect(url).toContain('pin-l-a+3b82f6');
    expect(url).toContain('access_token=TEST_TOKEN');
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd telegram-bot && npx vitest run test/mapImage.test.js`
Expected: FAIL with "Cannot find module '../src/mapImage.js'"

- [ ] **Step 4: Implement `mapImage.js`**

Create `telegram-bot/src/mapImage.js`:

```javascript
import * as turf from '@turf/turf';

const MARKER_COLOR = '3b82f6';
const SAFE_URL_LENGTH = 7000; // Mapbox Static Images API GET requests cap at ~8192 chars
const SIMPLIFY_OPTIONS = { tolerance: 0.001, highQuality: false };

function markersParam(letterZones) {
  return letterZones
    .map(z => {
      const [lng, lat] = turf.centroid(turf.feature(z.geometry)).geometry.coordinates;
      return `pin-l-${z.letter.toLowerCase()}+${MARKER_COLOR}(${lng.toFixed(5)},${lat.toFixed(5)})`;
    })
    .join(',');
}

function overlayParam(letterZones) {
  const fc = turf.featureCollection(letterZones.map(z => turf.feature(z.geometry)));
  return `geojson(${encodeURIComponent(JSON.stringify(fc))})`;
}

function buildUrl(letterZones, includeOverlay) {
  const markers = markersParam(letterZones);
  const overlay = includeOverlay ? `,${overlayParam(letterZones)}` : '';
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${markers}${overlay}/auto/800x600@2x?access_token=${process.env.MAPBOX_TOKEN}`;
}

function parsedLetterZones(search) {
  return search.letterZones.map(z => ({
    letter: z.letter,
    geometry: typeof z.geometry === 'string' ? JSON.parse(z.geometry) : z.geometry,
  }));
}

// Builds a Mapbox Static Images API URL showing each letter zone as a labeled
// pin plus its boundary outline (not the numbered sub-zones — spec §4, the
// announcement orients volunteers to coarse letter areas only). Falls back to
// simplified geometry, then to pins-only, if the URL would exceed Mapbox's cap.
export function buildZoneMapUrl(search) {
  const letterZones = parsedLetterZones(search);

  let url = buildUrl(letterZones, true);
  if (url.length <= SAFE_URL_LENGTH) return url;

  const simplified = letterZones.map(z => ({
    letter: z.letter,
    geometry: turf.simplify(turf.feature(z.geometry), SIMPLIFY_OPTIONS).geometry,
  }));
  url = buildUrl(simplified, true);
  if (url.length <= SAFE_URL_LENGTH) return url;

  return buildUrl(letterZones, false);
}
```

- [ ] **Step 5: Run to confirm the tests pass**

Run: `cd telegram-bot && npx vitest run test/mapImage.test.js`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add telegram-bot/package.json telegram-bot/package-lock.json telegram-bot/src/mapImage.js telegram-bot/test/mapImage.test.js
git commit -m "feat(bot): Mapbox Static Images URL builder for zone announcements (TDD)"
```

---

### Task 5: `announcementCaption` Message (TDD)

**Files:**
- Modify: `telegram-bot/src/messages.js`
- Modify: `telegram-bot/test/messages.test.js`

**Interfaces:**
- Produces: `announcementCaption(search: {name}, inviteLink: string, pickerUrl: string): string`
- Consumed by: Task 6's `searchWatcher.js`

- [ ] **Step 1: Write the failing test**

In `telegram-bot/test/messages.test.js`, change the top import line from:

```javascript
import { signupMessage, reSearchMessage } from '../src/messages.js';
```

to:

```javascript
import { signupMessage, reSearchMessage, announcementCaption } from '../src/messages.js';
```

Then append this new `describe` block at the end of the file:

```javascript
describe('announcementCaption', () => {
  it('names the search and includes both links', () => {
    const msg = announcementCaption(
      { name: 'Main St Search' },
      'https://t.me/+abc123',
      'https://sar-searcher.web.app/pick/s1'
    );
    expect(msg).toContain('Main St Search');
    expect(msg).toContain('https://t.me/+abc123');
    expect(msg).toContain('https://sar-searcher.web.app/pick/s1');
  });
});
```

(The existing `import { signupMessage, reSearchMessage } from '../src/messages.js';` at the top of the file stays — add the new named import alongside it, or as a second import line as shown above.)

- [ ] **Step 2: Run to confirm it fails**

Run: `cd telegram-bot && npx vitest run test/messages.test.js`
Expected: FAIL — `announcementCaption is not a function` (or similar).

- [ ] **Step 3: Implement it**

Append to `telegram-bot/src/messages.js`:

```javascript
export function announcementCaption(search, inviteLink, pickerUrl) {
  return [
    `🔍 Search: ${search.name}`,
    `Join the dedicated group to sign up: ${inviteLink}`,
    `Or tap a zone on the map: ${pickerUrl}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd telegram-bot && npx vitest run test/messages.test.js`
Expected: all tests pass (existing `signupMessage`/`reSearchMessage` tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add telegram-bot/src/messages.js telegram-bot/test/messages.test.js
git commit -m "feat(bot): announcementCaption message for bound-group announcements (TDD)"
```

---

### Task 6: `searchWatcher.js` — Map-Image Announcement Branch

**Files:**
- Modify: `telegram-bot/src/watchers/searchWatcher.js`
- Modify: `telegram-bot/src/index.js`
- Modify: `telegram-bot/.env.example`

**Interfaces:**
- Consumes: `buildZoneMapUrl` (Task 4), `announcementCaption` (Task 5)

- [ ] **Step 1: Add the branch to `searchWatcher.js`**

Replace the full contents of `telegram-bot/src/watchers/searchWatcher.js`:

```javascript
import { DAY_ID } from '../constants.js';
import { signupMessage, announcementCaption } from '../messages.js';
import { buildZoneMapUrl } from '../mapImage.js';

export function watchSearches(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { fetchZones } = await import('../firebase/zones.js');
    const { markAnnounced } = await import('../firebase/searches.js');

    unsubscribe = db.collection('searches')
      .where('status', '==', 'active')
      .onSnapshot(async snap => {
        const activeCount = snap.size;
        for (const change of snap.docChanges()) {
          if (change.type === 'removed') continue;
          const search = { id: change.doc.id, ...change.doc.data() };
          if (search.announcedAt) continue; // already announced (incl. before a restart)

          await markAnnounced(search.id); // claim first so a crash can't double-post
          const zones = await fetchZones(search.id, DAY_ID);
          const letters = [...new Set(zones.map(z => z.letter))].sort();

          if (search.groupChatId && search.inviteLink) {
            const pickerUrl = `${process.env.SEARCHER_APP_URL}/pick/${search.id}`;
            const caption = announcementCaption(search, search.inviteLink, pickerUrl);
            try {
              await bot.telegram.sendPhoto(
                process.env.TELEGRAM_GROUP_CHAT_ID,
                buildZoneMapUrl(search),
                { caption }
              );
            } catch {
              // Mapbox hiccup or a too-long URL that still slipped through — never
              // leave volunteers without a way to sign up (spec §6).
              await bot.telegram.sendMessage(process.env.TELEGRAM_GROUP_CHAT_ID, caption);
            }
          } else {
            await bot.telegram.sendMessage(
              process.env.TELEGRAM_GROUP_CHAT_ID,
              signupMessage(search, letters, activeCount > 1)
            );
          }
        }
      }, err => console.error('searchWatcher error:', err));
  })();
  return () => unsubscribe();
}
```

- [ ] **Step 2: Require `MAPBOX_TOKEN` at startup**

In `telegram-bot/src/index.js`, find:

```javascript
for (const key of ['TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'SEARCHER_APP_URL']) {
```

Replace with:

```javascript
for (const key of ['TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'SEARCHER_APP_URL', 'MAPBOX_TOKEN']) {
```

- [ ] **Step 3: Add `MAPBOX_TOKEN` to the env example**

Append a line to `telegram-bot/.env.example`:

```
MAPBOX_TOKEN=
```

- [ ] **Step 4: Set the real value on your machine**

In `telegram-bot/.env` (not committed), add `MAPBOX_TOKEN=` followed by the same public token value already in `command-center/.env` or `searcher-app/.env`'s `VITE_MAPBOX_TOKEN` — it's a public client token, safe to reuse, just without the `VITE_` prefix since that prefix is meaningless outside Vite.

- [ ] **Step 5: Verify index.js still parses and existing tests pass**

Run: `cd telegram-bot && node --check src/index.js && npm test`
Expected: no syntax error, all existing tests pass (no new tests for this task — `searchWatcher.js` is Telegram/Firestore-touching and untested per convention, verified in Task 15's smoke test).

- [ ] **Step 6: Commit**

```bash
git add telegram-bot/src/watchers/searchWatcher.js telegram-bot/src/index.js telegram-bot/.env.example
git commit -m "feat(bot): send map-image announcement to hub when a search is bound to a group"
```

---

### Task 7: Web Zone Request Watcher

**Files:**
- Create: `telegram-bot/src/firebase/zoneRequests.js`
- Create: `telegram-bot/src/watchers/zoneRequestWatcher.js`
- Modify: `telegram-bot/src/index.js`

**Interfaces:**
- Produces: `resolveRequest(requestId: string, updates: object): Promise<void>`
- Produces: `watchZoneRequests(): () => void`
- Consumes: `saveVolunteer` (Task 2), `fetchZones`/`assignZone` (existing), `createSearcherLink` (existing), `pickZone` (existing)

- [ ] **Step 1: Create the narrow write helper**

Create `telegram-bot/src/firebase/zoneRequests.js`:

```javascript
import { db } from './config.js';

// The single write path for resolving a web zone-request — mirrors zones.js's
// assignZone in being the bot's ONLY writer of this collection (Firestore
// rules deny client writes to anything but create; spec §2).
export async function resolveRequest(requestId, updates) {
  await db.doc(`zoneRequests/${requestId}`).update(updates);
}
```

- [ ] **Step 2: Create the watcher**

Create `telegram-bot/src/watchers/zoneRequestWatcher.js`:

```javascript
import { DAY_ID } from '../constants.js';

// The single assignment authority for web-originated requests. Deliberately
// calls the exact same helpers available.js calls, so a letter can't be
// double-assigned by the two channels running different logic (spec §5).
export function watchZoneRequests() {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { saveVolunteer } = await import('../firebase/volunteers.js');
    const { fetchZones, assignZone } = await import('../firebase/zones.js');
    const { createSearcherLink } = await import('../firebase/links.js');
    const { pickZone } = await import('../assignment/assign.js');
    const { resolveRequest } = await import('../firebase/zoneRequests.js');

    unsubscribe = db.collection('zoneRequests')
      .where('status', '==', 'pending')
      .onSnapshot(async snap => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const req = { id: change.doc.id, ...change.doc.data() };

          await saveVolunteer({ id: req.webVolunteerId, name: req.name });
          const zones = await fetchZones(req.searchId, DAY_ID);
          const zone = pickZone(zones, [req.letter]);
          if (!zone) {
            await resolveRequest(req.id, { status: 'no_availability' });
            continue;
          }
          const token = await createSearcherLink({
            searchId: req.searchId, dayId: DAY_ID, zoneId: zone.id, volunteerId: req.webVolunteerId,
          });
          await assignZone(req.searchId, DAY_ID, zone.id, { status: 'assigned', assignedTo: req.webVolunteerId });
          await resolveRequest(req.id, { status: 'assigned', zoneId: zone.id, token });
        }
      }, err => console.error('zoneRequestWatcher error:', err));
  })();
  return () => unsubscribe();
}
```

- [ ] **Step 3: Register it in `index.js`**

In `telegram-bot/src/index.js`, add the import:

```javascript
import { watchZoneRequests } from './watchers/zoneRequestWatcher.js';
```

And start it alongside the other watchers:

```javascript
  watchSearches(bot);
  watchZoneChanges(bot);
  watchZoneRequests();
```

- [ ] **Step 4: Verify index.js still parses and existing tests pass**

Run: `cd telegram-bot && node --check src/index.js && npm test`
Expected: no syntax error, all existing tests pass (no new tests — Firestore/watcher code, verified in Task 15).

- [ ] **Step 5: Commit**

```bash
git add telegram-bot/src/firebase/zoneRequests.js telegram-bot/src/watchers/zoneRequestWatcher.js telegram-bot/src/index.js
git commit -m "feat(bot): zoneRequestWatcher — sole assignment authority for web picker taps"
```

---

### Task 8: Invite Link Revocation on Completion

**Files:**
- Modify: `telegram-bot/src/firebase/searches.js`
- Create: `telegram-bot/src/watchers/completionWatcher.js`
- Modify: `telegram-bot/src/index.js`

**Interfaces:**
- Produces: `markInviteRevoked(searchId: string): Promise<void>`
- Produces: `watchSearchCompletion(bot): () => void`

- [ ] **Step 1: Add `markInviteRevoked`**

Append to `telegram-bot/src/firebase/searches.js`:

```javascript
export async function markInviteRevoked(searchId) {
  await db.doc(`searches/${searchId}`).update({ inviteLinkRevoked: true });
}
```

- [ ] **Step 2: Create the watcher**

Create `telegram-bot/src/watchers/completionWatcher.js`:

```javascript
// Watches every search (not zone) for a transition into 'complete', same
// before/after diffing style as zoneWatcher.js. Revocation is best-effort —
// if the bot was demoted from admin mid-search, completion shouldn't hang or
// error (spec §3/§6).
export function watchSearchCompletion(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { markInviteRevoked } = await import('../firebase/searches.js');

    const prev = new Map();
    let initial = true;

    unsubscribe = db.collection('searches').onSnapshot(async snap => {
      const changes = snap.docChanges();
      if (initial) {
        initial = false;
        for (const c of changes) prev.set(c.doc.id, c.doc.data());
        return;
      }
      for (const c of changes) {
        if (c.type === 'removed') { prev.delete(c.doc.id); continue; }
        const before = prev.get(c.doc.id);
        const after = c.doc.data();
        prev.set(c.doc.id, after);
        if (!before) continue; // search created after startup — no transition to react to

        if (after.status === 'complete' && before.status !== 'complete'
            && after.groupChatId && after.inviteLink && !after.inviteLinkRevoked) {
          await bot.telegram.revokeChatInviteLink(after.groupChatId, after.inviteLink).catch(() => {});
          await markInviteRevoked(c.doc.id);
        }
      }
    }, err => console.error('completionWatcher error:', err));
  })();
  return () => unsubscribe();
}
```

- [ ] **Step 3: Register it in `index.js`**

Add the import:

```javascript
import { watchSearchCompletion } from './watchers/completionWatcher.js';
```

And start it:

```javascript
  watchSearches(bot);
  watchZoneChanges(bot);
  watchZoneRequests();
  watchSearchCompletion(bot);
```

- [ ] **Step 4: Verify index.js still parses and existing tests pass**

Run: `cd telegram-bot && node --check src/index.js && npm test`
Expected: no syntax error, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add telegram-bot/src/firebase/searches.js telegram-bot/src/watchers/completionWatcher.js telegram-bot/src/index.js
git commit -m "feat(bot): revoke a search's group invite link on completion"
```

This completes all `telegram-bot/` changes. Tasks 9–14 are `searcher-app/`.

---

### Task 9: `watchZones` — Searcher-App Zone Collection Watch

**Files:**
- Modify: `searcher-app/src/firebase/zones.js`

**Interfaces:**
- Produces: `watchZones(searchId: string, dayId: string, cb: (zones: object[]) => void): () => void`
- Consumed by: Task 14's `PickPage.jsx`

- [ ] **Step 1: Add `collection` to the Firestore import and add `watchZones`**

In `searcher-app/src/firebase/zones.js`, find the top import line:

```javascript
import { doc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
```

Replace with:

```javascript
import { doc, collection, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
```

Then append this function at the end of the file (reusing the existing `parseZone` helper already defined above it in the same file):

```javascript
export function watchZones(searchId, dayId, cb) {
  const zonesCol = collection(db, 'searches', searchId, 'days', dayId, 'zones');
  return onSnapshot(zonesCol, snap => cb(snap.docs.map(parseZone)));
}
```

- [ ] **Step 2: Verify the app still builds**

Run: `cd searcher-app && npm run build`
Expected: build succeeds with no errors (this is a Firestore-touching change with no dedicated unit test, per convention — build success confirms no syntax/import errors).

- [ ] **Step 3: Commit**

```bash
git add searcher-app/src/firebase/zones.js
git commit -m "feat(searcher): watchZones — live collection watch for the zone picker"
```

---

### Task 10: `getSearch` — Searcher-App Read-Only Search Fetch

**Files:**
- Create: `searcher-app/src/firebase/searches.js`

**Interfaces:**
- Produces: `getSearch(searchId: string): Promise<{ id, name, status, letterZones: Array<{letter, geometry}> } | null>`
- Consumed by: Task 14's `PickPage.jsx`

- [ ] **Step 1: Create the file**

Create `searcher-app/src/firebase/searches.js`:

```javascript
import { doc, getDoc } from 'firebase/firestore';
import { db } from './config';

export async function getSearch(searchId) {
  const snap = await getDoc(doc(db, 'searches', searchId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    id: snap.id,
    ...data,
    letterZones: (data.letterZones ?? []).map(z => ({
      ...z,
      geometry: z.geometry ? JSON.parse(z.geometry) : null,
    })),
  };
}
```

- [ ] **Step 2: Verify the app still builds**

Run: `cd searcher-app && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add searcher-app/src/firebase/searches.js
git commit -m "feat(searcher): getSearch — read-only search doc fetch for the picker"
```

---

### Task 11: `pickToken.js` — Parse `/pick/{searchId}` (TDD)

**Files:**
- Create: `searcher-app/src/pick/pickToken.js`
- Create: `searcher-app/test/pick/pickToken.test.js`

**Interfaces:**
- Produces: `parseSearchId(pathname: string): string | null`
- Consumed by: Task 14's `App.jsx`

- [ ] **Step 1: Write the failing tests**

Create `searcher-app/test/pick/pickToken.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { parseSearchId } from '../../src/pick/pickToken.js';

describe('parseSearchId', () => {
  it('extracts the search id from /pick/{searchId}', () => {
    expect(parseSearchId('/pick/AbC123_-xYz9')).toBe('AbC123_-xYz9');
  });

  it('tolerates a trailing slash', () => {
    expect(parseSearchId('/pick/AbC123_-xYz9/')).toBe('AbC123_-xYz9');
  });

  it('returns null for the root path', () => {
    expect(parseSearchId('/')).toBeNull();
  });

  it('returns null for /pick/ with no id', () => {
    expect(parseSearchId('/pick/')).toBeNull();
  });

  it('returns null for a /s/{token} path', () => {
    expect(parseSearchId('/s/AbC123')).toBeNull();
  });

  it('returns null for ids with invalid characters', () => {
    expect(parseSearchId('/pick/abc$%^')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd searcher-app && npx vitest run test/pick/pickToken.test.js`
Expected: FAIL with "Cannot find module '../../src/pick/pickToken.js'"

- [ ] **Step 3: Implement it**

Create `searcher-app/src/pick/pickToken.js`:

```javascript
export function parseSearchId(pathname) {
  const match = pathname.match(/^\/pick\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd searcher-app && npx vitest run test/pick/pickToken.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add searcher-app/src/pick/pickToken.js searcher-app/test/pick/pickToken.test.js
git commit -m "feat(searcher): parseSearchId for /pick/{searchId} routing (TDD)"
```

---

### Task 12: `identity.js` — Web Volunteer Identity + Request Resumption (TDD)

**Files:**
- Create: `searcher-app/src/pick/identity.js`
- Create: `searcher-app/test/pick/identity.test.js`

**Interfaces:**
- Produces: `getIdentity(): { id: string, name: string|null }`
- Produces: `saveName(name: string): void`
- Produces: `getSavedRequest(searchId: string): string|null`
- Produces: `saveRequest(searchId: string, requestId: string): void`
- Consumed by: Task 14's `PickPage.jsx`

- [ ] **Step 1: Write the failing tests**

Create `searcher-app/test/pick/identity.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { getIdentity, saveName, getSavedRequest, saveRequest } from '../../src/pick/identity.js';

// In-memory localStorage stub — same globalThis-stubbing convention already
// used for globalThis.indexedDB in offlineQueue.test.js.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
}

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
});

describe('getIdentity', () => {
  it('generates and persists a UUID on first call', () => {
    const { id } = getIdentity();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getIdentity().id).toBe(id); // same id on second call
  });

  it('returns null name when none saved yet', () => {
    expect(getIdentity().name).toBeNull();
  });

  it('returns the saved name after saveName', () => {
    saveName('Sarah Cohen');
    expect(getIdentity().name).toBe('Sarah Cohen');
  });

  it('keeps the same id across calls even after saving a name', () => {
    const first = getIdentity().id;
    saveName('Dana Levi');
    expect(getIdentity().id).toBe(first);
  });
});

describe('getSavedRequest / saveRequest', () => {
  it('returns null when nothing saved for this search', () => {
    expect(getSavedRequest('search-1')).toBeNull();
  });

  it('returns the saved request id, scoped per search', () => {
    saveRequest('search-1', 'req-abc');
    saveRequest('search-2', 'req-xyz');
    expect(getSavedRequest('search-1')).toBe('req-abc');
    expect(getSavedRequest('search-2')).toBe('req-xyz');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd searcher-app && npx vitest run test/pick/identity.test.js`
Expected: FAIL with "Cannot find module '../../src/pick/identity.js'"

- [ ] **Step 3: Implement it**

Create `searcher-app/src/pick/identity.js`:

```javascript
export function getIdentity() {
  let id = localStorage.getItem('webVolunteerId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('webVolunteerId', id);
  }
  return { id, name: localStorage.getItem('webVolunteerName') };
}

export function saveName(name) {
  localStorage.setItem('webVolunteerName', name);
}

// Lets the picker resume an in-flight or already-resolved request after a
// reload or browser-back navigation instead of submitting a duplicate (spec §6).
export function getSavedRequest(searchId) {
  return localStorage.getItem(`zoneRequest:${searchId}`);
}

export function saveRequest(searchId, requestId) {
  localStorage.setItem(`zoneRequest:${searchId}`, requestId);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd searcher-app && npx vitest run test/pick/identity.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add searcher-app/src/pick/identity.js searcher-app/test/pick/identity.test.js
git commit -m "feat(searcher): web volunteer identity + request resumption (TDD)"
```

---

### Task 13: `zoneRequests.js` — Searcher-App Create + Watch

**Files:**
- Create: `searcher-app/src/firebase/zoneRequests.js`

**Interfaces:**
- Produces: `createRequest({ searchId, letter, webVolunteerId, name }): Promise<string>` (returns the new request's id)
- Produces: `watchRequest(requestId: string, cb: (request: object) => void): () => void`
- Consumed by: Task 14's `PickPage.jsx`

- [ ] **Step 1: Create the file**

Create `searcher-app/src/firebase/zoneRequests.js`:

```javascript
import { doc, addDoc, collection, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createRequest({ searchId, letter, webVolunteerId, name }) {
  const ref = await addDoc(collection(db, 'zoneRequests'), {
    searchId, letter, webVolunteerId, name,
    status: 'pending', zoneId: null, token: null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchRequest(requestId, cb) {
  return onSnapshot(doc(db, 'zoneRequests', requestId), snap => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() });
  });
}
```

- [ ] **Step 2: Verify the app still builds**

Run: `cd searcher-app && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add searcher-app/src/firebase/zoneRequests.js
git commit -m "feat(searcher): zoneRequests create/watch for the web zone picker"
```

---

### Task 14: `PickPage.jsx` + Routing

**Files:**
- Create: `searcher-app/src/pick/PickPage.jsx`
- Modify: `searcher-app/src/App.jsx`

**Interfaces:**
- Produces: `<PickPage searchId: string />`
- Consumes: `getSearch` (Task 10), `watchZones` (Task 9), `createRequest`/`watchRequest` (Task 13), `getIdentity`/`saveName`/`getSavedRequest`/`saveRequest` (Task 12), `parseSearchId` (Task 11)

- [ ] **Step 1: Create `PickPage.jsx`**

Create `searcher-app/src/pick/PickPage.jsx`:

```jsx
import { useState, useEffect, useMemo } from 'react';
import { getSearch } from '../firebase/searches';
import { watchZones } from '../firebase/zones';
import { createRequest, watchRequest } from '../firebase/zoneRequests';
import { getIdentity, saveName, getSavedRequest, saveRequest } from './identity';

// Day management arrives in Plan 4; until then the whole system uses one fixed day.
const DAY_ID = 'day-1';

function letterAvailability(zones) {
  const byLetter = zones.reduce((acc, z) => {
    (acc[z.letter] ??= []).push(z);
    return acc;
  }, {});
  return Object.fromEntries(
    Object.entries(byLetter).map(([letter, lzones]) => [
      letter,
      lzones.some(z => z.status === 'unassigned' || z.status === 'needs_re_search') ? 'available' : 'full',
    ])
  );
}

export function PickPage({ searchId }) {
  const [search, setSearch] = useState(undefined); // undefined = loading, null = not found
  const [zones, setZones] = useState([]);
  const [pendingLetter, setPendingLetter] = useState(null);
  const [nameInput, setNameInput] = useState('');
  const [requestId, setRequestId] = useState(() => getSavedRequest(searchId));
  const [requestStatus, setRequestStatus] = useState(null);
  const identity = useMemo(getIdentity, []);

  useEffect(() => { getSearch(searchId).then(setSearch); }, [searchId]);

  useEffect(() => {
    if (!search) return;
    return watchZones(search.id, DAY_ID, setZones);
  }, [search]);

  useEffect(() => {
    if (!requestId) return;
    return watchRequest(requestId, req => {
      setRequestStatus(req.status);
      if (req.status === 'assigned' && req.token) window.location.href = `/s/${req.token}`;
    });
  }, [requestId]);

  if (search === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (search === null) return <p style={{ padding: 24 }}>This search link isn't valid.</p>;

  const availability = letterAvailability(zones);

  async function submitRequest(letter, name) {
    const id = await createRequest({ searchId: search.id, letter, webVolunteerId: identity.id, name });
    saveRequest(search.id, id);
    setRequestId(id);
    setRequestStatus('pending');
  }

  function handleTapLetter(letter) {
    if (availability[letter] !== 'available') return;
    if (!identity.name) { setPendingLetter(letter); return; }
    submitRequest(letter, identity.name);
  }

  function handleNameSubmit(e) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    saveName(nameInput.trim());
    submitRequest(pendingLetter, nameInput.trim());
    setPendingLetter(null);
  }

  if (requestStatus === 'pending') {
    return <p style={{ padding: 24, textAlign: 'center' }}>Finding your zone…</p>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{search.name}</h1>
      <p style={{ color: '#6b7280', marginBottom: 20 }}>Tap an available zone to join the search.</p>

      {requestStatus === 'no_availability' && (
        <p style={{ color: '#b91c1c', marginBottom: 12 }}>That zone just filled up — try another.</p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {Object.entries(availability).sort().map(([letter, status]) => (
          <button
            key={letter}
            onClick={() => handleTapLetter(letter)}
            disabled={status !== 'available'}
            style={{
              width: 56, height: 56, fontSize: 22, fontWeight: 700,
              background: status === 'available' ? '#22c55e' : '#9ca3af',
            }}
          >
            {letter}
          </button>
        ))}
      </div>

      {pendingLetter && (
        <form onSubmit={handleNameSubmit} style={{
          position: 'fixed', bottom: 16, left: 16, right: 16,
          background: '#fff', borderRadius: 12, padding: 16,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          <p style={{ marginBottom: 8, fontWeight: 600 }}>What's your name?</p>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="First Last" autoFocus />
          <button type="submit" style={{ marginTop: 10, width: '100%' }}>Join Zone {pendingLetter}</button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire routing into `App.jsx`**

In `searcher-app/src/App.jsx`, add these imports near the top (alongside the existing ones):

```javascript
import { parseSearchId } from './pick/pickToken';
import { PickPage } from './pick/PickPage';
```

Then, as the very first line inside `export default function App() {` (before the existing `const [state, setState] = useState('loading');`), add:

```javascript
  const searchId = parseSearchId(window.location.pathname);
  if (searchId) return <PickPage searchId={searchId} />;
```

This is safe ahead of the other hooks because `window.location.pathname` doesn't change without a full page reload in this app (no client-side router) — the branch is constant for the lifetime of a given mounted `App` instance, so hook order stays consistent across re-renders per React's rules.

- [ ] **Step 3: Verify the app builds and existing tests still pass**

Run: `cd searcher-app && npm run build && npm test`
Expected: build succeeds, all existing tests pass (no new tests for `PickPage.jsx`/`App.jsx` routing — React components are verified via manual smoke test in this codebase, matching `StatusButton.jsx`/`MarkerForm.jsx`/`SearcherMap.jsx`, none of which have test files either).

- [ ] **Step 4: Commit**

```bash
git add searcher-app/src/pick/PickPage.jsx searcher-app/src/App.jsx
git commit -m "feat(searcher): PickPage — tap-to-claim web zone picker at /pick/{searchId}"
```

---

### Task 15: Manual End-to-End Smoke Test

**Files:** none (verification only)

This mirrors how Phase 2 and Phase 3 each ended with a real-device field test before being considered done.

- [ ] **Step 1: Rebuild and redeploy both apps, restart the bot**

```bash
cd telegram-bot && npm run dev
```
(leave running in one terminal)

```bash
cd searcher-app && npm run build && cd .. && firebase deploy --only hosting:searcher
```

- [ ] **Step 2: Create and publish a test search**

In the Command Center (`cd command-center && npm run dev`), log in, create a new search, draw a boundary and at least two letter zones, generate sub-zones, and publish it.

- [ ] **Step 3: Bind a real Telegram group**

Create a new Telegram group, add your bot to it, promote it to admin with "Invite Users via Link" permission, and send `/bind` in that group (or `/bind <code>` if more than one search is bindable). Confirm the bot replies confirming the bind.

- [ ] **Step 4: Confirm the hub announcement**

Check the permanent hub group (`TELEGRAM_GROUP_CHAT_ID`). It should receive a photo message: a map image with lettered pins, captioned with the search name, the new group's invite link, and a picker link.

- [ ] **Step 5: Walk the picker flow on a phone**

From a phone browser (not the Command Center's device), open the picker link from the hub announcement. Confirm:
- The search name and available/full letter buttons render.
- Tapping an available letter prompts for a name (first time only).
- After submitting, "Finding your zone…" appears, then the page redirects to `/s/{token}` and the existing Searcher PWA flow takes over (map, GPS, status button — already field-tested in Phase 3).
- In the Command Center's Zone Panel, the newly assigned zone shows the volunteer's name.

- [ ] **Step 6: Confirm the invite link revokes on completion**

In the Command Center, click Complete on the test search. Confirm the dedicated group's invite link no longer allows new members to join (test by opening it in a private/incognito browser — it should show "this link is no longer valid" or similar).

- [ ] **Step 7: Record the result**

If all six checks pass, note the field test result (mirroring the existing ledger style) in a short commit or update to `SAR-Command-Track-Handoff.md`:

```bash
git add -A
git commit -m "docs: comms upgrade field test passed" --allow-empty
```

---

## Spec Coverage

| Spec section | Covered |
|---|---|
| §2 Data model (searches fields, zoneRequests, volunteers generalization, rules) | Tasks 1, 2, 3, 8 |
| §3 Flow 1 — group binding, /bind, announcement branch, revoke on completion | Tasks 3, 6, 8 |
| §4 Flow 2 — zone map image | Task 4 |
| §5 Flow 3 — web zone picker | Tasks 9, 10, 11, 12, 13, 14 |
| §6 Error handling | Woven into Tasks 3 (bind failures), 4 (URL length), 6 (sendPhoto fallback), 14 (invalid search, no-availability, resumption) |
| §7 Testing | Tasks 3, 4, 5, 11, 12 (TDD); Task 15 (manual smoke test) |
