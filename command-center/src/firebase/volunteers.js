import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './config';

export function watchVolunteers(cb) {
  return onSnapshot(collection(db, 'volunteers'), snap =>
    cb(Object.fromEntries(snap.docs.map(d => [d.id, d.data().name])))
  );
}
