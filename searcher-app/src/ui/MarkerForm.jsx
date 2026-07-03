import { useState } from 'react';

export function MarkerForm({ location, onSave, onCancel }) {
  const [note, setNote] = useState('');
  return (
    <div style={{
      position: 'fixed', bottom: 88, left: 16, right: 16, zIndex: 10,
      background: '#fff', borderRadius: 12, padding: 16,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      <p style={{ marginBottom: 8, fontWeight: 600 }}>
        Drop a marker at {location.lat.toFixed(5)}, {location.lng.toFixed(5)}?
      </p>
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Note (e.g. backpack found)"
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => onSave(note)} style={{ flex: 1, background: '#ef4444' }}>Drop Marker</button>
        <button onClick={onCancel} style={{ flex: 1, background: '#6b7280' }}>Cancel</button>
      </div>
    </div>
  );
}
