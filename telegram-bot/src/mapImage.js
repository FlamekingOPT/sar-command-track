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
