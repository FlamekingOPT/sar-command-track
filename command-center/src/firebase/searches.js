import { collection, doc, addDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';
import { generateSearchCode } from '../search/searchCode';

export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundary: null, letterZones: [],
    code: generateSearchCode(),
  });
  return { id: ref.id };
}

export async function updateSearchBoundary(searchId, boundary) {
  await updateDoc(doc(db, 'searches', searchId), { boundary: JSON.stringify(boundary) });
}

export async function publishSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'active' });
}

export async function updateSearchLetterZones(searchId, letterZones) {
  await updateDoc(doc(db, 'searches', searchId), {
    letterZones: letterZones.map(z => ({
      letter: z.letter,
      geometry: JSON.stringify(z.feature.geometry),
    })),
  });
}

export function watchSearches(cb) {
  return onSnapshot(collection(db, 'searches'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}

export function watchSearch(searchId, cb) {
  return onSnapshot(doc(db, 'searches', searchId), snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    cb({
      id: snap.id,
      ...data,
      boundary: data.boundary ? JSON.parse(data.boundary) : null,
      letterZones: (data.letterZones ?? []).map(z => ({
        ...z,
        geometry: z.geometry ? JSON.parse(z.geometry) : null,
      })),
    });
  });
}
