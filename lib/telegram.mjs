// Send a message to your Telegram chat through your own bot.
// TELEGRAM_BOT_TOKEN comes from @BotFather; TELEGRAM_CHAT_ID is your chat with
// the bot (npm run telegram prints it). TELEGRAM_API_BASE is only for tests.
const LIMIT = 4000;                                 // Telegram's cap is 4096 characters

export const telegramReady = () => Boolean((process.env.TELEGRAM_BOT_TOKEN || '').trim() && (process.env.TELEGRAM_CHAT_ID || '').trim());
const api = (method) => `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${process.env.TELEGRAM_BOT_TOKEN.trim()}/${method}`;

// Long messages are split on line breaks.
export function chunks(text, limit = LIMIT) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > limit) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line.slice(0, limit);
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendTelegram(text) {
  if (!telegramReady()) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set.');
  for (const part of chunks(text)) {
    const send = () => fetch(api('sendMessage'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID.trim(), text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    // one retry on a dropped connection, so a network blip doesn't lose an alert
    const r = await send().catch(() => new Promise(res => setTimeout(res, 1000)).then(send));
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error(`Telegram: ${j?.description || r.status}`);
  }
}

export async function telegramUpdates() {
  const r = await fetch(api('getUpdates'));
  const j = await r.json().catch(() => null);
  if (!j?.ok) throw new Error(`Telegram: ${j?.description || r.status}`);
  return j.result;
}

export async function botName() {
  const j = await fetch(api('getMe')).then(r => r.json()).catch(() => null);
  return j?.ok ? j.result.username : 'your bot';
}

// Charts: one photo, or an album of up to 10 per message.
export async function sendPhotos(list) {
  if (!telegramReady()) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set.');
  const chat = process.env.TELEGRAM_CHAT_ID.trim();
  for (let i = 0; i < list.length; i += 10) {
    const group = list.slice(i, i + 10), fd = new FormData();
    fd.append('chat_id', chat);
    let method;
    if (group.length === 1) {
      method = 'sendPhoto';
      fd.append('photo', new Blob([group[0].png], { type: 'image/png' }), 'chart.png');
      fd.append('caption', group[0].caption); fd.append('parse_mode', 'HTML');
    } else {
      method = 'sendMediaGroup';
      fd.append('media', JSON.stringify(group.map((g, k) => ({ type: 'photo', media: `attach://c${k}`, caption: g.caption, parse_mode: 'HTML' }))));
      group.forEach((g, k) => fd.append(`c${k}`, new Blob([g.png], { type: 'image/png' }), `c${k}.png`));
    }
    const send = () => fetch(api(method), { method: 'POST', body: fd });
    const r = await send().catch(() => new Promise(res => setTimeout(res, 1000)).then(send));
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error(`Telegram: ${j?.description || r.status}`);
  }
}
