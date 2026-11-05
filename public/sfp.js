// Swing failure patterns (SFP) on 4h candles. Pure functions with no page
// code, so the same rules can run in the browser (the Beta tab) and later on
// the server for alerts.
//
// The rules, for a short (mirror everything for a long at swing lows):
//   1. Swing high: a candle whose body top (max of open, close) is above the
//      body tops of the `right` candles after it and the `left` candles before it.
//      It's confirmed once those `right` candles have closed.
//   2. Level: a line at that body top, live for `lookbackDays` after the swing.
//   3. Sweep: a later candle's wick goes above the line (it needn't pass the
//      swing candle's own wick), by at least `minSweep` (a share of the price).
//   4. Failure: that candle closes at or below the line. That close is the signal.
//      Only levels whose swing candle is at least `minAge` candles back can be
//      tested, so a signal is a test of an established range, not a fresh wiggle.
//   5. Range filters, against mid-range signals. The range is the highest high
//      and lowest low over the last `rangeDays` (default: the level lookback),
//      before the signal candle. With `edge`
//      (a share, e.g. 0.25) a short's level must sit in the top 25% of that
//      range and a long's in the bottom 25%; 0 turns it off. With `outermost`,
//      a short's level must be the highest live swing-high level (no live level
//      above it), mirrored for longs.
//   A close beyond the line breaks the level (if `breakOnClose`). With `once`
//   (the default) a level gives at most one signal, so a level that keeps
//   failing doesn't count over and over.

export const H4 = 4 * 3_600_000;
export const SFP_DEFAULTS = { left: 3, right: 3, minAge: 12, lookbackDays: 90, breakOnClose: true, once: true, edge: 0.25, rangeDays: 7, outermost: false, minSweep: 0 };
// Your Bybit watchlist (USDT perps; Bybit lists BONK and PEPE as 1000BONK and 1000PEPE).
export const DEFAULT_PAIRS = 'ETH SOL 1000BONK WIF 1000PEPE FARTCOIN USELESS BRETT CASHCAT TRUMP PONS DOGE STRK JUP PENDLE UNI ALGO WLD AAVE AERO ZK VVV HYPE MNT ARB ' +
  'ZETA PUMPFUN LINK NEAR ETHFI ZEC TAO SUI BARD LIT AVAX MEGA OPG SLX XMR ZRO ENA ADA AKE XRP XPL LINEA ONDO GWEI SKR 0G BNB RUNE TRX LTC CLANKER DGAI GRAM ICNT BMT DOT KAS POL';
// Added to the default after people had saved lists; saved lists get them too.
export const ADDED_PAIRS = ['BNB', 'RUNE', 'TRX', 'LTC', 'CLANKER', 'DGAI', 'GRAM', 'ICNT', 'BMT', 'DOT', 'KAS', 'POL'];
// The first list, kept so saved scanner settings still on it move to the new one.
export const OLD_DEFAULT_PAIRS = 'VVV HYPE STRK AAVE AERO JUP UNI ALGO LINK NEAR ETHFI ZEC SUI LIT AVAX WLD ONDO PENDLE ENA ZK MNT';
// Presets for how hard to filter. Balanced is the scanner's default (it tested
// best over 90 days) and what the alerts use.
export const PRESETS = {
  balanced: { minAge: 10, edge: 0.35, neutralBand: 0.01, smtRef: 'any', minSweep: 0.001 },
  strict: { minAge: 12, edge: 0.25, neutralBand: 0, smtRef: 32, minSweep: 0.001 },
};

const top = c => Math.max(c.o, c.c), bottom = c => Math.min(c.o, c.c);

// Only candles that have fully closed: Bybit's latest candle is still forming.
export const closedOnly = (candles, now = Date.now(), ms = H4) => candles.filter(c => c.t + ms <= now);

// Every swing in the candles, with when it becomes usable. On a perp each
// candle opens where the last one closed, so the candles either side of a peak
// share its body-top price. The first candle at that price is the swing: every
// other candle in the window must be strictly lower, except the one right
// after it, which may tie (it opened at the swing's close).
export function swings(candles, { left = 3, right = 3 } = {}) {
  const out = [];
  for (let i = left; i + right < candles.length; i++) {
    const hi = top(candles[i]), lo = bottom(candles[i]);
    let isHigh = true, isLow = true;
    for (let j = 1; j <= Math.max(left, right) && (isHigh || isLow); j++) {
      for (const k of [i - j, i + j]) {
        if ((k < i && j > left) || (k > i && j > right)) continue;
        const tieOk = k === i + 1;
        if (tieOk ? top(candles[k]) > hi : top(candles[k]) >= hi) isHigh = false;
        if (tieOk ? bottom(candles[k]) < lo : bottom(candles[k]) <= lo) isLow = false;
      }
    }
    if (isHigh) out.push({ kind: 'high', i, price: hi, t: candles[i].t, confirmedAt: i + right });
    if (isLow) out.push({ kind: 'low', i, price: lo, t: candles[i].t, confirmedAt: i + right });
  }
  return out;
}

// Walk the candles in order, keeping the live levels, and record every SFP.
// Returns signals (one per candle and side, listing every level it failed at),
// the levels still live after the last candle, and every level's lifetime
// (`levels`: from the candle it became usable to the candle it ended on, and why).
export function detect(candles, opts = {}) {
  const o = { ...SFP_DEFAULTS, ...opts };
  const all = swings(candles, o);
  const life = o.lookbackDays * 86_400_000;
  let live = [];
  const signals = [], levels = [];
  const end = (l, t, why) => levels.push({ kind: l.kind, price: l.price, t: l.t, from: l.from, until: t, why, hits: l.hits });
  let next = 0;
  const byConfirm = [...all].sort((a, b) => a.confirmedAt - b.confirmedAt);
  for (let k = 0; k < candles.length; k++) {
    const c = candles[k];
    // levels confirmed by the previous candle's close become usable now
    while (next < byConfirm.length && byConfirm[next].confirmedAt < k) live.push({ ...byConfirm[next++], hits: 0, from: c.t });
    live = live.filter(l => (c.t - l.t <= life) || (end(l, candles[k - 1].t, 'expired'), false));
    // the range over the lookback, up to the candle before this one
    const back = candles.slice(Math.max(0, k - Math.round((o.rangeDays ? o.rangeDays * 86_400_000 : life) / H4)), k);
    const rHi = back.length ? Math.max(...back.map(x => x.h)) : null, rLo = back.length ? Math.min(...back.map(x => x.l)) : null;
    const posIn = price => (rHi > rLo ? (price - rLo) / (rHi - rLo) : null);
    const topHigh = Math.max(...live.filter(l => l.kind === 'high').map(l => l.price));
    const bottomLow = Math.min(...live.filter(l => l.kind === 'low').map(l => l.price));
    const hit = { high: [], low: [] };
    for (const l of live) {
      if (k - l.i < o.minAge) continue;            // too young to count as a test
      const pos = posIn(l.price);
      // a wick that barely pokes past the level (under minSweep, a share of the price) isn't a sweep
      if (l.kind === 'high' && c.h > l.price * (1 + o.minSweep) && c.c <= l.price) {
        if (o.edge && (pos === null || pos < 1 - o.edge)) continue;    // mid-range
        if (o.outermost && l.price < topHigh) continue;               // a bigger level is still above
        hit.high.push(l);
      }
      if (l.kind === 'low' && c.l < l.price * (1 - o.minSweep) && c.c >= l.price) {
        if (o.edge && (pos === null || pos > o.edge)) continue;
        if (o.outermost && l.price > bottomLow) continue;
        hit.low.push(l);
      }
    }
    for (const [kind, levels] of Object.entries(hit)) {
      if (!levels.length) continue;
      const short = kind === 'high';
      const deepest = short ? Math.min(...levels.map(l => l.price)) : Math.max(...levels.map(l => l.price));
      const outer = short ? Math.max(...levels.map(l => l.price)) : Math.min(...levels.map(l => l.price));
      signals.push({
        side: short ? 'Short' : 'Long', k, t: c.t, close: c.c, high: c.h, low: c.l,
        // where the outermost failed level sits in the range: 0 bottom, 1 top
        range: { high: rHi, low: rLo, pos: posIn(outer) },
        levels: levels.map(l => ({ price: l.price, t: l.t, hits: l.hits })).sort((a, b) => (short ? a.price - b.price : b.price - a.price)),
        // how far the wick went past the nearest level it failed at
        sweepPct: short ? (c.h - deepest) / deepest : (deepest - c.l) / deepest,
        ...outcome(candles, k, short),
        trade: tradePlan(candles, k, short, levels, all),
      });
      for (const l of levels) l.hits++;
    }
    live = live.filter(l => {
      if (o.once && l.hits) return end(l, c.t, 'used'), false;
      if (o.breakOnClose && (l.kind === 'high' ? c.c > l.price : c.c < l.price)) return end(l, c.t, 'broken'), false;
      return true;
    });
  }
  for (const l of live) end(l, candles.at(-1).t, 'live');
  return { signals, live, levels, swings: all };
}

// The trade, for a short (mirrored for a long):
//   entry  the signal candle's close
//   stop   the signal candle's wick high
//   target the opposing level: the lowest swing-low body between the swept
//          swing (the oldest one, if several) and the signal candle, i.e. where
//          the move into the sweep started. Only swings confirmed by the signal's
//          close count, so the target is known at entry. If none is confirmed
//          yet (a fresh pullback), the lowest candle body in that span instead.
// Then it walks the later candles: the stop or the target, whichever is hit
// first. A candle that touches both counts as the stop (we can't see inside it).
// null when there's no opposing level beyond the entry.
export function tradePlan(candles, k, short, levels, swingList) {
  const c = candles[k], entry = c.c, sl = short ? c.h : c.l;
  const risk = Math.abs(sl - entry);
  if (!risk) return null;
  const from = Math.min(...levels.map(l => l.i));
  const opp = swingList.filter(s => s.kind === (short ? 'low' : 'high') && s.i > from && s.i < k && s.confirmedAt <= k);
  // no confirmed swing yet (the pullback is too fresh): the move's extreme body instead
  if (!opp.length) {
    for (let j = from + 1; j < k; j++) {
      const b = candles[j], body = short ? Math.min(b.o, b.c) : Math.max(b.o, b.c);
      opp.push({ price: body, t: b.t });
    }
    if (!opp.length) return null;
  }
  const target = opp.reduce((a, b) => (short ? (b.price < a.price ? b : a) : (b.price > a.price ? b : a)));
  const tp = target.price;
  if (short ? tp >= entry : tp <= entry) return null;
  const rr = Math.abs(entry - tp) / risk;
  const plan = { entry, sl, tp, tpT: target.t, rr, riskPct: risk / entry, result: 'open', R: null, exitT: null };
  const scaled = scaledResult(candles, k, plan, short);
  for (let j = k + 1; j < candles.length; j++) {
    const x = candles[j];
    const stopped = short ? x.h >= sl : x.l <= sl, hit = short ? x.l <= tp : x.h >= tp;
    if (stopped) return { ...plan, result: 'loss', R: -1, exitT: x.t, scaled };
    if (hit) return { ...plan, result: 'win', R: rr, exitT: x.t, scaled };
  }
  // still open: where it stands at the last close, in R
  const last = candles.at(-1);
  return { ...plan, R: k < candles.length - 1 ? (short ? entry - last.c : last.c - entry) / risk : 0, scaled };
}

// Bybit's standard fees: market orders in and at the stop, a limit at the target.
export const TAKER_FEE = 0.00055, MAKER_FEE = 0.0002;
// The same trade run with the scaling plan (scalePlan, below): adds at +1R and
// +2R, stops to the entry after the first and to the whole position's
// break-even after the second. An add hit during a candle counts from the next
// one, and a candle that touches the stop and the target counts as the stop.
// `R` and `net` (after fees) are in units of the first entry's risk; `rr` is
// what the full plan makes at the target. result: 'win' (target), 'loss' (the
// wick stop), 'entry' (stopped at the entry after add 1), 'be' (stopped at
// break-even after add 2) or 'open'.
export function scaledResult(candles, k, trade, short) {
  const { entry, sl, tp } = trade, dir = short ? -1 : 1, risk = Math.abs(entry - sl);
  const sp = scalePlan(trade, short ? 'Short' : 'Long');
  const legs = [{ px: entry, size: 1 }];
  const out = (result, px, exitT, fee) => {
    const R = legs.reduce((n, l) => n + l.size * (px - l.px) * dir, 0) / risk;
    const fees = legs.reduce((n, l) => n + l.size * (TAKER_FEE * l.px + fee * px), 0) / risk;
    return { result, R, net: result === 'open' ? null : R - fees, exitT, adds: legs.length - 1, rr: sp.R };
  };
  let stop = sl, next = 0;
  for (let j = k + 1; j < candles.length; j++) {
    const x = candles[j], adverse = short ? x.h : x.l, favour = short ? x.l : x.h;
    if (dir * (adverse - stop) <= 0) return out(next === 0 ? 'loss' : next === 1 ? 'entry' : 'be', stop, x.t, TAKER_FEE);
    if (dir * (favour - tp) >= 0) return out('win', tp, x.t, MAKER_FEE);
    while (next < sp.adds.length && dir * (favour - sp.adds[next].price) >= 0) {
      const a = sp.adds[next++];
      legs.push({ px: a.price, size: a.size });
      stop = a.stop;
    }
  }
  return out('open', candles.at(-1).c, null, 0);
}

// What price did next: the move in your favor after 1, 3 and 6 candles, and
// the best and worst points over those 6 candles (24 hours on 4h).
function outcome(candles, k, short) {
  const entry = candles[k].c, after = candles.slice(k + 1, k + 7);
  const move = p => (short ? entry - p : p - entry) / entry;
  const at = n => (after.length >= n ? move(after[n - 1].c) : null);
  return {
    after4h: at(1), after12h: at(3), after24h: at(6),
    best24h: after.length ? Math.max(...after.map(c => move(short ? c.l : c.h))) : null,
    worst24h: after.length ? Math.min(...after.map(c => move(short ? c.h : c.l))) : null,
  };
}

// ---- a candle that hasn't closed yet ----

export const M5 = 5 * 60_000;
// The 4h candle starting at `t` as it stood at `cut`, built from its 5m candles
// (any that closed by then). null when none had.
export function candleAt(parts, t, cut, ms = M5) {
  const in4h = parts.filter(c => c.t >= t && c.t < t + H4 && c.t + ms <= cut).sort((a, b) => a.t - b.t);
  if (!in4h.length || in4h[0].t !== t) return null;
  return { t, o: in4h[0].o, h: Math.max(...in4h.map(c => c.h)), l: Math.min(...in4h.map(c => c.l)), c: in4h.at(-1).c };
}

// The SFPs `candle` makes if it closes as it is, after the closed `history`
// (4h candles, oldest first, ending right before it).
export function signalsIf(history, candle, opts = {}) {
  const cs = [...history.filter(c => c.t < candle.t), candle];
  return detect(cs, opts).signals.filter(s => s.k === cs.length - 1);
}

// The price a signal's close must stay on the right side of: the outermost
// level it failed at (a short still signals while it closes at or below its
// highest swept level), and how far inside that the price is now.
export function holdLine(sig) {
  const short = sig.side === 'Short';
  const line = short ? Math.max(...sig.levels.map(l => l.price)) : Math.min(...sig.levels.map(l => l.price));
  return { line, inside: short ? (line - sig.close) / line : (sig.close - line) / line };
}

// ---- BTC filter: trend on 4h, SMT on 15m ----

export const M15 = 15 * 60_000;
// smtRef is a number of 15m candles, or 'any': a divergence over 4h, 8h or 16h.
// neutralBand: BTC within this share of its EMA is neutral, so nothing is counter-trend.
export const BTC_DEFAULTS = { requireSmt: false, trendEma: 50, smtRef: 'any', smtType: 'strength', neutralBand: 0.01 };
export const SMT_WINDOWS = [16, 32, 64];

// Exponential moving average of `values` over `n`, seeded with the first value.
export function ema(values, n) {
  const k = 2 / (n + 1), out = [];
  for (let i = 0; i < values.length; i++) out.push(i ? values[i] * k + out[i - 1] * (1 - k) : values[i]);
  return out;
}

// BTC's 4h trend at each candle close: up when the close is above its EMA.
// Returns Map(candle start → { up, close, ema }). The first `n` candles are left
// out, since the EMA hasn't settled there.
export function trendMap(btc, n = 50) {
  const e = ema(btc.map(c => c.c), n), out = new Map();
  for (let i = n; i < btc.length; i++) out.set(btc[i].t, { up: btc[i].c > e[i], close: btc[i].c, ema: e[i] });
  return out;
}

// The settings the Telegram alerts and the Signals tab use: the Balanced preset.
export const ALERT_SETTINGS = { ...SFP_DEFAULTS, ...BTC_DEFAULTS, ...PRESETS.balanced };

// How a signal sits against BTC's 4h trend, as the alerts report it: from the
// last 4h candle closed before the signal candle (the heads-up can't know the
// signal candle's own close). 'aligned', 'counter', 'neutral', or null if unknown.
export function btcSide(sig, trends, band = 0) {
  const tr = trends.get(sig.t - H4);
  if (!tr) return null;
  if (Math.abs(tr.close - tr.ema) / tr.ema < band) return 'neutral';
  return (sig.side === 'Long') === tr.up ? 'aligned' : 'counter';
}

// A signal is counter-trend when it goes against BTC: a long while BTC is down,
// a short while BTC is up. Within `band` of the EMA, BTC counts as neutral and
// nothing is counter-trend. null when BTC's trend isn't known for that candle.
export function counterTrend(sig, trends, band = 0) {
  const tr = trends.get(sig.t);
  if (!tr) return null;
  if (Math.abs(tr.close - tr.ema) / tr.ema < band) return false;
  return sig.side === 'Long' ? !tr.up : tr.up;
}

// SMT divergence against BTC on 15m, during the signal's 4h candle. Each market
// either takes its extreme of the `ref` 15m candles before (lower low for a
// long, higher high for a short) or holds it. Two forms:
//   'strength': BTC takes its low while the pair holds (the pair is stronger
//               than BTC: the usual case for a long against BTC's trend)
//   'sweep':    the pair takes its low while BTC holds
// `alt` and `btc` are 15m candles covering the reference window and the signal candle.
export function smt(sig, alt, btc, { ref = 32, ms = H4, type = 'strength' } = {}) {
  const from = sig.t - ref * M15, to = sig.t + ms;
  const part = (cs, a, b) => cs.filter(c => c.t >= a && c.t < b);
  const side = (cs) => {
    const before = part(cs, from, sig.t), during = part(cs, sig.t, to);
    if (!before.length || !during.length) return null;
    return sig.side === 'Long'
      ? { ref: Math.min(...before.map(c => c.l)), extreme: Math.min(...during.map(c => c.l)) }
      : { ref: Math.max(...before.map(c => c.h)), extreme: Math.max(...during.map(c => c.h)) };
  };
  const a = side(alt), b = side(btc);
  if (!a || !b) return { ok: null, alt: a, btc: b };
  const past = x => (sig.side === 'Long' ? x.extreme < x.ref : x.extreme > x.ref);
  const ok = type === 'sweep' ? past(a) && !past(b) : past(b) && !past(a);
  return { ok, type, alt: { ...a, took: past(a) }, btc: { ...b, took: past(b) } };
}

// A letter grade for a setup, from what held up in the 1-year backtest
// (54 pairs, wick stop, opposing-level target, fees; avg R per trade):
//   A++ with yesterday's NY bias, outside the NY session, BTC swept the same way   +3.24R main closes Mon–Thu (19, thin)
//   A+  the same but no BTC sweep, and the 4h RSI stretched the trade's way          +2.70R (229)
//   A   with the bias outside the session (neither), or with it + BTC sweep in the   +1.10R (122)
//       session (at 00:00 that's the 🌙 Midnight sweep)
//   A++ also: NY session open, 4h RSI stretched (🌃 Late A++, 00:00 / 04:00)       +1.6R (~135)
//   B+  that, when it also fades a 2%+ NY session (🌊 NY fade)                       +2.29R (32, 8 days)
//   B   with the bias but during the NY session (the bias may be going stale)       +0.02R
//   C++  a C that fades a 2%+ NY session at its last close (see nyFadeAt)            tracking only
//   C   against the bias, or no bias known                                         −0.13R
// ny: { bias: 'bullish'|'bearish'|'flat'|null, during: bool }; swept: BTC's own SFP, same side, same candle;
// rsi: the pair's 4h RSI(14) at the signal close (see rsi()), optional; fade: the setup fades
// a violent NY session at its last close (fadesNy in bias.js), optional.
export const BPLUS_RSI = 40;
export const rsiStretched = (side, r) => r != null && Number.isFinite(r) && (side === 'Short' ? r > 100 - BPLUS_RSI : r < BPLUS_RSI);
export function gradeSetup(side, { ny, swept = false, rsi = null, fade = false } = {}) {
  const dir = side === 'Short' ? 'bearish' : 'bullish';
  const mark = ny?.bias === 'bullish' ? '▲' : ny?.bias === 'bearish' ? '▼' : '';
  const nf = ', but fades a 2%+ NY session at its last close (NY fade)';
  if (!ny?.bias || ny.bias === 'flat') return fade ? { grade: 'C++', why: 'no NY bias to go with' + nf } : { grade: 'C', why: 'no NY bias to go with' };
  if (ny.bias !== dir) return fade ? { grade: 'C++', why: `against the NY bias ${mark}${nf}` } : { grade: 'C', why: `against the NY bias ${mark}` };
  const sw = swept ? ', BTC swept too' : '';
  if (!ny.during) {
    if (swept) return { grade: 'A++', why: `with the NY bias ${mark}${sw}` };
    if (rsiStretched(side, rsi)) return { grade: 'A+', why: `with the NY bias ${mark}, 4h RSI ${Math.round(rsi)} (stretched)` };
    return { grade: 'A', why: `with the NY bias ${mark}` };
  }
  // tagged: at the 00:00 close (Mon–Thu) this is the 🌙 Midnight sweep, taken at tracking size (proposedRisk)
  if (swept) return { grade: 'A', why: `with the NY bias ${mark}${sw}, NY session open`, tag: 'midnight' };
  // NY open with a stretched RSI: an A++ in its own right at the late closes (🌃 Late A++), or,
  // when it also fades a violent NY session, the 🌊 NY fade, tracked on its own
  if (rsiStretched(side, rsi)) return fade
    ? { grade: 'B+', why: `with the NY bias ${mark}, NY session open, 4h RSI ${Math.round(rsi)} (stretched), and fades a 2%+ NY session (🌊 NY fade)`, tag: 'fade' }
    : { grade: 'A++', why: `with the NY bias ${mark}, NY session open, 4h RSI ${Math.round(rsi)} (stretched): 🌃 Late A++`, tag: 'late' };
  return { grade: 'B', why: `with the NY bias ${mark}, but the NY session is open` };
}
export const GRADE_ORDER = ['A++', 'A+', 'A', 'B+', 'B', 'C++', 'C'];

// BTC's 1h RSI at the close, read from the setup's side (a short sees 100 − RSI, so low is
// always "BTC stretched against the trade"). Backtest (A-grades, main closes Mon–Thu, past year):
//   35–45  🧊 BTC cooled: pulled back without breaking down      86 trades, +2.90R a trade without the best 3
//   ≤35    ⚠️ BTC stretched against it: the pullback is a turn     104, −0.22R without the best 3
//   ≥60    ⚠️ BTC stretched the trade's way: chasing             45, −0.17R a trade, no quarter positive
//   (all A-grades there: +1.35R without the best 3). A tag for tracking: grades and sizes don't change.
export const BTC_RSI_BANDS = { deep: 35, cool: 45, chase: 60 };
export function btcRsiTag(side, r) {
  if (r == null || !Number.isFinite(r)) return null;
  const v = side === 'Short' ? 100 - r : r, n = Math.round(r), against = side === 'Short' ? 'overbought' : 'oversold', yours = side === 'Short' ? 'oversold' : 'overbought';
  if (v <= BTC_RSI_BANDS.deep) return { kind: 'deep', rsi: n, text: `⚠️ BTC ${against} against it (1h RSI ${n}): the pullback may be a turn` };
  if (v <= BTC_RSI_BANDS.cool) return { kind: 'cool', rsi: n, text: `🧊 BTC cooled off (1h RSI ${n}): pulled back, not broken` };
  if (v >= BTC_RSI_BANDS.chase) return { kind: 'chase', rsi: n, text: `⚠️ BTC ${yours} the trade’s way (1h RSI ${n}): chasing` };
  return null;
}

// Wilder's RSI over `n` candles (as TradingView draws it): one value per candle, null until there are n changes.
export function rsi(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c, up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// The scaling plan for a trade, as backtested on A-grade setups:
//   add 1 at +1R (same size as the entry); all stops → the entry
//   add 2 at +2R (half size, so it also risks 1R to the entry); all stops → the
//     whole position's break-even (its average entry, plus ~0.15% for fees)
//   all out at the target
// Adds the target would be reached before are left out. Sizes are in units of
// the first entry's size; `R` is what the full plan makes at the target, in
// units of the first entry's risk.
export const BE_FEES = 0.0015;
export function scalePlan(trade, side) {
  if (!trade) return null;
  const dir = side === 'Short' ? -1 : 1, risk = Math.abs(trade.entry - trade.sl);
  const legs = [{ step: 'Entry', price: trade.entry, size: 1 }];
  const adds = [];
  for (const n of [1, 2]) {
    const price = trade.entry + dir * n * risk;
    if (dir * (trade.tp - price) <= 0) break;                        // the target comes first
    const size = 1 / n;                                              // its own 1R to the entry
    legs.push({ step: `Add ${n}`, price, size });
    const stop = n === 1 ? trade.entry : (legs.reduce((a, l) => a + l.size * l.price, 0) / legs.reduce((a, l) => a + l.size, 0)) * (1 + dir * BE_FEES);
    adds.push({ n, at: n, price, size, stop, stopLabel: n === 1 ? 'entry' : 'break-even' });
  }
  const R = legs.reduce((a, l) => a + l.size * dir * (trade.tp - l.price), 0) / risk;
  return { risk, adds, R, size: legs.reduce((a, l) => a + l.size, 0) };
}
