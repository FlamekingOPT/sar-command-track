import { useState, useEffect, useRef } from 'react';
import * as turf from '@turf/turf';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { PinForm } from '../ui/PinForm';
import { allocateZoneCounts, orderZonesForNumbering } from '../zones/subdivider';
import { gridZones } from '../zones/grid';
import { validateZonePolygon, zonesToGenerate } from '../zones/reshape';
import { createZones, updateZoneStatus, updateZonePolygon, watchZones, deleteZonesForBoundary } from '../firebase/zones';
import { updateSearchBoundaries, updateSearchCommandBase, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';
import { createPin, deletePin, watchPins } from '../firebase/pins';
import { geocodeAddress } from '../map/geocode';
import { FeedbackForm } from '../feedback/FeedbackForm';

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
  const [zoneEditId, setZoneEditId] = useState(null);
  const [zoneEditError, setZoneEditError] = useState('');
  const [pins, setPins] = useState([]);
  const [pinDropMode, setPinDropMode] = useState(false);
  const [pendingPinLocation, setPendingPinLocation] = useState(null);
  const [commandBase, setCommandBase] = useState(null);
  const [commandBaseError, setCommandBaseError] = useState('');
  const [editingCommandBase, setEditingCommandBase] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [commandBaseInput, setCommandBaseInput] = useState('');
  const [savingCommandBase, setSavingCommandBase] = useState(false);
  const mapRef = useRef(null);

  function handleOpenCommandBaseEditor() {
    if (readOnly) return;
    setCommandBaseInput(commandBase?.address ?? '');
    setCommandBaseError('');
    setEditingCommandBase(true);
  }

  async function handleSaveCommandBase() {
    const address = commandBaseInput.trim();
    setSavingCommandBase(true);
    try {
      setCommandBaseError('');
      const base = address ? await geocodeAddress(address) : null;
      await updateSearchCommandBase(searchId, base);
      setEditingCommandBase(false);
    } catch (err) {
      console.error('handleSaveCommandBase failed:', err);
      setCommandBaseError(err.message ?? 'Could not find that address.');
    } finally {
      setSavingCommandBase(false);
    }
  }

  function handleZoneClick(zone) {
    setSelectedZoneId(zone.id);
    mapRef.current?.flyToZone(zone);
  }

  // The map hands back an id (layer features carry properties, not documents).
  function handleZoneClickById(zoneId) {
    if (zoneEditId) return; // clicks belong to Draw while reshaping
    const zone = zones.find(z => z.id === zoneId);
    if (zone) setSelectedZoneId(zone.id);
  }

  function handleToggleZoneEdit() {
    setZoneEditError('');
    setZoneEditId(current => (current ? null : selectedZoneId));
  }

  async function handleZoneReshaped({ id, geometry }) {
    const result = validateZonePolygon(geometry);
    if (!result.ok) {
      // Leave Draw holding the bad shape so the user can keep dragging it back
      // into something valid; nothing is written until it validates.
      setZoneEditError(result.error);
      return;
    }
    setZoneEditError('');
    try {
      await updateZonePolygon(searchId, DAY_ID, id, result.geometry);
    } catch (err) {
      console.error('handleZoneReshaped failed:', err);
      setZoneEditError('Could not save the new shape — check your connection.');
    }
  }

  useEffect(() => watchZones(searchId, DAY_ID, setZones), [searchId]);

  // Never leave a zone in Draw that the panel no longer points at.
  useEffect(() => {
    if (zoneEditId && zoneEditId !== selectedZoneId) setZoneEditId(null);
  }, [selectedZoneId, zoneEditId]);

  useEffect(() => {
    const stopTracks = watchTracks(searchId, DAY_ID, setTracks);
    const stopMarkers = watchMarkers(searchId, DAY_ID, setLiveMarkers);
    const stopPins = watchPins(searchId, DAY_ID, setPins);
    return () => { stopTracks(); stopMarkers(); stopPins(); };
  }, [searchId]);

  function handleTogglePinDrop() {
    setPendingPinLocation(null);
    setPinDropMode(m => !m);
  }

  function handlePinDrop(location) {
    setPendingPinLocation(location);
  }

  async function handleSavePin(note) {
    if (readOnly) return;
    const location = pendingPinLocation;
    setPendingPinLocation(null);
    setPinDropMode(false);
    try {
      await createPin(searchId, DAY_ID, { ...location, note });
    } catch (err) {
      console.error('handleSavePin failed:', err);
    }
  }

  async function handlePinClick({ id, note }) {
    if (readOnly) return;
    if (!window.confirm(`Delete this pin?${note ? ` (${note})` : ''}`)) return;
    try {
      await deletePin(searchId, DAY_ID, id);
    } catch (err) {
      console.error('handlePinClick failed:', err);
    }
  }

  useEffect(() => {
    return watchSearch(searchId, search => {
      if (search.name) setSearchName(search.name);
      if (search.code) setSearchCode(search.code);
      if (search.status) setSearchStatus(search.status);
      setBoundaries(search.boundaries ?? []);
      setCommandBase(search.commandBase ?? null);
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
      const remaining = zonesToGenerate(zoneCount);

      // No street data, no rules — a plain even grid clipped to each
      // boundary, split by AREA share across boundaries (2026-09-17: dropped
      // the street/hard-barrier logic entirely per command's call; zone
      // quality is being tackled separately).
      const notices = [];
      const alloc = allocateZoneCounts(remaining, targets.map(t => turf.area(t.feature)));
      const all = []; // { poly, boundaryId } across every target boundary
      targets.forEach((t, i) => {
        const polys = gridZones(t.feature, alloc[i]);
        for (const p of polys) all.push({ poly: p, boundaryId: t.id });
      });

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
          notices.push(`Generated ${toCreate.length} zones (requested ${remaining}).`);
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

        {/* Reshape the selected zone by dragging its vertices. Only one zone at
            a time — Draw holds that zone alone while the mode is on. */}
        {!readOnly && selectedZoneId && (
          <button
            onClick={handleToggleZoneEdit}
            style={{ background: zoneEditId ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {zoneEditId
              ? '✓ Done reshaping'
              : `✎ Reshape zone ${zones.find(z => z.id === selectedZoneId)?.number ?? ''}`}
          </button>
        )}
        {zoneEditError && (
          <span style={{ color: '#fca5a5', fontSize: 13 }}>{zoneEditError}</span>
        )}

        {/* Drop a pin with a note anywhere on the map — visible to searchers. */}
        {!readOnly && (
          <button
            onClick={handleTogglePinDrop}
            style={{ background: pinDropMode ? '#7c3aed' : '#334155', padding: '4px 12px' }}>
            {pinDropMode ? '📌 Click map to drop pin…' : '📌 Drop Pin'}
          </button>
        )}

        {/* A search's home base — the map auto-flies here once when the
            search is opened, so command doesn't start zoomed out to the LA
            basin default. Inline field, not window.prompt: a native prompt()
            dialog turned out to be easy to miss/inaccessible in some
            environments (field feedback 2026-09-17). */}
        {!readOnly && editingCommandBase && (
          <>
            <input
              value={commandBaseInput}
              onChange={e => setCommandBaseInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveCommandBase(); if (e.key === 'Escape') setEditingCommandBase(false); }}
              placeholder="Command base address"
              autoFocus
              style={{ width: 220, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <button onClick={handleSaveCommandBase} disabled={savingCommandBase}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {savingCommandBase ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditingCommandBase(false)} style={{ background: '#334155', padding: '4px 12px' }}>
              Cancel
            </button>
          </>
        )}
        {!readOnly && !editingCommandBase && (
          <button onClick={handleOpenCommandBaseEditor} title={commandBase?.address}
            style={{ background: '#334155', padding: '4px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            🏠 {commandBase ? commandBase.address : 'Set Command Base'}
          </button>
        )}
        {commandBaseError && (
          <span style={{ color: '#fca5a5', fontSize: 13 }}>{commandBaseError}</span>
        )}

        {/* Step 2: zone count (command types the total; walked/driven suggester
            removed 2026-07-16 — it proposed absurd counts like 1031) */}
        {!readOnly && boundaries.length > 0
          && boundaries.some(b => !zones.some(z => zoneBelongsTo(z, b.id))) && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>
              {zones.length ? 'Zones for new boundary' : 'Step 2: Zones'}
            </span>
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
        {/* Report a bug/feature straight from the search that surfaced it —
            not gated by readOnly, reporting isn't a mutation of the search
            itself, and a completed search can still have something worth
            flagging. */}
        <button onClick={() => setShowFeedback(s => !s)} style={{ background: showFeedback ? '#7c3aed' : '#334155', padding: '4px 12px' }}>
          🐛 Report Issue
        </button>
        <button onClick={onLogout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ position: 'relative', flex: 1, height: '100%' }}>
          <CommandMap
            ref={mapRef}
            commandBase={commandBase}
            drawMode={readOnly ? 'idle' : drawMode}
            onFeatureDrawn={handleFeatureDrawn}
            boundaries={boundaries}
            editable={!readOnly}
            onBoundaryEdited={handleBoundaryEdited}
            onBoundaryDeleted={handleBoundaryDeleted}
            zones={zones}
            tracks={tracksWithStatus}
            liveMarkers={liveMarkers}
            volunteers={volunteers}
            selectedZoneId={selectedZoneId}
            onZoneClick={handleZoneClickById}
            zoneEditId={zoneEditId}
            onZoneReshaped={handleZoneReshaped}
            pins={pins}
            pinDropMode={pinDropMode}
            onPinDrop={handlePinDrop}
            onPinClick={handlePinClick}
          />
          {pendingPinLocation && (
            <PinForm
              location={pendingPinLocation}
              onSave={handleSavePin}
              onCancel={() => setPendingPinLocation(null)}
            />
          )}
          {showFeedback && (
            <div style={{
              position: 'absolute', top: 12, right: 12, zIndex: 10, width: 320,
              maxHeight: 'calc(100% - 24px)', overflowY: 'auto',
              background: '#fff', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px 0' }}>
                <strong style={{ flex: 1, fontSize: 14 }}>🐛 Report Issue</strong>
                <button onClick={() => setShowFeedback(false)} style={{ background: 'transparent', padding: '2px 6px' }}>✕</button>
              </div>
              <div style={{ padding: 12 }}>
                <FeedbackForm
                  searchContext={{ searchId, searchName }}
                  onSubmitted={() => setShowFeedback(false)}
                />
              </div>
            </div>
          )}
        </div>
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
