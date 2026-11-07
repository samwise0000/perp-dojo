// Daily bias from the New York session: bullish when the session closed above
// where it opened, bearish when below. Pure functions, no page code.
//
// Session hours are New York wall-clock times, so daylight saving is handled:
// 08:00–17:00 ET is 13:00–22:00 UTC in winter and 12:00–21:00 UTC in summer.
// Weekends have no NY session, so Monday's bias comes from Friday.

export const NY_TZ = 'America/New_York';
export const NY_HOURS = {
  session: { open: '08:00', close: '17:00', short: '8–5 ET', label: '8 AM – 5 PM ET' },
  stocks: { open: '09:30', close: '16:00', short: '9:30–4 ET', label: '9:30 AM – 4 PM ET (stock market)' },
};
const DAY = 86_400_000;

// How far `tz` is ahead of UTC at instant `ms`, in ms.
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The UTC instant of wall-clock y-m-d hh:mm in `tz`.
export function zonedToUtc(y, m, d, hh, mm, tz = NY_TZ) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);              // second pass settles a DST change between guess and answer
}

// The calendar date in `tz` at instant `ms`, as [y, m, d].
export function zonedDate(ms, tz = NY_TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(ms)).map(x => [x.type, Number(x.value)]));
  return [p.year, p.month, p.day];
}

// The last `days` weekday NY sessions up to `now` (newest first), each with
// its open, close and bias read from `candles` ({t,o,h,l,c}, any interval
// `ms` that divides the session evenly). A session that has started but not
// finished is `live`; one that hasn't started yet is left out.
export function nySessions(candles, { hours = NY_HOURS.session, now = Date.now(), days = 5, ms = 15 * 60_000, tz = NY_TZ } = {}) {
  const [oh, om] = hours.open.split(':').map(Number), [ch, cm] = hours.close.split(':').map(Number);
  const [y, m, d] = zonedDate(now, tz);
  const out = [];
  for (let back = 0; out.length < days && back < days * 2 + 7; back++) {
    const date = new Date(Date.UTC(y, m - 1, d - back));
    const wd = date.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const [yy, mm, dd] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const start = zonedToUtc(yy, mm, dd, oh, om, tz), end = zonedToUtc(yy, mm, dd, ch, cm, tz);
    if (now < start) continue;
    const inSession = candles.filter(c => c.t >= start && c.t < end && c.t + ms <= Math.min(end, now));
    const key = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (!inSession.length && now < end) { out.push({ date: key, start, end, live: true, pending: true }); continue; }
    if (!inSession.length || inSession[0].t !== start) { out.push({ date: key, start, end, missing: true }); continue; }
    const open = inSession[0].o, close = inSession.at(-1).c;
    const live = now < end;
    out.push({
      date: key, start, end, live, open, close, upTo: inSession.at(-1).t + ms,
      high: Math.max(...inSession.map(c => c.h)), low: Math.min(...inSession.map(c => c.l)),
      change: (close - open) / open,
      bias: close > open ? 'bullish' : close < open ? 'bearish' : 'flat',
    });
  }
  return out;
}

// Today's bias: the most recent finished NY session.
export const currentBias = sessions => sessions.find(s => !s.live && !s.missing) || null;

// Every finished weekday NY session from `from` to `to`, oldest first, read from
// candles of `ms` (e.g. 1h): { start, end, bias }. For grading signals over months.
export function sessionList(candles, { from, to = Date.now(), hours = NY_HOURS.session, ms = 3_600_000, tz = NY_TZ } = {}) {
  const [oh, om] = hours.open.split(':').map(Number), [ch, cm] = hours.close.split(':').map(Number);
  const at = new Map(candles.map(c => [c.t, c]));
  const out = [];
  for (let d = from - 86_400_000; d <= to + 86_400_000; d += 86_400_000) {
    const [y, m, dd] = zonedDate(d, tz);
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const start = zonedToUtc(y, m, dd, oh, om, tz), end = zonedToUtc(y, m, dd, ch, cm, tz);
    if (out.length && out.at(-1).start === start) continue;
    const o = at.get(start), c = at.get(end - ms);
    if (!o || !c) continue;
    out.push({ start, end, bias: c.c > o.o ? 'bullish' : c.c < o.o ? 'bearish' : 'flat' });
  }
  return out;
}
// The bias in force at `t` (the last session finished by then) and whether a session is running.
export function nyBiasAt(sessions, t, hours = NY_HOURS.session, tz = NY_TZ) {
  let bias = null;
  for (const s of sessions) { if (s.end <= t) bias = s.bias; else break; }
  const [y, m, d] = zonedDate(t, tz);
  const [oh, om] = hours.open.split(':').map(Number), [ch, cm] = hours.close.split(':').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const during = wd !== 0 && wd !== 6 && t >= zonedToUtc(y, m, d, oh, om, tz) && t < zonedToUtc(y, m, d, ch, cm, tz);
  return { bias, during };
}

// ✨ NY pullback ("BTC in golden zone"): how much of the last finished NY session's
// move BTC has given back by `close` (0 = still at the session's close, 1 = all of it).
// Backtest (A-grades, main closes Mon–Thu, past year): at the 12:00 close (UTC+8)
// the ones with BTC ≥50% back made +1.34R a trade, those without −0.33R, and that held
// in every quarter. At 16:00 the split was noise; at 08:00 it ran the other way.
// Tagged at 12:00 and 16:00 for tracking only: it doesn't change the grade or size.
export const NY_PULLBACK = { back: 0.5, hours: [12, 16] };
// From candles of `ms` ({t,o,h,l,c}; the last one may still be forming): { dir: 'Long'|'Short', back } or null.
export function nyPullbackAt(candles, close, { ms = 3_600_000 } = {}) {
  const [oh, om] = NY_HOURS.session.open.split(':').map(Number), [ch, cm] = NY_HOURS.session.close.split(':').map(Number);
  const at = t => candles.find(c => c.t === t);
  for (let back = 0; back < 7; back++) {
    const [y, m, d] = zonedDate(close - back * DAY, NY_TZ);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const start = zonedToUtc(y, m, d, oh, om, NY_TZ), end = zonedToUtc(y, m, d, ch, cm, NY_TZ);
    if (end > close) continue;
    const o = at(start)?.o, c = at(end - ms)?.c, now = at(close - ms)?.c;
    if (o == null || c == null || now == null || o === c) return null;
    return { dir: c > o ? 'Long' : 'Short', back: (c - now) / (c - o) };
  }
  return null;
}
// Is a setup on `side` at a close of local hour `hour` in BTC's golden zone: with the session's move, after a ≥50% pullback?
export const inGoldenZone = (side, pull, hour) => Boolean(pull) && NY_PULLBACK.hours.includes(hour) && pull.dir === side && pull.back >= NY_PULLBACK.back;

// The NY fade: at the 4h close in the last 2 hours of the NY session (04:00 in
// UTC+8), when BTC has moved 2%+ since the session opened and sits in the outer
// 20% of the session's range, setups against that move are flagged. Backtest
// (all grades, past year): +1.05R a trade over 32 days, positive in both halves
// and without the best 3; the same fade at the mid-session close lost ~0.7R.
// A C setup that fades it grades C++ (tracking only: no size).
export const NY_FADE = { move: 0.02, edge: 0.2, hoursLeft: 2 };
// BTC's NY session so far from 15m candles up to `close`: { dir: 'down'|'up', move, pos } or null when not a fade close.
export function nyFadeAt(candles, close) {
  const [y, m, d] = zonedDate(close - 1, NY_TZ);
  const start = zonedToUtc(y, m, d, 8, 0, NY_TZ), end = zonedToUtc(y, m, d, 17, 0, NY_TZ);
  if (close <= start || close > end || end - close > NY_FADE.hoursLeft * 3_600_000) return null;
  const cs = candles.filter(c => c.t >= start && c.t < close);
  if (cs.length < 4) return null;
  const o = cs[0].o, last = cs.at(-1).c, hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l));
  const move = (last - o) / o, pos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  if (Math.abs(move) < NY_FADE.move) return null;
  if (move < 0 ? pos > NY_FADE.edge : pos < 1 - NY_FADE.edge) return null;
  return { dir: move < 0 ? 'down' : 'up', move, pos };
}
// Does a setup on `side` fade that move? (a long after a drop, a short after a rally)
export const fadesNy = (side, fade) => Boolean(fade) && (fade.dir === 'down' ? side === 'Long' : side === 'Short');

// 🗽 At the NY low / high: the swept level sits within ¼ ATR of the coin's previous NY session low (a long) or
// high (a short), the last weekday 8 AM–5 PM ET session finished by the signal's close. Read from the 4h candles
// overlapping the session (the 1h answer agrees 92% of the time). 5 years, 68 pairs, plan trades, capped at 10R:
// longs +0.26R a trade on 255, won 34% (vs −0.08R, 28% elsewhere); shorts +0.48R on 76, won 36% (vs +0.06R, 27%).
// Tracking only.
export const NY_EXTREME = { near: 0.25 };
export function lastNySession(close, hours = NY_HOURS.session, tz = NY_TZ) {
  const [oh, om] = hours.open.split(':').map(Number), [ch, cm] = hours.close.split(':').map(Number);
  const [y, m, d] = zonedDate(close, tz);
  for (let back = 0; back < 10; back++) {
    const date = new Date(Date.UTC(y, m - 1, d - back)), wd = date.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const [yy, mm, dd] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const end = zonedToUtc(yy, mm, dd, ch, cm, tz);
    if (end <= close) return { start: zonedToUtc(yy, mm, dd, oh, om, tz), end };
  }
  return null;
}
// candles: 4h, by time. → { at, high, low, d } (d in ATR, + = past the extreme) or null without the data
export function nyExtremeAt(side, level, atr, candles, close, o = NY_EXTREME) {
  const s = lastNySession(close), H4 = 4 * 3_600_000;
  if (!s || !(atr > 0)) return null;
  const byT = candles instanceof Map ? candles : new Map(candles.map(c => [c.t, c]));
  let high = -Infinity, low = Infinity;
  for (let t = Math.floor(s.start / H4) * H4; t < s.end; t += H4) { const c = byT.get(t); if (!c || t + H4 > close) continue; high = Math.max(high, c.h); low = Math.min(low, c.l); }
  if (!Number.isFinite(high)) return null;
  const d = side === 'Short' ? (level - high) / atr : (low - level) / atr;
  return { at: Math.abs(d) <= o.near, high, low, d, start: s.start, end: s.end };
}
