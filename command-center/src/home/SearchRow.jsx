// command-center/src/home/SearchRow.jsx
import { StatusPill } from '../ui/StatusPill';
import { completeSearch } from '../firebase/searches';

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => window.prompt('Copy this link:', text));
  } else {
    window.prompt('Copy this link:', text);
  }
}

export function SearchRow({ search, onOpen }) {
  async function handleComplete(e) {
    e.stopPropagation();
    if (!window.confirm(`Complete "${search.name}"? Volunteers will no longer be able to sign up.`)) return;
    await completeSearch(search.id);
  }

  function handleCopyInvite(e) {
    e.stopPropagation();
    copyToClipboard(search.inviteLink);
  }

  function handleCopyPicker(e) {
    e.stopPropagation();
    copyToClipboard(`${import.meta.env.VITE_SEARCHER_APP_URL}/pick/${search.id}`);
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, cursor: 'pointer',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{search.name}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {search.date}
          {search.code && <span style={{ fontFamily: 'monospace', marginLeft: 8 }}>· Bind: {search.code}</span>}
        </div>
      </div>
      <StatusPill status={search.status} />
      {search.inviteLink && (
        <button onClick={handleCopyInvite} style={{ background: '#334155', padding: '4px 10px', fontSize: 12 }}>
          Copy Invite Link
        </button>
      )}
      {search.status !== 'complete' && (
        <button onClick={handleCopyPicker} style={{ background: '#334155', padding: '4px 10px', fontSize: 12 }}>
          Copy Picker Link
        </button>
      )}
      {search.status === 'active' && (
        <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
          Complete
        </button>
      )}
    </div>
  );
}
