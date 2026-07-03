# SAR Command & Track — Phase 2: Telegram Bot

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the volunteer-facing Telegram bot: one-time `/register`, per-search `/available` sign-up with need-based zone assignment, searcher-link DMs, and group announcements driven by Firestore watchers.

**Architecture:** Standalone Node.js worker using Telegraf with long polling — no HTTP server, no public URL. Reads/writes the same Firestore database as the Command Center via the Firebase Admin SDK (service account). Command-Center-triggered behaviors (publish announcements, re-search alerts, reassignment DMs) are implemented as Firestore `onSnapshot` watchers inside the bot process. Deployed on Railway as a persistent worker.

**Tech Stack:** Node 20+ (ES modules), Telegraf 4, firebase-admin 12, Vitest 1

**This is Plan 2 of 4** (Plan 1: Command Center — built; Plan 3: Searcher PWA; Plan 4: Integration).

**Spec:** `docs/superpowers/specs/2026-07-02-telegram-bot-design.md`

## Global Constraints

- Repo root on this machine: `C:\Users\Jack\dev\sar-command-track` (never work in the Google Drive copy)
- Node ≥ 20, npm ≥ 10; all new code is ES modules (`"type": "module"`)
- firebase-admin v12 modular imports (`firebase-admin/app`, `firebase-admin/firestore`) — never the namespaced default export
- **Geometry fields in Firestore are JSON strings**, not objects — the Command Center stores `zone.polygon`, `search.boundary`, and `letterZones[].geometry` via `JSON.stringify`. The bot never needs to parse them (it doesn't do geometry), but must never overwrite them.
- Day ID is hardcoded: `DAY_ID = 'day-1'` (single constant in `telegram-bot/src/constants.js`). Day management arrives in Plan 4.
- **The bot's only zone writes go through `assignZone()` in `telegram-bot/src/firebase/zones.js`, which sets exactly `status` and `assignedTo`.** No other code path may write to a zone doc. (Admin SDK bypasses Firestore rules, so this is enforced by code structure + review, per spec §3.)
- Volunteers are keyed by Telegram user id: doc id of `volunteers/{telegramId}` is `String(ctx.from.id)` — makes `/register` idempotent and lets the bot DM by doc id.
- Zone statuses: `unassigned | assigned | in_progress | searched | needs_re_search` (existing schema)
- Secrets (`TELEGRAM_BOT_TOKEN`, `FIREBASE_SERVICE_ACCOUNT`) live only in `telegram-bot/.env` (gitignored) locally and Railway environment variables in production. Never committed, never in docs.
- Pure logic modules (`assignment/`, `search/resolveSearch.js`, `messages.js`, `firebase/tokens.js`) must NOT import `firebase/config.js` — config throws without env vars, and tests import the pure modules directly.
- All tests: Vitest `describe`/`it`/`expect`, files under `telegram-bot/test/` mirroring `src/`
- Git commits from repo root; identity already configured (Yechiel Kessler)

---

## File Map

```
sar-command-track/
  command-center/
    src/search/searchCode.js         (new — code generator, used by createSearch)
    src/firebase/searches.js         (modified — createSearch adds code field)
    test/search/searchCode.test.js   (new)
  telegram-bot/                      (all new)
    package.json
    .gitignore
    .env.example
    src/
      index.js                       — entrypoint: Telegraf init, handlers, watchers, launch
      constants.js                   — DAY_ID
      messages.js                    — pure message-template functions
      firebase/
        config.js                    — Admin SDK init, exports db
        zones.js                     — assignZone (THE zone write), fetchZones
        tokens.js                    — generateToken (pure)
        links.js                     — createSearcherLink, deactivateLinksForZone, findActiveLink
        volunteers.js                — getVolunteer, saveVolunteer
        searches.js                  — fetchActiveSearches, markAnnounced
      commands/
        register.js                  — /register handler + parseRegisterName (pure)
        available.js                 — /available handler
      search/
        resolveSearch.js             — pickSearch, parseAvailableArgs (pure)
      assignment/
        assign.js                    — pickZone (pure)
      watchers/
        searchWatcher.js             — announce newly-published searches to the group
        zoneWatcher.js               — re-search alerts + reassignment/release DMs
    test/
      search/resolveSearch.test.js
      assignment/assign.test.js
      firebase/tokens.test.js
      commands/register.test.js
      messages.test.js
```

---

### Task 1: Scaffold telegram-bot Workspace

**Files:**
- Create: `telegram-bot/package.json`
- Create: `telegram-bot/.gitignore`
- Create: `telegram-bot/.env.example`
- Create: `telegram-bot/src/constants.js`
- Create: `telegram-bot/src/firebase/config.js`

**Interfaces:**
- Produces: `db` (Admin Firestore instance) exported from `firebase/config.js`; `DAY_ID` from `constants.js`; working `npm test` in `telegram-bot/`
- Consumed by: every later task

- [ ] **Step 1: Create telegram-bot/package.json**

```json
{
  "name": "telegram-bot",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --env-file=.env src/index.js",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm install telegraf@^4.16 firebase-admin@^12
npm install -D vitest@^1.6
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
*service-account*.json
```

- [ ] **Step 4: Create .env.example**

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=
FIREBASE_SERVICE_ACCOUNT=
SEARCHER_APP_URL=http://localhost:5174
```

(`FIREBASE_SERVICE_ACCOUNT` is the entire service-account JSON on one line. `SEARCHER_APP_URL` points at the deployed Searcher PWA once Plan 3 ships; localhost placeholder until then.)

- [ ] **Step 5: Create src/constants.js**

```javascript
// Day management arrives in Plan 4; until then the whole system uses one fixed day,
// matching command-center/src/App.jsx.
export const DAY_ID = 'day-1';
```

- [ ] **Step 6: Create src/firebase/config.js**

```javascript
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required');
}

const app = initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

export const db = getFirestore(app);
```

- [ ] **Step 7: Verify vitest runs (no tests yet)**

```bash
npm test
```
Expected: exits reporting no test files found (that's fine — confirms tooling works).

- [ ] **Step 8: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): scaffold telegram-bot workspace"
```

---

### Task 2: Search Code Generation (Command Center change, TDD)

Spec §2: every search gets a short `code` at creation, surfaced only when >1 search is active.

**Files:**
- Create: `command-center/src/search/searchCode.js`
- Create: `command-center/test/search/searchCode.test.js`
- Modify: `command-center/src/firebase/searches.js` (createSearch, lines 4–9)

**Interfaces:**
- Produces: `generateSearchCode(random?: () => number): string` — 4 chars from an unambiguous alphabet (no 0/O/1/I/L)
- Produces: `searches/{id}` docs now include `code: string`
- Consumed by: Task 3 (`pickSearch` matches on `search.code`), Task 8 (signup message)

- [ ] **Step 1: Write failing tests**

```javascript
// command-center/test/search/searchCode.test.js
import { describe, it, expect } from 'vitest';
import { generateSearchCode, CODE_ALPHABET } from '../../src/search/searchCode.js';

describe('generateSearchCode', () => {
  it('returns 4 characters', () => {
    expect(generateSearchCode()).toHaveLength(4);
  });

  it('only uses unambiguous alphabet characters', () => {
    for (let i = 0; i < 50; i++) {
      for (const ch of generateSearchCode()) {
        expect(CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('excludes ambiguous characters from the alphabet', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('is deterministic given a seeded random source', () => {
    const fakeRandom = () => 0; // always first alphabet char
    expect(generateSearchCode(fakeRandom)).toBe(CODE_ALPHABET[0].repeat(4));
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\command-center"
npm test
```
Expected: FAIL — `Cannot find module '../../src/search/searchCode.js'` (the 5 existing subdivider tests still pass).

- [ ] **Step 3: Implement searchCode.js**

```javascript
// command-center/src/search/searchCode.js
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateSearchCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: previous 5 subdivider tests + 4 new tests pass.

- [ ] **Step 5: Add code to createSearch**

In `command-center/src/firebase/searches.js`, add the import at the top and the `code` field:

```javascript
import { generateSearchCode } from '../search/searchCode';
```

```javascript
export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundary: null, letterZones: [],
    code: generateSearchCode(),
  });
  return { id: ref.id };
}
```

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add command-center
git commit -m "feat: generate short search code at search creation"
```

---

### Task 3: Argument Parsing + Search Resolution (TDD)

**Files:**
- Create: `telegram-bot/src/search/resolveSearch.js`
- Create: `telegram-bot/test/search/resolveSearch.test.js`

**Interfaces:**
- Produces: `parseAvailableArgs(tokens: string[]): { code: string | null, letters: string[] }` — tokens are the words after `/available`, uppercased; a first token longer than 1 char is treated as a search code
- Produces: `pickSearch(activeSearches: Array<{id, name, code, ...}>, code: string | null): { search } | { error: 'no_active_search' | 'code_required' | 'invalid_code' }`
- Pure module — no Firestore imports
- Consumed by: Task 7 (`/available` handler)

- [ ] **Step 1: Write failing tests**

```javascript
// telegram-bot/test/search/resolveSearch.test.js
import { describe, it, expect } from 'vitest';
import { parseAvailableArgs, pickSearch } from '../../src/search/resolveSearch.js';

describe('parseAvailableArgs', () => {
  it('treats all single-char tokens as letters, uppercased', () => {
    expect(parseAvailableArgs(['a', 'B'])).toEqual({ code: null, letters: ['A', 'B'] });
  });

  it('treats a multi-char first token as the search code', () => {
    expect(parseAvailableArgs(['x7k2', 'a', 'b'])).toEqual({ code: 'X7K2', letters: ['A', 'B'] });
  });

  it('handles empty input', () => {
    expect(parseAvailableArgs([])).toEqual({ code: null, letters: [] });
  });
});

const SEARCH_A = { id: 's1', name: 'Main St', code: 'X7K2' };
const SEARCH_B = { id: 's2', name: 'Riverside', code: 'P3QM' };

describe('pickSearch', () => {
  it('errors when no search is active', () => {
    expect(pickSearch([], null)).toEqual({ error: 'no_active_search' });
  });

  it('uses the single active search, ignoring any code given', () => {
    expect(pickSearch([SEARCH_A], null)).toEqual({ search: SEARCH_A });
    expect(pickSearch([SEARCH_A], 'WRONG')).toEqual({ search: SEARCH_A });
  });

  it('requires a code when multiple searches are active', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], null)).toEqual({ error: 'code_required' });
  });

  it('matches code case-insensitively across multiple searches', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], 'p3qm')).toEqual({ search: SEARCH_B });
  });

  it('errors on an unrecognized code', () => {
    expect(pickSearch([SEARCH_A, SEARCH_B], 'ZZZZ')).toEqual({ error: 'invalid_code' });
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement resolveSearch.js**

```javascript
// telegram-bot/src/search/resolveSearch.js

export function parseAvailableArgs(tokens) {
  const upper = tokens.map(t => t.toUpperCase());
  if (upper.length && upper[0].length > 1) {
    return { code: upper[0], letters: upper.slice(1) };
  }
  return { code: null, letters: upper };
}

export function pickSearch(activeSearches, code) {
  if (activeSearches.length === 0) return { error: 'no_active_search' };
  if (activeSearches.length === 1) return { search: activeSearches[0] };
  if (!code) return { error: 'code_required' };
  const search = activeSearches.find(s => s.code?.toUpperCase() === code.toUpperCase());
  return search ? { search } : { error: 'invalid_code' };
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): available-args parsing and multi-search resolution (TDD)"
```

---

### Task 4: Zone Assignment Algorithm (TDD)

Spec §4: need-based, single zone across requested letters, ties → lowest sub-zone number, locked letters excluded except their `needs_re_search` sub-zones, fallback to nearest available letter.

**Files:**
- Create: `telegram-bot/src/assignment/assign.js`
- Create: `telegram-bot/test/assignment/assign.test.js`

**Interfaces:**
- Consumes: zone docs shaped `{ id, letter, number, status, assignedTo }` (from `fetchZones`, Task 5)
- Produces: `pickZone(zones, requestedLetters: string[], lockedLetters?: Set<string>): zone | null`
  - `null` means nothing assignable
  - No lock UI exists yet (Plan 4), so callers pass no `lockedLetters` for now — but the logic is spec'd and tested here so Plan 4 only has to wire it up
- Pure module — no Firestore imports
- Consumed by: Task 7

- [ ] **Step 1: Write failing tests**

```javascript
// telegram-bot/test/assignment/assign.test.js
import { describe, it, expect } from 'vitest';
import { pickZone } from '../../src/assignment/assign.js';

// Helper: build a zone doc
const z = (letter, number, status = 'unassigned', assignedTo = null) =>
  ({ id: `${letter}${number}`, letter, number, status, assignedTo });

describe('pickZone', () => {
  it('assigns the letter with the greatest need (3 of 4 assigned in A, 1 of 4 in B → B)', () => {
    const zones = [
      z('A', 1, 'assigned', 'v1'), z('A', 2, 'assigned', 'v2'), z('A', 3, 'assigned', 'v3'), z('A', 4),
      z('B', 1, 'assigned', 'v4'), z('B', 2), z('B', 3), z('B', 4),
    ];
    expect(pickZone(zones, ['A', 'B']).id).toBe('B2');
  });

  it('breaks ties within a letter by lowest sub-zone number', () => {
    const zones = [z('A', 3), z('A', 1), z('A', 2)];
    expect(pickZone(zones, ['A']).id).toBe('A1');
  });

  it('treats needs_re_search sub-zones as assignable', () => {
    const zones = [
      z('A', 1, 'searched', 'v1'), z('A', 2, 'needs_re_search', 'v1'),
    ];
    expect(pickZone(zones, ['A']).id).toBe('A2');
  });

  it('returns null when no requested letter has an assignable sub-zone and no fallback exists', () => {
    const zones = [z('A', 1, 'assigned', 'v1'), z('A', 2, 'in_progress', 'v2')];
    expect(pickZone(zones, ['A'])).toBeNull();
  });

  it('does NOT fall back to unrequested letters when requested letters are merely full (not locked)', () => {
    const zones = [z('A', 1, 'assigned', 'v1'), z('B', 1)];
    expect(pickZone(zones, ['A'])).toBeNull(); // volunteer asked for A only; B stays untouched
  });

  it('ignores letters that do not exist in the search', () => {
    const zones = [z('A', 1)];
    expect(pickZone(zones, ['Q', 'A']).id).toBe('A1');
  });

  it('excludes locked letters from normal assignment, falling back to an unlocked letter', () => {
    const zones = [z('A', 1), z('B', 1)];
    expect(pickZone(zones, ['A'], new Set(['A'])).id).toBe('B1');
  });

  it('offers a needs_re_search sub-zone in a locked requested letter before falling back', () => {
    const zones = [z('A', 1, 'needs_re_search', 'v1'), z('A', 2, 'assigned', 'v2'), z('B', 1)];
    expect(pickZone(zones, ['A'], new Set(['A'])).id).toBe('A1');
  });

  it('deduplicates and uppercases requested letters', () => {
    const zones = [z('A', 1)];
    expect(pickZone(zones, ['a', 'A', 'a']).id).toBe('A1');
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: FAIL — module not found (resolveSearch tests still pass).

- [ ] **Step 3: Implement assign.js**

```javascript
// telegram-bot/src/assignment/assign.js
const ASSIGNABLE = ['unassigned', 'needs_re_search'];

export function pickZone(zones, requestedLetters, lockedLetters = new Set()) {
  const letters = [...new Set(requestedLetters.map(l => l.toUpperCase()))];
  const unlockedRequested = letters.filter(l => !lockedLetters.has(l));
  const lockedRequested = letters.filter(l => lockedLetters.has(l));

  // 1. Normal: highest-need unlocked requested letter.
  const normal = pickByNeed(zones, unlockedRequested, ASSIGNABLE);
  if (normal) return normal;

  // 2. Locked requested letters: only sub-zones freed by a re-search flag may be offered.
  const reSearch = pickByNeed(zones, lockedRequested, ['needs_re_search']);
  if (reSearch) return reSearch;

  // 3. Fallback to OTHER letters exists only for the locked case (spec §4 item 3) —
  //    if the request merely hit full letters, return null so the bot can say so.
  //    ("Nearest available" is approximated by need-order; geographic nearest
  //    needs zone centroids — Plan 4.)
  if (!lockedRequested.length) return null;
  const others = [...new Set(zones.map(zn => zn.letter))]
    .filter(l => !lockedLetters.has(l) && !letters.includes(l));
  return pickByNeed(zones, others, ASSIGNABLE);
}

function pickByNeed(zones, letters, assignableStatuses) {
  let best = null;
  for (const letter of [...letters].sort()) {
    const letterZones = zones.filter(zn => zn.letter === letter);
    if (!letterZones.length) continue;
    const available = letterZones
      .filter(zn => assignableStatuses.includes(zn.status))
      .sort((a, b) => a.number - b.number);
    if (!available.length) continue;
    const assignedCount = letterZones.filter(zn => zn.assignedTo != null).length;
    const need = 1 - assignedCount / letterZones.length;
    if (!best || need > best.need) best = { need, zone: available[0] };
  }
  return best?.zone ?? null;
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 17 tests pass (8 resolveSearch + 9 assign).

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): need-based zone assignment algorithm (TDD)"
```

---

### Task 5: Admin Firestore Helpers (assignZone, links, volunteers, searches)

**Files:**
- Create: `telegram-bot/src/firebase/zones.js`
- Create: `telegram-bot/src/firebase/tokens.js`
- Create: `telegram-bot/test/firebase/tokens.test.js`
- Create: `telegram-bot/src/firebase/links.js`
- Create: `telegram-bot/src/firebase/volunteers.js`
- Create: `telegram-bot/src/firebase/searches.js`

**Interfaces:**
- Produces (`zones.js`):
  - `assignZone(searchId, dayId, zoneId, { status, assignedTo }): Promise<void>` — **the only zone write in the bot**
  - `fetchZones(searchId, dayId): Promise<Array<{ id, letter, number, status, assignedTo, polygon }>>`
- Produces (`tokens.js`, pure): `generateToken(): string` — 12-char URL-safe random token
- Produces (`links.js`):
  - `createSearcherLink({ searchId, dayId, zoneId, volunteerId }): Promise<string>` — returns the token
  - `deactivateLinksForZone(searchId, dayId, zoneId, { except }?: { except: volunteerId }): Promise<void>`
  - `deactivateLink(token: string): Promise<void>`
  - `findActiveLink(searchId, dayId, zoneId, volunteerId): Promise<object | null>`
- Produces (`volunteers.js`): `getVolunteer(telegramId): Promise<object | null>`, `saveVolunteer({ telegramId, name }): Promise<void>`
- Produces (`searches.js`): `fetchActiveSearches(): Promise<Array<{ id, name, code, ... }>>`, `markAnnounced(searchId): Promise<void>`
- Consumed by: Tasks 6, 7, 8

- [ ] **Step 1: Write failing token tests**

```javascript
// telegram-bot/test/firebase/tokens.test.js
import { describe, it, expect } from 'vitest';
import { generateToken } from '../../src/firebase/tokens.js';

describe('generateToken', () => {
  it('returns a 12-character token', () => {
    expect(generateToken()).toHaveLength(12);
  });

  it('only contains URL-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not repeat across 1000 generations', () => {
    const seen = new Set(Array.from({ length: 1000 }, generateToken));
    expect(seen.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement tokens.js**

```javascript
// telegram-bot/src/firebase/tokens.js
import crypto from 'node:crypto';

export function generateToken() {
  return crypto.randomBytes(9).toString('base64url'); // 9 bytes → 12 URL-safe chars
}
```

- [ ] **Step 4: Run — confirm token tests pass**

```bash
npm test
```
Expected: 20 tests pass.

- [ ] **Step 5: Implement zones.js**

```javascript
// telegram-bot/src/firebase/zones.js
import { db } from './config.js';

// The ONLY code path in the bot that writes to a zone document (spec §3).
// Sets exactly two fields. Never touches polygon/letter/number, never creates or deletes.
export async function assignZone(searchId, dayId, zoneId, { status, assignedTo }) {
  await db.doc(`searches/${searchId}/days/${dayId}/zones/${zoneId}`)
    .update({ status, assignedTo });
}

export async function fetchZones(searchId, dayId) {
  const snap = await db.collection(`searches/${searchId}/days/${dayId}/zones`).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

- [ ] **Step 6: Implement links.js**

```javascript
// telegram-bot/src/firebase/links.js
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';
import { generateToken } from './tokens.js';

export async function createSearcherLink({ searchId, dayId, zoneId, volunteerId }) {
  const token = generateToken();
  await db.doc(`searcherLinks/${token}`).set({
    searchId, dayId, zoneId, volunteerId,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });
  return token;
}

async function activeLinksForZone(searchId, dayId, zoneId) {
  const snap = await db.collection('searcherLinks')
    .where('searchId', '==', searchId)
    .where('dayId', '==', dayId)
    .where('zoneId', '==', zoneId)
    .where('active', '==', true)
    .get();
  return snap.docs;
}

// `except` protects a just-created link for the new assignee from being
// deactivated by the zone watcher racing the /available handler.
export async function deactivateLinksForZone(searchId, dayId, zoneId, { except } = {}) {
  const docs = await activeLinksForZone(searchId, dayId, zoneId);
  await Promise.all(
    docs
      .filter(d => d.data().volunteerId !== except)
      .map(d => d.ref.update({ active: false }))
  );
}

export async function findActiveLink(searchId, dayId, zoneId, volunteerId) {
  const docs = await activeLinksForZone(searchId, dayId, zoneId);
  const match = docs.find(d => d.data().volunteerId === volunteerId);
  return match ? { token: match.id, ...match.data() } : null;
}

export async function deactivateLink(token) {
  await db.doc(`searcherLinks/${token}`).update({ active: false });
}
```

- [ ] **Step 7: Implement volunteers.js**

```javascript
// telegram-bot/src/firebase/volunteers.js
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function getVolunteer(telegramId) {
  const snap = await db.doc(`volunteers/${telegramId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function saveVolunteer({ telegramId, name }) {
  await db.doc(`volunteers/${telegramId}`).set({
    name,
    telegramId,
    registeredAt: FieldValue.serverTimestamp(),
  });
}
```

- [ ] **Step 8: Implement searches.js**

```javascript
// telegram-bot/src/firebase/searches.js
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function fetchActiveSearches() {
  const snap = await db.collection('searches').where('status', '==', 'active').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// announcedAt guards against re-announcing on bot restart (search docs are
// not zone docs — this write is outside the assignZone restriction).
export async function markAnnounced(searchId) {
  await db.doc(`searches/${searchId}`).update({ announcedAt: FieldValue.serverTimestamp() });
}
```

- [ ] **Step 9: Run tests (still green) and commit**

```bash
npm test
```
Expected: 20 tests pass.

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): admin Firestore helpers — assignZone, searcher links, volunteers, searches"
```

---

### Task 6: /register Command (TDD on name parsing)

**Files:**
- Create: `telegram-bot/src/commands/register.js`
- Create: `telegram-bot/test/commands/register.test.js`

**Interfaces:**
- Produces: `parseRegisterName(text: string): string` (pure) and `registerHandler(): (ctx) => Promise<void>` (Telegraf middleware)
- Consumes: `getVolunteer`, `saveVolunteer` from Task 5
- Consumed by: Task 9 (index.js)

- [ ] **Step 1: Write failing tests**

```javascript
// telegram-bot/test/commands/register.test.js
import { describe, it, expect } from 'vitest';
import { parseRegisterName } from '../../src/commands/register.js';

describe('parseRegisterName', () => {
  it('extracts the name after /register', () => {
    expect(parseRegisterName('/register Sarah Cohen')).toBe('Sarah Cohen');
  });

  it('handles the @botname group form', () => {
    expect(parseRegisterName('/register@SarTrackBot Sarah Cohen')).toBe('Sarah Cohen');
  });

  it('returns empty string when no name given', () => {
    expect(parseRegisterName('/register')).toBe('');
    expect(parseRegisterName('/register   ')).toBe('');
  });

  it('collapses internal whitespace', () => {
    expect(parseRegisterName('/register  Sarah   Cohen ')).toBe('Sarah Cohen');
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: FAIL — module not found. **Note:** `register.js` will import volunteer helpers which import `config.js` — that throws without env vars. To keep the pure function testable, `register.js` must use a *lazy dynamic import* of the volunteers module inside the handler (see Step 3), and the test imports only `parseRegisterName`.

Simpler alternative used here: keep `parseRegisterName` at the top of `register.js` and do the volunteers import statically — but then the test crashes on config. **So: dynamic import inside the handler. Follow Step 3 exactly.**

- [ ] **Step 3: Implement register.js**

```javascript
// telegram-bot/src/commands/register.js

export function parseRegisterName(text) {
  return text
    .replace(/^\/register(@\w+)?/i, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function registerHandler() {
  return async ctx => {
    // Dynamic import keeps this module importable without Firebase env vars (tests).
    const { getVolunteer, saveVolunteer } = await import('../firebase/volunteers.js');

    const telegramId = String(ctx.from.id);
    const existing = await getVolunteer(telegramId);
    if (existing) {
      await ctx.reply(`You're already registered as ${existing.name}. You're all set — reply /available when a search goes out.`);
      return;
    }

    const name = parseRegisterName(ctx.message.text);
    if (!name) {
      await ctx.reply('Please include your name: /register First Last');
      return;
    }

    await saveVolunteer({ telegramId, name });
    await ctx.reply(`Registered as ${name}. When a search goes out, reply /available with the zone letters you can search (e.g. /available A B).`);
  };
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 24 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): /register command with idempotent registration"
```

---

### Task 7: /available Command

**Files:**
- Create: `telegram-bot/src/commands/available.js`

**Interfaces:**
- Produces: `availableHandler(): (ctx) => Promise<void>`
- Consumes: `parseAvailableArgs`, `pickSearch` (Task 3); `pickZone` (Task 4); `fetchActiveSearches`, `fetchZones`, `assignZone`, `createSearcherLink`, `deactivateLink`, `getVolunteer` (Task 5); `DAY_ID` (Task 1)
- Consumed by: Task 9

**Ordering note (race with the zone watcher, Task 8):** the searcher link is created *before* `assignZone` runs, so when the watcher sees the `assignedTo` change it finds an existing active link for the new volunteer and knows the bot (not staff) made the assignment.

- [ ] **Step 1: Implement available.js**

```javascript
// telegram-bot/src/commands/available.js
import { parseAvailableArgs, pickSearch } from '../search/resolveSearch.js';
import { pickZone } from '../assignment/assign.js';
import { DAY_ID } from '../constants.js';

export function availableHandler() {
  return async ctx => {
    const [{ getVolunteer }, { fetchActiveSearches }, { fetchZones, assignZone }, { createSearcherLink, deactivateLink }] =
      await Promise.all([
        import('../firebase/volunteers.js'),
        import('../firebase/searches.js'),
        import('../firebase/zones.js'),
        import('../firebase/links.js'),
      ]);

    const telegramId = String(ctx.from.id);
    const volunteer = await getVolunteer(telegramId);
    if (!volunteer) {
      await ctx.reply('Please register first: /register First Last');
      return;
    }

    const tokens = ctx.message.text.split(/\s+/).slice(1);
    const { code, letters } = parseAvailableArgs(tokens);
    if (!letters.length) {
      await ctx.reply('Tell me which zones you can search, e.g. /available A B');
      return;
    }

    const active = await fetchActiveSearches();
    const picked = pickSearch(active, code);
    if (picked.error === 'no_active_search') {
      await ctx.reply('There is no active search right now.');
      return;
    }
    if (picked.error === 'code_required' || picked.error === 'invalid_code') {
      const list = active.map(s => `${s.code} — ${s.name}`).join('\n');
      await ctx.reply(
        `${picked.error === 'invalid_code' ? "I don't recognize that code. " : ''}` +
        `More than one search is active — include the search code:\n${list}\n` +
        `e.g. /available ${active[0].code} ${letters.join(' ')}`
      );
      return;
    }

    const search = picked.search;
    const zones = await fetchZones(search.id, DAY_ID);
    const validLetters = [...new Set(zones.map(z => z.letter))].sort();
    const invalid = letters.filter(l => !validLetters.includes(l));
    if (invalid.length) {
      await ctx.reply(`Unknown zone${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}. Valid zones for ${search.name}: ${validLetters.join(', ')}`);
      return;
    }

    const zone = pickZone(zones, letters);
    if (!zone) {
      await ctx.reply('All requested zones are fully assigned right now — watch the group for re-search announcements, or offer more letters.');
      return;
    }

    // Create link BEFORE assigning (see ordering note above), then assign, then DM.
    const prev = { status: zone.status, assignedTo: zone.assignedTo };
    const token = await createSearcherLink({
      searchId: search.id, dayId: DAY_ID, zoneId: zone.id, volunteerId: telegramId,
    });
    await assignZone(search.id, DAY_ID, zone.id, { status: 'assigned', assignedTo: telegramId });

    const url = `${process.env.SEARCHER_APP_URL}/s/${token}`;
    try {
      await ctx.telegram.sendMessage(telegramId,
        `You're assigned Zone ${zone.letter}${zone.number} for ${search.name}. Open your map: ${url}`);
      if (ctx.chat.type !== 'private') {
        await ctx.reply(`${volunteer.name} → Zone ${zone.letter}${zone.number}. Check your DM for the map link.`);
      }
    } catch {
      // Volunteer never started a DM with the bot — roll the assignment back.
      await deactivateLink(token);
      await assignZone(search.id, DAY_ID, zone.id, prev);
      await ctx.reply(
        `${volunteer.name} — I can't DM you yet. Open a chat with me and press Start, then send /available again.`);
    }
  };
}
```

- [ ] **Step 2: Run tests (nothing broken)**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: 24 tests pass. (This handler is thin I/O wiring over the pure logic tested in Tasks 3–4; it gets exercised in the Task 9 smoke test.)

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): /available command — assignment, searcher link, DM with rollback"
```

---

### Task 8: Message Templates (TDD) + Firestore Watchers

**Files:**
- Create: `telegram-bot/src/messages.js`
- Create: `telegram-bot/test/messages.test.js`
- Create: `telegram-bot/src/watchers/searchWatcher.js`
- Create: `telegram-bot/src/watchers/zoneWatcher.js`

**Interfaces:**
- Produces (`messages.js`, pure):
  - `signupMessage(search: {name, code}, letters: string[], includeCode: boolean): string`
  - `reSearchMessage(zone: {letter, number}): string`
- Produces (`searchWatcher.js`): `watchSearches(bot): () => void` — announces newly-active, not-yet-announced searches to the group
- Produces (`zoneWatcher.js`): `watchZoneChanges(bot): () => void` — re-search group alerts; reassignment/release link deactivation + DMs
- Consumes: `fetchZones`, `markAnnounced`, link helpers (Task 5); `DAY_ID` (Task 1); env `TELEGRAM_GROUP_CHAT_ID`, `SEARCHER_APP_URL`
- Consumed by: Task 9

- [ ] **Step 1: Write failing message tests**

```javascript
// telegram-bot/test/messages.test.js
import { describe, it, expect } from 'vitest';
import { signupMessage, reSearchMessage } from '../src/messages.js';

describe('signupMessage', () => {
  const search = { name: 'Main St Search', code: 'X7K2' };

  it('lists the search name and available letters', () => {
    const msg = signupMessage(search, ['A', 'B', 'C'], false);
    expect(msg).toContain('Main St Search');
    expect(msg).toContain('A, B, C');
  });

  it('omits the code when only one search is active', () => {
    const msg = signupMessage(search, ['A'], false);
    expect(msg).not.toContain('X7K2');
    expect(msg).toContain('/available A');
  });

  it('includes the code in the example command when multiple searches are active', () => {
    const msg = signupMessage(search, ['A', 'B'], true);
    expect(msg).toContain('X7K2');
    expect(msg).toContain('/available X7K2 A');
  });
});

describe('reSearchMessage', () => {
  it('names the zone and gives the exact command', () => {
    const msg = reSearchMessage({ letter: 'A', number: 3 });
    expect(msg).toContain('Zone A3');
    expect(msg).toContain('/available A');
  });
});
```

- [ ] **Step 2: Run — confirm failure**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement messages.js**

```javascript
// telegram-bot/src/messages.js

export function signupMessage(search, letters, includeCode) {
  const zoneList = letters.join(', ');
  const example = includeCode
    ? `/available ${search.code} ${letters[0] ?? 'A'}`
    : `/available ${letters[0] ?? 'A'}`;
  return [
    `🔍 Search: ${search.name}`,
    `Available zones: ${zoneList}`,
    `Reply ${example} with the zone letters you can search. You'll be assigned one zone based on where coverage is needed most.`,
    ...(includeCode ? [`(Multiple searches are active — include the code ${search.code} for this one.)`] : []),
  ].join('\n');
}

export function reSearchMessage(zone) {
  return `⚠️ Zone ${zone.letter}${zone.number} needs re-search — reply /available ${zone.letter} to help.`;
}
```

- [ ] **Step 4: Run — confirm all pass**

```bash
npm test
```
Expected: 28 tests pass.

- [ ] **Step 5: Implement searchWatcher.js**

```javascript
// telegram-bot/src/watchers/searchWatcher.js
import { DAY_ID } from '../constants.js';
import { signupMessage } from '../messages.js';

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
          await bot.telegram.sendMessage(
            process.env.TELEGRAM_GROUP_CHAT_ID,
            signupMessage(search, letters, activeCount > 1)
          );
        }
      }, err => console.error('searchWatcher error:', err));
  })();
  return () => unsubscribe();
}
```

- [ ] **Step 6: Implement zoneWatcher.js**

```javascript
// telegram-bot/src/watchers/zoneWatcher.js
import { reSearchMessage } from '../messages.js';

// Watches every zone doc (collectionGroup). Detects transitions by diffing
// against an in-memory previous-state map; the initial snapshot only seeds
// the map so a bot restart never replays old events.
export function watchZoneChanges(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { deactivateLinksForZone, findActiveLink, createSearcherLink } = await import('../firebase/links.js');

    const prev = new Map();
    let initial = true;

    unsubscribe = db.collectionGroup('zones').onSnapshot(async snap => {
      const changes = snap.docChanges();
      if (initial) {
        initial = false;
        for (const c of changes) prev.set(c.doc.ref.path, c.doc.data());
        return;
      }
      for (const c of changes) {
        const path = c.doc.ref.path; // searches/{sid}/days/{did}/zones/{zid}
        if (c.type === 'removed') { prev.delete(path); continue; }
        const before = prev.get(path);
        const after = c.doc.data();
        prev.set(path, after);
        if (!before) continue; // zone created after startup — no transition to react to

        const [, searchId, , dayId, , zoneId] = path.split('/');
        const searchSnap = await db.doc(`searches/${searchId}`).get();
        if (searchSnap.data()?.status !== 'active') continue;

        // 1. Staff flagged a re-search → announce in the group (spec §3).
        if (after.status === 'needs_re_search' && before.status !== 'needs_re_search') {
          await bot.telegram.sendMessage(process.env.TELEGRAM_GROUP_CHAT_ID, reSearchMessage(after));
        }

        // 2. Assignment changed.
        if (before.assignedTo !== after.assignedTo) {
          // Deactivate stale links, but never the new assignee's own link
          // (the /available flow creates it just before assigning).
          await deactivateLinksForZone(searchId, dayId, zoneId, { except: after.assignedTo ?? undefined });

          // DM whoever lost the zone (reassign or release, spec §3).
          if (before.assignedTo) {
            await bot.telegram.sendMessage(before.assignedTo,
              `Your assignment to Zone ${after.letter}${after.number} was changed by command. ` +
              `Reply /available in the group to get a new zone.`).catch(() => {});
          }

          // Staff assigned someone directly in the Command Center → they have no
          // link yet; create one and DM it. (Bot-made assignments already have one.)
          if (after.assignedTo && !(await findActiveLink(searchId, dayId, zoneId, after.assignedTo))) {
            const token = await createSearcherLink({
              searchId, dayId, zoneId, volunteerId: after.assignedTo,
            });
            const url = `${process.env.SEARCHER_APP_URL}/s/${token}`;
            await bot.telegram.sendMessage(after.assignedTo,
              `You've been assigned Zone ${after.letter}${after.number}. Open your map: ${url}`
            ).catch(() => {});
          }
        }
      }
    }, err => console.error('zoneWatcher error:', err));
  })();
  return () => unsubscribe();
}
```

- [ ] **Step 7: Run tests (still green) and commit**

```bash
npm test
```
Expected: 28 tests pass.

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): search/zone watchers — signup posts, re-search alerts, reassignment DMs"
```

---

### Task 9: Entrypoint + Local Smoke Test

**Files:**
- Create: `telegram-bot/src/index.js`

**Manual prerequisites (one-time, before this task's smoke test):**
1. **Service account key:** Firebase Console → Project Settings (`sar-trackhatzolah`) → Service Accounts → Generate new private key. Downloads a JSON file. Copy `telegram-bot/.env.example` → `telegram-bot/.env`; set `FIREBASE_SERVICE_ACCOUNT` to the entire JSON collapsed onto one line. **Delete the downloaded file afterwards** — it must exist only in `.env` (gitignored) and later in Railway.
2. **Bot token:** paste the @BotFather token (Jack has it) into `TELEGRAM_BOT_TOKEN`.
3. **Group chat id:** create a small test Telegram group, add the bot to it, **and in BotFather run /setprivacy → Disable is NOT needed** (commands reach bots regardless of privacy mode). Leave `TELEGRAM_GROUP_CHAT_ID` blank, run `npm run dev`, send any `/register` message in the group, and read the `chat:` line the bot logs. Put that (negative) number into `.env` as `TELEGRAM_GROUP_CHAT_ID`, restart.
4. `SEARCHER_APP_URL`: leave as the localhost placeholder until Plan 3 deploys.

- [ ] **Step 1: Create src/index.js**

```javascript
// telegram-bot/src/index.js
import { Telegraf } from 'telegraf';
import { registerHandler } from './commands/register.js';
import { availableHandler } from './commands/available.js';
import { watchSearches } from './watchers/searchWatcher.js';
import { watchZoneChanges } from './watchers/zoneWatcher.js';

for (const key of ['TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'SEARCHER_APP_URL']) {
  if (!process.env[key]) throw new Error(`${key} env var is required`);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Logs every chat id once — used to discover TELEGRAM_GROUP_CHAT_ID during setup.
const seenChats = new Set();
bot.use((ctx, next) => {
  if (ctx.chat && !seenChats.has(ctx.chat.id)) {
    seenChats.add(ctx.chat.id);
    console.log(`chat: ${ctx.chat.id} (${ctx.chat.title ?? ctx.chat.type})`);
  }
  return next();
});

bot.command('register', registerHandler());
bot.command('available', availableHandler());

bot.catch(err => console.error('bot error:', err));

if (!process.env.TELEGRAM_GROUP_CHAT_ID) {
  console.warn('TELEGRAM_GROUP_CHAT_ID not set — watchers disabled. Send a message in the group to discover the id, set it in .env, restart.');
} else {
  watchSearches(bot);
  watchZoneChanges(bot);
}

bot.launch(() => console.log('SAR bot polling…'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

- [ ] **Step 2: Full test suite green**

```bash
cd "C:\Users\Jack\dev\sar-command-track\telegram-bot"
npm test
```
Expected: 28 tests pass.

- [ ] **Step 3: Smoke test against the real test group**

```bash
npm run dev
```

Walk through, in the test Telegram group (with the Command Center running via `npm run dev` in `command-center/`):
1. `/register Test Volunteer` → bot confirms registration; re-send → "already registered".
2. `/available A` with no active search → "no active search" reply.
3. In the Command Center: create a search, draw boundary, generate zones, **Send Out Search** → bot posts the sign-up message (no code, single search) listing the letters.
4. `/available A` → bot replies in group + DMs a Zone A assignment with an `/s/<token>` link (open a DM with the bot and press Start first).
5. Firebase console → confirm the zone doc has `status: 'assigned'`, `assignedTo: <your telegram id>`, and a `searcherLinks/{token}` doc exists with `active: true`.
6. In the Command Center zone panel, set that zone's status to `needs_re_search` → bot announces ⚠️ in the group.
7. In the Firebase console, manually change the zone's `assignedTo` to another value → old volunteer gets the "changed by command" DM and the old link doc flips `active: false`.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Jack\dev\sar-command-track"
git add telegram-bot
git commit -m "feat(bot): entrypoint with long polling — Phase 2 bot feature-complete locally"
```

---

### Task 10: Railway Deployment (manual)

No code changes — deployment configuration only.

- [ ] **Step 1: Create Railway project**

1. https://railway.app → sign up / log in (GitHub SSO with the FlamekingOPT account is simplest).
2. New Project → **Deploy from GitHub repo** → select `FlamekingOPT/sar-command-track` (authorize repo access when prompted).

- [ ] **Step 2: Configure the service**

In the created service's **Settings**:
- **Root Directory:** `telegram-bot`
- **Start Command:** `npm start`
- No public networking / domain needed (long polling makes outbound connections only).

- [ ] **Step 3: Set environment variables**

Service → **Variables** → add:
- `TELEGRAM_BOT_TOKEN` — same value as local `.env`
- `TELEGRAM_GROUP_CHAT_ID` — the *production* group's id (discover it the same way as in Task 9 if different from the test group)
- `FIREBASE_SERVICE_ACCOUNT` — the one-line service account JSON (paste value only here, never in git/docs)
- `SEARCHER_APP_URL` — the Plan 3 hosting URL once it exists; until then the placeholder

- [ ] **Step 4: Deploy and verify**

1. Railway auto-deploys on push to the default branch; trigger the first deploy from the dashboard if needed.
2. Check the service logs for `SAR bot polling…`.
3. **Stop the local bot** (two pollers on one token fight over updates), then repeat smoke-test steps 1–4 from Task 9 against the Railway instance.

- [ ] **Step 5: Update the handoff doc**

In `G:\My Drive\SAR\SAR-Command-Track-Handoff.md`, mark the bot as built/deployed and record the Railway project name (no secrets).

---

## Spec Coverage

| Spec section | Covered |
|---|---|
| §1 Stack (Telegraf, long polling, Admin SDK, Railway) | Tasks 1, 9, 10 |
| §1 Repo structure `telegram-bot/` | Task 1 |
| §1 Credentials handling | Tasks 1, 9, 10 |
| §2 `code` on searches, surfaced only when >1 active | Tasks 2, 3, 8 |
| §3 `/register` (idempotent) | Task 6 |
| §3 `/available` incl. code resolution + validation | Tasks 3, 7 |
| §3 Zone write scope (`assignZone` only) | Task 5 (+ Global Constraints) |
| §3 Publish → group sign-up post | Task 8 |
| §3 Re-search flag → group announcement | Task 8 |
| §3 Reassignment/release → DM affected volunteer | Task 8 |
| §4 Need-based assignment, ties, locked letters | Task 4 |
| §5 Error handling table | Tasks 6, 7 (replies); Task 9 restart behavior (long polling resumes) |
| §6 Testing approach (TDD pure logic, manual smoke I/O) | Tasks 2–6, 8 (unit); Task 9 (smoke) |
| §7 Manual prerequisites | Tasks 9, 10 |
| Searcher link creation/deactivation (PWA spec §2, bot-side) | Tasks 5, 7, 8 |

**Deferred:** geographic "nearest zone" fallback and the lock UI that feeds `lockedLetters` (Plan 4 — algorithm already supports it), dynamic sub-zone resizing (Plan 4), day management (Plan 4).
