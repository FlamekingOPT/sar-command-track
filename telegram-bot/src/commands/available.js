import { parseAvailableArgs, pickSearch } from '../search/resolveSearch.js';
import { pickZone } from '../assignment/assign.js';
import { DAY_ID } from '../constants.js';

export function availableHandler() {
  return async ctx => {
    const [{ getVolunteer }, { fetchActiveSearches }, { fetchZones, assignZone }, { createSearcherLink, deactivateLink }] =
      await Promise.all([
        import('../firebase/volunteers.js'),
        import('../firebase/searches.js'),
        import('../firebase/zones.js'),
        import('../firebase/links.js'),
      ]);

    const telegramId = String(ctx.from.id);
    const volunteer = await getVolunteer(telegramId);
    if (!volunteer) {
      await ctx.reply('Please register first: /register First Last');
      return;
    }

    const tokens = ctx.message.text.split(/\s+/).slice(1);
    const { code, letters } = parseAvailableArgs(tokens);
    if (!letters.length) {
      await ctx.reply('Tell me which zones you can search, e.g. /available A B');
      return;
    }

    const active = await fetchActiveSearches();
    const picked = pickSearch(active, code);
    if (picked.error === 'no_active_search') {
      await ctx.reply('There is no active search right now.');
      return;
    }
    if (picked.error === 'code_required' || picked.error === 'invalid_code') {
      const list = active.map(s => `${s.code} — ${s.name}`).join('\n');
      await ctx.reply(
        `${picked.error === 'invalid_code' ? "I don't recognize that code. " : ''}` +
        `More than one search is active — include the search code:\n${list}\n` +
        `e.g. /available ${active[0].code} ${letters.join(' ')}`
      );
      return;
    }

    const search = picked.search;
    const zones = await fetchZones(search.id, DAY_ID);
    const validLetters = [...new Set(zones.map(z => z.letter))].sort();
    const invalid = letters.filter(l => !validLetters.includes(l));
    if (invalid.length) {
      await ctx.reply(`Unknown zone${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}. Valid zones for ${search.name}: ${validLetters.join(', ')}`);
      return;
    }

    const zone = pickZone(zones, letters);
    if (!zone) {
      await ctx.reply('All requested zones are fully assigned right now — watch the group for re-search announcements, or offer more letters.');
      return;
    }

    // Create link BEFORE assigning, so the zone watcher sees an existing active
    // link for the new volunteer and knows the bot (not staff) made the assignment.
    const prev = { status: zone.status, assignedTo: zone.assignedTo };
    const token = await createSearcherLink({
      searchId: search.id, dayId: DAY_ID, zoneId: zone.id, volunteerId: telegramId,
    });
    await assignZone(search.id, DAY_ID, zone.id, { status: 'assigned', assignedTo: telegramId });

    const url = `${process.env.SEARCHER_APP_URL}/s/${token}`;
    try {
      await ctx.telegram.sendMessage(telegramId,
        `You're assigned Zone ${zone.letter}${zone.number} for ${search.name}. Open your map: ${url}`);
      if (ctx.chat.type !== 'private') {
        await ctx.reply(`${volunteer.name} → Zone ${zone.letter}${zone.number}. Check your DM for the map link.`);
      }
    } catch {
      // Volunteer never started a DM with the bot — roll the assignment back.
      await deactivateLink(token);
      await assignZone(search.id, DAY_ID, zone.id, prev);
      await ctx.reply(
        `${volunteer.name} — I can't DM you yet. Open a chat with me and press Start, then send /available again.`);
    }
  };
}
