// Monitoring: the hour before each 4h close. Every pair whose forming candle is at or near a level it could
// make a swing failure at (nearLevels in sfp.js, by the detector's own rules), in three lanes, left to right:
//   Near      within reach of the level (in 4h ATRs, the reach is a setting)
//   Through   price is past the level: it needs to close back inside to signal
//   Swept     the wick went past the level and price is back inside: it signals if it closes here
// Each card previews the grade it would get (the Signals tab's inputs: NY bias, BTC's sweep and 1h RSI, the
// candle's shape, 🐋 flow, golden zone, EMA100), the size, the entry (close or 🪜 ladder) and R:R, the forming
// candle on 15m bars, and whether it moved toward the level since the last check. It checks on its own from an
// hour before the close: every 5 minutes, then every minute in the last 15. New sweeps can raise a browser
// notification. After the close it shows which of them signalled.
import { H4, DEFAULT_PAIRS, ALERT_SETTINGS, nearLevels, signalsIf, candleShape, gradeSetup, tierOf, emaGuard, trendMap, SHORT_EMA, rsi, btcRsiTag, atrAt, fullSweep, goldenRaw, whaleAbsorption, ladderWhy, scalePlan, killzoneAt, KILLZONE, lateSweep, LATE_TIP, EARLY_TIP, sweepTag, positioning, TAG_TIPS, isGodTier, godTip } from './sfp.js';
import { sessionList, nyBiasAt, nyFadeAt, fadesNy, nyPullbackAt, inGoldenZone, nyExtremeAt } from './bias.js';
import { proposedRisk } from './day-playbook.js';
import { candlesFor, pool, bindCharts, killzoneBox, killzoneMark } from './signal-chart.js';
import { monitorHelpers } from './signals.js';

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR, M15 = 15 * MIN;
export const MONITOR_LEAD = HOUR;              // how long before the close it starts checking
const EVERY = 5 * MIN, EVERY_LATE = MIN, LATE = 15 * MIN;   // every 5 minutes, then every minute in the last 15
const PAIRS = DEFAULT_PAIRS.split(' ').map(x => x + 'USDT');
const KEY = 'perp-dojo:monitor';
const REACHES = [0.5, 1, 2];
const LANES = [
  { key: 'near', title: 'Near', sub: 'within reach of a level', tip: 'Not reached yet: how far the wick still has to go' },
  { key: 'beyond', title: 'Through', sub: 'needs to close back inside', tip: 'Price is past the level right now: it needs to close back inside to signal' },
  { key: 'swept', title: 'Swept', sub: 'back inside: signals if it closes here', tip: 'The wick went past the level and price is back inside: it signals if the candle closes here' },
];

// ---- settings, remembered in this browser ----
const prefs = { reach: 1, side: 'all', tradeable: false, pinnedOnly: false, notify: false, sound: false, pins: [] };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };

const st = { root: null, ctx: null, data: null, prev: null, result: null, running: false, done: 0, timer: null, clock: null, built: false };

// ---- small helpers ----
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const coin = s => s.replace(/USDT$/, '');
const hm = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const left = ms => { const s = Math.max(0, Math.round(ms / SEC)), m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const pc = v => `${(v * 100).toFixed(Math.abs(v) < 0.001 ? 3 : 2)}%`;
const gradeKey = g => 'g-' + g.toLowerCase().replace(/\+/g, 'plus');
const gradeLabel = g => (g === 'A++' ? '★ A++' : g === 'S++' ? '💎 S++' : g === 'S+' ? '👑 S+' : g === 'S' ? '🐋 S' : g === 'C+' ? '🕯️ C+' : g);
const idOf = r => `${r.symbol}:${r.side}:${r.price}`;
// the next close, and where we are before it
function windowAt(now = Date.now()) {
  const close = Math.floor(now / H4) * H4 + H4;
  const phase = now >= close - LATE ? 'late' : now >= close - MONITOR_LEAD ? 'watch' : 'wait';
  return { close, start: close - H4, opens: close - MONITOR_LEAD, on: phase !== 'wait', phase };
}
const dueEvery = w => (w.phase === 'late' ? EVERY_LATE : EVERY);

// ---- entry points ----
export function renderMonitor(root, ctx) {
  st.root = root; st.ctx = ctx; bindCharts(ctx);
  if (!st.built) build();
  paint();
  tick();
  if (!st.timer) st.timer = setInterval(tick, 15 * SEC);
  if (!st.clock) st.clock = setInterval(() => { if (visible()) paintClock(); }, SEC);
}
// keep checking in the background while the page is open, so the nav count (and notifications) stay current
export function startMonitor(ctx) {
  if (st.timer) return;
  st.ctx = ctx; bindCharts(ctx);
  st.timer = setInterval(tick, 15 * SEC);
}
const visible = () => st.root?.isConnected && !st.root.hidden;

function tick() {
  const w = windowAt(), d = st.data;
  // after a close: which of its candidates signalled (once, a little after the candle is final)
  if (d && !d.resolved && Date.now() >= d.close + 20 * SEC && !st.running) { resolve(d); return; }
  if (w.on && !st.running && (!d || d.close !== w.close || Date.now() - d.at >= dueEvery(w))) run();
  else if (visible()) paintStatus();
}

// ---- the check ----
async function market(w) {
  const since = Date.now() - (ALERT_SETTINGS.lookbackDays + 10) * DAY, api = st.ctx.apiJson, { hourly } = monitorHelpers(st.ctx);
  const btc4h = await candlesFor('BTCUSDT', since - 20 * DAY);
  const qs = new URLSearchParams({ category: 'linear', symbol: 'BTCUSDT', interval: '240', start: w.start, end: Date.now() });
  const btcCur = (await api('/api/klines?' + qs)).candles.find(c => c.t === w.start) || null;
  const btcHist = btc4h.filter(c => c.t < w.start);
  let h1 = [];
  try { h1 = await hourly('BTCUSDT', Date.now() - 12 * DAY); } catch {}
  const sessions = h1.length ? sessionList(h1, { from: Date.now() - 8 * DAY }) : null;
  const ny = sessions ? nyBiasAt(sessions, w.close) : null;
  const pull = h1.length ? nyPullbackAt(h1, w.close) : null, fade = h1.length ? nyFadeAt(h1, w.close) : null;
  const rsiNow = h1.length ? rsi(h1).at(-1) : null;
  const btcSides = btcCur ? signalsIf(btcHist, btcCur, ALERT_SETTINGS).map(s => s.side) : [];
  const trend100 = trendMap(btc4h, SHORT_EMA).get(w.start - H4) || null;
  const btcLevels = btcCur ? nearLevels(btcHist, btcCur) : [];
  return { ny, pull, fade, rsiNow, btcSides, ema100Up: trend100?.up, btcCur, btcLevel: btcLevels.find(l => l.state !== 'near') || btcLevels[0] || null,
    zone: side => inGoldenZone(side, pull, new Date(w.close).getHours()) };
}

// what the setup would grade (and size, and how it'd be entered) if the candle closed now
function preview(r, hist, cur, mk) {
  const side = r.side, shape = candleShape(hist.at(-1), cur, side), rsiK = btcRsiTag(side, mk.rsiNow);
  const g0 = gradeSetup(side, { ny: mk.ny, swept: mk.btcSides.includes(side), rsi: rsi([...hist, cur]).at(-1), fade: fadesNy(side, mk.fade) });
  const sig = r.state === 'swept' ? signalsIf(hist, cur, ALERT_SETTINGS).find(s => s.side === side) || null : null;
  const byT = new Map(hist.map(c => [c.t, c])), atr = atrAt([...hist, cur], hist.length);
  const full = sig ? fullSweep(sig, t => byT.get(t)) : false;
  const g = emaGuard(tierOf(g0, { shape: sig ? shape : null, full, grr: sig ? goldenRaw(sig.trade, atr) : false, btcRsi: rsiK?.kind ?? null, rr: sig?.trade?.rr ?? null, whale: r.whale ?? null, zone: mk.zone(side) }), side, mk.ema100Up);
  const risk = proposedRisk(g.grade, r.close, { tag: g.tag, from: g.from, skip: g.skip, god: isGodTier(side, full, r.lean, g) });
  const out = { grade: g.grade, from: g.from, skip: g.skip, why: g.why, risk, rsiK, sure: Boolean(sig), shape, full };
  if (sig?.trade) {
    const t = sig.trade, how = ladderWhy(g.grade, rsiK?.kind ?? null, shape);
    const rungs = how ? shape.ladder.filter(L => (t.tp - L) * (L - t.sl) > 0) : null;
    const rr = rungs?.length ? rungs.reduce((n, L) => n + 0.2 * Math.abs(t.tp - L) / Math.abs(L - t.sl), 0) : t.rr;
    Object.assign(out, { trade: t, how, rungs, rr, withAdds: scalePlan({ ...t, entry: t.entry }, side)?.R ?? null });
  }
  return out;
}

async function run() {
  const w = windowAt();
  st.running = true; st.done = 0; paintStatus();
  const api = st.ctx.apiJson, { flowFor } = monitorHelpers(st.ctx);
  let mk;
  try { mk = await market(w); } catch { mk = { ny: null, btcSides: [], rsiNow: null, zone: () => false, ema100Up: null }; }
  const errors = [], since = Date.now() - (ALERT_SETTINGS.lookbackDays + 10) * DAY;
  const rows = (await pool(PAIRS, 6, async symbol => {
    try {
      const deep = (await candlesFor(symbol, Date.now() - 380 * DAY)).filter(c => c.t < w.start);   // a year back, for ⚔️ killzone lines
      const hist = deep.filter(c => c.t >= since);
      const qs = new URLSearchParams({ category: 'linear', symbol, interval: '240', start: w.start, end: Date.now() });
      const cur = (await api('/api/klines?' + qs)).candles.find(c => c.t === w.start);
      if (!cur) return [];
      const levels = nearLevels(hist, cur).filter(r => r.state !== 'near' || (r.atr != null ? r.atr <= REACHES.at(-1) : r.toGo <= 0.02));
      if (!levels.length) return [];
      // 🐋 and the 15m bars, only for the pairs that made the list
      const flow = await flowFor(symbol, Date.now() - 40 * DAY).catch(() => null);
      const q15 = new URLSearchParams({ category: 'linear', symbol, interval: '15', start: w.start - 2 * HOUR, end: Date.now() });
      const bars = (await api('/api/klines?' + q15).catch(() => ({ candles: [] }))).candles;
      // the nearest level per side (the others listed on the card)
      const bySide = new Map();
      for (const l of levels) { if (!bySide.has(l.side)) bySide.set(l.side, { ...l, more: [] }); else bySide.get(l.side).more.push(l); }
      return [...bySide.values()].map(l => {
        const r = { ...l, symbol, px: cur.c, cur, close: w.close, bars, whale: flow ? whaleAbsorption(l.side, w.start, flow)?.kind ?? null : null, lean: flow ? positioning(l.side, w.start, flow.taker) : null, nyx: nyExtremeAt(l.side, l.price, atrAt([...hist, cur], hist.length), [...hist, cur], w.close) };
        r.p = preview(r, hist, cur, mk);
        r.late = r.state !== 'near' ? lateSweep(l.side, l.price, cur.t, bars) : null;     // when it first went past the level: ⏳ / ⚡ on A++ shorts / A+ longs
        // ⚔️ does a 1–12 month trendline meet this level at the forming candle? (the wick needn't reach it yet)
        { const all = [...deep, cur]; r.kzAtr = atrAt(all, all.length - 1); r.kz = killzoneAt(all, all.length - 1, l.side, l.price, r.kzAtr, { ...KILLZONE, wick: false }); }
        r.hist = hist;
        return r;
      });
    } catch { errors.push(symbol); return []; }
    finally { st.done++; if (visible()) paintStatus(); }
  })).flat();
  // against the last check of the same close: new, and moving toward or away from the level
  const before = st.data && st.data.close === w.close ? new Map(st.data.rows.map(r => [idOf(r), r])) : null;
  for (const r of rows) {
    const b = before?.get(idOf(r));
    r.isNew = before ? !b : false;
    r.became = b && b.state !== r.state ? r.state : null;
    r.move = !b ? 0 : r.state === 'near' && b.state === 'near' ? Math.sign(b.toGo - r.toGo) : 0;
  }
  if (st.data && st.data.close === w.close) st.prev = st.data;
  st.data = { close: w.close, start: w.start, at: Date.now(), rows, errors, mk };
  st.running = false;
  alertNew(rows, before);
  if (st.root) paint();
  badge();
}

// after the close: each swept / through candidate's closed candle, and whether it signalled
async function resolve(d) {
  st.running = true;
  const api = st.ctx.apiJson, cands = d.rows.filter(r => r.state !== 'near' || (r.atr ?? 9) <= 0.5);
  const out = await pool(cands, 6, async r => {
    try {
      const qs = new URLSearchParams({ category: 'linear', symbol: r.symbol, interval: '240', start: d.start, end: d.close + MIN });
      const c = (await api('/api/klines?' + qs)).candles.find(x => x.t === d.start);
      const sig = c ? signalsIf(r.hist, c, ALERT_SETTINGS).find(s => s.side === r.side) : null;
      return { symbol: r.symbol, side: r.side, was: r.state, grade: r.p?.grade, signalled: Boolean(sig), close: c?.c ?? null };
    } catch { return null; }
  });
  d.resolved = true;
  st.result = { close: d.close, list: out.filter(Boolean) };
  st.running = false;
  if (st.root) paint();
  badge();
}

// 🔔 a browser notification (and a soft chime) for each pair that newly swept a level at this close
function alertNew(rows, before) {
  if (!before) return;
  const fresh = rows.filter(r => r.state === 'swept' && before.get(idOf(r))?.state !== 'swept');
  if (!fresh.length) return;
  if (prefs.sound) chime();
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  for (const r of fresh.slice(0, 4)) {
    try {
      new Notification(`${coin(r.symbol)} swept its ${r.side === 'Short' ? 'high' : 'low'} · ${r.p?.grade || ''}`, {
        body: `${st.ctx.fmt.price(r.price)}, back inside at ${st.ctx.fmt.price(r.px)}. Signals ${r.side === 'Short' ? 'short' : 'long'} if it closes here (${hm(r.close)}).`, tag: idOf(r),
      });
    } catch {}
  }
}
function chime() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)(), t = a.currentTime;
    for (const [f, dt] of [[880, 0], [1320, 0.12]]) {
      const o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.12, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.35);
      o.connect(g).connect(a.destination); o.start(t + dt); o.stop(t + dt + 0.4);
    }
  } catch {}
}

// the nav count: what's swept or through right now (the ones that can signal at this close)
function badge() {
  const b = document.querySelector('#monCount'); if (!b) return;
  const n = st.data && st.data.close === windowAt().close ? st.data.rows.filter(r => r.state !== 'near').length : 0;
  b.hidden = !n; b.textContent = n;
}

// ---- layout ----
function build() {
  st.built = true;
  const hero = el('div', 'card c12 mon-hero');
  const ring = el('div', 'mon-ring');
  ring.innerHTML = '<svg viewBox="0 0 80 80" aria-hidden="true"><circle class="mon-ring-bg" cx="40" cy="40" r="34"/><circle class="mon-ring-hour" cx="40" cy="40" r="34"/><circle class="mon-ring-fg" cx="40" cy="40" r="34"/></svg><div class="mon-ring-t"><b class="mon-left">--:--</b><small class="mon-phase">to the close</small></div>';
  const mid = el('div', 'mon-hero-mid');
  mid.append(el('div', 'kicker mon-kick', 'The hour before the close'), el('h2', 'mon-h', 'Pairs nearing a level'), el('p', 'mon-status muted small'));
  const counts = el('div', 'mon-counts');
  hero.append(ring, mid, counts);

  const bar = el('div', 'card c12 mon-bar');
  const sel = (id, label, opts, val, on) => { const w = el('label', 'mon-sel'); w.append(el('span', '', label)); const s = el('select'); s.id = id; for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; o.selected = String(v) === String(val); s.append(o); } s.onchange = () => on(s.value); w.append(s); return w; };
  const tog = (id, label, key, tip, after) => { const w = el('label', 'mon-tog'); w.title = tip; const c = el('input'); c.type = 'checkbox'; c.id = id; c.checked = prefs[key]; c.onchange = async () => { prefs[key] = c.checked; if (after) await after(c); save(); paint(); }; w.append(c, el('span', '', label)); return w; };
  const now = el('button', 'btn small-btn mon-now', 'Check now'); now.type = 'button'; now.id = 'monNow';
  now.onclick = () => { if (!st.running) run(); };
  bar.append(
    sel('monReach', 'Near', REACHES.map(r => [r, `within ${r} ATR`]), prefs.reach, v => { prefs.reach = Number(v); save(); paint(); }),
    sel('monSide', 'Side', [['all', 'Longs and shorts'], ['Long', '▲ Longs'], ['Short', '▼ Shorts']], prefs.side, v => { prefs.side = v; save(); paint(); }),
    tog('monTradeable', 'Tradeable only', 'tradeable', 'Only setups the plan would size at this close (by the previewed grade)'),
    tog('monPinned', '⭐ Pinned only', 'pinnedOnly', 'Only the pairs you pinned'),
    tog('monNotify', '🔔 Notify', 'notify', 'A browser notification when a pair newly sweeps a level in the hour before the close', async c => {
      if (c.checked && 'Notification' in window && Notification.permission !== 'granted') { const p = await Notification.requestPermission().catch(() => 'denied'); if (p !== 'granted') { c.checked = false; prefs.notify = false; } }
    }),
    tog('monSound', '🔊 Sound', 'sound', 'A soft chime when a pair newly sweeps a level', c => { if (c.checked) chime(); }),
    now,
  );

  const btc = el('div', 'card c12 mon-btc');
  const result = el('div', 'card c12 mon-result'); result.hidden = true;
  const board = el('div', 'c12 mon-board');
  for (const l of LANES) {
    const col = el('section', `mon-lane lane-${l.key}`); col.dataset.lane = l.key;
    const h = el('header', 'mon-lane-h'); h.title = l.tip;
    h.append(el('span', 'mon-lane-dot'), el('b', '', l.title), el('span', 'mon-lane-n', '0'), el('small', 'muted', l.sub));
    col.append(h, el('div', 'mon-lane-body'));
    board.append(col);
  }
  st.root.replaceChildren(hero, bar, btc, result, board);
}

function paintClock() {
  if (!st.root) return;
  const w = windowAt(), now = Date.now(), toClose = w.close - now;
  const ring = st.root.querySelector('.mon-ring'); if (!ring) return;
  const C = 2 * Math.PI * 34, fg = ring.querySelector('.mon-ring-fg'), hr = ring.querySelector('.mon-ring-hour');
  // the outer arc: the 4h candle so far; the bright arc: the last hour, once it's on
  fg.style.strokeDasharray = `${C}`; fg.style.strokeDashoffset = `${C * (toClose / H4)}`;
  hr.style.strokeDasharray = `${C * (MONITOR_LEAD / H4)} ${C}`; hr.style.strokeDashoffset = `${-C * (1 - MONITOR_LEAD / H4)}`;
  ring.dataset.phase = w.phase;
  ring.querySelector('.mon-left').textContent = left(toClose);
  ring.querySelector('.mon-phase').textContent = w.phase === 'late' ? 'final minutes' : w.phase === 'watch' ? 'watching' : hm(w.close);
  st.root.querySelector('.mon-kick').textContent = `The ${hm(w.close)} close`;
}

function paintStatus() {
  if (!st.root) return;
  paintClock();
  const s = st.root.querySelector('.mon-status'), w = windowAt(), d = st.data, btn = st.root.querySelector('#monNow');
  if (btn) { btn.disabled = st.running; btn.textContent = st.running ? `Checking ${st.done}/${PAIRS.length}…` : 'Check now'; }
  if (!s) return;
  const fresh = d && d.close === w.close;
  s.textContent = st.running ? `Checking ${PAIRS.length} pairs…`
    : w.on ? `${fresh ? `Checked ${hm(d.at)} · next ${hm(Math.min(d.at + dueEvery(w), w.close))}` : 'Checking soon'} · every ${w.phase === 'late' ? 'minute' : '5 minutes'} until the close${d?.errors.length ? ` · couldn’t read ${d.errors.map(coin).join(', ')}` : ''}`
    : `Watching starts ${hm(w.opens)}, an hour before the close${d ? ` · below: the ${hm(d.at)} check, for the ${hm(d.close)} close` : ''}`;
}

function visibleRows() {
  const d = st.data; if (!d) return [];
  return d.rows.filter(r => (r.state !== 'near' || (r.atr != null ? r.atr <= prefs.reach : r.toGo <= 0.01))
    && (prefs.side === 'all' || r.side === prefs.side)
    && (!prefs.tradeable || r.p?.risk?.pct > 0)
    && (!prefs.pinnedOnly || prefs.pins.includes(r.symbol)));
}

// one lane's cards, in the order they show: pinned first, then the ones with size, then the closest
const laneRows = (rows, key) => rows.filter(r => r.state === key).sort((a, b) => (prefs.pins.includes(b.symbol) - prefs.pins.includes(a.symbol)) || (b.p?.risk?.pct > 0) - (a.p?.risk?.pct > 0) || (a.atr ?? a.toGo) - (b.atr ?? b.toGo) || Math.abs(a.inside) - Math.abs(b.inside));

function paint() {
  paintStatus();
  const d = st.data, stale = d && d.close !== windowAt().close;
  st.root.classList.toggle('mon-stale', Boolean(stale));
  paintBtc(d?.mk);
  paintResult();
  const rows = visibleRows();
  const counts = st.root.querySelector('.mon-counts');
  counts.replaceChildren(...LANES.map(l => { const n = rows.filter(r => r.state === l.key).length; const c = el('div', `mon-count c-${l.key}`); c.title = l.tip; c.append(el('b', '', n), el('span', '', l.title)); return c; }));
  for (const l of LANES) {
    const col = st.root.querySelector(`.mon-lane[data-lane="${l.key}"]`), body = col.querySelector('.mon-lane-body');
    const list = laneRows(rows, l.key);
    col.querySelector('.mon-lane-n').textContent = list.length;
    body.replaceChildren(...(list.length ? list.map(card) : [el('p', 'mon-empty muted small', !d ? (windowAt().on ? 'Checking…' : 'Nothing checked yet. It starts an hour before the close, or press Check now.') : l.key === 'near' ? `Nothing within ${prefs.reach} ATR` : 'None')]));
  }
}

// BTC at a glance: its own candle against its levels, the NY bias, its 1h RSI, the EMA100, the golden zone
function paintBtc(mk) {
  const box = st.root.querySelector('.mon-btc'); if (!box) return;
  if (!mk) { box.replaceChildren(el('span', 'muted small', 'BTC: read at the first check')); return; }
  const f = st.ctx.fmt.price, chip = (label, val, cls = '', tip = '') => { const c = el('span', 'mon-chip ' + cls); c.append(el('small', '', label), el('b', '', val)); if (tip) c.title = tip; return c; };
  const bias = mk.ny?.bias, l = mk.btcLevel;
  const rsiL = btcRsiTag('Long', mk.rsiNow)?.kind, rsiS = btcRsiTag('Short', mk.rsiNow)?.kind;
  const zl = mk.zone?.('Long'), zs = mk.zone?.('Short');
  box.replaceChildren(
    el('b', 'mon-btc-t', '₿ BTC'),
    chip('Price', mk.btcCur ? f(mk.btcCur.c) : '—'),
    chip('NY bias', bias === 'bullish' ? '▲ Bullish' : bias === 'bearish' ? '▼ Bearish' : 'Flat', bias === 'bullish' ? 'pos' : bias === 'bearish' ? 'neg' : '', 'The last NY session’s direction: setups with it grade A or better'),
    chip('Swept', mk.btcSides.length ? mk.btcSides.map(s => (s === 'Long' ? 'its low ▲' : 'its high ▼')).join(' · ') : 'nothing yet', mk.btcSides.length ? 'warn' : '', 'BTC sweeping the same side this candle lifts an A to A++'),
    chip('1h RSI', mk.rsiNow != null ? Math.round(mk.rsiNow) + (rsiL === 'cool' ? ' 🧊 longs' : rsiS === 'cool' ? ' 🧊 shorts' : rsiL === 'chase' ? ' ⚠️ ran up' : rsiS === 'chase' ? ' ⚠️ ran down' : '') : '—', '', '🧊 cooled off (35–45 the trade’s way) helps; ⚠️ already ran means A+ / A++ / B / C take the 🪜 ladder'),
    chip('EMA100', mk.ema100Up == null ? '—' : mk.ema100Up ? 'above' : 'below', '', 'Shorts while BTC is above its 4h EMA100 get no size'),
    chip('Golden zone', zl && zs ? 'both' : zl ? '✨ longs' : zs ? '✨ shorts' : 'no', zl || zs ? 'pos' : ''),
    chip('BTC level', l ? `${l.kind === 'high' ? 'high' : 'low'} ${f(l.price)} · ${l.state === 'near' ? pc(l.toGo) + ' away' : l.state}` : 'none near', l && l.state !== 'near' ? 'warn' : ''),
  );
}

// after the close: what the candidates did
function paintResult() {
  const box = st.root.querySelector('.mon-result'), r = st.result;
  if (!box) return;
  box.hidden = !r || windowAt().close - r.close > H4 + MONITOR_LEAD;   // until the next window's first check
  if (box.hidden) return;
  const yes = r.list.filter(x => x.signalled), no = r.list.filter(x => !x.signalled && x.was !== 'near');
  const chip = (x, ok) => { const c = el('span', 'mon-res ' + (ok ? 'ok' : 'no'), `${ok ? '✅' : '✕'} ${coin(x.symbol)} ${x.side === 'Short' ? '▼' : '▲'}${x.grade ? ' · ' + x.grade : ''}`); c.title = ok ? 'Signalled at the close: it’s on the Signals tab' : `Was ${x.was === 'swept' ? 'swept' : 'through'} at the last check, but didn’t close as a signal`; return c; };
  box.replaceChildren(el('b', 'mon-res-t', `The ${hm(r.close)} close`), ...(yes.length || no.length ? [...yes.map(x => chip(x, true)), ...no.map(x => chip(x, false))] : [el('span', 'muted small', 'None of the candidates signalled.')]));
}

// one pair: the level, the 15m bars of the forming candle, the preview
function card(r) {
  const f = st.ctx.fmt.price, short = r.side === 'Short', p = r.p || {}, pinned = prefs.pins.includes(r.symbol);
  const c = el('article', `mon-card s-${r.state}` + (pinned ? ' pinned' : '') + (r.isNew || r.became ? ' fresh' : ''));
  c.tabIndex = 0;
  const top = el('div', 'mon-card-top');
  const pin = el('button', 'mon-pin' + (pinned ? ' on' : ''), pinned ? '★' : '☆'); pin.type = 'button'; pin.title = pinned ? 'Unpin' : 'Pin this pair to the top';
  pin.onclick = e => { e.stopPropagation(); prefs.pins = pinned ? prefs.pins.filter(x => x !== r.symbol) : [...prefs.pins, r.symbol]; save(); paint(); };
  const name = el('b', 'mon-coin', coin(r.symbol));
  const side = el('span', 'mon-side ' + (short ? 'neg' : 'pos'), short ? '▼ Short' : '▲ Long');
  top.append(pin, name, side);
  const god = isGodTier(r.side, p.full, r.lean, p.grade ? { grade: p.grade, from: p.from, skip: p.skip } : null);
  if (p.grade) { const g = el('span', `sig-grade ${gradeKey(p.grade)} mon-grade` + (p.sure ? '' : ' maybe') + (god ? ' god' : ''), (god ? '🔱 ' : '') + gradeLabel(p.grade)); g.title = (god ? godTip(r.side) + '\n\n' : '') + `${p.sure ? 'Grade if it closes here' : 'Grade if it sweeps and closes back (the candle’s shape can still change it)'}: ${p.grade}, ${p.why}`; top.append(g); }
  // the tags as small pills: in your favour | warnings | plan notes, the same groups as the Signals tab
  { const box = el('span', 'mon-tags'); tagList(r).forEach((g, i) => { if (i) box.append(el('span', 'tag-sep')); for (const x of g) { const k = el('span', x.cls + ' tone-' + x.tone, x.pill); k.title = x.title; box.append(k); } }); if (box.childElementCount) top.append(box); }
  if (r.isNew) top.append(el('span', 'mon-flag', 'new'));
  else if (r.became) top.append(el('span', 'mon-flag', r.became === 'swept' ? 'just swept' : r.became === 'beyond' ? 'went through' : 'back off'));
  else if (r.move) { const m = el('span', 'mon-move ' + (r.move > 0 ? 'closer' : 'away'), r.move > 0 ? '↗ closer' : '↘ away'); m.title = 'Since the last check'; top.append(m); }
  c.append(top, spark(r));
  // the numbers
  const grid = el('div', 'mon-nums');
  const num = (k, v, cls = '', tip = '') => { const d = el('div'); d.append(el('small', '', k), el('b', cls, v)); if (tip) d.title = tip; return d; };
  const dist = r.state === 'near' ? `${pc(r.toGo)}${r.atr != null ? ` · ${r.atr.toFixed(1)} ATR` : ''}` : r.state === 'swept' ? `${pc(r.inside)} inside` : `${pc(-r.inside)} past`;
  grid.append(num('Level', f(r.price)), num('Price', f(r.px)), num(r.state === 'near' ? 'To go' : 'Now', dist, r.state === 'swept' ? 'pos' : r.state === 'beyond' ? 'warn' : ''),
    num('Size', p.risk ? (p.risk.pct ? `${+p.risk.pct.toFixed(2)}%` : 'none') : '—', p.risk?.pct ? 'pos' : 'muted', p.risk ? p.risk.why : ''));
  c.append(grid);
  // the plan, once it's a signal: entry, stop, target, R:R
  if (p.trade) {
    const t = p.trade, plan = el('div', 'mon-plan');
    plan.append(
      el('span', 'mon-plan-e', p.how ? `🪜 ${f(p.rungs?.[0] ?? t.entry)}–${f(p.rungs?.at(-1) ?? t.entry)}` : `At the close ${f(t.entry)}`),
      el('span', 'neg', `SL ${f(t.sl)}`), el('span', 'pos', `TP ${f(t.tp)} → trail`), el('b', '', `${p.rr.toFixed(1)}R`));
    plan.title = p.how === 'chase' ? 'BTC’s RSI already ran: the 🪜 ladder, 5 limits 70–90% back' : p.how === 'away' ? 'Closed away from the level: the 🪜 ladder, 5 limits 70–90% back' : 'Entry at the 4h close';
    c.append(plan);
  }
  const foot = el('div', 'mon-foot muted small');
  // each piece hovers with its own explanation
  const bits = [
    r.pos != null && [`${Math.round(r.pos * 100)}% of 7d range`, `Where the price sits in the last 7 days’ range: 0% the low, 100% the high. ${short ? 'Shorts near the top' : 'Longs near the bottom'} sweep the more obvious extremes.`],
    r.more?.length && [`+${r.more.length} more level${r.more.length > 1 ? 's' : ''}`, 'Also near: ' + r.more.map(m => `${f(m.price)} (${m.state})`).join(', ')],
  ].filter(Boolean);
  bits.forEach(([t, tip], i) => { if (i) foot.append(' · '); const sp = el('span', '', t); sp.title = tip; foot.append(sp); });
  if (foot.textContent) c.append(foot);
  const go = () => openChart(r);
  c.onclick = go; c.onkeydown = e => { if (e.key === 'Enter') go(); };
  return c;
}

// the forming 4h candle on 15m bars (with the two hours before it, faded), the level, and the zone past it
function spark(r) {
  const W = 260, H = 64, pad = 3, bars = (r.bars || []).filter(b => b.t >= r.cur.t - 2 * HOUR);
  const box = el('div', 'mon-spark');
  if (!bars.length) return box;
  const hi = Math.max(r.price, ...bars.map(b => b.h)), lo = Math.min(r.price, ...bars.map(b => b.l)), span = hi - lo || hi * 0.001;
  const y = v => pad + (H - 2 * pad) * (1 - (v - lo) / span);
  const n = 24, bw = (W - 2 * pad) / n, x = i => pad + i * bw;
  const t0 = r.cur.t - 2 * HOUR, short = r.side === 'Short', ly = y(r.price);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  svg += `<rect class="sp-past" x="0" y="${short ? 0 : ly}" width="${W}" height="${short ? ly : H - ly}"/>`;
  svg += `<rect class="sp-now" x="${x(8)}" y="0" width="${W - x(8)}" height="${H}"/>`;
  for (const b of bars) {
    const i = Math.round((b.t - t0) / M15); if (i < 0 || i >= n) continue;
    const up = b.c >= b.o, cx = x(i) + bw / 2, cls = (up ? 'sp-up' : 'sp-dn') + (b.t < r.cur.t ? ' sp-old' : '');
    svg += `<line class="${cls}" x1="${cx}" x2="${cx}" y1="${y(b.h)}" y2="${y(b.l)}"/><rect class="${cls}" x="${x(i) + bw * 0.18}" y="${y(Math.max(b.o, b.c))}" width="${bw * 0.64}" height="${Math.max(1, Math.abs(y(b.o) - y(b.c)))}"/>`;
  }
  svg += `<line class="sp-level" x1="0" x2="${W}" y1="${ly}" y2="${ly}"/></svg>`;
  box.innerHTML = svg;
  box.title = `15m bars: the forming 4h candle (from ${hm(r.cur.t)}) and the 2 hours before it. Dashed: the level; shaded: past it.`;
  return box;
}

// every tag on a card, for the chart's header row: the same names and hovers as on the Signals tab
function tagList(r) {
  const p = r.p || {}, short = r.side === 'Short', L = [], add = (tone, pill, text, cls, title) => L.push({ tone, pill, text, cls, title });
  if (r.whale) { const ws = r.whale === 'absorbed' && short; add(r.whale === 'absorbed' ? (short ? 'info' : 'good') : 'warn', r.whale === 'absorbed' ? '🐋' : '⚠️ $', r.whale === 'absorbed' ? '🐋 Whale Absorption' : '⚠️ Crowded', 'sig-whale ' + r.whale, TAG_TIPS['whale:' + r.whale + (ws ? ':Short' : '')]); }
  if (r.lean?.on) add('good', '🔥', short ? '🔥 Sellers Positioning' : '🔥 Buyers Positioning', 'sig-lean', `So far: ${(r.lean.share * 100).toFixed(1)}% of the last 24h’s market orders were ${short ? 'sells' : 'buys'}, more than in ${Math.round(r.lean.rank * 100)}% of the past month’s 24h windows (the forming candle counts as it stands).\n\n${TAG_TIPS['lean:' + r.side]}`);
  if (r.nyx?.at) add('good', '🗽', short ? '🗽 At NY high' : '🗽 At NY low', 'sig-nyx', `This one: level ${st.ctx.fmt.price(r.price)}, the previous NY session’s ${short ? 'high' : 'low'} ${st.ctx.fmt.price(short ? r.nyx.high : r.nyx.low)} (${Math.abs(r.nyx.d).toFixed(2)} ATR away).\n\n` + TAG_TIPS['nyx:' + r.side]);
  const tg = sweepTag(r.side, p.grade, r.late);
  if (tg) add('good', tg === 'late' ? '⏳' : '⚡', tg === 'late' ? '⏳ Late sweep' : '⚡ Early sweep', 'sig-late ' + tg, `First went past the level at ${hm(r.late.at)}, in the candle’s ${tg === 'late' ? 'second' : 'first'} half.${p.sure ? '' : ' (If the grade holds.)'}\n\n${TAG_TIPS[tg]}`);
  if (p.rsiK) add(p.rsiK.kind === 'cool' ? 'good' : 'warn', p.rsiK.kind === 'cool' ? '🧊' : '⚠️ RSI', p.rsiK.kind === 'cool' ? '🧊 RSI' : '⚠️ RSI', 'sig-btcrsi ' + p.rsiK.kind, `${p.rsiK.text}.\n\n${TAG_TIPS['rsi:' + p.rsiK.kind] || ''}`);
  if (r.kz) add('warn', '⚔️', '⚔️ Killzone', 'sig-kz', `⚔️ Killzone: a ${r.kz.days}-day ${short ? 'falling' : 'rising'} 4h trendline through two wick tips meets this level at ${st.ctx.fmt.price(r.kz.at)}, ${r.kz.dist.toFixed(2)} ATR from it (boxed on the chart).\nWhy it matters: trendline and level traders watch the same price, so it’s where the fight happens. It breaks more often than it holds: within 24h about half the time.\nTracking only.`);
  if (p.shape?.away) add('info', '🕯️', p.shape.engulf === 'wick' ? '🕯️ Wick engulf' : p.shape.engulf === 'body' ? '🕯️ Body engulf' : '🕯️ Away', 'sig-shape' + (p.shape.engulf ? ' ' + p.shape.engulf : ''), `So far, as the candle stands.\n\n${TAG_TIPS[p.shape.engulf ? 'engulf' : 'away']}`);
  return ['good', 'warn', 'info'].map(t => L.filter(x => x.tone === t)).filter(g => g.length);
}
// the chart's header row: the grade and side, then the tags grouped like the Signals tab's
function tagChips(r) {
  const p = r.p || {}, short = r.side === 'Short', out = [];
  const god = isGodTier(r.side, p.full, r.lean, p.grade ? { grade: p.grade, from: p.from, skip: p.skip } : null);
  if (p.grade) out.push({ text: (god ? '🔱 ' : '') + gradeLabel(p.grade) + (p.sure ? '' : ' ?'), cls: `sig-grade ${gradeKey(p.grade)}` + (god ? ' god' : ''), title: (god ? godTip(r.side) + '\n\n' : '') + `${p.sure ? 'Grade if it closes here' : 'Grade if it sweeps and closes back (the candle’s shape can still change it)'}: ${p.grade}, ${p.why}` });
  out.push({ text: short ? '▼ Short' : '▲ Long', cls: 'rg-tag', title: short ? 'A swept high: a short if it closes back below the level' : 'A swept low: a long if it closes back above the level' });
  for (const g of tagList(r)) { out.push({ text: '', cls: 'tag-sep', title: '' }); for (const x of g) out.push({ text: x.text, cls: x.cls + ' tone-' + x.tone, title: x.title }); }
  return out;
}

// the 4h chart with the level drawn, and a short card on the left about where it stands.
// ← → (or the buttons) step through every card on the board, lane by lane, in the order they show.
function openChart(r) {
  const order = LANES.flatMap(l => laneRows(visibleRows(), l.key)), list = order.includes(r) ? order : [r];
  const items = list.map(chartItem);
  st.ctx.openReplay(items[list.indexOf(r)], items, { apiJson: st.ctx.apiJson, compact: true, nav: { prev: '‹ Previous', next: 'Next ›', count: (i, n) => `${i} of ${n} on the board` }, fmt: { money: st.ctx.fmt.money, price: st.ctx.fmt.price, dateTime: st.ctx.fmt.dateTime, duration: () => '' } });
}
function chartItem(r) {
  const f = st.ctx.fmt.price, short = r.side === 'Short', d = st.data, now = Math.min(Date.now(), d.close), p = r.p || {};
  const what = r.state === 'swept' ? `Wick to **${f(r.wick)}**, back inside at **${f(r.px)}**: signals if it closes ${short ? 'below' : 'above'} **${f(r.price)}**.`
    : r.state === 'beyond' ? `Past the level at **${f(r.px)}**: needs to close back ${short ? 'below' : 'above'} **${f(r.price)}**.`
    : `${short ? 'High' : 'Low'} so far **${f(r.wick)}**: ${pc(r.toGo)} more${r.atr != null ? ` (${r.atr.toFixed(1)} ATR)` : ''} to sweep **${f(r.price)}**.`;
  const steps = [what];
  if (r.nyx?.at) steps.push(`🗽 At NY ${short ? 'high' : 'low'}: the level is ${Math.abs(r.nyx.d).toFixed(2)} ATR from the previous NY session’s ${short ? 'high' : 'low'} (**${f(short ? r.nyx.high : r.nyx.low)}**). Backtest plan trades here won ${short ? '36% vs 27%' : '34% vs 28%'} elsewhere. Tracking only.`);
  if (r.kz) steps.push(`⚔️ Killzone: a ${r.kz.days}-day ${short ? 'falling' : 'rising'} trendline (dotted purple) meets this level at **${f(r.kz.at)}**, boxed on the chart. These broke within 24h about half the time. Tracking only.`);
  if (p.grade) steps.push(`${p.sure ? 'Grade' : 'Grade if it signals'}: **${p.grade}**${p.risk ? `, ${p.risk.pct ? `risk **${+p.risk.pct.toFixed(2)}%**` : 'no size'}` : ''}.`);
  if (p.trade) steps.push(`${p.how ? `🪜 ${p.rungs.map(x => `**${f(x)}**`).join(' · ')}` : `Entry at the close **${f(p.trade.entry)}**`}, stop **${f(p.trade.sl)}**, TP **${f(p.trade.tp)}** then trail: **${p.rr.toFixed(1)}R**.`);
  const t = {
    symbol: r.symbol, category: 'linear', dir: r.side, entry: r.px, exit: r.px, size: 0, leverage: 1, pnl: 0, fees: 0, funding: 0,
    openedAt: r.t, time: now, duration: now - r.t,
    view: {
      interval: '240',
      title: `${r.symbol} · ${short ? 'high' : 'low'} ${f(r.price)} · the ${hm(d.close)} close`,
      guide: {
        history: { title: 'Tags', chips: tagChips(r), rows: [], proj: null }, outcome: null,
        context: `Checked ${hm(d.at)}. The level formed ${new Date(r.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${r.pos != null ? `, at ${Math.round(r.pos * 100)}% of the 7-day range` : ''}.`,
        sections: [{ key: 'entry', title: short ? 'Swing high' : 'Swing low', figure: f(r.price), sub: LANES.find(l => l.key === r.state).title.toLowerCase(), state: r.state === 'near' ? 'wait' : 'done', badge: LANES.find(l => l.key === r.state).title, steps }],
      },
      lines: [{ price: r.price, color: 'ink', from: r.t, to: d.start }, ...(p.trade ? [{ price: p.trade.sl, color: 'neg', after: true, title: 'SL' }, { price: p.trade.tp, color: 'pos', after: true, title: 'TP' }] : [])],
      boxes: killzoneBox(r.kz, r.price, r.kzAtr, r.cur.t),
      trendlines: r.kz ? [{ from: r.kz.from, to: r.kz.to, end: r.cur.t + 12 * H4, color: '#8b5cf6' }] : [],
      marks: [{ t: r.t, position: short ? 'aboveBar' : 'belowBar', shape: 'circle', color: 'ink', tip: [`Swing ${short ? 'high' : 'low'} · level ${f(r.price)}`] }, ...killzoneMark(r.kz, r.price, r.cur.t, r.side, f, r.whale === 'absorbed')],
      note: 'The level is drawn from the swing that made it. The last candle is the one still forming.',
    },
  };
  return t;
}
