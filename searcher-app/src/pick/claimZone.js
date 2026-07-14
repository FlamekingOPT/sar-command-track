import { doc, runTransaction, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

export const ASSIGNABLE = ['unassigned', 'needs_re_search'];

// Client claims one specific zone directly via a Firestore transaction — no
// bot/server needed. A searcher taps exactly one zone (flat model, no letter
// grouping to fall through within), so a lost race just reports unavailable —
// the same "that zone just filled up" UI already handles this correctly.
export async function claimZone({ searchId, dayId, zoneId, volunteerId, name }) {
  await setDoc(doc(db, 'volunteers', volunteerId), { name }, { merge: true });

  const zoneRef = doc(db, 'searches', searchId, 'days', dayId, 'zones', zoneId);
  const token = crypto.randomUUID();
  const linkRef = doc(db, 'searcherLinks', token);
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(zoneRef);
      if (!ASSIGNABLE.includes(snap.data()?.status)) throw new Error('taken');
      tx.update(zoneRef, { status: 'assigned', assignedTo: volunteerId });
      tx.set(linkRef, {
        searchId, dayId, zoneId, volunteerId,
        active: true, createdAt: serverTimestamp(),
      });
    });
    return token;
  } catch {
    return null; // zone was taken between tap and transaction
  }
}
