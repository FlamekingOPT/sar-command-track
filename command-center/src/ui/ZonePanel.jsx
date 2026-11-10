import { useCallback, useRef, useState } from 'react';

const ALL_STATUSES = ['unassigned', 'assigned', 'in_progress', 'searched', 'needs_re_search'];
const STATUS_COLOR = {
  unassigned: '#9ca3af', assigned: '#3b82f6', in_progress: '#f59e0b',
  searched: '#22c55e', needs_re_search: '#ef4444',
};
const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

export function ZonePanel({ zones, volunteers = {}, messages = [], onStatusChange, onZoneClick, onSendMessage, selectedZoneId = null, readOnly = false }) {
  const sorted = [...zones].sort((a, b) => a.number - b.number);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragState = useRef(null);
  const [composeTo, setComposeTo] = useState(null); // null = closed; { id, label } otherwise ('__all__' id = broadcast)
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const assignedCount = new Set(zones.filter(z => z.assignedTo).map(z => z.assignedTo)).size;

  const thread = !composeTo ? []
    : composeTo.id === '__all__' ? messages.filter(m => m.to === null)
    : messages.filter(m => m.from === composeTo.id || m.to === composeTo.id);

  function closeCompose() {
    setComposeTo(null);
    setMessageText('');
  }

  async function handleSend() {
    const text = messageText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSendMessage({ to: composeTo.id === '__all__' ? null : composeTo.id, text });
      closeCompose();
    } catch (err) {
      console.error('handleSend failed:', err);
    } finally {
      setSending(false);
    }
  }

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

  const unassignedCount = zones.filter(z => !z.assignedTo).length;

  return (
    <div style={{ position: 'relative', width, flexShrink: 0, overflowY: 'auto', background: '#fafafa', borderLeft: '1px solid #e5e7eb' }}>
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute', top: 0, left: 0, bottom: 0, width: 6,
          cursor: 'col-resize', transform: 'translateX(-3px)',
        }}
      />
      <div style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fafafa', padding: '18px 18px 12px', borderBottom: '1px solid #ececec' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Zones</h3>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{assignedCount} assigned · {unassignedCount} open</div>
          </div>
          {!readOnly && assignedCount > 0 && (
            <button
              onClick={() => setComposeTo({ id: '__all__', label: `Everyone (${assignedCount} assigned)` })}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' }}>
              💬 Message All
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: 12 }}>
        {zones.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No zones yet. Draw a boundary and generate zones.</p>
        )}
        {sorted.map(zone => {
          const volunteer = zone.assignedTo ? volunteers[zone.assignedTo] : null;
          const name = volunteer?.name ?? zone.assignedTo ?? '—';
          const phone = volunteer?.phone;
          return (
            <div key={zone.id}
              onClick={() => onZoneClick?.(zone)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
                cursor: onZoneClick ? 'pointer' : undefined,
                background: '#fff',
                border: zone.id === selectedZoneId ? '1px solid #1e3a5f' : '1px solid #ececec',
                borderRadius: 10, padding: '10px 12px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
              }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#f3f4f6', color: '#4b5563', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
                {zone.number}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div title={name} style={{ fontSize: 13, fontWeight: 600, color: zone.assignedTo ? '#111827' : '#c1c5cc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </div>
                {phone && (
                  <a href={`tel:${phone}`} onClick={e => e.stopPropagation()}
                    style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'none' }}>
                    {phone}
                  </a>
                )}
              </div>
              <select value={zone.status} disabled={readOnly}
                onChange={e => onStatusChange(zone.id, e.target.value)}
                onClick={e => e.stopPropagation()}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 12, border: 'none',
                  background: STATUS_COLOR[zone.status] ?? '#9ca3af', color: '#fff', flexShrink: 0,
                }}>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              {!readOnly && zone.assignedTo && (
                <button
                  onClick={e => { e.stopPropagation(); setComposeTo({ id: zone.assignedTo, label: name }); }}
                  title={`Message ${name}`}
                  style={{
                    background: messages.some(m => m.from === zone.assignedTo) ? '#dcfce7' : 'transparent',
                    border: 'none', borderRadius: '50%', width: 34, height: 34, fontSize: 19, lineHeight: 1, cursor: 'pointer', flexShrink: 0,
                  }}>
                  💬
                </button>
              )}
            </div>
          );
        })}
      </div>

      {composeTo && (
        <div style={{
          position: 'sticky', bottom: 0, background: '#fff',
          borderTop: '1px solid #ececec', boxShadow: '0 -4px 12px rgba(0,0,0,0.06)',
          padding: '12px 16px', boxSizing: 'border-box',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
              To: <span style={{ color: '#1e3a5f' }}>{composeTo.label}</span>
            </span>
            <button onClick={closeCompose} style={{ background: 'transparent', color: '#9ca3af', fontSize: 14, padding: '0 4px' }}>✕</button>
          </div>
          {thread.length > 0 && (
            <div style={{ maxHeight: 140, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {thread.map(m => (
                <div key={m.id} style={{
                  alignSelf: m.from === 'command' ? 'flex-end' : 'flex-start',
                  background: m.from === 'command' ? '#1e3a5f' : '#f3f4f6',
                  color: m.from === 'command' ? '#fff' : '#111827',
                  borderRadius: 10, padding: '6px 10px', fontSize: 12, maxWidth: '85%',
                }}>
                  {m.text}
                </div>
              ))}
            </div>
          )}
          <textarea placeholder="Type a message…" value={messageText} onChange={e => setMessageText(e.target.value)} autoFocus
            style={{ width: '100%', boxSizing: 'border-box', minHeight: 56, resize: 'vertical', border: '1px solid #d1d5db', borderRadius: 6, padding: 8, fontSize: 13, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button onClick={closeCompose} style={{ background: 'transparent', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
              Cancel
            </button>
            <button onClick={handleSend} disabled={!messageText.trim() || sending}
              style={{ background: '#1e3a5f', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, opacity: !messageText.trim() || sending ? 0.6 : 1 }}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
