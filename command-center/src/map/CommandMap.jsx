import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const STATUS_COLORS = {
  unassigned: '#9ca3af', assigned: '#3b82f6',
  in_progress: '#f59e0b', searched: '#22c55e', needs_re_search: '#ef4444',
};

export function CommandMap({ drawMode, onFeatureDrawn, letterZones = [], subZones = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center: [-118.25, 34.05],
      zoom: 11,
    });
    const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true } });
    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('letter-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'letter-zones-fill', type: 'fill', source: 'letter-zones',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'letter-zones-line', type: 'line', source: 'letter-zones',
        paint: { 'line-color': '#1d4ed8', 'line-width': 2 } });

      map.addSource('sub-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'sub-zones-fill', type: 'fill', source: 'sub-zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'sub-zones-line', type: 'line', source: 'sub-zones',
        paint: { 'line-color': '#374151', 'line-width': 1 } });
    });

    map.on('draw.create', e => {
      const type = drawModeRef.current === 'boundary' ? 'boundary' : 'letter_zone';
      onFeatureDrawn?.(e.features[0], type);
      draw.deleteAll();
    });

    mapRef.current = map;
    drawRef.current = draw;
    return () => map.remove();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.changeMode(drawMode === 'idle' ? 'simple_select' : 'draw_polygon');
  }, [drawMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('letter-zones')?.setData(
      turf.featureCollection(letterZones.map(z => ({ ...z.feature, properties: { letter: z.letter } })))
    );
  }, [letterZones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('sub-zones')?.setData(
      turf.featureCollection(subZones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { label: `${z.letter}${z.number}`, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
  }, [subZones]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
}
