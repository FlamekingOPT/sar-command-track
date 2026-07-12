import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function getVolunteer(id) {
  const snap = await db.doc(`volunteers/${id}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function saveVolunteer({ id, name, telegramId = null }) {
  await db.doc(`volunteers/${id}`).set({
    name,
    telegramId,
    registeredAt: FieldValue.serverTimestamp(),
  });
}
