// Prefetch full-detail Overpass street data into static hosting tiles.
// (spec: docs/superpowers/specs/2026-07-14-street-tile-cache-design.md)
//
//   node tools/prefetch-streets.mjs --region westla|basin|county
//   node tools/prefetch-streets.mjs --bbox -118.50,33.99,-118.32,34.11
//
// Resumable: already-downloaded tiles are skipped, so re-running after a
// failure (or to grow coverage) only fetches what's missing. Patient by
// design — search-time code gets 20s and 2 endpoints; here we take 5
// attempts with backoff because nobody is waiting in a parking lot.
// Tile scheme MUST match cacheTileKeys in command-center/src/zones/overpass.js.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TILE_SIZE_DEG = 0.05;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'command-center', 'public', 'street-tiles');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const REGIONS = {
  westla: [-118.50, 33.99, -118.32, 34.11],
  basin:  [-118.67, 33.70, -118.15, 34.33],
  county: [-118.95, 33.60, -117.65, 34.85],
};
const ATTEMPTS = 5;
const INTER_TILE_DELAY_MS = 2000;

function parseArgs() {
  const args = process.argv.slice(2);
  const regionIdx = args.indexOf('--region');
  if (regionIdx !== -1) {
    const bbox = REGIONS[args[regionIdx + 1]];
    if (!bbox) { console.error(`Unknown region. Options: ${Object.keys(REGIONS).join(', ')}`); process.exit(1); }
    return bbox;
  }
  const bboxIdx = args.indexOf('--bbox');
  if (bboxIdx !== -1) {
    const parts = args[bboxIdx + 1].split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
  }
  console.error('Usage: node tools/prefetch-streets.mjs --region westla|basin|county  (or --bbox w,s,e,n)');
  process.exit(1);
}

function tiles([west, south, east, north]) {
  const out = [];
  for (let iy = Math.floor(south / TILE_SIZE_DEG); iy <= Math.floor(north / TILE_SIZE_DEG); iy++) {
    for (let ix = Math.floor(west / TILE_SIZE_DEG); ix <= Math.floor(east / TILE_SIZE_DEG); ix++) {
      out.push({
        key: `tile_${ix}_${iy}`,
        bbox: [ix * TILE_SIZE_DEG, iy * TILE_SIZE_DEG, (ix + 1) * TILE_SIZE_DEG, (iy + 1) * TILE_SIZE_DEG],
      });
    }
  }
  return out;
}

const query = ([west, south, east, north]) => `[out:json][timeout:60];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified"](${south},${west},${north},${east});
  way["waterway"~"river|canal|stream"](${south},${west},${north},${east});
);
out geom;`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchTile(bbox) {
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      // Overpass etiquette for scripted access: identify yourself with a real
      // User-Agent (default Node UA gets 406'd by overpass-api.de) and send
      // the query as form data.
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'sar-command-track-prefetch/1.0 (SAR zone precompute; github.com/FlamekingOPT/sar-command-track)',
        },
        body: 'data=' + encodeURIComponent(query(bbox)),
      });
      if (!resp.ok) throw new Error(`${endpoint} → ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data.elements)) throw new Error('malformed response');
      return data;
    } catch (err) {
      lastErr = err;
      const backoff = 10_000 * (attempt + 1);
      console.log(`    retry ${attempt + 1}/${ATTEMPTS} in ${backoff / 1000}s (${err.message})`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

const bbox = parseArgs();
const all = tiles(bbox);
await mkdir(OUT_DIR, { recursive: true });
console.log(`${all.length} tiles → ${OUT_DIR}`);

let done = 0, skipped = 0, failed = 0;
for (const t of all) {
  done++;
  const file = join(OUT_DIR, `${t.key}.json`);
  const exists = await access(file).then(() => true, () => false);
  if (exists) { skipped++; console.log(`tile ${done}/${all.length} ${t.key} (skipped)`); continue; }
  try {
    const data = await fetchTile(t.bbox);
    const body = JSON.stringify({ elements: data.elements });
    await writeFile(file, body);
    console.log(`tile ${done}/${all.length} ${t.key} (ok ${(body.length / 1e6).toFixed(1)}MB, ${data.elements.length} ways)`);
  } catch (err) {
    failed++;
    console.log(`tile ${done}/${all.length} ${t.key} (FAILED after ${ATTEMPTS} attempts: ${err.message})`);
  }
  await sleep(INTER_TILE_DELAY_MS);
}
console.log(`Done. ${all.length - skipped - failed} downloaded, ${skipped} skipped, ${failed} failed${failed ? ' — re-run to retry' : ''}.`);
process.exit(failed ? 1 : 0);
