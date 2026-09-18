import { useState } from 'react';
import { createFeedback, uploadFeedbackVideo } from '../firebase/feedback';
import { useScreenRecording } from './useScreenRecording';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

// Shared by the standalone Feedback page and the in-search report overlay
// (SearchDetail) — reporting from inside a live search should feel like the
// same tool, not a separate one, and both need the same recording flow.
export function FeedbackForm({ searchContext = null, onSubmitted }) {
  const [reporter, setReporter] = useState('');
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const recording = useScreenRecording();

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    setSubmitNotice('');
    setSubmitting(true);
    // Video upload and the text report are deliberately independent failures:
    // losing the whole report because Storage hiccuped would be worse than
    // saving the text and just flagging the video.
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
      await createFeedback({
        type, title, description, severity, reporter, videoURL,
        searchId: searchContext?.searchId ?? null,
        searchName: searchContext?.searchName ?? null,
      });
      setTitle('');
      setDescription('');
      recording.reset();
      if (videoWarning) setSubmitNotice(videoWarning);
      else onSubmitted?.();
    } catch (err) {
      console.error('feedback submit failed:', err);
      setSubmitError(`Failed to submit: ${err?.message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 }}>
      {searchContext?.searchName && (
        <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Reporting on: <strong>{searchContext.searchName}</strong></p>
      )}
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
  );
}
