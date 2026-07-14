import { doc, getDoc } from 'firebase/firestore';
import { db } from './config';

export async function getSearch(searchId) {
  const snap = await getDoc(doc(db, 'searches', searchId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}
