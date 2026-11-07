// Today's playbook: what the 1-year backtest says about trading this day, the
// closes you trade today, and the rules that always apply. Days and hours are
// the viewer's local time (the backtest used UTC+8, Asia/Makassar). Numbers are
// A-grade setups (A++, A+, A) traded with the full plan (adds at +1R and +2R, stops to
// entry then break-even), after fees.
//
// The trading day is 8 AM to 4 PM: new trades only at the 08:00, 12:00 and
// 16:00 closes, never between closes. The other closes (20:00, 00:00, 04:00)
// broke even or lost once a few outliers were removed.
import { NY_PULLBACK } from './bias.js';
import { btcRsiTag, FAR_LOCK } from './sfp.js';

const DAYS = [
  // [verdict, avg R, win rate, share of days with an A-grade setup, one line]
  ['weak', -0.32, 19, 85, 'No new trades. Hold runners; Monday 08:00 is the week’s first prime close.'],
  ['mixed', 0.41, 28, 87, 'The busiest day, modest profit: be selective. 08:00 is where Monday pays.'],
  ['strong', 3.47, 44, 56, 'The best day in the backtest: take A-grades with the full plan.'],
  ['strong', 3.91, 32, 57, 'Strong, carried by big winners: hold to the target.'],
  ['strong', 1.68, 38, 67, 'Steady. Trades opened today can run into the weekend; 16:00 is weak.'],
  ['weak', -0.47, 26, 56, 'Trade cautiously: the best A-grade of a close only, a quarter size.'],
  ['weak', -0.56, 15, 65, 'No new trades. Hold runners and review the week.'],
];
// The three closes you trade, rated per weekday (Sun..Sat) from A-grade results at
// that close: prime = clearly the best, ok = positive, weak = lost money (half size),
// skip = new A-grade entries lost in both halves of the year (Sat–Sun: −0.45R a trade on 170).
// caution = a tier below weak, by choice: Friday lost too (−0.47R on 64), but runners into the weekend
// can still start there. A-grades only, a quarter size, and only the best one of a close (CAUTION).
export const SESSION = [8, 12, 16];
export const SLOTS = [
  ['skip', 'skip', 'skip'],    // Sun
  ['prime', 'ok', 'ok'],       // Mon
  ['prime', 'ok', 'ok'],       // Tue
  ['prime', 'ok', 'ok'],       // Wed
  ['prime', 'ok', 'weak'],     // Thu
  ['caution', 'caution', 'caution'],   // Fri: trade cautiously (A-grades lost −0.47R a trade on 64 here)
  ['skip', 'skip', 'skip'],    // Sat
];
const SLOT_TEXT = { prime: 'Prime', ok: 'OK', weak: 'Weak', caution: 'Caution', skip: 'Skip' };
// Trade cautiously: this share of the grade's risk, and at most this many new trades a close
export const CAUTION = { share: 0.25, picks: 1 };
export const MAX_POSITIONS = 5;
// At most this many new trades on one 4h close: when more qualify, the best grade first, then
// the highest R:R. Backtest: 681R vs 817R uncapped per close, worst day −7R vs −14R.
export const PICKS_PER_CLOSE = 2;
// the slot of a main close at `closeAt` (local time), or null outside them
export function slotAt(closeAt) {
  const t = new Date(closeAt), i = SESSION.indexOf(t.getHours());
  if (!t.getMinutes() && [5, 6].includes(t.getDay()) && BPLUS_HOURS.includes(t.getHours())) return 'caution';   // Thursday and Friday nights' 00:00 / 04:00
  return i < 0 || t.getMinutes() ? null : SLOTS[t.getDay()][i];
}
// how many new trades a close takes: one on a trade-cautiously close
export const picksAt = closeAt => (slotAt(closeAt) === 'caution' ? CAUTION.picks : PICKS_PER_CLOSE);

// Risk per trade, % of account equity, by grade. Half on a weak close; nothing
// outside the trading day. Change the numbers here.
// A+ stays at A's 1% until the forward test has ~50 A+ trades: at 1.5% it added ~14 points of drawdown.
// Over 5 years (35 long-lived pairs, current plan) A+ was the best A grade (+0.55R a trade, 4 of 5 years up),
// the A++ at the main closes lost (−0.32R on 47) and A was close to flat (+0.12R): so A+ and A++ 1%, A ½%.
export const RISK_PCT = { 'A++': 1, 'A+': 1, A: 0.5, 'B+': 0.5, B: 0.5, 'C++': 0, 'C+': 0, C: 0 };
// Outside the trading day, Monday to Thursday's late closes take only the 🌃 Late A++
// (NY open, RSI stretched) at 00:00 and 04:00 at half a percent (+1.69R a trade on 135;
// −0.62R at 20:00, so not there), and at a quarter percent the 🌊 NY fade (B+) and the
// 🌙 Midnight sweep below. The main-close A++ is skipped there: +0.23R a trade on 11.
export const OFF_HOURS = [20, 0, 4], OFF_HOURS_PCT = 0.25, BPLUS_HOURS = [0, 4];
// 🌃 Late A++ (NY open, 4h RSI stretched, with the bias; what used to be B+) at 00:00 and 04:00, Mon–Thu
export const LATE_APP_PCT = 0.5;
// 🌙 Midnight sweep: an A where BTC swept the same way while the NY session is open
// (gradeSetup tags it), at the 00:00 close, Mon–Thu. Backtest: +2.64R a trade on 15
// (7 days), positive in both halves; thin, so tracking size. At 04:00 the same lost.
export const MIDNIGHT_HOURS = [0];
// Setups tracked under their own name inside a grade: the 🌃 Late A++ (NY open, RSI stretched),
// the 🌙 Midnight sweep (an A, only
// where it's taken) and the 🌊 NY fade (a B+ that also fades a 2%+ NY session at its last
// close: +2.29R a trade on 32 over the year, but 8 days; tracked to see if it earns more).
export function setupName(grade, closeAt, tag) {
  if (tag === 'late' && grade === 'A++' && proposedRisk(grade, closeAt, { tag }).pct > 0) return '🌃 Late A++';
  if (tag === 'midnight' && grade === 'A' && proposedRisk(grade, closeAt, { tag }).pct > 0) return '🌙 Midnight sweep';
  if (tag === 'fade' && grade === 'B+') return '🌊 NY fade';
  return null;
}
// The proposed risk for a setup whose 4h candle closes at `closeAt` (ms):
// { pct, slot, why } with slot 'prime' | 'ok' | 'weak' | 'caution' | 'skip' | null (outside hours).
// tag: the grade's tag ('midnight' for the Midnight sweep), optional.
// 🔱 God tier (a 💥 full swing failure long with 🔥 Buyers Positioning): at least full plan size, whatever the grade
// or the time. 5 years: plan trades +1.06R a trade on 30 (vs +0.09R for other full SFP longs, ~2% odds of luck),
// all graded +0.39R on 169, C longs +0.35R on 99. Rests on a few runners (+0.13R without the best 3): forward-test.
// Shorts (🔥 Sellers Positioning on an A-grade short): +1.26R a trade on 38 all graded, plan +2.00R on 21. Same floor.
export const GOD_PCT = 1;
export function proposedRisk(grade, closeAt, { tag = null, from = null, skip = null, god = false } = {}) {
  if (god && skip !== 'ema') {
    const r = proposedRisk(grade, closeAt, { tag, from, skip });
    return r.pct >= GOD_PCT ? { ...r, why: '🔱 god tier, ' + r.why } : { ...r, pct: GOD_PCT, why: `🔱 god tier (💥 full SFP + 🔥 buyers positioning): ${GOD_PCT}% whatever the grade or time${r.pct ? ` (the grade alone: ${r.pct}%)` : ''}` };
  }
  if (skip === 'ema') { const t = new Date(closeAt), i = SESSION.indexOf(t.getHours()); return { pct: 0, slot: i < 0 || t.getMinutes() ? null : SLOTS[t.getDay()][i], why: 'a short while BTC is above its 4h EMA100: skip (those shorts lost in every one of 5 years)' }; }
  // S+ tier: a full swing failure with BTC cooled or a golden R:R on an A grade, sized as that A grade, at the same closes
  if (grade === 'S++') { const r = proposedRisk(from || 'A', closeAt, { tag }); return { ...r, why: r.pct ? `S++ tier (${from || 'an A grade'}: S+ with ⭐ golden R:R in the ✨ golden zone): sized as ${from || 'A'}, ${r.why.replace(/^grade \S+ /, '')}` : r.why }; }
  if (grade === 'S+') { const r = proposedRisk(from || 'A', closeAt, { tag }); return { ...r, why: r.pct ? `S+ tier (${from || 'an A grade'}, full swing failure + BTC cooled or golden R:R): sized as ${from || 'A'}, ${r.why.replace(/^grade \S+ /, '')}` : r.why }; }
  const t = new Date(closeAt), i = SESSION.indexOf(t.getHours());
  const slot = i < 0 || t.getMinutes() ? null : SLOTS[t.getDay()][i];
  const base = RISK_PCT[grade] ?? 0;
  if (!base) return { pct: 0, slot, why: grade === 'C++' ? 'grade C++ (a NY fade): tracking only, no size' : grade === 'C+' ? 'grade C+ (an A grade whose candle engulfed): tracking only, no size, a 🪜 ladder 70–90% back' : `grade ${grade}: skip` };
  if (!slot) {
    const h = t.getHours(), late = !t.getMinutes() && OFF_HOURS.includes(h);
    // Thursday and Friday nights' 00:00 and 04:00 (Friday's and Saturday's dates): the late setups, trade-cautiously.
    // Thursday night lost in the backtest (Late A++ −0.49R on 60), so a quarter size keeps it cheap.
    const friNight = late && [5, 6].includes(t.getDay()) && BPLUS_HOURS.includes(h);
    const off = late && ((t.getDay() >= 1 && t.getDay() <= 4) || friNight);
    const r = (() => {
      if (off && grade === 'A++' && tag === 'late' && BPLUS_HOURS.includes(h)) return { pct: LATE_APP_PCT, slot, why: '🌃 Late A++ (NY open, 4h RSI oversold / overbought) at a late close, Mon–Thu: half a percent' };
      if (off && grade === 'A++' && tag === 'late') return { pct: 0, slot, why: '🌃 Late A++ at 20:00 lost money in the backtest: skip (only 00:00 and 04:00)' };
      if (off && grade === 'B+' && BPLUS_HOURS.includes(h)) return { pct: OFF_HOURS_PCT, slot, why: '🌊 NY fade at a late close (Mon–Thu): a quarter percent, for tracking' };
      if (off && grade === 'B+') return { pct: 0, slot, why: 'B+ at 20:00 lost money in the backtest: skip (only 00:00 and 04:00)' };
      if (off && grade === 'A' && tag === 'midnight' && MIDNIGHT_HOURS.includes(h)) return { pct: OFF_HOURS_PCT, slot, why: '🌙 Midnight sweep (BTC swept the same way mid-NY session, Mon–Thu 00:00): a quarter percent, for tracking' };
      return { pct: 0, slot, why: off ? 'outside the main closes, only the 🌃 Late A++ (0.5%) and 🌊 NY fade at 00:00 / 04:00 and the 🌙 Midnight sweep at 00:00 are taken here, at 0.25%: skip' : 'outside your trading hours (08:00, 12:00, 16:00 closes): skip' };
    })();
    if (!friNight) return r;
    return { pct: r.pct * CAUTION.share, slot: 'caution', why: r.pct ? `${r.why.replace(/, Mon–Thu|\(Mon–Thu\) |Mon–Thu /g, '')}. ${t.getDay() === 5 ? 'Thursday' : 'Friday'} night: trade cautiously, a quarter of that, the best one only` : r.why };
  }
  if (slot === 'skip') return { pct: 0, slot, why: 'weekend main close: new entries lost in the backtest, skip (hold runners from the week)' };
  if (slot === 'caution') return grade === 'B' || grade === 'B+' ? { pct: 0, slot, why: `grade ${grade} on a trade-cautiously close: skip` } : { pct: base * CAUTION.share, slot, why: `grade ${grade} on a trade-cautiously close: a quarter size, the best setup only` };
  if (slot === 'weak') return grade === 'B' || grade === 'B+' ? { pct: 0, slot, why: `grade ${grade} on a weak close: skip` } : { pct: base / 2, slot, why: `grade ${grade} on a weak close: half size` };
  return { pct: base, slot, why: `grade ${grade} at a ${slot === 'prime' ? 'prime' : 'good'} close` };
}
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VERDICT = { strong: 'Strong day', mixed: 'Mixed day', weak: 'Weak day' };
const pctText = v => `${+v.toFixed(2)}%`;
const OPEN_KEY = 'perp-dojo:playbook-rules';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const r = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`;
const hh = h => `${String(h).padStart(2, '0')}:00`;

// Where we are in the trading day: the close coming up (or null once 16:00 has passed).
function nextClose(now) {
  const h = now.getHours() + now.getMinutes() / 60;
  const i = SESSION.findIndex(x => h < x + 5 / 60);          // a close counts as "now" for 5 minutes after it
  return i < 0 ? null : { i, at: SESSION[i], now: h >= SESSION[i] };
}

// "in 1h 23m", "now" for 5 minutes after the close, then "done"
export function countdown(at, now = Date.now()) {
  const m = Math.ceil((at - now) / 60_000);
  if (m <= 0) return now - at < 5 * 60_000 ? 'now' : 'done';
  return m >= 60 ? `in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `in ${m}m`;
}
// Update the countdowns in place (cheap; doesn't rebuild the card).
export function tickPlaybook(root, now = Date.now()) {
  for (const e of root.querySelectorAll('[data-at]')) { const t = countdown(Number(e.dataset.at), now); if (e.textContent !== t) e.textContent = t; }
}

// How each weekday usually plays (1-year backtest, A-grades, your time) and the plan for it: [how it plays, the plan]
const DAY_PLAY = [
  ['Setups pile up, but weekend chop sweeps the stops: 19% of A-grades reached the target.', 'No new trades. Hold runners; Sunday night’s 00:00 and 04:00 start the week’s late setups.'],
  ['The busiest day: an A-grade on most Mondays, often several at once, but only modest profit.', 'Be selective: 08:00 is where Monday pays. Best grade first, 2 a close at most.'],
  ['The best day: 44% of A-grades reached the target, and the bias tends to carry.', 'Full plan with confidence at every close. Tuesday night is the best night for the 🌃 Late A++.'],
  ['Strong, but carried by a few very large winners; most trades still stop out.', 'Full plan and hold to the target: the runners pay for everything. 08:00 made most of it.'],
  ['Steady, and the trades still running into the weekend start here: they made most of Thursday’s profit.', 'Full plan at 08:00 and 12:00, half at 16:00. Let working trades run. Tonight’s late setups: caution, a quarter size.'],
  ['Fresh entries mostly get stopped: 35% win at 1:1, against 54% Mon–Thu. The weekend comes before most targets.', 'Trade cautiously: the best A-grade of a close at a quarter size. Hold runners into the weekend.'],
  ['The weakest day: 15% of A-grades reached the target. BTC drifts, alts chop around it.', 'No new trades. Hold runners, review the week and journal.'],
];

// ---- today's read: what New York did, the bias, and what to look for (plain English) ----
const WEEKDAY = NAMES;
const sessDay = x => WEEKDAY[new Date(`${x.date}T12:00:00Z`).getUTCDay()];
const pcS = v => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
// sessions: newest first, as nySessions returns. { story, live, liveEnd, bias, dir, from } or null.
export function nyRead(sessions = []) {
  const done = (sessions || []).filter(x => !x.live && !x.missing && x.bias), last = done[0];
  if (!last) return null;
  const live = sessions[0]?.live && !sessions[0].pending ? sessions[0] : null;
  const pos = last.high > last.low ? (last.close - last.low) / (last.high - last.low) : 0.5;
  const where = pos >= 0.75 ? 'near its high' : pos <= 0.25 ? 'near its low' : 'mid-range';
  const story = Math.abs(last.change) < 0.003
    ? `BTC went nowhere in ${sessDay(last)}’s NY session (${pcS(last.change)}).`
    : `BTC ${last.change > 0 ? 'rose' : 'fell'} ${Math.abs(last.change * 100).toFixed(1)}% in ${sessDay(last)}’s NY session and closed ${where}.`;
  return {
    story, live: live ? `Today’s session is open: ${pcS(live.change)} so far.` : null, liveEnd: live?.end ?? null,
    bias: last.bias, dir: last.bias === 'bullish' ? 'Long' : last.bias === 'bearish' ? 'Short' : null, from: sessDay(last),
  };
}
// What to look for today: [{ text, cls }]. btc: { pull: nyPullbackAt(...), rsi: BTC's 1h RSI } (either may be null).
export function lookingFor(read, { now = new Date(), nyLive = false, open = null } = {}) {
  const d = now.getDay(), next = nextClose(now), dir = read?.dir;
  if (!read) return { lines: [{ text: 'Reading the New York session…', cls: 'muted' }] };
  if (!dir) return { lines: [{ text: 'No clear bias: every setup grades C. Stand aside today.', cls: 'warn' }] };
  const side = dir === 'Long' ? 'longs' : 'shorts', other = dir === 'Long' ? 'shorts' : 'longs', lo = dir === 'Long' ? 'low' : 'high', back = dir === 'Long' ? 'above' : 'below';
  const left = (next ? SESSION.slice(next.i) : []).filter(h => SLOTS[d][SESSION.indexOf(h)] !== 'skip');
  const out = [];
  if (SLOTS[d].every(q => q === 'skip')) out.push({ text: 'No new trades today. Hold runners; don’t close them for the weekend.', cls: '' });
  else if (!left.length) out.push({ text: 'No more closes today: manage what’s open.', cls: '' });
  else {
    out.push({ text: `${side[0].toUpperCase() + side.slice(1)} at ${left.map(hh).join(' · ')}: a sweep of a ${lo} that closes back ${back} it.`, cls: '' });
    out.push({ text: `Best: BTC sweeping the same way (A++) or the alt’s 4h RSI ${dir === 'Long' ? 'under 40' : 'over 60'} (A+).`, cls: '' });
    if (left.some(h => NY_PULLBACK.hours.includes(h))) out.push({ text: 'Extra edge: BTC back half of NY’s move ✨ with its 1h RSI at 35–45 🧊.', cls: '' });
    if (left.some(h => SLOTS[d][SESSION.indexOf(h)] === 'caution')) out.push({ text: 'Only the best one per close, at a quarter size.', cls: 'warn' });
    out.push({ text: `Skip ${other}: against the bias they grade C.`, cls: 'muted' });
    // room under the caps, for the next close
    if (Number.isFinite(open)) {
      const max = picksAt(new Date(now).setHours(left[0], 0, 0, 0)), room = Math.max(0, Math.min(max, MAX_POSITIONS - open));
      out.push({ text: room ? `Room for ${room} new at ${hh(left[0])} (${open} of ${MAX_POSITIONS} open).` : `${open} of ${MAX_POSITIONS} open: no room for new trades until one closes.`, cls: room ? 'muted' : 'warn' });
    }
  }
  if (nyLive) out.push({ text: 'NY is open: until it closes, only the 🌃 Late A++ or an A with a BTC sweep.', cls: 'warn' });
  return { lines: out };
}
// BTC right now, read from the bias's side: how far it's pulled back from NY's close (✨ golden zone at
// 50%+) and its 1h RSI (🧊 cooled off / ⚠️ stretched or extended). [{ text, cls }]
export function btcChips(read, btc) {
  const dir = read?.dir, chips = [];
  if (!dir || !btc) return chips;
  const side = dir === 'Long' ? 'longs' : 'shorts';
  if (btc.pull && btc.pull.dir === dir) {
    const b = btc.pull.back, pct = b > 1 ? 'all' : `${Math.max(0, Math.round(b * 100))}%`;
    chips.push(b >= NY_PULLBACK.back ? { text: `✨ Golden zone: BTC gave back ${pct} of NY’s move`, cls: 'gold' }
      : b < 0 ? { text: `BTC ${dir === 'Long' ? 'above' : 'below'} NY’s close: no pullback yet`, cls: 'muted' } : { text: `BTC gave back ${pct} of NY’s move`, cls: 'muted' });
  }
  const t = btcRsiTag(dir, btc.rsi);
  if (t) chips.push({ text: t.kind === 'cool' ? `🧊 1h RSI ${t.rsi}: cooled off` : t.kind === 'deep' ? `⚠️ 1h RSI ${t.rsi}: ${dir === 'Long' ? 'oversold' : 'overbought'}, against ${side}` : `⚠️ 1h RSI ${t.rsi}: ${dir === 'Long' ? 'overbought' : 'oversold'}, wait for a cool-off`, cls: t.kind === 'cool' ? 'cool' : 'warn' });
  else if (Number.isFinite(btc.rsi)) chips.push({ text: `1h RSI ${Math.round(btc.rsi)}: neutral`, cls: 'muted' });
  return chips;
}

// Everything the playbook shows, as plain data, for the alternative layouts (playbook-options.js)
export function playbookData({ now = new Date(), nyLive = false, sessions = null, btc = null, open = null } = {}) {
  const d = now.getDay(), [verdict, avg, win, share] = DAYS[d], next = nextClose(now), read = nyRead(sessions);
  const lateDay = h => (h === 20 ? d : (d + 1) % 7);
  const tonight = BPLUS_HOURS.filter(h => { const x = lateDay(h); return x >= 1 && x <= 6; });
  // the tier of each close today (the 00:00 / 04:00 at the start of the day close last night's late setups)
  const lateTier = day => (day >= 1 && day <= 4 ? 'late' : day === 5 || day === 6 ? 'caution' : 'none');
  const closes = [0, 4, 8, 12, 16, 20].map(h => {
    const i = SESSION.indexOf(h), at = new Date(now).setHours(h, 0, 0, 0);
    return { h, at, tier: i >= 0 ? SLOTS[d][i] : h === 20 ? 'none' : lateTier(d), label: i >= 0 ? SLOT_TEXT[SLOTS[d][i]] : h === 20 ? '—' : { late: 'Late', caution: 'Caution', none: '—' }[lateTier(d)] };
  });
  return {
    d, day: NAMES[d], verdict, verdictText: VERDICT[verdict], avg, win, share, next, nyLive, open, btc, read,
    slots: SESSION.map((h, i) => ({ h, q: SLOTS[d][i], text: SLOT_TEXT[SLOTS[d][i]], at: new Date(now).setHours(h, 0, 0, 0) })),
    closes, tonight, tonightCaution: tonight.length > 0 && [5, 6].includes(lateDay(0)),
    look: lookingFor(read, { now, nyLive, open }).lines, chips: btcChips(read, btc), play: DAY_PLAY[d],
    history: (sessions || []).filter(x => !x.live && !x.missing && x.bias).slice(0, 5).reverse(),
    live: sessions?.[0]?.live && !sessions[0].pending ? sessions[0] : null,
    room: Number.isFinite(open) && next ? Math.max(0, Math.min(picksAt(new Date(now).setHours(SESSION[next.i], 0, 0, 0)), MAX_POSITIONS - open)) : null,
    rsiTag: read?.dir ? btcRsiTag(read.dir, btc?.rsi) : null,
  };
}
export { countdown as pbCountdown, hh as pbHour, r as pbR, sessDay as pbSessDay, pcS as pbPct };

// The setups to use today and their size, from the plan (proposedRisk): the main closes left in the day,
// then tonight's late closes. [{ name, what, size, tonight, caution }]
export function strategiesToday(now = new Date()) {
  const d = now.getDay(), at = (h, plus = 0) => { const t = new Date(now); t.setDate(t.getDate() + plus); t.setHours(h, 0, 0, 0); return t.getTime(); };
  const out = [], mains = SESSION.filter((h, i) => SLOTS[d][i] !== 'skip');
  // S+: an A grade that's a full swing failure with BTC cooled or a golden R:R, sized as its A grade, wherever the A grades are taken
  const sBy = mains.map(h => [h, proposedRisk('A', at(h))]).filter(([, r]) => r.pct > 0);
  if (sBy.length) out.push({ name: '💎 S++', what: 'S+ with ⭐ golden R:R in the ✨ golden zone', pct: 'as its A', note: '', size: 'as its A grade', caution: sBy.every(([, r]) => r.slot === 'caution') });
  if (sBy.length) out.push({ name: 'S+', what: 'full swing failure + 🧊 BTC cooled or ⭐ golden R:R', pct: 'as its A', note: '', size: 'as its A grade', caution: sBy.every(([, r]) => r.slot === 'caution') });
  for (const [g, name, what] of [['A++', '★ A++', 'BTC swept the same way'], ['A+', 'A+', 'alt’s 4h RSI oversold / overbought'], ['A', 'A', 'with the bias']]) {
    const by = mains.map(h => [h, proposedRisk(g, at(h))]).filter(([, r]) => r.pct > 0);
    if (!by.length) continue;
    const top = Math.max(...by.map(([, r]) => r.pct)), others = by.filter(([, r]) => r.pct !== top);
    const note = others.length ? others.map(([h, r]) => `${pctText(r.pct)} at ${hh(h)}`).join(', ') : '';
    out.push({ name, what, pct: pctText(top), note, size: pctText(top) + (note ? ` · ${note}` : ''), caution: by.every(([, r]) => r.slot === 'caution') });
  }
  for (const [g, tag, hours, name, what] of [['A++', 'late', [0, 4], '🌃 Late A++', 'NY open, RSI oversold / overbought'], ['A', 'midnight', [0], '🌙 Midnight sweep', 'BTC swept mid-NY'], ['B+', 'fade', [4], '🌊 NY fade', 'fades a 2%+ NY session']]) {
    const by = hours.map(h => [h, proposedRisk(g, at(h, 1), { tag })]).filter(([, r]) => r.pct > 0);
    const same = by.every(([, r]) => r.pct === by[0][1].pct);
    if (by.length) out.push({ name, what, pct: pctText(by[0][1].pct), note: same ? by.map(([h]) => hh(h)).join(' · ') : by.map(([h, r]) => `${pctText(r.pct)} at ${hh(h)}`).join(' · '), size: same ? `${pctText(by[0][1].pct)} at ${by.map(([h]) => hh(h)).join(' / ')}` : by.map(([h, r]) => `${pctText(r.pct)} at ${hh(h)}`).join(' · '), tonight: true, caution: by.every(([, r]) => r.slot === 'caution') });
  }
  return out;
}

// The rules, short, as a collapsible block (open state remembered in this browser)
export function guidelines({ equity = null, hidden = false, money = v => `$${Math.round(v)}` } = {}) {
  const rules = el('details', 'pb-rules'), sum = el('summary');
  try { rules.open = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  const label = () => { sum.textContent = rules.open ? 'Hide guidelines' : 'Guidelines'; };
  rules.addEventListener('toggle', () => { label(); try { localStorage.setItem(OPEN_KEY, rules.open ? '1' : '0'); } catch {} });
  label();
  const usd = g => (equity && !hidden ? ` (${money(equity * RISK_PCT[g] / 100)})` : '');
  const guide = [
    ['🎯', 'Entry', 'At the 4h close · 🪜 ladder 70–90% back if it closed away, or on A+ / A++ / B / C when BTC’s RSI already ran · stop at the wick · target the opposing level'],
    ['➕', 'Scale in', '+1R: add 1×, stops → entry · +2R: add ½×, stops → break-even'],
    ['🏁', 'Exit', 'At the target don’t close: trail the stop to each closed 4h candle’s low (a short: its high)'],
    ['📏', 'Risk', `A+ / A++ ${pctText(RISK_PCT['A+'])}${usd('A+')} · A ${pctText(RISK_PCT.A)}${usd('A')} · half on Weak, ¼ on Caution`],
    ['🔢', 'Limits', `${PICKS_PER_CLOSE} new a close (1 on Caution) · ${MAX_POSITIONS} open · best grade, then R:R`],
    ['🌙', 'Late', `00:00 / 04:00, Sun–Wed nights: 🌃 Late A++ ${pctText(LATE_APP_PCT)} · 🌙 / 🌊 ${pctText(OFF_HOURS_PCT)} · Thu–Fri nights ¼`],
    ['🚫', 'Never', 'Average down · take profit early · widen a stop · trade C'],
  ];
  const g = el('div', 'pb-guide');
  for (const [i, k, v] of guide) { const row = el('div', 'pb-g'); row.append(el('span', 'pb-g-i', i), el('b', '', k), el('span', '', v)); g.append(row); }
  rules.append(sum, g);
  return rules;
}

// BTC vs the alt in a new trade's first 3 candles: a long where BTC's 4h candle breaks the
// one before's high but the alt's doesn't (a short: the low) is the alt lagging while the
// full 1R is still on. Backtest (A-grades Mon–Thu, past year): the 62 trades it caught before
// +1R made −0.42R a trade held; closing at that candle's close made −0.02R. Closing on it
// after +1R, or taking half off, cost money. alt4h / btc4h: 4h candles, oldest first.
export const SMT_WINDOW = 3;
const H4_MS = 4 * 3_600_000;
export function smtCheck(p, alt4h, btc4h, now = Date.now()) {
  if (!p.openedAt || !alt4h?.length || !btc4h?.length) return null;
  const long = p.dir === 'Long', ext = c => (long ? c.h : -c.l);
  const first = Math.round(p.openedAt / H4_MS) * H4_MS;                  // the candle that opened at the entry close (entries land a few minutes either side of it)
  const alt = new Map(alt4h.map(c => [c.t, c])), btc = new Map(btc4h.map(c => [c.t, c]));
  for (let i = 0; i < SMT_WINDOW; i++) {
    const t = first + i * H4_MS;
    if (t + H4_MS > now) return { state: 'watch', until: first + SMT_WINDOW * H4_MS };   // still inside the window
    const a = alt.get(t), a0 = alt.get(t - H4_MS), b = btc.get(t), b0 = btc.get(t - H4_MS);
    if (!a || !a0 || !b || !b0) return null;
    if (ext(b) > ext(b0) && !(ext(a) > ext(a0))) return { state: 'diverged', t };
  }
  return null;                                                           // the window passed without it
}

const coinOf = s => String(s || '').replace(/USDT$/, '');
// Notes for a live position, from what the backtest found:
//   - the NY bias now vs the position (with it: hold; flipped your way since
//     entry: keep holding; against it: weaker odds)
//   - where it stands in the plan (next step at +1R / +2R, or protected)
//   - Friday to Sunday: hold runners through the weekend
// p: { dir, entry, mark, sl, slLoss, openedAt }; sessions: newest first, as nySessions returns.
// smt: smtCheck's answer for this position, when the app has read its 4h candles.
export function positionNotes(p, { sessions = [], now = new Date(), price = v => String(v), equity = null, smt = null, plan = null } = {}) {
  const notes = [], long = p.dir === 'Long', side = long ? 'bullish' : 'bearish', d = long ? 1 : -1;
  const done = (sessions || []).filter(x => !x.live && !x.missing && x.bias);
  const nowBias = done[0]?.bias || null;
  const atEntry = p.openedAt ? done.find(x => x.end <= p.openedAt)?.bias || null : null;
  const mark = b => (b === 'bullish' ? '▲' : b === 'bearish' ? '▼' : '');
  if (nowBias && nowBias !== 'flat') {
    if (nowBias === side && atEntry && atEntry !== side) notes.push({ cls: 'pos', text: `NY flipped your way ${mark(nowBias)}: keep holding` });
    else if (nowBias === side) notes.push({ cls: 'pos', text: `With the NY bias ${mark(nowBias)}: hold to the plan` });
    else notes.push({ cls: 'warn', text: `Against the NY bias ${mark(nowBias)}: consider tightening or closing` });
  }
  if (sessions?.[0]?.live && !sessions[0].pending) notes.push({ cls: 'muted', text: 'NY session open: the bias can change at its close' });
  // 🎯→ past the target the plan trails the stop behind each closed 4h candle (see trailFrom in sfp.js)
  const pastTp = plan?.tp && p.mark ? d * (p.mark - plan.tp) >= 0 || plan.trailing : false;
  if (pastTp) {
    const ts = plan.trailStop, set = ts != null && p.sl && d * (p.sl - ts) >= 0;
    notes.push(ts == null
      ? { cls: 'pos', text: `At the target: don’t close, trail the stop to each closed 4h candle’s ${long ? 'low' : 'high'}` }
      : set ? { cls: 'pos', text: `Trailing past the target: stop ${price(p.sl)}, move it to each 4h close’s ${long ? 'low' : 'high'}` }
      : { cls: 'warn', text: `Trailing past the target: move the stop to ${price(ts)}, the last 4h candle’s ${long ? 'low' : 'high'}` });
    // the softer option: bank half, trail the rest (about 0.2R a trade less in the backtest, half the give-back)
    if (ts == null || !set) notes.push({ cls: 'muted', text: 'Optional: take half off here and trail the rest, a little less on average but half the give-back' });
    // the other way: press a breakout. Half the first entry's size at each 4h close past the target, stop at the trail
    // (1 year: +2.47R a plan trade vs +2.18R, but +1.57R vs +1.55R without the best 3: it pays on the rare parabolic run)
    notes.push({ cls: 'muted', text: `Optional, a parabolic run: at each 4h close ${long ? 'above' : 'below'} ${price(plan.tp)}, add half your first entry’s size, stop at the trail. It pays on the rare big run, about even otherwise` });
  }
  if (p.sl && p.entry && p.mark && !pastTp) {
    const risk = d * (p.entry - p.sl);
    if (risk <= 0) notes.push({ cls: 'pos', text: 'Stop at or past entry: protected, hold to the target, then trail' });
    else {
      const r = d * (p.mark - p.entry) / risk, at = n => price(p.entry + d * n * risk);
      const rs = `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`;
      if (r >= 2) notes.push({ cls: 'pos', text: `${rs}: add half size, all stops to break-even` });
      else if (r >= 1) notes.push({ cls: 'pos', text: `${rs}: add the same size, stops to entry. Next add ${at(2)}` });
      else notes.push({ cls: '', text: `${rs}: stop at the wick, first add at ${at(1)} (+1R)` });
      // still at full risk in the first 3 candles: does the alt keep up with BTC? (smtCheck)
      if (r < 1 && smt?.state === 'diverged') notes.push({ cls: 'warn', text: `BTC broke its 4h ${long ? 'high' : 'low'}, ${coinOf(p.symbol)} didn’t: closing is reasonable` });
      else if (r < 1 && smt?.state === 'watch') notes.push({ cls: 'muted', text: 'If SMT is present against BTC, closing early is reasonable' });
    }
  }
  // hold time: most stops come within 8h; trades that last longer are the ones that reach the target
  const held = p.openedAt ? (now.getTime() - p.openedAt) / 3_600_000 : null;
  const up = p.sl && d * (p.entry - p.sl) > 0 ? d * (p.mark - p.entry) / (d * (p.entry - p.sl)) >= 0.25 : d * (p.mark - p.entry) > 0;   // clearly in profit
  if (held !== null && held >= 8 && p.mark && up) notes.push({ cls: 'pos', text: `Held ${held >= 48 ? Math.round(held / 24) + 'd' : Math.round(held) + 'h'}, in profit: past the stop-out window, let it run` });
  // size against the plan's largest first entry (RISK_PCT)
  if (equity && p.slLoss < 0 && d * (p.entry - p.sl) > 0) {
    const pct = -p.slLoss / equity * 100;
    const max = Math.max(...Object.values(RISK_PCT));
    if (pct > max * 1.25) notes.push({ cls: 'warn', text: `Risking ${pct.toFixed(1)}% to the stop: the plan’s max is ${max}%` });
  }
  // Thursday, working (in profit, or the stop at/past entry): the last weekday before the weekend, when
  // runners have days to go. Trades still open into the weekend averaged +15.7R in the backtest.
  if (now.getDay() === 4 && p.mark && p.entry && (d * (p.mark - p.entry) > 0 || (p.sl && d * (p.entry - p.sl) <= 0)))
    notes.push({ cls: 'pos', text: 'Thursday: weekend ahead, consider holding it a few days' });
  // into the weekend in profit (+1R or better, or stop already at/past entry): runners held over it
  // tended to keep going, and an add that risked 1R to the existing stop made money in the backtest
  if ([5, 6, 0].includes(now.getDay())) {
    const risk = p.sl && p.entry ? d * (p.entry - p.sl) : null, r = risk > 0 && p.mark ? d * (p.mark - p.entry) / risk : null;
    const ahead = p.mark && d * (p.mark - p.entry) > 0 && (r === null ? risk !== null : r >= 1);
    notes.push(ahead
      ? { cls: 'pos', text: 'Weekend, in profit: add on a dip, 1R to your current stop' }
      : { cls: 'muted', text: 'Weekend: hold your runner, don’t close it for the weekend' });
  }
  // 🛡️ a far target (15R+ from the entry, by the original plan): at +7R, lock +3R
  if (plan && p.mark) {
    const r0 = Math.abs(plan.entry - plan.sl), rr = r0 ? Math.abs(plan.tp - plan.entry) / r0 : 0, now0 = r0 ? d * (p.mark - plan.entry) / r0 : 0, lock = plan.entry + d * FAR_LOCK.to * r0;
    if (rr >= FAR_LOCK.rr && now0 >= FAR_LOCK.at) notes.push(p.sl && d * (p.sl - lock) >= 0
      ? { cls: 'pos', text: `Far target (${Math.round(rr)}R): +3R locked, let it run` }
      : { cls: 'warn', text: `Far target (${Math.round(rr)}R), past +7R: lock +3R, stop to ${price(lock)}` });
  }
  return notes;
}
