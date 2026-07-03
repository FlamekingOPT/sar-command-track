import { useState, useEffect } from 'react';
import { watchSearches } from '../firebase/searches';
import { sortSearches } from './sortSearches';
import { SearchRow } from './SearchRow';

export function HomeDashboard({ onOpen, onNewSearch, onLogout }) {
  const [searches, setSearches] = useState([]);

  useEffect(() => watchSearches(setSearches), []);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>SAR Command</h1>
        <span style={{ flex: 1 }} />
        <button onClick={onNewSearch} style={{ background: '#3b82f6', padding: '8px 16px', fontWeight: 700 }}>
          + New Search
        </button>
        <button onClick={onLogout} style={{ background: '#334155', color: '#fff', padding: '8px 16px' }}>
          Sign Out
        </button>
      </div>
      {searches.length === 0 && (
        <p style={{ color: '#9ca3af' }}>No searches yet. Click "+ New Search" to start one.</p>
      )}
      {sortSearches(searches).map(search => (
        <SearchRow key={search.id} search={search} onOpen={() => onOpen(search.id)} />
      ))}
    </div>
  );
}
