// GET /api/sfp-alert?phase=pre|close|test — the SFP alert job. An outside
// scheduler (cron-job.org) calls it 5 minutes before and just after every 4h
// close. Needs ALERT_SECRET, as "Authorization: Bearer <secret>" or ?key=<secret>.
// &dry=1 returns the message without sending it; &at=<ms> runs as of that time.
// Uses Bybit's public candles only: no API key involved.
import crypto from 'node:crypto';
import { json, query } from '../lib/http.mjs';
import { runAlerts, pairsFrom, windowFor, fetchCandles, deliver } from '../lib/sfp-alert.mjs';
import { sendTelegram, sendPhotos, telegramReady } from '../lib/telegram.mjs';

const digest = s => crypto.createHash('sha256').update(String(s)).digest();

export default async function handler(req, res) {
  const secret = (process.env.ALERT_SECRET || '').trim();
  if (!secret) return json(res, 503, { error: 'ALERT_SECRET is not set on the server.' });
  const q = query(req);
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(q.key || '');
  if (!crypto.timingSafeEqual(digest(got), digest(secret))) return json(res, 401, { error: 'Wrong alert secret.' });

  const phase = q.phase, dry = q.dry === '1';
  if (!['pre', 'close', 'test'].includes(phase)) return json(res, 400, { error: 'phase must be pre, close or test.' });
  if (!dry && !telegramReady()) return json(res, 503, { error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set.' });
  const link = (process.env.APP_URL || '').trim() ? process.env.APP_URL.trim().replace(/\/+$/, '') + '/#scanner' : '';

  try {
    if (phase === 'test') {
      const message = '✅ <b>Perp Dojo alerts are connected.</b> You’ll get SFP setups 5 minutes before each 4h close, and the result just after.';
      if (!dry) await sendTelegram(message);
      return json(res, 200, { phase, sent: !dry, message });
    }
    const now = Number(q.at) || Date.now();
    const out = await runAlerts({
      phase, now, pairs: pairsFrom(process.env.SFP_PAIRS), fetchCandles,
      tz: (process.env.ALERT_TZ || '').trim() || undefined, link,
    });
    const d = out.message && !dry ? await deliver(out, { sendText: sendTelegram, sendPhotos }) : null;
    json(res, 200, {
      phase, window: windowFor(phase, now), sent: Boolean(d?.sent), charts: d?.images ?? 0, chartError: d?.imageError, message: out.message, errors: out.errors, trend: out.trend,
      setups: out.results.flatMap(r => r.pre.map(s => ({ symbol: r.symbol, side: s.side, line: s.line, inside: s.inside, close: s.close }))),
      confirmed: phase === 'close' ? out.results.flatMap(r => r.final.map(s => ({ symbol: r.symbol, side: s.side, close: s.close }))) : undefined,
    });
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}
