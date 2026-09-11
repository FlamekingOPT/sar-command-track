import { useState, useEffect, useRef } from 'react';
import * as turf from '@turf/turf';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { fetchStreets, selectDetail } from '../zones/overpass';
import { allocateZoneCounts, buildBlocks, mergeBlocksToZones, orderZonesForNumbering, computeBlockEfforts } from '../zones/subdivider';
import { gridZones } from '../zones/grid';
import { createZones, updateZoneStatus, watchZones, deleteZonesForBoundary } from '../firebase/zones';
import { updateSearchBoundaries, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';

const DAY_ID = 'day-1';

export function SearchDetail({ searchId, volunteers, onBack, onLogout }) {
  const [searchName, setSearchName] = useState('');
  const [searchStatus, setSearchStatus] = useState('setup');
  const [drawMode, setDrawMode] = useState('idle');
  const [boundaries, setBoundaries] = useState([]);
  const [zoneCount, setZoneCount] = useState(25);
  const [generateNotice, setGenerateNotice] = useState('');
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [generateError, setGenerateError] = useState('');
  const [zones, setZones] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [liveMarkers, setLiveMarkers] = useState([]);
  const [copiedLink, setCopiedLink] = useState(false);
  const [searchCode, setSearchCode] = useState('');
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const mapRef = useRef(null);

  function handleZoneClick(zone) {
    setSelectedZoneId(zone.id);
    mapRef.current?.flyToZone(zone);
  }

  useEffect(() => watchZones(searchId, DAY_ID, setZones), [searchId]);

  useEffect(() => {
    const stopTracks = watchTracks(searchId, DAY_ID, setTracks);
    const stopMarkers = watchMarkers(searchId, DAY_ID, setLiveMarkers);
    return () => { stopTracks(); stopMarkers(); };
  }, [searchId]);

  useEffect(() => {
    return watchSearch(searchId, search => {
      if (search.name) setSearchName(search.name);
      if (search.code) setSearchCode(search.code);
      if (search.status) setSearchStatus(search.status);
      setBoundaries(search.boundaries ?? []);
    });
  }, [searchId]);

  const readOnly = searchStatus === 'complete';

  // Line stays visible forever (the walked path is the record); only the live
  // position dot should disappear once that volunteer's zone is marked searched.
  const statusByVolunteer = Object.fromEntries(
    zones.filter(z => z.assignedTo).map(z => [z.assignedTo, z.status])
  );
  const tracksWithStatus = tracks.map(t => ({ ...t, zoneStatus: statusByVolunteer[t.volunteerId] }));

  // Legacy zones predate boundaryId — the shim calls their boundary 'legacy-1',
  // so a missing boundaryId is attributed there. Keeps "does this boundary have
  // zones?" true for old searches.
  const zoneBelongsTo = (z, boundaryId) => (z.boundaryId ?? 'legacy-1') === boundaryId;

  async function handleFeatureDrawn(feature) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      const next = [...boundaries, { id: String(feature.id ?? crypto.randomUUID()), geometry: feature.geometry }];
      setBoundaries(next);
      await updateSearchBoundaries(searchId, next);
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }

  async function handleBoundaryEdited(updated) {
    if (readOnly) return;
    const hasZones = zones.some(z => zoneBelongsTo(z, updated.id));
    if (hasZones && searchStatus === 'active'
        && !window.confirm("Searchers may already be assigned to this boundary's zones. Editing deletes its zones — continue?")) {
      setBoundaries(prev => [...prev]); // re-sync the map back to the stored shape
      return;
    }
    const next = boundaries.map(b => (b.id === updated.id ? { ...b, geometry: updated.geometry } : b));
    setBoundaries(next);
    await updateSearchBoundaries(searchId, next);
    if (hasZones) await deleteZonesForBoundary(searchId, DAY_ID, updated.id);
  }

  async function handleBoundaryDeleted(boundaryId) {
    if (readOnly) return;
    const hasZones = zones.some(z => zoneBelongsTo(z, boundaryId));
    if (hasZones && searchStatus === 'active'
        && !window.confirm("Searchers may already be assigned to this boundary's zones. Deleting removes them — continue?")) {
      setBoundaries(prev => [...prev]);
      return;
    }
    const next = boundaries.filter(b => b.id !== boundaryId);
    setBoundaries(next);
    await updateSearchBoundaries(searchId, next);
    if (hasZones) await deleteZonesForBoundary(searchId, DAY_ID, boundaryId);
  }

  async function handleGenerateZones() {
    if (!boundaries.length) return;
    setGeneratingZones(true);
    setGenerateError('');
    setGenerateNotice('');
    const failures = [];
    try {
      // Per-boundary retry for free: only boundaries with no zones yet are
      // (re)generated, and the requested total is reduced by what already exists.
      const targets = boundaries
        .map(b => ({ ...b, feature: { type: 'Feature', geometry: b.geometry, properties: {} } }))
        .filter(b => !zones.some(z => zoneBelongsTo(z, b.id)));
      if (!targets.length) { setGeneratingZones(false); return; }
      const remaining = Math.max(1, zoneCount - zones.length);

      // Fetch + polygonize per boundary — smaller queries, independent failures.
      // LOD needs a PRE-fetch estimate (block counts don't exist yet), so the
      // estimate splits `remaining` by area; the real allocation below uses
      // actual block counts (spec §3).
      const totalTargetArea = targets.reduce((s, t) => s + turf.area(t.feature), 0);
      const built = [];   // boundaries with street data
      const gridded = []; // boundaries that fell back to grid zones
      const notices = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const areaM2 = turf.area(t.feature);
        const estAlloc = Math.max(1, Math.round(remaining * areaM2 / totalTargetArea));
        const label = targets.length > 1 ? ` (boundary ${i + 1} of ${targets.length})` : '';
        try {
          setGeneratingStatus(`Fetching map data…${label}`);
          const { hardLines, softLines, allStreetLines, terrainPolygons, terrainPaths } = await fetchStreets(t.feature, {
            detail: selectDetail(areaM2, estAlloc),
            onProgress: (done, total) => {
              if (total > 1) setGeneratingStatus(`Fetching map data…${label} tile ${Math.min(done + 1, total)}/${total}`);
            },
          });
          setGeneratingStatus(`Building blocks…${label}`);
          // The "implausibly big block" artifact filter must scale with zone
          // size: at coarse LOD, real blocks between major roads are km-scale.
          // 4× the expected zone area keeps every legitimate block while still
          // dropping polygonize leaks.
          const maxBlockAreaM2 = Math.max(200_000, (areaM2 / estAlloc) * 4);
          const { blocks, adjacency } = buildBlocks(t.feature, hardLines, softLines, {
            maxBlockAreaM2,
            // blocks holding more than one zone's share of streets get locally
            // re-polygonized at full detail so dense areas can split
            refineStreets: allStreetLines,
            targetZoneCount: estAlloc,
            terrainPolygons,
            terrainPaths,
          });
          // real workload per block: full-detail street meters (+ open-ground
          // allowance) — zones balance search effort, not a block-size proxy
          const efforts = computeBlockEfforts(blocks, allStreetLines);
          built.push({ ...t, blocks, adjacency, efforts });
        } catch (err) {
          // Street data unavailable (no cache tile, live Overpass down) —
          // degrade to grid zones so generation NEVER produces nothing.
          console.error(`street data unavailable for boundary ${t.id}, using grid zones:`, err);
          gridded.push({ ...t, polys: gridZones(t.feature, estAlloc) });
          notices.push(`Boundary ${i + 1}: street data unavailable — used grid zones.`);
        }
      }

      setGeneratingStatus('Generating zones…');
      const all = []; // { poly, boundaryId } across every target boundary
      const gridCount = gridded.reduce((s, g) => s + g.polys.length, 0);
      if (built.length) {
        // split the total by each boundary's total EFFORT (street meters), so a
        // dense boundary gets proportionally more zones than an open one
        const alloc = allocateZoneCounts(
          Math.max(1, remaining - gridCount),
          built.map(b => Math.max(1, b.efforts.reduce((s, e) => s + e, 0))),
        );
        const noStreets = [];
        built.forEach((b, i) => {
          // clamp: a zone is never smaller than one block (spec §1)
          const clamped = Math.min(alloc[i], Math.max(1, b.blocks.length));
          const polys = b.blocks.length ? mergeBlocksToZones(b.blocks, b.adjacency, clamped, { efforts: b.efforts }) : [b.feature];
          if (!b.blocks.length) noStreets.push(b.id);
          for (const p of polys) all.push({ poly: p, boundaryId: b.id });
        });
        if (noStreets.length) {
          notices.push(`${noStreets.length} boundar${noStreets.length === 1 ? 'y' : 'ies'} had no mapped streets — each became a single zone.`);
        }
      }
      for (const g of gridded) {
        for (const p of g.polys) all.push({ poly: p, boundaryId: g.id });
      }

      if (all.length) {
        // Numbering reads like a page ACROSS all boundaries: north rows first,
        // west→east — zone 47 sits next to zone 46 on the map.
        const boundaryIdByPoly = new Map(all.map(a => [a.poly, a.boundaryId]));
        const ordered = orderZonesForNumbering(all.map(a => a.poly));
        const firstNumber = zones.reduce((m, z) => Math.max(m, z.number), 0) + 1;
        const toCreate = ordered.map((p, k) => ({
          number: firstNumber + k,
          polygon: p.geometry,
          boundaryId: boundaryIdByPoly.get(p),
        }));
        setGeneratingStatus(`Saving ${toCreate.length} zones…`);
        await createZones(searchId, DAY_ID, toCreate);
        if (toCreate.length !== remaining && !notices.length) {
          notices.push(`Generated ${toCreate.length} zones (requested ${remaining} — limited by available blocks or hard-road divides).`);
        }
      }
      if (notices.length) setGenerateNotice(notices.join(' '));
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
      failures.push(err.message);
    }
    if (failures.length) {
      setGenerateError(`${failures.join(' — ')}. Other boundaries' zones were saved; press Generate again to retry just the failed ones.`);
    }
    setGeneratingStatus('');
    setGeneratingZones(false);
  }

  async function handleStatusChange(zoneId, status) {
    await updateZoneStatus(searchId, DAY_ID, zoneId, status);
  }

  async function handleComplete() {
    if (!window.confirm('Complete this search? Volunteers will no longer be able to sign up.')) return;
    await completeSearch(searchId);
    onBack();
  }

  function handleCopyPickerLink() {
    const url = `${import.meta.env.VITE_SEARCHER_APP_URL}/pick/${searchId}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).catch(() => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
    }
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Searches</button>
        <span style={{ fontWeight: 700, marginRight: 8 }}>{searchName || 'SAR Command'}</span>
        {searchCode && (
          <span
            title="Telegram bind code — send /bind {code} in the group"
            style={{ fontSize: 12, fontFamily: 'monospace', background: '#334155', color: '#f8fafc', padding: '3px 8px', borderRadius: 4, marginRight: 8 }}>
            Bind: {searchCode}
          </span>
        )}

        {/* Step 1: draw one or more boundaries — stays available once active so
            command can extend a live search, not just during initial setup */}
        {!readOnly && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary'
              ? '✏ Drawing boundary… (double-click to finish)'
              : boundaries.length ? '📍 Add Boundary' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}

        {/* Step 2: zone count (command types the total; walked/driven suggester
            removed 2026-07-16 — it proposed absurd counts like 1031) */}
        {!readOnly && boundaries.length > 0
          && boundaries.some(b => !zones.some(z => zoneBelongsTo(z, b.id))) && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: Zones</span>
            <input
              type="number" min={1} value={zoneCount}
              onChange={e => setZoneCount(Math.max(1, Number(e.target.value)))}
              style={{ width: 64, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
            {generateError && (
              <span style={{ color: '#fca5a5', fontSize: 13 }}>{generateError}</span>
            )}
            {generateNotice && (
              <span style={{ color: '#fcd34d', fontSize: 13 }}>{generateNotice}</span>
            )}
          </>
        )}

        {/* Step 3: send out */}
        {searchStatus === 'setup' && zones.length > 0 && (
          <button
            onClick={async () => { await publishSearch(searchId); }}
            style={{ background: '#22c55e', padding: '4px 12px', fontWeight: 700 }}>
            Step 3: Send Out Search
          </button>
        )}

        {searchStatus === 'active' && (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>● ACTIVE</span>
            <button onClick={handleCopyPickerLink} style={{ background: '#334155', padding: '4px 12px' }}>
              {copiedLink ? '✓ Copied' : '🔗 Copy Sign-Up Link'}
            </button>
            <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
              ■ Complete Search
            </button>
          </>
        )}

        {readOnly && (
          <span style={{ color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>VIEWING COMPLETED SEARCH — READ ONLY</span>
        )}

        <span style={{ flex: 1 }} />
        <button onClick={onLogout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <CommandMap
          ref={mapRef}
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundaries={boundaries}
          editable={!readOnly}
          onBoundaryEdited={handleBoundaryEdited}
          onBoundaryDeleted={handleBoundaryDeleted}
          zones={zones}
          tracks={tracksWithStatus}
          liveMarkers={liveMarkers}
          selectedZoneId={selectedZoneId}
        />
        <ZonePanel
          zones={zones}
          volunteers={volunteers}
          onStatusChange={handleStatusChange}
          onZoneClick={handleZoneClick}
          selectedZoneId={selectedZoneId}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
