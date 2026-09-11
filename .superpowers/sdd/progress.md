# SDD Progress Ledger � SAR Phase 1 Command Center

Task 1: complete (commit 3e1b907, review clean)
Task 2: complete (commit 7a3779c, review clean)
Task 3: complete (commit 4250688, review clean)
Task 4: complete (commit 87f2497, review clean)
Task 5: complete (commit b28cc7c, review clean)
Task 6: complete (commit c154485, review clean)
Task 7: complete (commit b79dd6a, review clean)
Task 8: complete (commit 0bdae73, review clean)
Task 9: complete (commit 552c6a0, review clean)
Final review fixes: complete (commit 33d2ced, re-review approved)
Phase 1: COMPLETE

# Phase 2 Telegram Bot (inline execution per Jack, 2026-07-03)
Task 1: complete (commit 4943bab)
Pre-existing fix: subdivideZone n<=0 guard restored (ed55caf)
Task 2: complete (commit 4c2ef59, 9/9 command-center tests)
Task 3: complete (commit bc94309)
Task 4: complete (commit 47fdb46)
Task 5: complete (commit 3e70bbe)
Task 6: complete (commit 9a9dcd1)
Task 7: complete (commit 06c337b)
Task 8: complete (commit 2c1d1ae)
Task 9: code complete (index.js, 28/28 tests) — live smoke test pending (needs secrets)
Task 10: Railway deploy — manual, pending
Task 9 smoke test: PASSED 2026-07-03 (sign-up post, /available assignment + DM verified in "Search bot test" group, id -5444874346; searcher links point at localhost placeholder until Plan 3 deploys)
Old test searches closed (kept newest active). Bot .env fully configured locally.
Consolidation: C:\Users\Jack\Desktop\SAR Command recycled; unique WIP saved as .superpowers/wip-barrier-extension.patch (extendPastPolygon never implemented — follow-up task chip created)
Phase 2: CODE COMPLETE — remaining: Task 10 Railway deploy (after Plan 3 provides real searcher URL)

# Phase 3 Searcher PWA (inline execution)
PWA Tasks 1-9: complete (scaffold 42c0afb .. app d79ef5b, 16/16 tests, build OK)
PWA Task 2 note: sar-searcher site created via CLI; rules deployed live 2026-07-03
PWA Task 10: deployed to https://sar-searcher.web.app; bot SEARCHER_APP_URL updated + restarted
Remaining: real-phone airplane-mode smoke test (Jack), Railway bot deploy (plan 2 Task 10)
CC live view + Complete Search button: built, deployed (commit range 24124e4..)
Field test PASSED: GPS 1015 pts, live tracks on CC, zone complete works
PENDING DEPLOY: searcher instant-status fix (committed+pushed, run: firebase deploy --only hosting:searcher)
NEXT: specs for dashboard (Plan 5) + comms/picker (Plan 6) — decisions in Drive handoff doc

# Plan 5 CC Home Dashboard (subagent-driven, 2026-07-03)
Task 1: complete (commits 0cd5f37..c32f380, review approved)
  Minor (deferred to final review): sortSearches comparator returns NaN when two items in one status group both lack createdAt (Infinity - Infinity); no mixed Timestamp/number test case
Task 2: complete (commits c32f380..ceedaf2, review approved, no deferred findings)
Task 3: complete (commits ceedaf2..fafd1a8, review approved)
  Minor (deferred to final review): no hashchange listener (manual URL edits while running don't navigate); deep-link to nonexistent searchId renders silent empty setup view; 'SAR Command' name flash until watchSearch resolves
Task 4: complete (commits fafd1a8..f7d0797, review approved)
  Minor (deferred to final review): none blocking; path-as-comment header in SearchRow (matches plan's code blocks)
Final whole-branch review (fable): NEEDS FIXES -> I1 fixed (79568fe, re-review APPROVED)
  I1 (Important, fixed): readOnly guard added to handleFeatureDrawn — map draw control could write zones into completed searches
  M1-M5 + a-e triaged ship-as-is; hashchange listener spun off as follow-up task chip (task_e2436392)
Plan 5: CODE COMPLETE (commits 0cd5f37..79568fe, 17/17 tests, build+lint clean) — pending: Jack's manual smoke test, then deploy hosting:command-center

# Plan 6 Comms Upgrade (subagent-driven, 2026-07-11)
Task 1: complete (commit ff942f0..5eb28b1, review approved)
  Deploy deferred: firebase CLI not authenticated on this machine; rule committed, will deploy bundled before Task 15 smoke test
Task 2: complete (commits 5eb28b1..05af000, review approved)
Task 3: complete (commits 05af000..c73b4ff, review approved)
Task 4: complete (commits c73b4ff..176cb4c, review approved)
  Minor (deferred to final review): no test asserts exact 5-decimal coordinate formatting; hugeCircle test fixture ring is not closed (harmless since simplify is always mocked in these tests)
Task 5: complete (commits 176cb4c..17a17f7, review approved)
Task 6: complete (commits 17a17f7..81da315, review approved)
  Minor (deferred to final review): letters computation runs even on the map-image path where it's unused (small inefficiency, not a duplication issue)
Task 7: complete (commits 81da315..968604a, review approved; 37/37 tests independently re-confirmed by controller)
Task 8: complete (commits 968604a..5777178, review approved)
Bot-side work (Tasks 1-8) COMPLETE. Moving to searcher-app (Tasks 9-14).
Task 9: complete (commits 5777178..e1e965e, review approved)
Task 10: complete (commits e1e965e..23f10c4, review approved; geometry-parsing consistency with command-center's watchSearch confirmed by controller during plan authoring)
Task 11: complete (commits 23f10c4..4ebf7a8, review approved)
Task 12: complete (commits 4ebf7a8..7f11dd7, review approved)
Task 13: complete (commits 7f11dd7..c107c47, review approved)
Task 14: complete (commits c107c47..ae4f307, review approved)
  Minor (deferred to final review, both inherited verbatim from plan's prescribed code, not implementer deviations): Object.entries(...).sort() relies on default string-coercion sort (happens to work for single-char letter keys); useMemo(getIdentity, []) treated as a once-only guarantee (harmless since getIdentity is idempotent)
All 14 code tasks COMPLETE. Only Task 15 (manual smoke test, needs Jack) and final whole-branch review remain.
Final whole-branch review (opus): WITH FIXES -> I1 fixed (774d0be, verified by controller: diff matches reviewer's exact recommendation, 37/37 tests incl. bind.test.js 3/3)
  I1 (Important, fixed): bind.js used ** (double-asterisk) bold with legacy Markdown parse_mode, which Telegram rejects (400 can't parse entities) -- bind succeeded but confirmation reply silently failed. Fixed: dropped parse_mode entirely, plain text (matches rest of bot).
  M1 (deferred, ship-as-is): zoneRequestWatcher crash between assignZone and resolveRequest could double-assign on bot restart (narrow window, staff can reassign, no transactions is an existing convention)
  M2 (deferred, ship-as-is): PickPage re-prompts for name after a no_availability response (identity read once via useMemo at mount; saveName's write isn't reflected until remount) -- one extra tap, not a data bug
  Deferred findings from Tasks 4/6/14 (mapImage decimal-format test coverage, unclosed test fixture ring, searchWatcher's unused letters computation on the map-image path, PickPage's default-sort/useMemo-once patterns): all triaged ship-as-is by final reviewer
  IMPORTANT SMOKE-TEST NOTE for Task 15: the rich map-image announcement only fires if the search is bound (groupChatId+inviteLink set) BEFORE it's published (searchWatcher's announcedAt guard means binding after publish does NOT retroactively re-announce -- this is correct/intended per spec, not a bug). When running Task 15, bind the group WHILE the search is still in 'setup', before clicking Publish, or you'll only see the plain-text announcement and think something is broken.
Plan 6 CODE COMPLETE (commits ff942f0..774d0be, 37/37 tests, builds clean) -- pending: Task 1's firebase deploy --only firestore:rules (deferred, needs firebase login), Jack's Task 15 manual smoke test (needs bot .env fully configured + real Telegram group + phone)

# Picker UI correction (2026-07-12)
Live-tested Task 14's picker with real Firestore data (seeded+cleaned via scratch script) via headless browser -- found two things: (1) design gap -- PickPage rendered as a plain button grid, not an actual map, contradicting the "clickable map" framing used throughout planning; (2) real bug -- createRequest failure (e.g. permission denied) silently reverted the UI with zero feedback.
Fix: docs/superpowers/specs/2026-07-03-comms-upgrade-design.md §5 corrected to require an actual Mapbox map (commit 7271a76). New searcher-app/src/pick/PickMap.jsx (mirrors SearcherMap.jsx pattern) + PickPage.jsx rewired to render it as full-screen map with fixed-position overlays; createRequest wrapped in try/catch with a requestError banner. Commit 3edf083, reviewed and approved (one self-flagged geometry:null defensive guard, verified legitimate; two Minor notes, ship-as-is: unsplit letter zones render as "full" gray rather than a distinct "not yet available" state; no Mapbox-load-failure UI, pre-existing gap shared with SearcherMap.jsx).
Live-verified the map fix (3edf083) with a real seeded search + Playwright: found and fixed a second real bug -- loadedRef was a plain ref, not state; mutating it inside map.on('load') never re-triggered the source-update effect, so if Firestore zone data arrived before Mapbox finished loading (the common case), the colored zone polygons silently never rendered at all (map showed, but permanently empty). Fixed in 12c973d by converting to mapLoaded state. Re-verified live after the fix: real Mapbox map renders zone A green/available and zone B gray/full with correct labels; tapping A's polygon opens the name prompt; tapping B (full) is correctly a no-op; the createRequest error banner (from the earlier fix) correctly displays since the zoneRequests rule deploy is still pending. Demo search+zones cleaned up from Firestore afterward.

# Zone Algorithm Quality (subagent-driven, 2026-07-20)
Base commit before Task 1: c710975
Task 1: complete (commit dbd21c3, review clean)
Task 2: complete (commit 3c8e83b, review found brief self-contradiction re: footway exclusion in classifyWays -- implementer's resolution was correct, plan corrected to match (554526c), disclosure appended, re-review clean)
Task 3: complete (commit 402f61e, review clean; Minor deferred: untested non-overlapping-terrain and terrainPaths-combo edge cases)
Task 4: complete (commit 201448e, review clean). Part A (feature-aware fetching, Tasks 1-4) COMPLETE.
Task 5: complete (commit dfff3b5, review clean)
Task 6: complete (commit 72d11a9, review clean; implementer proactively fixed a real same-edge dual-direction dead-region data-loss race not in the brief, independently verified by reviewer as correct and a no-op on all 4 tests; 2 Minor non-functional notes on report accuracy/test ordering)
Task 7: ABANDONED (not committed). Wiring refineZoneBoundaries into mergeBlocksToZones broke 7 pre-existing regression tests. Root cause: a genuine formula bug (weightDelta recomputed "fair share" against a shrinking region count on dissolution, mechanically favoring any merge -- reintroduced the exact mean-skewed-by-an-outlier bug the 2026-07-16 median-threshold fix already solved once). Hand-fixed live (fixed fairShare, runt-threshold-gated dissolution, rescaled hard-road penalty) -- got failures down to 2, but empirical validation against a real 143-zone West LA boundary (see below) showed the whole refineZoneBoundaries approach has a low ceiling: it can only rearrange zones greedy growth already grew badly, it can't fix a zone that was bad from the moment it grew. subdivider.js reverted to the clean Task 6 commit (72d11a9) -- refineZoneBoundaries stays in that commit but is superseded, see below.
SUPERSEDED (2026-07-23): Jack proposed inverting the approach entirely -- decide compact, effort-balanced target zones first (k-means clustering on block centroids, weighted by effort, one cluster set per hard-road-isolated compartment so a cluster can never cross a hard road), THEN union real blocks into each cluster, instead of growing zones outward block-by-block with no shape objective. Validated empirically via throwaway Node scripts (command-center/scratch-*.mjs, untracked, kept for reference) against the real West LA boundary: median compactness 0.531->0.586, zones below 0.25 compactness 11->3. Also found and confirmed via the same real-data test: the motorway-crossing bug is NOT in mergeBlocksToZones at all -- 10 of 1324 individual blocks already fully contain a motorway segment before any zone-grouping step runs (a buildBlocks/turf.polygonize topology limitation: motorways are grade-separated, rarely share an exact vertex with the surface grid, so polygonize can't use them as splitting edges away from interchanges). Neither the old growth algorithm nor k-means clustering can fix that -- it needs its own future fix (candidates scoped but not designed: a post-hoc validation/repair pass [recommended], splitting faces against hard lines directly, or snapping hard-line endpoints before polygonize). Jack explicitly accepted this as a known, separate, deferred issue.
New design spec written and approved: docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md (commit 2cce29a). Replaces refineZoneBoundaries entirely (removed, along with isConnected and its 5 scoring constants) with k-means clustering as mergeBlocksToZones' internal region-forming step; restores the original bestHard runt-absorption fallback (nothing else replaces its job now). Tasks 1-5 of the 2026-07-20 plan (terrain-aware fetching, isoperimetricQuotient, road-class adjacency) are UNAFFECTED and stay as committed -- only Tasks 6-7 are superseded.
NEXT SESSION: run the new spec through writing-plans to produce an implementation plan, then execute via subagent-driven-development. subdivider.js is currently at the clean Task-6-committed baseline (commit 72d11a9) -- the new plan's first task should remove refineZoneBoundaries/isConnected/its constants and restore bestHard before adding the k-means clustering code.
