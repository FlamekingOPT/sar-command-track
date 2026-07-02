# Design — Telegram Bot (Plan 2)

**Date:** 2026-07-02 · **Status: DESIGN — not built.**

Builds on `docs/superpowers/specs/2026-06-28-sar-command-track-design.md` (§3, §6, §8) and implements **Plan 2** referenced in `docs/superpowers/plans/2026-06-28-sar-phase-1-command-center.md`.

---

## 0. Overview

A standalone Node.js process that runs the volunteer-facing Telegram bot for SAR Command & Track. It handles one-time volunteer registration, per-search sign-up, need-based zone assignment, and status notifications — reading and writing the same Firestore database the Command Center uses.

Out of scope for this plan: the Searcher PWA the bot links to (Plan 3), the web-based signup fallback for non-Telegram users (Command Center feature, separate), terrain-aware sub-zone generation (Plan 4 enhancement).

---

## 1. Architecture

### Stack

| Layer | Technology |
|---|---|
| Bot runtime | Node.js + Telegraf |
| Transport | Long polling (no public URL required; identical behavior local and in production) |
| Data access | Firebase Admin SDK (service account credentials — bypasses client Firestore security rules) |
| Hosting | Railway, deployed as a persistent worker process (no HTTP port bound) |

### Repo structure

New top-level folder in the existing monorepo, alongside `command-center/`:

```
sar-command-track/
  command-center/          (existing, unchanged)
  telegram-bot/            (new)
    package.json
    src/
      index.js             — entrypoint: Telegraf init, command registration, long polling start
      firebase/
        config.js          — Firebase Admin SDK init (service account)
      commands/
        register.js        — /register
        available.js       — /available
      assignment/
        assign.js          — subdivideZone... need-based zone assignment logic
      search/
        resolveSearch.js   — resolves an incoming message to a search doc (handles single vs. multi-search + code)
    test/
      assignment/
        assign.test.js
    .env.example
    .gitignore
```

### Credentials

- `TELEGRAM_BOT_TOKEN` — from @BotFather (already created by Jack).
- `FIREBASE_SERVICE_ACCOUNT` (or path to a JSON key file) — generated via Firebase Console → Project Settings → Service Accounts → Generate new private key. **Sensitive — never committed to git; provided as a Railway environment variable at deploy time.**

This is distinct from the `VITE_FIREBASE_*` values used by `command-center` — those are public client config; the service account is a privileged backend credential.

---

## 2. Data Model Additions

Extends the schema in the main design spec (§6).

```
searches/{searchId}
  ...existing fields...
  code            string   — short auto-generated code (e.g. "X7K2"), assigned at creation
```

- `code` is always generated, but only surfaced to volunteers (in bot messages and required in commands) when **more than one search is currently active** (`status == 'active'`). With a single active search, the bot infers it automatically and volunteers never need to type a code.
- No changes needed to `volunteers/` or `zones/` — the existing schema already supports everything below.

---

## 3. Commands & Flows

### `/register [First Last]`

- One-time per volunteer. Stores `{ name, telegramId, registeredAt }` in `volunteers/{volunteerId}`.
- Idempotent: re-registering confirms existing info rather than duplicating.

### `/available <zones...>` or `/available <code> <zones...>`

1. Bot checks the sender is registered — if not, replies asking them to `/register` first.
2. Bot resolves the target search:
   - If exactly one search is `active`, use it (code omitted or ignored if given).
   - If more than one search is `active`, a code is required; if missing or unrecognized, bot replies asking for a valid code.
3. Bot validates the requested letters exist for that search's current day; invalid letters get a reply listing the valid ones.
4. **Assignment logic** (see §4) picks one sub-zone across the requested letters.
5. Bot updates the zone doc (`status: 'assigned'`, `assignedTo: volunteerId`) and DMs the volunteer their assigned zone + link.

### Publish / New Day (triggered by Command Center, not a Telegram command)

- When staff publish a search or start a new day, the bot posts the sign-up message to the group (including the search `code` only if multiple searches are active).

### Manual re-search flag (triggered by Command Center)

- When staff flag any zone `needs_re_search` (any time, not just at day boundaries), the bot proactively announces it in the group: `⚠️ Zone A3 needs re-search — reply /available A to help.`

### Reassignment / release (triggered by Command Center)

- When staff reassign or release a volunteer's zone, the bot DMs the affected volunteer to notify them of the change.

---

## 4. Assignment Algorithm

Given a volunteer's requested letters, assign the **single most-needed** sub-zone across those letters:

1. For each requested letter, compute need = (unassigned/needs-re-search sub-zones) weighted by how few volunteers are currently assigned relative to the zone's total sub-zone count.
2. Pick the sub-zone with the highest need. Ties broken by lowest sub-zone number (e.g. A1 before A3).
3. **Locked letter zones**: excluded from normal assignment. If a volunteer requests a locked letter, the bot instead offers the nearest available zone, preferring the same letter if a sub-zone in it just became available (e.g. via re-search flag).

This mirrors the "no hard cap once every letter has ≥1 searcher" rule from the main spec (§2) — need-driven, not capacity-capped.

---

## 5. Error Handling

| Situation | Behavior |
|---|---|
| Unregistered volunteer uses `/available` | Reply: register first, with the exact command to run |
| Invalid zone letter | Reply listing valid letters for the current search/day |
| Missing/invalid code with multiple active searches | Reply asking for a valid code, lists active search codes by name |
| Bot restart / reconnect (Railway redeploy, network blip) | Long polling resumes automatically; no missed-message handling needed beyond Telegram's own update queue |
| Duplicate `/register` | Confirms existing registration, does not create a duplicate `volunteers` doc |

---

## 6. Testing

Same TDD approach used for `subdivideZone` in Phase 1: write Vitest cases for the assignment algorithm first (e.g. "3 assigned in A, 1 in B → next request for A or B resolves to B"), then implement against them. Command handlers (`register.js`, `available.js`) are kept thin — they parse input, delegate to `assignment/assign.js` and `search/resolveSearch.js`, and call Firestore/Telegram APIs. Pure logic (assignment scoring, search resolution) is unit tested; Telegram/Firestore I/O is exercised via manual smoke test against a real test group, matching how Phase 1 verified Firebase integration.

---

## 7. Manual Prerequisites (one-time)

1. Telegram bot already created via @BotFather — token in hand.
2. Generate a Firebase service account key (Console → Project Settings → Service Accounts) — **deferred until implementation/deploy step**.
3. Railway account + project connected to the GitHub repo, with `TELEGRAM_BOT_TOKEN` and the service account credential set as environment variables.

---

## 8. Open Decisions Resolved

| Topic | Decision |
|---|---|
| Deployment target | Railway |
| Bot transport | Long polling (not webhook) |
| Repo location | New `telegram-bot/` top-level folder in the existing monorepo |
| Firestore access | Firebase Admin SDK with a service account (bypasses client security rules) |
| Multiple concurrent searches | Supported — one shared Telegram group, disambiguated by an auto-generated short code, only required when >1 search is active |
| Mid-day re-search flagging | Bot proactively announces it in the group |
