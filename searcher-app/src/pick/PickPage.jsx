import { useState, useEffect, useMemo } from 'react';
import { getSearch } from '../firebase/searches';
import { watchZones } from '../firebase/zones';
import { claimZone, ASSIGNABLE } from './claimZone';
import { getIdentity, saveName, savePhone } from './identity';
import { PickMap } from './PickMap';

// Day management arrives in Plan 4; until then the whole system uses one fixed day.
const DAY_ID = 'day-1';

export function PickPage({ searchId }) {
  const [search, setSearch] = useState(undefined); // undefined = loading, null = not found
  const [zones, setZones] = useState([]);
  const [pendingZone, setPendingZone] = useState(null);
  const [nameInput, setNameInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [requestStatus, setRequestStatus] = useState(null);
  const [requestError, setRequestError] = useState(null);
  const identity = useMemo(getIdentity, []);

  useEffect(() => { getSearch(searchId).then(setSearch); }, [searchId]);

  useEffect(() => {
    if (!search) return;
    return watchZones(search.id, DAY_ID, setZones);
  }, [search]);

  if (search === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (search === null) return <p style={{ padding: 24 }}>This search link isn't valid.</p>;

  async function submitRequest(zone, name, phone) {
    setRequestError(null);
    setRequestStatus(null);
    setClaiming(true);
    try {
      const token = await claimZone({
        searchId: search.id, dayId: DAY_ID, zoneId: zone.id, volunteerId: identity.id, name, phone,
      });
      if (!token) { setRequestStatus('no_availability'); setClaiming(false); return; }
      window.location.href = `/s/${token}`;
    } catch {
      setRequestError("Something went wrong claiming that zone — try again.");
      setClaiming(false);
    }
  }

  function handleTapZone(zoneId) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone || !ASSIGNABLE.includes(zone.status)) return;
    if (!identity.name || !identity.phone) {
      setNameInput(identity.name ?? '');
      setPhoneInput(identity.phone ?? '');
      setPendingZone(zone);
      return;
    }
    submitRequest(zone, identity.name, identity.phone);
  }

  function handleNameSubmit(e) {
    e.preventDefault();
    if (!nameInput.trim() || !phoneInput.trim()) return;
    saveName(nameInput.trim());
    savePhone(phoneInput.trim());
    submitRequest(pendingZone, nameInput.trim(), phoneInput.trim());
    setPendingZone(null);
  }

  if (claiming) {
    return <p style={{ padding: 24, textAlign: 'center' }}>Joining zone…</p>;
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <PickMap zones={zones} onZoneClick={handleTapZone} />

      <div style={{
        position: 'fixed', top: 12, left: 12, right: 12, zIndex: 10,
        background: 'rgba(30,41,59,0.92)', color: '#f8fafc',
        borderRadius: 10, padding: '10px 14px', fontWeight: 700, textAlign: 'center',
      }}>
        {search.name}
        <div style={{ fontWeight: 400, fontSize: 13, marginTop: 4 }}>
          Tap an available zone to join the search.
        </div>

        {requestStatus === 'no_availability' && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6, color: '#fca5a5' }}>
            That zone just filled up — try another.
          </div>
        )}

        {requestError && (
          <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6, color: '#fca5a5' }}>
            {requestError}
          </div>
        )}
      </div>

      {pendingZone && (
        <form onSubmit={handleNameSubmit} style={{
          position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
          background: '#fff', borderRadius: 12, padding: 16,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          <p style={{ marginBottom: 8, fontWeight: 600 }}>What's your name and phone?</p>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="First Last" autoFocus style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }} />
          <input value={phoneInput} onChange={e => setPhoneInput(e.target.value)} placeholder="Phone number" type="tel" style={{ width: '100%', boxSizing: 'border-box' }} />
          <button type="submit" style={{ marginTop: 10, width: '100%' }}>Join Zone {pendingZone.number}</button>
        </form>
      )}
    </div>
  );
}
