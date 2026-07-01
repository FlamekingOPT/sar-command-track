import { useState } from 'react';
import { createSearch } from '../firebase/searches';

export function SearchSetup({ onSearchCreated }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { id } = await createSearch({ name, date });
      onSearchCreated(id);
    } catch (err) {
      console.error('createSearch failed:', err);
      setError(`Failed to create search: ${err?.message ?? err}`);
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 360 }}>
        <h2 style={{ margin: 0 }}>New Search</h2>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="Search name (e.g. Mt Wilson 2026-06-28)" required autoFocus />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
        {error && <p style={{ color: '#ef4444', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Creating…' : 'Create Search'}</button>
      </form>
    </div>
  );
}
