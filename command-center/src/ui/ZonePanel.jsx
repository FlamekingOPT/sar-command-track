import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned','assigned','in_progress','searched','needs_re_search'];

export function ZonePanel({ zones, onStatusChange }) {
  const byLetter = zones.reduce((acc, z) => {
    (acc[z.letter] ??= []).push(z);
    return acc;
  }, {});

  return (
    <div style={{ width: 280, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
      )}
      {Object.entries(byLetter).sort().map(([letter, lzones]) => (
        <div key={letter} style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>Zone {letter} — {lzones.length} sub-zone{lzones.length !== 1 ? 's' : ''}</h4>
          {lzones.sort((a, b) => a.number - b.number).map(zone => (
            <div key={zone.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontWeight: 700, minWidth: 28 }}>{zone.letter}{zone.number}</span>
              <span style={{ flex: 1, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {zone.assignedTo ?? '—'}
              </span>
              <StatusPill status={zone.status} />
              <select value={zone.status} onChange={e => onStatusChange(zone.id, e.target.value)}
                style={{ fontSize: 11, padding: '1px 4px' }}>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
