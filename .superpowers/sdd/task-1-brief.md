### Task 1: Add terrain-feature and path/footway tags to both Overpass queries

**Files:**
- Modify: `command-center/src/zones/overpass.js:76-83` (`buildQuery`)
- Modify: `tools/prefetch-streets.mjs:61-66` (`query`)
- Test: `command-center/test/zones/overpass.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildQuery(bbox, detail)` — same signature, larger query string. No exported symbol changes.

- [ ] **Step 1: Write the failing test**

Add to `command-center/test/zones/overpass.test.js`, right after the existing `describe('fetchStreetGraph level of detail', ...)` block (after line 137):

```js
describe('buildQuery terrain-feature and path tags', () => {
  const boundary = turf.polygon([[
    [-118.30, 34.00], [-118.29, 34.00], [-118.29, 34.01], [-118.30, 34.01], [-118.30, 34.00],
  ]]);

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ elements: [] }) });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('always requests golf/park/cemetery/wood polygons and path/footway ways, regardless of detail', async () => {
    await fetchStreetGraph(boundary, { detail: 'city' });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.body).toContain('leisure"~"golf_course|park');
    expect(options.body).toContain('landuse"~"cemetery');
    expect(options.body).toContain('natural"~"wood');
    expect(options.body).toContain('highway"~"path|footway');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js -t "terrain-feature"`
Expected: FAIL — `options.body` does not contain `'leisure"~"golf_course|park'`.

- [ ] **Step 3: Implement — extend `buildQuery` in `overpass.js`**

Replace lines 76-83:

```js
function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;
}
```

with:

```js
// Terrain features (2026-07-19 zone-algorithm-quality spec, issue #1): parks/
// golf courses/cemeteries/wood are invisible to the algorithm without these —
// a block containing one falls back to a blind grid split instead of
// following the feature's real shape (field bug: a golf course cut in half by
// a straight grid line). Fetched at every detail level, not gated by
// DETAIL_LEVELS, since they matter to local refinement regardless of zoning
// LOD. highway=path|footway rides along so a feature's internal paths are
// available too — see buildBlocks' local-refinement branch (Task 3).
function buildQuery([west, south, east, north], detail) {
  return `[out:json][timeout:25];
(
  way["highway"~"${DETAIL_LEVELS[detail]}"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
  way["leisure"~"golf_course|park"](${south},${west},${north},${east});
  way["landuse"~"cemetery"](${south},${west},${north},${east});
  way["natural"~"wood"](${south},${west},${north},${east});
  way["highway"~"path|footway"](${south},${west},${north},${east});
);
out geom;`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd command-center && npx vitest run test/zones/overpass.test.js -t "terrain-feature"`
Expected: PASS

- [ ] **Step 5: Manually update the cache-prep script to match**

`tools/prefetch-streets.mjs` has no test suite (standalone Node script, confirmed no existing test file references it). Replace lines 61-66:

```js
const query = ([west, south, east, north]) => `[out:json][timeout:60];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;
```

with:

```js
// Keep in sync with command-center/src/zones/overpass.js's buildQuery — the
// cache tile scheme requires identical tag coverage (2026-07-19 zone-
// algorithm-quality spec, issue #1: terrain features + internal paths).
const query = ([west, south, east, north]) => `[out:json][timeout:60];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
  way["leisure"~"golf_course|park"](${south},${west},${north},${east});
  way["landuse"~"cemetery"](${south},${west},${north},${east});
  way["natural"~"wood"](${south},${west},${north},${east});
  way["highway"~"path|footway"](${south},${west},${north},${east});
);
out geom;`;
```

Verify by reading the two query strings side by side — every `way[...]` clause in `overpass.js`'s new `buildQuery` (except the `${DETAIL_LEVELS[detail]}` interpolation, which `prefetch-streets.mjs` intentionally hardcodes to the `full` tier since it always prefetches full detail) must appear in `prefetch-streets.mjs`'s `query`.

- [ ] **Step 6: Run the full test suite**

Run: `cd command-center && npx vitest run`
Expected: all tests PASS (no regressions from the added query clauses — nothing else parses `buildQuery`'s output at this point).

- [ ] **Step 7: Commit**

```bash
git add command-center/src/zones/overpass.js tools/prefetch-streets.mjs command-center/test/zones/overpass.test.js
git commit -m "feat(cc): fetch terrain features and paths for zone splitting"
```

---

