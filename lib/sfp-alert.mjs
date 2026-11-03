// SFP alerts, run twice per 4h candle by an outside scheduler:
//   'pre'   5 minutes before the close: every pair that would signal if the
//           candle closed where price is now.
//   'close' just after the close: which of those held, which didn't, and any
//           that only formed in the last 5 minutes.
// Stateless: both runs rebuild "5 minutes before the close" from 5m candles, so
// the close run knows what the heads-up said without storing anything.
import { H4, M5, ALERT_SETTINGS, DEFAULT_PAIRS, candleAt, signalsIf, holdLine, trendMap } from '../public/sfp.js';

const DAY = 86_400_000;
export const LEAD = 5 * 60_000;                    // how long before the close the heads-up goes
export const CLOSE_CALL = 0.003;                   // within 0.3% of the line counts as a close call
export const ALERT_OPTS = ALERT_SETTINGS;

// Bybit's public candles, oldest first, including one still forming. One retry:
// a single dropped request shouldn't lose a pair's alert.
const bybitBase = () => (process.env.BYBIT_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.bybit.com';
async function candlesOnce(symbol, interval, start, end) {
  const qs = new URLSearchParams({ category: 'linear', symbol, interval, start, end, limit: 1000 });
  const r = await fetch(`${bybitBase()}/v5/market/kline?${qs}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`Bybit answered ${r.status}`);
  if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
  return (j.result?.list || []).map(c => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]) })).sort((a, b) => a.t - b.t);
}
export const fetchCandles = (...a) => candlesOnce(...a).catch(() => new Promise(r => setTimeout(r, 400)).then(() => candlesOnce(...a)));

export const pairsFrom = text => [...new Set(String(text || DEFAULT_PAIRS).toUpperCase().split(/[\s,$]+/).filter(Boolean)
  .map(x => (/(USDT|USDC|PERP)$/.test(x) ? x : x + 'USDT')))];

// Which phase a scheduled run at `now` should do, or null: the heads-up from
// 6 to 1 minutes before a close, the result in the 5 minutes after one. A run
// outside those (e.g. a Mac waking from sleep) does nothing, so nothing stale is sent.
export function phaseAt(now) {
  const next = Math.ceil(now / H4) * H4, prev = Math.floor(now / H4) * H4;
  if (now - prev < 5 * 60_000) return 'close';
  if (next - now <= 6 * 60_000 && next - now >= 60_000) return 'pre';
  return null;
}

// Which 4h candle a run is about: for 'pre' the one closing next, for 'close'
// the one that just closed. Returns its start, its close and the heads-up time.
export function windowFor(phase, now) {
  const close = phase === 'pre' ? Math.ceil(now / H4) * H4 : Math.floor(now / H4) * H4;
  return { start: close - H4, close, cut: close - LEAD };
}

// One pair. `fetchCandles(symbol, interval, start, end)` returns {t,o,h,l,c}
// oldest first, including a candle still forming.
export async function checkPair(symbol, { phase, now, opts = ALERT_OPTS, fetchCandles }) {
  const w = windowFor(phase, now);
  const from = w.start - (opts.lookbackDays + Math.max(opts.rangeDays || 0, 7) + 5) * DAY;
  const [h4, m5] = await Promise.all([fetchCandles(symbol, '240', from, w.close), fetchCandles(symbol, '5', w.start, w.close)]);
  const history = h4.filter(c => c.t < w.start);
  const before = candleAt(m5, w.start, Math.min(w.cut, now));
  const pre = before ? signalsIf(history, before, opts).map(s => ({ ...s, ...holdLine(s) })) : [];
  // the last 90 candles up to the signal candle, for the chart image
  const recent = c => [...history.slice(-89), c];
  const out = { symbol, pre, preCandles: before ? recent(before) : null };
  if (phase === 'close') {
    const closed = h4.find(c => c.t === w.start && c.t + H4 <= now);
    out.closed = closed || null;
    out.final = closed ? signalsIf(history, closed, opts).map(s => ({ ...s, ...holdLine(s) })) : [];
    out.finalCandles = closed ? recent(closed) : null;
  }
  return out;
}

// BTC's 4h trend at the last closed candle before the window.
export function btcTrend(btc4h, start, opts = ALERT_OPTS) {
  const map = trendMap(btc4h.filter(c => c.t < start), opts.trendEma);
  const last = [...map.values()].at(-1);
  if (!last) return null;
  const off = (last.close - last.ema) / last.ema;
  return { up: last.up, off, neutral: Math.abs(off) < opts.neutralBand };
}

// ---- messages (Telegram HTML) ----

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = v => (v ? Number(v.toPrecision(6)).toString() : '—');
const pc = v => `${(v * 100).toFixed(Math.abs(v) < 0.01 ? 2 : 1)}%`;
const coin = s => s.replace(/USDT$/, '');
const timeIn = (ms, tz) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit' }) + (tz ? '' : ' UTC');
// BTC's 4h trend against the setup's direction, as its own line
const btcLine = (tr, side, last = true) => `${last ? '└' : '├'} BTC trend: ${!tr ? 'unknown' : tr.neutral ? 'Neutral ➖' : (side === 'Long') === tr.up ? 'Aligned 👍' : 'Countertrend ⚠️'}`;
const head = (s, symbol, icon = s.side === 'Short' ? '🔴' : '🟢') => `${icon} <b>${esc(coin(symbol))} ${s.side.toLowerCase()}</b>`;
const levelsOf = s => s.levels.map(l => px(l.price)).join(', ');
const footer = link => (link ? `\n🔗 <a href="${esc(link)}">Scanner</a>` : '');

// the trade: stop at the wick, target at the opposing level, and the R:R
const planLine = s => (s.trade ? `├ 🛑 ${px(s.trade.sl)} · 💰 ${px(s.trade.tp)} · ${s.trade.rr.toFixed(1)}R\n` : '');

// 🟢 VVV long  22.219
// ├ 🎯 22.11 · 0.49% in
// ├ 🛑 21.95 · 💰 23.40 · 4.4R
// └ BTC trend: Countertrend ⚠️
function setupLine(s, symbol, tr) {
  const tight = s.inside < CLOSE_CALL ? '🔥 ' : '';
  return `${head(s, symbol)}  ${px(s.close)}\n├ 🎯 ${levelsOf(s)} · ${tight}${pc(s.inside)} in\n${planLine(s)}${btcLine(tr, s.side)}`;
}

export function preMessage(results, w, { tz, link, trend } = {}) {
  const hits = results.flatMap(r => r.pre.map(s => ({ s, symbol: r.symbol })));
  if (!hits.length) return null;
  hits.sort((a, b) => a.s.inside - b.s.inside);
  return ['<b>Swing Failures Spotted</b> 👀', '', `⏳ 4h close in 5m · ${timeIn(w.close, tz)}`, '', ...hits.map(h => setupLine(h.s, h.symbol, trend)), footer(link)].join('\n').trim();
}

export function closeMessage(results, w, { tz, link, trend } = {}) {
  const lines = [];
  for (const r of results) {
    if (!r.closed && r.pre.length) { lines.push(`⚠️ <b>${esc(coin(r.symbol))}</b> no closed candle yet`); continue; }
    for (const p of r.pre) {
      const f = r.final.find(x => x.side === p.side);
      lines.push(f ? `${head(f, r.symbol, '✅')}  ${px(f.close)}\n${planLine(f)}${btcLine(trend, f.side)}` : `${head(p, r.symbol, '❌')}  ${px(r.closed.c)} · lost 🎯 ${px(p.line)}`);
    }
    for (const f of r.final.filter(x => !r.pre.some(p => p.side === x.side)))
      lines.push(`${head(f, r.symbol, '🆕')}  ${px(f.close)}\n├ 🎯 ${levelsOf(f)} · late setup\n${planLine(f)}${btcLine(trend, f.side)}`);
  }
  if (!lines.length) return null;
  return [`🕓 <b>4h closed</b> · ${timeIn(w.close, tz)}`, '', ...lines, footer(link)].join('\n').trim();
}

// Both phases for every pair, a few at a time. Pairs that fail are listed, not fatal.
export async function runAlerts({ phase, now = Date.now(), pairs, opts = ALERT_OPTS, fetchCandles, tz, link }) {
  const w = windowFor(phase, now);
  const results = [], errors = [];
  const queue = [...pairs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try { results.push(await checkPair(symbol, { phase, now, opts, fetchCandles })); }
      catch (e) { errors.push({ symbol, error: e.message }); }
    }
  }));
  results.sort((a, b) => pairs.indexOf(a.symbol) - pairs.indexOf(b.symbol));
  let trend = null;
  try { trend = btcTrend(await fetchCandles('BTCUSDT', '240', w.start - 20 * DAY, w.close), w.start, opts); } catch {}
  const message = (phase === 'pre' ? preMessage : closeMessage)(results, w, { tz, link, trend });
  // a chart for every heads-up setup, and for setups that only formed at the close
  const charts = phase === 'pre'
    ? results.flatMap(r => r.pre.map(sig => ({ symbol: r.symbol, sig, candles: r.preCandles })))
    : results.flatMap(r => r.final.filter(f => !r.pre.some(p => p.side === f.side)).map(sig => ({ symbol: r.symbol, sig, candles: r.finalCandles })));
  return { phase, window: w, results, errors, trend, message, charts, tz };
}

// ---- sending: the message, then a chart per setup ----

const trendLabel = (tr, side) => (!tr ? '' : tr.neutral ? 'BTC neutral' : (side === 'Long') === tr.up ? 'BTC aligned' : 'BTC countertrend');

// PNGs with captions for the charts of a run (rendering is loaded only when there are any)
export async function chartImages(out) {
  if (!out.charts?.length) return [];
  const { chartPng } = await import('./chart-image.mjs');
  const when = timeIn(out.window.close, out.tz);
  return out.charts.map(({ symbol, sig, candles }) => ({
    png: chartPng({ symbol, candles, sig, trend: trendLabel(out.trend, sig.side), closeLabel: (out.phase === 'pre' ? 'closes ' : 'closed ') + when }),
    caption: `${sig.side === 'Short' ? '🔴' : '🟢'} <b>${esc(coin(symbol))} ${sig.side.toLowerCase()}</b>${sig.trade ? ` · 🛑 ${px(sig.trade.sl)} · 💰 ${px(sig.trade.tp)} · ${sig.trade.rr.toFixed(1)}R` : ''}`,
  }));
}

export async function deliver(out, { sendText, sendPhotos }) {
  if (!out.message) return { sent: false, images: 0 };
  await sendText(out.message);
  let images = 0;
  try { const imgs = await chartImages(out); if (imgs.length) { await sendPhotos(imgs); images = imgs.length; } }
  catch (e) { return { sent: true, images, imageError: e.message }; }       // the text matters more than the picture
  return { sent: true, images };
}
