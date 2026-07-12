// Watches every search (not zone) for a transition into 'complete', same
// before/after diffing style as zoneWatcher.js. Revocation is best-effort —
// if the bot was demoted from admin mid-search, completion shouldn't hang or
// error (spec §3/§6).
export function watchSearchCompletion(bot) {
  let unsubscribe = () => {};
  (async () => {
    const { db } = await import('../firebase/config.js');
    const { markInviteRevoked } = await import('../firebase/searches.js');

    const prev = new Map();
    let initial = true;

    unsubscribe = db.collection('searches').onSnapshot(async snap => {
      const changes = snap.docChanges();
      if (initial) {
        initial = false;
        for (const c of changes) prev.set(c.doc.id, c.doc.data());
        return;
      }
      for (const c of changes) {
        if (c.type === 'removed') { prev.delete(c.doc.id); continue; }
        const before = prev.get(c.doc.id);
        const after = c.doc.data();
        prev.set(c.doc.id, after);
        if (!before) continue; // search created after startup — no transition to react to

        if (after.status === 'complete' && before.status !== 'complete'
            && after.groupChatId && after.inviteLink && !after.inviteLinkRevoked) {
          await bot.telegram.revokeChatInviteLink(after.groupChatId, after.inviteLink).catch(() => {});
          await markInviteRevoked(c.doc.id);
        }
      }
    }, err => console.error('completionWatcher error:', err));
  })();
  return () => unsubscribe();
}
