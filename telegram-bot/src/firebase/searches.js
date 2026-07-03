import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function fetchActiveSearches() {
  const snap = await db.collection('searches').where('status', '==', 'active').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// announcedAt guards against re-announcing on bot restart (search docs are
// not zone docs — this write is outside the assignZone restriction).
export async function markAnnounced(searchId) {
  await db.doc(`searches/${searchId}`).update({ announcedAt: FieldValue.serverTimestamp() });
}
