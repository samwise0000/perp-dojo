// SFP alerts, run twice per 4h candle by an outside scheduler:
//   'pre'   5 minutes before the close: every pair that would signal if the
//           candle closed where price is now.
//   'close' just after the close: which of those held, which didn't, and any
//           that only formed in the last 5 minutes.
// Stateless: both runs rebuild "5 minutes before the close" from 5m candles, so
// the close run knows what the heads-up said without storing anything.
import { proposedRisk, PICKS_PER_CLOSE, RISK_PCT, picksAt } from '../public/day-playbook.js';
import { H4, M5, ALERT_SETTINGS, DEFAULT_PAIRS, candleAt, signalsIf, holdLine, trendMap, gradeSetup, GRADE_ORDER, rsi, btcRsiTag, candleShape, tierOf, emaGuard, SHORT_EMA, atrAt, goldenRR, goldenRaw, fullSweep } from '../public/sfp.js';
import { nySessions, currentBias, nyFadeAt, fadesNy, nyPullbackAt, inGoldenZone } from '../public/bias.js';

const DAY = 86_400_000;
export const LEAD = 5 * 60_000;                    // how long before the close the heads-up goes
export const CLOSE_CALL = 0.003;                   // within 0.3% of the line counts as a close call
export const ALERT_OPTS = ALERT_SETTINGS;

// Bybit's public candles, oldest first, including one still forming. Every close asks
// for ~130 candle sets at once, which can trip Bybit's rate limit (retCode 10006, or an
// HTTP 403/429): those wait for the limit to reset and try again, other failures retry
// after a short pause. 4 tries in all, so one dropped request doesn't lose a pair's alert.
const bybitBase = () => (process.env.BYBIT_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.bybit.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Busy extends Error { constructor(msg, wait) { super(msg); this.wait = wait; } }
async function candlesOnce(symbol, interval, start, end) {
  const qs = new URLSearchParams({ category: 'linear', symbol, interval, start, end, limit: 1000 });
  const r = await fetch(`${bybitBase()}/v5/market/kline?${qs}`);
  const j = await r.json().catch(() => null);
  const reset = Number(r.headers.get('x-bapi-limit-reset-timestamp')), wait = reset > Date.now() ? Math.min(3000, reset - Date.now() + 50) : null;
  if (r.status === 403 || r.status === 429 || j?.retCode === 10006) throw new Busy(`Bybit rate limit (${j?.retCode ?? r.status})`, wait);
  if (!r.ok || !j) throw new Error(`Bybit answered ${r.status}`);
  if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
  return (j.result?.list || []).map(c => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]) })).sort((a, b) => a.t - b.t);
}
export async function fetchCandles(...a) {
  for (let i = 0; ; i++) {
    try { return await candlesOnce(...a); }
    catch (e) {
      if (i >= 3) throw e;
      await sleep((e instanceof Busy ? e.wait ?? 600 * 2 ** i : 400 * (i + 1)) + Math.random() * 250);   // jitter, so the workers don't all come back at once
    }
  }
}

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
  // the 4h RSI as of that candle (for B+)
  const rsiAt = c => rsi([...history, c]).at(-1);
  const pre = before ? signalsIf(history, before, opts).map(s => ({ ...s, ...holdLine(s), rsi: rsiAt(before), shape: candleShape(history.at(-1), before, s.side), atr: atrAt([...history, before], history.length), full: fullSweep(s, t => history.find(c => c.t === t)) })) : [];
  // the last 90 candles up to the signal candle, for the chart image
  const recent = c => [...history.slice(-89), c];
  const out = { symbol, pre, preCandles: before ? recent(before) : null };
  if (phase === 'close') {
    const closed = h4.find(c => c.t === w.start && c.t + H4 <= now);
    out.closed = closed || null;
    out.final = closed ? signalsIf(history, closed, opts).map(s => ({ ...s, ...holdLine(s), rsi: rsiAt(closed), shape: candleShape(history.at(-1), closed, s.side), atr: atrAt([...history, closed], history.length), full: fullSweep(s, t => history.find(c => c.t === t)) })) : [];
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
  const e100 = [...trendMap(btc4h.filter(c => c.t < start), SHORT_EMA).values()].at(-1);
  return { up: last.up, off, neutral: Math.abs(off) < opts.neutralBand, above100: e100 ? e100.up : null };
}

// ---- messages (Telegram HTML) ----

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = v => (v ? Number(v.toPrecision(6)).toString() : '—');
const pc = v => `${(v * 100).toFixed(Math.abs(v) < 0.01 ? 2 : 1)}%`;
const coin = s => s.replace(/USDT$/, '');
const timeIn = (ms, tz) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit' }) + (tz ? '' : ' UTC');
// BTC's 4h trend against the setup's direction, as its own line
const btcLine = (tr, side, last = true) => `${last ? '└' : '├'} BTC trend: ${!tr ? 'unknown' : tr.neutral ? 'Neutral ➖' : (side === 'Long') === tr.up ? 'Aligned 🤝' : 'Countertrend ⚠️'}`;
const head = (s, symbol, icon = s.side === 'Short' ? '🔴' : '🟢') => `${icon} <b>${esc(coin(symbol))} ${s.side.toLowerCase()}</b>`;
const levelsOf = s => s.levels.map(l => px(l.price)).join(', ');
const footer = link => (link ? `\n🔗 <a href="${esc(link)}">Signals</a>` : '');

// The setup's grade (see gradeSetup) with the reason, e.g. "├ 🅰️ A+ · with the NY bias ▼, BTC swept too".
// ctx: { ny, btcSides } — BTC's swept sides for this phase.
const BADGE = { 'S+': '👑', 'A++': '🏆', 'A+': '💎', A: '🥇', 'B+': '🎖️', B: '🥈', 'C++': '🏅', 'C+': '🕯️', C: '🥉' };
export const gradeOf = (s, ctx = {}) => emaGuard(tierOf(gradeSetup(s.side, { ny: ctx.ny, swept: Boolean(ctx.btcSides?.includes(s.side)), rsi: s.rsi, fade: fadesNy(s.side, ctx.fade) }), { shape: s.shape, full: s.full, grr: goldenRaw(s.trade, s.atr), btcRsi: btcRsiTag(s.side, ctx.btcRsi)?.kind ?? null, rr: s.trade?.rr ?? null }), s.side, ctx.ema100);
// the grade at the end of a setup's first line: "  ·  🥇 A"
const gradeTag = (s, ctx) => { const g = gradeOf(s, ctx).grade; return `  ·  ${BADGE[g]} <b>${g}</b>`; };

// the trade: stop at the wick, target at the opposing level, and the R:R
// 🕯️ a signal candle that already closed the trade's way: a limit back toward the wick instead of the close; engulfs marked
const shapeLine = s => {
  const sh = s.shape; if (!sh?.away || !s.trade) return '';
  const eg = sh.engulf === 'wick' ? 'Wick engulf · ' : sh.engulf === 'body' ? 'Body engulf · ' : '';
  return `├ 🕯️ ${eg}Closed away from the level. Set LO 70% back\n`;
};
// R:R from the limit when the candle closed away from the level (see shapeLine), else from the close
const loRR = s => { const t = s.trade, L = s.shape?.away ? s.shape.limit : null; return L != null && Math.abs(t.sl - L) > 0 && (t.tp - L) * (L - t.sl) > 0 ? Math.abs(t.tp - L) / Math.abs(t.sl - L) : null; };
// the R:R to show: from the limit when there is one
const rrText = s => { const lo = loRR(s); return `${(lo ?? s.trade.rr).toFixed(1)}R${lo != null ? ' (LO)' : ''}`; };
const planLine = s => { if (!s.trade) return ''; const lo = loRR(s); return `├ 🛑 ${px(s.trade.sl)} · 💰 ${px(s.trade.tp)} · ${(lo ?? s.trade.rr).toFixed(1)}R${lo != null ? ' (LO)' : ''}\n`; };

// 🟢 VVV long  22.219  ·  🥇 A
// ├ 🎯 22.11 · 0.49% in
// ├ 🛑 21.95 · 💰 23.40 · 4.4R
// └ BTC trend: Countertrend ⚠️
function setupLine(s, symbol, tr, ctx, picks = new Set(), fade = null, at = {}) {
  const tight = s.inside < CLOSE_CALL ? '🔥 ' : '';
  return `${head(s, symbol)}  ${px(s.close)}${gradeTag(s, ctx)}\n├ 🎯 ${levelsOf(s)} · ${tight}${pc(s.inside)} in\n${fadeTag(s, fade, ctx)}${midnightLine(s, ctx, at.close, at.tz)}${fullLine(s)}${goldenRRLine(s, ctx)}${goldenLine(s, ctx, at.close, at.tz)}${btcRsiLine(s, ctx)}${emaLine(s, ctx)}${wrongTimeLine(s, ctx, at.close, at.tz)}${planLine(s)}${shapeLine(s)}${cppLine(s, ctx)}${btcLine(tr, s.side)}`;
}
const rank = (s, ctx) => GRADE_ORDER.indexOf(gradeOf(s, ctx).grade);

// At most PICKS_PER_CLOSE new trades on one close (see day-playbook.js).
// In the backtest, 2 a close kept ~83% of the profit and halved the worst day,
// and which 2 mattered: the best grade first, then the highest R:R made far more than a
// random pick. Only setups the plan would take at this close count (see
// proposedRisk: A to A++ at the main closes, A++, B+ and the Midnight sweep at the late ones, Mon–Thu).
// the close as a local-time Date in `tz`, so proposedRisk reads the right hour and weekday
function inTz(ms, tz = 'UTC') {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return new Date(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute).getTime();
}
const riskOf = (s, ctx, close, tz) => { const g = gradeOf(s, ctx); return proposedRisk(g.grade, inTz(close, tz), { tag: g.tag, from: g.from, skip: g.skip }); };
export const takeable = (s, ctx, close, tz) => Boolean(s.trade) && riskOf(s, ctx, close, tz).pct > 0;
// 🌙 Midnight sweep: an A where BTC swept the same way mid-NY session, taken at the 00:00 close (Mon–Thu)
// a good grade the plan skips at this close (an A at 20:00, a B+ at 20:00, ...): marked so it doesn't look tradeable
const GOOD = new Set(['S+', 'A++', 'A+', 'A', 'B+']);
// Saturday and Sunday (local): no plan trades, but the alerts still show everything and leave the call to you
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekendDay = (close, tz) => { const d = new Date(inTz(close, tz)).getDay(); return [6, 0].includes(d) ? DAYS[d] : null; };
// 💥 Full swing failure: the wick also cleared the swing candle's own wick (any grade)
const fullLine = s => (s.full ? '├ 💥 Full swing failure: swept the swing candle’s wick\n' : '');
// ⭐ Golden R:R: an A grade with a 10–20R target from the close that's within 10 ATR (tracking only)
const goldenRRLine = (s, ctx) => (goldenRR(gradeOf(s, ctx).grade, s.trade, s.atr) ? '├ ⭐ Golden R:R: 10–20R, target in reach\n' : '');
// ⚠️ a short while BTC is above its 4h EMA100: shown, but the plan skips it
const emaLine = (s, ctx) => (gradeOf(s, ctx).skip === 'ema' ? '├ ⚠️ BTC above 4h EMA100: plan skips shorts\n' : '');
const wrongTimeLine = (s, ctx, close, tz) => (!(s.trade && GOOD.has(gradeOf(s, ctx).grade) && !gradeOf(s, ctx).skip && riskOf(s, ctx, close, tz).pct === 0) ? ''
  : weekendDay(close, tz) ? '├ 📅 Weekend: not a plan trade, your call\n' : '├ ⛔ Wrong time: the plan skips this grade at this close\n');
const midnightLine = (s, ctx, close, tz) => {
  if (!s.trade) return '';
  const g = gradeOf(s, ctx), r = riskOf(s, ctx, close, tz);
  if (g.tag === 'midnight' && r.pct > 0) return `├ 🌙 Midnight sweep: BTC swept with it mid-NY session (tracking, ${+r.pct.toFixed(2)}%${r.slot === 'caution' ? ', trade cautiously' : ''})\n`;
  if (g.tag === 'late' && r.pct > 0) return `├ 🌃 Late A++: NY open, 4h RSI stretched (${+r.pct.toFixed(2)}%${r.slot === 'caution' ? ', trade cautiously' : ''})\n`;
  return '';
};
// ✨ BTC gave back half or more of the last NY session's move, the setup's way, at 12:00 / 16:00 (tracking only)
const goldenLine = (s, ctx, close, tz) => (inGoldenZone(s.side, ctx.pull, new Date(inTz(close, tz)).getHours())
  ? '├ ✨ BTC in golden zone / NY pullback\n' : '');
// BTC's 1h RSI from the setup's side: 🧊 cooled off, ⚠️ oversold (a long) / overbought (a short), or ⚠️ extended the trade's way (tracking only)
// only on setups with the NY bias (A to B): the backtest's ground, and a C has no NY move to pull back from
const rsiTagOf = (s, ctx) => (['C', 'C++'].includes(gradeOf(s, ctx).grade) ? null : btcRsiTag(s.side, ctx.btcRsi));
const btcRsiLine = (s, ctx) => { const t = rsiTagOf(s, ctx); return !t ? '' : `├ ${t.kind === 'cool' ? '🧊 BTC RSI cooled off' : t.kind === 'deep' ? `⚠️ BTC ${s.side === 'Short' ? 'overbought' : 'oversold'} (1h RSI ${t.rsi})` : '⚠️ BTC RSI extended'}\n`; };
// the setups to take when more than PICKS_PER_CLOSE qualify (an empty Set otherwise)
export function picksOf(sigs, ctx, close, tz) {
  const ok = sigs.filter(s => takeable(s, ctx, close, tz));
  const max = picksAt(inTz(close, tz));
  if (ok.length <= max) return { picks: new Set(), n: ok.length, max };
  ok.sort((a, b) => rank(a, ctx) - rank(b, ctx) || b.trade.rr - a.trade.rr);
  return { picks: new Set(ok.slice(0, max)), n: ok.length, max };
}
const fades = (s, fade) => fadesNy(s.side, fade);

// The last word of an alert: which setups to take and why, or why none.
// 🧭 Take
// • HYPE short · A+ · 1%: with the NY bias ▼, 4h RSI 68 (stretched)
// Skip
// • SUI, ONDO short · C: no NY bias to go with. C had no edge in the backtest
const rsiNote = (s, ctx) => { const t = rsiTagOf(s, ctx); return !t ? '' : t.kind === 'cool' ? ' · 🧊 BTC RSI cooled off' : t.kind === 'deep' ? ` · ⚠️ BTC ${s.side === 'Short' ? 'overbought' : 'oversold'}` : ' · ⚠️ BTC RSI extended'; };
const SKIP_WHY = { C: 'C had no edge in the backtest', 'C++': 'tracking only, no size', 'C+': 'tracking only, no size', B: 'B lost money in the backtest' };
// why a grade the plan trades is skipped at this close, in a few words
function skipTime(r, close, tz) {
  const t = new Date(inTz(close, tz)), h = t.getHours(), wd = t.getDay();
  if (r.slot === 'caution') return 'not on a trade-cautiously close';
  if (r.slot === 'skip' || wd === 6 || wd === 0) return 'no new trades on weekends, they lost in the backtest';
  if (r.slot === 'weak') return 'not on a weak close';
  if (r.slot === 'caution') return 'not on a trade-cautiously close';
  if (h === 20) return 'the plan skips 20:00, the NY open stops most of them out';
  if ([0, 4].includes(h)) return `at ${String(h).padStart(2, '0')}:00 the plan only takes the 🌃 Late A++, 🌊 NY fade${h === 0 ? ' and 🌙 Midnight sweep' : ''}`;
  return 'outside the 08:00, 12:00 and 16:00 closes';
}
export function recommendation(hits, ctx, close, tz, { pre = false } = {}) {
  if (!hits.length) return null;
  const ok = hits.filter(h => takeable(h.s, ctx, close, tz))
    .sort((a, b) => rank(a.s, ctx) - rank(b.s, ctx) || b.s.trade.rr - a.s.trade.rr);
  const max = picksAt(inTz(close, tz)), take = ok.slice(0, max), extra = ok.slice(max);
  const name = h => `${esc(coin(h.symbol))} ${h.s.side.toLowerCase()}`;
  const out = [take.length ? `🧭 <b>Take${pre ? ' if it closes like this' : ''}</b>` : `🧭 <b>Take: nothing${pre ? ' so far' : ''}</b>`];
  for (const h of take) {
    const g = gradeOf(h.s, ctx), r = riskOf(h.s, ctx, close, tz);
    out.push(`• <b>${name(h)}</b> · ${g.grade} · ${+r.pct.toFixed(2)}% · ${rrText(h.s)}: ${esc(g.why)}${r.slot === 'weak' ? ' (weak close, half size)' : r.slot === 'caution' ? ' (trade cautiously, a quarter size)' : ''}${goldenLine(h.s, ctx, close, tz) ? ' · ✨ BTC in golden zone' : ''}${rsiNote(h.s, ctx)}`);
  }
  if (extra.length) out.push(`• Also qualifies, but ${max} a close is the limit${max < PICKS_PER_CLOSE ? ' today' : ''}: ${extra.map(name).join(', ')}`);
  // Saturday and Sunday: nothing is a plan trade, so name the best of the board (A++ to B) and leave the call to you
  const day = !take.length && weekendDay(close, tz);
  const best = !day ? [] : hits.filter(h => h.s.trade && (GOOD.has(gradeOf(h.s, ctx).grade) || gradeOf(h.s, ctx).grade === 'B'))
    .sort((a, b) => rank(a.s, ctx) - rank(b.s, ctx) || b.s.trade.rr - a.s.trade.rr).slice(0, PICKS_PER_CLOSE);
  if (best.length) {
    out[0] = `🧭 <b>${day}: no plan trades, your call</b>`;
    out.push('Best on the board:');
    for (const h of best) { const g = gradeOf(h.s, ctx); out.push(`• <b>${name(h)}</b> · ${g.grade} · ${rrText(h.s)}: ${esc(g.why)}${rsiNote(h.s, ctx)}`); }
    out.push('Weekend entries lost money in every backtest we ran (all grades, fixed 2R / 3R, out Saturday or Sunday): the weekend chop sweeps wick stops. If you take one, keep it small.');
  }
  // the rest, grouped by why they're skipped
  const groups = new Map();
  for (const h of hits.filter(h => !ok.includes(h) && !best.includes(h))) {
    const g = gradeOf(h.s, ctx), r = riskOf(h.s, ctx, close, tz);
    const why = !h.s.trade ? 'no trade plan (no target level)'
      : `${g.grade}, ${g.why}: ${g.skip === 'ema' ? 'a short while BTC is above its 4h EMA100, those lost every year' : RISK_PCT[g.grade] || g.grade === 'S' || g.grade === 'S+' ? skipTime(r, close, tz) : SKIP_WHY[g.grade] || 'skip'}`;
    if (!groups.has(why)) groups.set(why, []);
    groups.get(why).push(h);
  }
  if (groups.size) {
    if (take.length || best.length) out.push(best.length ? 'The rest' : 'Skip');
    for (const [why, hs] of groups) out.push(`• ${hs.map(name).join(', ')} · ${esc(why)}`);
  }
  if (take.length) out.push(`At most ${max === 1 ? '1 new trade' : max + ' new trades'} a close and 5 open in all: skip any you have no room for.`);
  // Thursday: the last day for new trades before the weekend, when runners have days to go
  // Friday: a weak day by choice, half size
  if (take.length && riskOf(take[0].s, ctx, close, tz).slot === 'caution') out.push('📅 Friday: trade cautiously. The best setup only, at a quarter size: Friday A-grades lost −0.47R a trade in the backtest, mostly stopped before the weekend, but a runner can still carry into it.');
  if (take.length && new Date(inTz(close, tz)).getDay() === 4) out.push('📅 Thursday: the weekend is coming. If it works, consider leaving it open for a few days: trades still running into the weekend averaged +15.7R in the backtest.');
  return out.filter((l, i) => l || i).join('\n');
}
export { nyFadeAt };
const fadeTag = (s, fade, ctx) => (!fades(s, fade) ? '' : ctx && gradeOf(s, ctx).tag === 'fade' ? '├ 🌊 NY fade: a B+ that also fades the NY session (tracked on its own, 0.25%)\n' : '├ 🌊 NY fade\n');
const fadeNote = (fade, list) => (fade && list.some(s => fades(s, fade))
  ? `🌊 BTC ${fade.move > 0 ? '+' : '−'}${Math.abs(fade.move * 100).toFixed(1)}% in today’s NY session and closing near its ${fade.dir === 'down' ? 'low' : 'high'}. ${fade.dir === 'down' ? 'Longs' : 'Shorts'} here fade it. A C that fades it is a 🏅 C++: tracking only, no size, with fixed 2R / 3R targets.`
  : null);
// C++ setups are tracked with fixed 2R and 3R targets (first entry, no adds): steadier than the plan for NY fades
const cppLine = (s, ctx) => {
  if (!s.trade || gradeOf(s, ctx).grade !== 'C++') return '';
  const d = s.side === 'Short' ? -1 : 1, r = Math.abs(s.trade.entry - s.trade.sl);
  return `├ 🎯 C++ targets: 2R ${px(s.trade.entry + d * 2 * r)} · 3R ${px(s.trade.entry + d * 3 * r)}\n`;
};

// When nothing is setting up, a one-liner says so (sent silently, see deliver).
export function quietMessage(results, w, { tz, errors = [] } = {}) {
  const missed = errors.length ? `\n⚠️ couldn't read ${errors.map(e => esc(coin(e.symbol))).join(', ')}` : '';
  return `😴 <b>No setups</b> · 4h close ${timeIn(w.close, tz)}\n${results.length} pairs checked${missed}`;
}

export function preMessage(results, w, { tz, link, trend, btcSweep, ny, fade = null, pull = null, btcRsi = null } = {}) {
  const ctx = { ny, btcSides: btcSweep?.pre, fade, pull, btcRsi, ema100: trend?.above100 };
  const hits = results.flatMap(r => r.pre.map(s => ({ s, symbol: r.symbol })));
  if (!hits.length) return null;
  const pk = picksOf(hits.map(h => h.s), ctx, w.close, tz);
  hits.sort((a, b) => rank(a.s, ctx) - rank(b.s, ctx) || pk.picks.has(b.s) - pk.picks.has(a.s) || a.s.inside - b.s.inside);      // best grade first, the picks first within it
  const fn = fadeNote(fade, hits.map(h => h.s));
  return ['<b>Swing Failures Spotted</b> 👀', '', `⏳ 4h close in 5m · ${timeIn(w.close, tz)}`, ...(fn ? ['', fn] : []), '', hits.map(h => setupLine(h.s, h.symbol, trend, ctx, pk.picks, fade, { close: w.close, tz })).join('\n\n'), '', recommendation(hits, ctx, w.close, tz, { pre: true }), footer(link)].join('\n').trim();      // a blank line between setups
}

export function closeMessage(results, w, { tz, link, trend, btcSweep, ny, fade = null, pull = null, btcRsi = null } = {}) {
  const ctx = { ny, btcSides: btcSweep?.final, fade, pull, btcRsi, ema100: trend?.above100 };
  const finals = results.flatMap(r => (r.closed ? r.final : []));
  const pk = picksOf(finals, ctx, w.close, tz), fn = fadeNote(fade, finals);
  const lines = [];
  for (const r of results) {
    if (!r.closed && r.pre.length) { lines.push(`⚠️ <b>${esc(coin(r.symbol))}</b> no closed candle yet`); continue; }
    for (const p of r.pre) {
      const f = r.final.find(x => x.side === p.side);
      lines.push(f ? `${head(f, r.symbol, '✅')}  ${px(f.close)}${gradeTag(f, ctx)}\n${fadeTag(f, fade, ctx)}${midnightLine(f, ctx, w.close, tz)}${fullLine(f)}${goldenRRLine(f, ctx)}${goldenLine(f, ctx, w.close, tz)}${btcRsiLine(f, ctx)}${emaLine(f, ctx)}${wrongTimeLine(f, ctx, w.close, tz)}${planLine(f)}${shapeLine(f)}${cppLine(f, ctx)}${btcLine(trend, f.side)}` : `${head(p, r.symbol, '❌')}  ${px(r.closed.c)} · lost 🎯 ${px(p.line)}`);
    }
    for (const f of r.final.filter(x => !r.pre.some(p => p.side === x.side)))
      lines.push(`${head(f, r.symbol, '🆕')}  ${px(f.close)}${gradeTag(f, ctx)}\n├ 🎯 ${levelsOf(f)} · late setup\n${fadeTag(f, fade, ctx)}${midnightLine(f, ctx, w.close, tz)}${fullLine(f)}${goldenRRLine(f, ctx)}${goldenLine(f, ctx, w.close, tz)}${btcRsiLine(f, ctx)}${emaLine(f, ctx)}${wrongTimeLine(f, ctx, w.close, tz)}${planLine(f)}${shapeLine(f)}${cppLine(f, ctx)}${btcLine(trend, f.side)}`);
  }
  if (!lines.length) return null;
  const rec = recommendation(results.flatMap(r => (r.closed ? r.final.map(s => ({ s, symbol: r.symbol })) : [])), ctx, w.close, tz);
  return [`🕓 <b>4h closed</b> · ${timeIn(w.close, tz)}`, ...(fn ? ['', fn] : []), '', lines.join('\n\n'), ...(rec ? ['', rec] : []), footer(link)].join('\n').trim();
}

// Both phases for every pair, a few at a time. Pairs that fail are listed, not fatal.
export async function runAlerts({ phase, now = Date.now(), pairs, opts = ALERT_OPTS, fetchCandles, tz, link }) {
  const w = windowFor(phase, now);
  const results = [], errors = [];
  const queue = [...pairs];
  const failed = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try { results.push(await checkPair(symbol, { phase, now, opts, fetchCandles })); }
      catch { failed.push(symbol); }
    }
  }));
  // a second pass, one at a time, once the burst is over
  for (const symbol of failed) {
    try { results.push(await checkPair(symbol, { phase, now, opts, fetchCandles })); }
    catch (e) { errors.push({ symbol, error: e.message }); }
  }
  results.sort((a, b) => pairs.indexOf(a.symbol) - pairs.indexOf(b.symbol));
  let trend = null;
  try { trend = btcTrend(await fetchCandles('BTCUSDT', '240', w.start - 40 * DAY, w.close), w.start, opts); } catch {}       // 40 days: enough for the EMA100
  // BTC's own SFP on this candle, by the same rules: which sides it swept
  let btcSweep = { pre: [], final: [] };
  try {
    const b = await checkPair('BTCUSDT', { phase, now, opts, fetchCandles });
    btcSweep = { pre: b.pre.map(s => s.side), final: (b.final || []).map(s => s.side) };
  } catch {}
  // yesterday's NY session bias as of this candle's close, and whether a session is running then
  let ny = null, fade = null, pull = null;
  try {
    const m15 = await fetchCandles('BTCUSDT', '15', w.close - 8 * DAY, w.close);
    const sessions = nySessions(m15, { now: w.close, days: 5 });
    ny = { bias: currentBias(sessions)?.bias || null, during: Boolean(sessions[0]?.live) };
    fade = nyFadeAt(m15.filter(c => c.t < Math.min(now, w.close)), w.close);   // the heads-up reads BTC up to now
    pull = nyPullbackAt(m15, w.close, { ms: 15 * 60_000 });                     // the heads-up reads the forming candle
  } catch {}
  // BTC's 1h RSI at the close (the heads-up reads the hour still forming)
  let btcRsi = null;
  try { btcRsi = rsi((await fetchCandles('BTCUSDT', '60', w.close - 12 * DAY, w.close)).filter(c => c.t < w.close)).at(-1) ?? null; } catch {}
  let message = (phase === 'pre' ? preMessage : closeMessage)(results, w, { tz, link, trend, btcSweep, ny, fade, pull, btcRsi });
  // the heads-up always reports, so a quiet channel means nothing set up rather than a stalled bot
  const quiet = phase === 'pre' && !message;
  if (quiet) message = quietMessage(results, w, { tz, errors });
  else if (message && errors.length) message += `\n\n⚠️ couldn't check ${errors.map(e => esc(coin(e.symbol))).join(', ')} (Bybit didn't answer)`;
  // a chart for every heads-up setup, and for setups that only formed at the close
  const charts = phase === 'pre'
    ? results.flatMap(r => r.pre.map(sig => ({ symbol: r.symbol, sig, candles: r.preCandles })))
    : results.flatMap(r => r.final.filter(f => !r.pre.some(p => p.side === f.side)).map(sig => ({ symbol: r.symbol, sig, candles: r.finalCandles })));
  return { phase, window: w, results, errors, trend, btcSweep, ny, fade, pull, btcRsi, message, quiet, charts, tz };
}

// ---- sending: the message, then a chart per setup ----

const trendLabel = (tr, side) => (!tr ? '' : tr.neutral ? 'BTC neutral' : (side === 'Long') === tr.up ? 'BTC aligned' : 'BTC countertrend');

// PNGs with captions for the charts of a run (rendering is loaded only when there are any)
export async function chartImages(out) {
  if (!out.charts?.length) return [];
  const { chartPng } = await import('./chart-image.mjs');
  const when = timeIn(out.window.close, out.tz);
  return out.charts.map(({ symbol, sig, candles }) => ({
    png: chartPng({ symbol, candles, sig, trend: trendLabel(out.trend, sig.side), closeLabel: (out.phase === 'pre' ? 'closes ' : 'closed ') + when, grade: gradeOf(sig, { ny: out.ny, fade: out.fade, btcSides: out.btcSweep?.[out.phase === 'pre' ? 'pre' : 'final'] }).grade }),
    caption: `${sig.side === 'Short' ? '🔴' : '🟢'} <b>${esc(coin(symbol))} ${sig.side.toLowerCase()}</b>${sig.trade ? ` · 🛑 ${px(sig.trade.sl)} · 💰 ${px(sig.trade.tp)} · ${rrText(sig)}` : ''} · ${gradeOf(sig, { ny: out.ny, fade: out.fade, btcSides: out.btcSweep?.[out.phase === 'pre' ? 'pre' : 'final'] }).grade}`,
  }));
}

export async function deliver(out, { sendText, sendPhotos }) {
  if (!out.message) return { sent: false, images: 0 };
  await sendText(out.message, { silent: out.quiet });
  let images = 0;
  try { const imgs = await chartImages(out); if (imgs.length) { await sendPhotos(imgs); images = imgs.length; } }
  catch (e) { return { sent: true, images, imageError: e.message }; }       // the text matters more than the picture
  return { sent: true, images };
}
