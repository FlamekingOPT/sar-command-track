import { useState, useEffect } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';
import { SearchSetup } from './search/SearchSetup';
import { SearchDetail } from './search/SearchDetail';
import { HomeDashboard } from './home/HomeDashboard';
import { FeedbackPage } from './feedback/FeedbackPage';
import { watchVolunteers } from './firebase/volunteers';

function parseHash() {
  if (location.hash === '#/feedback') return { view: 'feedback' };
  const match = location.hash.match(/^#\/search\/(.+)$/);
  return match ? { view: 'detail', searchId: match[1] } : null;
}

export default function App() {
  const { user, logout } = useAuth();
  const [view, setView] = useState(() => parseHash()?.view ?? 'home'); // 'home' | 'detail' | 'feedback'
  const [searchId, setSearchId] = useState(() => parseHash()?.searchId ?? null);
  const [volunteers, setVolunteers] = useState({});

  useEffect(() => {
    if (view === 'detail' && searchId) location.hash = `#/search/${searchId}`;
    else if (view === 'feedback') location.hash = '#/feedback';
    else location.hash = '#/';
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
    return <HomeDashboard onOpen={openSearch} onNewSearch={() => openSearch(null)} onFeedback={() => setView('feedback')} onLogout={logout} />;
  }

  if (view === 'feedback') {
    return <FeedbackPage onBack={goHome} onLogout={logout} />;
  }

  if (!searchId) {
    return <SearchSetup onSearchCreated={openSearch} />;
  }

  return <SearchDetail key={searchId} searchId={searchId} volunteers={volunteers} onBack={goHome} onLogout={logout} />;
}
