import { DAY_ID } from '../constants.js';
import { signupMessage } from '../messages.js';

export function watchSearches(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { fetchZones } = await import('../firebase/zones.js');
    const { markAnnounced } = await import('../firebase/searches.js');

    unsubscribe = db.collection('searches')
      .where('status', '==', 'active')
      .onSnapshot(async snap => {
        const activeCount = snap.size;
        for (const change of snap.docChanges()) {
          if (change.type === 'removed') continue;
          const search = { id: change.doc.id, ...change.doc.data() };
          if (search.announcedAt) continue; // already announced (incl. before a restart)

          await markAnnounced(search.id); // claim first so a crash can't double-post
          const zones = await fetchZones(search.id, DAY_ID);
          const letters = [...new Set(zones.map(z => z.letter))].sort();
          await bot.telegram.sendMessage(
            process.env.TELEGRAM_GROUP_CHAT_ID,
            signupMessage(search, letters, activeCount > 1)
          );
        }
      }, err => console.error('searchWatcher error:', err));
  })();
  return () => unsubscribe();
}
