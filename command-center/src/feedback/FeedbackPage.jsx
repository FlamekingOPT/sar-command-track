import { useEffect, useState } from 'react';
import { createFeedback, deleteFeedback, updateFeedbackStatus, uploadFeedbackVideo, watchFeedback } from '../firebase/feedback';
import { useScreenRecording } from './useScreenRecording';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUS_CYCLE = ['new', 'planned', 'done'];
const STATUS_COLORS = { new: '#3b82f6', planned: '#f59e0b', done: '#22c55e' };

export function FeedbackPage({ onBack, onLogout }) {
  const [reports, setReports] = useState([]);
  const [filter, setFilter] = useState('all'); // 'all' | 'bug' | 'feature'
  const [reporter, setReporter] = useState('');
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const recording = useScreenRecording();

  useEffect(() => watchFeedback(setReports), []);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    setSubmitNotice('');
    setSubmitting(true);
    // Video upload and the text report are deliberately independent failures:
    // losing the whole report because Storage hiccuped (or isn't provisioned
    // yet) would be worse than saving the text and just flagging the video.
    let videoURL = null;
    let videoWarning = '';
    if (recording.videoBlob) {
      try {
        videoURL = await uploadFeedbackVideo(recording.videoBlob);
      } catch (err) {
        console.error('feedback video upload failed:', err);
        videoWarning = 'Report saved, but the recording failed to upload — try again without it, or ask Jack to check Storage setup.';
      }
    }
    try {
      await createFeedback({ type, title, description, severity, reporter, videoURL });
      setTitle('');
      setDescription('');
      recording.reset();
      setSubmitNotice(videoWarning);
    } catch (err) {
      console.error('feedback submit failed:', err);
      setSubmitError(`Failed to submit: ${err?.message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  }

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
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 8 }}>
        <button onClick={onBack} style={{ background: 'transparent', padding: '4px 8px' }}>← Back</button>
        <h1 style={{ margin: 0, fontSize: 22 }}>🐛 Tester Feedback</h1>
        <span style={{ flex: 1 }} />
        <button onClick={onLogout} style={{ background: '#334155', color: '#fff', padding: '8px 16px' }}>Sign Out</button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setType('bug')}
            style={{ flex: 1, padding: 8, fontWeight: 700, background: type === 'bug' ? '#ef4444' : '#f3f4f6', color: type === 'bug' ? '#fff' : '#111' }}>
            🐛 Bug
          </button>
          <button type="button" onClick={() => setType('feature')}
            style={{ flex: 1, padding: 8, fontWeight: 700, background: type === 'feature' ? '#3b82f6' : '#f3f4f6', color: type === 'feature' ? '#fff' : '#111' }}>
            💡 Feature request
          </button>
        </div>

        <input value={reporter} onChange={e => setReporter(e.target.value)} placeholder="Your name (optional)" />
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Short title" required />
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What happened? What did you expect?" required rows={4} />

        {type === 'bug' && (
          <div style={{ display: 'flex', gap: 6 }}>
            {SEVERITIES.map(s => (
              <button key={s} type="button" onClick={() => setSeverity(s)}
                style={{ flex: 1, padding: '4px 8px', fontSize: 12, textTransform: 'capitalize',
                  background: severity === s ? '#334155' : '#f3f4f6', color: severity === s ? '#fff' : '#111' }}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div>
          {!recording.recording && !recording.previewUrl && (
            <button type="button" onClick={recording.start} style={{ background: '#7c3aed', color: '#fff', padding: '6px 12px' }}>
              ⏺ Record screen
            </button>
          )}
          {recording.recording && (
            <button type="button" onClick={recording.stop} style={{ background: '#ef4444', color: '#fff', padding: '6px 12px' }}>
              ⏹ Stop recording (auto-stops at 3 min)
            </button>
          )}
          {recording.previewUrl && (
            <div style={{ marginTop: 8 }}>
              <video src={recording.previewUrl} controls style={{ maxWidth: '100%', maxHeight: 200, display: 'block', marginBottom: 6 }} />
              <button type="button" onClick={recording.reset} style={{ background: '#f3f4f6', padding: '4px 10px', fontSize: 12 }}>
                🗑 Discard recording
              </button>
            </div>
          )}
          {recording.error && <p style={{ color: '#ef4444', fontSize: 13, margin: '4px 0 0' }}>{recording.error}</p>}
        </div>

        {submitError && <p style={{ color: '#ef4444', margin: 0 }}>{submitError}</p>}
        {submitNotice && <p style={{ color: '#b45309', margin: 0 }}>⚠ {submitNotice}</p>}
        <button type="submit" disabled={submitting || recording.recording} style={{ background: '#22c55e', color: '#fff', padding: '10px', fontWeight: 700 }}>
          {submitting ? (recording.videoBlob ? 'Uploading video…' : 'Submitting…') : 'Submit report'}
        </button>
      </form>

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
          </div>
        </div>
      ))}
    </div>
  );
}
