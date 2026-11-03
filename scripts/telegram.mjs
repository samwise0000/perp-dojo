// npm run telegram — connects SFP alerts to your Telegram, using .env only.
//  1. Put TELEGRAM_BOT_TOKEN=... in .env (from @BotFather).
//  2. Send your bot any message in Telegram.
//  3. Run this. It finds your chat, saves TELEGRAM_CHAT_ID (and a new
//     ALERT_SECRET if there isn't one) to .env, and sends a test message.
// npm run telegram -- channel: send alerts to a channel instead. Add the bot to
// the channel as an admin that can post, post anything there, then run it.
// Nothing secret is printed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { sendTelegram, telegramUpdates, botName } from '../lib/telegram.mjs';

const ENV = new URL('../.env', import.meta.url);
const read = () => (fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '');
function setVar(name, value) {
  let text = read();
  const line = `${name}=${value}`;
  text = new RegExp(`^${name}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line) : text.replace(/\n?$/, '\n') + line + '\n';
  fs.writeFileSync(ENV, text, { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
  process.env[name] = value;
}

if (!(process.env.TELEGRAM_BOT_TOKEN || '').trim()) {
  console.log('No TELEGRAM_BOT_TOKEN in .env yet.\n\n1. In Telegram, message @BotFather, send /newbot and follow the steps.\n2. Add the token it gives you to .env as TELEGRAM_BOT_TOKEN=...\n3. Send your new bot any message, then run npm run telegram again.');
  process.exit(1);
}

const wantChannel = process.argv.includes('channel');
if (wantChannel || !(process.env.TELEGRAM_CHAT_ID || '').trim()) {
  let updates;
  try { updates = await telegramUpdates(); } catch (e) { console.log(`Couldn't reach your bot: ${e.message}\nCheck TELEGRAM_BOT_TOKEN in .env.`); process.exit(1); }
  const chats = [...new Map(updates.map(u => (u.message || u.channel_post || u.my_chat_member)?.chat).filter(Boolean).map(c => [c.id, c])).values()];
  if (wantChannel) {
    const channels = chats.filter(c => c.type === 'channel');
    if (!channels.length) {
      console.log('No channel found yet.\n\n1. In Telegram, open your channel → Administrators → Add Admin → @' + (await botName()) + ', with permission to post messages.\n2. Post anything in the channel (e.g. "hi").\n3. Run npm run telegram -- channel again.');
      process.exit(1);
    }
    const ch = channels.at(-1);
    setVar('TELEGRAM_CHAT_ID', String(ch.id));
    console.log(`Found the channel "${ch.title}" and saved it as TELEGRAM_CHAT_ID in .env. Alerts will post there.` + (channels.length > 1 ? ` (The bot is in ${channels.length} channels; picked the most recent.)` : ''));
  } else {
    if (!chats.length) { console.log('Your bot has no messages yet. Open it in Telegram, send it anything (e.g. "hi"), then run this again.'); process.exit(1); }
    const chat = chats.find(c => c.type === 'private') || chats[0];
    setVar('TELEGRAM_CHAT_ID', String(chat.id));
    console.log(`Found your chat${chat.first_name ? ' with ' + chat.first_name : ''} and saved TELEGRAM_CHAT_ID to .env.`);
  }
}

if (!(process.env.ALERT_SECRET || '').trim()) {
  setVar('ALERT_SECRET', crypto.randomBytes(24).toString('base64url'));
  console.log('Made a new ALERT_SECRET and saved it to .env.');
}

try {
  await sendTelegram('✅ <b>Perp Dojo alerts are connected.</b> You’ll get SFP setups 5 minutes before each 4h close, and the result just after.');
  console.log('Sent a test message. Check Telegram.');
} catch (e) { console.log(`Couldn't send: ${e.message}`); process.exit(1); }
