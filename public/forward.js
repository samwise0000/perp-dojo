// Forward test: your live trades against the plan. Each closed position is
// matched to the signal it came from (same pair and side, opened within the 4h
// candle after the signal's close, or up to an hour before it), then scored in R by that signal's stop:
// your net P&L ÷ (your first order's size × the signal's entry-to-stop distance).
// The same signal's plan result (with the adds, after fees) is the yardstick, and
// the year before your start date says what the plan should average.
import { loadSignals } from './signals.js';
import { showOnChart } from './signal-chart.js';
import { H4, GRADE_ORDER } from './sfp.js';
import { proposedRisk, picksAt, setupName } from './day-playbook.js';

const DAY = 864e5, GOAL = 100, START_KEY = 'perp-dojo:forward-start';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const rText = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${+v.toFixed(2) > 0 ? '+' : +v.toFixed(2) < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const coin = s => s.replace(/USDT$|USDC$/, '');
const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => (a.length ? sum(a) / a.length : null);

// ---- the matching (pure, tested) ----

// Closed-P&L records → positions: the partial closes of one position share its open time.
export function positionsFrom(trades) {
  const m = new Map();
  for (const t of trades) {
    if (!Number.isFinite(t.openedAt)) continue;
    const k = `${t.category}:${t.symbol}:${t.dir}:${t.openedAt}`;
    const p = m.get(k) || { key: k, category: t.category, symbol: t.symbol, dir: t.dir, openedAt: t.openedAt, closedAt: 0, pnl: 0, fees: 0, size: 0, parts: 0 };
    p.closedAt = Math.max(p.closedAt, t.time); p.pnl += t.pnl; p.fees += t.fees || 0; p.size += t.size; p.parts++;
    m.set(k, p);
  }
  return [...m.values()].sort((a, b) => a.openedAt - b.openedAt);
}

// The first order's size and how many more orders added to the position, from the fills.
export function entryOrders(pos, execs) {
  const opens = pos.dir === 'Long' ? 'Buy' : 'Sell';
  const fills = Object.values(execs || {}).filter(f => f.s === pos.symbol && f.c === pos.category && f.side === opens && f.t >= pos.openedAt && f.t <= pos.closedAt && f.q - Math.min(f.cs || 0, f.q) > 0)
    .sort((a, b) => a.t - b.t);
  if (!fills.length) return { first: null, adds: 0 };
  const firstOrder = fills[0].o;
  const first = sum(fills.filter(f => f.o === firstOrder).map(f => f.q - Math.min(f.cs || 0, f.q)));
  return { first, adds: new Set(fills.filter(f => f.o !== firstOrder).map(f => f.o)).size };
}

// The signal a position came from: same pair and side, opened from an hour before
// the signal's close (entering on the forming candle) to the end of the next 4h candle.
export function matchSignal(pos, signals) {
  const near = signals.filter(s => s.symbol === pos.symbol && s.side === pos.dir && pos.openedAt >= s.t + H4 - 60 * 60_000 && pos.openedAt < s.t + 2 * H4);
  return near.sort((a, b) => Math.abs(pos.openedAt - (a.t + H4)) - Math.abs(pos.openedAt - (b.t + H4)))[0] || null;
}

// Would the plan take this signal at its close (risk > 0), and was it one of the close's picks?
export const takeable = s => Boolean(s.grade && s.trade) && proposedRisk(s.grade.grade, s.t + H4, { tag: s.grade.tag }).pct > 0;
export function pickSet(signals) {
  const byClose = new Map();
  for (const s of signals.filter(takeable)) { const k = s.t; if (!byClose.has(k)) byClose.set(k, []); byClose.get(k).push(s); }
  const picks = new Set();
  for (const g of byClose.values()) {
    g.sort((a, b) => GRADE_ORDER.indexOf(a.grade.grade) - GRADE_ORDER.indexOf(b.grade.grade) || b.trade.rr - a.trade.rr);
    g.slice(0, picksAt(g[0].t + H4)).forEach(s => picks.add(s));
  }
  return picks;
}
// The plan's result for a signal, in R after fees (with the adds), or null while it's open.
export const planR = s => (s?.trade?.scaled && s.trade.scaled.net !== null && s.trade.scaled.net !== undefined ? s.trade.scaled.net : null);

export function forwardReport({ trades, execs, signals, start, now = Date.now() }) {
  const live = positionsFrom(trades).filter(p => p.openedAt >= start);
  const picks = pickSet(signals);
  const rows = live.map(p => {
    const sig = matchSignal(p, signals), { first, adds } = entryOrders(p, execs);
    const riskUsd = sig && first ? first * Math.abs(sig.trade.entry - sig.trade.sl) : null;
    return { ...p, sig, grade: sig?.grade?.grade || null, setup: sig?.grade ? setupName(sig.grade.grade, sig.t + H4, sig.grade.tag) : null, onPlan: Boolean(sig && takeable(sig)), pick: Boolean(sig && picks.has(sig)), adds,
      R: riskUsd ? p.pnl / riskUsd : null, plan: planR(sig) };
  });
  const taken = new Set(rows.map(r => r.sig).filter(Boolean));
  const missed = signals.filter(s => s.t + H4 >= start && s.t + H4 <= now && takeable(s) && picks.has(s) && !taken.has(s));
  // what the plan averaged on the year before the start, per grade (closed signals only)
  const before = signals.filter(s => s.t + H4 < start && takeable(s) && planR(s) !== null);
  const expect = { all: avg(before.map(planR)), n: before.length };
  for (const g of GRADE_ORDER) { const x = before.filter(s => s.grade.grade === g); expect[g] = { avg: avg(x.map(planR)), n: x.length }; }
  for (const n of ['🌃 Late A++', '🌙 Midnight sweep', '🌊 NY fade']) { const x = before.filter(s => setupName(s.grade.grade, s.t + H4, s.grade.tag) === n); expect[n] = { avg: avg(x.map(planR)), n: x.length }; }
  return { rows, missed, expect };
}

// ---- the tab ----

let state = { start: null };
try { const v = Number(localStorage.getItem(START_KEY)); if (v) state.start = v; } catch {}
const dateInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// two cumulative R lines: yours and the plan's on the same trades
function curve(rows) {
  const pts = rows.filter(r => r.R !== null && r.plan !== null);
  if (pts.length < 2) return el('p', 'muted small', 'The chart appears after two closed trades on plan signals.');
  let a = 0, b = 0; const A = [0], B = [0];
  for (const r of pts) { a += r.R; b += r.plan; A.push(a); B.push(b); }
  const W = 640, H = 200, lo = Math.min(0, ...A, ...B), hi = Math.max(0, ...A, ...B), span = hi - lo || 1;
  const X = i => 40 + i / (A.length - 1) * (W - 56), Y = v => 12 + (hi - v) / span * (H - 30);
  const line = (vs, c) => `<polyline points="${vs.map((v, i) => `${X(i)},${Y(v)}`).join(' ')}" class="fw-line ${c}"/>`;
  const wrap = el('div', 'fw-curve');
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your cumulative R against the plan's"><line x1="40" x2="${W - 16}" y1="${Y(0)}" y2="${Y(0)}" class="fw-zero"/>
    <text x="34" y="${Y(hi) + 4}" text-anchor="end" class="fw-tick">${rText(hi).replace('.00', '')}</text><text x="34" y="${Y(lo) + 4}" text-anchor="end" class="fw-tick">${rText(lo).replace('.00', '')}</text>
    ${line(B, 'plan')}${line(A, 'you')}</svg>
    <div class="fw-key"><span class="you">You ${rText(a)}</span><span class="plan">Plan on the same trades ${rText(b)}</span></div>`;
  return wrap;
}

function verdict(rows, expect) {
  const R = rows.filter(r => r.onPlan && r.R !== null).map(r => r.R), n = R.length;
  if (!expect.all && expect.all !== 0) return ['muted', 'No backtest yet', 'Not enough signals before your start date to compare against.'];
  if (n < 20) return ['muted', 'Too early to tell', `${n} trade${n === 1 ? '' : 's'} on plan so far. With a strategy this lumpy, give it at least 20–30 before reading anything into the average, and the full ${GOAL} before changing size.`];
  const m = avg(R), sd = Math.sqrt(sum(R.map(x => (x - m) ** 2)) / (n - 1)), se = sd / Math.sqrt(n);
  if (m + 2 * se < expect.all) return ['neg', 'Clearly below the backtest', `Your ${rText(m)} a trade is below the plan’s ${rText(expect.all)} by more than chance explains. Check execution (late entries, skipped adds, early exits) before blaming the setups.`];
  if (m - 2 * se > expect.all) return ['pos', 'Above the backtest', `Your ${rText(m)} a trade beats the plan’s ${rText(expect.all)}. Enjoy it, but expect it to come back toward the plan.`];
  return ['ok', 'In line with the backtest', `Your ${rText(m)} a trade is within the range the plan’s ${rText(expect.all)} would give over ${n} trades.`];
}

export async function renderForward(root, { ctx, trades, execs, fmt }) {
  const money = fmt.money, when = ms => fmt.dateTime(ms);
  if (!state.start) state.start = Date.now() - 30 * DAY;
  root.replaceChildren(el('div', 'card c12', 'Loading the year’s signals…'));
  let data;
  try { data = await loadSignals(ctx, 365); }
  catch (e) { root.replaceChildren(el('div', 'card c12 muted', `Couldn’t load signals: ${e.message}`)); return; }
  const { rows, missed, expect } = forwardReport({ trades, execs, signals: data.signals, start: state.start });
  const on = rows.filter(r => r.onPlan), scored = on.filter(r => r.R !== null), off = rows.filter(r => !r.onPlan);
  const liveAvg = avg(scored.map(r => r.R)), planSame = avg(scored.filter(r => r.plan !== null).map(r => r.plan));
  const busy = on.filter(r => r.sig && data.signals.filter(s => s.t === r.sig.t && takeable(s)).length > picksAt(r.sig.t + H4));

  // head: the start date and progress
  const head = el('div', 'card c12 fw-head');
  const startIn = el('input'); startIn.type = 'date'; startIn.value = dateInput(state.start); startIn.id = 'fwStart';
  startIn.onchange = () => { const [y, m, d] = startIn.value.split('-').map(Number); if (!y) return; state.start = new Date(y, m - 1, d).getTime(); try { localStorage.setItem(START_KEY, String(state.start)); } catch {} renderForward(root, { ctx, trades, execs, fmt }); };
  const lab = el('label', 'fw-start'); lab.append(el('span', 'kicker', 'Forward test since'), startIn);
  const prog = el('div', 'fw-prog'), bar = el('i'); bar.style.width = `${Math.min(100, on.length / GOAL * 100)}%`; prog.append(bar);
  const [vc, vt, vd] = verdict(rows, expect);
  const top = el('div', 'card-row fw-top'); top.append(lab); head.append(top);
  head.append(el('p', 'muted', 'Your closed trades since the start date, matched to the signal each came from and scored in R by that signal’s stop. The plan column is what the same signal made in the backtest with the adds, so the gap between them is execution.'),
    el('div', 'fw-prog-row'));
  head.lastChild.append(el('b', '', `${on.length} of ${GOAL}`), prog, el('span', 'muted small', 'trades on plan signals'));
  const v = el('div', 'fw-verdict ' + vc); v.append(el('b', '', vt), el('span', '', vd)); head.append(v);

  // KPIs
  const kpi = (k, val, sub, c = '') => { const d = el('div', 'card c3 fw-kpi'); d.append(el('div', 'kicker', k), el('div', 'fw-kpi-v ' + c, val), el('div', 'muted small', sub)); return d; };
  const kpis = [
    kpi('Your avg', rText(liveAvg), `${scored.length} scored trade${scored.length === 1 ? '' : 's'} on plan`, cls(liveAvg)),
    kpi('Plan on the same trades', rText(planSame), 'the backtest result of those signals', cls(planSame)),
    kpi('Plan’s year before', rText(expect.all), `${expect.n} takeable signals before your start`, cls(expect.all)),
    kpi('Off plan', String(off.length), off.length ? `${money(sum(off.map(r => r.pnl)))} P&L · no takeable signal behind them` : 'every trade came from a plan signal', off.length ? 'neg' : 'pos'),
  ];

  // by grade
  const gradeCard = el('div', 'card c6');
  gradeCard.append(el('div', 'kicker', 'By grade'));
  const gt = el('table', 'data compact'); gt.innerHTML = '<thead><tr><th>Grade</th><th class="num">Trades</th><th class="num">Your avg</th><th class="num">Plan, same trades</th><th class="num">Plan’s year before</th></tr></thead>';
  const gb = el('tbody');
  for (const g of GRADE_ORDER) {
    const x = rows.filter(r => r.grade === g), xs = x.filter(r => r.R !== null), e = expect[g];
    if (!x.length && !e?.n) continue;
    const tr = el('tr'), b = el('td'); b.append(el('span', 'sig-grade g-' + g.toLowerCase().replace(/\+/g, 'plus'), g === 'A++' ? '★ A++' : g));
    const ya = avg(xs.map(r => r.R)), pa = avg(xs.filter(r => r.plan !== null).map(r => r.plan));
    tr.append(b, el('td', 'num', String(x.length)), el('td', 'num ' + cls(ya), rText(ya)), el('td', 'num ' + cls(pa), rText(pa)), el('td', 'num muted', e?.n ? `${rText(e.avg)} (${e.n})` : '—'));
    gb.append(tr);
    subRows(g);
  }
  function subRows(g) { for (const n of { 'A++': ['🌃 Late A++'], A: ['🌙 Midnight sweep'], 'B+': ['🌊 NY fade'] }[g] || []) {
    const x = rows.filter(r => r.setup === n), xs = x.filter(r => r.R !== null), e = expect[n];
    if (!x.length && !e?.n) continue;
    const ya = avg(xs.map(r => r.R)), pa = avg(xs.filter(r => r.plan !== null).map(r => r.plan)), tr = el('tr', 'fw-sub');
    tr.append(el('td', '', '↳ ' + n), el('td', 'num', String(x.length)), el('td', 'num ' + cls(ya), rText(ya)), el('td', 'num ' + cls(pa), rText(pa)), el('td', 'num muted', e?.n ? `${rText(e.avg)} (${e.n})` : '—'));
    gb.append(tr);
  } }
  gt.append(gb); const gw = el('div', 'table-wrap'); gw.append(gt); gradeCard.append(gw);
  gradeCard.append(el('p', 'muted small', 'B and C trades show here too, so you can see what taking them costs. Only A++, A+, A and B+ at their closes (and the 🌙 Midnight sweep) count as on plan.'));

  // discipline
  const disc = el('div', 'card c6');
  disc.append(el('div', 'kicker', 'Discipline'));
  const dl = el('dl', 'fw-disc');
  const item = (k, v, sub, c = '') => { const d = el('div'); d.append(el('dt', c, v), el('dd', '', k), el('small', 'muted', sub)); dl.append(d); };
  const addsDone = on.filter(r => r.adds > 0).length, bigPlan = on.filter(r => r.plan !== null && r.plan >= 3);
  item('Took the pick', busy.length ? `${busy.filter(r => r.pick).length} of ${busy.length}` : '—', 'on closes with more than 2 setups');
  item('Added to the trade', on.length ? `${addsDone} of ${on.length}` : '—', 'trades with at least one add order');
  item('Missed picks', String(missed.length), missed.length ? `the plan made ${rText(sum(missed.map(planR).filter(v => v !== null)))} on them` : 'none since the start', missed.length ? 'warn' : '');
  item('Runners held', bigPlan.length ? `${bigPlan.filter(r => r.R !== null && r.R >= r.plan * 0.5).length} of ${bigPlan.length}` : '—', 'plan made 3R+: you kept at least half');
  disc.append(dl, curve(on));

  // the trades
  const list = el('div', 'card c12');
  list.append(el('div', 'kicker', 'Your trades'));
  const t = el('table', 'data compact fw-table');
  t.innerHTML = '<thead><tr><th>Opened</th><th>Pair</th><th>Side</th><th>Grade</th><th>Signal</th><th class="num">Adds</th><th class="num">P&amp;L</th><th class="num">You</th><th class="num">Plan</th><th class="num">Gap</th></tr></thead>';
  const tb = el('tbody');
  for (const r of [...rows].reverse()) {
    const tr = el('tr', r.onPlan ? '' : 'fw-off');
    const g = el('td'); if (r.grade) g.append(el('span', 'sig-grade g-' + r.grade.toLowerCase().replace(/\+/g, 'plus'), r.grade === 'A++' ? '★ A++' : r.grade)); else g.textContent = '—';
    const sigTxt = !r.sig ? 'no signal' : !r.onPlan ? 'not taken by the plan' : r.pick ? `👉 pick · ${r.sig.trade.rr.toFixed(1)}R target` : `${r.sig.trade.rr.toFixed(1)}R target`;
    const gap = r.R !== null && r.plan !== null ? r.R - r.plan : null;
    tr.append(el('td', '', when(r.openedAt)), el('td', '', coin(r.symbol)), el('td', r.dir === 'Long' ? 'pos' : 'neg', r.dir), g, el('td', 'muted', sigTxt), el('td', 'num', String(r.adds)),
      el('td', 'num ' + cls(r.pnl), money(r.pnl)), el('td', 'num ' + cls(r.R), rText(r.R)), el('td', 'num ' + cls(r.plan), r.sig ? (r.plan === null ? 'open' : rText(r.plan)) : '—'), el('td', 'num ' + cls(gap), rText(gap)));
    if (r.sig) { tr.classList.add('clickable'); tr.title = 'Open the signal on the chart'; tr.onclick = () => showOnChart(r.sig, rows.map(x => x.sig).filter(Boolean)); }
    tb.append(tr);
  }
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'muted', 'No closed trades since the start date yet. Pull your latest trades, or move the start date back.'); td.colSpan = 10; tr.append(td); tb.append(tr); }
  t.append(tb); const tw = el('div', 'table-wrap'); tw.append(t); list.append(tw);
  list.append(el('p', 'muted small', 'You = your net P&L ÷ (your first order’s size × the signal’s entry-to-stop distance), so it’s in the same R as the plan. Gap = you − plan: negative means the trade gave up R against the plan (late entry, skipped adds, early exit, fees). Faded rows had no takeable signal behind them.'));

  // missed picks
  const miss = el('details', 'card c12 fw-missed');
  miss.append(el('summary', '', `Picks you didn’t take (${missed.length})`));
  if (missed.length) {
    const mt = el('table', 'data compact'); mt.innerHTML = '<thead><tr><th>Close</th><th>Pair</th><th>Side</th><th>Grade</th><th class="num">Target</th><th class="num">Plan</th></tr></thead>';
    const mb = el('tbody');
    for (const s of [...missed].reverse()) {
      const tr = el('tr', 'clickable'), g = el('td'); g.append(el('span', 'sig-grade g-' + s.grade.grade.toLowerCase().replace(/\+/g, 'plus'), s.grade.grade === 'A++' ? '★ A++' : s.grade.grade));
      const p = planR(s);
      tr.append(el('td', '', when(s.t + H4)), el('td', '', coin(s.symbol)), el('td', s.side === 'Long' ? 'pos' : 'neg', s.side), g, el('td', 'num', `${s.trade.rr.toFixed(1)}R`), el('td', 'num ' + cls(p), p === null ? 'open' : rText(p)));
      tr.onclick = () => showOnChart(s, missed);
      mb.append(tr);
    }
    mt.append(mb); const mw = el('div', 'table-wrap'); mw.append(mt); miss.append(mw);
  } else miss.append(el('p', 'muted small', 'You took every pick since the start date.'));

  root.replaceChildren(head, ...kpis, gradeCard, disc, list, miss);
}
