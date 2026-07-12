import { doc, addDoc, collection, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createRequest({ searchId, letter, webVolunteerId, name }) {
  const ref = await addDoc(collection(db, 'zoneRequests'), {
    searchId, letter, webVolunteerId, name,
    status: 'pending', zoneId: null, token: null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function watchRequest(requestId, cb) {
  return onSnapshot(doc(db, 'zoneRequests', requestId), snap => {
    if (snap.exists()) cb({ id: snap.id, ...snap.data() });
  });
}
