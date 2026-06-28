import { useState, useEffect } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { auth } from '../firebase/config';

export function useAuth() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    return onAuthStateChanged(auth, setUser);
  }, []);

  return {
    user,
    login: (email, password) => signInWithEmailAndPassword(auth, email, password),
    logout: () => signOut(auth),
  };
}
