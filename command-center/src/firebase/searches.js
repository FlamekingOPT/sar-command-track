import { collection, doc, addDoc, updateDoc, deleteDoc, getDocs, query, where, writeBatch, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';
import { generateSearchCode } from '../search/searchCode';
import { parseBoundaries } from '../search/boundaries';

const DAY_ID = 'day-1';

export async function createSearch({ name, date }) {
  const ref = await addDoc(collection(db, 'searches'), {
    name, date, status: 'setup', createdAt: serverTimestamp(), boundaries: null,
    code: generateSearchCode(),
  });
  return { id: ref.id };
}

export async function updateSearchBoundary(searchId, boundary) {
  await updateDoc(doc(db, 'searches', searchId), { boundary: JSON.stringify(boundary) });
}

export async function updateSearchBoundaries(searchId, boundaries) {
  await updateDoc(doc(db, 'searches', searchId), { boundaries: JSON.stringify(boundaries) });
}

export async function publishSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'active' });
}

export async function completeSearch(searchId) {
  await updateDoc(doc(db, 'searches', searchId), { status: 'complete' });
}

async function deleteInBatches(refs) {
  while (refs.length) {
    const batch = writeBatch(db);
    refs.splice(0, 500).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

// Firestore has no cascading delete — clean up every subcollection and every
// root-level doc that references this search before removing the search itself.
export async function deleteSearch(searchId) {
  for (const name of ['zones', 'tracks', 'markers']) {
    const snap = await getDocs(collection(db, 'searches', searchId, 'days', DAY_ID, name));
    await deleteInBatches(snap.docs.map(d => d.ref));
  }
  for (const [col, field] of [['searcherLinks', 'searchId'], ['zoneRequests', 'searchId']]) {
    const snap = await getDocs(query(collection(db, col), where(field, '==', searchId)));
    await deleteInBatches(snap.docs.map(d => d.ref));
  }
  await deleteDoc(doc(db, 'searches', searchId));
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
    const boundaries = parseBoundaries(data);
    cb({
      id: snap.id,
      ...data,
      boundaries,
      // legacy field kept until SearchDetail switches over (Task 7 removes it)
      boundary: boundaries[0]?.geometry ?? null,
    });
  });
}
