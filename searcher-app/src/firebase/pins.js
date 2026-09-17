import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './config';

// Command-center-dropped pins are read-only from the searcher side.
export function watchPins(searchId, dayId, cb) {
  return onSnapshot(collection(db, 'searches', searchId, 'days', dayId, 'pins'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
