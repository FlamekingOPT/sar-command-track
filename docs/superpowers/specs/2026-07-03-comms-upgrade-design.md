# Design — Comms Upgrade: Per-Search Telegram Groups + Web Zone Picker (Plan 6)

**Date:** 2026-07-03 · **Status: APPROVED (verbal, 2026-07-03) — not built.**

Builds on the built Phase 2 bot (`telegram-bot/`, field-tested 2026-07-03) and Phase 3
Searcher PWA (`searcher-app/`, deployed to https://sar-searcher.web.app). Extends both.
Complements `2026-07-03-cc-home-dashboard-design.md` (Plan 5) — the dashboard's copy-link
buttons read the fields this plan writes.

---

## 0. Overview

Today, every search shares one permanent Telegram group (`TELEGRAM_GROUP_CHAT_ID`) for
sign-up. That's fine for a single ongoing search but gets noisy once a search wraps and a new
one starts, or if two are active at once (handled today only by requiring a short code in
`/available`, per Phase 2). This plan adds two independent but related capabilities:

1. **A dedicated Telegram group per search**, created manually by staff, bound to a search via
   a new `/bind` command. The original permanent group becomes a pure **announcement hub**: it
   never hosts sign-up chatter itself once a search has its own group — it just posts a
   one-time announcement (map image + invite link + picker link) pointing volunteers at the
   dedicated group.
2. **A web zone picker** (`sar-searcher.web.app/pick/{searchId}`) as a tap-to-take alternative
   to typing `/available A` — usable by anyone with the link (including non-Telegram users,
   e.g. shared over WhatsApp), asking a name once and remembering it in `localStorage`.

Both funnel into the **same** assignment code the bot already uses (`pickZone` +
`assignZone`), so there is exactly one place in the system that decides who gets which zone,
regardless of which channel the request came in on.

Out of scope: retiring the plain-text `/available` fallback (stays, always works, cheapest
path for anyone already in a group and comfortable typing); any change to the assignment
algorithm itself (`assign.js`'s `pickZone` is reused unmodified).

---

## 1. Architecture

### New/changed files — `telegram-bot/`

```
telegram-bot/src/
  commands/
    bind.js                 — new: /bind [code] — binds the group it's sent in to a search
  firebase/
    searches.js              — CHANGED: fetchBindableSearches(), bindGroup(), markInviteRevoked()
    volunteers.js             — CHANGED: generalize saveVolunteer()'s key from "telegramId" to
                                 any volunteer id (web-registered volunteers have no Telegram id)
    zoneRequests.js           — new: fetchPending(), resolveRequest() — mirrors zones.js/links.js style
  mapImage.js                 — new: builds a Mapbox Static Images API URL for a search's letter zones
  watchers/
    zoneRequestWatcher.js     — new: watches zoneRequests, is the ONLY consumer of web-picker taps
    completionWatcher.js      — new: watches searches for status → 'complete', revokes invite links
  index.js                    — CHANGED: registers /bind, starts the two new watchers, requires MAPBOX_TOKEN
  .env.example                — CHANGED: adds MAPBOX_TOKEN
```

### New/changed files — `searcher-app/`

```
searcher-app/src/
  App.jsx                   — CHANGED: routes /pick/{searchId} to PickPage before the token check
  pick/
    PickPage.jsx             — new: letter-zone picker UI, name prompt, request/redirect flow
    identity.js               — new: localStorage read/write for {webVolunteerId, name}
    pickToken.js               — new: parseSearchId(pathname), mirrors firebase/token.js's parseToken
  firebase/
    zoneRequests.js            — new: createRequest(), watchRequest()
    searches.js                — new: getSearch() (read-only, letterZones + status) — searcher-app
                                  currently has no searches.js at all; App.jsx only ever reads a
                                  zone via a resolved link, never a search doc directly
```

### New dependency

`telegram-bot` gains `@turf/turf` (already a dependency of both frontend apps) — needed to
compute each letter zone's centroid for pin placement on the static map image.

### New/changed environment variables

| Var | App | Purpose |
|---|---|---|
| `MAPBOX_TOKEN` | `telegram-bot` | Mapbox Static Images API calls. Same underlying public token value as the frontends' `VITE_MAPBOX_TOKEN` is fine to reuse — it's a public client token — but named without the `VITE_` prefix since that prefix is meaningless outside Vite |

---

## 2. Data Model Additions

### `searches/{searchId}` — new fields

```
groupChatId       string | null   — the dedicated group's Telegram chat id, set by /bind
inviteLink        string | null   — Telegram invite link for that group, set by /bind
inviteLinkRevoked boolean         — set true by completionWatcher once revoked
```

All three are written only by the bot (Admin SDK) — same convention already established for
`announcedAt` (`telegram-bot/src/firebase/searches.js:11`, "this write is outside the
`assignZone` restriction" — that restriction only ever applied to zone docs, not search docs).

### New top-level collection: `zoneRequests`

```
zoneRequests/{requestId}
  searchId        string
  letter          string           — the single letter tapped, e.g. 'A'
  webVolunteerId  string           — localStorage-generated UUID, stands in for a Telegram id
  name            string
  status          'pending' | 'assigned' | 'no_availability'
  zoneId          string | null    — set on assign
  token           string | null    — searcherLinks token, set on assign
  createdAt       timestamp
```

### `volunteers/{id}` — id scheme generalized

Today every `volunteers` doc is keyed by Telegram id and written by
`telegram-bot/src/firebase/volunteers.js`'s `saveVolunteer({ telegramId, name })`. Web-picker
users have no Telegram id, so the bot's `saveVolunteer` needs its parameter generalized to any
id string (rename the param `id`, keep writing `telegramId` only when the caller actually has
one):

```js
// telegram-bot/src/firebase/volunteers.js — generalized
export async function saveVolunteer({ id, name, telegramId = null }) {
  await db.doc(`volunteers/${id}`).set({ name, telegramId, registeredAt: FieldValue.serverTimestamp() }, { merge: true });
}
```

`register.js` (Telegram `/register`) calls it with `{ id: telegramId, name, telegramId }`;
`zoneRequestWatcher.js` calls it with `{ id: webVolunteerId, name }`. This keeps Plan 5's
`ZonePanel` volunteer-name lookup (`volunteers[zone.assignedTo]`) working uniformly for both
kinds of volunteer with no branching in the Command Center.

### Firestore rules addition

```
match /zoneRequests/{requestId} {
  allow read: if true;    // the picker page polls its own request doc
  allow create: if true;  // open trust model, same as tracks/markers today
  allow update: if false; // only the bot (Admin SDK, bypasses rules) resolves a request
}
```

---

## 3. Flow 1 — Dedicated Group Binding

### Manual setup (staff, outside the app)

1. Staff creates a new Telegram group for the search.
2. Staff adds the bot to that group **and promotes it to admin** with "Invite Users via Link"
   rights — required for the bot to create and later revoke the group's invite link.
3. Staff sends `/bind` (or `/bind <code>` if more than one bindable search exists) **in that
   group**.

### `/bind [code]`

Reuses `resolveSearch.js`'s existing `pickSearch(searches, code)` helper, but against a wider
pool than `/available` uses — a search can be bound before it's published:

```js
// telegram-bot/src/firebase/searches.js — new
export async function fetchBindableSearches() {
  const snap = await db.collection('searches').where('status', 'in', ['setup', 'active']).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

Handler (`commands/bind.js`):

1. Resolve the search via `pickSearch(await fetchBindableSearches(), code)` — identical
   code/error-message shape as `/available` (zero active searches → "no active search";
   ambiguous → "include the code").
2. Call the Telegram Bot API `createChatInviteLink(ctx.chat.id, { name: search.name })`. If it
   throws (bot isn't admin, or lacks the invite-link permission), reply asking staff to
   promote the bot to admin first — do not silently fail.
3. `bindGroup(search.id, { groupChatId: ctx.chat.id, inviteLink: result.invite_link })`.
4. Reply in the group confirming the bind (e.g. "Bound to **Mt Wilson 2026-07-03**. Sign-ups
   happen here from now on.").

### Announcement to the hub

`watchers/searchWatcher.js` currently always posts the plain-text `signupMessage` to
`TELEGRAM_GROUP_CHAT_ID` (the hub) when a search is published. Change: at the moment of firing,
check whether the search is already bound:

```js
if (search.groupChatId && search.inviteLink) {
  const mapUrl = buildZoneMapUrl(search); // mapImage.js
  await bot.telegram.sendPhoto(process.env.TELEGRAM_GROUP_CHAT_ID, mapUrl, {
    caption: announcementCaption(search, search.inviteLink, pickerUrl(search.id)),
  });
} else {
  await bot.telegram.sendMessage(process.env.TELEGRAM_GROUP_CHAT_ID, signupMessage(search, letters, activeCount > 1));
}
```

This decision is made **once**, at publish time, exactly like today's `announcedAt` guard
already ensures. **If staff binds a group after the search is already published and
announced**, no automatic re-announcement fires — re-announcing later would either duplicate
the hub message or need a second guard field for no clear benefit. Staff shares the invite/
picker links manually in that case, via the **copy-link buttons on the Plan 5 dashboard** —
this is the concrete reason those buttons exist independent of the auto-announcement path.

`Telegram.sendPhoto` accepts a plain URL string for the photo — no need to download and
re-upload the Mapbox image; the bot just passes the Static Images API URL straight through.

### Revoking on completion

New `watchers/completionWatcher.js`, same `onSnapshot`-diff style as `zoneWatcher.js`:

```js
// watches searches (not zones) for a transition into 'complete'
if (after.status === 'complete' && before.status !== 'complete'
    && after.groupChatId && after.inviteLink && !after.inviteLinkRevoked) {
  await bot.telegram.revokeChatInviteLink(after.groupChatId, after.inviteLink).catch(() => {});
  await markInviteRevoked(after.id);
}
```

Revoking is best-effort (`.catch(() => {})`) — if the bot was demoted from admin mid-search,
completion shouldn't hang or error the watcher; the group simply stays joinable.

---

## 4. Flow 2 — Zone Map Image

`mapImage.js` builds a Mapbox Static Images API URL from a search's `letterZones` (already
stored as GeoJSON on the search doc, same shape the Command Center draws):

1. For each letter zone feature, compute its centroid with `turf.centroid`.
2. Build one marker overlay per letter: `pin-l-{letter-lowercase}+3b82f6({lng},{lat})` —
   Mapbox's static marker syntax supports single alphanumeric characters as pin labels, which
   fits zone letters (A–Z) directly, no custom icon needed.
3. Build a `geojson()` overlay of the letter zone boundaries only (stroke, no fill, to stay
   legible at chat-image size) — **not** the numbered sub-zones; per the requirement, the
   announcement is meant to orient volunteers to the coarse letter areas, not the assignment
   grid.
4. Auto-fit the bbox to the search boundary (`auto` region parameter) rather than hand-computing
   center/zoom.
5. Final URL: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/{markers},{geojson-overlay}/auto/800x600@2x?access_token={MAPBOX_TOKEN}`.

**URL length caveat:** Mapbox Static Images API GET requests are capped (~8192 characters). A
boundary with many vertices could blow this. Mitigation: if the built URL exceeds a safe
threshold (e.g. 7000 chars), retry with `turf.simplify` applied to the boundary/letter-zone
geometry before re-encoding; if still too long, drop the geojson overlay and send pins only —
never let this block the announcement outright.

---

## 5. Flow 3 — Web Zone Picker

### `searcher-app` routing

`App.jsx` currently does one thing: `parseToken(window.location.pathname)` → resolves `/s/{token}`.
Add a check ahead of it:

```js
const searchId = parseSearchId(window.location.pathname); // /^\/pick\/([A-Za-z0-9_-]+)\/?$/
if (searchId) return <PickPage searchId={searchId} />;
// ...existing /s/{token} logic unchanged
```

### Identity (`pick/identity.js`)

```js
export function getIdentity() {
  let id = localStorage.getItem('webVolunteerId');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('webVolunteerId', id); }
  return { id, name: localStorage.getItem('webVolunteerName') };
}
export function saveName(name) { localStorage.setItem('webVolunteerName', name); }
```

Name is asked once, the very first time a volunteer taps a letter with no name on file (not
before — someone just looking at the map without tapping shouldn't be interrupted).

### `PickPage.jsx` flow

1. Fetch the search doc once (`getSearch(searchId)` — status + `letterZones` GeoJSON) plus a
   live `watchZones`-style subscription to the search's sub-zones (searcher-app already has
   `firebase/zones.js` reading a single zone by ref; extend with a collection-level watch
   scoped to `searchId`/`DAY_ID`, mirroring the Command Center's `watchZones`).
2. Render each **letter zone** (not sub-zones) colored by availability, computed by
   aggregating that letter's sub-zone statuses — matching what's actually implemented today,
   not the original design doc's aspirational per-letter locking (never built — `pickZone`
   accepts a `lockedLetters` set but nothing populates it, confirmed in the running code):
   - **Available** (green) — at least one sub-zone `unassigned` or `needs_re_search`.
   - **Full** (gray) — every sub-zone `assigned`, `in_progress`, or `searched`.
3. Tap an available letter → if no name saved yet, show a one-time inline name prompt → on
   submit (or immediately, if a name is already saved), write a `zoneRequests` doc:
   `{ searchId, letter, webVolunteerId: id, name, status: 'pending', createdAt }`.
4. Show a "Finding your zone…" waiting state; `watchRequest(requestId)` listens for the
   status to change:
   - `'assigned'` → redirect to `/s/{token}` (the existing Searcher PWA flow takes over from
     here, unchanged).
   - `'no_availability'` → "That zone just filled up — try another," return to the picker view.

### Bot side — `watchers/zoneRequestWatcher.js`

The single assignment authority for web-originated requests, deliberately calling the *exact
same helpers* `available.js` calls, so a letter can't be double-assigned by the two channels
running different logic:

```js
export function watchZoneRequests(bot) { // bot param unused today, kept for signature symmetry with other watchers
  return db.collection('zoneRequests').where('status', '==', 'pending').onSnapshot(async snap => {
    for (const change of snap.docChanges()) {
      if (change.type !== 'added') continue;
      const req = { id: change.doc.id, ...change.doc.data() };
      await saveVolunteer({ id: req.webVolunteerId, name: req.name });
      const zones = await fetchZones(req.searchId, DAY_ID);
      const zone = pickZone(zones, [req.letter]);
      if (!zone) { await change.doc.ref.update({ status: 'no_availability' }); continue; }
      const token = await createSearcherLink({ searchId: req.searchId, dayId: DAY_ID, zoneId: zone.id, volunteerId: req.webVolunteerId });
      await assignZone(req.searchId, DAY_ID, zone.id, { status: 'assigned', assignedTo: req.webVolunteerId });
      await change.doc.ref.update({ status: 'assigned', zoneId: zone.id, token });
    }
  }, err => console.error('zoneRequestWatcher error:', err));
}
```

This does not introduce a new race condition beyond what already exists: two simultaneous
`/available` calls from two Telegram users already have the same theoretical
read-then-write gap (`fetchZones` → `pickZone` → `assignZone` isn't transactional today). The
web picker funnels through this identical gap, not a second one — it doesn't make the existing
risk worse, and closing it (e.g. with a Firestore transaction) is a pre-existing concern for
`/available` too, not something this plan needs to newly solve.

---

## 6. Error Handling

| Situation | Behavior |
|---|---|
| `/bind` sent by a non-admin bot, or bot not in the group at all | Telegram API call throws; reply asks staff to add/promote the bot first, no partial bind is written |
| `/bind` with no code and >1 bindable search | Same message shape as `/available`'s multi-search case, listing codes |
| Mapbox static URL exceeds length cap | Retry with simplified geometry, then pins-only, per §4 — never blocks the announcement |
| `sendPhoto` fails (bad URL, Mapbox outage) | Falls back to the plain-text `signupMessage` in the same hub post, so an image hiccup never leaves volunteers without a way to sign up |
| Two people tap the same letter at once on the picker | Same resolution as two near-simultaneous `/available` calls — whoever's watcher iteration runs first gets the best sub-zone, the other gets the next-best or `no_availability` |
| Picker page reopened after a request already resolved (browser back button) | `watchRequest` re-reads current status immediately on mount — if already `'assigned'`, redirects right away rather than re-prompting |
| Revoking an invite link for a group the bot was removed from | Best-effort, caught and ignored (§3) — completion still succeeds |

---

## 7. Testing

- Unit: `pickZone` is unchanged and already tested (Phase 2) — no new tests needed there, only
  confirmation that `zoneRequestWatcher` calls it with the same shape `available.js` does.
- Unit: `mapImage.js`'s URL builder — given fixture letter-zone GeoJSON, asserts the marker
  string and geojson overlay are well-formed, and that the length-cap fallback path
  (simplify → pins-only) triggers at the right threshold. No real network calls (matches the
  existing `tilePrefetch.test.js` pattern in `searcher-app`).
- Unit: `identity.js` — id persistence across calls, using the same fake-localStorage approach
  already available via `fake-indexeddb`'s sibling tooling, or a plain in-memory stub.
- Manual smoke test (mirrors Phase 2/3's real-device tests): create a search, bind a real test
  group, publish, confirm the hub receives the map image + both links, tap through the picker
  from a phone browser with airplane-mode-off, confirm DM/redirect to `/s/{token}` works,
  complete the search, confirm the invite link no longer allows joining.

---

## 8. Open Decisions Resolved

| Topic | Decision |
|---|---|
| Who creates the per-search Telegram group | Staff, manually, outside the app — the bot only binds an existing group via `/bind`, never creates one itself (Telegram bots can't create groups) |
| Where the rich announcement posts | The permanent hub group (`TELEGRAM_GROUP_CHAT_ID`), never the new dedicated group — the hub is where volunteers already are |
| Re-announcing after a late bind | No automatic re-announcement; staff shares links manually via the Plan 5 dashboard's copy-link buttons |
| Letter-zone locking in the picker's availability coloring | Not modeled — locking was never implemented in Phase 1 despite being in the original design doc; the picker reflects actual sub-zone status only |
| Assignment authority for web-originated requests | Exclusively the bot, via a new Firestore-watched `zoneRequests` collection and the same `pickZone`/`assignZone` calls `/available` uses — the picker page never calls `assignZone` itself |
| Volunteer identity for web-only searchers | Client-generated UUID in `localStorage`, stored in the same `volunteers` collection as Telegram users (generalized key, `telegramId: null`) so name lookups (Plan 5's Zone Panel) work uniformly |
| Static map image content | Letter zones only (not numbered sub-zones), pins at centroids, labeled with the zone letter — matches the coarse orientation the hub announcement needs |
