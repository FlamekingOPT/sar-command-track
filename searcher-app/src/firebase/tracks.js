import { doc, setDoc, arrayUnion } from 'firebase/firestore';
import { db } from './config';

export async function appendTrackPoints({ searchId, dayId, volunteerId, points }) {
  const ref = doc(db, 'searches', searchId, 'days', dayId, 'tracks', volunteerId);
  await setDoc(ref, { points: arrayUnion(...points) }, { merge: true });
}
