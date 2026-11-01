import { collection, addDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

const messagesCol = (searchId, dayId) =>
  collection(db, 'searches', searchId, 'days', dayId, 'messages');

// Command-center-sent messages are read-only from the searcher side, aside
// from replying. Small, ephemeral collection per search day — same open-read
// model as pins/markers, filtered client-side to this volunteer's own
// messages plus any broadcast (to: null) ones, oldest first.
export function watchMessages(searchId, dayId, volunteerId, cb) {
  return onSnapshot(messagesCol(searchId, dayId), snap => {
    const mine = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => m.from === 'command' && (m.to === null || m.to === volunteerId))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
    cb(mine);
  });
}

export async function replyToMessage(searchId, dayId, { volunteerId, text }) {
  await addDoc(messagesCol(searchId, dayId), { from: volunteerId, to: 'command', text, createdAt: serverTimestamp() });
}
