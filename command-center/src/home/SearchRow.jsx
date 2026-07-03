import { StatusPill } from '../ui/StatusPill';
import { completeSearch } from '../firebase/searches';

export function SearchRow({ search, onOpen }) {
  async function handleComplete(e) {
    e.stopPropagation();
    if (!window.confirm(`Complete "${search.name}"? Volunteers will no longer be able to sign up.`)) return;
    await completeSearch(search.id);
  }

  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
      border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, cursor: 'pointer',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{search.name}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{search.date}</div>
      </div>
      <StatusPill status={search.status} />
      {search.status === 'active' && (
        <button onClick={handleComplete} style={{ background: '#7f1d1d', padding: '4px 12px' }}>
          Complete
        </button>
      )}
    </div>
  );
}
