# SAR Command & Track — Handoff

## 2026-09-16 — PUSH THIS TO PRODUCTION: k-means + pin drops both merged to `master`, pushed, NOT deployed

Same session as the 2026-09-11 k-means entry directly below (picked back up after Jack field-tested it). Two things happened:

1. **Jack smoke-tested the k-means redesign** on a real boundary (Beverly Hills + Westwood, search "test update"). Verdict: "very happy with most of these but the ones I'm about to send still need work" — sent zone numbers 16, 17, 31 (Beverly Hills) and 68 (Westwood). **Root-caused all four, using the actual cached street tiles + the real boundary geometry pulled from Firestore, not guesswork:**
   - **Zones 16, 17: single raw blocks straight out of `buildBlocks`, k-means never touched them** (IQ 0.077 / 0.118 — long thin wedges hugging Wilshire Blvd). Boundary's edge runs almost parallel to Wilshire itself, so the strip between the drawn line and the first real interior street comes out elongated.
   - **Zone 31: k-means paired 2 blocks, but block A was independently already IQ 0.22 before pairing** — the "U" shape predates the clustering step; B (a fine, compact block) just got attached to one arm of it.
   - **All three trace to bad SOURCE blocks, not the clustering algorithm** — same category as the already-documented, already-accepted motorway-crossing limitation ("no zone-grouping strategy can fix a block that was already built wrong"). The old greedy-growth algorithm would have inherited these exact same ugly blocks too; this is not a k-means regression.
   - Zone 68 (Westwood) not yet dug into as deeply — its `isoperimetricQuotient` (0.488) is actually fine; it's just disproportionately LARGE (58,440 m² vs neighbors' 17-23k) — likely a freeway-frontage compartment (Veteran Ave / 405) that only got allocated 1-2 zones. Different mechanism than 16/17/31, not yet root-caused to the same depth.
   - **Proposed, not yet built:** extend `buildBlocks`'s existing local-refinement step (today it only re-splits a block when its street EFFORT exceeds target) to ALSO re-split when a block's own `isoperimetricQuotient` is bad — reuses the exact same re-polygonize/grid-fallback machinery already in the file, doesn't touch the clustering step at all. Scoped, low-risk, **not built** — Jack was about to greenlight it when the conversation moved to combining branches instead. **Pick this up first if continuing zone-quality work.**
2. **Jack asked for an inventory of everything sitting in the repo but not in production**, so it could all get combined into one deploy instead of trickling out branch by branch. Full inventory (branches, PRs, what's stale vs. real) is in the session transcript; net result:
   - **Pushed** the k-means work (`docs: add zone-growth-redesign implementation plan` through `Merge branch 'zone-growth-redesign'`) straight to `origin/master`.
   - **Fixed 2 real findings from PR #1's own Claude code review** (pin drops: `handleSavePin`/`handlePinClick` were missing the `readOnly` guard every other map-mutation handler has; the map's pin-drop click handler fired even mid-boundary-draw or mid-zone-reshape, fighting Mapbox Draw for the same click) — commit `3e3aae1`, then **merged PR #1 into `master`** (`bf14b18`), **pushed**. PR #1 auto-closed as merged on GitHub.
   - Both apps re-verified on the fully-merged `master`: command-center 118/118 tests, searcher-app 30/30, both lint clean (searcher-app's `App.jsx` conditional-hooks lint errors are pre-existing, confirmed present before either of today's changes — not new), both build clean.
   - Cleaned up: `zone-growth-redesign` branch/worktree deleted (already done 2026-09-11), `feature/command-center-pin-drops` branch/worktree deleted this session.

### ⚠️ NOT YET DONE — this is the actual handoff

**`origin/master` (`bf14b18`) has k-means + pin drops, fully merged, tested, pushed. Nothing is deployed. Production is still running whatever was live before this session** (last known deploy: 2026-09-11's `88542ca`/`97573c0` zone-reshape+searcher-name-label work, later than that unclear — check the live bundle's asset hash against `git log`, don't assume).

**⚠️ If you local-test pin drops (`npm run dev`) BEFORE deploying rules, dropping a pin will fail with `FirebaseError: Missing or insufficient permissions` in the console.** This is not a code bug — confirmed by Jack hitting it live 2026-09-16. `command-center/.env`/dev server always talks to the REAL production Firestore project (no local emulator, `firebase.json` has none configured), and the live security rules don't have the new `pins` subcollection match yet — it only exists in this repo's `firestore.rules`, unpushed to the backend. **Deploy rules first, separately, before any local pin-drop testing:**
```bash
cd C:\Users\Jack\dev\sar-command-track && firebase deploy --only firestore:rules
```
This is rules-only — it does not touch the live app, is safe to run any time, and doesn't need to wait for the hosting deploy below. Do it as step 0 if you're about to test locally, or let the full deploy command below cover it when you actually ship.

**To deploy — do this first, before touching anything else:**

```bash
cd C:\Users\Jack\dev\sar-command-track
git pull   # confirm you're at bf14b18 or later
cd command-center && npm run build
cd ..
```

Before running `firebase deploy`, **check nothing else is mid-build in another worktree** (this exact problem hit the 2026-09-11 session — a concurrent session's `npm run build` raced into the same `command-center/dist/` and shipped the WRONG bundle on the first attempt). If unsure, `rm -rf command-center/dist` and rebuild clean immediately before deploying.

```bash
firebase deploy --only hosting:command-center,firestore:rules,hosting:searcher
```

(`firestore:rules` because pin drops added a new `pins` subcollection rule; `hosting:searcher` because searcher-app also changed — pins render there too. If you only want command-center live and searcher-app deploy separately later, drop `hosting:searcher` — but the searcher-app pin-viewing code is inert/harmless until command-center actually drops a pin, so shipping both together is simplest and lowest-risk.)

**After deploying, verify against the live bundle, not just "deploy succeeded":**
```bash
curl -s "https://sar-trackhatzolah.web.app/index.html?cb=$RANDOM" | grep -o 'assets/[^"]*\.js'
# then diff that asset's filename hash against command-center/dist/assets/index-*.js from YOUR OWN build
```

**Smoke-test after deploy (production, not dev):**
1. Zone reshape/click (from 2026-09-11, should already be live, confirm it still is) — click a zone, "✎ Reshape zone N", drag a vertex.
2. Pin drops (new) — "📌 Drop Pin" toggle, click the map, add a note, confirm it shows up on a searcher's `/pick/...` link as a purple dot, click the pin again to delete it (confirm prompt).
3. Generate zones on a NEW boundary in a real or test search — compare shape to before (k-means should look rounder/more compact on most zones; expect zones 16/17/31-style thin wedges to still appear occasionally along any boundary edge that runs near-parallel to a real street, until the proposed `isoperimetricQuotient`-triggered re-split fix above gets built).

**Then update this doc** — move this section's content down into history, write a fresh "current state" line, and note the new deploy commit SHA.

### Still on the table, not started

- The `isoperimetricQuotient`-triggered block re-split fix (see item 1 above) — Jack wants it, scoped, ready to build.
- Zone 68 / Westwood freeway-frontage oversized-zone mechanism — not root-caused as deeply as 16/17/31 yet.
- `claude/serene-lamport-daisrp` branch (1 commit, `6c1e293`, pushed to its own remote branch, NOT master) — small street-tile-fetch timeout fix, looked safe, never folded in. Small enough to just cherry-pick onto master whenever.
- The old `worktree-flat-zone-grid` / `origin/gridsubdivide-wip` branches — forked from ~2 months before the current zone-generation architecture, its zone-shape algorithm (`gridSubdivide`) is superseded and would conflict hard with current `subdivider.js`/`overpass.js` if merged now; skip that part. One bundled commit (`885b25f`, GPS-tracking-gates-on-zone-status + mobile Wake Lock + direct-transaction zone claiming) MIGHT still contain something not ported forward — the zone-claim part is confirmed already in current `claimZone.js`, but the Wake Lock / tracking-gate parts were never verified against current `searcher-app`. Needs a real file-by-file check before deciding, not a blind merge — flagged, not investigated.
- `feature/searcher-history-and-contact` branch — spec + plan only, zero app code, not built.

---

## 2026-09-11 — Zone reshape/count fixes (deployed) + k-means zone-growth redesign (pushed to master 2026-09-16, see entry above — NOT deployed as of that date either)

Separate session from the pin-drops entry directly below (different concurrent Claude session, same day). Two pieces of work:

### Part A — three small fixes, already live in production

1. **Zones were never clickable/editable — root-caused, then built.** Jack reported "zones still won't allow me to edit." Investigation found this wasn't a regression: `git log --all` shows zone-map click handling never existed anywhere in this repo's history. Built from scratch: click a zone on the map or in the panel to select it; a "✎ Reshape zone N" toolbar button puts that one zone into Mapbox Draw (`direct_select` mode) for vertex dragging, boundaries go read-only for the duration so a stray drag can't resize the search area, each drag writes straight to Firestore (`updateZonePolygon`), validated (rejects self-intersecting/degenerate shapes) before the write. `command-center/src/zones/reshape.js` (new), `CommandMap.jsx`, `SearchDetail.jsx`, `firebase/zones.js`. **Does not reflow neighbors** — reshaping a zone can leave a gap/overlap with the zone next door; that's a known limitation, not a bug, flagged to Jack at the time.
2. **Zone-count bug on a second boundary.** `SearchDetail.jsx` computed `remaining = zoneCount - zones.length` — treating the entered number as a running total for the WHOLE search, not "zones for the boundary I'm generating now." Adding a 2nd boundary when 25 zones already existed and typing 20 more computed `max(1, 20-25) = 1` zone. Confirmed via live Firestore query on Jack's real "6609 Goodland Ave" search: 27 of 32 boundaries got exactly 1 zone each from this bug. Fixed in `command-center/src/zones/reshape.js`'s `zonesToGenerate()`. **The 27 already-broken boundaries are NOT auto-fixed** — each needs its zones regenerated (nudge the boundary to delete its zones, then Generate again) to get real subdivision.
3. **Searcher position dots had no name label.** Command could see a dot moving but not who — cross-referencing the panel was the only way. Added a `searcher-positions-labels` symbol layer keyed off the same `volunteers` map the panel already used. `CommandMap.jsx`.

Commits `88542ca`, `97573c0` — pushed, deployed to https://sar-trackhatzolah.web.app same session, verified live (`index-Rw72mGaL.js` then `index-D6UV6d7Q.js` bundle checked directly against the CDN). **One deploy hazard hit mid-session, worth knowing:** a concurrent session (see pin-drops entry / `feat/zone-panel-resize` branch) was building `command-center/dist` in another worktree at the same moment — the first deploy attempt shipped a build with none of this session's code because `npm run build` and the other session's build raced into the same `dist/` output directory. Caught by fingerprinting the live bundle against known source strings after deploy, fixed by deleting `dist/` and rebuilding clean. **If you deploy while another session might also be building, delete `command-center/dist` first and verify the deployed bundle's asset hash matches your own build's `dist/assets/index-*.js`, don't just trust `firebase deploy`'s "success."**

### Part B — k-means zone-growth redesign, executed via `subagent-driven-development`

Jack asked "we ran tiles of the whole LA map that was supposed to give us well-shaped zones, what happened to that" — investigation found the tiles were fine (verified live, serving real street data) and the actual cause was the zone-count bug above (27 single-zone boundaries with no real subdivision). While explaining that, Jack separately asked to pick up the **approved-but-never-implemented** `docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md` — replace `mergeBlocksToZones`'s greedy BFS region-growing with weighted k-means clustering for compact zone shapes.

⚠️ **Important correction to the 2026-07-26 entry further down this doc.** That entry claims a 25-commit branch `zone-tools-and-kmeans` was fully built (k-means clustering AND clickable zone list AND manual vertex editing with gap/overlap dialogs AND hot-zone split), reviewed, sitting ready to merge. **That branch does not exist on this machine.** Checked exhaustively: `git branch -a` (local + remote), `git log --all --oneline` for any of its commits, `hotZoneSplit.js`/`seedClusters`/`refineClusters` anywhere in history — zero hits. It most likely existed only on whatever machine built it (the doc's own text says "desktop", this session ran on a different machine) and was never pushed to origin — same class of stale-claim risk this doc has caught in itself before (see the 2026-07-19 "post-dispatch boundary spec doesn't actually exist" correction). **Practical consequence: the k-means work in THIS entry is a fresh, independent build from the same spec, not a continuation of that lost branch — it does NOT include the clickable-zone-list/manual-editing/hot-zone-split tools the 2026-07-26 entry describes** (a *simpler*, separately-built version of clickable-select + single-zone reshape shipped in Part A above, with no gap/overlap resolution and no split). If that lost branch's work still exists somewhere (an old laptop, a different clone), recovering it and reconciling against what's here is worth doing before rebuilding those three tools a second time.

Ran the spec through `writing-plans` → `docs/superpowers/plans/2026-09-10-zone-growth-redesign.md` (3 tasks) → executed via `subagent-driven-development` in an isolated worktree/branch (`zone-growth-redesign`, off `master` `97573c0`). Two rounds of real fix loops in Task 2 (both caught by task review, not self-reported): a hand-derived test fixture that never actually produced the disconnection behavior it claimed to test (twice — the plan author's own derivation had an arithmetic error, then an implementer's empirically-found replacement fixture also turned out to pass for an unrelated reason), resolved by exporting `connectedParts` for direct unit testing instead of chasing a third fragile black-box fixture. Final whole-branch review (opus) found no Critical issues, 4 Important (test-rigor/doc-accuracy, not behavior), one more fix wave, clean. Full task-by-task history with every ruling made is in git commit messages (deleted the SDD workspace ledger per the process, per its own instructions — trust `git log` now).

- **Merged to `master` locally** as `4f48c4a` (6 commits: `0911470` refactor removes the abandoned, never-wired-in `refineZoneBoundaries` patch from 2026-07-19/20 · `11f10a6` the actual k-means clustering (deterministic farthest-point seeding, Lloyd's iteration with effort-weighted centroids, 20-iteration cap, non-contiguous-cluster splitting) · `bd4aa8e`/`f89f40c`/`33ead07` fix rounds and review polish · `ca1be30` the plan doc). **NOT pushed to origin** (`git status`: master ahead 7). **NOT deployed.**
- **118/118 tests passing** (`command-center`), lint clean, build clean. `mergeBlocksToZones`'s external signature/return-shape is unchanged — no caller anywhere needed touching.
- **Accepted trade-off, approved via ruling not by Jack directly (flag if it bites in the field):** one pre-existing test's expectation was deliberately changed. For a fixture with EXTREME weight skew (one block ~10x heavier than its 3 neighbors) on a straight 1-D chain, k-means's geometric-first seeding produces a positional 2-vs-2 split (weight ratio 5.5:1) instead of the old greedy algorithm's clean 1-vs-3 isolation (weight ratio 3.3:1) of the heavy block. This is a real, structural consequence of the new algorithm for extreme skew on near-linear shapes, not a bug — but if a real search produces a visibly lopsided zone pair, this is the mechanism to check.
- **Motorway-crossing bug (zone spanning a freeway) is unaffected, still open** — confirmed in the 2026-07-23 spec and unchanged by this work: it's a `buildBlocks`/`turf.polygonize` topology limitation (blocks already contain a motorway segment before any zone-grouping runs), not something either the old or new grouping algorithm can fix. Three candidate fixes scoped, none built — see the 2026-07-23 entry further down.

**Also observed, not touched:** three OTHER local branches from concurrent sessions today — `feat/zone-panel-resize` (merged to master already, commit `6a6f721`), `feature/command-center-pin-drops` (pushed, PR #1 open, see entry below), `feature/searcher-history-and-contact` (design-only, see 2026-09-10 entry below). Don't be surprised by unfamiliar branches; they're real, someone else's concurrent work, not artifacts to clean up.

### START HERE if picking this up

1. **Smoke-test before pushing.** Open a real search, draw or add a boundary, Generate Zones, eyeball the shapes — compare to the old greedy-growth zones already in that search. This is the one manual check nobody but Jack can do.
2. **Push:** `git push origin master` (7 commits, currently local-only).
3. **Deploy:** `cd command-center && npm run build && cd .. && npx firebase deploy --only hosting:command-center` — check no other session is racing a build first (see Part A's deploy-hazard note above).
4. Consider hunting for the lost `zone-tools-and-kmeans` branch/work (see correction above) before rebuilding clickable-zone-list-with-multiselect / manual-editing-with-gap-dialogs / hot-zone-split from the 2026-07-26 spec — it may already exist somewhere.
5. The 27 single-zone boundaries on "6609 Goodland Ave" (and any other search hit by the zone-count bug before today's fix) still need manual zone regeneration per-boundary — see Part A item 2.

---

## 2026-09-11 — BUILT + pushed: command-center pin drops, visible to searchers (PR #1, unmerged)

Jack asked (via chat) for a quick, separate feature: command center drops pins with notes on the map, searchers see them. Built end-to-end in a fresh worktree/branch so it wouldn't collide with whatever the other concurrent session is doing on `zone-growth-redesign`/`worktree-flat-zone-grid`.

- **Branch:** `feature/command-center-pin-drops` (off `master` `6a6f721`), pushed, **PR open:** https://github.com/FlamekingOPT/sar-command-track/pull/1. Not merged, not deployed.
- **Worktree:** `C:\Users\Jack\dev\sar-command-track\.claude\worktrees\pin-drops` (safe to remove after merge: `git worktree remove .claude/worktrees/pin-drops`).
- **What it does:** new "📌 Drop Pin" toggle in the Command Center header — click the map while active to place a pinned note (small floating form), click an existing pin to delete it (confirm prompt). Searchers see the same pins live on their own map (purple dot, distinct from their own red self-dropped markers), read-only.
- **Data model:** new `searches/{id}/days/{id}/pins/{pinId}` subcollection — `{lat, lng, note, createdAt}`. Mirrors the existing searcher→command `markers` collection but reversed direction. `firestore.rules`: `read: if true`, `create/update/delete: if request.auth != null` (command-center-only writes, same gate as zones).
- **New/changed files:** `command-center/src/firebase/pins.js`, `command-center/src/ui/PinForm.jsx`, `command-center/src/map/CommandMap.jsx`, `command-center/src/search/SearchDetail.jsx`, `searcher-app/src/firebase/pins.js`, `searcher-app/src/App.jsx`, `searcher-app/src/map/SearcherMap.jsx`, `firestore.rules`.
- **Verified:** `npm test` green in both apps (145 tests total, no new failures), `npm run build` clean in both apps, `oxlint` shows no new warnings (confirmed the pre-existing `App.jsx` conditional-hooks errors and one `set-state-in-effect` warning already exist on `master`, not introduced by this). **NOT manually click-tested in the Command Center UI** — blocked by Firebase Auth login, no credentials available in that session. Also not blocked-on but worth knowing: the click-drop interaction only wired a plain `map.on('click', ...)` handler, doesn't yet handle the "click landed on a zone AND pin-drop mode is on" case beyond suppressing zone-selection (see `CommandMap.jsx` comments).
- **Still needed before this is live:**
  1. Smoke-test in the real UI: drop a pin, confirm it appears on a searcher's `/pick/...` link, delete it.
  2. `firebase deploy --only firestore:rules` after merge (rules change, not run from this session — production security rules, didn't want to push that without Jack's OK).
  3. Merge PR #1, then regular `hosting` deploy per the cheatsheet at the bottom of this doc.

---

## 2026-09-10 — new branch, design-only: searcher history + contact from ZonePanel

Jack asked (via chat, not a coding session at the desk) for two new ZonePanel features — click a searcher's name to (1) see every zone they've been assigned/searched, (2) see their phone/contact. Explicitly **plan only, don't build** — folds into a later update.

- **Branch:** `feature/searcher-history-and-contact` (off `master`, one commit `dd9a329`, docs only — no app code touched).
- **Spec:** `docs/superpowers/specs/2026-09-10-searcher-history-and-contact.md`
- **Plan:** `docs/superpowers/plans/2026-09-10-searcher-history-and-contact.md` (6 tasks, ready to execute via `writing-plans`/`subagent-driven-development` whenever this gets picked up)
- **Important correction made during planning, worth knowing before touching this:** the first draft assumed `telegram-bot` was the live searcher-messaging channel and designed around it. That's wrong — re-verify-able any time: the bot's `zoneWatcher.js`/`messages.js` still reference `zone.letter` (letter-keyed zones), but the live system has been flat-numbered since 2026-07-13; `firebase.json` has no `functions` key and no bot reference at all. Matches this doc's own **"Telegram bot: still stale... Web picker remains the primary sign-up path"** note below. The real, current assignment path is `searcher-app/src/pick/claimZone.js` — a direct client-side Firestore transaction, no bot/server involved. The plan was rewritten around that: `assignmentHistory` gets appended to by the three actual zone-writing call sites (searcher-app's claim + status update, command-center's status update) instead of a bot-side watcher; "contact" means collecting a phone number at pick-time and showing `tel:`/`sms:` links, not in-app Telegram messaging (that'd need reviving/reconciling the bot or adding an SMS gateway — flagged as a separate v2 decision, not in this plan).
- **Also sitting uncommitted on `master`'s working tree** (separate from this branch, not part of it): `command-center/src/ui/ZonePanel.jsx` has an unshipped panel-resize-drag-handle + name-hover-tooltip change from the same conversation. Held back from commit/deploy because another session was concurrently building `zone-growth-redesign` on its own worktree/branch at the time — check whether that's still true before committing it.

---

**Last updated:** 2026-07-26 (second session) — **The zone-growth k-means redesign AND all three Command Center zone tools are BUILT, reviewed, and committed on a feature branch — but NOT merged and NOT deployed.** 25 commits on branch `zone-tools-and-kmeans`, **160/160 tests green**, working tree clean. A second field-testing round found and fixed **five more real bugs** including a major coverage hole and a live data-loss path (see "Field-testing round 2" immediately below). Three things remain: (1) Jack's manual checks, (2) a final whole-branch code review, (3) merge + deploy.

---

## Field-testing round 2 (2026-07-26, second session) — 5 fixes, `4351e13`..`015c5cf`

All on the same branch, all with regression tests confirmed to fail against the pre-fix code (one exception, labelled in the file). **160/160 tests, build clean, lint unchanged (same 2 pre-existing warnings).** Full detail with measurements is in the progress ledger.

1. **`4351e13` — a whole hillside inside a boundary got NO zones.** Not the algorithm: `buildBlocks` **dropped** any polygonized face over `maxBlockAreaM2`, *before* the refinement step whose job is splitting oversized blocks. Only bites in sparse terrain — at district LOD the edge set is motorway→tertiary, but hillside canyon roads are `residential`/`unclassified`, so faces between the surviving majors run 1.5–7.5 km² against a ~0.89 km² cap. Measured on real tiles (Hollywood Hills, 148 zones): coverage **14.8% → 100.7%**. Dense West LA has zero over-cap faces, so it's a verified no-op there — which is why this survived every earlier test. The cap is now a must-refine trigger, not a delete.
2. **`2bade9f` — editing still opened with too many handles.** Not a regression of `5ed3405`. `simplifyForEditing` treated 40 vertices as "good enough" in two places (an early `break`, and an entry guard). Costs **nothing** in fidelity — the 2% budget was simply never spent. Measured over 137 real zones: **median handles 33 → 11**, zones opened untouched 20 → 2.
3. **`825d777` — the gap/overlap dialogs rendered with blank buttons.** `index.css` styles every `<button>` white-on-blue; the dialogs override `background` to light grey but never `color`. Also had to set `esbuild.jsx: 'automatic'` — vitest was transforming `.jsx` with the classic runtime, so no component test could ever have run here.
4. **`33c59aa` — edit mode is now vertices-only.** Draw's `direct_select` translates the whole polygon on any drag starting in the zone's interior. New `zone_vertex_edit` mode closes that. `dragRotate` is now disabled during edits alongside `dragPan` (it wasn't). Scroll zoom deliberately left on.
5. **`015c5cf` — tester bug report, real data loss, reproduced on master AND the branch.** Selecting the boundary outline and dragging it deleted all 89 zones with no prompt. `c894cf4` only removed the boundary from Draw *during a zone edit*; outside edit mode it stays draggable, and the confirm was gated on `searchStatus === 'active'` — so in setup, exactly where you've just generated zones, it was silent. Status now only *adds* the "searchers may be assigned" sentence. Same gate fixed in the delete path.

**Checked and dismissed — "zones look blank" is NOT a regression.** Zone fill is byte-identical to master (`fill-color: ['get','color']`, `fill-opacity: 0.25`, unassigned `#9ca3af`); only the outline gained a selected-state case. Unassigned zones have always rendered as faint grey over a pale basemap. Real readability complaint, just not new — **Jack was offered a fix (raise opacity, or recolour `unassigned`) and hasn't picked one yet.**

### ⚠️ Separate finding, still open: the cached street tiles are terrain-stale

Audited all 702: of the 607 non-empty tiles, **exactly 1 contains terrain polygons and 2 contain path/footway**. They were downloaded 2026-07-14→19; terrain tags were added to `tools/prefetch-streets.mjs` on 2026-07-20 (`dbd21c3`). `fetchStreets` reads the cache first and only falls back to Overpass for *missing* tiles, so `terrainPolygons` is empty on every real search — both real-data runs this session reported `terrainPolygons 0`. **The whole 2026-07-19 terrain-aware refinement work (Tasks 1-4) is inert in the field.** Remedy: re-run the county prefetch. Less urgent now that over-cap faces get split rather than dropped.

---

## FINISH THIS — START HERE (2026-07-26)

### Where the work lives

- **Worktree:** `C:\Users\Jack\dev\sar-command-track\.worktrees\zone-tools-and-kmeans` (branch `zone-tools-and-kmeans`, branched from master `c71bf2f`).
- **Branch state:** 25 commits ahead of master, working tree clean, **160/160 tests passing**, lint clean (2 pre-existing unrelated warnings). Four untracked `scratch-*.mjs` harnesses sit in `command-center/` — real-data coverage and edit-handle measurement, no dev server needed; useful for re-verification, safe to delete.
- **Not merged, not pushed, not deployed.** `master` has only the two design specs + the implementation plan (`5010144`, `c71bf2f`) — none of the actual code.
- **Progress ledger (read this first if you lose context):** `C:\Users\Jack\dev\sar-command-track\.superpowers\sdd\progress.md` — every task, every bug found, every fix, with commit SHAs. Gitignored, lives in the MAIN checkout's working tree. Per-task briefs/reports/review-diffs are in the WORKTREE's `.superpowers\sdd\`.
- **Specs:** `docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md` (k-means) and `docs/superpowers/specs/2026-07-23-command-center-zone-tools-design.md` (the three tools). **Plan:** `docs/superpowers/plans/2026-07-23-zone-tools-and-kmeans-redesign.md` (14 tasks; 1-13 complete, 14 is the manual pass below).

### ⚠️ Local dev setup gotcha (already done in this worktree — needed again on another machine)

`.env` and `public/street-tiles/` are gitignored, so a fresh worktree/clone has **neither**, and the app fails to a **totally blank screen** with no console error (this cost time already). In this worktree both are in place (`.env` copied from the main checkout, street-tiles symlinked to the main checkout's 702 tiles). On any other machine, copy `.env` and provide street tiles before `npm run dev`:

```bash
cd "C:/Users/Jack/dev/sar-command-track/.worktrees/zone-tools-and-kmeans/command-center" && npm run dev
```

### Step 1 — Two manual checks (only Jack can do these)

1. **Re-verify zone editing after the round-2 fixes.** Open a real zone → "Edit zone". Confirm (a) the shape looks like the real zone, (b) there are now only ~10-15 corner handles and they're individually grabbable, (c) dragging the zone's *interior* does nothing and the map can't be panned or rotated mid-edit, (d) a corner drag → "Save edit" shows a gap/overlap dialog whose buttons are **readable**. Then, outside edit mode, click the boundary outline and drag it — you should now get a confirmation naming the zone loss, and cancelling should restore the shape.
   - One thing to look at: the screenshot of the gap dialog appeared to list "Zone 43" twice. If the neighbour list really does offer the same zone twice (rather than that being the faded text), say so — that's a separate bug and nobody has chased it.
   - **Also decide:** unassigned zones render as faint grey at 25% opacity and are hard to see (long-standing, not new). Want the opacity raised or `unassigned` recoloured?
2. **Feature-flag check (plan Task 14, Step 3).** In `command-center/src/zones/hotZoneSplit.js` set `ENABLE_HOT_ZONE_SPLIT = false`, restart the dev server, confirm **both** "Split zone" and "Draw hot zone" buttons disappear while manual editing and the clickable zone list still work. **Set it back to `true`.**

### Step 2 — Final whole-branch code review

Not yet done, and now covers 25 commits rather than 20. Run `superpowers:requesting-code-review` over the full branch diff (`git merge-base master HEAD`..`HEAD`), on the most capable model. Hand it the deferred-Minor list below so it can triage what must be fixed before merge.

### Step 3 — Merge + deploy

Then `superpowers:finishing-a-development-branch`. **Deploy must come from a machine WITH the street tiles** (the desktop has them) — see the existing deploy-gotcha section further down; deploying tile-less silently strips the cache from production.

### ⚠️ Possible data integrity issue from testing

An over-simplification bug (fixed in `5ed3405`) could distort a zone's shape when it was opened for editing. **Any zone that was edited AND saved during 2026-07-26 testing may have a mangled shape stored in Firestore.** The fix prevents new occurrences but does not repair existing data — if a zone looks wrong in a real search, regenerate zones for that boundary.

### What got built (all reviewed, all committed)

**Phase 1 — k-means zone-growth redesign** (implements the 2026-07-23 spec; `refineZoneBoundaries` removed entirely):
- `seedClusters` (deterministic seeding: highest-effort block first, then farthest-point sampling; no `Math.random`), `refineClusters` (Lloyd's algorithm, effort-weighted centres, 20-iteration cap), `splitNonContiguousClusters` (BFS connected-components), all wired into `mergeBlocksToZones`'s region-forming step. Compartment detection, runt absorption, and the sliver sweep are untouched; the public signature is unchanged.
- **Jack verified on a real boundary:** zone shapes are visibly more compact than before. His words: "looks better, we still need to improve it but for now it works." Not perfect — further zone-quality work is still open (see backlog).

**Phase 2 — three Command Center tools:**
- **Clickable zone list** — bidirectional select/highlight between list and map, multi-select, map fits to selection.
- **Manual zone editing** — drag vertices of one selected zone, explicit "Save edit"/"Cancel edit", post-save gap/overlap resolution dialogs (assign the vacated area to a touching neighbour, create a new zone from it, take area from an overlapped neighbour, trim back, or leave as-is). MultiPolygon (multi-part remainder) zones are deliberately not editable.
- **Split** — one action, two entry points, both behind `ENABLE_HOT_ZONE_SPLIT`: multi-select zones then Split, or draw a shape (precise-clip: partially-overlapped zones survive as reshaped remainders keeping their id/status/assignedTo; fully-covered zones are deleted and an assigned searcher's assignment follows their last known GPS position into whichever new zone contains it). Re-subdivision reuses the same k-means clustering.

### Real bugs found and fixed during this session (all in the ledger with detail)

Several were in the plan's own specified code, caught by review or by Jack's testing:
1. **Mid-drag edit abort** — `saveZoneEdit` was wired to Mapbox's continuously-firing `draw.update`, so edit mode ended after the first sub-pixel movement and continuing the drag threw. Fixed by separating live-drag tracking from an explicit Save.
2. **Boundary drag deleted all zones (data loss)** — the boundary stayed in the same Mapbox Draw instance during a zone edit; Draw's `direct_select` falls back to `simple_select` on an outside click, re-exposing the boundary (easily mistaken for "the map") for dragging, which triggers boundary-edit → deletes every zone on that boundary, **with no confirmation at all outside `active` status**. Fixed by excluding the boundary from Draw for the duration of an edit (+ `dragPan` disabled while editing).
3. **Over-simplification destroyed zone shapes** — the editing simplifier treated "≤40 vertices" as a hard requirement with no fidelity check, returning a 5-vertex/+15.3%-area blob instead of an available 45-vertex/−0.6% result. Fixed by making fidelity a hard constraint (≤2% area deviation, no self-intersections) and vertex reduction a goal; returns the original untouched if nothing qualifies.
4. **Two delete-before-create orderings** in both Split entry points — a create failure after a successful delete would vanish zones permanently. Reordered to create-then-delete (worst case is now recoverable duplicate coverage).
5. **`turf.difference` throw treated as "fully covered"** in `planDrawSplit` — a topology glitch on a partially-covered zone would have silently deleted real territory. Now a throw leaves that zone completely untouched.
6. Plus: `seedClusters` tie-break depended on caller-sorted input; a `hotZoneDrawing`/`drawMode` desync that could silently discard an in-progress boundary sketch; `turf` v6-vs-v7 API mismatch in the plan's sample code; midpoint handle clutter.

### Accepted tradeoffs (deliberate, don't "fix" these without asking)

- **A manually-edited zone's border is slightly less street-precise** than the algorithm drew it (simplification is what makes editing usable). Only affects zones actually edited and saved; capped at 2% area change. Opening editing without dragging persists nothing.
- **`targetVertices` (40) is a soft goal, not a guarantee** — genuinely convoluted zones keep more handles rather than being distorted. There's a comment saying so; don't turn it back into a hard cap.
- **One old test's expectation was updated** (`mergeBlocksToZones` "balances zones by provided efforts"): its fixture is a rigid zero-gap 4-block chain where Lloyd's-with-weighted-centroid-recompute mathematically cannot isolate a heavy block from an adjacent one (a weighted centroid is a convex combination bounded by its own members). Real street blocks always have geometric slack, and heavy-block isolation is confirmed working there. Jack approved this over changing the validated clustering math.

### Deferred Minor findings — hand these to the final review to triage

- `fitBounds` effect depends on `zones`, so it re-centres on any zone update while a selection is active (plan-mandated dep array).
- Lint: `no-unused-expressions` on the ternary-as-statement in `toggleZoneSelection`.
- `boundaryId: touched[0].boundaryId` / `selected[0].boundaryId` — a Split spanning two boundaries mis-tags new zones (inherited pattern in both entry points).
- A `turf.difference`-throw zone still contributes its `consumedPieces` to the split region while its own doc is left alone (could overlap the surviving original).
- `dragPan` stays disabled if the edited zone disappears mid-edit (concurrent deletion).
- Gap-fill zones created by `resolveGapNewZone` derive from simplified vertices (consistent with the accepted tradeoff above).
- `isoperimetricQuotient`'s doc comment still name-drops the removed `refineZoneBoundaries`.
- No automated coverage for a "pathological non-convex" simplification case beyond the jagged fixture.

---

**2026-07-23** — The 2026-07-19 zone-algorithm-quality spec's Part B (`refineZoneBoundaries`, a scored post-growth patch) is **superseded**, not built. Wiring it into production broke 7 pre-existing regression tests; the root cause was a genuine formula bug (recomputing "fair share" against a shrinking region count on dissolution, which reintroduced the exact mean-skewed-by-an-outlier bug the 2026-07-16 fix already solved once). Even after hand-fixing that bug, testing it against a real 143-zone West LA search (reconstructed boundary, `Bind: Z5CJ`) showed the whole approach has a low ceiling — it can only rearrange zones that greedy growth already grew badly, it can't fix a zone that was bad from the moment it grew.

Jack proposed inverting the approach instead: decide compact, effort-balanced target zones geometrically first (k-means clustering on block centroids, weighted by search effort, one cluster set per hard-road-isolated compartment), *then* assign real street-blocks to them — rather than growing zones outward block-by-block with no shape objective. Validated empirically (throwaway Node scripts, see below) against the same real boundary: median compactness 0.531→0.586, zones below 0.25 compactness 11→3. **Approved and spec'd:** `docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md` (commit `2cce29a`) — replaces `refineZoneBoundaries` entirely (removed) with k-means clustering as `mergeBlocksToZones`'s internal region-forming step, restores the original hard-road-runt-absorption rule (nothing else replaces its job now). **Not implemented** — next session's job is `writing-plans` + build. Tasks 1-5 of the superseded plan (terrain-aware fetching, `isoperimetricQuotient`, road-class adjacency) are unaffected, stay as committed, and remain valid.

**Also found during this same investigation, still unfixed:** the motorway-crossing bug (zone 95 spanning the 405, first seen 2026-07-19) is **not** in `mergeBlocksToZones` at all. Confirmed directly: 10 of 1324 individual *blocks* already fully contain a motorway segment before any zone-grouping step ever runs — a `buildBlocks`/`turf.polygonize` topology limitation (motorways are grade-separated, so a real motorway way rarely shares an exact vertex with the surface street grid except at interchanges; `polygonize` can only cut along edges that share exact coordinates, so a stretch with no nearby interchange never becomes a splitting edge). Neither the old growth algorithm nor the new k-means approach can fix this — confirmed empirically (7-8 crossings either way). Jack has explicitly accepted this as a known, separate, deferred issue. Three candidate fixes were scoped but not designed in detail, in order of recommendation: (1) a post-hoc validation/repair pass that splits any finished zone found to fully contain a hard line — narrow, low-risk; (2) split polygonized faces against hard lines directly using a buffer+difference operation instead of relying on shared vertices — fixes it at the source, more surface area for bugs; (3) snap hard-line endpoints to nearby nodes before polygonize runs — keeps the existing architecture, but this file's history shows tolerance-based snapping repeatedly causing subtle bugs, riskiest of the three.

Throwaway validation scripts from this investigation live at `command-center/scratch-*.mjs` (untracked, not committed) — `scratch-kmeans.mjs` in particular is a working prototype of the k-means clustering logic, useful as an implementation reference. Safe to delete once the real implementation lands.

---

**2026-07-19** — Two things happened this session, neither implemented yet (both are next-session work, not done now, per Jack):
1. **Correction to this doc's own 2026-07-16 claim below:** the "fully-designed, approved, committed" post-dispatch-2nd-boundary spec does **not exist** — checked `git log --all` (every branch) and the Drive copy, zero trace of `docs/superpowers/specs/2026-07-16-post-dispatch-boundary-design.md` ever being written. This is the same class of stale-claim problem the searcher-picker bug had. Treat "post-dispatch 2nd boundary" as **undesigned** — it needs its own brainstorming pass before anything else, not an implementation session.
2. **Zone-generation algorithm quality** (the "biggest field impact" item from the 2026-07-16 review) was brainstormed with Jack and turned into an approved, committed design: `docs/superpowers/specs/2026-07-19-zone-algorithm-quality-design.md` (commit `976880a`). Unifies 4 of the 5 diagnosed issues (odd shapes, isolated runt zones, standing slivers, Vermont-Ave-style split mismatches) into one scored boundary-refinement pass that runs after today's greedy growth, plus a separate fix to fetch golf/park/cemetery polygons so the algorithm can see them. **Not implemented** — next session should run this spec through `writing-plans` and build it.

Also this session: `node tools/prefetch-streets.mjs --region county` **completed** — all 702 tiles downloaded (278MB), integrity-checked (0 malformed, the 95 empty tiles all fall in a legitimate ocean band south of 34.00°N — not a bug). Local-tested via `npm run dev` on the desktop clone:
- **A 200-zone "whole county"-scale single boundary hangs** in the zone-crunching step after street data loads (tile fetch itself finishes fine). Likely `buildBlocks`'s O(n²) block-adjacency comparison (`subdivider.js:346-353`) — never exercised at anywhere near this scale before (prior real tests topped out ~150-175 zones over a few-neighborhood boundary). Real searches should keep using multiple reasonably-sized boundaries rather than one giant one; this is a scale limit worth knowing about, not necessarily something to fix before it's actually needed.
- **A real 143-zone West LA search (Hollywood→Venice, `Bind: Z5CJ`) surfaced concrete field evidence for the 2026-07-19 zone-algorithm-quality spec** — now added to that spec file directly (commit `14719ce`): zone 95 genuinely crosses the 405 freeway (a real bug in the "last-resort hard-road absorption" rule, not a visual glitch), zone 86 has a wildly jagged shape (compactness 0.039), zone 2 is a 9,300m² standing sliver, and Barry Ave is fragmented across 4 zones.
- **New, separate, undesigned issue found**: zone numbering (`orderZonesForNumbering`) doesn't hold up on large/irregularly-shaped multi-neighborhood boundaries like this one — validated on compact single-neighborhood boundaries (WeHo/Beverly Hills) but here the average number-gap between geographically-nearest zones is 10.1 (out of 143), worst case 38 (zones ~500-800m apart numbered 88 and 50, or 92 and 129). Needs its own brainstorming pass — not part of the 2026-07-19 spec's scope (that one only covers `buildBlocks`/`mergeBlocksToZones`).

Still needs a rebuild+redeploy from a machine with the finished tileset to actually ship the wider county coverage — not done yet.

See "Open feature backlog" section below for a compiled list of every unbuilt feature request across the project (verified against actual code, not just prior handoff claims).

---

**2026-07-16 (night)** — a tester bug report confirmed the Searcher picker globe-view bug was still live in production, despite this doc's earlier claim that a fix had been coded — it hadn't actually landed (only a related race-condition fix, `12c973d`, had). Verified against the real repo, actually fixed this time (`hasFitRef` refit-on-late-arrival in `PickMap.jsx`), plus a second bug from the same report (no way back to the zone picker after marking a zone complete). Both deployed to https://sar-searcher.web.app and pushed as `181d50d`. Also: a zone-quality review with Jack produced diagnosed-but-undesigned notes on algorithm quality, manual zone editing, and hot-zone auto-split — see "Zone-quality review" section below. (The post-dispatch-boundary spec claimed here turned out not to exist — see correction above.) Earlier that day, the park-skip bug was **RESOLVED per Jack's retest**: a fresh Command Center screenshot of a large real West Hollywood→Downtown LA boundary (~158 zones) shows full coverage, no blank gaps, including through park/hillside areas. No further code changes were made for this — the existing `d6a2d45` fix (already in production) appears to hold on this boundary; treat as closed unless it resurfaces.

## Zone-quality review (2026-07-16 night) — brainstorm backlog for next session

Jack reviewed a live 37-zone WeHo/Beverly Hills/Koreatown search (screenshot:
`c:\Users\Jack\Pictures\Screenshots\Screenshot 2026-07-16 222358.png`) and flagged
specific issues plus wants real "AI-assisted" zone judgment, not just constant
tuning. Four independent items were raised. Jack picked **post-dispatch 2nd
boundary** to brainstorm first, but **the spec this doc previously claimed
existed for it was never actually written** (confirmed 2026-07-19 — see the
top correction). It remains fully undesigned; needs its own brainstorming pass
from scratch.

**Algorithm quality was brainstormed and spec'd 2026-07-19, then superseded
2026-07-23** (see top of doc): the original spec's Part B (`refineZoneBoundaries`)
didn't hold up under real-data testing. The replacement —
`docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md`, commit
`2cce29a` — is approved, committed, **not implemented**. Next session's job is
to run *that* spec through `writing-plans` and build it, not to re-brainstorm
it. Part A of the original spec (terrain-aware fetching, Tasks 1-4) is
unaffected and already committed.

The other two are diagnosed but NOT yet brainstormed into a design — pick up
with Jack in order, or as he prioritizes:

1. ~~**Algorithm quality (biggest field impact — do this one next).**~~ Design
   done 2026-07-19, see above. Root causes
   found by reading `subdivider.js`/`overpass.js` directly (screenshot's zone
   numbers, same boundary):
   - **Zone 20 split down the middle by a golf course:** Overpass only ever
     fetches `highway` + `waterway` ways (`overpass.js:80,91`) — no
     `leisure=golf_course`/park/cemetery polygons at all. The course is
     invisible to the algorithm, just "open ground" cost. When a block over it
     needs local refinement (no internal streets to re-polygonize with), it
     falls back to `gridZones` — a dumb rectangular grid (`subdivider.js:325-343`)
     that ignores the feature's real shape. That's the straight cut through the
     course. Fix direction: fetch natural=golf_course/wood/cemetery/leisure
     polygons and either treat them as a single non-splittable region (never
     grid-split across one) or bias region growth to complete one side before
     crossing the feature.
   - **Zone 11 odd/non-rectangular shape:** region growth is greedy BFS toward
     a weight target (`subdivider.js:501-516`) — zero compactness objective.
     Elongated/notched shapes are a natural side effect of the current growth
     rule, not a one-off bug.
   - **Zone 3 much smaller than neighbors:** likely a hard-road-isolated
     compartment hitting the min-1 floor in `allocateZoneCounts` while under
     its own compartment's runt-absorption threshold — runt absorption only
     happens *within* a soft-connected compartment, never across a hard road
     between compartments.
   - **Zone 34 still a sliver:** the final geometric sweep in
     `mergeBlocksToZones` (`subdivider.js:615-621`) intentionally leaves a
     graph-isolated tiny zone standing rather than risk erasing real area —
     this is the 2026-07-16 park-erasure fix's tradeoff working as designed,
     not a regression. Fixing this well probably means giving command a manual
     override (see item 2) rather than chasing the algorithm further.
   - **Zone 12 east border doesn't snap to Vermont Ave:** only
     `motorway/trunk/primary` are hard barriers (`HARD_HIGHWAYS`). Vermont is
     likely tagged `secondary` — just another soft internal street today, no
     "snap zone boundary to named arterial" concept exists at all.
   - Not yet brainstormed into a design — needs the same clarifying-questions
     pass as the boundary spec before writing one.
2. **Manual zone editing** — let command redraw a single zone's polygon by
   hand, before OR after zones are sent to searchers. Confirmed nothing like
   this exists today: `SearchDetail.jsx` only has boundary draw/edit/delete: no
   per-zone geometry editing UI, no Firestore write path for it either.
   Interacts with searcher-app: if a zone is edited after searchers are
   already assigned/in-progress, `watchZone`'s live listener means their view
   updates automatically, but need to decide UX (warn command? auto-notify
   the assigned searcher somehow?).
3. **Hot-zone flag + auto-split** — command flags a zone as high-priority
   (e.g. a new tip came in) and the system auto-subdivides it into smaller
   zones. No existing "hot"/priority concept in the data model — zones only
   have the searcher-facing `status` field
   (unassigned/assigned/in_progress/searched/needs_re_search). Would need: a
   new zone field, a command UI affordance, and a re-subdivision path that
   reuses `buildBlocks`/`mergeBlocksToZones` scoped to just that zone's
   existing polygon — plus a decision on what happens to an already-assigned
   searcher when their zone gets split under them.

## Searcher picker globe-view fix — ACTUALLY fixed + deployed 2026-07-16 night (`181d50d`)

A tester bug report ("wil the search app work" search, Zone 54, Chrome/Android)
confirmed this was still happening live, despite this doc previously claiming
a fix had been coded — checked the repo directly and it hadn't actually
landed: only `12c973d` (a related but different race-condition fix) had.
Real fix this time, verified against current `PickMap.jsx`:

- **Bug:** `searcher-app/src/pick/PickMap.jsx` built the Mapbox map once on
  mount using whatever `zones` prop existed at that instant. Zone data comes
  from an async Firestore listener (`watchZones`), so the first render almost
  always has `zones = []` → `bbox` undefined → map fell back to
  `center:[0,0], zoom:1` (whole-Earth view), and nothing ever re-fit it later.
- **Fix:** `hasFitRef` — first time real zone geometry arrives, calls
  `map.fitBounds()` on it.
- **Second bug from the same report:** after tapping "Zone Complete — tap to
  re-open," there was no way back to the zone-picker grid to claim another
  zone. Fixed in `searcher-app/src/App.jsx`: added a "Pick another zone" link
  to `/pick/${link.searchId}` shown when zone status is `searched`.
- 30/30 tests pass, lint clean (pre-existing unrelated `App.jsx`
  conditional-hooks lint errors confirmed present on `master` before this
  change too — not introduced by it).
- **Deployed** to https://sar-searcher.web.app, pushed to `master` as
  `181d50d`. Jack confirmed "searcher app works" after testing the live
  deploy.
- Follow-up needed next session: the picker's camera-refit is one-shot
  (`hasFitRef` only fits once) — a zone added later from a 2nd boundary won't
  pull the camera to it. Already designed as part of the post-dispatch-
  boundary spec below, just not built yet.

## Formerly-open bug, now resolved — park-skip (2026-07-16 evening entries below, kept for history)

- **What Jack originally saw:** screenshot of an Inglewood/Baldwin Hills-area search (~60 zones), a visible green park polygon with a **totally blank unlabeled gap** in the middle — same symptom as the bug "fixed" earlier that day in `d6a2d45` (Kenneth Hahn boundary, verified clean at the time).
- **Resolution:** Jack retested with a different, larger real boundary (West Hollywood → Downtown LA, ~158 zones, includes hillside/park terrain) in Command Center and confirmed full coverage, no gaps. Treating this as resolved without further code changes; re-open if a gap reappears on any boundary.

## Current state

> **2026-07-26 note:** everything in this section describes what's on `master` / in production. The k-means zone redesign + the three new zone tools are on the **unmerged** branch `zone-tools-and-kmeans` and are NOT reflected below and NOT live.

- **Live sites:** Command Center https://sar-trackhatzolah.web.app (DEPLOYED 2026-07-16 as `d59771c`, includes everything through the park/sliver fix — deployed from the laptop, has street tiles) · Searcher PWA https://sar-searcher.web.app (DEPLOYED 2026-07-16 night as `181d50d`, includes the globe-view + pick-another-zone fixes above). Testers can be pointed at both now.
- **Testing:** `TESTER_BUG_REPORTS.md` in the repo root — a prompt testers paste into their own Claude session to get back a standardized bug report to send Jack.
- **`master` (pushed, everything merged):** command types a total **zone count** (time+mode demoted to a suggester); zones balance **blended search effort** (`area^0.5` per block — dense areas get smaller zones, spread stays bounded; runt/sliver zones absorbed into neighbors); **multiple boundaries** per search (drawable, vertex-editable, deletable); per-boundary generation with independent failure/retry; **street-tile cache** (Jack's precompute idea — prefetched tiles on our hosting first, live Overpass for gaps, **grid zones** as the never-fail floor); zone numbers read **like a page** (north rows first, west→east) across all boundaries; LOD road filtering with an LOD-scaled block-size cap; legacy single-`boundary` searches work via a read shim; zones carry `boundaryId`.
- **Field bugs found & fixed during Jack's smoke tests (all have regression tests):** confetti zones (block cap didn't scale with LOD), monster-zone-plus-slivers (pure block-count balancing), scattered numbering.
- **2026-07-16 third fix, pushed as `d6a2d45`:** Jack's screenshot showed a park with a totally blank gap (no zone at all — literal hole in the map). Root cause: `dissolveSlivers` (from the previous fix) unconditionally dropped any thin isolated block (mean width <25m) regardless of area — fine for a real road median, wrong for a winding park path that carves off a large elongated meadow lobe. First attempt (never drop) fixed the gap but caused a real `turf.union` crash AND a genuine hang in `mergeBlocksToZones` on dense full-LOD boundaries (Westlake, confirmed by isolating pipeline stages with a hard timeout + file-based logging, since console.log buffers under vitest and hides progress before a kill) — hundreds of full-detail micro-fragments surviving into the zone-level sliver sweep could cascade. Final fix: only drop an isolated sliver if it's BOTH under 25m mean width AND under `MIN_ISOLATED_SLIVER_AREA_M2` (500 m² — real noise, nowhere near a real park lobe). Also: `safeUnion` (falls back to `turf.combine` instead of crashing) and the zone-level sweep now leaves an unmergeable tiny zone standing instead of dropping it. Verified on all 4 known boundaries incl. the reported one — zero crashes, zero hangs, zero multi-part, 100-106% coverage. 89 tests green. **Caution for next session:** if you see a `node.exe` process pegged at high CPU for a long time after a test run, check `Get-Process node` for elapsed/CPU before assuming a hang — some completions just have laggy notifications; only kill specific PIDs you can confirm are yours, never `taskkill /IM node.exe` (kills the dev server too).
- **2026-07-16 second fix, pushed as `3e8c896`:** WeHo/Mid-City test (25 requested → only 10 built, one "31 massive" zone, several starved slivers) traced to parks being unsplittable (no internal streets for local refinement to work with) AND, worse, that one outsized region's area/effort was skewing the MEAN used for runt-absorption thresholds, so normal zones next to it got folded together too — that's why the COUNT collapsed, not just one zone. Fixed: `OPEN_GROUND_M_PER_M2` raised 0.005→0.018 (parks now cost about the same as real streets, not ~1/4 — stop discounting them); `buildBlocks` grid-subdivides an oversized block with no internal streets (reuses `grid.js`'s technique) instead of leaving it as one unsplittable zone; runt/area thresholds switched mean→median (resists one outlier distorting them). Caught and fixed a self-introduced regression before commit: the final sliver-sweep's `turf.union` could produce a MultiPolygon on a point-only touch — now requires a real shared edge length. Real-tile retest: 25→26, smooth 0.4-2.8 km² spread, zero multi-part. 88 tests green.
- **2026-07-16, pushed as `2a9cf76`:** walked/driven zone-count suggester REMOVED (suggested 1031 zones for a 50 km² boundary — never useful). `computeZoneCount` + rate constants deleted; count field is a plain input defaulting to 25. 85 tests green. Superseded note below (RUNT_FRACTION suggestion) — the real cause of small pockets was the mean-threshold bug just fixed above, not a threshold tuning need; re-evaluate in the field before touching RUNT_FRACTION.
- **2026-07-15 third pass, pushed as `e495d78`:** Jack's Westwood/BH retest: sizes varied with no visible density difference + bad number sequence. Rework of zone balancing: (1) effort now = full-detail **street meters per block** (`computeBlockEfforts`; `OPEN_GROUND_M_PER_M2` = 0.005 gives parks/open ground effort too, tunable) instead of sqrt(area) — cache tiles are full-detail so this works even when zoning at city LOD; (2) **local LOD refinement**: any block holding more than one zone's share of streets is re-polygonized with full-detail streets in place (dense flats get fine blocks, hillsides stay coarse); (3) zone counts allocated per hard-boxed compartment by effort share (min 1, not sum-exact); (4) region growth capped at 1.5× fair share, big blocks seed their own zones; (5) numbering is **serpentine** (N row W→E, next E→W). Validated: worst zone 76→40 street-km (BH), Westlake 174→174. 90 tests green. Knobs now: `OPEN_GROUND_M_PER_M2`, `MIN_BLOCK_MEAN_WIDTH_M`, `REFINE_EFFORT_FACTOR`, the 1.5× target cap, `RUNT_FRACTION`/`RUNT_AREA_FRACTION` — all in `subdivider.js`.
- **2026-07-15 follow-up, pushed as `8c9b113` (supersedes the zone-level approach in `8f2dd70`):** Jack's retest still showed slivers, plus duplicate zone numbers (multi-part zones). Now fixed at the source: `buildBlocks` dissolves faces under 25m mean width (`MIN_BLOCK_MEAN_WIDTH_M`, tunable — road medians/gores) into the longest-border neighbor BEFORE zoning, keeping adjacency across divided soft roads; multi-part clipped faces split into one block per part; every zone guaranteed one contiguous polygon (multi-part unions split, isolated tiny zones dropped, never teleported). Validated on real tiles: BH/West Adams 25→24, Westwood/BH 21→21, dense Westlake 174→175 with density spread intact — zero slivers, zero multi-part. 82 tests green.
- **2026-07-15 (laptop session), pushed as `8f2dd70`:** median-sliver confetti fix. Jack's Beverly Hills/West Adams test (25 requested → 38 built, many tiny) reproduced WITH the 07-14 fixes in place — different root cause: dual-carriageway medians and corner cutoffs polygonize into slivers walled by hard edges on every side, unreachable by soft-only runt absorption. Fix (all in `mergeBlocksToZones`, 78 tests green): (1) runts with no soft neighbor absorb across a hard edge as last resort; (2) area-based runt check (`RUNT_AREA_FRACTION` = 0.1 of avg region area) catches sqrt-weight-dodging sliver clusters; (3) final geometric sweep folds graph-isolated tiny zones into their touching neighbor. Same boundary now: 25 requested → 23 zones, none under 0.1 km². NOTE: this reverses the old "never absorbs across a hard road even for slivers" test — hard roads remain absolute for non-runt zones only. Desktop: `git pull` before touching zone code.
- **Street tiles downloaded on Jack's DESKTOP only:** 156 tiles / 109MB in `command-center/public/street-tiles/` covering West LA + the LA basin (−118.67,33.70 → −118.15,34.33). **Gitignored — they do NOT travel via git.**
- Telegram bot: still stale (letter-keyed zones, undeployed) and now doubly stale (`boundaryId`). Web picker remains the primary sign-up path.

## Where things live

- **Repo:** https://github.com/FlamekingOPT/sar-command-track — clone to a local path (e.g. `C:\Users\Jack\dev\sar-command-track`), NEVER work in the Drive copy (Drive sync fights npm).
- **This handoff:** `G:\My Drive\SAR\` (syncs across machines).
- Specs/plans: `docs/superpowers/specs/` and `docs/superpowers/plans/` — see the two `2026-07-14-*` pairs for everything built today.

## Working from another computer — checklist

1. `git clone` (or `git pull`) — everything is merged on `master` and pushed.
2. Copy `command-center/.env` from an existing machine (gitignored; has Mapbox token + Firebase config). Laptop and desktop both have it.
3. `firebase login` once per machine (desktop + laptop both authorized as of 2026-07-14).
4. **Street tiles don't come with git.** A copy of the basin tileset (156 files, 109MB, downloaded 2026-07-14) is parked in Drive at **`G:\My Drive\SAR\street-tiles\`**. On the laptop: wait for Drive to finish syncing it, then **copy it OUT of Drive** into the clone at `command-center\public\street-tiles\` (the folder must live inside the repo, and the repo must NOT live inside Drive — Drive sync fights npm). After both machines have the tiles, delete `G:\My Drive\SAR\street-tiles\` so 109MB isn't permanently syncing. Alternative if the Drive copy is gone or stale: `node tools/prefetch-streets.mjs --region basin` rebuilds it in ~40 unattended minutes (resumable, free). Without tiles the app still works — it falls back to live Overpass, then grid zones — but deploys from a tile-less machine strip the cache from production (see gotcha below).
5. `npm install` in `command-center/` (and `searcher-app/` if building it).

## ⚠️ NEW deploy gotcha — street tiles ship with the build

`npm run build` copies `public/street-tiles/` into the deployed bundle. **Deploying from a machine WITHOUT the tiles silently removes the cache from production** (app degrades to live Overpass + grid fallback — works, but loses the reliability win). Before `firebase deploy`, make sure the machine has the tiles (checklist step 4). Old gotchas still apply: creds expire (`firebase login --reauth`), browsers cache the old bundle hard (Ctrl+Shift+R; Searcher PWA needs service-worker unregister), don't chain `cd X && npm run build && cd ..` in PowerShell.

## Next session — START HERE

> **SUPERSEDED 2026-07-26 — use the "FINISH THIS — START HERE" section at the top of this doc instead.** The k-means redesign and all three zone tools listed below as "to build" are now BUILT on branch `zone-tools-and-kmeans` (unmerged). The items below are kept only for the still-open ones (post-dispatch 2nd boundary, zone numbering, motorway crossing, per-boundary count split, multi-day, reassignment, export, Telegram).

0. **Zone-quality backlog** — see "Zone-quality review" section above.
   - ~~**Implement `docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md`**~~ — **DONE 2026-07-26** (branch `zone-tools-and-kmeans`, unmerged). `refineZoneBoundaries` removed, k-means clustering built and wired.
   - The motorway-crossing bug (blocks spanning the 405 before any zone-grouping runs) remains open — see top of doc for the 3 scoped candidate fixes. Pick up whenever Jack prioritizes it.
   - **Post-dispatch 2nd boundary** needs a brainstorming pass from scratch — the spec this doc previously claimed existed for it was never actually written (confirmed 2026-07-19).
   - Manual zone editing, hot-zone auto-split, and the zone-numbering issue (see backlog below) remain undesigned, pick up whenever Jack prioritizes them.
   - County-wide street tiles finished downloading 2026-07-20 (702/702, verified) — still needs a rebuild+redeploy from a machine with the tileset to ship the wider coverage.
1. ~~Deploy the Searcher picker globe-view fix~~ — done 2026-07-16 night, see section above.
2. **Open question Jack flagged (2026-07-14): "zones per boundary."** How the one total count should split across multiple boundaries — today it's proportional to block count (dense boundary gets more). Jack wants to revisit; possible directions: per-boundary count fields, pinning a boundary's count with the rest auto-balancing (options B/C from the 2026-07-14 sizing spec), or a per-boundary preview before generating. Brainstorm with Jack before building.
3. **Deploy** (from a machine WITH the tiles — desktop has them): build command-center + searcher-app one at a time, `firebase deploy --only hosting,firestore:rules`. First deploy uploads ~109MB of tiles — slower than usual.
4. **Weekend (Jack's plan, to save weekday tokens):** `node tools/prefetch-streets.mjs --region county` (LA County-wide tiles, resumable), then rebuild + redeploy. Then real validation: recreate the **Jeanne Missing** search (~150 zones over the LA basin, Scribble Maps reference) and compare zone sizes (~2–3 km² average, small downtown / big hillside).
5. **Tuning knobs if field results disappoint** (constants, no logic changes): `BLOCK_EFFORT_EXPONENT` (0.5; →1 = uniform sizes, →0 = pure density) and `RUNT_FRACTION` (0.25) in `src/zones/subdivider.js`; `DISTRICT_MIN_ZONE_AREA_M2` / `CITY_MIN_ZONE_AREA_M2` / `MAX_FETCH_AREA_M2` in `src/zones/overpass.js`; the 4× block-cap multiplier in `SearchDetail.jsx`.
6. **Backlog:** Telegram bot reconcile-or-retire (old issues: announcement wording, /bind visibility, no persistent host).

## How zone generation works now (one paragraph)

Command draws one or more boundaries and types a zone count (time+mode pre-fills a suggestion). Per boundary: street data loads from our hosted tiles (live Overpass for gaps), gets LOD-filtered by expected zone size, is polygonized into blocks, and the count is split across boundaries proportionally by block count. Each boundary's blocks are grown into equal-block-count zones that never cross motorway/trunk/primary/waterways — dense areas naturally get small zones. Any boundary that can't get street data becomes grid zones with a notice. All zones are then numbered in reading order and written to Firestore with their `boundaryId` (editing/deleting a boundary replaces only its own zones).

## Open feature backlog (compiled 2026-07-19, verified against code — not just prior handoff claims)

**Zone generation**
- Post-dispatch 2nd boundary — undesigned (see correction above; the "committed spec" never existed). **Still open.**
- ~~Zone-growth redesign (compact-first k-means clustering)~~ — **BUILT 2026-07-26**, branch `zone-tools-and-kmeans`, unmerged. Jack: "looks better, we still need to improve it but for now it works" — so further zone-shape quality work is still open, but the greedy-growth→k-means swap itself is done.
- Motorway-crossing blocks (a `buildBlocks`/polygonize topology bug, not a grouping bug) — diagnosed 2026-07-23, 3 candidate fixes scoped, none designed in detail. **Still open**, and confirmed unaffected by the k-means redesign.
- ~~Manual zone editing (command hand-redraws a zone's polygon)~~ — **BUILT 2026-07-26** (vertex dragging on a simplified shape + gap/overlap resolution dialogs), unmerged.
- ~~Hot-zone flag + auto-split~~ — **BUILT 2026-07-26** as "Split" with two entry points (multi-select, or draw a shape with precise-clip remainders), behind `ENABLE_HOT_ZONE_SPLIT`, unmerged. Note: the persisted `hot` flag idea was deliberately dropped — Split is an immediate action, not a flag-then-act workflow.
- ~~Clickable zone list~~ — **BUILT 2026-07-26** (bidirectional list↔map select/highlight/fit, multi-select), unmerged.
- Per-boundary zone-count split (today: proportional by block count) — open question, Jack wants to revisit (see item 2 below).
- Zone numbering doesn't read naturally on large/irregular multi-neighborhood boundaries — undesigned, found 2026-07-20 (see top of doc), needs its own brainstorm.
- Whole-county-scale (~200 zone) single-boundary generation hangs, likely O(n²) block adjacency — undesigned, found 2026-07-20; low priority unless real searches start needing boundaries this large.
- ~~Terrain-aware subdivision (Mapbox Terrain RGB)~~ — superseded, not open: replaced by the OSM street-graph approach shipped 2026-07-13+.

**Command Center**
- Multi-day search support ("New Day" resets assignments, prior days retained) — undesigned/unbuilt. `firebase/searches.js` hardcodes `DAY_ID = 'day-1'`.
- Manual volunteer reassignment (move a zone to a different volunteer, or clear it) — unbuilt. `updateZoneStatus` only ever writes `status`, never `assignedTo`.
- End-of-search export (PDF/GeoJSON of tracks, coverage, markers) — unbuilt, no export code anywhere in `command-center/src`.
- ~~Letter-zone locking~~ — moot: the letter-zone tier it applied to no longer exists (flat numbering shipped 2026-07-13).

**Searcher app**
- True multi-hour wilderness offline capability — explicitly deferred as a "potential future enhancement" in the original PWA spec, never revisited.
- Camera auto-refit for zones added by a later boundary (today's fit is one-shot) — known follow-up, undesigned build-wise.

**Telegram bot**
- Reconcile-or-retire — stale (letter-keyed, now also `boundaryId`-stale), undeployed. Explicitly out-of-scope since 2026-07-13; still just sitting there.

## Deploy / run cheatsheet

```bash
cd C:\Users\Jack\dev\sar-command-track && git pull

# dev server for testing
cd command-center && npm run dev     # http://localhost:5173

# build + deploy (machine must have street tiles!)
cd command-center && npm run build
cd ../searcher-app && npm run build
cd .. && firebase deploy --only hosting,firestore:rules

# street tile prefetch (resumable; regions: westla | basin | county)
node tools/prefetch-streets.mjs --region basin

# bot (local, stale — optional)
cd telegram-bot && npm run dev
```
