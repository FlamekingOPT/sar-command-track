import { doc, runTransaction, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

const ASSIGNABLE = ['unassigned', 'needs_re_search'];

// Client claims a zone directly via a Firestore transaction — no bot/server
// needed. Two searchers racing the same letter: Firestore retries the loser's
// transaction, it re-reads the now-'assigned' zone, and the rule/ASSIGNABLE
// check fails, so we fall through to the next same-letter zone.
export async function claimZone({ searchId, dayId, letter, zones, volunteerId, name }) {
  await setDoc(doc(db, 'volunteers', volunteerId), { name }, { merge: true });

  const candidates = zones.filter(z => z.letter === letter && ASSIGNABLE.includes(z.status));
  for (const zone of candidates) {
    const zoneRef = doc(db, 'searches', searchId, 'days', dayId, 'zones', zone.id);
    const token = crypto.randomUUID();
    const linkRef = doc(db, 'searcherLinks', token);
    try {
      await runTransaction(db, async tx => {
        const snap = await tx.get(zoneRef);
        if (!ASSIGNABLE.includes(snap.data()?.status)) throw new Error('taken');
        tx.update(zoneRef, { status: 'assigned', assignedTo: volunteerId });
        tx.set(linkRef, {
          searchId, dayId, zoneId: zone.id, volunteerId,
          active: true, createdAt: serverTimestamp(),
        });
      });
      return token;
    } catch {
      continue;
    }
  }
  return null; // every same-letter zone got taken before we landed one
}
