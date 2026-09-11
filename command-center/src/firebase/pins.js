import { collection, doc, addDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const pinsCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'pins');

export async function createPin(searchId, dayId, { lat, lng, note }) {
  await addDoc(pinsCol(searchId, dayId), { lat, lng, note, createdAt: serverTimestamp() });
}

export async function deletePin(searchId, dayId, pinId) {
  await deleteDoc(doc(db, 'searches', searchId, 'days', dayId, 'pins', pinId));
}

export function watchPins(searchId, dayId, cb) {
  return onSnapshot(pinsCol(searchId, dayId), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
