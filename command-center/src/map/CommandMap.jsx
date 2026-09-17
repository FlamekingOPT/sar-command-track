import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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

export const CommandMap = forwardRef(function CommandMap({ commandBase = null, drawMode, onFeatureDrawn, boundaries = [], editable = false, onBoundaryEdited, onBoundaryDeleted, zones = [], tracks = [], liveMarkers = [], volunteers = {}, selectedZoneId = null, onZoneClick, zoneEditId = null, onZoneReshaped, pins = [], pinDropMode = false, onPinDrop, onPinClick }, ref) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const drawModeRef = useRef(drawMode);
  const onFeatureDrawnRef = useRef(onFeatureDrawn);
  const pinDropModeRef = useRef(pinDropMode);
  const onPinDropRef = useRef(onPinDrop);
  const onPinClickRef = useRef(onPinClick);
  useEffect(() => { pinDropModeRef.current = pinDropMode; }, [pinDropMode]);
  useEffect(() => { onPinDropRef.current = onPinDrop; }, [onPinDrop]);
  useEffect(() => { onPinClickRef.current = onPinClick; }, [onPinClick]);
  // State (not a ref/isStyleLoaded check) so the data effects below re-run once
  // the map + sources are ready. Firestore data usually arrives before the map
  // finishes loading; without this the effects return early and never retry,
  // leaving every overlay (boundary, zones, tracks) empty.
  const [mapLoaded, setMapLoaded] = useState(false);

  const onBoundaryEditedRef = useRef(onBoundaryEdited);
  const onBoundaryDeletedRef = useRef(onBoundaryDeleted);
  const onZoneClickRef = useRef(onZoneClick);
  const onZoneReshapedRef = useRef(onZoneReshaped);
  // draw.update fires from the same Draw instance for both a boundary and a
  // zone being reshaped, and the handler is bound once on mount — it needs the
  // CURRENT edit target to tell the two apart.
  const zoneEditIdRef = useRef(zoneEditId);
  // Read through a ref, not the prop, so the Draw-sync effect below does NOT
  // re-run on every zones snapshot: each reshape write echoes back from
  // Firestore, and re-seeding Draw mid-edit would drop the vertex selection.
  const zonesRef = useRef(zones);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { onFeatureDrawnRef.current = onFeatureDrawn; }, [onFeatureDrawn]);
  useEffect(() => { onBoundaryEditedRef.current = onBoundaryEdited; }, [onBoundaryEdited]);
  useEffect(() => { onBoundaryDeletedRef.current = onBoundaryDeleted; }, [onBoundaryDeleted]);
  useEffect(() => { onZoneClickRef.current = onZoneClick; }, [onZoneClick]);
  useEffect(() => { onZoneReshapedRef.current = onZoneReshaped; }, [onZoneReshaped]);
  useEffect(() => { zoneEditIdRef.current = zoneEditId; }, [zoneEditId]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);

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
      map.addLayer({ id: 'zones-selected-line', type: 'line', source: 'zones',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': '#2563eb', 'line-width': 4 } });

      map.addSource('tracks', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks',
        paint: { 'line-color': '#16a34a', 'line-width': 3, 'line-opacity': 0.9 } });

      map.addSource('searcher-positions', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'searcher-positions-dot', type: 'circle', source: 'searcher-positions',
        paint: { 'circle-radius': 7, 'circle-color': '#16a34a', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
      // Command needs to know WHO is where without cross-referencing the panel:
      // the dot alone can't answer "who is in zone 14?" during a live search.
      map.addLayer({ id: 'searcher-positions-labels', type: 'symbol', source: 'searcher-positions',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'top',
          'text-offset': [0, 0.7],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#14532d', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

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

      map.addSource('command-pins', { type: 'geojson', data: turf.featureCollection([]) });
      map.addLayer({ id: 'command-pins-dot', type: 'circle', source: 'command-pins',
        paint: { 'circle-radius': 8, 'circle-color': '#7c3aed', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      map.addLayer({ id: 'command-pins-labels', type: 'symbol', source: 'command-pins',
        layout: {
          'text-field': ['get', 'note'],
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
        },
        paint: { 'text-color': '#5b21b6', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });

      setMapLoaded(true); // sources + layers now exist — let the data effects push
    });

    // No deleteAll after create: the boundaries/editable sync effect below
    // reconciles Draw against the boundaries prop (stable feature ids make
    // the echo-back idempotent); deleting here would wipe other boundaries.
    map.on('draw.create', e => {
      onFeatureDrawnRef.current?.(e.features[0]);
    });
    map.on('draw.update', e => {
      for (const f of e.features) {
        const id = String(f.id);
        // While a zone is being reshaped it is the only feature inside Draw,
        // so anything else coming back is a boundary edit.
        if (id === zoneEditIdRef.current) onZoneReshapedRef.current?.({ id, geometry: f.geometry });
        else onBoundaryEditedRef.current?.({ id, geometry: f.geometry });
      }
    });
    map.on('draw.delete', e => {
      for (const f of e.features) {
        // Trash while reshaping would silently drop a numbered zone — Draw's
        // copy is put back by the sync effect below.
        if (String(f.id) === zoneEditIdRef.current) continue;
        onBoundaryDeletedRef.current?.(String(f.id));
      }
    });

    map.on('click', 'zones-fill', e => {
      if (pinDropModeRef.current) return; // dropping a pin takes priority over zone selection
      const hit = e.features?.[0];
      if (hit) onZoneClickRef.current?.(hit.properties.id);
    });
    map.on('mouseenter', 'zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'zones-fill', () => { map.getCanvas().style.cursor = ''; });

    map.on('click', 'command-pins-dot', e => {
      if (pinDropModeRef.current) return; // let the generic handler below drop a new pin instead
      const hit = e.features?.[0];
      if (hit) onPinClickRef.current?.({ id: hit.properties.id, note: hit.properties.note });
    });
    map.on('mouseenter', 'command-pins-dot', () => {
      if (!pinDropModeRef.current) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'command-pins-dot', () => { map.getCanvas().style.cursor = pinDropModeRef.current ? 'crosshair' : ''; });

    // Plain map click (not tied to a layer) so dropping a pin works anywhere,
    // including empty water/unmapped areas that have no zones-fill feature.
    // Boundary drawing and zone reshaping both put Mapbox Draw in an active
    // editing mode — a pin-drop click landing on top of that would silently
    // fight Draw for the same click (losing a boundary vertex, or dropping a
    // pin mid-drag) instead of doing either cleanly, so pin-drop mode defers
    // to whichever of those is active.
    map.on('click', e => {
      if (!pinDropModeRef.current) return;
      if (drawModeRef.current !== 'idle' || zoneEditIdRef.current) return;
      onPinDropRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    mapRef.current = map;
    drawRef.current = draw;
    return () => { setMapLoaded(false); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    flyToZone(zone) {
      const map = mapRef.current;
      if (!map || !zone?.polygon) return;
      const [minX, minY, maxX, maxY] = turf.bbox(zone.polygon);
      map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 120, maxZoom: 18, duration: 800 });
    },
  }), []);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || zoneEditId) return; // reshaping owns Draw's mode
    draw.changeMode(drawMode === 'idle' ? 'simple_select' : 'draw_polygon');
  }, [drawMode, zoneEditId]);

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
    const editingZone = zoneEditId ? zonesRef.current.find(z => z.id === zoneEditId) : null;
    if (editingZone?.polygon) {
      // Reshaping puts ONLY that zone in Draw: boundaries drop to the read-only
      // source so a stray drag can't reshape the search area by accident, and
      // draw.update stays unambiguous.
      draw.set({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', id: editingZone.id, geometry: editingZone.polygon, properties: {} }],
      });
      map.getSource('boundary')?.setData(turf.featureCollection(
        boundaries.map(b => ({ type: 'Feature', geometry: b.geometry, properties: {} }))
      ));
      draw.changeMode('direct_select', { featureId: editingZone.id });
    } else if (editable) {
      draw.set({ type: 'FeatureCollection', features });
      map.getSource('boundary')?.setData(turf.featureCollection([]));
    } else {
      draw.set({ type: 'FeatureCollection', features: [] });
      map.getSource('boundary')?.setData(turf.featureCollection(
        boundaries.map(b => ({ type: 'Feature', geometry: b.geometry, properties: {} }))
      ));
    }
  }, [boundaries, editable, mapLoaded, zoneEditId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('zones')?.setData(
      turf.featureCollection(zones.map(z => ({
        type: 'Feature', geometry: z.polygon,
        properties: { id: z.id, number: z.number, color: STATUS_COLORS[z.status] ?? '#9ca3af' },
      })))
    );
  }, [zones, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.setFilter('zones-selected-line', ['==', ['get', 'id'], selectedZoneId ?? '']);
  }, [selectedZoneId, mapLoaded]);

  // Draw draws its own copy of the zone under edit; without this the stale
  // pre-drag polygon stays painted underneath the vertices.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const hide = ['!=', ['get', 'id'], zoneEditId ?? ''];
    for (const layer of ['zones-fill', 'zones-line', 'zones-labels']) map.setFilter(layer, hide);
    map.setFilter('zones-selected-line', [
      'all', hide, ['==', ['get', 'id'], selectedZoneId ?? ''],
    ]);
  }, [zoneEditId, selectedZoneId, mapLoaded]);

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
        // An unregistered id would render as a UUID next to the dot — worse
        // than nothing, so those stay unlabelled.
        { volunteerId: t.volunteerId, label: volunteers[t.volunteerId] ?? '' }
      ));
    map.getSource('searcher-positions')?.setData(turf.featureCollection(positions));
  }, [tracks, volunteers, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('live-markers')?.setData(
      turf.featureCollection(liveMarkers.map(m => turf.point([m.lng, m.lat], { note: m.note ?? '' })))
    );
  }, [liveMarkers, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.getSource('command-pins')?.setData(
      turf.featureCollection(pins.map(p => turf.point([p.lng, p.lat], { id: p.id, note: p.note ?? '' })))
    );
  }, [pins, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = pinDropMode ? 'crosshair' : '';
  }, [pinDropMode]);

  // Auto-navigate to the search's command base once when it's first opened —
  // NOT on every commandBase prop change, or setting/editing the base later
  // (or any other search-doc snapshot re-delivering the same value) would
  // yank the view out from under command mid-work.
  const flownToCommandBaseRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || flownToCommandBaseRef.current) return;
    if (typeof commandBase?.lat !== 'number' || typeof commandBase?.lng !== 'number') return;
    flownToCommandBaseRef.current = true;
    map.flyTo({ center: [commandBase.lng, commandBase.lat], zoom: 13, duration: 1200 });
  }, [commandBase, mapLoaded]);

  return <div ref={containerRef} style={{ flex: 1, height: '100%' }} />;
});
