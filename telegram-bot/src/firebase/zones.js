import { db } from './config.js';

// The ONLY code path in the bot that writes to a zone document (spec §3).
// Sets exactly two fields. Never touches polygon/letter/number, never creates or deletes.
export async function assignZone(searchId, dayId, zoneId, { status, assignedTo }) {
  await db.doc(`searches/${searchId}/days/${dayId}/zones/${zoneId}`)
    .update({ status, assignedTo });
}

export async function fetchZones(searchId, dayId) {
  const snap = await db.collection(`searches/${searchId}/days/${dayId}/zones`).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
