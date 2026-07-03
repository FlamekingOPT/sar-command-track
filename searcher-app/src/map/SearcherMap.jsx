import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import { prefetchZoneTiles } from './tilePrefetch';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const EMPTY = turf.featureCollection([]);

export function SearcherMap({ zonePolygon, points = [], markers = [], onMapTap }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const loadedRef = useRef(false);
  const onMapTapRef = useRef(onMapTap);
  useEffect(() => { onMapTapRef.current = onMapTap; }, [onMapTap]);

  useEffect(() => {
    const bbox = turf.bbox({ type: 'Feature', geometry: zonePolygon, properties: {} });
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      bounds: bbox,
      fitBoundsOptions: { padding: 40 },
    });

    map.on('load', () => {
      map.addSource('zone', { type: 'geojson', data: { type: 'Feature', geometry: zonePolygon, properties: {} } });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zone',
        paint: { 'line-color': '#1d4ed8', 'line-width': 3 } });

      map.addSource('coverage', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'coverage-fill', type: 'fill', source: 'coverage',
        paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.25 } });

      map.addSource('path', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'path-line', type: 'line', source: 'path',
        paint: { 'line-color': '#16a34a', 'line-width': 3 } });

      map.addSource('markers', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'markers-dots', type: 'circle', source: 'markers',
        paint: { 'circle-radius': 8, 'circle-color': '#ef4444', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

      map.addSource('position', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'position-dot', type: 'circle', source: 'position',
        paint: { 'circle-radius': 7, 'circle-color': '#1d4ed8', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });

      loadedRef.current = true;
      prefetchZoneTiles(map, bbox); // fire-and-forget: cache zone tiles while we have signal
    });

    map.on('click', e => onMapTapRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat }));

    mapRef.current = map;
    return () => { loadedRef.current = false; map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Path + coverage + current position
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    if (points.length >= 2) {
      const line = turf.lineString(points.map(p => [p.lng, p.lat]));
      map.getSource('path')?.setData(line);
      map.getSource('coverage')?.setData(turf.buffer(line, 0.02, { units: 'kilometers' }));
    }
    if (points.length >= 1) {
      const last = points[points.length - 1];
      map.getSource('position')?.setData(turf.point([last.lng, last.lat]));
    }
  }, [points]);

  // Markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    map.getSource('markers')?.setData(
      turf.featureCollection(markers.map(m => turf.point([m.lng, m.lat], { note: m.note })))
    );
  }, [markers]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
