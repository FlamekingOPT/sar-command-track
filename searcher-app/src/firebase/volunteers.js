import { doc, setDoc } from 'firebase/firestore';
import { db } from './config';

export function setVolunteerPhone(volunteerId, phone) {
  return setDoc(doc(db, 'volunteers', volunteerId), { phone }, { merge: true });
}
