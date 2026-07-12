import { Telegraf } from 'telegraf';
import { registerHandler } from './commands/register.js';
import { availableHandler } from './commands/available.js';
import { bindHandler } from './commands/bind.js';
import { watchSearches } from './watchers/searchWatcher.js';
import { watchZoneChanges } from './watchers/zoneWatcher.js';
import { watchZoneRequests } from './watchers/zoneRequestWatcher.js';
import { watchSearchCompletion } from './watchers/completionWatcher.js';

for (const key of ['TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'SEARCHER_APP_URL', 'MAPBOX_TOKEN']) {
  if (!process.env[key]) throw new Error(`${key} env var is required`);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Logs every chat id once — used to discover TELEGRAM_GROUP_CHAT_ID during setup.
const seenChats = new Set();
bot.use((ctx, next) => {
  if (ctx.chat && !seenChats.has(ctx.chat.id)) {
    seenChats.add(ctx.chat.id);
    console.log(`chat: ${ctx.chat.id} (${ctx.chat.title ?? ctx.chat.type})`);
  }
  return next();
});

bot.command('register', registerHandler());
bot.command('available', availableHandler());
bot.command('bind', bindHandler());

bot.catch(err => console.error('bot error:', err));

if (!process.env.TELEGRAM_GROUP_CHAT_ID) {
  console.warn('TELEGRAM_GROUP_CHAT_ID not set — watchers disabled. Send a message in the group to discover the id, set it in .env, restart.');
} else {
  watchSearches(bot);
  watchZoneChanges(bot);
  watchZoneRequests();
  watchSearchCompletion(bot);
}

bot.launch(() => console.log('SAR bot polling…'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
