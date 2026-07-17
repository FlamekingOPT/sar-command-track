import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = turf.featureCollection([]);
const AVAILABLE_COLOR = '#22c55e';
const FULL_COLOR = '#9ca3af';

const ASSIGNABLE_STATUSES = ['unassigned', 'needs_re_search'];

export function PickMap({ zones, onZoneClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const onZoneClickRef = useRef(onZoneClick);
  // State (not a ref) so the source-update effect below re-runs once the map
  // finishes loading — a ref mutation inside `map.on('load', ...)` wouldn't
  // re-trigger that effect, so if Firestore data arrives before the map does
  // (the common case), the zone layer would otherwise stay empty forever.
  const [mapLoaded, setMapLoaded] = useState(false);
  const hasFitRef = useRef(false);
  useEffect(() => { onZoneClickRef.current = onZoneClick; }, [onZoneClick]);

  useEffect(() => {
    const zonesWithGeometry = zones.filter(z => z.polygon);
    const fc = turf.featureCollection(
      zonesWithGeometry.map(z => ({ type: 'Feature', geometry: z.polygon, properties: { id: z.id } }))
    );
    const bbox = fc.features.length ? turf.bbox(fc) : undefined;
    hasFitRef.current = !!bbox;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      ...(bbox ? { bounds: bbox, fitBoundsOptions: { padding: 40 } } : { center: [0, 0], zoom: 1 }),
    });

    map.on('load', () => {
      map.addSource('zones', { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.45 },
      });
      map.addLayer({
        id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#1f2937', 'line-width': 2 },
      });
      map.addLayer({
        id: 'zones-labels', type: 'symbol', source: 'zones',
        layout: { 'text-field': ['get', 'number'], 'text-size': 20, 'text-allow-overlap': true },
        paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      });

      map.on('click', 'zones-fill', e => {
        const id = e.features[0]?.properties?.id;
        if (id) onZoneClickRef.current?.(id);
      });
      map.on('mouseenter', 'zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'zones-fill', () => { map.getCanvas().style.cursor = ''; });

      setMapLoaded(true);
    });

    mapRef.current = map;
    return () => { setMapLoaded(false); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const zonesWithGeometry = zones.filter(z => z.polygon);
    map.getSource('zones')?.setData(
      turf.featureCollection(
        zonesWithGeometry.map(z => ({
          type: 'Feature',
          geometry: z.polygon,
          properties: {
            id: z.id,
            number: z.number,
            color: ASSIGNABLE_STATUSES.includes(z.status) ? AVAILABLE_COLOR : FULL_COLOR,
          },
        }))
      )
    );
    // Zones arrive via an async Firestore listener, so the map is often built
    // (see the mount effect above) before any geometry exists — camera falls
    // back to a whole-Earth view. Once real geometry shows up, snap to it.
    if (!hasFitRef.current && zonesWithGeometry.length) {
      hasFitRef.current = true;
      const bbox = turf.bbox(turf.featureCollection(
        zonesWithGeometry.map(z => ({ type: 'Feature', geometry: z.polygon, properties: {} }))
      ));
      map.fitBounds(bbox, { padding: 40, duration: 0 });
    }
  }, [zones, mapLoaded]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
