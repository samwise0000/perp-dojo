// Signals: every 4h swing failure signal on the default pairs, with the same
// rules and filters as the Telegram alerts (sfp.js ALERT_SETTINGS), so the
// site and the bot always agree. The Signals tab lists them all; the dashboard
// shows the latest few. Candles come from the IndexedDB cache in signal-chart.js.
import { detect, H4, ALERT_SETTINGS, DEFAULT_PAIRS, trendMap, btcSide, gradeSetup } from './sfp.js';
import { sessionList, nyBiasAt } from './bias.js';
import { idbGet, idbSet } from './db.js';
import { candlesFor, pool, showOnChart, bindCharts } from './signal-chart.js';

const DAY = 86_400_000;
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const PAIRS = DEFAULT_PAIRS.split(' ').map(x => x + 'USDT');
const TREND = { aligned: 'Aligned', counter: 'Countertrend', neutral: 'Neutral' };

// ---- data ----
// One computation, kept for the current 4h candle. A longer period also serves
// any shorter request.
let held = null;                           // { days, candle, p }
// Progress of the computation in flight: which pairs are read, then BTC. Views
// subscribe while they wait, so the tab can show it even if the dashboard started it.
const progress = { pairs: new Map(), stage: 'idle', subs: new Set() };
const notify = () => progress.subs.forEach(f => f());
let ctx_ = null;
export function loadSignals(ctx, days) {
  bindCharts(ctx); ctx_ = ctx;
  const candle = Math.floor(Date.now() / H4);
  if (held && held.candle === candle && held.days >= days) return held.p.then(r => ({ ...r, signals: r.signals.filter(s => s.t >= Date.now() - days * DAY) }));
  const p = compute(days);
  held = { days, candle, p };
  p.catch(() => { if (held?.p === p) held = null; });
  return p;
}

async function compute(days) {
  const o = ALERT_SETTINGS;
  const since = Date.now() - days * DAY;
  const start = since - (o.lookbackDays + Math.max(o.rangeDays, 7) + 5) * DAY;
  const errors = [];
  progress.pairs = new Map(PAIRS.map(p => [p, 'wait'])); progress.stage = 'pairs'; notify();
  const per = await pool(PAIRS, 4, async symbol => {
    try {
      // one retry: a single dropped request shouldn't hide a pair
      const candles = (await candlesFor(symbol, start).catch(() => candlesFor(symbol, start))).filter(c => c.t >= start);
      progress.pairs.set(symbol, 'ok'); notify();
      const last = candles.at(-1);
      return detect(candles, o).signals.filter(s => s.t >= since).map(s => {
        // how it's doing now, for signals younger than 24h
        const run = last && last.t > s.t ? (s.side === 'Short' ? s.close - last.c : last.c - s.close) / s.close : null;
        return { ...s, symbol, running: run };
      });
    } catch (e) { errors.push(symbol); progress.pairs.set(symbol, 'err'); notify(); return []; }
  });
  progress.stage = 'btc'; notify();
  const btc = await candlesFor('BTCUSDT', start - 20 * DAY);
  const trends = trendMap(btc, o.trendEma);
  // for the grade: BTC's own SFPs (same rules) and the NY session bias from BTC's 1h candles
  const btcSfp = new Set(detect(btc, o).signals.map(s => `${s.t}:${s.side}`));
  let sessions = null;
  try { sessions = sessionList(await hourly('BTCUSDT', since - 7 * DAY), { from: since - 7 * DAY }); } catch {}
  const signals = per.flat().map(s => {
    const trend = btcSide(s, trends, o.neutralBand);
    const ny = sessions ? nyBiasAt(sessions, s.t + H4) : null;
    const grade = sessions ? gradeSetup(s.side, { ny, swept: btcSfp.has(`${s.t}:${s.side}`) }) : null;
    return { ...s, trend, counter: trend === 'counter', btc: trends.get(s.t - H4) || null, ny, grade };
  }).sort((a, b) => b.t - a.t || a.symbol.localeCompare(b.symbol));
  progress.stage = 'done'; notify();
  return { signals, errors, at: Date.now(), days };
}

// 1h candles from `start`, cached like the 4h ones (closed candles only)
const H1 = 3_600_000;
async function hourly(symbol, start) {
  const key = `sfp1h:linear:${symbol}`;
  let have = (await idbGet(key).catch(() => null)) || [];
  if (have.length && have[0].t > start) have = [];
  const fresh = [];
  for (let s = have.length ? have.at(-1).t + H1 : Math.floor(start / H1) * H1; s < Date.now(); s += 1000 * H1) {
    const qs = new URLSearchParams({ category: 'linear', symbol, interval: '60', start: s, end: Math.min(Date.now(), s + 1000 * H1 - 1) });
    fresh.push(...(await ctx_.apiJson('/api/klines?' + qs)).candles);
  }
  const all = [...new Map([...have, ...fresh].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t).filter(c => c.t + H1 <= Date.now());
  idbSet(key, all).catch(() => {});
  return all;
}

// ---- shared bits ----
// A+ gets a gold star; the others a small letter
const GRADES = ['A+', 'A', 'B', 'C'];
const gradeKey = g => 'g-' + (g === 'A+' ? 'aplus' : g.toLowerCase());
const gradeLabel = g => (g === 'A+' ? '★ A+' : g);
const gradeChip = s => {
  if (!s.grade) return null;
  const g = s.grade.grade, chip = el('span', 'sig-grade ' + gradeKey(g), gradeLabel(g));
  chip.title = `Grade ${g}: ${s.grade.why}`;
  return chip;
};
const pctS = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(2) + '%');
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const coin = s => s.replace(/USDT$/, '');
const rText = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
// Bybit's standard fees, in R: a market entry at the close, a limit order at the
// target, a stop-market at the stop. Tight stops make fees a big share of 1R.
const TAKER = 0.00055, MAKER = 0.0002;
const afterFees = t => t.R - (TAKER + (t.result === 'win' ? MAKER : TAKER)) / t.riskPct;
// 4h candles close on the hour, so no minutes: "Nov 3, 8 PM"
const closeTime = t => new Date(t + H4).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
const ago = t => { const h = (Date.now() - (t + H4)) / 3_600_000; return h < 1 ? 'just now' : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
const trendChip = s => el('span', 'sig-trend ' + (s.trend || 'none'), s.trend ? TREND[s.trend] : 'BTC ?');
// the 24h result once there is one, otherwise how it's doing so far
// the trade's result in R: won, stopped, or where it stands while open
const result = s => {
  const t = s.trade;
  if (!t) return { label: 'no target', v: null };
  if (t.result === 'win') return { label: 'target hit', v: t.R };
  if (t.result === 'loss') return { label: 'stopped', v: -1 };
  return { label: t.exitT === null && t.R === 0 ? 'new' : 'open', v: t.R === 0 ? null : t.R };
};
const open = (s, list) => showOnChart(s, list);

// ---- dashboard widget: the latest few ----
// three beside the open positions, six when they have the row to themselves
const latestCount = () => ($('#posCard').hidden && innerWidth > 560 ? 6 : 3);
export async function renderSignalsWidget(ctx) {
  const box = $('#sigLatest');
  if (!box.childElementCount) box.replaceChildren(...Array.from({ length: latestCount() }, (_, i) => {
    const sk = el('div', 'sig-tile sig-skel'); sk.style.setProperty('--i', i);
    sk.append(el('i', 'w60'), el('i', 'w80'), el('i', 'w40'));
    return sk;
  }));
  let r;
  try { r = await loadSignals(ctx, 14); }
  catch (e) { box.replaceChildren(el('p', 'muted small', `Couldn’t load signals: ${e.message}`)); return; }
  const list = r.signals.slice(0, latestCount());
  
  if (!list.length) { box.replaceChildren(el('p', 'muted small', 'No signals in the last 2 weeks.')); return; }
  box.replaceChildren(...list.map((s, i) => {
    const b = el('button', 'sig-tile sig-in' + (s.grade ? ' tile-' + gradeKey(s.grade.grade) : '')); b.style.setProperty('--i', i); b.type = 'button'; b.title = 'Open on the 4h chart';
    const short = s.side === 'Short';
    const res = result(s);
    // ▲ ONDO long        +1.33%
    // Nov 3, 08:00 PM · 2h ago
    // [Countertrend]      so far
    const top = el('div', 'sig-top');
    top.append(...[el('b', short ? 'neg' : 'pos', `${short ? '▼' : '▲'} ${coin(s.symbol)}`), el('span', 'muted', short ? 'short' : 'long'), gradeChip(s),
      el('span', 'sig-res ' + cls(res.v), res.v === null ? '' : rText(res.v))].filter(Boolean));
    const mid = el('div', 'sig-mid');
    mid.append(el('span', 'muted small', `${closeTime(s.t)} · ${ago(s.t)}`));
    const bot = el('div', 'sig-bot');
    bot.append(trendChip(s), el('span', 'muted small', res.label));
    b.append(top, mid, bot);
    b.onclick = () => open(s, list);
    return b;
  }));
}

// ---- Signals tab ----
const tab = { days: 365, pair: 'all', side: 'all', trend: 'all', grades: new Set(GRADES), shown: 100, wired: false, data: null, busy: false };
const GRADE_KEY = 'perp-dojo:signal-grades';
try { const g = JSON.parse(localStorage.getItem(GRADE_KEY) || 'null'); if (Array.isArray(g)) tab.grades = new Set(g.filter(x => GRADES.includes(x))); } catch {}
// a signal without a grade (the NY bias couldn't be read) shows only when every grade is ticked
const gradeOk = s => (s.grade ? tab.grades.has(s.grade.grade) : tab.grades.size === GRADES.length);

export function renderSignalsView(ctx) {
  bindCharts(ctx);
  tab.ctx = ctx;
  if (!tab.wired) {
    tab.wired = true;
    $('#sigPeriod').onchange = e => { tab.days = Number(e.target.value); tab.shown = 100; load(ctx); };
    $('#sigRefresh').onclick = () => { held = null; load(ctx); };
    for (const [id, k] of [['#sigPair', 'pair'], ['#sigSide', 'side'], ['#sigTrendF', 'trend']])
      $(id).onchange = e => { tab[k] = e.target.value; tab.shown = 100; paint(); };
    $('#sigGradeF').replaceChildren(...GRADES.map(g => {
      const lab = el('label', 'grade-check'), box = el('input'); box.type = 'checkbox'; box.value = g; box.checked = tab.grades.has(g);
      box.onchange = () => {
        box.checked ? tab.grades.add(g) : tab.grades.delete(g);
        try { localStorage.setItem(GRADE_KEY, JSON.stringify([...tab.grades])); } catch {}
        tab.shown = 100; paint();
      };
      lab.append(box, el('span', 'sig-grade ' + gradeKey(g), gradeLabel(g)));
      lab.title = { 'A+': 'With the NY bias, outside the NY session, and BTC swept the same way', A: 'With the NY bias outside the session (or with a BTC sweep during it)', B: 'With the NY bias, but during the NY session', C: 'Against the NY bias' }[g];
      return lab;
    }));
    const pf = $('#sigPair');
    pf.replaceChildren(el('option', '', 'All pairs'), ...PAIRS.map(p => { const o = el('option', '', coin(p)); o.value = p; return o; }));
    pf.firstChild.value = 'all';
  }
  $('#sigPeriod').value = String(tab.days);
  if (tab.data && tab.data.days === tab.days && Math.floor(tab.data.at / H4) === Math.floor(Date.now() / H4)) paint();
  else load(ctx);
}

async function load(ctx) {
  if (tab.busy) return;
  tab.busy = true;
  const status = $('#sigStatus');
  status.textContent = '';
  const loader = $('#sigLoader'), results = $('#sigResults');
  loader.hidden = false; results.hidden = true;
  const chips = new Map(PAIRS.map((p, i) => { const c = el('span', 'sig-chip wait', coin(p)); c.style.setProperty('--i', i); return [p, c]; }));
  $('#sigLoadPairs').replaceChildren(...chips.values());
  const paintLoader = () => {
    let done = 0;
    for (const [p, st] of progress.pairs) { const c = chips.get(p); if (!c) continue; if (st !== 'wait') done++; if (!c.classList.contains(st)) c.className = 'sig-chip ' + st; }
    const share = progress.stage === 'btc' || progress.stage === 'done' ? 1 : done / PAIRS.length;
    $('#sigLoadBar').style.setProperty('--w', (share * 100).toFixed(1) + '%');
    $('#sigLoadCount').textContent = progress.stage === 'btc' ? 'Checking BTC’s 4h trend…' : `${done} of ${PAIRS.length} pairs`;
  };
  progress.subs.add(paintLoader); paintLoader();
  try {
    tab.data = await loadSignals(ctx, tab.days);
    status.textContent = `Updated ${new Date(tab.data.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` +
      (tab.data.errors.length ? ` · couldn’t read ${tab.data.errors.map(coin).join(', ')}` : '');
    paintLoader();
    await new Promise(r => setTimeout(r, 350));                     // let the bar finish before the results come in
    loader.hidden = true; results.hidden = false;
    results.classList.remove('sig-reveal'); void results.offsetWidth; results.classList.add('sig-reveal');
    paint();
  } catch (e) { loader.hidden = true; status.textContent = `Couldn’t load signals: ${e.message}`; }
  finally { progress.subs.delete(paintLoader); tab.busy = false; }
}

function stats(list) {
  const done = list.map(s => s.trade).filter(t => t && t.result !== 'open');
  const wins = done.filter(t => t.result === 'win').length;
  const gross = done.reduce((n, t) => n + t.R, 0), net = done.reduce((n, t) => n + afterFees(t), 0);
  return { n: list.length, done: done.length, win: done.length ? wins / done.length : null, avg: done.length ? gross / done.length : null, net: done.length ? net / done.length : null, total: net };
}

function paint() {
  const all = tab.data.signals;
  const base = all.filter(s => (tab.pair === 'all' || s.symbol === tab.pair) && (tab.side === 'all' || s.side === tab.side) && (tab.trend === 'all' || s.trend === tab.trend));
  const list = base.filter(gradeOk);

  // summary: everything shown, then split by BTC trend
  // each card: average R per trade after fees, then the count, win rate and the figure before fees
  const card = (title, st) => {
    const d = el('div', 'card'), sub = el('small', 'muted');
    if (st.win === null) sub.textContent = `${st.n.toLocaleString()} signals · no closed trades yet`;
    else sub.textContent = `a trade after fees · ${st.done.toLocaleString()} trades · ${Math.round(st.win * 100)}% won · ${rText(st.avg)} before fees · ${rText(st.total).replace(/\.\d+R/, 'R')} total`;
    d.append(el('dt', '', title), el('dd', cls(st.net), st.net === null ? '—' : rText(st.net)), sub);
    return d;
  };
  const perDay = list.length ? list.length / tab.days : 0;
  // one card per grade (within the other filters), then the shown list split by trend and side
  const gradeCard = g => { const d = card(`Grade ${g}`, stats(base.filter(s => s.grade?.grade === g))); d.classList.add('grade-card', gradeKey(g)); d.classList.toggle('off', !tab.grades.has(g)); return d; };
  $('#sigSummary').replaceChildren(
    ...GRADES.map(gradeCard),
    card('Signals', stats(list)),
    card('Aligned with BTC', stats(list.filter(s => s.trend === 'aligned'))),
    card('Countertrend', stats(list.filter(s => s.trend === 'counter'))),
    card('BTC neutral', stats(list.filter(s => s.trend === 'neutral'))),
    card('Longs', stats(list.filter(s => s.side === 'Long'))),
    card('Shorts', stats(list.filter(s => s.side === 'Short'))),
  );
  $('#sigCount').textContent = `${list.length.toLocaleString()} signal${list.length === 1 ? '' : 's'} · about ${perDay.toFixed(1)} a day · newest first`;

  const t = $('#sigTable'); t.replaceChildren();
  const head = el('tr');
  for (const [h, num] of [['4h close', 0], ['Pair', 0], ['Side', 0], ['Grade', 0], ['Level', 0], ['Entry', 1], ['Stop', 1], ['Target', 1], ['R:R', 1], ['BTC trend', 0], ['Result', 1], ['After fees', 1]]) head.append(el('th', num ? 'num' : '', h));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const s of list.slice(0, tab.shown)) {
    const tr = el('tr', 'replayable'); tr.tabIndex = 0; tr.title = 'Show on the 4h chart';
    const tc = el('td'); tc.append(trendChip(s));
    const gc = el('td'); const chip = gradeChip(s); if (chip) gc.append(chip); else gc.textContent = '—';
    const t = s.trade, f = tab.ctx.fmt.price;
    const res = !t ? '—' : t.result === 'win' ? `✓ ${rText(t.R)}` : t.result === 'loss' ? '✗ −1R' : t.R === 0 ? 'new' : `open ${rText(t.R)}`;
    tr.append(
      el('td', '', closeTime(s.t)), el('td', '', coin(s.symbol)), el('td', 'side-' + s.side.toLowerCase(), s.side), gc,
      el('td', '', s.levels.map(l => f(l.price)).join(', ')),
      el('td', 'num', f(s.close)), el('td', 'num', t ? f(t.sl) : '—'), el('td', 'num', t ? f(t.tp) : '—'),
      el('td', 'num', t ? t.rr.toFixed(1) : '—'), tc,
      el('td', 'num ' + (t && t.result !== 'open' ? cls(t.R) : ''), res),
      el('td', 'num ' + (t && t.result !== 'open' ? cls(afterFees(t)) : ''), t && t.result !== 'open' ? rText(afterFees(t)) : ''),
    );
    const go = () => open(s, list);
    tr.onclick = go; tr.onkeydown = e => { if (e.key === 'Enter') go(); };
    body.append(tr);
  }
  t.append(thead, body);
  const more = $('#sigMore');
  more.hidden = list.length <= tab.shown;
  more.textContent = `Show ${Math.min(100, list.length - tab.shown)} more of ${list.length - tab.shown}`;
  more.onclick = () => { tab.shown += 100; paint(); };
}

// ---- Analytics: the six 4h closes ----
// For each close (in local time): the year's A/A+ signals as expected results,
// per weekday as a heatmap, and the user's own trades grouped by the close they
// opened after. Expected R is the single entry after fees; the scaling plan
// adds to it on winners.
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const localDay = t => (new Date(t).getDay() + 6) % 7;                         // Mon = 0
const hourLabel = h => `${String(h).padStart(2, '0')}:00`;
export async function renderCloseBreakdown(ctx, root, trades, fmtMoney) {
  let data;
  try { data = await loadSignals(ctx, 365); }
  catch (e) { root.replaceChildren(el('p', 'muted small', `Couldn’t load signals: ${e.message}`)); return; }
  const good = data.signals.filter(s => s.grade && (s.grade.grade === 'A' || s.grade.grade === 'A+') && s.trade && s.trade.result !== 'open');
  const span = Math.max(1, (Date.now() - Math.min(...data.signals.map(s => s.t))) / (7 * DAY));   // weeks covered
  const at = s => new Date(s.t + H4).getHours();
  const hours = [...new Set(data.signals.map(at))].sort((a, b) => a - b);
  const stat = xs => {
    if (!xs.length) return null;
    const R = xs.map(s => afterFees(s.trade)), wins = xs.filter(s => s.trade.result === 'win').length;
    const sorted = [...R].sort((a, b) => b - a), trim = sorted.slice(Math.min(3, Math.floor(R.length / 10)));
    return { n: xs.length, win: wins / xs.length, avg: R.reduce((a, b) => a + b, 0) / R.length, total: R.reduce((a, b) => a + b, 0), trimmed: trim.reduce((a, b) => a + b, 0) / trim.length };
  };
  // the user's trades, by the 4h close they opened after
  const mine = new Map();
  for (const t of trades) {
    if (!Number.isFinite(t.openedAt)) continue;
    const h = new Date(Math.floor(t.openedAt / H4) * H4).getHours();
    const m = mine.get(h) || { n: 0, wins: 0, pnl: 0 }; m.n++; if (t.pnl > 0) m.wins++; m.pnl += t.pnl; mine.set(h, m);
  }

  // the table
  const table = el('table', 'data close-table');
  const head = el('tr');
  for (const [h, num] of [['Close', 0], ['A/A+ a year', 1], ['A week', 1], ['Hit target', 1], ['Avg R', 1], ['Without its outliers', 1], ['Expected R a week', 1], ['Verdict', 0], ['Your trades', 1], ['Your win rate', 1], ['Your P&L', 1]]) head.append(el('th', num ? 'num' : '', h));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const h of hours) {
    const st = stat(good.filter(s => at(s) === h)), m = mine.get(h);
    const week = st ? st.n / span : 0, exp = st ? week * st.avg : null;
    // the verdict: positive even without the biggest winners, positive only because of them, or negative
    const verdict = !st || st.n < 15 ? ['Too few', 'muted'] : st.avg > 0.15 && st.trimmed > 0 ? ['Trade it', 'pos'] : st.avg > 0 ? ['Outliers only', 'warn'] : ['Skip', 'neg'];
    const tr = el('tr', h >= 8 && h <= 16 ? 'in-hours' : '');
    const v = el('td'); v.append(el('span', 'close-verdict ' + verdict[1], verdict[0]));
    tr.append(
      el('td', '', hourLabel(h) + (h >= 8 && h <= 16 ? ' ·' : '')),
      el('td', 'num', st ? String(st.n) : '0'), el('td', 'num', st ? week.toFixed(1) : '—'),
      el('td', 'num', st ? Math.round(st.win * 100) + '%' : '—'),
      el('td', 'num ' + (st ? cls(st.avg) : ''), st ? rText(st.avg) : '—'),
      el('td', 'num ' + (st ? cls(st.trimmed) : ''), st ? rText(st.trimmed) : '—'),
      el('td', 'num ' + (exp !== null ? cls(exp) : ''), exp !== null ? rText(exp) : '—'), v,
      el('td', 'num', m ? String(m.n) : '—'), el('td', 'num', m ? Math.round(m.wins / m.n * 100) + '%' : '—'),
      el('td', 'num ' + (m ? cls(m.pnl) : ''), m ? fmtMoney(m.pnl) : '—'),
    );
    body.append(tr);
  }
  table.append(thead, body);
  const wrap = el('div', 'table-wrap'); wrap.append(table);

  // the heatmap: avg R by close and weekday
  const grid = el('div', 'close-grid');
  grid.append(el('span', 'cg-corner', ''), ...DAYS_SHORT.map(d => el('span', 'cg-day', d)));
  const cells = [];
  for (const h of hours) {
    grid.append(el('span', 'cg-hour', hourLabel(h)));
    for (let d = 0; d < 7; d++) {
      const st = stat(good.filter(s => at(s) === h && localDay(s.t + H4) === d));
      const c = el('span', 'cg-cell' + (st && st.n < 8 ? ' thin' : ''));
      if (st) {
        const k = Math.max(-1, Math.min(1, st.avg / 2));
        c.style.setProperty('--k', Math.abs(k).toFixed(2));
        c.classList.add(k >= 0 ? 'pos' : 'neg');
        c.append(el('b', '', rText(st.avg).replace(/(\.\d)\d/, '$1')), el('small', '', `${st.n}`));
        c.title = `${DAYS_SHORT[d]} ${hourLabel(h)} close: ${st.n} A/A+ trades, ${Math.round(st.win * 100)}% hit target, ${rText(st.avg)} avg after fees`;
      } else c.append(el('small', '', '—'));
      cells.push(c); grid.append(c);
    }
  }
  const note = el('p', 'muted small close-note', `Times are your local time; · marks your trading day (08:00–16:00). “Without its outliers” drops the best few trades, so a close that only looks good because of one huge winner shows up. Expected R a week = A/A+ setups a week × avg R. In the grid, faded cells have under 8 trades. Your trades are grouped by the 4h candle they were opened in.`);
  root.replaceChildren(wrap, el('h3', 'close-sub', 'By weekday'), grid, note);
}
