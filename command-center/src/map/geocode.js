// Parses a Mapbox Geocoding v5 response into the shape the app stores.
// Split from the fetch call so it's unit-testable without a network mock.
export function parseGeocodeResponse(json, address) {
  const feature = json?.features?.[0];
  if (!feature) throw new Error(`Couldn't find that address: ${address}`);
  const [lng, lat] = feature.center;
  return { address, lat, lng, placeName: feature.place_name };
}

export async function geocodeAddress(address) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Geocoding request failed (${resp.status})`);
  const json = await resp.json();
  return parseGeocodeResponse(json, address);
}
