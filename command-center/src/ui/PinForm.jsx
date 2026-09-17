import { useState } from 'react';

export function PinForm({ location, onSave, onCancel }) {
  const [note, setNote] = useState('');
  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 10,
      background: '#fff', borderRadius: 10, padding: 14, width: 260,
      boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    }}>
      <p style={{ marginBottom: 8, fontWeight: 600, fontSize: 13 }}>
        Drop a pin at {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
      </p>
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Note (e.g. staging area)"
        style={{ width: '100%', boxSizing: 'border-box' }}
        autoFocus
        onKeyDown={e => { if (e.key === 'Enter') onSave(note); }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={() => onSave(note)} style={{ flex: 1, background: '#7c3aed', color: '#fff' }}>Drop Pin</button>
        <button onClick={onCancel} style={{ flex: 1, background: '#6b7280', color: '#fff' }}>Cancel</button>
      </div>
    </div>
  );
}
