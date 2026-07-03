import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';

export async function getVolunteer(telegramId) {
  const snap = await db.doc(`volunteers/${telegramId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function saveVolunteer({ telegramId, name }) {
  await db.doc(`volunteers/${telegramId}`).set({
    name,
    telegramId,
    registeredAt: FieldValue.serverTimestamp(),
  });
}
