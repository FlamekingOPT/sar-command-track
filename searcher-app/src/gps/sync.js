import { pendingEntries, markSynced, linkKeyOf } from './offlineQueue';
import { appendTrackPoints } from '../firebase/tracks';
import { createMarker } from '../firebase/markers';
import { updateZoneStatus } from '../firebase/zones';

// Entries that fail stay queued and retry on the next tick (spec §4).
export async function flushOnce(linkCtx) {
  const key = linkKeyOf(linkCtx);
  // Only sync entries belonging to THIS assignment. Stale entries from a prior
  // search stay inert rather than corrupting the current zone's track doc.
  const entries = (await pendingEntries()).filter(e => e.linkKey === key);
  if (!entries.length) return 0;
  const done = [];

  // All pending track points go up as ONE arrayUnion write.
  const trackEntries = entries.filter(e => e.type === 'trackPoint');
  if (trackEntries.length) {
    try {
      await appendTrackPoints({ ...linkCtx, points: trackEntries.map(e => e.payload) });
      done.push(...trackEntries.map(e => e.id));
    } catch { /* retry next tick */ }
  }

  for (const entry of entries.filter(e => e.type !== 'trackPoint')) {
    try {
      if (entry.type === 'marker') await createMarker({ ...linkCtx, ...entry.payload });
      else if (entry.type === 'status') await updateZoneStatus({ ...linkCtx, status: entry.payload.status });
      done.push(entry.id);
    } catch { /* retry next tick */ }
  }

  if (done.length) await markSynced(done);
  return done.length;
}

export function startSync(linkCtx, intervalMs = 10000) {
  flushOnce(linkCtx).catch(() => {});
  const id = setInterval(() => flushOnce(linkCtx).catch(() => {}), intervalMs);
  return () => clearInterval(id);
}
