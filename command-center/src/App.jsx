import { useState, useEffect } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';
import { SearchSetup } from './search/SearchSetup';
import { CommandMap } from './map/CommandMap';
import { ZonePanel } from './ui/ZonePanel';
import { subdivideZone } from './zones/subdivider';
import { createZone, updateZoneStatus, watchZones } from './firebase/zones';
import { updateSearchBoundary } from './firebase/searches';

const DAY_ID = 'day-1';

export default function App() {
  const { user, logout } = useAuth();
  const [searchId, setSearchId] = useState(null);
  const [drawMode, setDrawMode] = useState('idle');
  const [letterZones, setLetterZones] = useState([]);
  const [zones, setZones] = useState([]);

  useEffect(() => {
    if (!searchId) return;
    return watchZones(searchId, DAY_ID, setZones);
  }, [searchId]);

  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;
  if (!searchId) return <SearchSetup onSearchCreated={setSearchId} />;

  async function handleFeatureDrawn(feature, type) {
    setDrawMode('idle');
    if (type === 'boundary') {
      await updateSearchBoundary(searchId, feature.geometry);
    } else {
      const letter = String.fromCharCode(65 + letterZones.length); // A, B, C…
      const updated = [...letterZones, { letter, feature }];
      setLetterZones(updated);
      const subZones = subdivideZone(feature, 1);
      for (let i = 0; i < subZones.length; i++) {
        await createZone(searchId, DAY_ID, { letter, number: i + 1, polygon: subZones[i].geometry });
      }
    }
  }

  async function handleStatusChange(zoneId, status) {
    await updateZoneStatus(searchId, DAY_ID, zoneId, status);
  }

  const nextLetter = String.fromCharCode(65 + letterZones.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', background: '#1e293b', color: '#f8fafc', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, marginRight: 8 }}>SAR Command</span>
        <button
          onClick={() => setDrawMode(m => m === 'boundary' ? 'idle' : 'boundary')}
          style={{ background: drawMode === 'boundary' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
          {drawMode === 'boundary' ? '✏ Drawing boundary…' : '📍 Draw Boundary'}
        </button>
        <button
          onClick={() => setDrawMode(m => m === 'letter_zone' ? 'idle' : 'letter_zone')}
          style={{ background: drawMode === 'letter_zone' ? '#f59e0b' : '#334155', padding: '4px 12px' }}>
          {drawMode === 'letter_zone' ? `✏ Drawing Zone ${nextLetter}…` : `🗺 Add Zone ${nextLetter}`}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={logout} style={{ background: '#334155', padding: '4px 12px' }}>Sign Out</button>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <CommandMap
          drawMode={drawMode}
          onFeatureDrawn={handleFeatureDrawn}
          letterZones={letterZones}
          subZones={zones}
        />
        <ZonePanel zones={zones} onStatusChange={handleStatusChange} />
      </div>
    </div>
  );
}
