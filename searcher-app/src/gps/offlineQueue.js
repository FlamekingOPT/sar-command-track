import { openDB } from 'idb';

let dbPromise;

function queueDb() {
  dbPromise ??= openDB('sar-searcher', 1, {
    upgrade(db) {
      const store = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      store.createIndex('synced', 'synced');
    },
  });
  return dbPromise;
}

// Stable identity for one zone assignment. Queue entries are stamped with it so
// track points / markers / status from a PREVIOUS search on this device never
// replay onto — or sync into — the current zone (they share one IndexedDB store).
export function linkKeyOf(ctx) {
  return ctx ? `${ctx.searchId}/${ctx.dayId}/${ctx.zoneId}/${ctx.volunteerId}` : null;
}

export async function enqueue(type, payload, linkKey = null) {
  const db = await queueDb();
  return db.add('queue', { type, payload, linkKey, synced: 0, createdAt: Date.now() });
}

export async function pendingEntries() {
  const db = await queueDb();
  return db.getAllFromIndex('queue', 'synced', 0);
}

export async function allEntries() {
  const db = await queueDb();
  return db.getAll('queue');
}

export async function markSynced(ids) {
  const db = await queueDb();
  const tx = db.transaction('queue', 'readwrite');
  for (const id of ids) {
    const entry = await tx.store.get(id);
    if (entry) {
      entry.synced = 1;
      await tx.store.put(entry);
    }
  }
  await tx.done;
}

export function _resetForTests() {
  dbPromise = undefined;
}
