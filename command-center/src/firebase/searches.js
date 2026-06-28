import { collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundary: null, letterZones: [],
  });
  return { id: ref.id };
}

export async function updateSearchBoundary(searchId, boundary) {
  await updateDoc(doc(db, 'searches', searchId), { boundary });
}

export async function publishSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'active' });
}

export function watchSearches(cb) {
  return onSnapshot(collection(db, 'searches'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
