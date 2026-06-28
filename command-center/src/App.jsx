import { useAuth } from './auth/useAuth';
import { LoginPage } from './auth/LoginPage';

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!user) return <LoginPage />;
  return <p style={{ padding: 24 }}>Logged in as {user.email}</p>;
}
