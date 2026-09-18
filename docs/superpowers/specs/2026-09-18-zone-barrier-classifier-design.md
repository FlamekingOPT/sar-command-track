# Zone barrier classifier — design

**Status:** approved, not yet implemented. Standalone project, separate repo from `sar-command-track`.

## Why

Every attempt at street-aware zone generation in `sar-command-track` (greedy growth, k-means clustering, hard-barrier splitting) failed for the same underlying reason: the system has no reliable way to tell a *real* hard break (a freeway, a genuine barrier a searcher can't cross) from OSM tagging noise (LA's dense arterials — Manchester, Century, Rosecrans — tagged `primary`, same as this data used elsewhere, or a golf course treated as ordinary open ground). The 2026-09-17 session gave up and rolled zone generation back to a plain even grid rather than keep tuning a barrier whitelist by hand.

This project targets that specific weak link: a small, interpretable classifier that scores whether a given road/feature segment is a real barrier for zone-splitting purposes. It does **not** attempt to generate zone shapes itself — that stays a separate, later decision. See `docs/superpowers/specs/2026-07-23-zone-growth-redesign-design.md` and the 2026-09-17 handoff entry for the failed prior attempts this is meant to fix the root cause of.

## Scope

**In scope:**
- A standalone repo (e.g. `sar-zone-barriers`), Python, no dependency on or deploy path into `sar-command-track` or its production Firebase project.
- Ingest cached OSM tiles already downloaded by `sar-command-track` (`public/street-tiles/`, 702 tiles, LA county) — read-only, no new fetching required to get started.
- Seed a labeled dataset from corrections already documented in `sar-command-track`'s handoff history (Vermont Ave should be a break, the three false-primary arterials should not, the Hollywood Hills golf course is a non-splittable area barrier, etc.).
- A local, single-user labeling tool (static web page, Leaflet-based) to grow that dataset by hand against real boundaries.
- Train a small interpretable model (logistic regression or shallow decision tree) over engineered per-segment features.
- Evaluate via cross-validation (dataset will stay small — dozens to low hundreds of examples, not enough for a trustworthy held-out split).
- Export the trained model as a plain, hand-inspectable JSON ruleset.

**Out of scope:**
- Reintegrating the ruleset into `command-center`'s zone generator. That's a separate future decision — this project's deliverable is a ruleset file, not a shipped feature.
- Zone shape generation, clustering, or region-growing of any kind.
- Any production deploy, Firebase project, or shared infrastructure.

## Data ingestion

A script reads `sar-command-track/public/street-tiles/*.json` (or whatever the actual cached tile format is — confirm during implementation) and extracts every way/feature into a flat table:

- `id`, raw OSM tags (`highway`, `name`, `lanes`, `leisure`, etc.)
- geometry (linestring for roads, polygon for area features like parks/golf courses)
- derived features: segment length, whether it's linear (road) vs. areal (park/golf/cemetery boundary), and simple structural signals like whether it sits between two otherwise-dense block clusters (a proxy for "this looks like a real dividing line" vs. "this is just another residential street").

## Seed labels

A script encodes the specific, already-documented corrections as labeled rows before any manual labeling happens:

| Example | Label | Why (from handoff history) |
|---|---|---|
| Vermont Ave (tagged `secondary`) | real break | Command wanted zone boundaries to snap to it; today only `motorway/trunk/primary` count as hard, so it's invisible |
| Manchester / Century / Rosecrans (tagged `primary`) | NOT a hard break | Treating all `primary` as hard exploded a 12-zone boundary into 117 zones — LA tags ordinary arterials this way |
| Hollywood Hills golf course (`leisure=golf_course`) | non-splittable area barrier | A block spanning it fell back to a dumb rectangular grid, cutting straight through the course |

This gives the model a non-empty, correctness-anchored starting point instead of starting from zero.

## Labeling tool

A static local web page (Leaflet, reading the extracted tile data directly, no backend):

- Load a boundary (or a whole tile) and render its road segments and area features as clickable shapes.
- Click a segment → choose a label: **hard break** / **soft break** / **not a break**, with an optional free-text note (mirrors the "why" already present in the handoff's own corrections, so future review has the same context).
- A "Save" action writes/appends to a local JSON labels file. No database, no server — single user, offline tool.
- Designed to be re-run against new real boundaries whenever a future zone-quality problem gets diagnosed, so the dataset keeps growing organically instead of requiring a dedicated labeling effort up front.

## Model

A small, interpretable classifier — logistic regression or a shallow decision tree over the engineered features from ingestion. Deliberately not a black box: with a dataset this small (dozens to low hundreds of examples), interpretability matters more than squeezing out accuracy, and an interpretable model is what makes hand-inspection of the exported ruleset possible.

## Evaluation

Given the small dataset, use k-fold (or leave-one-out) cross-validation rather than a fixed train/test split — a held-out set that small wouldn't be trustworthy on its own.

Concrete success criteria:
1. The model correctly classifies every seeded historical correction (Vermont Ave, the three false-primary arterials, the golf course) under cross-validation.
2. The exported ruleset's decision logic (coefficients or tree rules) is inspected by hand and judged to reflect real signal — not spurious correlation — before being considered "done."

## Output

The trained model exports to a plain JSON file: either explicit rules (if a decision tree) or a feature list + weights (if logistic regression) — small enough to read directly and simple enough to reimplement as a short, dependency-free scoring function in JavaScript later, without needing Python in production.

## Explicitly deferred

Whether and how this ruleset ever gets wired into `command-center`'s zone generator is a separate, later decision, made only after this project proves the classifier actually works — not assumed as this project's endpoint.
