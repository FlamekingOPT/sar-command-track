import { useState } from 'react';
import { useAuth } from './useAuth';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
    } catch {
      setError('Invalid email or password.');
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320 }}>
        <h1 style={{ margin: 0 }}>SAR Command Center</h1>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required autoFocus />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required />
        {error && <p style={{ color: '#ef4444', margin: 0 }}>{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign In'}</button>
      </form>
    </div>
  );
}
