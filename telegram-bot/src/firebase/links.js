import { FieldValue } from 'firebase-admin/firestore';
import { db } from './config.js';
import { generateToken } from './tokens.js';

export async function createSearcherLink({ searchId, dayId, zoneId, volunteerId }) {
  const token = generateToken();
  await db.doc(`searcherLinks/${token}`).set({
    searchId, dayId, zoneId, volunteerId,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
  });
  return token;
}

async function activeLinksForZone(searchId, dayId, zoneId) {
  const snap = await db.collection('searcherLinks')
    .where('searchId', '==', searchId)
    .where('dayId', '==', dayId)
    .where('zoneId', '==', zoneId)
    .where('active', '==', true)
    .get();
  return snap.docs;
}

// `except` protects a just-created link for the new assignee from being
// deactivated by the zone watcher racing the /available handler.
export async function deactivateLinksForZone(searchId, dayId, zoneId, { except } = {}) {
  const docs = await activeLinksForZone(searchId, dayId, zoneId);
  await Promise.all(
    docs
      .filter(d => d.data().volunteerId !== except)
      .map(d => d.ref.update({ active: false }))
  );
}

export async function findActiveLink(searchId, dayId, zoneId, volunteerId) {
  const docs = await activeLinksForZone(searchId, dayId, zoneId);
  const match = docs.find(d => d.data().volunteerId === volunteerId);
  return match ? { token: match.id, ...match.data() } : null;
}

export async function deactivateLink(token) {
  await db.doc(`searcherLinks/${token}`).update({ active: false });
}
