// SFP scanner (beta): backtests the 4h swing failure rules in sfp.js across a
// list of pairs, from Bybit's public candles. Candles are kept in IndexedDB,
// so a re-run only fetches what has closed since.
import { scalePlan, detect, closedOnly, H4, SFP_DEFAULTS, BTC_DEFAULTS, SMT_WINDOWS, M15, trendMap, counterTrend, smt, DEFAULT_PAIRS, OLD_DEFAULT_PAIRS, ADDED_PAIRS, PRESETS, signalsIf, holdLine } from './sfp.js';
import { idbGet, idbSet } from './db.js';
import { loadLib, css, local, entryColor, decimals } from './replay.js';

const DAY = 86_400_000;
const DEFAULTS = { pairs: DEFAULT_PAIRS, period: 90, ...SFP_DEFAULTS, ...BTC_DEFAULTS, ...PRESETS.balanced };
const KEY = 'perp-report:sfp';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Saved settings carry a version; when the defaults change on purpose, older
// saves get the new rule (v2: one signal per level, no SMT requirement;
// v3: the full watchlist, if the pairs were still the first default list;
// v4: a 0.2% minimum sweep, so a wick that barely touches a level doesn't use it up).
const VERSION = 7;
const load = () => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  if ((saved.v || 1) < 2) { saved.once = true; saved.requireSmt = false; }
  if ((saved.v || 1) < 3 && (!saved.pairs || saved.pairs.trim() === OLD_DEFAULT_PAIRS)) saved.pairs = DEFAULT_PAIRS;
  if ((saved.v || 1) < 4) saved.minSweep = PRESETS.balanced.minSweep;
  if ((saved.v || 1) < 5 && (saved.lookbackDays ?? 30) === 30) saved.lookbackDays = DEFAULTS.lookbackDays;   // 30 → 90 days, so older levels count
  if ((saved.v || 1) < 6 && saved.minSweep === 0.002) saved.minSweep = PRESETS.balanced.minSweep;   // 0.2% → 0.1%: a tiny wick still counts
  if ((saved.v || 1) < 7 && saved.pairs) {
    const have = new Set(saved.pairs.toUpperCase().split(/[\s,$]+/).map(x => x.replace(/USDT$/, '')));
    const add = ADDED_PAIRS.filter(x => !have.has(x));
    if (add.length) saved.pairs = saved.pairs.trim() + ' ' + add.join(' ');
  }
  const s = { ...DEFAULTS, ...saved, v: VERSION };
  save(s);
  return s;
};
const save = s => { try { localStorage.setItem(KEY, JSON.stringify({ ...s, v: VERSION })); } catch {} };
const symbolsOf = text => [...new Set(text.toUpperCase().split(/[\s,$]+/).filter(Boolean).map(x => (/(USDT|USDC|PERP)$/.test(x) ? x : x + 'USDT')))];

let ctx = null, settings = load(), result = null, busy = false, wired = false;
const view = { pair: 'all', side: 'all', shown: 100, chartPair: null, levels: true };

// Other views (Signals) reuse the candle cache and the chart window.
export const bindScanner = c => { if (!ctx) ctx = c; };

export function renderScanner(c) {
  ctx = c;
  if (!wired) wire();
  paintSettings();
  if (result) paintResults();
  paintNextClose();
  checkForming();
}

function wire() {
  wired = true;
  $('#sfpRun').onclick = run;
  for (const b of document.querySelectorAll('[data-sfp-preset]')) b.onclick = () => {
    settings = { ...settings, ...PRESETS[b.dataset.sfpPreset] }; save(settings); paintSettings();
  };
  $('#sfpReset').onclick = () => { settings = { ...DEFAULTS, pairs: settings.pairs }; save(settings); paintSettings(); };
  const read = () => {
    settings = {
      pairs: $('#sfpPairs').value, period: Number($('#sfpPeriod').value),
      right: clamp($('#sfpRight').value, 1, 20, DEFAULTS.right), left: clamp($('#sfpLeft').value, 0, 20, DEFAULTS.left),
      minAge: clamp($('#sfpMinAge').value, 0, 100, DEFAULTS.minAge),
      minSweep: Math.min(5, Math.max(0, Number($('#sfpMinSweep').value) || 0)) / 100,
      lookbackDays: clamp($('#sfpLookback').value, 1, 120, DEFAULTS.lookbackDays),
      breakOnClose: $('#sfpBreak').checked, once: $('#sfpOnce').checked,
      edge: clamp($('#sfpEdge').value, 0, 50, DEFAULTS.edge * 100) / 100, rangeDays: clamp($('#sfpRangeDays').value, 1, 60, DEFAULTS.rangeDays), outermost: $('#sfpOutermost').checked,
      requireSmt: $('#sfpSmt').checked, trendEma: clamp($('#sfpEma').value, 5, 200, DEFAULTS.trendEma), smtRef: $('#sfpSmtRef').value === 'any' ? 'any' : Number($('#sfpSmtRef').value), smtType: $('#sfpSmtType').value,
      neutralBand: clamp(Number($('#sfpBand').value) * 10, 0, 50, DEFAULTS.neutralBand * 1000) / 1000,
    };
    save(settings);
  };
  for (const id of ['#sfpPairs', '#sfpPeriod', '#sfpRight', '#sfpLeft', '#sfpMinAge', '#sfpMinSweep', '#sfpLookback', '#sfpBreak', '#sfpOnce', '#sfpEdge', '#sfpRangeDays', '#sfpOutermost', '#sfpSmt', '#sfpEma', '#sfpSmtRef', '#sfpSmtType', '#sfpBand']) $(id).addEventListener('change', read);
  $('#sfpPairFilter').onchange = e => { view.pair = e.target.value; view.shown = 100; paintSignals(); if (view.pair !== 'all') { view.chartPair = view.pair; paintChart(); } };
  $('#sfpSideFilter').onchange = e => { view.side = e.target.value; view.shown = 100; paintSignals(); };
  $('#sfpChartPair').onchange = e => { view.chartPair = e.target.value; paintChart(); };
  $('#sfpChartLevels').onchange = e => { view.levels = e.target.checked; paintChart(); };
  setInterval(() => { if (!$('#view-scanner').hidden) paintNextClose(); }, 1000);
  setInterval(() => { if (!$('#view-scanner').hidden && !document.hidden) checkForming(); }, 60_000);
  $('#sfpFormCheck').onclick = () => checkForming(true);
}
const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function paintSettings() {
  $('#sfpPairs').value = settings.pairs;
  $('#sfpPeriod').value = String(settings.period);
  $('#sfpRight').value = settings.right;
  $('#sfpLeft').value = settings.left;
  $('#sfpMinAge').value = settings.minAge;
  $('#sfpMinSweep').value = +(settings.minSweep * 100).toFixed(2);
  $('#sfpLookback').value = settings.lookbackDays;
  $('#sfpBreak').checked = settings.breakOnClose;
  $('#sfpOnce').checked = settings.once;
  $('#sfpEdge').value = Math.round(settings.edge * 100);
  $('#sfpRangeDays').value = settings.rangeDays;
  $('#sfpOutermost').checked = settings.outermost;
  $('#sfpSmt').checked = settings.requireSmt;
  $('#sfpEma').value = settings.trendEma;
  $('#sfpSmtRef').value = String(settings.smtRef);
  $('#sfpBand').value = +(settings.neutralBand * 100).toFixed(1);
  for (const b of document.querySelectorAll('[data-sfp-preset]')) {
    const p = PRESETS[b.dataset.sfpPreset];
    b.setAttribute('aria-pressed', String(Object.entries(p).every(([k, v]) => settings[k] === v)));
  }
  $('#sfpSmtType').value = settings.smtType;
}

// ---- candles ----

// Closed 4h candles from `start` to now, from the cache plus whatever is new.
export async function candlesFor(symbol, start) {
  const key = `sfp4h:linear:${symbol}`;
  let have = (await idbGet(key).catch(() => null)) || [];
  if (have.length && have[0].t > start) have = [];               // need older history than cached
  const from = have.length ? have[have.length - 1].t + H4 : Math.floor(start / H4) * H4;
  const fresh = [];
  for (let s = from; s < Date.now(); s += 1000 * H4) {
    const e = Math.min(Date.now(), s + 1000 * H4 - 1);
    const qs = new URLSearchParams({ category: 'linear', symbol, interval: '240', start: s, end: e });
    const { candles } = await ctx.apiJson('/api/klines?' + qs);
    fresh.push(...candles);
  }
  const byT = new Map([...have, ...fresh].map(c => [c.t, c]));
  const all = closedOnly([...byT.values()].sort((a, b) => a.t - b.t));
  idbSet(key, all).catch(() => {});
  return all;
}

// 15m candles from `start` to `end`, for the SMT check.
async function m15(symbol, start, end) {
  const key = `sfp15:linear:${symbol}:${start}:${end}`;
  const settled = end < Date.now() - M15;
  if (settled) { const hit = await idbGet(key).catch(() => null); if (hit) return hit; }
  const qs = new URLSearchParams({ category: 'linear', symbol, interval: '15', start, end });
  const { candles } = await ctx.apiJson('/api/klines?' + qs);
  const closed = closedOnly(candles, Date.now(), M15);
  if (settled && closed.length) idbSet(key, closed).catch(() => {});
  return closed;
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function run() {
  if (busy) return;
  busy = true;
  const btn = $('#sfpRun'); btn.disabled = true;
  const status = $('#sfpStatus');
  const symbols = symbolsOf(settings.pairs);
  const since = Date.now() - settings.period * DAY;
  const start = since - (settings.lookbackDays + 5) * DAY;      // history for the levels live at the start
  let done = 0;
  status.textContent = `Fetching 4h candles for ${symbols.length} pairs…`;
  const errors = [];
  try {
    const perPair = await pool(symbols, 4, async symbol => {
      try {
        const candles = (await candlesFor(symbol, start)).filter(c => c.t >= start);
        const d = detect(candles, settings);
        status.textContent = `Fetched ${++done} of ${symbols.length} pairs…`;
        return { symbol, candles, ...d, signals: d.signals.filter(s => s.t >= since) };
      } catch (e) {
        errors.push(`${symbol}: ${e.message}`);
        status.textContent = `Fetched ${++done} of ${symbols.length} pairs…`;
        return null;
      }
    });
    const pairs = perPair.filter(Boolean);

    // BTC filter: every signal gets BTC's 4h trend; counter-trend ones need a 15m SMT
    status.textContent = 'Checking BTC’s 4h trend…';
    const btc4h = await candlesFor('BTCUSDT', start - 20 * DAY);
    const trends = trendMap(btc4h, settings.trendEma);
    const checks = [];
    for (const p of pairs) for (const sg of p.signals) {
      sg.btc = trends.get(sg.t) || null;
      sg.counter = p.symbol === 'BTCUSDT' ? false : counterTrend(sg, trends, settings.neutralBand);
      if (sg.counter && settings.requireSmt) checks.push({ p, sg });
    }
    let n = 0;
    const btcWindows = new Map();
    await pool(checks, 4, async ({ p, sg }) => {
      const refs = settings.smtRef === 'any' ? SMT_WINDOWS : [settings.smtRef];
      const a = sg.t - Math.max(...refs) * M15, b = sg.t + H4 - 1;
      try {
        if (!btcWindows.has(a)) btcWindows.set(a, m15('BTCUSDT', a, b));
        const [alt, btc] = await Promise.all([m15(p.symbol, a, b), btcWindows.get(a)]);
        // with 'any', the first window (shortest first) that shows a divergence
        const tries = refs.map(ref => ({ ref, ...smt(sg, alt, btc, { ref, type: settings.smtType }) }));
        sg.smt = tries.find(x => x.ok) || tries.find(x => x.ok === false) || tries[0];
      } catch (e) { sg.smt = { ok: null, error: e.message }; }
      status.textContent = `Checking 15m SMT against BTC: ${++n} of ${checks.length} counter-trend signals…`;
    });
    let dropped = 0;
    for (const p of pairs) {
      p.dropped = settings.requireSmt ? p.signals.filter(sg => sg.counter && sg.smt?.ok !== true) : [];
      dropped += p.dropped.length;
      if (settings.requireSmt) p.signals = p.signals.filter(sg => !(sg.counter && sg.smt?.ok !== true));
    }

    result = { pairs, since, at: Date.now(), settings: { ...settings }, dropped, counterChecked: checks.length };
    view.pair = 'all'; view.shown = 100;
    status.textContent = `Ran ${new Date(result.at).toLocaleTimeString()} over ${result.pairs.length} pairs, last ${settings.period} days.` +
      (settings.requireSmt ? ` ${checks.length} signals were counter to BTC’s 4h trend; ${dropped} had no 15m SMT and were dropped.` : '') +
      (errors.length ? ` Skipped: ${errors.join('; ')}` : '');
    paintResults();
  } finally { busy = false; btn.disabled = false; }
}

// ---- results ----

const pctS = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(2) + '%');
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const avg = (a, f) => { const v = a.map(f).filter(Number.isFinite); return v.length ? v.reduce((n, x) => n + x, 0) / v.length : null; };
const share = (a, f) => { const v = a.filter(x => f(x) !== null); return v.length ? v.filter(f).length / v.length : null; };
const when = t => new Date(t + H4).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function allSignals() {
  return result.pairs.flatMap(p => p.signals.map(s => ({ ...s, symbol: p.symbol }))).sort((a, b) => b.t - a.t);
}

function paintResults() {
  $('#sfpResults').hidden = false;
  const sigs = allSignals();
  const days = (Date.now() - result.since) / DAY;

  // the most recent closed 4h candle, across every pair
  const lastT = Math.max(...result.pairs.map(p => p.candles.at(-1)?.t ?? 0));
  const latest = sigs.filter(s => s.t === lastT);
  const box = $('#sfpLatest');
  box.replaceChildren(el('p', 'small', `Candle closed ${when(lastT)}: ` + (latest.length ? `${latest.length} signal${latest.length === 1 ? '' : 's'}.` : 'no signals on any pair.')));
  if (latest.length) box.append(signalList(latest));

  // headline numbers
  const hit1 = share(sigs, s => (s.best24h === null ? null : s.best24h >= 0.01));
  const rows = [
    ['Signals', sigs.length.toLocaleString(), `${(sigs.length / days).toFixed(1)} a day · ${sigs.filter(s => s.side === 'Short').length} short, ${sigs.filter(s => s.side === 'Long').length} long`],
    ['Avg move after 4h', pctS(avg(sigs, s => s.after4h)), 'in the signal’s direction'],
    ['Avg move after 24h', pctS(avg(sigs, s => s.after24h)), 'in the signal’s direction'],
    ['Reached +1% within 24h', hit1 === null ? '—' : Math.round(hit1 * 100) + '%', 'best point in your favor'],
    ['Avg worst point in 24h', pctS(avg(sigs, s => s.worst24h)), 'against you, from the signal close'],
  ];
  $('#sfpSummary').replaceChildren(...rows.map(([k, v, sub]) => { const d = el('div', 'card'); d.append(el('dt', '', k), el('dd', '', v), el('small', 'muted', sub)); return d; }));

  // per pair
  const pr = result.pairs.map(p => ({
    symbol: p.symbol, n: p.signals.length, shorts: p.signals.filter(s => s.side === 'Short').length, longs: p.signals.filter(s => s.side === 'Long').length,
    live: p.live.length, last: p.candles.at(-1)?.c ?? null,
    a24: avg(p.signals, s => s.after24h), hit: share(p.signals, s => (s.best24h === null ? null : s.best24h >= 0.01)),
  })).sort((a, b) => b.n - a.n);
  const t = $('#sfpPairTable'); t.replaceChildren();
  const head = el('tr'); for (const h of ['Pair', 'Signals', 'Short / long', 'Live levels now', 'Avg after 24h', 'Reached +1%']) head.append(el('th', h === 'Pair' ? '' : 'num', h));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const r of pr) {
    const tr = el('tr', 'replayable'); tr.tabIndex = 0;
    tr.append(el('td', '', r.symbol), el('td', 'num', String(r.n)), el('td', 'num', `${r.shorts} / ${r.longs}`), el('td', 'num', String(r.live)),
      el('td', 'num ' + cls(r.a24), pctS(r.a24)), el('td', 'num', r.hit === null ? '—' : Math.round(r.hit * 100) + '%'));
    const pick = () => { view.pair = r.symbol; view.chartPair = r.symbol; view.shown = 100; paintSignals(); paintChart(); $('#sfpTable').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    tr.onclick = pick; tr.onkeydown = e => { if (e.key === 'Enter') pick(); };
    body.append(tr);
  }
  t.append(thead, body);

  const pf = $('#sfpPairFilter');
  pf.replaceChildren(new Option('All pairs', 'all'), ...result.pairs.map(p => new Option(p.symbol, p.symbol)));
  paintSignals();
  if (!result.pairs.some(p => p.symbol === view.chartPair)) view.chartPair = pr[0]?.symbol ?? null;
  $('#sfpChartPair').replaceChildren(...result.pairs.map(p => new Option(`${p.symbol} · ${p.signals.length}`, p.symbol)));
  paintChart();
}

// ---- every signal for one pair on its 4h chart, with the levels' lifetimes ----
let chart = null;
async function paintChart() {
  const p = result?.pairs.find(x => x.symbol === view.chartPair);
  const box = $('#sfpChart'), note = $('#sfpChartNote');
  $('#sfpChartPair').value = view.chartPair ?? '';
  $('#sfpChartLevels').checked = view.levels;
  if (!p) return;
  const LW = await loadLib().catch(e => { note.textContent = e.message; return null; });
  if (!LW || p.symbol !== view.chartPair) return;
  chart?.remove(); chart = null; box.replaceChildren();

  const from = result.since - 3 * DAY;
  const cs = p.candles.filter(c => c.t >= from);
  if (!cs.length) { note.textContent = 'No candles for this pair.'; return; }
  const pos = css('--pos'), neg = css('--neg'), muted = css('--muted'), ink = css('--ink-2'), entryC = entryColor(pos, neg) || ink;
  chart = LW.createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: muted, fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') },
    timeScale: { borderColor: css('--axis'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: LW.CrosshairMode.Normal },
  });
  const dp = decimals(cs);
  const series = chart.addCandlestickSeries({ upColor: pos, downColor: neg, borderVisible: false, wickUpColor: pos, wickDownColor: neg, priceFormat: { type: 'price', precision: dp, minMove: 10 ** -dp } });
  series.setData(cs.map(c => ({ time: local(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));

  // levels as segments; the ones that produced a signal are solid
  // each line starts at its swing candle's body and runs until the level broke or expired
  const shownLevels = view.levels ? p.levels.filter(l => l.until >= from) : [];
  for (const l of shownLevels) {
    const line = chart.addLineSeries({ color: l.hits ? ink : muted, lineWidth: 1, lineStyle: l.hits ? LW.LineStyle.Solid : LW.LineStyle.Dotted,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: dp, minMove: 10 ** -dp } });
    line.setData([{ time: local(Math.max(l.t, from)), value: l.price }, { time: local(l.until), value: l.price }]);
  }

  // arrows by direction: shorts down in the loss color, longs up in the gain color
  const marks = p.signals.map(s => ({ time: local(s.t), position: s.side === 'Short' ? 'aboveBar' : 'belowBar', shape: s.side === 'Short' ? 'arrowDown' : 'arrowUp', color: s.side === 'Short' ? neg : pos, size: 1.2, s }));
  series.setMarkers(marks.map(({ s, ...m }) => m));

  const tip = document.createElement('div');
  tip.className = 'replay-tip'; tip.hidden = true;
  box.append(tip);
  const at = time => marks.filter(m => m.time === time);
  chart.subscribeCrosshairMove(e => {
    const hit = e.point && e.time !== undefined && at(e.time);
    if (!hit?.length) { tip.hidden = true; box.style.cursor = ''; return; }
    box.style.cursor = 'pointer';
    tip.replaceChildren(...hit.flatMap(({ s, color }) => {
      const h = el('b', '', `SFP ${s.side.toLowerCase()} · ${when(s.t)}`); h.style.color = color;
      return [h, el('span', '', `Failed at ${s.levels.map(l => ctx.fmt.price(l.price)).join(', ')} · close ${ctx.fmt.price(s.close)}`),
        el('span', '', s.after24h === null ? 'Too recent for a 24h result' : `After 24h ${pctS(s.after24h)} · best ${pctS(s.best24h)} · worst ${pctS(s.worst24h)}`)];
    }));
    tip.hidden = false;
    const x = e.point.x + 14 + tip.offsetWidth > box.clientWidth - 70 ? e.point.x - 14 - tip.offsetWidth : e.point.x + 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, Math.min(e.point.y - tip.offsetHeight / 2, box.clientHeight - tip.offsetHeight - 30)) + 'px';
  });
  chart.subscribeClick(e => {
    const hit = e.time !== undefined && at(e.time);
    if (!hit?.length) return;
    // open it in the signal view, stepping through this pair's signals newest first
    const list = p.signals.map(x => ({ ...x, symbol: p.symbol })).sort((a, b) => b.t - a.t);
    showOnChart(list.find(x => x.t === hit[0].s.t && x.side === hit[0].s.side), list);
  });
  chart.timeScale().fitContent();

  const good = p.signals.filter(s => s.after24h > 0).length, bad = p.signals.filter(s => s.after24h < 0).length;
  note.textContent = `${p.symbol}: ${p.signals.length} signals (${p.signals.filter(s => s.side === 'Short').length} short, ${p.signals.filter(s => s.side === 'Long').length} long). ` +
    `${good} moved your way over 24h, ${bad} didn't.` + (view.levels ? ` ${shownLevels.length} levels drawn, ${shownLevels.filter(l => l.hits).length} of them produced a signal.` : '') + ' Scroll to zoom, drag to pan.';
}

function paintSignals() {
  const pf = $('#sfpPairFilter'); pf.value = view.pair;
  $('#sfpSideFilter').value = view.side;
  const sigs = allSignals().filter(s => (view.pair === 'all' || s.symbol === view.pair) && (view.side === 'all' || s.side === view.side));
  $('#sfpCount').textContent = `${sigs.length.toLocaleString()} signal${sigs.length === 1 ? '' : 's'}, newest first`;
  const t = $('#sfpTable'); t.replaceChildren();
  const head = el('tr');
  for (const [h, num] of [['4h close', 0], ['Pair', 0], ['Side', 0], ['Levels failed at', 0], ['In range', 1], ['BTC 4h', 0], ['Wick past', 1], ['Close', 1], ['After 4h', 1], ['After 12h', 1], ['After 24h', 1], ['Best / worst in 24h', 1]]) head.append(el('th', num ? 'num' : '', h));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const s of sigs.slice(0, view.shown)) {
    const tr = el('tr', 'replayable'); tr.tabIndex = 0; tr.title = 'Show on the 4h chart';
    const lv = s.levels.map(l => ctx.fmt.price(l.price)).join(', ');
    tr.append(
      el('td', '', when(s.t)), el('td', '', s.symbol), el('td', 'side-' + s.side.toLowerCase(), s.side),
      el('td', '', s.levels.length > 1 ? `${s.levels.length}: ${lv}` : lv),
      el('td', 'num', rangeText(s)),
      el('td', s.counter ? 'counter' : '', btcText(s)),
      el('td', 'num', pctS(s.sweepPct).replace('+', '')), el('td', 'num', ctx.fmt.price(s.close)),
      el('td', 'num ' + cls(s.after4h), pctS(s.after4h)), el('td', 'num ' + cls(s.after12h), pctS(s.after12h)), el('td', 'num ' + cls(s.after24h), pctS(s.after24h)),
      el('td', 'num', s.best24h === null ? 'still open' : `${pctS(s.best24h)} / ${pctS(s.worst24h)}`),
    );
    const open = () => showOnChart(s, sigs);
    tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); };
    body.append(tr);
  }
  t.append(thead, body);
  const more = $('#sfpMore');
  more.hidden = sigs.length <= view.shown;
  more.textContent = `Show ${Math.min(100, sigs.length - view.shown)} more of ${sigs.length - view.shown}`;
  more.onclick = () => { view.shown += 100; paintSignals(); };
}

function smtText(s) {
  const a = s.smt.alt, b = s.smt.btc, f = ctx.fmt.price;
  const what = `${s.smt.ref * 15 / 60}h ${s.side === 'Long' ? 'low' : 'high'}`;
  const did = x => `${x.took ? 'took' : 'held'} its ${what} (${f(x.extreme)} vs ${f(x.ref)})`;
  return `${s.smt.ok ? 'Yes' : 'No'}: ${s.symbol.replace(/USDT$/, '')} ${did(a)}, BTC ${did(b)}`;
}

// where the level sits in the lookback range: 0% the low, 100% the high
// BTC's 4h trend against the signal, and whether a counter-trend one had its SMT
const btcText = s => (!s.btc ? '—' : `${s.btc.up ? '↑' : '↓'} ${s.counter ? 'counter' : 'with'}` + (s.counter ? (s.smt?.ok ? ' · SMT ✓' : s.smt?.ok === false ? ' · no SMT' : '') : ''));
const rangeText = s => (s.range?.pos === null || s.range?.pos === undefined ? '—' : Math.round(s.range.pos * 100) + '%');

function signalList(sigs) {
  const ul = el('ul', 'sfp-latest-list');
  for (const s of sigs) {
    const b = el('button', 'recap-trade'); b.type = 'button';
    b.append(el('span', 'rt-name', `${s.symbol} · ${s.side}`), el('span', 'side-' + s.side.toLowerCase(), `${s.levels.length} level${s.levels.length === 1 ? '' : 's'} · close ${ctx.fmt.price(s.close)}`));
    b.onclick = () => showOnChart(s, sigs);
    const li = el('li'); li.append(b); ul.append(li);
  }
  return ul;
}

// ---- the chart: the replay window, on 4h candles, with the levels drawn ----
const rText = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
export function chartItem(s) {
  const short = s.side === 'Short', tr = s.trade, p = ctx.fmt.price;
  const firstSwing = Math.min(...s.levels.map(l => l.t), tr ? tr.tpT : Infinity);
  // the chart runs to where the trade ended (or now, if it's still open)
  const end = tr ? (tr.exitT ?? Math.floor(Date.now() / H4) * H4) : s.t;
  const plan = scalePlan(tr, s.side);                          // adds at +1R and +2R, stops stepped up behind them
  // the break-even stop to the entry's precision (rounded toward the safe side)
  if (plan?.adds[1]) { const dec = (p(tr.entry).replace(/,/g, '').split('.')[1] || '').length, k = 10 ** dec; plan.adds[1].stop = (short ? Math.floor : Math.ceil)(plan.adds[1].stop * k) / k; }
  // the trade guide above the chart: plain-English steps, prices in **bold**
  const coin = s.symbol.replace(/USDT$/, ''), buy = short ? 'Short' : 'Buy', beyond = short ? 'above' : 'below', toward = short ? 'down' : 'up';
  const lv = s.levels.map(l => `**${p(l.price)}**`).join(', ');
  const steps = [`The 4h candle that closed ${when(s.t)} wicked ${short ? 'above' : 'below'} ${s.levels.length > 1 ? 'the levels' : 'the level'} ${lv} and closed back ${short ? 'below' : 'above'}: a failed ${short ? 'breakout' : 'breakdown'}.`];
  if (tr) {
    steps.push(`${buy} ${coin} at the close: **${p(tr.entry)}**.`);
    steps.push(`Put your stop just ${beyond} the wick at **${p(tr.sl)}**, ${(tr.riskPct * 100).toFixed(2)}% away. That distance is 1R, your risk.`);
    for (const a of plan?.adds || []) steps.push(a.n === 1
      ? `If price gets to **${p(a.price)}** (+1R), add the same size again and move all stops ${toward} to your entry, **${p(a.stop)}**.`
      : `If price gets to **${p(a.price)}** (+2R), add half your entry size and move all stops to break-even for the whole position, **${p(a.stop)}**.`);
    steps.push(`Take everything off at **${p(tr.tp)}**, the opposing level the move started from: ${tr.rr.toFixed(1)}R on the first entry${plan?.adds.length ? `, ${rText(plan.R)} with the adds` : ''}.`);
  } else steps.push('No trade: there’s no opposing level beyond the entry to aim for.');
  const outcome = !tr ? null : tr.result === 'win' ? { text: `Target hit after ${Math.round((tr.exitT - s.t) / H4)} candles: ${rText(tr.R)} on the first entry.`, cls: 'pos' }
    : tr.result === 'loss' ? { text: `Stopped out after ${Math.round((tr.exitT - s.t) / H4)} candles: −1R.`, cls: 'neg' }
    : { text: `Still open: ${rText(tr.R)} at the last close.`, cls: '' };
  const context = [
    s.grade ? `Grade ${s.grade.grade}: ${s.grade.why}` : null,
    s.btc ? `BTC 4h trend ${s.btc.up ? 'up' : 'down'}, so this is ${s.counter ? 'against' : 'with'} it` : null,
    s.counter && s.smt?.alt ? `15m SMT vs BTC: ${smtText(s)}` : null,
    s.range?.high ? `level at ${rangeText(s)} of the 7-day range` : null,
    s.after24h !== null && s.after24h !== undefined ? `${pctS(s.after24h)} after 24h` : null,
  ].filter(Boolean).join(' · ');
  return {
    symbol: s.symbol, category: 'linear', dir: s.side, entry: s.close, exit: s.close, size: 0, leverage: 1, pnl: 0, fees: 0, funding: 0,
    openedAt: firstSwing, time: end + H4, duration: end + H4 - firstSwing,
    view: {
      interval: '240',
      trimTo: tr ? end + 2 * H4 : undefined,                    // a couple of candles after the trade ends
      title: `${s.symbol} · SFP ${s.side.toLowerCase()} · ${when(s.t)}`,
      guide: { steps, outcome, context },
      lines: [
        ...s.levels.map(l => ({ price: l.price, color: 'ink', from: l.t, to: s.t })),     // swing levels in neutral gray
        ...(tr ? [
          { price: tr.tp, color: 'ink', from: tr.tpT, to: s.t },                      // the opposing level, from its swing
          // the position, drawn to the right of the candles
          { price: tr.entry, color: 'entry', after: true, title: 'Entry' },
          { price: tr.sl, color: 'neg', after: true, title: 'SL' },
          { price: tr.tp, color: 'pos', after: true, title: 'TP' },
          ...(plan?.adds || []).map(a => ({ price: a.price, color: 'muted', after: true, title: `Add ${a.n}` })),
          ...(plan?.adds.length === 2 ? [{ price: plan.adds[1].stop, color: 'muted', after: true, title: 'B/E' }] : []),
        ] : []),
      ],
      boxes: tr ? [
        { after: true, price: tr.sl, base: tr.entry, color: 'neg' },
        { after: true, price: tr.tp, base: tr.entry, color: 'pos' },
      ] : [],
      marks: [
        ...s.levels.map(l => ({ t: l.t, position: short ? 'aboveBar' : 'belowBar', shape: 'circle', color: 'ink', tip: [`Swing ${short ? 'high' : 'low'} · level ${p(l.price)}`, new Date(l.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })] })),
        ...(tr ? [{ t: tr.tpT, position: short ? 'belowBar' : 'aboveBar', shape: 'circle', color: 'ink', tip: [`Opposing swing ${short ? 'low' : 'high'} · target ${p(tr.tp)}`] }] : []),
        { t: s.t, position: short ? 'aboveBar' : 'belowBar', shape: short ? 'arrowDown' : 'arrowUp', color: short ? 'neg' : 'pos', tip: [`SFP ${s.side.toLowerCase()} · entry ${p(s.close)}`, `Wick ${p(short ? s.high : s.low)} is the stop`] },
        ...(tr?.exitT ? [{ t: tr.exitT, position: tr.result === 'win' ? (short ? 'belowBar' : 'aboveBar') : (short ? 'aboveBar' : 'belowBar'), shape: 'square', color: tr.result === 'win' ? 'pos' : 'neg', tip: [tr.result === 'win' ? `Target hit · ${rText(tr.R)}` : 'Stopped out · −1R'] }] : []),
      ],
      note: 'Entry at the signal candle’s close, stop at its wick, target at the opposing swing level the move started from. The position is drawn to the right of the candles: red is the risk, the other zone the reward. Circles mark the swing candles; the square marks where the trade ended.',
    },
  };
}
// The chart window steps through `list` oldest to newest, whatever order it's shown in.
export function showOnChart(s, list) {
  const sorted = [...list].sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
  const items = sorted.map(chartItem);
  ctx.openReplay(items[sorted.indexOf(s)], items, { apiJson: ctx.apiJson, fmt: { money: ctx.fmt.money, price: ctx.fmt.price, dateTime: ctx.fmt.dateTime, duration: () => '' } });
}

// ---- forming now: the open 4h candle, as if it closed at the current price ----
let forming = null, formBusy = false;
async function checkForming(force = false) {
  const start = Math.floor(Date.now() / H4) * H4;
  if (formBusy || (!force && forming && forming.start === start && Date.now() - forming.at < 55_000)) { paintForming(); return; }
  formBusy = true;
  $('#sfpFormLive').classList.add('busy');
  const symbols = symbolsOf(settings.pairs), errors = [];
  const from = start - (settings.lookbackDays + Math.max(settings.rangeDays || 0, 7) + 5) * DAY;
  try {
    const hits = await pool(symbols, 4, async symbol => {
      try {
        const history = (await candlesFor(symbol, from)).filter(c => c.t >= from && c.t < start);
        const qs = new URLSearchParams({ category: 'linear', symbol, interval: '240', start, end: Date.now() });
        const now = (await ctx.apiJson('/api/klines?' + qs)).candles.find(c => c.t === start);
        if (!now) return [];
        return signalsIf(history, now, settings).map(sg => ({ ...sg, ...holdLine(sg), symbol }));
      } catch (e) { errors.push(symbol); return []; }
    });
    forming = { start, at: Date.now(), setups: hits.flat().sort((a, b) => a.inside - b.inside), errors, settings: { ...settings } };
  } finally { formBusy = false; $('#sfpFormLive').classList.remove('busy'); }
  paintForming();
}

function paintForming() {
  const box = $('#sfpForming');
  if (!forming) { box.replaceChildren(el('p', 'muted small', 'Checking the open 4h candle…')); return; }
  const ago = Math.round((Date.now() - forming.at) / 1000);
  const head = el('p', 'muted small', `${forming.setups.length ? `${forming.setups.length} pair${forming.setups.length === 1 ? '' : 's'} would signal` : 'No pair would signal'} if the candle closed now · checked ${ago < 10 ? 'just now' : ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)} min ago`}` +
    (forming.errors.length ? ` · couldn't read ${forming.errors.join(', ')}` : ''));
  if (!forming.setups.length) { box.replaceChildren(head); return; }
  const list = el('ul', 'sfp-latest-list');
  for (const s of forming.setups) {
    const short = s.side === 'Short';
    const li = el('li'), b = el('button', 'recap-trade'); b.type = 'button';
    b.append(el('span', 'rt-name', `${s.symbol.replace(/USDT$/, '')} ${short ? 'short ▼' : 'long ▲'}`), el('span', 'rt-pnl ' + (s.inside < 0.003 ? 'neg' : ''), `${(s.inside * 100).toFixed(2)}% inside`));
    b.append(el('span', 'rt-meta muted small', `Swept ${s.levels.map(l => ctx.fmt.price(l.price)).join(', ')} · now ${ctx.fmt.price(s.close)} · needs a close ${short ? 'at or below' : 'at or above'} ${ctx.fmt.price(s.line)}`));
    b.title = 'Open on the chart';
    b.onclick = () => showOnChart(s, forming.setups);
    li.append(b); list.append(li);
  }
  box.replaceChildren(head, list);
}

function paintNextClose() {
  const next = Math.ceil((Date.now() + 1) / H4) * H4, left = next - Date.now();
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000), sec = Math.floor((left % 60_000) / 1000);
  $('#sfpNextClose').textContent = `Next 4h close in ${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  $('#sfpFormClose').textContent = `closes in ${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (forming && !formBusy && next - H4 !== forming.start) checkForming();           // a new candle opened
}
