// Signals: every 4h swing failure signal on the default pairs, with the same
// rules and filters as the Telegram alerts (sfp.js ALERT_SETTINGS), so the
// site and the bot always agree. The Signals tab lists them all; the dashboard
// shows the latest few. Candles come from the IndexedDB cache in signal-chart.js.
import { ladderTrade, ladderWhy, detect, H4, ALERT_SETTINGS, DEFAULT_PAIRS, trendMap, btcSide, gradeSetup, rsi, GRADE_ORDER, btcRsiTag, candleShape, limitTrade, tierOf, scalePlan, emaGuard, SHORT_EMA, atrAt, goldenRR, goldenRaw, fullSweep, FAR_LOCK, whaleAbsorption, WHALE_TIP, winModel, projectWin, signalTags } from './sfp.js';
import { sessionList, nyBiasAt, nyFadeAt, fadesNy, nyPullbackAt, inGoldenZone } from './bias.js';
import { setupName, proposedRisk, picksAt } from './day-playbook.js';
import { idbGet, idbSet } from './db.js';
import { fmtDuration } from './metrics.js';
import { candlesFor, pool, showOnChart, bindCharts, adds, setAdds, outcomeOf, outcomeIn, hooks } from './signal-chart.js';

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
let ctx_ = null, lastSignals = [];
// An open position's original plan, from the signal it was opened on: same coin and side, the closest
// close within 4½h of when it opened. Of that signal's two plans (at the close, or the 70% limit) the one
// whose entry is nearest the position's. Lets the battery keep measuring R after the stop moves to entry.
export function planFor(pos) {
  if (!pos?.openedAt || !lastSignals.length) return null;
  const near = lastSignals.filter(s => s.symbol === pos.symbol && s.side === pos.dir && Math.abs(s.t + H4 - pos.openedAt) <= 4.5 * 3_600_000)
    .sort((a, b) => Math.abs(a.t + H4 - pos.openedAt) - Math.abs(b.t + H4 - pos.openedAt))[0];
  if (!near) return null;
  const t = [near.atClose, near.trade].filter(x => x && !x.missed).sort((a, b) => Math.abs(a.entry - pos.entry) - Math.abs(b.entry - pos.entry))[0];
  // past the target the plan trails: the stop for the last closed 4h candle, from the signal's own walk
  const sc = t?.scaled?.trailing ? t.scaled : t?.trailing ? t : null;
  return t ? { entry: t.entry, sl: t.sl, tp: t.tp, rr: t.rr, signal: near, trailing: Boolean(sc), trailStop: sc?.trailStop ?? null } : null;
}
export function loadSignals(ctx, days) {
  bindCharts(ctx); ctx_ = ctx;
  const candle = Math.floor(Date.now() / H4);
  if (held && held.candle === candle && held.days >= days) return held.p.then(r => ({ ...r, signals: r.signals.filter(s => s.t >= Date.now() - days * DAY) }));
  const p = compute(days);
  p.then(r => { lastSignals = r.signals; }).catch(() => {});
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
      const last = candles.at(-1), r14 = rsi(candles);
      const flow = await flowFor(symbol, since - 35 * DAY).catch(() => null);      // 🐋 funding + taker volume, optional
      const byT = new Map(candles.map(c => [c.t, c]));
      return detect(candles, o).signals.filter(s => s.t >= since).map(s => {
        // how it's doing now, for signals younger than 24h
        const run = last && last.t > s.t ? (s.side === 'Short' ? s.close - last.c : last.c - s.close) / s.close : null;
        const shape = candleShape(candles[s.k - 1], candles[s.k], s.side);
        // closed away from the level: the plan is a 🪜 ladder of 5 limits 70–90% back toward the wick, not the close.
        // The ladder is worked out for the others too: once graded, an A+ / A++ / B / C whose BTC RSI already ran
        // takes it as well (ladderWhy, below)
        const short = s.side === 'Short', lad = shape?.ladder ? ladderTrade(candles, s.k, s.trade, short, shape.ladder) : null;
        const trade = shape?.away && lad ? { ...lad, ladderWhy: 'away' } : s.trade;
        const best = bestRs(candles, s.k, trade, short);
        const alt = !shape?.away && lad ? { trade: { ...lad, ladderWhy: 'chase' }, best: bestRs(candles, s.k, lad, short) } : null;
        return { ...s, trade, best, alt, atClose: s.trade, atr: atrAt(candles, s.k), full: fullSweep(s, t => byT.get(t)), symbol, running: run, rsi: r14[s.k], shape, whale: flow ? whaleAbsorption(s.side, s.t, flow) : null };
      });
    } catch (e) { errors.push(symbol); progress.pairs.set(symbol, 'err'); notify(); return []; }
  });
  progress.stage = 'btc'; notify();
  const btc = await candlesFor('BTCUSDT', start - 20 * DAY);
  const trends = trendMap(btc, o.trendEma), trends100 = trendMap(btc, SHORT_EMA);
  // for the grade: BTC's own SFPs (same rules) and the NY session bias from BTC's 1h candles
  const btcSfp = new Set(detect(btc, o).signals.map(s => `${s.t}:${s.side}`));
  let sessions = null;
  let h1 = [];
  try { h1 = await hourly('BTCUSDT', since - 7 * DAY); sessions = sessionList(h1, { from: since - 7 * DAY }); } catch {}
  // the NY fade at each close (for C++), read once per close
  const fadeMemo = new Map(), fadeAt = T => { if (!fadeMemo.has(T)) fadeMemo.set(T, nyFadeAt(h1, T)); return fadeMemo.get(T); };
  // ✨ BTC's pullback from the last NY session at each close (the golden-zone tag at 12:00 / 16:00)
  // BTC's 1h RSI at each close (the 🧊 / ⚠️ tag), from the hour that closed with it
  const h1rsi = rsi(h1), rsiAt = new Map(h1.map((c, i) => [c.t + H1, h1rsi[i]]));
  const pullMemo = new Map(), pullAt = T => { if (!pullMemo.has(T)) pullMemo.set(T, nyPullbackAt(h1, T)); return pullMemo.get(T); };
  const signals = per.flat().map(s => {
    const trend = btcSide(s, trends, o.neutralBand);
    const ny = sessions ? nyBiasAt(sessions, s.t + H4) : null;
    const bRsi = btcRsiTag(s.side, rsiAt.get(s.t + H4))?.kind ?? null;
    const pull = pullAt(s.t + H4), golden = inGoldenZone(s.side, pull, new Date(s.t + H4).getHours()) ? pull.back : null;
    const grade = sessions ? emaGuard(tierOf(gradeSetup(s.side, { ny, swept: btcSfp.has(`${s.t}:${s.side}`), rsi: s.rsi, fade: fadesNy(s.side, fadeAt(s.t + H4)) }), { shape: s.shape, full: s.full, grr: goldenRaw(s.atClose ?? s.trade, s.atr), btcRsi: bRsi, rr: (s.atClose ?? s.trade)?.rr ?? null, whale: s.whale?.kind ?? null, zone: golden != null }), s.side, trends100.get(s.t - H4)?.up) : null;
    const gradeC = grade;
    const btcRsi = gradeC && !['C', 'C++'].includes(gradeC.grade) ? btcRsiTag(s.side, rsiAt.get(s.t + H4)) : null;   // with the NY bias only
    // ⚠️ BTC's RSI already ran the trade's way on an A+ / A++ / B / C: the 🪜 ladder, not the close
    const chase = s.alt && ladderWhy(gradeC?.grade, bRsi, s.shape) === 'chase';
    const { alt, ...rest } = s;
    return { ...rest, ...(chase ? { trade: alt.trade, best: alt.best } : {}), trend, counter: trend === 'counter', btc: trends.get(s.t - H4) || null, ny, grade: gradeC, golden, btcRsi, goldenRR: goldenRR(gradeC?.grade, s.atClose ?? s.trade, s.atr) };
  }).sort((a, b) => b.t - a.t || a.symbol.localeCompare(b.symbol));
  markPicks(signals);
  // the projected win rate's model, from this year of closed signals (kept for the dashboard's two weeks)
  if (days >= 180) {
    const models = { adds: winModel(signals, s => wonOf(s, true)), first: winModel(signals, s => wonOf(s, false)) };
    if (models.adds && models.first) { savedModels = models; try { localStorage.setItem(MODEL_KEY, JSON.stringify(models)); } catch {} }
    savedHist = historyOf(signals); try { localStorage.setItem(HIST_KEY, JSON.stringify(savedHist)); } catch {}
  }
  progress.stage = 'done'; notify();
  return { signals, errors, at: Date.now(), days };
}

// for the Monitoring tab: BTC's 1h candles and a pair's funding + taker flow, from the same caches
export function monitorHelpers(ctx) { if (!ctx_) ctx_ = ctx; return { hourly, flowFor }; }
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

// what each grade is, in a sentence (the grade checkboxes and the ⓘ on the grade stats)
// the size the playbook gives a grade, read from proposedRisk on a Tuesday: the main closes and the late ones
function sizeNote(g) {
  const tue = h => { const d = new Date(); d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7)); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const at = h => proposedRisk(g, tue(h), { from: 'A' }).pct;
  const main = [8, 12, 16].map(at), late = [0, 4].map(at), lateTxt = late.some(Boolean) ? `, ${late[0] === late[1] ? `${late[0]}% at 00:00 / 04:00` : late.map((x, i) => `${x}% at ${['00:00', '04:00'][i]}`).join(', ')}` : '';
  const s = g === 'S++' || g === 'S+' || g === 'S' ? 'as the A grade under it (A+ / A++ 1%, A 0.5%), at the main closes Mon–Thu'
    : main.some(Boolean) ? `${Math.max(...main)}% at the main closes Mon–Thu${lateTxt}` : late.some(Boolean) ? lateTxt.slice(2) : g === 'C++' || g === 'C+' ? 'tracking only, no size' : 'skip';
  return s + (main.some(Boolean) || late.some(Boolean) ? '. Weekends, ⛔ closes and EMA100 shorts get none.' : '');
}
const GRADE_DEF = { 'S++': 'An S+, or an A / A+ with 🐋 whale absorption, that’s also a ⭐ golden R:R in the ✨ golden zone (BTC pulled back from the NY session; it stands in for S’s BTC cool-off here). Sized as the A grade under it', S: 'An A or A+ with 🐋 Whale Absorption (funding against your side and the sweep candle’s selling, or buying, absorbed) while BTC’s 1h RSI has 🧊 cooled off (35–45). Sized as the A grade under it', 'S+': 'An A-grade setup that’s both a 💥 full swing failure (swept the swing candle’s wick) and a ⭐ golden R:R', 'A++': 'With the NY bias, outside the NY session, and BTC swept the same way', 'A+': 'With the NY bias, outside the NY session, 4h RSI stretched the trade’s way (no BTC sweep)', A: 'With the NY bias outside the session (or with a BTC sweep during it)', 'B+': 'A B whose 4h RSI is stretched the trade’s way (long under 40, short over 60)', B: 'With the NY bias, but during the NY session', 'C++': 'A C that fades a 2%+ NY session at its last close (NY fade): tracking only', 'C+': 'An A-grade setup whose candle engulfed the previous one (body or wick): a 🪜 ladder 70–90% back, tracking only', C: 'Against the NY bias' };

// ---- projected win rate (projectWin in sfp.js) ----
const MODEL_KEY = 'perp-dojo:win-model-v1';
let savedModels = null;
try { savedModels = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null'); } catch {}
// won (target or 🛡️ lock) / lost / null (open or never filled), with the adds or the first entry alone
function wonOf(s, withAdds) {
  const t = s.trade;
  if (!t || t.missed || t.pending) return null;
  const r = withAdds && t.scaled ? t.scaled.result : t.result;
  return r === 'open' || r == null ? null : r === 'win' || r === 'lock';
}
const TAG_NAMES = { full: '💥 Full SFP', body: 'Body-only sweep', 'whale:absorbed': '🐋 Whale Absorption', 'whale:crowded': '⚠️ Crowded funding', grr: '⭐ Golden R:R', nypull: '✨ NY pullback', 'rsi:cool': '🧊 BTC RSI cooled off', 'rsi:chase': '⚠️ BTC RSI already ran', 'rsi:deep': '⚠️ BTC oversold / overbought', engulf: '🕯️ Engulf', away: '🕯️ Closed away', ema: '⚠️ Short above EMA100', 'trend:aligned': 'Aligned with BTC', 'trend:counter': 'Countertrend', 'trend:neutral': 'BTC neutral' };
function projOf(s) {
  const m = savedModels?.[adds.on ? 'adds' : 'first'];
  return m ? projectWin(s, m) : null;
}
function projTip(pr) {
  const m = savedModels?.[adds.on ? 'adds' : 'first'], pc = x => `${Math.round(x * 100)}%`, pts = x => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(0)} pts`;
  const lines = [`Projected win rate ≈${pc(pr.p)}`, `• Grade ${pr.grade.g}: ${pc(pr.grade.p)} (${pr.grade.n} closed)`,
    ...pr.parts.filter(q => Math.abs(q.pts) >= 0.5).map(q => `• ${TAG_NAMES[q.tag] || q.tag}: ${pts(q.pts)} (${q.n} closed)`)];
  if (pr.combo) lines.push(`Exactly this grade + tags before: ${pr.combo.w} of ${pr.combo.n} won (${pc(pr.combo.w / pr.combo.n)})`);
  lines.push('', `From ${m ? m.n.toLocaleString() : 'the'} closed signals of the past year, ${adds.on ? 'with the adds (a stop at entry or break-even isn’t a win)' : 'first entry only'}. Won = target or 🛡️ lock. Each tag’s effect is measured on top of its grade and pulled toward zero when the sample is small. A guide, not a promise.`);
  return lines.join('\n');
}
const projChip = s => {
  const pr = projOf(s); if (!pr) return null;
  const c = el('span', 'sig-proj ' + (pr.p >= 0.3 ? 'hi' : pr.p >= 0.18 ? 'mid' : 'lo'), `≈${Math.round(pr.p * 100)}% win`);
  c.title = projTip(pr);
  return c;
};

// ---- each grade's, and each exact grade + tags', record over the past year (the chart guide's header) ----
// Wrong-time setups are left out, as on the Signals page by default. Both modes: with the adds / first entry.
const HIST_KEY = 'perp-dojo:signal-history-v1';
let savedHist = null;
try { savedHist = JSON.parse(localStorage.getItem(HIST_KEY) || 'null'); } catch {}
const histKey = s => s.grade.grade + '|' + [...signalTags(s)].sort().join(',');
function historyOf(signals) {
  const h = { at: Date.now(), from: Infinity, adds: {}, first: {} };
  for (const s of signals) {
    if (!s.grade || wrongTime(s)) continue;
    for (const mode of ['adds', 'first']) {
      const o = outcomeIn(s.trade, mode === 'adds');
      if (!o || o.result === 'open' || o.net == null) continue;
      h.from = Math.min(h.from, s.t);
      for (const k of ['g:' + s.grade.grade, histKey(s)]) {
        const x = (h[mode][k] ||= { n: 0, w: 0, b: 0, sum: 0, top: [] });
        x.n++; x.sum += o.net;
        if (o.result === 'win' || o.result === 'lock') x.w++; else if (o.result === 'be') x.b++;
        x.top.push(o.net); x.top.sort((a, b) => b - a); x.top.length = Math.min(3, x.top.length);
      }
    }
  }
  return h;
}
const histRow = (label, x, title) => {
  if (!x) return { label, title, n: 0 };
  const sum = a => a.reduce((n, v) => n + v, 0), wo3 = x.n > 3 ? (x.sum - sum(x.top)) / (x.n - 3) : null, avg = x.sum / x.n;
  return { label, title, n: x.n, wins: x.w, bes: x.b, losses: x.n - x.w - x.b, avg, avgText: rText(avg), wo3, wo3Text: rText(wo3), thin: x.n < 10 };
};
hooks.history = s => {
  if (!s.grade) return null;
  const g = s.grade.grade, tags = signalTags(s), H = savedHist?.[adds.on ? 'adds' : 'first'];
  const chips = [{ text: gradeLabel(g), cls: 'sig-grade ' + gradeKey(g), title: `Grade ${g}: ${GRADE_DEF[g] || ''}` },
    ...tags.map(t => ({ text: TAG_NAMES[t] || t, cls: 'rg-tag' + (/^(ema|rsi:chase|rsi:deep|whale:crowded|trend:counter)$/.test(t) ? ' warn' : /^(whale:absorbed|grr|nypull|rsi:cool|full)$/.test(t) ? ' good' : '') }))];
  const pr = projOf(s);
  const proj = pr ? { text: `≈${Math.round(pr.p * 100)}% win projected`, cls: pr.p >= 0.3 ? 'hi' : pr.p >= 0.18 ? 'mid' : 'lo', title: projTip(pr) } : null;
  if (!H) return { title: 'History', chips, proj, rows: [], note: 'Open the Signals tab on 180 days or more once to build this record.' };
  const exact = H[histKey(s)], gr = H['g:' + g];
  const days = Math.round((Date.now() - savedHist.from) / 86_400_000);
  return {
    title: `History · past ${days > 400 ? Math.round(days / 365) + ' years' : 'year'}`, chips, proj,
    rows: [histRow('This grade + these tags', exact, 'Signals with exactly this grade and every one of these tags'), histRow(`All ${g}`, gr, `Every grade ${g} signal`)],
    note: [`${adds.on ? 'With the adds' : 'First entry only'}, after fees, wrong-time setups left out. Won = target or 🛡️ lock.`,
      exact && exact.n < 10 ? `Only ${exact.n} with exactly this combination: read it with the grade’s row.` : !exact ? 'No finished signal had exactly this combination.' : ''].filter(Boolean).join(' '),
  };
};

// ⓘ what a setup is made of, in words: the grade and why, the size, every tag, the levels, the plan
function setupInfo(s) {
  const f = (tab.ctx || ctx_)?.fmt?.price || (x => String(x)), pc = x => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
  const short = s.side === 'Short', L = [];
  L.push(`${short ? '▼ Short' : '▲ Long'} ${coin(s.symbol)} · 4h close ${new Date(s.t + H4).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  if (s.grade) {
    L.push('', `Grade ${s.grade.grade}${s.grade.from ? ` (built on ${s.grade.from})` : ''}: ${s.grade.why}`);
    const r = riskOf(s); if (r) L.push(`Size: ${r.pct ? `${r.pct}% risk` : 'no size'}, ${r.why}`);
  } else L.push('', 'No grade: the NY bias couldn’t be read');
  const lv = s.levels.map(l => f(l.price)).join(', ');
  L.push('', `Swept: ${short ? 'swing high' : 'swing low'} level${s.levels.length > 1 ? 's' : ''} ${lv} (the swing candle’s body), wick ${pc(s.sweepPct)} past it, closed back inside`);
  if (s.range?.pos != null) L.push(`Where: ${Math.round(s.range.pos * 100)}% up the last 7 days’ range`);
  const tags = [];
  tags.push(s.full ? '💥 Full swing failure: the wick also took the swing candle’s own wick' : 'Body-only sweep: the wick took the swing’s body, not its wick');
  if (s.whale) tags.push(s.whale.text);
  if (s.goldenRR) tags.push('⭐ Golden R:R: a 10–20R target within 10 ATR');
  if (s.golden != null) tags.push(`✨ NY pullback: BTC gave back ${s.golden > 1 ? 'all' : Math.round(s.golden * 100) + '%'} of the last NY move`);
  if (s.btcRsi) tags.push(s.btcRsi.text);
  if (s.shape?.away) tags.push(`🕯️ ${s.shape.engulf ? (s.shape.engulf === 'wick' ? 'Wick engulf' : 'Body engulf') : 'Closed away'}: 🪜 5 limits 70–90% back (${(s.shape.ladder || [s.shape.limit]).map(f).join(', ')}) instead of the close${s.trade?.ladder ? `, ${s.trade.ladder.filled.length} of ${s.trade.ladder.prices.length} filled` : ''}`);
  if (s.trade?.ladderWhy === 'chase') tags.push(`⚠️ BTC RSI already ran: 🪜 5 limits 70–90% back (${s.trade.ladder.prices.map(f).join(', ')}), a fifth of the risk each`);
  if (s.grade?.skip === 'ema') tags.push('⚠️ A short while BTC is above its 4h EMA100: no size');
  if (s.trend) tags.push({ aligned: 'BTC 4h trend: aligned with the trade', counter: 'BTC 4h trend: against the trade (countertrend)', neutral: 'BTC 4h trend: neutral (within 1% of its EMA50)' }[s.trend]);
  if (s.ny?.bias) tags.push(`NY bias: ${s.ny.bias}${s.ny.during ? ', NY session open' : ''}`);
  L.push('', 'Tags:', ...tags.map(t => '• ' + t));
  const t = s.trade;
  if (t) L.push('', `Plan: entry ${f(t.entry)}${t.ladder ? ' (🪜 ladder average)' : t.limit ? ' (limit)' : ''} · stop ${f(t.sl)} (the wick) · target ${f(t.tp)} (the opposing level) · ${t.rr.toFixed(1)}R · ${pc(t.riskPct)} to the stop`);
  const pr = projOf(s);
  if (pr) L.push(`Projected win rate ≈${Math.round(pr.p * 100)}%${pr.combo ? ` · this exact grade + tags before: ${pr.combo.w} of ${pr.combo.n} won` : ''}`);
  return L.join('\n');
}
const infoBtn = s => { const b = el('span', 'sig-info', 'i'); b.title = setupInfo(s); b.tabIndex = 0; b.setAttribute('aria-label', 'What this setup is made of'); return b; };

// 🐋 order flow (funding settlements, Binance 4h taker volume) from `start`, cached; only the newest part is re-read
async function flowFor(symbol, start) {
  const key = `flow:${symbol}`;
  let have = (await idbGet(key).catch(() => null)) || null;
  if (have && (have.from > start || !have.taker)) have = null;
  const from = have ? Math.max(start, Math.min(have.funding.at(-1)?.t ?? start, have.taker.at(-1)?.t ?? start) - 2 * DAY) : start;
  const fresh = await ctx_.apiJson(`/api/flow?${new URLSearchParams({ symbol, start: from, end: Date.now() })}`);
  const merge = (a = [], b = []) => [...new Map([...a, ...b].map(x => [x.t, x])).values()].sort((x, y) => x.t - y.t);
  const all = { from: have?.from ?? start, funding: merge(have?.funding, fresh.funding), taker: merge(have?.taker, fresh.taker) };
  idbSet(key, all).catch(() => {});
  return all;
}

// ---- shared bits ----
// A++ gets a gold star; the others a small letter
const GRADES = ['S++', 'S+', 'S', 'A+', 'A++', 'A', 'B+', 'C++', 'C+', 'B', 'C'];
const gradeKey = g => 'g-' + g.toLowerCase().replace(/\+/g, 'plus');
const gradeLabel = g => (g === 'A++' ? '★ A++' : g === 'S++' ? '💎 S++' : g === 'S+' ? '👑 S+' : g === 'S' ? '🐋 S' : g === 'C+' ? '🕯️ C+' : g);
const SETUPS_IN = { 'A++': ['🌃 Late A++'], A: ['🌙 Midnight sweep'], 'B+': ['🌊 NY fade'] };
// As the alerts mark them: ⛔ a good grade at a close the plan skips
// with more takeable setups than the plan takes (the best grade first, then the highest R:R).
const GOOD = new Set(['S++', 'S+', 'S', 'A++', 'A+', 'A', 'B+']);
const riskOf = s => (s.grade ? proposedRisk(s.grade.grade, s.t + H4, { tag: s.grade.tag, from: s.grade.from, skip: s.grade.skip }) : null);
const wrongTime = s => Boolean(s.trade && s.grade && GOOD.has(s.grade.grade) && !s.grade.skip && riskOf(s).pct === 0);
function markPicks(signals) {
  const byClose = new Map();
  for (const s of signals) { if (!s.trade || !(riskOf(s)?.pct > 0)) continue; if (!byClose.has(s.t)) byClose.set(s.t, []); byClose.get(s.t).push(s); }
  for (const g of byClose.values()) {
    const max = picksAt(g[0].t + H4);
    if (g.length <= max) continue;
    g.sort((a, b) => GRADE_ORDER.indexOf(a.grade.grade) - GRADE_ORDER.indexOf(b.grade.grade) || b.trade.rr - a.trade.rr);
    g.slice(0, max).forEach(s => (s.pick = true));
    g.slice(max).forEach(s => (s.passed = true));
  }
  return signals;
}
// the signals with the plan entered at the close (the bot and the forward test enter there, so they compare against that)
export const atCloseSignals = list => list.map(s => (s.atClose && s.atClose !== s.trade ? { ...s, trade: s.atClose } : s));
// The furthest a trade went in its favour before it ended, in R of the first entry: from the candle after
// the entry (or the limit's fill) through the candle it ended in. { single, scaled } for the two result modes.
function bestRs(candles, k, t, short) {
  if (!t || t.missed || t.pending) return null;
  const risk = Math.abs(t.entry - t.sl); if (!(risk > 0)) return null;
  const from = t.fillT != null ? candles.findIndex(c => c.t === t.fillT) : k + 1;
  const upTo = exitT => { let best = 0; for (let i = Math.max(from, k + 1); i < candles.length; i++) { const c = candles[i]; best = Math.max(best, (short ? t.entry - c.l : c.h - t.entry) / risk); if (exitT != null && c.t >= exitT) break; } return best; };
  return { single: upTo(t.exitT), scaled: t.scaled ? upTo(t.scaled.exitT) : null };
}
// A small battery for a signal tile: the risk block, then one block per R (or per few R on a far target,
// at most 12) up to the target, outlined green; the +7R lock block outlined gold on a far target.
// .set(R, live) lights it up to R.
function miniBattery(rr) {
  const box = el('div', 'bat-cells mini');
  if (!(rr > 0)) return Object.assign(box, { set() {} });
  const per = Math.max(1, Math.ceil(rr / 12)), n = Math.max(1, Math.ceil(rr / per)), far = rr >= FAR_LOCK.rr;
  const risk = el('span', 'cell risk'), cells = [];
  for (let i = 0; i < n; i++) {
    const lo = i * per, hi = Math.min(rr, (i + 1) * per), c = el('span', 'cell' + (i === n - 1 ? ' tp' : '') + (far && lo < FAR_LOCK.at && FAR_LOCK.at <= hi ? ' lock-at' : ''));
    c.dataset.lo = lo; c.dataset.hi = hi; cells.push(c);
  }
  box.append(risk, ...cells);
  box.set = (v, live) => {
    risk.classList.toggle('lit', v < 0); risk.style.setProperty('--f', Math.min(1, Math.max(0, -v)));
    box.reached = Math.max(box.reached || 0, v); box.querySelector('.lock-at')?.classList.toggle('lock', box.reached >= FAR_LOCK.at);
    for (const c of cells) { const lo = +c.dataset.lo, hi = +c.dataset.hi, f = Math.max(0, Math.min(1, (v - lo) / (hi - lo))); c.classList.toggle('lit', f > 0); c.style.setProperty('--f', f); }
    box.title = `stop −1R · now ${rText(v)}${live ? ' (live)' : ''} · target +${rr.toFixed(1)}R${per > 1 ? ` · each block ${per}R` : ''}${far ? ` · 🛡️ at +${FAR_LOCK.at}R lock +${FAR_LOCK.to}R` : ''}`;
  };
  // the furthest it got, as a faint fill behind (a trade that came back)
  box.ghost = b => { box.reached = Math.max(box.reached || 0, b); box.querySelector('.lock-at')?.classList.toggle('lock', b >= FAR_LOCK.at); for (const c of cells) { const lo = +c.dataset.lo, hi = +c.dataset.hi; c.style.setProperty('--g', Math.max(0, Math.min(1, (b - lo) / (hi - lo)))); } box.classList.add('ghosted'); box.title += ` · got to +${b.toFixed(1)}R`; };
  return box;
}
// The Signals table's trade cell: the battery (lit to the result, the best R behind it as a ghost on a
// trade that came back) over one line of prices: entry → stop · target · R:R
function tradeCell(s, o, f) {
  const td = el('td', 'sig-trade-c'), t = s.trade;
  if (!t) { td.textContent = '—'; return td; }
  // the battery is price: the first entry's R:R long, lit to where price ended (or is now)
  const rr = t.rr, withAdds = adds.on && o?.rr && o.rr > rr + 0.05 ? o.rr : null, bat = miniBattery(rr), pos = pricePos(s);
  if (!o || o.result !== 'open') bat.classList.add('still');      // only a trade that's still open gets the moving stripes
  bat.set(pos, false);
  const b = bestOf(s); if (b != null && b > Math.max(0, pos)) bat.ghost(b);
  const line = el('small', 'muted', `${t.ladder ? `🪜${t.ladder.filled.length || ''} ` : t.limit ? 'LO ' : ''}${f(t.entry)} · SL ${f(t.sl)} · TP ${f(t.tp)}`);
  line.title = `${t.ladder ? `🪜 Ladder: 5 limits 70–90% back at ${t.ladder.prices.map(f).join(', ')}; ${t.ladder.filled.length} filled, averaging ` : t.limit ? 'Limit entry (70% back) ' : 'Entry at the close '}${f(t.entry)} · stop ${f(t.sl)} · target ${f(t.tp)} · ${rr.toFixed(1)}R to the target on the first entry${withAdds ? `, ${withAdds.toFixed(1)}R if both adds fill` : ''}${t.limit ? ` · the candle closed at ${f(t.close)}` : ''}`;
  td.append(bat, line);
  return td;
}
const setupOf = s => (s.grade ? setupName(s.grade.grade, s.t + H4, s.grade.tag) : null);
const gradeChip = s => {
  if (!s.grade) return null;
  const g = s.grade.grade, name = setupOf(s), wt = wrongTime(s);
  const chip = el('span', 'sig-grade ' + gradeKey(g) + (wt ? ' wrong-time' : ''), gradeLabel(g) + (name ? ' ' + name.split(' ')[0] : '') + (wt ? ' ⛔' : ''));
  chip.title = (wt ? '⛔ Wrong time: the plan skips this grade at this close\n\n' : '') + setupInfo(s);
  chip.style.cursor = 'help';
  return chip;
};
// ✨ BTC in golden zone / NY pullback (12:00 and 16:00 closes): tracking only
// 💥 Full swing failure: the wick went past the swing candle's own wick, not just its body
const fullChip = s => {
  if (!s.full) return null;
  const c = el('span', 'sig-full', '💥 Full SFP');
  c.title = 'Full swing failure: the wick ran past the swing candle’s own wick, not just its body, taking the stops beyond the visible extreme.\nOver 5 years, A grades like this (at plan times, EMA100 shorts left out) were positive in every year: +0.55R a trade on 515.';
  return c;
};
// 🐋 Whale Absorption (or ⚠️ crowded): funding + taker flow on the signal candle, tracking only
const whaleChip = s => {
  if (!s.whale) return null;
  const c = el('span', 'sig-whale ' + s.whale.kind, s.whale.kind === 'absorbed' ? '🐋 Whale Absorption' : '⚠️ Crowded');
  c.title = s.whale.text + '\n\n' + WHALE_TIP;
  return c;
};
// ⭐ Golden R:R: an A grade with a 10–20R target (from the close) within 10 ATR: tracking only
const goldenRRChip = s => {
  if (!s.goldenRR) return null;
  const c = el('span', 'sig-golden', '⭐ Golden R:R');
  c.title = `${(s.atClose ?? s.trade).rr.toFixed(1)}R from the close, the target within 10 times the coin’s average 4h range: room to pay, but reachable.\nTracking only. Over 5 years, A grades like this made +1.05R a trade (+0.55R without the best 3), positive in 4 of 5 years.`;
  return c;
};
const goldenChip = s => {
  if (s.golden == null) return null;
  const c = el('span', 'sig-golden', '✨ Golden zone');
  c.title = `BTC in golden zone / NY pullback: BTC had given back ${s.golden > 1 ? 'all of the last NY session’s move and more' : `${Math.round(s.golden * 100)}% of the last NY session’s move`}, the way this setup trades.\nTracking only. At the 12:00 close, A-grades with it made +1.34R a trade in the backtest, those without −0.33R.`;
  return c;
};
// 🧊 BTC cooled off / ⚠️ BTC stretched, from BTC's 1h RSI at the close (tracking only)
const btcRsiChip = s => {
  if (!s.btcRsi) return null;
  const t = s.btcRsi, c = el('span', 'sig-btcrsi ' + t.kind, t.kind === 'cool' ? '🧊 RSI' : '⚠️ RSI');
  c.title = t.text + '\nBTC’s 1h RSI, read from this setup’s side. Backtest (A-grades, main closes): 35–45 made +2.90R a trade without the best 3, ≤35 −0.22R, ≥60 −0.17R. Tracking only.';
  return c;
};
// 🕯️ closed away from the level (a limit back toward the wick beats the close), engulfs named
const shapeChip = s => {
  const sh = s.shape; if (!sh?.away || !s.trade) return null;
  const c = el('span', 'sig-shape' + (sh.engulf ? ' ' + sh.engulf : ''), sh.engulf === 'wick' ? '🕯️ Wick engulf' : sh.engulf === 'body' ? '🕯️ Body engulf' : '🕯️ Away');
  c.title = `${sh.engulf === 'wick' ? 'Closed past the previous candle’s wick. ' : sh.engulf === 'body' ? 'Closed past the previous candle’s body, not its wick. ' : ''}The candle already closed the trade’s way, far from the level: a 🪜 ladder of 5 limits 70–90% back toward the wick (${(sh.ladder || [sh.limit]).map(x => (tab.ctx || ctx_).fmt.price(x)).join(', ')}), each a fifth of the risk, instead of chasing the close. Tracking only.`;
  return c;
};
// ⚠️ a short while BTC is above its 4h EMA100: the plan skips it
const emaChip = s => {
  if (s.grade?.skip !== 'ema') return null;
  const c = el('span', 'sig-btcrsi chase', '⚠️ EMA100');
  c.title = 'A short while BTC is above its 4h EMA100. Shown, but the plan gives it no size and the Dojo Bot passes: over 5 years these shorts lost every year (−0.28R a trade across all signals).';
  return c;
};
const pctS = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(2) + '%');
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const coin = s => s.replace(/USDT$/, '');
const rText = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`);
// The R:R to show. A closed trade that reached the target and went out on the trail shows the R:R the trail
// got on the first entry instead of the target's (still in its tooltip); every other trade shows the target's.
export function rrShown(t) {
  if (t?.trail && t.result === 'win' && Number.isFinite(t.R)) return { v: t.R, tp: t.rr, trailed: true };
  return { v: t?.rr ?? null, tp: t?.rr ?? null, trailed: false };
}
// "9.1R ↗": a trailed one, past its target (↗) or let go before it (↘); its tooltip says both
export function rrEl(tag, cls, t) {
  const r = rrShown(t), e = document.createElement(tag);
  e.className = cls + (r.trailed ? ' rr-trail ' + (r.v >= r.tp ? 'up' : 'down') : '');
  e.textContent = r.v == null ? '—' : `${r.v.toFixed(1)}R${r.trailed ? (r.v >= r.tp ? ' ↗' : ' ↘') : ''}`;
  e.title = r.v == null ? '' : r.trailed
    ? `🏁 Trailed: the target was ${r.tp.toFixed(1)}R; the trail past it got out at ${r.v.toFixed(1)}R on the first entry (${r.v >= r.tp ? '+' : '−'}${Math.abs(r.v - r.tp).toFixed(1)}R ${r.v >= r.tp ? 'more' : 'less'} than closing at the target)`
    : `${r.v.toFixed(1)}R to the target on the first entry`;
  return e;
}
// Bybit's standard fees, in R: a market entry at the close, a stop-market at the stop and on the trail
// past the target (a limit at a fixed target). Tight stops make fees a big share of 1R.
const TAKER = 0.00055, MAKER = 0.0002;
const afterFees = t => t.net ?? t.R - (TAKER + (t.result === 'win' && !t.trail ? MAKER : TAKER)) / t.riskPct;
// 4h candles close on the hour, so no minutes: "Nov 3, 8 PM"
const closeTime = t => new Date(t + H4).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
const ago = t => { const h = (Date.now() - (t + H4)) / 3_600_000; return h < 1 ? 'just now' : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
const trendChip = s => el('span', 'sig-trend ' + (s.trend || 'none'), s.trend ? TREND[s.trend] : 'BTC ?');
// the 24h result once there is one, otherwise how it's doing so far
// the trade's result in R: won, stopped, or where it stands while open
const result = s => {
  if (s.trade?.missed) return { label: 'LO missed', v: null };
  if (s.trade?.pending) return { label: 'LO pending', v: null };
  const o = outcomeOf(s.trade);
  if (!o) return { label: 'no target', v: null };
  if (o.result === 'win') return { label: o.trail ? 'TP → trailed' : 'target hit', v: o.R };
  if (o.result === 'loss') return { label: 'stopped', v: o.R };
  if (o.result === 'entry') return { label: 'stopped at entry', v: o.R };
  if (o.result === 'be') return { label: 'break-even stop', v: o.R };
  if (o.result === 'lock') return { label: '🛡️ locked +3R', v: o.R };
  return { label: o.exitT === null && o.R === 0 ? 'new' : o.trailing ? 'trailing' : 'open', v: o.R === 0 ? null : o.R };
};
const open = (s, list) => showOnChart(s, list);

// R so far for a signal that's still in its first candle: the latest 5m close against its stop (cached for a minute)
const liveMemo = new Map();
function liveR(s) {
  const key = s.symbol + ':' + Math.floor(Date.now() / 60_000);
  if (!liveMemo.has(key)) {
    const qs = new URLSearchParams({ category: 'linear', symbol: s.symbol, interval: '5', start: Date.now() - 30 * 60_000, end: Date.now() });
    liveMemo.set(key, ctx_.apiJson('/api/klines?' + qs).then(r => r.candles.at(-1)?.c ?? null).catch(() => null));
  }
  return liveMemo.get(key).then(px => {
    const t = s.trade, risk = Math.abs(t.entry - t.sl), d = s.side === 'Short' ? -1 : 1;
    if (!px || !risk) return null;
    // with the adds on, the adds already filled at the last close count too, as in the closed result
    const o = outcomeOf(t), legs = [{ px: t.entry, size: 1 }];
    if (adds.on && o?.adds) legs.push(...(scalePlan(t, s.side)?.adds || []).slice(0, o.adds).map(a => ({ px: a.price, size: a.size })));
    const r = legs.reduce((n, l) => n + l.size * d * (px - l.px), 0) / risk;
    return Object.assign(new Number(r), { move: d * (px - t.entry) / risk });   // the P&L in R, and where price is in R (for the battery)
  });
}
// Where price stands for the battery, in R of the first entry between the stop (−1) and the target (its
// R:R). Not the P&L: with the adds a win pays more than the distance, and a stop at the entry pays −1R.
function pricePos(s) {
  const t = s.trade, o = outcomeOf(t);
  if (!t || !o) return 0;
  if (o.result === 'win') return o.trail && t.trail ? t.R : t.rr;              // out on the trail: where it let go
  if (o.result === 'loss') return -1;
  if (o.result === 'entry' || o.result === 'be') return 0;
  if (o.result === 'lock') return FAR_LOCK.to;
  return t.R ?? 0;                                                   // open: price at the last 4h close
}

// ---- dashboard widget: the latest few ----
// four beside the open positions, eight when they have the row to themselves
const latestCount = () => ($('#posCard').hidden && innerWidth > 560 ? 8 : 4);
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
    // a square: ▲ ONDO + grade on top, the result big, then the close and BTC's trend
    const top = el('div', 'sig-top');
    top.append(...[gradeChip(s)].filter(Boolean));
    // the ✨ golden zone and BTC's RSI read as small pills: orange when stretched or extended, blue when cooled off
    if (goldenChip(s)) { const g = el('span', 'sig-pill gold', '✨'); g.title = goldenChip(s).title; top.append(g); }
    if (s.btcRsi) { const r = el('span', 'sig-pill ' + (s.btcRsi.kind === 'cool' ? 'cool' : 'warn'), 'RSI'); r.title = s.btcRsi.text; top.append(r); }
    if (fullChip(s)) { const k = el('span', 'sig-pill full', '💥'); k.title = fullChip(s).title; top.append(k); }
    if (goldenRRChip(s)) { const k = el('span', 'sig-pill gold', '⭐'); k.title = goldenRRChip(s).title; top.append(k); }
    { const pc = projChip(s); if (pc) { const k = el('span', 'sig-pill proj ' + pc.className.split(' ').pop(), pc.textContent.replace('≈', '').replace(' win', '')); k.title = pc.title; top.append(k); } }
    if (whaleChip(s)) { const k = el('span', 'sig-pill ' + (s.whale.kind === 'absorbed' ? 'whale' : 'warn'), s.whale.kind === 'absorbed' ? '🐋' : '⚠️ $'); k.title = whaleChip(s).title; top.append(k); }
    if (emaChip(s)) { const k = el('span', 'sig-pill warn', 'EMA'); k.title = emaChip(s).title; top.append(k); }
    if (shapeChip(s)) { const k = el('span', 'sig-pill candle', '🕯️'); k.title = shapeChip(s).title; top.append(k); }
    const tc = trendChip(s); tc.classList.add('sig-trend-top'); tc.title = `BTC’s 4h trend: ${tc.textContent}`; tc.textContent = { aligned: 'Aligned', counter: 'Counter', neutral: 'Neutral' }[s.trend] || 'BTC ?'; top.append(tc);
    // the grade stays left; the tags sit in their own group on the right, and a second line hugs the right edge too
    const tagBox = el('div', 'sig-top-tags'); tagBox.append(...[...top.children].slice(1)); top.append(tagBox);
    const name = el('div', 'sig-coin ' + (short ? 'neg' : 'pos'));
    name.append(el('b', '', `${short ? '▼' : '▲'} ${coin(s.symbol)}`));
    if (s.trade) {
      const t = el('span', 'sig-target'), r = rrEl('span', '', s.trade);
      t.append(el('i', '', rrShown(s.trade).trailed ? '🏁' : '🎯'), r);
      t.title = rrShown(s.trade).trailed ? r.title : `Target: the opposing level, ${s.trade.rr.toFixed(1)}R from the entry. Once it’s touched the stop trails each closed 4h candle`;
      name.append(t);
    }
    const mid = el('div', 'sig-mid');
    mid.append(el('span', 'sig-res ' + cls(res.v), res.v === null ? '—' : rText(res.v)), el('span', 'muted small', `${short ? 'short' : 'long'} · ${res.label}`));
    // still open (or inside its first 4h candle): R from the live price, not the last 4h close
    if (s.trade && !s.trade.missed && !s.trade.pending && (res.label === 'new' || res.label === 'open')) liveR(s).then(r => {
      if (r === null) return;
      const move = r.move; r = +r;
      const v = mid.querySelector('.sig-res'); v.className = 'sig-res ' + cls(r); v.textContent = rText(r);
      mid.querySelector('.muted').textContent = `${short ? 'short' : 'long'} · ${res.label === 'new' ? 'live' : 'open · live'}`;
      v.title = res.label === 'new' ? 'So far, from the live price: its first 4h candle hasn’t closed yet' : `Now, from the live price${adds.on && outcomeOf(s.trade)?.adds ? ', with the adds filled so far' : ''}. At the last 4h close: ${rText(res.v ?? 0)}`;
      // the battery too (it's built further down; this runs after)
      bar.set(move, true);
    });
    // where it stands, as the open position's battery: the 1R at risk, then blocks up to the target
    const rr = s.trade?.rr || 0, bar = miniBattery(rr);
    bar.set(pricePos(s), false);
    if (outcomeOf(s.trade)?.result !== 'open') bar.classList.add('still');
    const bot = el('div', 'sig-bot');
    bot.append(el('span', 'muted small', `${closeTime(s.t)} · ${ago(s.t)}`));
    b.classList.add(short ? 'short' : 'long');
    // the bar with its ends priced: the stop on the left, the entry, the target on the right
    const pf = v => String(Number(v.toPrecision(5)));
    const track = el('div', 'sig-track');
    if (s.trade) {
      const ends = el('div', 'sig-ends');
      ends.append(el('span', 'neg', pf(s.trade.sl)), el('span', 'pos', pf(s.trade.tp)));
      ends.title = `stop ${pf(s.trade.sl)} · entry ${pf(s.trade.entry)} · target ${pf(s.trade.tp)}`;
      track.append(bar, ends);
    }
    b.append(top, name, mid, ...(s.trade ? [track] : []), bot);
    b.onclick = () => open(s, list);
    return b;
  }));
}

// ---- Signals tab ----
const tab = { days: 365, pair: 'all', side: 'all', trend: 'all', golden: 'all', rsi: 'all', shape: 'all', setup: 'all', ema: 'all', grr: 'all', full: 'all', whale: 'all', status: 'all', noWrong: false, noBE: false, grades: new Set(GRADES), sort: { key: 't', dir: -1 }, shown: 100, wired: false, data: null, busy: false };
const GRADE_KEY = 'perp-dojo:signal-grades';
// B+ and C++ came later: a saved choice from before them shows each wherever B (or C) was ticked
try {
  const g = JSON.parse(localStorage.getItem(GRADE_KEY) || 'null');
  // v4: the old A+ is now A++, and the new A+ was part of A: keep each tick where it was
  const v4 = !Array.isArray(g) || g.includes('v4') ? [] : [...(g.includes('A+') ? ['A++'] : []), ...(g.includes('A') ? ['A+'] : [])];
  if (Array.isArray(g)) tab.grades = new Set([...g.map(x => (x === 'C+' && !g.includes('v6') ? 'C++' : x)), ...v4, ...(g.includes('v5') ? [] : ['S']), ...(g.includes('v7') ? [] : ['C+']), ...(g.includes('v9') ? [] : ['S']), ...(g.includes('v10') ? [] : ['S++']), ...(g.includes('v8') ? [] : ['S+']), ...(g.includes('B') && !g.includes('v2') && !g.includes('v3') && !g.includes('v4') ? ['B+'] : []), ...(g.includes('C') && !g.includes('v3') && !g.includes('v4') ? ['C++'] : [])].filter(x => GRADES.includes(x)));
} catch {}
// a signal without a grade (the NY bias couldn't be read) shows only when every grade is ticked
const WRONG_KEY = 'perp-dojo:sig-hide-wrong-time-v2';
tab.noWrong = true;                                      // wrong-time signals hidden unless you show them
try { const v = localStorage.getItem(WRONG_KEY); if (v !== null) tab.noWrong = v === '1'; } catch {}
const gradeOk = s => (s.grade ? tab.grades.has(s.grade.grade) : tab.grades.size === GRADES.length);

export function renderSignalsView(ctx) {
  bindCharts(ctx);
  tab.ctx = ctx;
  if (!tab.wired) {
    tab.wired = true;
    $('#sigPeriod').onchange = e => { tab.days = Number(e.target.value); tab.shown = 100; load(ctx); };
    $('#sigRefresh').onclick = () => { held = null; load(ctx); };
    $('#sigMode').value = adds.on ? 'adds' : 'first';
    $('#sigMode').onchange = e => { setAdds(e.target.value === 'adds'); paint(); };
    for (const [id, k] of [['#sigPair', 'pair'], ['#sigSide', 'side'], ['#sigTrendF', 'trend'], ['#sigGoldF', 'golden'], ['#sigRsiF', 'rsi'], ['#sigShapeF', 'shape'], ['#sigSetupF', 'setup'], ['#sigEmaF', 'ema'], ['#sigGrrF', 'grr'], ['#sigFullF', 'full'], ['#sigWhaleF', 'whale'], ['#sigStatusF', 'status']])
      $(id).onchange = e => { tab[k] = e.target.value; tab.shown = 100; paint(); };
    const saveGrades = () => { try { localStorage.setItem(GRADE_KEY, JSON.stringify([...tab.grades, 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'])); } catch {} };
    // one button ticks every grade, or clears them all when they're all ticked
    const allBtn = el('button', 'grade-all'); allBtn.type = 'button';
    const syncAll = () => { const all = tab.grades.size === GRADES.length; allBtn.textContent = all ? 'None' : 'All'; allBtn.title = all ? 'Untick every grade' : 'Tick every grade'; };
    allBtn.onclick = () => {
      const on = tab.grades.size !== GRADES.length;
      tab.grades = new Set(on ? GRADES : []);
      for (const b of $('#sigGradeF').querySelectorAll('input[type=checkbox]')) b.checked = on;
      saveGrades(); syncAll(); tab.shown = 100; paint();
    };
    $('#sigGradeF').replaceChildren(allBtn, ...GRADES.map(g => {
      const lab = el('label', 'grade-check'), box = el('input'); box.type = 'checkbox'; box.value = g; box.checked = tab.grades.has(g);
      box.onchange = () => {
        box.checked ? tab.grades.add(g) : tab.grades.delete(g);
        saveGrades(); syncAll();
        tab.shown = 100; paint();
      };
      lab.append(box, el('span', 'sig-grade ' + gradeKey(g), gradeLabel(g)));
      lab.title = GRADE_DEF[g];
      return lab;
    }));
    syncAll();
    // ⛔ wrong time: a good grade at a close the plan skips
    const wl = el('label', 'grade-check wrong-check'), wb = el('input'); wb.type = 'checkbox'; wb.checked = tab.noWrong;
    wb.onchange = () => { tab.noWrong = wb.checked; try { localStorage.setItem(WRONG_KEY, wb.checked ? '1' : '0'); } catch {} tab.shown = 100; paint(); };
    wl.append(wb, el('span', '', 'Hide ⛔ wrong time')); wl.title = 'Leave out good grades at a close the plan skips (weekends, and the closes marked ⛔ in the Strategy tab)';
    $('#sigWrongSlot').replaceWith(wl);
    // B/E: trades stopped at the whole position's break-even after both adds (only with the adds on)
    const bl = el('label', 'grade-check wrong-check be-check'), bb = el('input'); bb.type = 'checkbox'; bb.checked = tab.noBE;
    bb.onchange = () => { tab.noBE = bb.checked; tab.shown = 100; paint(); };
    bl.append(bb, el('span', '', 'Hide B/E trades')); bl.title = 'Leave out trades stopped at break-even after both adds (with the adds on; a single entry never ends at B/E)';
    wl.after(bl);
    const btn = $('#sigFiltBtn'), panel = $('#sigFiltPanel');
    $('#sigFiltReset').onclick = () => { for (const f of FILTERS) f.clear(); tab.shown = 100; paint(); };
    // The filters as rows of pills, always in view: each dropdown's options become pills (click one to
    // use it, again to clear it), the two checkboxes become toggles. The dropdowns stay underneath, hidden,
    // so everything else (the chips' clear, saved state) works as before. The pair list stays a dropdown.
    const bar = panel; bar.hidden = false; bar.className = 'sig-pillbar'; bar.removeAttribute('role');
    btn.closest('.sig-more').replaceWith(...[]);
    $('#sigView').before(bar);
    for (const lab of [...bar.querySelectorAll(':scope > label')]) {
      const sel = lab.querySelector('select'), name = lab.querySelector('span')?.textContent || '';
      if (!sel) continue;
      const g = el('div', 'sig-pg'); g.title = lab.title || ''; g.append(el('span', 'sig-pg-n', name));
      if (sel.id === 'sigPair') { sel.classList.add('sig-pg-sel'); g.append(sel); lab.replaceWith(g); continue; }
      for (const o of [...sel.options].filter(o => o.value !== 'all')) {
        const pb = el('button', 'sig-fpill', o.textContent); pb.type = 'button'; pb.dataset.sel = sel.id; pb.dataset.v = o.value;
        pb.onclick = () => { sel.value = sel.value === o.value && sel.querySelector('option[value="all"]') ? 'all' : o.value; sel.dispatchEvent(new Event('change')); };
        g.append(pb);
      }
      sel.hidden = true; g.append(sel); lab.replaceWith(g);
    }
    const tg = el('div', 'sig-pg'); tg.append(el('span', 'sig-pg-n', 'Hide'));
    for (const [lab, txt] of [[wl, '⛔ Wrong time'], [bl, 'B/E trades']]) {
      const box = lab.querySelector('input'), pb = el('button', 'sig-fpill', txt); pb.type = 'button'; pb.title = lab.title; pb.dataset.box = '1';
      pb.onclick = () => box.click(); pb._box = box; tg.append(pb); lab.hidden = true; tg.append(lab);
    }
    $('#sigFiltReset').before(tg);
    const box = (name, ids) => { const b = el('div', 'sig-fbox'); b.append(el('div', 'sig-fbox-n', name)); const body = el('div', 'sig-fbox-b'); b.append(body);
      for (const id of ids) { const g = id === 'hide' ? tg : bar.querySelector('#' + id)?.closest('.sig-pg'); if (g) { const lbl = g.querySelector('.sig-pg-n'); if (lbl) lbl.textContent = { sigPair: 'Pair', sigSide: 'Side', sigStatusF: 'Status', sigMode: 'Results', sigTrendF: 'Trend', sigRsiF: '1h RSI', sigEmaF: 'EMA100', sigGoldF: 'NY pullback', sigSetupF: 'Setup', sigFullF: 'Sweep', sigWhaleF: 'Whale', sigShapeF: 'Candle', sigGrrF: 'R:R', hide: 'Hide' }[id] ?? lbl.textContent; body.append(g); } }
      return b; };
    const reset = $('#sigFiltReset');
    bar.replaceChildren(box('Trade', ['sigPair', 'sigSide', 'sigStatusF', 'sigMode']), box('BTC', ['sigTrendF', 'sigRsiF', 'sigEmaF', 'sigGoldF']), box('Setup', ['sigSetupF', 'sigFullF', 'sigWhaleF', 'sigShapeF', 'sigGrrF']), box('Hide', ['hide']), reset);
    // collapse / expand: collapsed, only the filters in use show, as chips (click one to clear it). Remembered.
    const FKEY = 'perp-dojo:sig-filters-collapsed', head = el('div', 'sig-fhead'), tog = el('button', 'sig-ftoggle'); tog.type = 'button';
    const chips = $('#sigFiltChips'); chips.hidden = false;
    head.append(tog, chips); bar.before(head);
    const setCollapsed = on => { bar.hidden = on; head.classList.toggle('collapsed', on); tog.setAttribute('aria-expanded', String(!on)); tog.innerHTML = `<i>${on ? '▸' : '▾'}</i> Filters`; try { localStorage.setItem(FKEY, on ? '1' : '0'); } catch {} };
    tog.onclick = () => setCollapsed(!bar.hidden);
    let fc = false; try { fc = localStorage.getItem(FKEY) === '1'; } catch {}
    setCollapsed(fc);
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

// the results of the shown list, for the bar above the table
function viewStats(list) {
  const os = list.map(s => ({ s, o: outcomeOf(s.trade) }));
  const done = os.filter(x => x.o && x.o.result !== 'open'), nets = done.map(x => x.o.net), sorted = [...nets].sort((a, b) => b - a);
  const wins = done.filter(x => x.o.result === 'win' || x.o.result === 'lock').length, bes = done.filter(x => x.o.result === 'be').length, hits = done.filter(x => x.o.result === 'win').length;
  const pos = nets.filter(n => n > 0), neg = nets.filter(n => n < 0), sum = a => a.reduce((n, v) => n + v, 0);
  const holds = done.map(x => (x.o.exitT != null ? x.o.exitT - x.s.t : null)).filter(h => h != null);
  return { done: done.length, wins, bes, hits, losses: done.length - wins - bes, win: done.length ? wins / done.length : null,
    net: done.length ? sum(nets) / done.length : null, total: sum(nets), wo3: sorted.length > 3 ? sum(sorted.slice(3)) / (sorted.length - 3) : null,
    pf: neg.length ? sum(pos) / -sum(neg) : null, avgWin: pos.length ? sum(pos) / pos.length : null, avgLoss: neg.length ? sum(neg) / neg.length : null,
    hold: holds.length ? sum(holds) / holds.length : null, open: os.filter(x => x.o?.result === 'open').length, missed: list.filter(s => s.trade?.missed).length };
}
function stats(list) {
  const done = list.map(s => outcomeOf(s.trade)).filter(o => o && o.result !== 'open');
  // won: the target; B/E: stopped at the whole position's break-even after both adds; lost: the rest
  // (the wick stop, or stopped at the entry after add 1, where the add loses its 1R)
  // won: took profit, the target or the 🛡️ +3R lock; B/E: the break-even stop after both adds; lost: the rest
  // (the wick stop, or the stop at the entry after add 1, where the add loses its 1R)
  const wins = done.filter(o => o.result === 'win' || o.result === 'lock').length, bes = done.filter(o => o.result === 'be').length, hits = done.filter(o => o.result === 'win').length;
  const gross = done.reduce((n, o) => n + o.R, 0), net = done.reduce((n, o) => n + o.net, 0);
  return { n: list.length, done: done.length, wins, bes, hits, losses: done.length - wins - bes, win: done.length ? wins / done.length : null, avg: done.length ? gross / done.length : null, net: done.length ? net / done.length : null, total: net };
}

// Signals table sorting. Prices aren't comparable across pairs, so Level,
// Entry, Stop and Target don't sort. Rows without a value (no trade, still
// open) go last either way; ties fall back to newest first.
const TREND_RANK = { aligned: 3, neutral: 2, counter: 1 };
const closed = s => { const o = outcomeOf(s.trade); return o && o.result !== 'open' ? o : null; };
const closedR = s => closed(s)?.R ?? null;
// how long the trade was held: from the entry at the signal's close to the close of the candle it
// exited in (so to within 4h), or so far when it's still open
// Best R: only for trades that didn't reach the target (a winner went all the way by definition)
const bestOf = s => { const o = outcomeOf(s.trade); if (!o || o.result === 'win' || !s.best) return null; return (adds.on && s.trade.scaled ? s.best.scaled : s.best.single) ?? null; };
const heldOf = s => { const o = outcomeOf(s.trade); return !o ? null : o.result === 'open' ? Date.now() - (s.t + H4) : o.exitT != null ? o.exitT - s.t : null; };
const SORT_KEYS = {
  t: { label: ['oldest first', 'newest first'], first: -1, val: s => s.t },
  symbol: { label: ['pair A–Z', 'pair Z–A'], first: 1, val: s => s.symbol },
  side: { label: ['longs first', 'shorts first'], first: 1, val: s => s.side },
  grade: { label: ['lowest grade first', 'best grade first'], first: -1, val: s => (s.grade ? GRADES.length - GRADES.indexOf(s.grade.grade) : null) },
  rr: { label: ['lowest R:R first', 'highest R:R first'], first: -1, val: s => rrShown(s.trade).v },
  trend: { label: ['countertrend first', 'aligned with BTC first'], first: -1, val: s => TREND_RANK[s.trend] ?? null },
  held: { label: ['shortest hold first', 'longest hold first'], first: -1, val: heldOf },
  best: { label: ['lowest best R first', 'highest best R first'], first: -1, val: bestOf },
  // wins, then B/E, then stopped at entry, then losses; by R within each
  result: { label: ['losses first', 'wins first'], first: -1, val: s => { const o = closed(s); return o ? ({ win: 4, lock: 3, be: 2, entry: 1, loss: 0 }[o.result] ?? 0) * 1e4 + o.R : null; } },
  fees: { label: ['worst after fees first', 'best after fees first'], first: -1, val: s => closed(s)?.net ?? null },
};
const SORT_BY = { '4h close': 't', Pair: 'symbol', Side: 'side', Grade: 'grade', 'R:R': 'rr', Trade: 'rr', 'BTC trend': 'trend', Held: 'held', 'Best R': 'best', Result: 'result', 'After fees': 'fees' };
function sortSignals(list) {
  const { key, dir } = tab.sort, val = SORT_KEYS[key].val;
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null || y === null) return x === y ? b.t - a.t : x === null ? 1 : -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * dir || b.t - a.t;
  });
}
const sortLabel = () => SORT_KEYS[tab.sort.key].label[tab.sort.dir > 0 ? 0 : 1];

// each filter in the popover: what it shows as a chip when set, and how to clear it
const selFilter = (id, k) => ({ on: () => tab[k] !== 'all', text: () => $(id).selectedOptions[0]?.textContent, clear: () => { tab[k] = 'all'; $(id).value = 'all'; } });
const FILTERS = [
  selFilter('#sigPair', 'pair'), selFilter('#sigSide', 'side'), selFilter('#sigTrendF', 'trend'), selFilter('#sigGoldF', 'golden'), selFilter('#sigRsiF', 'rsi'), selFilter('#sigShapeF', 'shape'), selFilter('#sigSetupF', 'setup'), selFilter('#sigEmaF', 'ema'), selFilter('#sigGrrF', 'grr'), selFilter('#sigFullF', 'full'), selFilter('#sigWhaleF', 'whale'), selFilter('#sigStatusF', 'status'),
  { on: () => tab.noWrong, text: () => 'No ⛔ wrong time', clear: () => { tab.noWrong = false; $('.wrong-check input').checked = false; try { localStorage.setItem(WRONG_KEY, '0'); } catch {} } },
  { on: () => tab.noBE, text: () => 'No B/E', clear: () => { tab.noBE = false; $('.be-check input').checked = false; } },
  { on: () => !adds.on, text: () => 'First entry only', clear: () => { setAdds(true); $('#sigMode').value = 'adds'; } },
];
// BTC's 1h RSI tag: one band, either warning, or no tag at all
const rsiOk = s => { const k = s.btcRsi?.kind, f = tab.rsi; return f === 'all' || (f === 'none' ? !k : f === 'warn' ? k === 'chase' || k === 'deep' : k === f); };
// the signal candle's shape (candleShape): at the level, or closed away from it, and how it engulfed
const shapeOk = s => {
  const f = tab.shape, sh = s.shape; if (f === 'all') return true; if (!sh) return false;
  return f === 'at' ? !sh.away : f === 'away' ? sh.away : f === 'plain' ? sh.away && !sh.engulf : f === 'engulf' ? Boolean(sh.engulf) : sh.engulf === f;
};
// which filter pills are on: a pill matches its dropdown's value, a toggle its checkbox
// still running: an open trade, or a limit still waiting to fill
const isLive = s => Boolean(s.trade && !s.trade.missed && (s.trade.pending || outcomeOf(s.trade)?.result === 'open'));
function syncPills() {
  for (const pb of document.querySelectorAll('.sig-fpill')) {
    const on = pb._box ? pb._box.checked : $('#' + pb.dataset.sel)?.value === pb.dataset.v;
    pb.classList.toggle('on', on); pb.setAttribute('aria-pressed', String(on));
  }
}
function paintChips() {
  const set = FILTERS.filter(f => f.on());
  const n = $('#sigFiltN'); if (n) { n.hidden = !set.length; n.textContent = set.length; }
  $('#sigFiltChips')?.replaceChildren(...(set.length ? [] : [el('span', 'muted small', 'No filters on')]), ...set.map(f => {
    const c = el('button', 'sig-filt-chip'); c.type = 'button'; c.title = 'Remove this filter';
    c.append(f.text(), el('i', '', '×'));
    c.onclick = () => { f.clear(); tab.shown = 100; paint(); };
    return c;
  }));
}

function paint() {
  paintChips();
  syncPills();
  const all = tab.data.signals;
  const base = all.filter(s => (tab.pair === 'all' || s.symbol === tab.pair) && (tab.side === 'all' || s.side === tab.side) && (tab.trend === 'all' || s.trend === tab.trend) && (tab.golden === 'all' || (s.golden != null) === (tab.golden === 'in')) && rsiOk(s) && shapeOk(s) && (tab.setup === 'all' || (setupOf(s) ?? 'none') === tab.setup) && (tab.status === 'all' || isLive(s) === (tab.status === 'open')) && (tab.full === 'all' || Boolean(s.full) === (tab.full === 'full')) && (tab.whale === 'all' || (tab.whale === 'none' ? !s.whale : s.whale?.kind === tab.whale)) && (tab.grr === 'all' || Boolean(s.goldenRR) === (tab.grr === 'in')) && (tab.ema === 'all' || (s.grade?.skip === 'ema') === (tab.ema === 'only')) && !(tab.noWrong && wrongTime(s)) && !(tab.noBE && outcomeOf(s.trade)?.result === 'be'));
  const list = sortSignals(base.filter(gradeOk));

  const perDay = list.length ? list.length / tab.days : 0;
  // the grades as one row of stats on what's shown (all the other filters applied): each grade's R a
  // trade, and its verdict: the best R a trade, the best win rate, the biggest total, Inconsistent when it
  // loses; otherwise its win rate and trade count
  const gs = GRADES.map(g => ({ g, st: stats(base.filter(s => s.grade?.grade === g)) })), ok = gs.filter(x => x.st.done >= 10 && x.st.net !== null);
  const top = f => (ok.length ? ok.reduce((a, b) => (f(b) > f(a) ? b : a)).g : null);
  const bestR = top(x => x.st.net), bestW = top(x => x.st.win), bestT = top(x => x.st.total);
  $('#sigSummary').replaceChildren(...gs.map(({ g, st }) => {
    const tags = [g === bestT && 'Best overall', g === bestR && 'Best R / trade', g === bestW && 'Best win %'].filter(Boolean);
    const enough = st.done >= 10, losing = enough && st.net < 0;
    const d = el('div', 'sig-gstat');
    const val = el('b', 'sig-gstat-r ' + (st.net == null ? 'muted' : cls(st.net)), st.net == null ? '—' : rText(st.net));
    const sub = el('small', 'sig-gstat-v' + (tags.length && enough ? ' best' : losing ? ' bad' : ''),
      !st.done ? 'no trades' : !enough ? `${Math.round(st.win * 100)}% won` : tags.length ? tags.join(' · ') : losing ? 'Inconsistent' : `${Math.round(st.win * 100)}% won`);
    const count = el('small', 'sig-gstat-n', st.done ? `${st.done.toLocaleString()} trade${st.done === 1 ? '' : 's'}` : '');
    const chip = el('span', 'sig-grade ' + gradeKey(g), gradeLabel(g));
    chip.title = `Grade ${g}: ${GRADE_DEF[g] || ''}` + `\n\nSize: ${sizeNote(g)}`;
    d.append(chip, val, sub, count);
    d.title = st.done ? `Grade ${g}: ${st.done.toLocaleString()} trades · ${st.wins} won (${Math.round(st.win * 100)}%) · ${st.losses} lost${st.bes ? ` · ${st.bes} B/E` : ''} · ${rText(st.net)} a trade after fees · ${rText(st.total).replace(/\.\d+R/, 'R')} total` : `Grade ${g}: no finished trades here`;
    return d;
  }));
  // the results of exactly what's shown: every filter and grade tick applied
  const v = viewStats(list), sv = $('#sigView');
  const stat = (k, val, c = '', tip = '') => { const d = el('div', 'sig-view-s'); d.append(el('span', 'kicker', k), el('b', c, val)); if (tip) d.title = tip; return d; };
  sv.replaceChildren(...(v.done ? [
    stat('R a trade', rText(v.net), cls(v.net), 'Average after Bybit fees' + (adds.on ? ', with the adds' : ', first entry only')),
    stat('Total', rText(v.total).replace(/\.\d+R/, 'R'), cls(v.total)),
    stat('Without best 3', v.wo3 === null ? '—' : rText(v.wo3), cls(v.wo3), 'R a trade with the 3 best trades left out: does it hold up without its outliers?'),
    stat('Won', `${Math.round(v.win * 100)}%`, '', `Took profit: ${v.hits} hit the target${v.wins - v.hits ? ` · ${v.wins - v.hits} locked +3R` : ''} · ${v.losses} lost${v.bes ? ` · ${v.bes} B/E` : ''}`),
    stat('Trades', `${v.done.toLocaleString()}`, '', `${v.done} finished of ${list.length.toLocaleString()} signals${v.open ? ` · ${v.open} still open` : ''}${v.missed ? ` · ${v.missed} limits never filled` : ''}`),
    stat('Profit factor', v.pf === null ? '—' : v.pf.toFixed(2), v.pf === null ? '' : v.pf >= 1 ? 'pos' : 'neg', 'What the winners made ÷ what the losers lost, after fees'),
    stat('Avg win / loss', v.avgWin === null ? '—' : `${rText(v.avgWin).replace('R', '')} / ${v.avgLoss === null ? '—' : rText(v.avgLoss)}`, '', 'The average winning and losing trade, after fees'),
    stat('Avg hold', v.hold === null ? '—' : fmtDuration(v.hold)),
  ] : [(() => {
    // nothing shown: if the grade ticks are what's hiding them, say which grades they're in, with a click to show them
    if (list.length) return el('p', 'muted small', 'No finished trades in this view yet.');
    const hid = base.filter(s => s.grade && !tab.grades.has(s.grade.grade));
    if (!hid.length) return el('p', 'muted small', 'No signals match these filters.');
    const by = [...new Set(hid.map(s => s.grade.grade))].sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b));
    const p = el('p', 'muted small sig-hidden-note');
    p.append(`No signals in the ticked grades. ${hid.length.toLocaleString()} match these filters in unticked grades: `);
    for (const g of by) { const b = el('button', 'sig-grade ' + gradeKey(g), `${gradeLabel(g)} · ${hid.filter(s => s.grade.grade === g).length}`); b.type = 'button'; b.title = `Tick ${g}`; b.onclick = () => $(`#sigGradeF input[value="${g}"]`)?.click(); p.append(b, ' '); }
    if (by.includes('C+')) p.append(' (an A grade whose candle engulfed is graded 🕯️ C+)');
    return p;
  })()]));
  $('#sigCount').textContent = `${list.length.toLocaleString()} signal${list.length === 1 ? '' : 's'} · about ${perDay.toFixed(1)} a day · ${sortLabel()}`;

  const t = $('#sigTable'); t.replaceChildren();
  const head = el('tr');
  for (const [h, num] of [['4h close', 0], ['Pair', 0], ['Grade', 0], ['Level', 0], ['Trade', 0], ['BTC trend', 0], ['Held', 1], ['Best R', 1], ['R:R', 1], ['Result', 1]]) {
    const th = el('th', num ? 'num' : ''), key = SORT_BY[h];
    if (!key) { th.textContent = h; head.append(th); continue; }
    const b = el('button', 'sort', h), on = tab.sort.key === key;
    if (on) { b.append(el('span', 'arrow', tab.sort.dir > 0 ? ' ↑' : ' ↓')); th.setAttribute('aria-sort', tab.sort.dir > 0 ? 'ascending' : 'descending'); }
    b.onclick = () => { tab.sort = { key, dir: on ? -tab.sort.dir : SORT_KEYS[key].first }; tab.shown = 100; paint(); };
    th.append(b); head.append(th);
  }
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const s of list.slice(0, tab.shown)) {
    const tr = el('tr', 'replayable'); tr.tabIndex = 0; tr.title = 'Show on the 4h chart';
    const tc = el('td'); tc.append(trendChip(s));
    const gc = el('td'), chips = [gradeChip(s), projChip(s), fullChip(s), whaleChip(s), goldenRRChip(s), goldenChip(s), btcRsiChip(s), shapeChip(s), emaChip(s)].filter(Boolean);
    { const w = el('div', 'sig-chips'); w.append(...chips); gc.append(w); }
    const t = s.trade, f = tab.ctx.fmt.price;
    const o = outcomeOf(t), done = o && o.result !== 'open';
    const hv = heldOf(s), held = el('td', 'num' + (done ? '' : ' muted'), hv == null ? '—' : fmtDuration(hv));
    if (hv != null) held.title = done ? 'From the entry to the close of the 4h candle it exited in' : 'Still open: held so far';
    const res = t?.missed ? 'LO missed' : t?.pending ? 'LO pending' : !o ? '—' : done ? { win: '✓ ', loss: '✗ ', entry: '✗ ', be: '= ', lock: '🛡️ ' }[o.result] + rText(o.R) : o.R === 0 ? 'new' : `open ${rText(o.R)}`;
    tr.append(
      el('td', '', closeTime(s.t)), (() => { const td = el('td', 'side-' + s.side.toLowerCase(), `${s.side === 'Short' ? '▼' : '▲'} ${coin(s.symbol)}`); td.title = s.side; return td; })(), gc,
      (() => { const lv = s.levels.map(l => f(l.price)).join(', '), td = el('td', 'sig-lvl-c', lv); td.title = lv; return td; })(),
      tradeCell(s, o, f), tc,
      held,
      (() => { const v = bestOf(s), td = el('td', 'num' + (v == null ? '' : v >= 1 ? ' pos' : ' muted'), v == null ? '' : `+${v.toFixed(1)}R`); if (v != null) td.title = 'The furthest it went in your favour before it ended, in R of the first entry'; return td; })(),
      (() => { const t0 = s.trade; if (!t0) return el('td', 'num', '—');
        const td = rrEl('td', 'num', t0), w = adds.on && o?.rr && o.rr > t0.rr + 0.05 ? o.rr : null;
        if (rrShown(t0).trailed) { if (adds.on && o?.trail && o.adds) td.title += `; ${rText(o.R)} with the adds`; }
        else if (w) td.title += `, ${w.toFixed(1)}R if both adds fill`;
        return td; })(),
      (() => { const td = el('td', 'num sig-res-c ' + (done ? cls(o.R) : '')); td.append(el('span', '', res)); if (done) { const n = el('small', cls(o.net), `${rText(o.net)} after fees`); td.append(n); } return td; })(),
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
// For each close (in local time): the year's A-grade signals as expected results,
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
  const good = data.signals.filter(s => s.grade && ['A', 'A+', 'A++', 'S', 'S+'].includes(s.grade.grade) && s.trade && s.trade.result !== 'open' && !s.trade.missed);
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
  for (const [h, num] of [['Close', 0], ['A-grade a year', 1], ['A week', 1], ['Hit target', 1], ['Avg R', 1], ['Without its outliers', 1], ['Expected R a week', 1], ['Verdict', 0], ['Your trades', 1], ['Your win rate', 1], ['Your P&L', 1]]) head.append(el('th', num ? 'num' : '', h));
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
        c.title = `${DAYS_SHORT[d]} ${hourLabel(h)} close: ${st.n} A-grade trades, ${Math.round(st.win * 100)}% hit target, ${rText(st.avg)} avg after fees`;
      } else c.append(el('small', '', '—'));
      cells.push(c); grid.append(c);
    }
  }
  const note = el('p', 'muted small close-note', `Times are your local time; · marks your trading day (08:00–16:00). “Without its outliers” drops the best few trades, so a close that only looks good because of one huge winner shows up. Expected R a week = A/A+ setups a week × avg R. In the grid, faded cells have under 8 trades. Your trades are grouped by the 4h candle they were opened in.`);
  root.replaceChildren(wrap, el('h3', 'close-sub', 'By weekday'), grid, note);
}
