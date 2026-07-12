import { db } from './config.js';

// The single write path for resolving a web zone-request — mirrors zones.js's
// assignZone in being the bot's ONLY writer of this collection (Firestore
// rules deny client writes to anything but create; spec §2).
export async function resolveRequest(requestId, updates) {
  await db.doc(`zoneRequests/${requestId}`).update(updates);
}
