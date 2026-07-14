import { useState, useEffect } from 'react';
import * as turf from '@turf/turf';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { fetchStreetGraph, computeZoneCount, generateZones } from '../zones/subdivider';
import { createZones, updateZoneStatus, watchZones } from '../firebase/zones';
import { updateSearchBoundary, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';

const DAY_ID = 'day-1';

export function SearchDetail({ searchId, volunteers, onBack, onLogout }) {
  const [searchName, setSearchName] = useState('');
  const [searchStatus, setSearchStatus] = useState('setup');
  const [drawMode, setDrawMode] = useState('idle');
  const [boundary, setBoundary] = useState(null);
  const [searchMinutes, setSearchMinutes] = useState(30);
  const [searchMode, setSearchMode] = useState('walked');
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [generateError, setGenerateError] = useState('');
  const [zones, setZones] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [liveMarkers, setLiveMarkers] = useState([]);
  const [copiedLink, setCopiedLink] = useState(false);
  const [searchCode, setSearchCode] = useState('');

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
      if (search.boundary) setBoundary(search.boundary);
    });
  }, [searchId]);

  const readOnly = searchStatus === 'complete';

  // Line stays visible forever (the walked path is the record); only the live
  // position dot should disappear once that volunteer's zone is marked searched.
  const statusByVolunteer = Object.fromEntries(
    zones.filter(z => z.assignedTo).map(z => [z.assignedTo, z.status])
  );
  const tracksWithStatus = tracks.map(t => ({ ...t, zoneStatus: statusByVolunteer[t.volunteerId] }));

  async function handleFeatureDrawn(feature) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      setBoundary(feature.geometry);
      await updateSearchBoundary(searchId, feature.geometry);
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }

  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    setGenerateError('');
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };

      setGeneratingStatus('Fetching street network…');
      const { hardLines, softLines } = await fetchStreetGraph(boundaryFeature);

      setGeneratingStatus('Generating zones…');
      const zoneCount = computeZoneCount(turf.area(boundaryFeature), searchMinutes, searchMode);
      const zonePolygons = generateZones(boundaryFeature, zoneCount, hardLines, softLines);

      setGeneratingStatus(`Saving ${zonePolygons.length} zones…`);
      await createZones(searchId, DAY_ID, zonePolygons.map((p, i) => ({ number: i + 1, polygon: p.geometry })));
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
      setGenerateError("Couldn't fetch street data — the map service may be busy. Try again.");
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

        {/* Step 1: draw boundary */}
        {searchStatus === 'setup' && !boundary && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary' ? '✏ Drawing boundary… (double-click to finish)' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}

        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && zones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: Search time & mode</span>
            <input
              type="number" min={5} max={240} value={searchMinutes}
              onChange={e => setSearchMinutes(Number(e.target.value))}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <span style={{ fontSize: 13, opacity: 0.7 }}>min</span>
            <select
              value={searchMode} onChange={e => setSearchMode(e.target.value)}
              style={{ padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }}>
              <option value="walked">Walked</option>
              <option value="driven">Driven</option>
            </select>
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
            {generateError && (
              <span style={{ color: '#fca5a5', fontSize: 13 }}>{generateError}</span>
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
          drawMode={readOnly ? 'idle' : drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          boundary={boundary}
          zones={zones}
          tracks={tracksWithStatus}
          liveMarkers={liveMarkers}
        />
        <ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} readOnly={readOnly} />
      </div>
    </div>
  );
}
