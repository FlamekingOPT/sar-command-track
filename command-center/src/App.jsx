import { useState, useEffect } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';
import { SearchSetup } from './search/SearchSetup';
import { SearchDetail } from './search/SearchDetail';
import { HomeDashboard } from './home/HomeDashboard';
import { watchVolunteers } from './firebase/volunteers';

function parseHash() {
  const match = location.hash.match(/^#\/search\/(.+)$/);
  return match ? match[1] : null;
}

export default function App() {
  const { user, logout } = useAuth();
  const [view, setView] = useState('home'); // 'home' | 'detail'
  const [searchId, setSearchId] = useState(() => parseHash());
  const [volunteers, setVolunteers] = useState({});

  useEffect(() => {
    if (parseHash()) setView('detail');
  }, []);

  useEffect(() => {
    location.hash = (view === 'detail' && searchId) ? `#/search/${searchId}` : '#/';
  }, [view, searchId]);

  useEffect(() => watchVolunteers(setVolunteers), []);

  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;

  function openSearch(id) {
    setSearchId(id);
    setView('detail');
  }

  function goHome() {
    setView('home');
  }

  if (view === 'home') {
    return <HomeDashboard onOpen={openSearch} onNewSearch={() => openSearch(null)} onLogout={logout} />;
  }

  if (!searchId) {
    return <SearchSetup onSearchCreated={openSearch} />;
  }

  return <SearchDetail key={searchId} searchId={searchId} volunteers={volunteers} onBack={goHome} onLogout={logout} />;
}
