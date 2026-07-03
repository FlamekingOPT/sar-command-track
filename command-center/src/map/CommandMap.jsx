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

export function CommandMap({ drawMode, onFeatureDrawn, boundary = null, letterZones = [], subZones = [], osmBarriers = [], tracks = [], liveMarkers = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);
  const onFeatureDrawnRef = useRef(onFeatureDrawn);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { onFeatureDrawnRef.current = onFeatureDrawn; }, [onFeatureDrawn]);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-118.25, 34.05],
      zoom: 11,
    });
    const draw = new MapboxDraw({ displayControlsDefault: false, controls: { polygon: true, trash: true } });
    map.addControl(draw);
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('boundary', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-dasharray': [4, 2] } });

      map.addSource('letter-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'letter-zones-fill', type: 'fill', source: 'letter-zones',
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'letter-zones-line', type: 'line', source: 'letter-zones',
        paint: { 'line-color': '#1d4ed8', 'line-width': 2 } });
      map.addLayer({ id: 'letter-zones-labels', type: 'symbol', source: 'letter-zones',
        layout: {
          'text-field': ['get', 'letter'],
          'text-size': 22,
          'text-font': ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
          'text-anchor': 'center',
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#1e3a8a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

      map.addSource('sub-zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'sub-zones-fill', type: 'fill', source: 'sub-zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'sub-zones-line', type: 'line', source: 'sub-zones',
        paint: { 'line-color': '#374151', 'line-width': 1 } });
      map.addLayer({ id: 'sub-zones-labels', type: 'symbol', source: 'sub-zones',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

      map.addSource('osm-barriers', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'osm-roads', type: 'line', source: 'osm-barriers',
        filter: ['==', ['get', 'barrierType'], 'road'],
        paint: { 'line-color': '#6b7280', 'line-width': 1.5, 'line-opacity': 0.7 } });
      map.addLayer({ id: 'osm-waterways', type: 'line', source: 'osm-barriers',
        filter: ['==', ['get', 'barrierType'], 'waterway'],
        paint: { 'line-color': '#60a5fa', 'line-width': 2, 'line-opacity': 0.8 } });

      map.addSource('tracks', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks',
        paint: { 'line-color': '#16a34a', 'line-width': 3, 'line-opacity': 0.9 } });

      map.addSource('searcher-positions', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'searcher-positions-dot', type: 'circle', source: 'searcher-positions',
        paint: { 'circle-radius': 7, 'circle-color': '#16a34a', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });

      map.addSource('live-markers', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'live-markers-dot', type: 'circle', source: 'live-markers',
        paint: { 'circle-radius': 8, 'circle-color': '#ef4444', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      map.addLayer({ id: 'live-markers-labels', type: 'symbol', source: 'live-markers',
        layout: {
          'text-field': ['get', 'note'],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
        },
        paint: { 'text-color': '#991b1b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
    });

    map.on('draw.create', e => {
      const type = drawModeRef.current === 'boundary' ? 'boundary' : 'letter_zone';
      onFeatureDrawnRef.current?.(e.features[0], type);
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
    map.getSource('boundary')?.setData(
      boundary
        ? turf.featureCollection([{ type: 'Feature', geometry: boundary, properties: {} }])
        : turf.featureCollection([])
    );
  }, [boundary]);

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
    map.getSource('osm-barriers')?.setData(turf.featureCollection(osmBarriers));
  }, [osmBarriers]);

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

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const lines = tracks
      .filter(t => t.points?.length >= 2)
      .map(t => turf.lineString(t.points.map(p => [p.lng, p.lat]), { volunteerId: t.volunteerId }));
    map.getSource('tracks')?.setData(turf.featureCollection(lines));
    const positions = tracks
      .filter(t => t.points?.length >= 1)
      .map(t => turf.point(
        [t.points[t.points.length - 1].lng, t.points[t.points.length - 1].lat],
        { volunteerId: t.volunteerId }
      ));
    map.getSource('searcher-positions')?.setData(turf.featureCollection(positions));
  }, [tracks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    map.getSource('live-markers')?.setData(
      turf.featureCollection(liveMarkers.map(m => turf.point([m.lng, m.lat], { note: m.note ?? '' })))
    );
  }, [liveMarkers]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
}
