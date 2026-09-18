import { useEffect, useState } from 'react';
import { deleteFeedback, updateFeedbackStatus, watchFeedback } from '../firebase/feedback';
import { FeedbackForm } from './FeedbackForm';

const STATUS_CYCLE = ['new', 'planned', 'done'];
const STATUS_COLORS = { new: '#3b82f6', planned: '#f59e0b', done: '#22c55e' };

export function FeedbackPage({ onBack, onLogout }) {
  const [reports, setReports] = useState([]);
  const [filter, setFilter] = useState('all'); // 'all' | 'bug' | 'feature'

  useEffect(() => watchFeedback(setReports), []);

  async function handleCycleStatus(report) {
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(report.status) + 1) % STATUS_CYCLE.length];
    await updateFeedbackStatus(report.id, next);
  }

  async function handleDelete(report) {
    if (!window.confirm(`Delete this report? "${report.title}"`)) return;
    await deleteFeedback(report.id);
  }

  const visible = reports.filter(r => filter === 'all' || r.type === filter);

  return (
    // Fixed header + independently scrolling body — not a sticky header
    // inside a page-scrolling div. A long report list (especially with
    // videos) pushed "← Back"/"Sign Out" out of the viewport with no way
    // back to them (field bug 2026-09-17, same class as the in-search
    // report overlay's close button earlier tonight).
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 24px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 22 }}>🐛 Tester Feedback</h1>
        <span style={{ flex: 1 }} />
        <button onClick={onLogout} style={{ background: '#334155', color: '#fff', padding: '8px 16px' }}>Sign Out</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ marginBottom: 24 }}>
            <FeedbackForm />
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {['all', 'bug', 'feature'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ padding: '4px 10px', fontSize: 12, textTransform: 'capitalize',
                  background: filter === f ? '#334155' : '#f3f4f6', color: filter === f ? '#fff' : '#111' }}>
                {f}
              </button>
            ))}
          </div>

          {visible.length === 0 && <p style={{ color: '#9ca3af' }}>No reports yet.</p>}
          {visible.map(r => (
            <div key={r.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span>{r.type === 'bug' ? '🐛' : '💡'}</span>
                <strong style={{ flex: 1 }}>{r.title}</strong>
                {r.type === 'bug' && r.severity && (
                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: '#f3f4f6', textTransform: 'capitalize' }}>{r.severity}</span>
                )}
                <button onClick={() => handleCycleStatus(r)}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, color: '#fff', background: STATUS_COLORS[r.status] ?? '#9ca3af', textTransform: 'capitalize' }}>
                  {r.status}
                </button>
                <button onClick={() => handleDelete(r)} style={{ background: 'transparent', color: '#ef4444', padding: '2px 6px', fontSize: 12 }}>✕</button>
              </div>
              <p style={{ margin: '4px 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{r.description}</p>
              {r.videoURL && (
                <video src={r.videoURL} controls style={{ maxWidth: '100%', maxHeight: 240, display: 'block', margin: '6px 0' }} />
              )}
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {r.reporter || 'Anonymous'} · {r.createdAt?.toDate?.().toLocaleString() ?? ''}
                {r.searchName && <> · on <strong>{r.searchName}</strong></>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
