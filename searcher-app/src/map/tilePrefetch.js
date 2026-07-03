import mapboxgl from 'mapbox-gl';
import { tilesForBbox, tileUrlsFromTemplate } from './tileMath.js';

// Fetches every tile covering the zone bbox once, in small batches, while the
// device still has signal. The Workbox CacheFirst route caches the responses;
// offline, Mapbox GL requests tiles as usual and the SW serves them (spec §4).
export async function prefetchZoneTiles(map, bbox, zooms = [14, 15, 16, 17]) {
  const tiles = tilesForBbox(bbox, zooms);
  const sources = Object.values(map.getStyle().sources)
    .filter(s => s.type === 'vector' && s.url?.startsWith('mapbox://'));

  for (const source of sources) {
    const tilesetId = source.url.replace('mapbox://', '');
    try {
      const tileJson = await fetch(
        `https://api.mapbox.com/v4/${tilesetId}.json?secure&access_token=${mapboxgl.accessToken}`
      ).then(r => r.json());
      const template = tileJson.tiles?.[0];
      if (!template) continue;
      await fetchInBatches(tileUrlsFromTemplate(template, tiles));
    } catch {
      // No signal or Mapbox hiccup — tiles already viewed are still cached.
    }
  }
}

async function fetchInBatches(urls, batchSize = 10) {
  for (let i = 0; i < urls.length; i += batchSize) {
    await Promise.allSettled(urls.slice(i, i + batchSize).map(u => fetch(u)));
  }
}
