// npm run alerts — one run of the SFP alert job on this computer, the same
// checks and messages as /api/sfp-alert. The Mac's scheduler (npm run alerts:on)
// runs it at minute 55 and minute 0 of every hour; it works out from the time
// whether that's a heads-up, a result, or nothing (most hours are nothing).
//   npm run alerts -- pre|close   force a phase now
//   npm run alerts -- pre --dry   print the message instead of sending it
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAlerts, pairsFrom, phaseAt, fetchCandles, deliver, chartImages } from '../lib/sfp-alert.mjs';
import { sendTelegram, sendPhotos, telegramReady } from '../lib/telegram.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const now = Date.now();
const phase = args.find(a => a === 'pre' || a === 'close') || phaseAt(now);
const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

if (!phase) { console.log(`${stamp} · not near a 4h close, nothing to do`); process.exit(0); }
if (!dry && !telegramReady()) { console.log(`${stamp} · ${phase}: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing from .env`); process.exit(1); }

try {
  const out = await runAlerts({
    phase, now, pairs: pairsFrom(process.env.SFP_PAIRS), fetchCandles,
    tz: (process.env.ALERT_TZ || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    link: (process.env.APP_URL || '').trim() ? process.env.APP_URL.trim().replace(/\/+$/, '') + '/#signals' : '',
  });
  const setups = out.results.reduce((n, r) => n + r.pre.length, 0);
  const errs = out.errors.length ? ` · couldn't read ${out.errors.map(e => `${e.symbol} (${e.error})`).join(', ')}` : '';
  const d = !dry && out.message ? await deliver(out, { sendText: sendTelegram, sendPhotos }) : null;
  const pics = d ? ` with ${d.images} chart${d.images === 1 ? '' : 's'}${d.imageError ? ` (charts failed: ${d.imageError})` : ''}` : '';
  console.log(`${stamp} · ${phase}: ${setups} setup${setups === 1 ? '' : 's'}, ${out.message ? (dry ? 'dry run' : out.quiet ? 'sent the no-setups note' : 'sent' + pics) : 'nothing to send'}${errs}`);
  if (dry && out.message) {
    console.log(out.message);
    // a dry run saves the charts it would send
    const imgs = await chartImages(out), dir = path.join(os.tmpdir(), 'perp-dojo-charts');
    if (imgs.length) { fs.mkdirSync(dir, { recursive: true }); imgs.forEach((im, i) => fs.writeFileSync(path.join(dir, `${i + 1}.png`), im.png)); console.log(`Charts: ${dir}`); }
  }
} catch (e) {
  console.log(`${stamp} · ${phase}: failed: ${e.message}`);
  process.exit(1);
}
