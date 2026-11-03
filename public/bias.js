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
