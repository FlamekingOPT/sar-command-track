import { useCallback, useRef, useState } from 'react';
import { StatusPill } from './StatusPill';

const ALL_STATUSES = ['unassigned', 'assigned', 'in_progress', 'searched', 'needs_re_search'];
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 280;

export function ZonePanel({ zones, volunteers = {}, onStatusChange, onZoneClick, selectedZoneId = null, readOnly = false }) {
  const sorted = [...zones].sort((a, b) => a.number - b.number);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragState = useRef(null);

  const handleResizeStart = useCallback(e => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };

    const handleMouseMove = moveEvent => {
      const { startX, startWidth } = dragState.current;
      // Panel sits right of the map; dragging the left edge left should grow it.
      const next = startWidth - (moveEvent.clientX - startX);
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    };
    const handleMouseUp = () => {
      dragState.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [width]);

  return (
    <div style={{ position: 'relative', width, flexShrink: 0, overflowY: 'auto', padding: 16, borderLeft: '1px solid #e5e7eb' }}>
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute', top: 0, left: 0, bottom: 0, width: 6,
          cursor: 'col-resize', transform: 'translateX(-3px)',
        }}
      />
      <h3 style={{ marginTop: 0 }}>Zones</h3>
      {zones.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
      )}
      {sorted.map(zone => {
        const name = zone.assignedTo ? (volunteers[zone.assignedTo] ?? zone.assignedTo) : '—';
        return (
          <div key={zone.id}
            onClick={() => onZoneClick?.(zone)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
              cursor: onZoneClick ? 'pointer' : undefined,
              background: zone.id === selectedZoneId ? '#eff6ff' : undefined,
              borderRadius: 4, padding: '2px 4px',
            }}>
            <span style={{ fontWeight: 700, minWidth: 28 }}>{zone.number}</span>
            <span title={name} style={{ flex: 1, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
            <StatusPill status={zone.status} />
            {!readOnly && (
              <select value={zone.status} onChange={e => onStatusChange(zone.id, e.target.value)}
                onClick={e => e.stopPropagation()}
                style={{ fontSize: 11, padding: '1px 4px' }}>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
