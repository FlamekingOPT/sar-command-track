import { useState, useEffect, useRef } from 'react';
import { parseToken } from './firebase/token';
import { resolveLink } from './firebase/links';
import { getZone, watchZone } from './firebase/zones';
import { enqueue, linkKeyOf } from './gps/offlineQueue';
import { startSync, flushOnce } from './gps/sync';
import { useGpsTracking } from './gps/useGpsTracking';
import { SearcherMap } from './map/SearcherMap';
import { StatusButton } from './ui/StatusButton';
import { MarkerForm } from './ui/MarkerForm';
import { parseSearchId } from './pick/pickToken';
import { PickPage } from './pick/PickPage';

function Message({ children }) {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <p style={{ fontSize: 17, color: '#374151' }}>{children}</p>
    </div>
  );
}

export default function App() {
  const searchId = parseSearchId(window.location.pathname);
  if (searchId) return <PickPage searchId={searchId} />;

  const [state, setState] = useState('loading'); // loading | invalid | ready
  const [link, setLink] = useState(null);        // { searchId, dayId, zoneId, volunteerId }
  const [zone, setZone] = useState(null);
  const [pinLocation, setPinLocation] = useState(null);
  const [localMarkers, setLocalMarkers] = useState([]);
  const startedRef = useRef(false);

  const linkKey = linkKeyOf(link);
  const { points, error: gpsError, retry } = useGpsTracking(state === 'ready', linkKey);

  // Resolve token → link → zone
  useEffect(() => {
    const token = parseToken(window.location.pathname);
    if (!token) { setState('invalid'); return; }
    (async () => {
      try {
        const resolved = await resolveLink(token);
        if (!resolved) { setState('invalid'); return; }
        const zoneDoc = await getZone(resolved);
        if (!zoneDoc?.polygon) { setState('invalid'); return; }
        setLink(resolved);
        setZone(zoneDoc);
        setState('ready');
      } catch {
        setState('invalid'); // offline first-open with nothing cached also lands here
      }
    })();
  }, []);

  // Live zone updates + sync loop + one-time "in progress" flip
  useEffect(() => {
    if (state !== 'ready' || !link) return;
    const stopWatch = watchZone(link, setZone);
    const stopSync = startSync(link);
    if (!startedRef.current) {
      startedRef.current = true;
      if (zone?.status === 'assigned') enqueue('status', { status: 'in_progress' }, linkKey);
    }
    return () => { stopWatch(); stopSync(); };
  }, [state, link]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === 'loading') return <Message>Loading your zone…</Message>;
  if (state === 'invalid') return <Message>This link is no longer active. Ask command for a new one via /available in the group.</Message>;

  function handleSaveMarker(note) {
    const marker = { lat: pinLocation.lat, lng: pinLocation.lng, note };
    enqueue('marker', marker, linkKey);
    setLocalMarkers(prev => [...prev, marker]);
    setPinLocation(null);
  }

  // Status changes flip the UI instantly and sync immediately — waiting for
  // the 10s tick made the Complete button look dead (watchZone corrects us
  // if the write is rejected; offline, the queue still delivers it later).
  async function handleStatusChange(status) {
    setZone(z => ({ ...z, status }));
    await enqueue('status', { status }, linkKey);
    flushOnce(link).catch(() => {});
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <SearcherMap
        zonePolygon={zone.polygon}
        points={points}
        markers={localMarkers}
        onMapTap={setPinLocation}
      />

      <div style={{
        position: 'fixed', top: 12, left: 12, right: 12, zIndex: 10,
        background: 'rgba(30,41,59,0.92)', color: '#f8fafc',
        borderRadius: 10, padding: '10px 14px', fontWeight: 700, textAlign: 'center',
      }}>
        Zone {zone.number}
        {gpsError === 'denied' && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6 }}>
            GPS permission is required to track your search.{' '}
            <button onClick={retry} style={{ padding: '4px 10px', fontSize: 13 }}>Enable GPS</button>
          </div>
        )}
      </div>

      {pinLocation && (
        <MarkerForm
          location={pinLocation}
          onSave={handleSaveMarker}
          onCancel={() => setPinLocation(null)}
        />
      )}

      <StatusButton
        status={zone.status}
        onComplete={() => handleStatusChange('searched')}
        onReopen={() => handleStatusChange('in_progress')}
      />
    </div>
  );
}
