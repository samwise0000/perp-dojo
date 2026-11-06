// Trade replay: one closed trade on a candle chart, with the entry and exit
// marked. Candles come from Bybit's public market data via /api/klines and
// are kept in IndexedDB once they can no longer change. The chart library
// (TradingView Lightweight Charts, Apache 2.0) is loaded on first use.
import { idbGet, idbSet } from './db.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const INTERVALS = [
  { id: '1', label: '1m', ms: MIN }, { id: '5', label: '5m', ms: 5 * MIN }, { id: '15', label: '15m', ms: 15 * MIN },
  { id: '60', label: '1h', ms: HOUR }, { id: '240', label: '4h', ms: 4 * HOUR }, { id: 'D', label: '1D', ms: DAY },
];
const MAX_CANDLES = 1000;
const $ = s => document.querySelector(s);

let lib = null;
export function loadLib() {
  lib ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'vendor/lightweight-charts.js';
    s.onload = () => ok(window.LightweightCharts);
    s.onerror = () => { lib = null; fail(new Error('Couldn’t load the chart library.')); };
    document.head.append(s);
  });
  return lib;
}

// The window to fetch: the trade plus context on both sides. Without a known
// open, center on the close.
function windowFor(t, iv) {
  const open = Number.isFinite(t.openedAt) ? t.openedAt : t.time;
  const span = t.time - open;
  const pad = Math.max(span, 80 * iv.ms);
  const start = Math.floor((open - pad) / iv.ms) * iv.ms;
  const end = Math.min(Date.now(), t.time + pad);
  return { start, end };
}
const fits = (t, iv) => { const { start, end } = windowFor(t, iv); return (end - start) / iv.ms <= MAX_CANDLES; };
// Smallest candle that shows the whole trade as at least a third of the view.
function autoInterval(t) {
  const span = Number.isFinite(t.duration) ? t.duration : 0;
  return INTERVALS.find(iv => span / iv.ms <= 120 && fits(t, iv)) || INTERVALS[INTERVALS.length - 1];
}

async function candles(apiJson, t, iv) {
  const { start, end } = windowFor(t, iv);
  const key = `kl:${t.category}:${t.symbol}:${iv.id}:${start}:${end}`;
  const settled = end < Date.now() - iv.ms;           // the last candle has closed, so this never changes
  if (settled) { const hit = await idbGet(key).catch(() => null); if (hit) return hit; }
  const qs = new URLSearchParams({ category: t.category, symbol: t.symbol, interval: iv.id, start, end });
  const { candles } = await apiJson('/api/klines?' + qs);
  if (settled && candles.length) idbSet(key, candles).catch(() => {});
  return candles;
}

export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// The library draws in UTC; shift so the axis reads in local time.
export const local = ms => Math.floor((ms - new Date(ms).getTimezoneOffset() * MIN) / 1000);

// Best and worst price while the position was open, from candle highs and lows.
// Candles at either edge include a little time outside the trade.
function excursion(t, cs, iv) {
  if (!Number.isFinite(t.openedAt) || !t.entry) return null;
  const inside = cs.filter(c => c.t + iv.ms > t.openedAt && c.t <= t.time);
  if (!inside.length) return null;
  const hi = Math.max(...inside.map(c => c.h)), lo = Math.min(...inside.map(c => c.l));
  const long = t.dir === 'Long';
  const fav = long ? (hi - t.entry) / t.entry : (t.entry - lo) / t.entry;
  const adv = long ? (t.entry - lo) / t.entry : (hi - t.entry) / t.entry;
  return { fav: Math.max(0, fav), adv: Math.max(0, adv), favPrice: long ? hi : lo, advPrice: long ? lo : hi };
}

let chart = null, state = null;

export function openReplay(t, list, ctx) {
  const dlg = $('#replayDlg');
  state = { list, i: Math.max(0, list.indexOf(t)), ctx, iv: null };
  $('#rpClose').onclick = () => dlg.close();
  // a click on the backdrop closes it (pressed and let go outside the box, so a drag out of it doesn't)
  const outside = e => { if (e.target !== dlg) return false; const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let downOut = false;
  dlg.onpointerdown = e => { downOut = outside(e); };
  dlg.onclick = e => { if (downOut && outside(e)) dlg.close(); downOut = false; };
  dlg.onclose = () => { chart?.remove(); chart = null; state = null; };
  $('#replayPrev').onclick = () => step(-1);
  $('#replayNext').onclick = () => step(1);
  dlg.onkeydown = e => {
    if (e.target.closest('input, textarea, select')) return;      // typing a note
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  };
  if (!dlg.open) dlg.showModal();
  show();
}

function step(d) {
  if (!state) return;
  const i = state.i + d;
  if (i < 0 || i >= state.list.length) return;
  state.i = i; state.iv = null;
  show();
}

async function show() {
  const { list, i, ctx } = state;
  const t = list[i], f = ctx.fmt;
  // `t.view` is a chart that isn't one of your trades (an SFP signal): it brings its own
  // candle size, title, stats, lines and markers
  const iv = state.iv ||= (t.view?.interval && INTERVALS.find(x => x.id === t.view.interval)) || autoInterval(t);
  $('#replayPrev').disabled = i <= 0;
  $('#replayNext').disabled = i >= list.length - 1;
  $('.replay-nav').hidden = list.length < 2;
  // signals step oldest to newest, with a counter; trades keep the order of the table they came from
  $('#replayPrev').textContent = t.view ? '‹ Older' : '‹ Previous trade';
  $('#replayNext').textContent = t.view ? 'Newer ›' : 'Next trade ›';
  $('#rpCount').textContent = t.view && list.length > 1 ? `Signal ${i + 1} of ${list.length}` : '';
  // notes and tags belong to closed trades; the page fills this panel
  const notes = $('#rpNotes');
  notes.hidden = !!t.open || !!t.view || !ctx.notes;
  if (!notes.hidden) ctx.notes(notes, t);
  // an open position replays up to now: no close, its stop-loss and take-profit drawn instead
  $('#rpTitle').textContent = t.view ? t.view.title : t.open ? `${t.symbol} ${t.dir.toLowerCase()} · open now` : `${t.symbol} ${t.dir.toLowerCase()} · ${f.dateTime(t.time)}`;

  const seg = $('#rpIntervals');
  seg.replaceChildren(...INTERVALS.map(x => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = x.label;
    b.setAttribute('aria-pressed', String(x === iv));
    b.disabled = !fits(t, x);
    if (b.disabled) b.title = 'Too many candles for this trade';
    b.onclick = () => { state.iv = x; show(); };
    return b;
  }));

  const stats = t.view ? (t.view.stats || []) : t.open ? [
    ['Unrealized P&L', t.hidePnl ? '$******' : f.money(t.pnl), t.hidePnl ? '' : t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''],
    ['Entry → mark', `${f.price(t.entry)} → ${f.price(t.exit)}`],
    ['Opened', Number.isFinite(t.openedAt) ? f.dateTime(t.openedAt) : 'Over 7 days ago'],
    ['Held so far', f.duration(t.duration)],
    ['Size', `${t.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}${t.leverage ? ` · ${t.leverage}×` : ''}`],
    ['Stop-loss / take-profit', `${t.sl ? f.price(t.sl) : 'none'} / ${t.tp ? f.price(t.tp) : 'none'}`, t.sl ? '' : 'neg'],
  ] : [
    ['Net P&L', f.money(t.pnl), t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''],
    ['Entry → exit', `${f.price(t.entry)} → ${f.price(t.exit)}`],
    ['Opened', Number.isFinite(t.openedAt) ? f.dateTime(t.openedAt) : 'Before your pulled data'],
    ['Held', f.duration(t.duration)],
    ['Size', `${t.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}${t.leverage ? ` · ${t.leverage}×` : ''}`],
    ['Fees + funding', f.money(-(t.fees + (t.funding || 0)))],
  ];
  const dl = $('#rpStats');
  const fill = extra => dl.replaceChildren(...[...stats, ...extra].map(([k, v, cls]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    d.append(dt, dd); return d;
  }));
  fill([]);
  // a signal's trade guide replaces the stat cards
  const guide = $('#rpGuide');
  dl.hidden = Boolean(t.view?.guide); guide.hidden = !t.view?.guide;
  $('#replayDlg').classList.toggle('has-guide', Boolean(t.view?.guide));   // guide on the left, chart on the right
  const head = $('#rpHead'); head.hidden = !t.view?.guide;
  if (t.view?.guide) renderGuide(guide, head, t.view.guide);

  const box = $('#rpChart'), note = $('#rpNote');
  note.textContent = 'Loading candles from Bybit…';
  let LW, cs;
  try {
    [LW, cs] = await Promise.all([loadLib(), candles(ctx.apiJson, t, iv)]);
  } catch (e) {
    if (state?.list[state.i] !== t) return;
    chart?.remove(); chart = null; box.replaceChildren();
    note.textContent = e.message;
    return;
  }
  if (!state || state.list[state.i] !== t || state.iv !== iv) return;   // moved on while loading
  if (t.view?.trimTo) cs = cs.filter(c => c.t <= t.view.trimTo);       // a signal's chart ends soon after its trade
  if (!cs.length) { chart?.remove(); chart = null; box.replaceChildren(); note.textContent = 'Bybit has no candles for this market and time.'; return; }

  chart?.remove();
  box.replaceChildren();
  const ink = css('--ink-2'), pos = css('--pos'), neg = css('--neg'), grid = css('--grid'), axis = css('--axis');
  chart = LW.createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: css('--muted'), fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: axis },
    timeScale: { borderColor: axis, timeVisible: iv.ms < DAY, secondsVisible: false },
    crosshair: { mode: LW.CrosshairMode.Normal },
  });
  const series = chart.addCandlestickSeries({
    upColor: pos, downColor: neg, borderVisible: false, wickUpColor: pos, wickDownColor: neg,
    priceFormat: { type: 'price', precision: decimals(cs), minMove: 10 ** -decimals(cs) },
  });
  series.setData(cs.map(c => ({ time: local(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
  // room after the candles for a trade drawn to their right (empty time slots)
  const sideRoom = t.view && [...(t.view.boxes || []), ...t.view.lines].some(x => x.after);
  if (sideRoom) {
    const last = cs[cs.length - 1].t, pad = [];
    for (let k = 1; k <= SIDE.gap + SIDE.width + SIDE.tail; k++) pad.push({ time: local(last + k * iv.ms) });
    series.setData([...cs.map(c => ({ time: local(c.t), open: c.o, high: c.h, low: c.l, close: c.c })), ...pad]);
  }

  const long = t.dir === 'Long', result = t.pnl >= 0 ? pos : neg, entryC = entryColor(pos, neg) || ink;
  const snap = ms => local(Math.floor(ms / iv.ms) * iv.ms);
  // arrows only; the details show when you hover the candle they sit on
  const marks = [];
  const color = c => ({ pos, neg, entry: entryC, ink, muted: css('--muted') }[c] || c);
  if (t.view) {
    for (const m of t.view.marks) marks.push({ time: snap(m.t), position: m.position, shape: m.shape, color: color(m.color), size: m.shape === 'circle' ? 0.8 : 1.4, tip: m.tip });
    // Things marked `after` (a trade's zones and lines) sit to the right of the
    // candles, past a small gap, so they don't cover the price action.
    const GAP = SIDE.gap, WIDTH = SIDE.width, lastT = cs[cs.length - 1].t;
    const side = { from: lastT + GAP * iv.ms, to: lastT + (GAP + WIDTH) * iv.ms };
    const span = (o) => (o.after ? side : { from: o.from, to: o.to });
    const times = ({ from, to }, after) => {
      if (!after) { const a = snap(from), z = snap(to); return cs.map(c => local(c.t)).filter(x => x >= a && x <= z); }
      const out = []; for (let x = from; x <= to; x += iv.ms) out.push(local(x)); return out;
    };
    // shaded zones between two prices over a span of candles: the stop and target of a trade
    for (const b of t.view.boxes || []) {
      const fill = alpha(color(b.color), 0.16);
      const zone = chart.addBaselineSeries({
        baseValue: { type: 'price', price: b.base }, lineWidth: 1, topLineColor: 'transparent', bottomLineColor: 'transparent',
        topFillColor1: fill, topFillColor2: fill, bottomFillColor1: fill, bottomFillColor2: fill,
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        priceFormat: { type: 'price', precision: decimals(cs), minMove: 10 ** -decimals(cs) },
      });
      zone.setData(times(span(b), b.after).map(time => ({ time, value: b.price })));
    }
    for (const l of t.view.lines) {
      // a segment between two candles (a level from its swing to its test), or a full-width line
      if (l.after || (l.from && l.to > l.from)) {
        const seg = chart.addLineSeries({ color: color(l.color), lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
          priceFormat: { type: 'price', precision: decimals(cs), minMove: 10 ** -decimals(cs) } });
        seg.setData(l.after ? [{ time: local(side.from), value: l.price }, { time: local(side.to), value: l.price }] : [{ time: snap(l.from), value: l.price }, { time: snap(l.to), value: l.price }]);
        if (l.title) seg.createPriceLine({ price: l.price, color: color(l.color), lineVisible: false, axisLabelVisible: true, title: l.title });
        if (l.after) {
          // a dotted lead from the position to its label on the price axis
          const lead = chart.addLineSeries({ color: color(l.color), lineWidth: 1, lineStyle: LW.LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
            priceFormat: { type: 'price', precision: decimals(cs), minMove: 10 ** -decimals(cs) } });
          lead.setData([{ time: local(side.to), value: l.price }, { time: local(lastT + (SIDE.gap + SIDE.width + SIDE.tail) * iv.ms), value: l.price }]);
        }
      } else series.createPriceLine({ price: l.price, color: color(l.color), lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: l.title || '' });
    }
  }
  else if (Number.isFinite(t.openedAt)) marks.push({ time: snap(t.openedAt), position: long ? 'belowBar' : 'aboveBar', color: entryC, shape: long ? 'arrowUp' : 'arrowDown', size: 1.4,
    tip: [`${long ? 'Buy' : 'Sell'} to open`, `${f.price(t.entry)} · ${f.dateTime(t.openedAt)}`] });
  if (!t.open && !t.view) marks.push({ time: snap(t.time), position: long ? 'aboveBar' : 'belowBar', color: result, shape: long ? 'arrowDown' : 'arrowUp', size: 1.4,
    tip: [`Close · ${f.money(t.pnl)}`, `${f.price(t.exit)} · ${f.dateTime(t.time)}`] });
  marks.sort((a, b) => a.time - b.time);
  series.setMarkers(marks.map(({ tip, ...m }) => m));
  if (!t.view) series.createPriceLine({ price: t.entry, color: entryC, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: '' });
  if (!t.open && !t.view) series.createPriceLine({ price: t.exit, color: result, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: '' });
  if (t.open && t.sl) series.createPriceLine({ price: t.sl, color: neg, lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'SL' });
  if (t.open && t.tp) series.createPriceLine({ price: t.tp, color: pos, lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'TP' });
  if (t.open && t.liq) series.createPriceLine({ price: t.liq, color: css('--muted'), lineWidth: 1, lineStyle: LW.LineStyle.SparseDotted, axisLabelVisible: true, title: 'Liq' });

  // the page tooltip lives under <body>, behind the modal, so this one lives in the chart box
  const tip = document.createElement('div');
  tip.className = 'replay-tip'; tip.hidden = true;
  box.append(tip);
  chart.subscribeCrosshairMove(p => {
    const hit = p.point && p.time !== undefined && marks.filter(m => m.time === p.time);
    if (!hit?.length) { tip.hidden = true; return; }
    tip.replaceChildren(...hit.flatMap(m => {
      const h = document.createElement('b'); h.textContent = m.tip[0]; h.style.color = m.color;
      const d = document.createElement('span'); d.textContent = m.tip[1];
      return [h, d];
    }));
    tip.hidden = false;
    const x = p.point.x + 14 + tip.offsetWidth > box.clientWidth - 70 ? p.point.x - 14 - tip.offsetWidth : p.point.x + 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, Math.min(p.point.y - tip.offsetHeight / 2, box.clientHeight - tip.offsetHeight - 30)) + 'px';
  });

  // frame the trade with some room either side
  const from = Number.isFinite(t.openedAt) ? t.openedAt : t.time;
  const room = Math.max(t.time - from, 40 * iv.ms) * 0.8;
  chart.timeScale().setVisibleRange({ from: local(Math.max(cs[0].t, from - room)), to: sideRoom ? local(lastT_(cs) + (SIDE.gap + SIDE.width + SIDE.tail) * iv.ms) : local(Math.min(cs[cs.length - 1].t, t.time + room)) });

  const x = t.view ? null : excursion(t, cs, iv);
  if (x) fill([
    ['Best price in trade', `${f.price(x.favPrice)} · ${(x.fav * 100).toFixed(2)}% in your favor`, 'pos'],
    ['Worst price in trade', `${f.price(x.advPrice)} · ${(x.adv * 100).toFixed(2)}% against you`, 'neg'],
  ]);
  if (t.view) { note.textContent = `${t.view.note} ${iv.label} candles from Bybit, in your local time.` + (list.length > 1 ? ' Use ← → for older and newer signals.' : ''); return; }
  note.textContent = (t.open ? (Number.isFinite(t.openedAt) ? 'Still open: the chart runs to now. ' : 'Opened over 7 days ago, so the entry isn’t marked. ') : Number.isFinite(t.openedAt) ? '' : 'The open isn’t in your pulled fills, so only the close is marked. ') +
    `${iv.label} candles from Bybit, last price. Times are your local time. Best and worst prices are from candle highs and lows, so they're approximate.` + (list.length > 1 ? ' Use ← → to step through trades.' : '');
}

// The entry arrow needs a color that can't be mistaken for a win or a loss:
// of the theme's colorful accents, the one whose hue is furthest from both.
export function entryColor(pos, neg) {
  const hsl = c => {
    const x = c.replace('#', '');
    if (x.length !== 6) return null;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    const h = !d ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    return { h: (h + 360) % 360, s: sat };
  };
  const P = hsl(pos), N = hsl(neg);
  if (!P || !N) return null;
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  let best = null, score = -1;
  for (const k of ['--a1', '--a2', '--a3', '--a4', '--a5']) {
    const c = css(k), A = hsl(c);
    if (!A || A.s < 0.3) continue;
    const d = Math.min(gap(A.h, P.h), gap(A.h, N.h));
    if (d > score) { score = d; best = c; }
  }
  return score >= 40 ? best : null;     // nothing clearly different: the caller falls back to ink
}

// A CSS color at the given opacity, for canvas fills (the chart can't use color-mix).
const paint = document.createElement('canvas').getContext('2d');
export function alpha(c, a) {
  paint.fillStyle = '#000'; paint.fillStyle = c;
  const v = paint.fillStyle;
  if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; }
  return v.replace(/rgba?\(([^)]+)\)/, (m, x) => `rgba(${x.split(',').slice(0, 3).join(',')}, ${a})`);
}

const lastT_ = cs => cs[cs.length - 1].t;
// a trade drawn beside the candles: empty candles before it, its width, and room after
const SIDE = { gap: 2, width: 10, tail: 10 };

export function decimals(cs) {
  const p = cs[cs.length - 1].c;
  return p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 4 : Math.min(8, 2 + Math.ceil(-Math.log10(p)) + 2);
}

// A signal's trade guide: its record (grade + tags, past year), then Entry → Trade management → Exit
function renderGuide(root, headRoot, { history, sections, outcome, context }) {
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const rich = text => text.split('**').map((part, i) => { if (!(i % 2)) return document.createTextNode(part); const b = document.createElement('b'); b.textContent = part; return b; });
  const out = [];
  if (history) {
    const h = mk('div', 'rg-hist');
    const head = mk('div', 'rg-hist-head');
    head.append(mk('span', 'kicker', history.title));
    const chips = mk('div', 'rg-chips');
    for (const c of history.chips) { const e = mk('span', c.cls, c.text); if (c.title) e.title = c.title; chips.append(e); }
    head.append(chips);
    if (history.proj) { const e = mk('span', 'rg-proj ' + history.proj.cls, history.proj.text); e.title = history.proj.title || ''; head.append(e); }
    h.append(head);
    const rows = mk('div', 'rg-hist-rows');
    for (const r of history.rows) {
      const row = mk('div', 'rg-hrow' + (r.thin ? ' thin' : ''));
      const lab = mk('span', 'rg-hlab', r.label); if (r.title) lab.title = r.title;
      const bar = mk('span', 'rg-hbar');
      if (r.n) for (const [k, v] of [['w', r.wins], ['b', r.bes], ['l', r.losses]]) if (v) { const seg = mk('i', 'rg-' + k); seg.style.flexGrow = v; bar.append(seg); }
      bar.title = r.n ? `${r.wins} won · ${r.bes} break-even · ${r.losses} lost` : 'No finished trades';
      const st = (k, v, cls = '', tip = '') => { const d = mk('span', 'rg-hst'); d.append(mk('small', '', k), mk('b', cls, v)); if (tip) d.title = tip; return d; };
      row.append(lab, bar,
        st('Trades', r.n ? r.n.toLocaleString() : '—'),
        st('Won', r.n ? `${Math.round(100 * r.wins / r.n)}%` : '—'),
        st('R a trade', r.avg == null ? '—' : r.avgText, r.avg == null ? '' : r.avg >= 0 ? 'pos' : 'neg', 'Average after Bybit fees'),
        st('w/o best 3', r.wo3 == null ? '—' : r.wo3Text, r.wo3 == null ? '' : r.wo3 >= 0 ? 'pos' : 'neg', 'R a trade with its 3 best trades left out: does it hold up without its outliers?'));
      rows.append(row);
    }
    h.append(rows);
    if (history.note) { head.firstChild.title = history.note; if (!history.rows.length) h.append(mk('p', 'rg-hnote muted small', history.note)); }
    headRoot.replaceChildren(h);
  } else { headRoot.replaceChildren(); headRoot.hidden = true; }
  const flow = mk('div', 'rg-flow');
  sections.forEach((sec, i) => {
    const c = mk('section', `rg-sec rg-${sec.key} st-${sec.state || 'idle'}`);
    const top = mk('div', 'rg-sec-head');
    top.append(mk('span', 'rg-n', String(i + 1)), mk('span', 'rg-sec-t', sec.title));
    if (sec.badge) top.append(mk('span', 'rg-badge', sec.badge));
    const fig = mk('div', 'rg-fig'); fig.append(mk('span', '', sec.figure));
    if (sec.sub) fig.append(mk('span', 'rg-sub muted small', sec.sub));
    c.append(top, fig);
    const ol = mk('ol');
    for (const st of sec.steps) { const li = mk('li'); li.append(...rich(st)); ol.append(li); }
    c.append(ol);
    // what happened, at the end of the exit
    if (sec.key === 'exit' && outcome) { const p = mk('p', 'rg-outcome ' + outcome.cls); p.append(...rich(outcome.text)); c.append(p); }
    flow.append(c);
  });
  out.push(flow);
  if (context) out.push(mk('p', 'rg-context muted small', context));
  root.replaceChildren(...out);
}
