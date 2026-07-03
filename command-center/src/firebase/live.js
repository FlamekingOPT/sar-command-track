import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './config';

// Live volunteer data for an active search: GPS tracks and dropped markers.
// Written by the Searcher PWA; the Command Center only reads.

export function watchTracks(searchId, dayId, cb) {
  return onSnapshot(collection(db, 'searches', searchId, 'days', dayId, 'tracks'), snap =>
    cb(snap.docs.map(d => ({ volunteerId: d.id, ...d.data() })))
  );
}

export function watchMarkers(searchId, dayId, cb) {
  return onSnapshot(collection(db, 'searches', searchId, 'days', dayId, 'markers'), snap =>
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  );
}
