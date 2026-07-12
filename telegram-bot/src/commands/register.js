export function parseRegisterName(text) {
  return text
    .replace(/^\/register(@\w+)?/i, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function registerHandler() {
  return async ctx => {
    // Dynamic import keeps this module importable without Firebase env vars (tests).
    const { getVolunteer, saveVolunteer } = await import('../firebase/volunteers.js');

    const telegramId = String(ctx.from.id);
    const existing = await getVolunteer(telegramId);
    if (existing) {
      await ctx.reply(`You're already registered as ${existing.name}. You're all set — reply /available when a search goes out.`);
      return;
    }

    const name = parseRegisterName(ctx.message.text);
    if (!name) {
      await ctx.reply('Please include your name: /register First Last');
      return;
    }

    await saveVolunteer({ id: telegramId, name, telegramId });
    await ctx.reply(`Registered as ${name}. When a search goes out, reply /available with the zone letters you can search (e.g. /available A B).`);
  };
}
