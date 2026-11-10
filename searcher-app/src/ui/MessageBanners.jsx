import { useState } from 'react';

// Dismiss is local/session-only (no read-receipt in Firestore) — same spirit
// as pins/markers, which also carry no ack state back to command.
export function MessageBanners({ messages, onReply }) {
  const [dismissed, setDismissed] = useState({});
  const [replying, setReplying] = useState({}); // id -> draft text, '' once opened
  const [sent, setSent] = useState({}); // id -> the reply text that was sent
  const visible = messages.filter(m => !dismissed[m.id]);
  if (!visible.length) return null;

  async function handleSendReply(id) {
    const text = (replying[id] ?? '').trim();
    if (!text) return;
    await onReply(text);
    setSent(s => ({ ...s, [id]: text }));
    setReplying(r => { const next = { ...r }; delete next[id]; return next; });
  }

  return (
    <div style={{
      position: 'fixed', top: 64, left: 12, right: 12, zIndex: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {visible.map(m => (
        <div key={m.id} style={{
          background: '#1e3a5f', color: '#fff', borderRadius: 10, padding: '10px 12px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>💬</span>
            <div style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#93c5fd', marginBottom: 2 }}>
                {m.to === null ? 'Command — Everyone' : 'Command'}
              </div>
              {m.text}
            </div>
            <button onClick={() => setDismissed(d => ({ ...d, [m.id]: true }))}
              style={{ background: 'transparent', border: 'none', color: '#cbd5e1', fontSize: 13, padding: '0 2px' }}>
              ✕
            </button>
          </div>

          {sent[m.id] ? (
            <div style={{ marginTop: 8, fontSize: 12, color: '#93c5fd' }}>
              ✓ You replied: {sent[m.id]}
            </div>
          ) : replying[m.id] !== undefined ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input autoFocus value={replying[m.id]}
                onChange={e => setReplying(r => ({ ...r, [m.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') handleSendReply(m.id); }}
                placeholder="Type a reply…"
                style={{ flex: 1, borderRadius: 6, border: 'none', padding: '4px 8px', fontSize: 12 }} />
              <button onClick={() => handleSendReply(m.id)}
                style={{ background: '#fff', color: '#1e3a5f', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600 }}>
                Send
              </button>
            </div>
          ) : (
            <button onClick={() => setReplying(r => ({ ...r, [m.id]: '' }))}
              style={{ marginTop: 6, background: 'transparent', border: 'none', color: '#93c5fd', fontSize: 12, padding: 0, textDecoration: 'underline' }}>
              Reply
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
