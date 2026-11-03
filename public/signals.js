// Signals: every 4h swing failure signal on the default pairs, with the same
// rules and filters as the Telegram alerts (sfp.js ALERT_SETTINGS), so the
// site and the bot always agree. The Signals tab lists them all; the dashboard
// shows the latest 24. Candles come from the scanner's IndexedDB cache.
import { detect, H4, ALERT_SETTINGS, DEFAULT_PAIRS, trendMap, btcSide } from './sfp.js';
import { candlesFor, pool, showOnChart, bindScanner } from './scanner.js';

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
export function loadSignals(ctx, days) {
  bindScanner(ctx);
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
  const signals = per.flat().map(s => {
    const trend = btcSide(s, trends, o.neutralBand);
    return { ...s, trend, counter: trend === 'counter', btc: trends.get(s.t - H4) || null };
  }).sort((a, b) => b.t - a.t || a.symbol.localeCompare(b.symbol));
  progress.stage = 'done'; notify();
  return { signals, errors, at: Date.now(), days };
}

// ---- shared bits ----
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
    const b = el('button', 'sig-tile sig-in'); b.style.setProperty('--i', i); b.type = 'button'; b.title = 'Open on the 4h chart';
    const short = s.side === 'Short';
    const res = result(s);
    // ▲ ONDO long        +1.33%
    // Nov 3, 08:00 PM · 2h ago
    // [Countertrend]      so far
    const top = el('div', 'sig-top');
    top.append(el('b', short ? 'neg' : 'pos', `${short ? '▼' : '▲'} ${coin(s.symbol)}`), el('span', 'muted', short ? 'short' : 'long'),
      el('span', 'sig-res ' + cls(res.v), res.v === null ? '' : rText(res.v)));
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
const tab = { days: 365, pair: 'all', side: 'all', trend: 'all', shown: 100, wired: false, data: null, busy: false };

export function renderSignalsView(ctx) {
  bindScanner(ctx);
  tab.ctx = ctx;
  if (!tab.wired) {
    tab.wired = true;
    $('#sigPeriod').onchange = e => { tab.days = Number(e.target.value); tab.shown = 100; load(ctx); };
    $('#sigRefresh').onclick = () => { held = null; load(ctx); };
    for (const [id, k] of [['#sigPair', 'pair'], ['#sigSide', 'side'], ['#sigTrendF', 'trend']])
      $(id).onchange = e => { tab[k] = e.target.value; tab.shown = 100; paint(); };
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
  const list = all.filter(s => (tab.pair === 'all' || s.symbol === tab.pair) && (tab.side === 'all' || s.side === tab.side) && (tab.trend === 'all' || s.trend === tab.trend));

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
  $('#sigSummary').replaceChildren(
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
  for (const [h, num] of [['4h close', 0], ['Pair', 0], ['Side', 0], ['Level', 0], ['Entry', 1], ['Stop', 1], ['Target', 1], ['R:R', 1], ['BTC trend', 0], ['Result', 1], ['After fees', 1]]) head.append(el('th', num ? 'num' : '', h));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const s of list.slice(0, tab.shown)) {
    const tr = el('tr', 'replayable'); tr.tabIndex = 0; tr.title = 'Show on the 4h chart';
    const tc = el('td'); tc.append(trendChip(s));
    const t = s.trade, f = tab.ctx.fmt.price;
    const res = !t ? '—' : t.result === 'win' ? `✓ ${rText(t.R)}` : t.result === 'loss' ? '✗ −1R' : t.R === 0 ? 'new' : `open ${rText(t.R)}`;
    tr.append(
      el('td', '', closeTime(s.t)), el('td', '', coin(s.symbol)), el('td', 'side-' + s.side.toLowerCase(), s.side),
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
