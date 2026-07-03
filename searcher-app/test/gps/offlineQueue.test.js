import 'fake-indexeddb/auto'; // installs indexedDB + IDBRequest/IDBKeyRange/… globals for idb
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { enqueue, pendingEntries, allEntries, markSynced, _resetForTests } from '../../src/gps/offlineQueue.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // fresh DB per test
  _resetForTests();
});

describe('offlineQueue', () => {
  it('enqueued entries appear as pending', async () => {
    await enqueue('trackPoint', { lat: 34.05, lng: -118.25, timestamp: 1 });
    const pending = await pendingEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('trackPoint');
    expect(pending[0].payload.lat).toBe(34.05);
  });

  it('markSynced removes entries from pending but keeps them in allEntries', async () => {
    const id1 = await enqueue('trackPoint', { lat: 1, lng: 2, timestamp: 1 });
    await enqueue('marker', { lat: 3, lng: 4, note: 'backpack' });
    await markSynced([id1]);

    expect(await pendingEntries()).toHaveLength(1);
    expect((await pendingEntries())[0].type).toBe('marker');
    expect(await allEntries()).toHaveLength(2);
  });

  it('preserves insertion order', async () => {
    await enqueue('trackPoint', { timestamp: 1 });
    await enqueue('trackPoint', { timestamp: 2 });
    await enqueue('trackPoint', { timestamp: 3 });
    const pending = await pendingEntries();
    expect(pending.map(e => e.payload.timestamp)).toEqual([1, 2, 3]);
  });

  it('markSynced ignores unknown ids', async () => {
    await enqueue('status', { status: 'searched' });
    await markSynced([9999]);
    expect(await pendingEntries()).toHaveLength(1);
  });
});
