import { useState, useEffect, useMemo } from 'react';
import { getSearch } from '../firebase/searches';
import { watchZones } from '../firebase/zones';
import { claimZone } from './claimZone';
import { getIdentity, saveName } from './identity';
import { PickMap } from './PickMap';

// Day management arrives in Plan 4; until then the whole system uses one fixed day.
const DAY_ID = 'day-1';

function letterAvailability(zones) {
  const byLetter = zones.reduce((acc, z) => {
    (acc[z.letter] ??= []).push(z);
    return acc;
  }, {});
  return Object.fromEntries(
    Object.entries(byLetter).map(([letter, lzones]) => [
      letter,
      lzones.some(z => z.status === 'unassigned' || z.status === 'needs_re_search') ? 'available' : 'full',
    ])
  );
}

export function PickPage({ searchId }) {
  const [search, setSearch] = useState(undefined); // undefined = loading, null = not found
  const [zones, setZones] = useState([]);
  const [pendingLetter, setPendingLetter] = useState(null);
  const [nameInput, setNameInput] = useState('');
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

  const availability = letterAvailability(zones);

  async function submitRequest(letter, name) {
    setRequestError(null);
    setRequestStatus(null);
    setClaiming(true);
    try {
      const token = await claimZone({
        searchId: search.id, dayId: DAY_ID, letter, zones, volunteerId: identity.id, name,
      });
      if (!token) { setRequestStatus('no_availability'); setClaiming(false); return; }
      window.location.href = `/s/${token}`;
    } catch {
      setRequestError("Something went wrong claiming that zone — try again.");
      setClaiming(false);
    }
  }

  function handleTapLetter(letter) {
    if (availability[letter] !== 'available') return;
    if (!identity.name) { setPendingLetter(letter); return; }
    submitRequest(letter, identity.name);
  }

  function handleNameSubmit(e) {
    e.preventDefault();
    if (!nameInput.trim()) return;
    saveName(nameInput.trim());
    submitRequest(pendingLetter, nameInput.trim());
    setPendingLetter(null);
  }

  if (claiming) {
    return <p style={{ padding: 24, textAlign: 'center' }}>Joining zone…</p>;
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <PickMap letterZones={search.letterZones} availability={availability} onZoneClick={handleTapLetter} />

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

      {pendingLetter && (
        <form onSubmit={handleNameSubmit} style={{
          position: 'fixed', bottom: 16, left: 16, right: 16, zIndex: 10,
          background: '#fff', borderRadius: 12, padding: 16,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          <p style={{ marginBottom: 8, fontWeight: 600 }}>What's your name?</p>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="First Last" autoFocus />
          <button type="submit" style={{ marginTop: 10, width: '100%' }}>Join Zone {pendingLetter}</button>
        </form>
      )}
    </div>
  );
}
