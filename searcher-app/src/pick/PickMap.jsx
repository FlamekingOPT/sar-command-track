import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = turf.featureCollection([]);
const AVAILABLE_COLOR = '#22c55e';
const FULL_COLOR = '#9ca3af';

export function PickMap({ letterZones, availability, onZoneClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const onZoneClickRef = useRef(onZoneClick);
  // State (not a ref) so the source-update effect below re-runs once the map
  // finishes loading — a ref mutation inside `map.on('load', ...)` wouldn't
  // re-trigger that effect, so if Firestore data arrives before the map does
  // (the common case), the zone layer would otherwise stay empty forever.
  const [mapLoaded, setMapLoaded] = useState(false);
  useEffect(() => { onZoneClickRef.current = onZoneClick; }, [onZoneClick]);

  useEffect(() => {
    const zonesWithGeometry = letterZones.filter(z => z.geometry);
    const fc = turf.featureCollection(
      zonesWithGeometry.map(z => ({ type: 'Feature', geometry: z.geometry, properties: { letter: z.letter } }))
    );
    const bbox = fc.features.length ? turf.bbox(fc) : undefined;
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
        layout: { 'text-field': ['get', 'letter'], 'text-size': 24, 'text-allow-overlap': true },
        paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      });

      map.on('click', 'zones-fill', e => {
        const letter = e.features[0]?.properties?.letter;
        if (letter) onZoneClickRef.current?.(letter);
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
    map.getSource('zones')?.setData(
      turf.featureCollection(
        letterZones.filter(z => z.geometry).map(z => ({
          type: 'Feature',
          geometry: z.geometry,
          properties: {
            letter: z.letter,
            color: availability[z.letter] === 'available' ? AVAILABLE_COLOR : FULL_COLOR,
          },
        }))
      )
    );
  }, [letterZones, availability, mapLoaded]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
