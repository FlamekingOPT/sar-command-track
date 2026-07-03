import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './config';

export async function createMarker({ searchId, dayId, volunteerId, lat, lng, note }) {
  await addDoc(collection(db, 'searches', searchId, 'days', dayId, 'markers'), {
    volunteerId, lat, lng, note, createdAt: serverTimestamp(),
  });
}
