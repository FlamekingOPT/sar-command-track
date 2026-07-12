import { useState, useEffect, useMemo } from 'react';
import { getSearch } from '../firebase/searches';
import { watchZones } from '../firebase/zones';
import { createRequest, watchRequest } from '../firebase/zoneRequests';
import { getIdentity, saveName, getSavedRequest, saveRequest } from './identity';

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
  const [requestId, setRequestId] = useState(() => getSavedRequest(searchId));
  const [requestStatus, setRequestStatus] = useState(null);
  const identity = useMemo(getIdentity, []);

  useEffect(() => { getSearch(searchId).then(setSearch); }, [searchId]);

  useEffect(() => {
    if (!search) return;
    return watchZones(search.id, DAY_ID, setZones);
  }, [search]);

  useEffect(() => {
    if (!requestId) return;
    return watchRequest(requestId, req => {
      setRequestStatus(req.status);
      if (req.status === 'assigned' && req.token) window.location.href = `/s/${req.token}`;
    });
  }, [requestId]);

  if (search === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (search === null) return <p style={{ padding: 24 }}>This search link isn't valid.</p>;

  const availability = letterAvailability(zones);

  async function submitRequest(letter, name) {
    const id = await createRequest({ searchId: search.id, letter, webVolunteerId: identity.id, name });
    saveRequest(search.id, id);
    setRequestId(id);
    setRequestStatus('pending');
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

  if (requestStatus === 'pending') {
    return <p style={{ padding: 24, textAlign: 'center' }}>Finding your zone…</p>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>{search.name}</h1>
      <p style={{ color: '#6b7280', marginBottom: 20 }}>Tap an available zone to join the search.</p>

      {requestStatus === 'no_availability' && (
        <p style={{ color: '#b91c1c', marginBottom: 12 }}>That zone just filled up — try another.</p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {Object.entries(availability).sort().map(([letter, status]) => (
          <button
            key={letter}
            onClick={() => handleTapLetter(letter)}
            disabled={status !== 'available'}
            style={{
              width: 56, height: 56, fontSize: 22, fontWeight: 700,
              background: status === 'available' ? '#22c55e' : '#9ca3af',
            }}
          >
            {letter}
          </button>
        ))}
      </div>

      {pendingLetter && (
        <form onSubmit={handleNameSubmit} style={{
          position: 'fixed', bottom: 16, left: 16, right: 16,
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
