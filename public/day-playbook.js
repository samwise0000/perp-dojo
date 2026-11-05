// Today's playbook: what the 1-year backtest says about trading this day, the
// closes you trade today, and the rules that always apply. Days and hours are
// the viewer's local time (the backtest used UTC+8, Asia/Makassar). Numbers are
// A-grade setups (A++, A+, A) traded with the full plan (adds at +1R and +2R, stops to
// entry then break-even), after fees.
//
// The trading day is 8 AM to 4 PM: new trades only at the 08:00, 12:00 and
// 16:00 closes, never between closes. The other closes (20:00, 00:00, 04:00)
// broke even or lost once a few outliers were removed.
const DAYS = [
  // [verdict, avg R, win rate, share of days with an A-grade setup, advice]
  ['weak', -0.32, 19, 85, ['Setups lost money on Sundays: no new trades.', 'One of the busiest days for setups, so it’s easy to get pulled in. Wait for the week.', 'Hold anything already running from the week.', 'Monday’s 08:00 close is the first prime slot of the week.']],
  ['mixed', 0.41, 28, 87, ['The busiest day: there’s an A-grade setup on most Mondays, often several at once.', 'Only modestly profitable, so be selective and stay under your position cap.', 'The 08:00 close is where Monday’s profit came from.', 'Skip the 20:00, 00:00 and 04:00 closes even when a setup looks good.']],
  ['strong', 3.47, 44, 56, ['The best day in the backtest: 44% of A-grade trades hit the target.', 'Take A-grade setups with confidence, full plan.', 'Hold to the opposing level. The big winners pay for everything.', 'The 12:00 close was strong on Tuesdays too.']],
  ['strong', 3.91, 32, 57, ['A strong day, carried by some very large winners.', 'Take A-grade setups with the full plan.', 'Hold to the target; don’t cut winners early.', 'The 08:00 close made most of Wednesday’s profit.']],
  ['strong', 1.68, 38, 67, ['Solid and steady, positive in both halves of the year.', 'Trades opened now often run into the weekend, and those were the biggest winners.', 'Hold them through the weekend if they’re working.', 'Skip the 16:00 close: it lost money on Thursdays.']],
  ['weak', -0.47, 26, 56, ['New setups opened on Fridays lost money: no new trades.', 'Hold your runners. Trades already open going into the weekend were the biggest winners.', 'Don’t close winners just because the weekend is coming.', 'Use the day to review the week instead.']],
  ['weak', -0.56, 15, 65, ['The weakest day: only 15% of A-grade trades hit the target.', 'No new trades.', 'Hold anything already running and leave the stops where the plan puts them.', 'A good day to review the week’s trades and journal.']],
];
// The three closes you trade, rated per weekday (Sun..Sat) from A-grade results at
// that close: prime = clearly the best, ok = positive, weak = lost money (half size),
// skip = new A-grade entries lost in both halves of the year (Fri–Sun: −0.46R a trade on 234).
export const SESSION = [8, 12, 16];
export const SLOTS = [
  ['skip', 'skip', 'skip'],    // Sun
  ['prime', 'ok', 'ok'],       // Mon
  ['prime', 'ok', 'ok'],       // Tue
  ['prime', 'ok', 'ok'],       // Wed
  ['prime', 'ok', 'weak'],     // Thu
  ['skip', 'skip', 'skip'],    // Fri
  ['skip', 'skip', 'skip'],    // Sat
];
const SLOT_TEXT = { prime: 'Prime', ok: 'OK', weak: 'Weak', skip: 'Skip' };
export const MAX_POSITIONS = 5;
// At most this many new trades on one 4h close: when more qualify, the best grade first, then
// the highest R:R. Backtest: 681R vs 817R uncapped per close, worst day −7R vs −14R.
export const PICKS_PER_CLOSE = 2;

// Risk per trade, % of account equity, by grade. Half on a weak close; nothing
// outside the trading day. Change the numbers here.
// A+ stays at A's 1% until the forward test has ~50 A+ trades: at 1.5% it added ~14 points of drawdown.
export const RISK_PCT = { 'A++': 2, 'A+': 1, A: 1, 'B+': 0.5, B: 0.5, 'C++': 0, C: 0 };
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
// { pct, slot, why } with slot 'prime' | 'ok' | 'weak' | 'skip' | null (outside hours).
// tag: the grade's tag ('midnight' for the Midnight sweep), optional.
export function proposedRisk(grade, closeAt, { tag = null } = {}) {
  const t = new Date(closeAt), i = SESSION.indexOf(t.getHours());
  const slot = i < 0 || t.getMinutes() ? null : SLOTS[t.getDay()][i];
  const base = RISK_PCT[grade] ?? 0;
  if (!base) return { pct: 0, slot, why: grade === 'C++' ? 'grade C++ (a NY fade): tracking only, no size' : `grade ${grade}: skip` };
  if (!slot) {
    const off = !t.getMinutes() && OFF_HOURS.includes(t.getHours()) && t.getDay() >= 1 && t.getDay() <= 4;
    if (off && grade === 'A++' && tag === 'late' && BPLUS_HOURS.includes(t.getHours())) return { pct: LATE_APP_PCT, slot, why: '🌃 Late A++ (NY open, 4h RSI stretched) at a late close, Mon–Thu: half a percent' };
    if (off && grade === 'A++' && tag === 'late') return { pct: 0, slot, why: '🌃 Late A++ at 20:00 lost money in the backtest: skip (only 00:00 and 04:00)' };
    if (off && grade === 'B+' && BPLUS_HOURS.includes(t.getHours())) return { pct: OFF_HOURS_PCT, slot, why: '🌊 NY fade at a late close (Mon–Thu): a quarter percent, for tracking' };
    if (off && grade === 'B+') return { pct: 0, slot, why: 'B+ at 20:00 lost money in the backtest: skip (only 00:00 and 04:00)' };
    if (off && grade === 'A' && tag === 'midnight' && MIDNIGHT_HOURS.includes(t.getHours())) return { pct: OFF_HOURS_PCT, slot, why: '🌙 Midnight sweep (BTC swept the same way mid-NY session, Mon–Thu 00:00): a quarter percent, for tracking' };
    return { pct: 0, slot, why: off ? 'outside the main closes, only the 🌃 Late A++ (0.5%) and 🌊 NY fade at 00:00 / 04:00 and the 🌙 Midnight sweep at 00:00 are taken here, at 0.25%: skip' : 'outside your trading hours (08:00, 12:00, 16:00 closes): skip' };
  }
  if (slot === 'skip') return { pct: 0, slot, why: 'weekend main close: new entries lost in the backtest, skip (hold runners from the week)' };
  if (slot === 'weak') return grade === 'B' || grade === 'B+' ? { pct: 0, slot, why: `grade ${grade} on a weak close: skip` } : { pct: base / 2, slot, why: `grade ${grade} on a weak close: half size` };
  return { pct: base, slot, why: `grade ${grade} at a ${slot === 'prime' ? 'prime' : 'good'} close` };
}
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VERDICT = { strong: 'Strong day', mixed: 'Mixed day', weak: 'Weak day' };
const ALWAYS = [
  ['Hours', 'Trade 8 AM to 4 PM: only the 08:00, 12:00 and 16:00 closes. No trades between closes. At 20:00, 00:00 and 04:00 (Mon–Thu) take only the 🌃 Late A++ (NY open, 4h RSI stretched) at 00:00 and 04:00 at 0.5%, and at 0.25% the 🌊 NY fade at 04:00 and the 🌙 Midnight sweep at 00:00 (an A where BTC swept the same way). The main-close A++ (BTC swept) is a skip there: it made +0.23R a trade. No new trades at all on Fri–Sun: hold runners from the week.'],
  ['Grades', 'Trade A++ (BTC swept with it) at 2%, A+ (4h RSI stretched: under 40 for a long, over 60 for a short) and A at 1%. At the late closes, the 🌃 Late A++ (NY open, 4h RSI stretched) and the 🌊 NY fade, as above. Be cautious with plain B: it lost money in the backtest. Mostly avoid C: trading against yesterday’s NY bias had no edge. C++ (a C fading a 2%+ NY session at 04:00) is tracking only.'],
  ['Entry', 'At the 4h close, stop at the wick, target at the opposing level.'],
  ['Per close', 'At most 2 new trades on one close, 5 open in all. If more qualify, take the best grade first (A++, then A+, then A), then the highest R:R. The alerts mark them 👉 pick.'],
  ['Scale in', 'At +1R add the same size and move all stops to your entry. At +2R add half size and move all stops to break-even.'],
  ['Never', 'Average down, take profit early, or move a stop further away.'],
];
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

// nyLive: today's NY session is running (new setups can't be the main-close A++, A+ or A)
// equity: account equity in USD (null if unknown); hidden: the balance is masked
export function renderPlaybook(root, { now = new Date(), nyLive = false, equity = null, hidden = false, money = v => `$${Math.round(v)}` } = {}) {
  const d = now.getDay(), [verdict, avg, win, share, tips] = DAYS[d], next = nextClose(now);
  // only rebuild when something shown changes: the dashboard re-renders often,
  // and rebuilding would undo an open or close the moment it happens
  const key = `${now.toDateString()}:${nyLive}:${next ? `${next.i}${next.now}` : 'done'}:${equity === null ? '-' : Math.round(equity)}:${hidden}`;
  if (root.dataset.key === key && root.childElementCount) return;
  root.dataset.key = key;

  const head = el('div', 'pb-head');
  head.append(el('span', 'pb-icon', '◆'), el('b', '', `${NAMES[d]}’s playbook`), el('span', 'pb-verdict ' + verdict, VERDICT[verdict]));
  const stat = el('span', 'pb-stat muted small', `A-grade trades: ${r(avg)} avg, ${win}% hit target · a setup on ${share}% of ${NAMES[d]}s`);
  stat.title = 'From the 1-year backtest: A-grade setups with the full scaling plan, after fees';
  head.append(stat);

  // today's three closes, rated, with the one coming up marked
  const slots = el('div', 'pb-slots');
  slots.append(el('span', 'pb-slots-label', 'Trade the closes'));
  SESSION.forEach((h, i) => {
    const q = SLOTS[d][i], chip = el('span', `pb-slot ${q}` + (next?.i === i ? ' next' : '') + (next && i < next.i ? ' past' : !next ? ' past' : ''));
    const at = new Date(now); at.setHours(h, 0, 0, 0);
    const left = el('small', 'pb-left'); left.dataset.at = at.getTime();            // the countdown, ticked by tickPlaybook
    left.textContent = countdown(at.getTime(), now.getTime());
    chip.append(el('b', '', hh(h)), el('span', '', SLOT_TEXT[q]), left);
    chip.title = { prime: 'The best close in the backtest', ok: 'Positive in the backtest', weak: 'Lost money in the backtest: half size, skip B', skip: 'New entries lost money on Fri–Sun: no new trades, hold runners' }[q];
    slots.append(chip);
  });

  // tonight's late closes: B+ and the Midnight sweep at a quarter percent, when the close falls Mon–Thu
  // (20:00 is today; 00:00 and 04:00 close tomorrow)
  const lateOk = h => { const day = h === 20 ? d : (d + 1) % 7; return day >= 1 && day <= 4; };
  const late = OFF_HOURS.filter(lateOk), lateChip = el('span', 'pb-slot late' + (late.length ? '' : ' off'));
  lateChip.append(el('b', '', late.length ? late.map(hh).join(' · ') : 'Late closes'), el('span', '', late.some(h => BPLUS_HOURS.includes(h)) ? `🌃 A++ ${pctText(LATE_APP_PCT)} at ${late.filter(h => BPLUS_HOURS.includes(h)).map(hh).join(' / ')} · 🌊 NY fade, 🌙 A ${pctText(OFF_HOURS_PCT)}` : 'no new trades'));
  lateChip.title = late.length ? 'Outside the main closes, Monday to Thursday: the 🌃 Late A++ (NY open, 4h RSI stretched) at 00:00 and 04:00 at 0.5%; the 🌊 NY fade at 04:00 and the 🌙 Midnight sweep at 00:00 at 0.25%' : 'No new trades outside the main closes on Friday to Sunday';
  slots.append(el('span', 'pb-slots-sep', 'then'), lateChip);

  const list = el('ul', 'pb-tips');
  for (const t of tips) list.append(el('li', '', t));
  if (nyLive) list.append(el('li', 'pb-live', 'The NY session is open right now: until it closes, new setups are the 🌃 Late A++ (4h RSI stretched), an A with a BTC sweep, or a B.'));

  const rules = el('details', 'pb-rules'), sum = el('summary');
  try { rules.open = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  const label = () => { sum.textContent = rules.open ? 'Hide guidelines' : 'Show guidelines'; };
  rules.addEventListener('toggle', () => { label(); try { localStorage.setItem(OPEN_KEY, rules.open ? '1' : '0'); } catch {} });
  label();
  rules.append(sum);
  const dl = el('dl');
  // risk per grade, in dollars from the current equity
  const dollars = g => (equity && !hidden ? ` (${money(equity * RISK_PCT[g] / 100)})` : '');
  const risk = `A++ ${pctText(RISK_PCT['A++'])}${dollars('A++')} · A+ ${pctText(RISK_PCT['A+'])}${dollars('A+')} · A ${pctText(RISK_PCT.A)}${dollars('A')} · B ${pctText(RISK_PCT.B)}${dollars('B')} of equity per trade, half on a weak close, none on Fri–Sun. At most 2 new a close, 5 open.`;
  for (const [k, v] of [...ALWAYS, ['Risk', risk + (equity === null ? ' Connect your account to see it in dollars.' : '')]]) { const row = el('div'); row.append(el('dt', '', k), el('dd', '', v)); dl.append(row); }
  rules.append(dl);

  root.replaceChildren(head, slots, list, rules);
  root.className = 'day-playbook c12 pb-' + verdict;
  root.hidden = false;
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

const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const coinOf = s => String(s || '').replace(/USDT$/, '');
// Notes for a live position, from what the backtest found:
//   - the NY bias now vs the position (with it: hold; flipped your way since
//     entry: keep holding; against it: weaker odds)
//   - where it stands in the plan (next step at +1R / +2R, or protected)
//   - Friday to Sunday: hold runners through the weekend
// p: { dir, entry, mark, sl, slLoss, openedAt }; sessions: newest first, as nySessions returns.
// smt: smtCheck's answer for this position, when the app has read its 4h candles.
export function positionNotes(p, { sessions = [], now = new Date(), price = v => String(v), equity = null, smt = null } = {}) {
  const notes = [], long = p.dir === 'Long', side = long ? 'bullish' : 'bearish', d = long ? 1 : -1;
  const done = (sessions || []).filter(x => !x.live && !x.missing && x.bias);
  const nowBias = done[0]?.bias || null;
  const atEntry = p.openedAt ? done.find(x => x.end <= p.openedAt)?.bias || null : null;
  const mark = b => (b === 'bullish' ? '▲' : b === 'bearish' ? '▼' : '');
  if (nowBias && nowBias !== 'flat') {
    if (nowBias === side && atEntry && atEntry !== side) notes.push({ cls: 'pos', text: `NY flipped your way since entry ${mark(nowBias)}: keep holding` });
    else if (nowBias === side) notes.push({ cls: 'pos', text: `With the NY bias ${mark(nowBias)}: hold to the plan` });
    else notes.push({ cls: 'warn', text: `Against the NY bias ${mark(nowBias)}: weaker odds, consider tightening or closing` });
  }
  if (sessions?.[0]?.live && !sessions[0].pending) notes.push({ cls: 'muted', text: 'NY session open: the bias can change at its close' });
  if (p.sl && p.entry && p.mark) {
    const risk = d * (p.entry - p.sl);
    if (risk <= 0) notes.push({ cls: 'pos', text: 'Stop at or past entry: protected, hold to the target' });
    else {
      const r = d * (p.mark - p.entry) / risk, at = n => price(p.entry + d * n * risk);
      const rs = `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`;
      if (r >= 2) notes.push({ cls: 'pos', text: `${rs}: past +2R, add half size and move all stops to break-even` });
      else if (r >= 1) notes.push({ cls: 'pos', text: `${rs}: past +1R, add the same size and move all stops to entry. Next at ${at(2)} (+2R)` });
      else notes.push({ cls: '', text: `${rs}: stop at the wick, first add at ${at(1)} (+1R)` });
      // still at full risk in the first 3 candles: does the alt keep up with BTC? (smtCheck)
      if (r < 1 && smt?.state === 'diverged') notes.push({ cls: 'warn', text: `BTC broke its last 4h ${long ? 'high' : 'low'} but ${coinOf(p.symbol)} didn’t, still at full risk: closing is reasonable` });
      else if (r < 1 && smt?.state === 'watch') notes.push({ cls: 'muted', text: `Tip: until the ${hhmm(smt.until)} close, if BTC breaks its last 4h ${long ? 'high' : 'low'} and ${coinOf(p.symbol)} doesn’t, closing is reasonable` });
    }
  }
  // hold time: most stops come within 8h; trades that last longer are the ones that reach the target
  const held = p.openedAt ? (now.getTime() - p.openedAt) / 3_600_000 : null;
  const up = p.sl && d * (p.entry - p.sl) > 0 ? d * (p.mark - p.entry) / (d * (p.entry - p.sl)) >= 0.25 : d * (p.mark - p.entry) > 0;   // clearly in profit
  if (held !== null && held >= 8 && p.mark && up) notes.push({ cls: 'pos', text: `Held ${held >= 48 ? Math.round(held / 24) + 'd' : Math.round(held) + 'h'} and in profit: past the usual stop-out window, let it run` });
  // size against the plan (A and A+ 1%, A++ 2% of equity on the first entry)
  if (equity && p.slLoss < 0 && d * (p.entry - p.sl) > 0) {
    const pct = -p.slLoss / equity * 100;
    if (pct > RISK_PCT['A++'] * 1.25) notes.push({ cls: 'warn', text: `Risking ${pct.toFixed(1)}% of equity to the stop: the plan's most is ${RISK_PCT['A++']}% (A++)` });
  }
  // Thursday, working (in profit, or the stop at/past entry): the last weekday before the weekend, when
  // runners have days to go. Trades still open into the weekend averaged +15.7R in the backtest.
  if (now.getDay() === 4 && p.mark && p.entry && (d * (p.mark - p.entry) > 0 || (p.sl && d * (p.entry - p.sl) <= 0)))
    notes.push({ cls: 'pos', text: 'Thursday: the weekend is coming, consider leaving it open for a few days' });
  // into the weekend in profit (+1R or better, or stop already at/past entry): runners held over it
  // tended to keep going, and an add that risked 1R to the existing stop made money in the backtest
  if ([5, 6, 0].includes(now.getDay())) {
    const risk = p.sl && p.entry ? d * (p.entry - p.sl) : null, r = risk > 0 && p.mark ? d * (p.mark - p.entry) / risk : null;
    const ahead = p.mark && d * (p.mark - p.entry) > 0 && (r === null ? risk !== null : r >= 1);
    notes.push(ahead
      ? { cls: 'pos', text: 'Weekend, in profit: consider adding on a pullback. Size it to risk 1R to your current stop, and don’t move the stop up for it' }
      : { cls: 'muted', text: 'Weekend: hold your runner, don’t close for the weekend' });
  }
  return notes;
}
