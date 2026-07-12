export function parseBindArgs(text) {
  const tokens = text.replace(/^\/bind(@\w+)?/i, '').trim().split(/\s+/).filter(Boolean);
  return { code: tokens[0]?.toUpperCase() ?? null };
}

export function bindHandler() {
  return async ctx => {
    const { fetchBindableSearches, bindGroup } = await import('../firebase/searches.js');
    const { pickSearch } = await import('../search/resolveSearch.js');

    const { code } = parseBindArgs(ctx.message.text);
    const bindable = await fetchBindableSearches();
    const picked = pickSearch(bindable, code);

    if (picked.error === 'no_active_search') {
      await ctx.reply('No search is ready to bind right now — create one in the Command Center first.');
      return;
    }
    if (picked.error === 'code_required' || picked.error === 'invalid_code') {
      const list = bindable.map(s => `${s.code} — ${s.name}`).join('\n');
      await ctx.reply(
        `${picked.error === 'invalid_code' ? "I don't recognize that code. " : ''}` +
        `More than one search is bindable — include the code:\n${list}\ne.g. /bind ${bindable[0].code}`
      );
      return;
    }

    const search = picked.search;
    let inviteLink;
    try {
      const result = await ctx.telegram.createChatInviteLink(ctx.chat.id, { name: search.name });
      inviteLink = result.invite_link;
    } catch {
      await ctx.reply('I need to be a group admin with "Invite Users via Link" permission before I can bind this group. Promote me, then send /bind again.');
      return;
    }

    await bindGroup(search.id, { groupChatId: String(ctx.chat.id), inviteLink });
    await ctx.reply(`Bound to **${search.name}**. Sign-ups happen here from now on.`, { parse_mode: 'Markdown' });
  };
}
