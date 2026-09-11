import * as turf from '@turf/turf';

// Mapbox Draw hands back whatever the user dragged — including rings that
// cross themselves or collapse to a sliver. Reject those before they reach
// Firestore: a self-intersecting zone breaks the containment and area math
// the searcher app and the numbering pass both rely on.
export function validateZonePolygon(geometry) {
  if (!geometry || geometry.type !== 'Polygon') {
    return { ok: false, error: 'A zone has to stay a single polygon.' };
  }
  const ring = geometry.coordinates?.[0];
  if (!Array.isArray(ring)) return { ok: false, error: 'A zone has to stay a single polygon.' };

  // Draw normally closes the ring itself; close it here anyway so a hand-built
  // or half-saved feature is fixed instead of thrown away.
  const closed = ringIsClosed(ring) ? ring : [...ring, ring[0]];
  if (closed.length < 4) return { ok: false, error: 'A zone needs at least three corners.' };

  const feature = turf.polygon([closed, ...geometry.coordinates.slice(1)]);
  if (turf.kinks(feature).features.length) {
    return { ok: false, error: 'Zone edges cross themselves — untangle the shape before saving.' };
  }
  if (turf.area(feature) < 1) return { ok: false, error: 'That shape has no area.' };

  return { ok: true, geometry: feature.geometry };
}

function ringIsClosed(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1];
}

// The zone-count box means "zones for the boundaries I'm generating right now",
// NOT a running total for the search. Subtracting zones that already exist (the
// pre-2026-09-10 behaviour) made a second boundary collapse to a single zone:
// asking for 20 more when 25 already existed computed max(1, 20-25) = 1.
export function zonesToGenerate(entered) {
  return Math.max(1, Math.round(Number(entered) || 0));
}
