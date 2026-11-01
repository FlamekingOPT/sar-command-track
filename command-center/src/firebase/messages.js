import { collection, addDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const messagesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'messages');

// to: a volunteerId, or null to broadcast to every assigned searcher.
export async function createMessage(searchId, dayId, { to, text }) {
  await addDoc(messagesCol(searchId, dayId), { from: 'command', to, text, createdAt: serverTimestamp() });
}

export function watchMessages(searchId, dayId, cb) {
  return onSnapshot(messagesCol(searchId, dayId), snap =>
    cb(snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0)))
  );
}
