import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import * as turf from '@turf/turf';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const STATUS_COLORS = {
  unassigned: '#9ca3af', assigned: '#3b82f6',
  in_progress: '#f59e0b', searched: '#22c55e', needs_re_search: '#ef4444',
};

export function CommandMap({ drawMode, onFeatureDrawn, boundaries = [], editable = false, onBoundaryEdited, onBoundaryDeleted, zones = [], tracks = [], liveMarkers = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);
  const onFeatureDrawnRef = useRef(onFeatureDrawn);
  // State (not a ref/isStyleLoaded check) so the data effects below re-run once
  // the map + sources are ready. Firestore data usually arrives before the map
  // finishes loading; without this the effects return early and never retry,
  // leaving every overlay (boundary, zones, tracks) empty.
  const [mapLoaded, setMapLoaded] = useState(false);

  const onBoundaryEditedRef = useRef(onBoundaryEdited);
  const onBoundaryDeletedRef = useRef(onBoundaryDeleted);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { onFeatureDrawnRef.current = onFeatureDrawn; }, [onFeatureDrawn]);
  useEffect(() => { onBoundaryEditedRef.current = onBoundaryEdited; }, [onBoundaryEdited]);
  useEffect(() => { onBoundaryDeletedRef.current = onBoundaryDeleted; }, [onBoundaryDeleted]);

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
    map.addControl(new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl,
      marker: true,
      placeholder: 'Search address...',
    }), 'top-left');

    map.on('load', () => {
      map.addSource('boundary', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } });
      map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-dasharray': [4, 2] } });

      map.addSource('zones', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#374151', 'line-width': 1.5 } });
      map.addLayer({ id: 'zones-labels', type: 'symbol', source: 'zones',
        layout: {
          'text-field': ['get', 'number'],
          'text-size': 16,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

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

      setMapLoaded(true); // sources + layers now exist — let the data effects push
    });

    // No deleteAll after create: the boundaries/editable sync effect below
    // reconciles Draw against the boundaries prop (stable feature ids make
    // the echo-back idempotent); deleting here would wipe other boundaries.
    map.on('draw.create', e => {
      onFeatureDrawnRef.current?.(e.features[0]);
    });
    map.on('draw.update', e => {
      for (const f of e.features) onBoundaryEditedRef.current?.({ id: String(f.id), geometry: f.geometry });
    });
    map.on('draw.delete', e => {
      for (const f of e.features) onBoundaryDeletedRef.current?.(String(f.id));
    });

    mapRef.current = map;
    drawRef.current = draw;
    return () => { setMapLoaded(false); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.changeMode(drawMode === 'idle' ? 'simple_select' : 'draw_polygon');
  }, [drawMode]);

  // Boundaries live INSIDE Mapbox Draw while editable (giving click-to-select
  // and vertex editing for free); on completed searches they render read-only
  // on the plain geojson source. draw.set is idempotent — echoing the prop
  // back after a create/update round-trips through the parent without flicker
  // because feature ids are stable.
  useEffect(() => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw || !mapLoaded) return;
    const features = boundaries.map(b => ({ type: 'Feature', id: b.id, geometry: b.geometry, properties: {} }));
    if (editable) {
      draw.set({ type: 'FeatureCollection', features });
      map.getSource('boundary')?.setData(turf.featureCollection([]));
    } else {
      draw.set({ type: 'FeatureCollection', features: [] });
      map.getSource('boundary')?.setData(turf.featureCollection(
        boundaries.map(b => ({ type: 'Feature', geometry: b.geometry, properties: {} }))
      ));
    }
  }, [boundaries, editable, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('zones')?.setData(
      turf.featureCollection(zones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { number: z.number, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
  }, [zones, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const lines = tracks
      .filter(t => t.points?.length >= 2)
      .map(t => turf.lineString(t.points.map(p => [p.lng, p.lat]), { volunteerId: t.volunteerId }));
    map.getSource('tracks')?.setData(turf.featureCollection(lines));
    const positions = tracks
      .filter(t => t.points?.length >= 1 && t.zoneStatus !== 'searched')
      .map(t => turf.point(
        [t.points[t.points.length - 1].lng, t.points[t.points.length - 1].lat],
        { volunteerId: t.volunteerId }
      ));
    map.getSource('searcher-positions')?.setData(turf.featureCollection(positions));
  }, [tracks, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('live-markers')?.setData(
      turf.featureCollection(liveMarkers.map(m => turf.point([m.lng, m.lat], { note: m.note ?? '' })))
    );
  }, [liveMarkers, mapLoaded]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
}
