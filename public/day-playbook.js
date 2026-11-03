// Today's playbook: what the 1-year backtest says about trading this day, the
// closes you trade today, and the rules that always apply. Days and hours are
// the viewer's local time (the backtest used UTC+8, Asia/Makassar). Numbers are
// A and A+ setups traded with the full plan (adds at +1R and +2R, stops to
// entry then break-even), after fees.
//
// The trading day is 8 AM to 4 PM: new trades only at the 08:00, 12:00 and
// 16:00 closes, never between closes. The other closes (20:00, 00:00, 04:00)
// broke even or lost once a few outliers were removed.
const DAYS = [
  // [verdict, avg R, win rate, share of days with an A/A+ setup, advice]
  ['weak', -0.32, 19, 85, ['Setups lost money on Sundays: half size or skip new ones.', 'One of the busiest days for setups, so it’s easy to get pulled in. Wait for the week.', 'Hold anything already running from the week.']],
  ['mixed', 0.41, 28, 87, ['The busiest day: there’s an A/A+ setup on most Mondays, often several at once.', 'Only modestly profitable, so be selective and stay under your position cap.', 'The 08:00 close is where Monday’s profit came from.']],
  ['strong', 3.47, 44, 56, ['The best day in the backtest: 44% of A/A+ trades hit the target.', 'Take A and A+ setups with confidence, full plan.', 'Hold to the opposing level. The big winners pay for everything.']],
  ['strong', 3.91, 32, 57, ['A strong day, carried by some very large winners.', 'Take A and A+ setups with the full plan.', 'Hold to the target; don’t cut winners early.']],
  ['strong', 1.68, 38, 67, ['Solid and steady, positive in both halves of the year.', 'Trades opened now often run into the weekend, and those were the biggest winners.', 'Hold them through the weekend if they’re working.']],
  ['weak', -0.47, 26, 56, ['New setups opened on Fridays lost money: half size or skip.', 'Hold your runners. Trades already open going into the weekend were the biggest winners.', 'Don’t close winners just because the weekend is coming.']],
  ['weak', -0.56, 15, 65, ['The weakest day: only 15% of A/A+ trades hit the target.', 'Skip new setups, or half size at most.', 'Hold anything already running and leave the stops where the plan puts them.']],
];
// The three closes you trade, rated per weekday (Sun..Sat) from A/A+ results at
// that close: prime = clearly the best, ok = positive, weak = lost money.
const SESSION = [8, 12, 16];
const SLOTS = [
  ['weak', 'weak', 'weak'],    // Sun
  ['prime', 'ok', 'ok'],       // Mon
  ['prime', 'ok', 'ok'],       // Tue
  ['prime', 'ok', 'ok'],       // Wed
  ['prime', 'ok', 'weak'],     // Thu
  ['weak', 'weak', 'weak'],    // Fri
  ['weak', 'weak', 'weak'],    // Sat
];
const SLOT_TEXT = { prime: 'Prime', ok: 'OK', weak: 'Weak' };
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VERDICT = { strong: 'Strong day', mixed: 'Mixed day', weak: 'Weak day' };
const ALWAYS = [
  ['Hours', 'Trade 8 AM to 4 PM: only the 08:00, 12:00 and 16:00 closes. No trades between closes, none at 20:00, 00:00 or 04:00.'],
  ['Grades', 'Take A and A+. B only if it’s clean, at half size. Skip C.'],
  ['Entry', 'At the 4h close, stop at the wick, target at the opposing level.'],
  ['Scale in', 'At +1R add the same size and move all stops to your entry. At +2R add half size and move all stops to break-even.'],
  ['Never', 'Average down, take profit early, or move a stop further away.'],
  ['Size', 'Fixed dollar risk per trade, at most 5 positions open.'],
];
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

// nyLive: today's NY session is running (setups now grade B at best)
export function renderPlaybook(root, { now = new Date(), nyLive = false } = {}) {
  const d = now.getDay(), [verdict, avg, win, share, tips] = DAYS[d], next = nextClose(now);
  // only rebuild when something shown changes: the dashboard re-renders often,
  // and rebuilding would undo an open or close the moment it happens
  const key = `${now.toDateString()}:${nyLive}:${next ? `${next.i}${next.now}` : 'done'}`;
  if (root.dataset.key === key && root.childElementCount) return;
  root.dataset.key = key;

  const head = el('div', 'pb-head');
  head.append(el('span', 'pb-icon', '◆'), el('b', '', `${NAMES[d]}’s playbook`), el('span', 'pb-verdict ' + verdict, VERDICT[verdict]));
  const stat = el('span', 'pb-stat muted small', `A/A+ trades: ${r(avg)} avg, ${win}% hit target · a setup on ${share}% of ${NAMES[d]}s`);
  stat.title = 'From the 1-year backtest: A and A+ setups with the full scaling plan, after fees';
  head.append(stat);

  // today's three closes, rated, with the one coming up marked
  const slots = el('div', 'pb-slots');
  slots.append(el('span', 'pb-slots-label', 'Trade the closes'));
  SESSION.forEach((h, i) => {
    const q = SLOTS[d][i], chip = el('span', `pb-slot ${q}` + (next?.i === i ? ' next' : '') + (next && i < next.i ? ' past' : !next ? ' past' : ''));
    chip.append(el('b', '', hh(h)), el('span', '', SLOT_TEXT[q]));
    chip.title = { prime: 'The best close in the backtest', ok: 'Positive in the backtest', weak: 'Lost money in the backtest: half size or skip' }[q];
    slots.append(chip);
  });
  const status = !next ? 'Done for today: the next trades are at the 08:00 close tomorrow.'
    : next.now ? `The ${hh(next.at)} close is now: check the alerts.`
    : next.i === 0 ? `Before the trading day: it starts at the 08:00 close (${SLOT_TEXT[SLOTS[d][0]].toLowerCase()}).`
    : `Between closes: no new trades. Next is ${hh(next.at)} (${SLOT_TEXT[SLOTS[d][next.i]].toLowerCase()}).`;
  slots.append(el('span', 'pb-slot-status muted small', status));

  const list = el('ul', 'pb-tips');
  for (const t of tips) list.append(el('li', '', t));
  if (nyLive) list.append(el('li', 'pb-live', 'The NY session is open right now: new setups grade B at best until it closes.'));

  const rules = el('details', 'pb-rules'), sum = el('summary');
  try { rules.open = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  const label = () => { sum.textContent = rules.open ? 'Hide guidelines' : 'Show guidelines'; };
  rules.addEventListener('toggle', () => { label(); try { localStorage.setItem(OPEN_KEY, rules.open ? '1' : '0'); } catch {} });
  label();
  rules.append(sum);
  const dl = el('dl');
  for (const [k, v] of ALWAYS) { const row = el('div'); row.append(el('dt', '', k), el('dd', '', v)); dl.append(row); }
  rules.append(dl);

  root.replaceChildren(head, slots, list, rules);
  root.className = 'day-playbook c12 pb-' + verdict;
  root.hidden = false;
}
