import { reSearchMessage } from '../messages.js';

// Watches every zone doc (collectionGroup). Detects transitions by diffing
// against an in-memory previous-state map; the initial snapshot only seeds
// the map so a bot restart never replays old events.
export function watchZoneChanges(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { deactivateLinksForZone, findActiveLink, createSearcherLink } = await import('../firebase/links.js');

    const prev = new Map();
    let initial = true;

    unsubscribe = db.collectionGroup('zones').onSnapshot(async snap => {
      const changes = snap.docChanges();
      if (initial) {
        initial = false;
        for (const c of changes) prev.set(c.doc.ref.path, c.doc.data());
        return;
      }
      for (const c of changes) {
        const path = c.doc.ref.path; // searches/{sid}/days/{did}/zones/{zid}
        if (c.type === 'removed') { prev.delete(path); continue; }
        const before = prev.get(path);
        const after = c.doc.data();
        prev.set(path, after);
        if (!before) continue; // zone created after startup — no transition to react to

        const [, searchId, , dayId, , zoneId] = path.split('/');
        const searchSnap = await db.doc(`searches/${searchId}`).get();
        if (searchSnap.data()?.status !== 'active') continue;

        // 1. Staff flagged a re-search → announce in the group (spec §3).
        if (after.status === 'needs_re_search' && before.status !== 'needs_re_search') {
          await bot.telegram.sendMessage(process.env.TELEGRAM_GROUP_CHAT_ID, reSearchMessage(after));
        }

        // 2. Assignment changed.
        if (before.assignedTo !== after.assignedTo) {
          // Deactivate stale links, but never the new assignee's own link
          // (the /available flow creates it just before assigning).
          await deactivateLinksForZone(searchId, dayId, zoneId, { except: after.assignedTo ?? undefined });

          // DM whoever lost the zone (reassign or release, spec §3).
          if (before.assignedTo) {
            await bot.telegram.sendMessage(before.assignedTo,
              `Your assignment to Zone ${after.letter}${after.number} was changed by command. ` +
              `Reply /available in the group to get a new zone.`).catch(() => {});
          }

          // Staff assigned someone directly in the Command Center → they have no
          // link yet; create one and DM it. (Bot-made assignments already have one.)
          if (after.assignedTo && !(await findActiveLink(searchId, dayId, zoneId, after.assignedTo))) {
            const token = await createSearcherLink({
              searchId, dayId, zoneId, volunteerId: after.assignedTo,
            });
            const url = `${process.env.SEARCHER_APP_URL}/s/${token}`;
            await bot.telegram.sendMessage(after.assignedTo,
              `You've been assigned Zone ${after.letter}${after.number}. Open your map: ${url}`
            ).catch(() => {});
          }
        }
      }
    }, err => console.error('zoneWatcher error:', err));
  })();
  return () => unsubscribe();
}
