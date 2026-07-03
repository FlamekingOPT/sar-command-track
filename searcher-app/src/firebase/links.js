import { doc, getDoc } from 'firebase/firestore';
import { db } from './config';

export async function resolveLink(token) {
  const snap = await getDoc(doc(db, 'searcherLinks', token));
  if (!snap.exists() || !snap.data().active) return null;
  const { searchId, dayId, zoneId, volunteerId } = snap.data();
  return { searchId, dayId, zoneId, volunteerId };
}
