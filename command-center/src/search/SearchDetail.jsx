import { useState, useEffect } from 'react';
import { CommandMap } from '../map/CommandMap';
import { ZonePanel } from '../ui/ZonePanel';
import { fetchOSMBarriers, subdivideWithBarriers, subdivideZone } from '../zones/subdivider';
import { createZone, updateZoneStatus, watchZones } from '../firebase/zones';
import { updateSearchBoundary, updateSearchLetterZones, publishSearch, completeSearch, watchSearch } from '../firebase/searches';
import { watchTracks, watchMarkers } from '../firebase/live';

const DAY_ID = 'day-1';

export function SearchDetail({ searchId, volunteers, onBack, onLogout }) {
  const [searchName, setSearchName] = useState('');
  const [searchStatus, setSearchStatus] = useState('setup');
  const [drawMode, setDrawMode] = useState('idle');
  const [boundary, setBoundary] = useState(null);
  const [zoneCount, setZoneCount] = useState(4);
  const [generatingZones, setGeneratingZones] = useState(false);
  const [generatingStatus, setGeneratingStatus] = useState('');
  const [osmBarriers, setOsmBarriers] = useState([]);
  const [letterZones, setLetterZones] = useState([]);
  const [zones, setZones] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [liveMarkers, setLiveMarkers] = useState([]);

  useEffect(() => watchZones(searchId, DAY_ID, setZones), [searchId]);

  useEffect(() => {
    const stopTracks = watchTracks(searchId, DAY_ID, setTracks);
    const stopMarkers = watchMarkers(searchId, DAY_ID, setLiveMarkers);
    return () => { stopTracks(); stopMarkers(); };
  }, [searchId]);

  useEffect(() => {
    return watchSearch(searchId, search => {
      if (search.name) setSearchName(search.name);
      if (search.status) setSearchStatus(search.status);
      if (search.boundary) setBoundary(search.boundary);
      if (search.letterZones?.length) {
        setLetterZones(search.letterZones.map(z => ({
          letter: z.letter,
          feature: { type: 'Feature', geometry: z.geometry, properties: {} },
        })));
      }
    });
  }, [searchId]);

  const readOnly = searchStatus === 'complete';

  async function handleFeatureDrawn(feature, type) {
    if (readOnly) return;
    setDrawMode('idle');
    try {
      if (type === 'boundary') {
        setBoundary(feature.geometry);
        await updateSearchBoundary(searchId, feature.geometry);
      } else {
        const letter = String.fromCharCode(65 + letterZones.length); // A, B, C…
        const updated = [...letterZones, { letter, feature }];
        setLetterZones(updated);
        await updateSearchLetterZones(searchId, updated);
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleFeatureDrawn failed:', err);
    }
  }

  async function handleGenerateZones() {
    if (!boundary) return;
    setGeneratingZones(true);
    try {
      const boundaryFeature = { type: 'Feature', geometry: boundary, properties: {} };

      setGeneratingStatus('Fetching roads & waterways…');
      let barriers = [];
      try {
        barriers = await fetchOSMBarriers(boundaryFeature);
        setOsmBarriers(barriers);
      } catch (e) {
        console.warn('OSM fetch failed, using grid:', e);
      }

      setGeneratingStatus('Generating zones…');
      const letterPolygons = barriers.length
        ? subdivideWithBarriers(boundaryFeature, zoneCount, barriers)
        : subdivideZone(boundaryFeature, zoneCount);

      const newLetterZones = letterPolygons.map((poly, i) => ({
        letter: String.fromCharCode(65 + i),
        feature: poly,
      }));
      setLetterZones(newLetterZones);
      await updateSearchLetterZones(searchId, newLetterZones);
      for (const { letter, feature } of newLetterZones) {
        const subZones = subdivideZone(feature, 4);
        for (let i = 0; i < subZones.length; i++) {
          await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
        }
      }
    } catch (err) {
      console.error('handleGenerateZones failed:', err);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Searches</button>
        <span style={{ fontWeight: 700, marginRight: 8 }}>{searchName || 'SAR Command'}</span>

        {/* Step 1: draw boundary */}
        {searchStatus === 'setup' && !boundary && (
          <button
            onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
            style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
            {drawMode === 'boundary' ? '✏ Drawing boundary… (double-click to finish)' : '📍 Step 1: Draw Search Boundary'}
          </button>
        )}

        {/* Step 2: generate zones */}
        {searchStatus === 'setup' && boundary && letterZones.length === 0 && (
          <>
            <span style={{ fontSize: 13, opacity: 0.7 }}>Step 2: How many zones?</span>
            <input
              type="number" min={1} max={26} value={zoneCount}
              onChange={e => setZoneCount(Number(e.target.value))}
              style={{ width: 52, padding: '3px 6px', background: '#334155', border: 'none', color: '#f8fafc', borderRadius: 4 }} />
            <button
              onClick={handleGenerateZones}
              disabled={generatingZones}
              style={{ background: '#3b82f6', padding: '4px 12px', fontWeight: 600 }}>
              {generatingZones ? generatingStatus || 'Generating…' : '🗺 Generate Zones'}
            </button>
          </>
        )}

        {/* Step 3: send out */}
        {searchStatus === 'setup' && letterZones.length > 0 && (
          <button
            onClick={async () => { await publishSearch(searchId); }}
            style={{ background: '#22c55e', padding: '4px 12px', fontWeight: 700 }}>
            Step 3: Send Out Search
          </button>
        )}

        {searchStatus === 'active' && (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 14 }}>● ACTIVE</span>
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
          letterZones={letterZones}
          subZones={zones}
          osmBarriers={osmBarriers}
          tracks={tracks}
          liveMarkers={liveMarkers}
        />
        <ZonePanel zones={zones} volunteers={volunteers} onStatusChange={handleStatusChange} readOnly={readOnly} />
      </div>
    </div>
  );
}
