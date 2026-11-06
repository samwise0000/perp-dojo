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
  'ZETA PUMPFUN LINK NEAR ETHFI ZEC TAO SUI BARD LIT AVAX MEGA OPG SLX XMR ZRO ENA ADA AKE XRP XPL LINEA ONDO GWEI SKR 0G BNB RUNE TRX LTC CLANKER DGAI GRAM ICNT BMT DOT KAS POL TIA OP CC VIRTUAL XTZ';
// Added to the default after people had saved lists; saved lists get them too.
export const ADDED_PAIRS = ['BNB', 'RUNE', 'TRX', 'LTC', 'CLANKER', 'DGAI', 'GRAM', 'ICNT', 'BMT', 'DOT', 'KAS', 'POL', 'TIA', 'OP', 'CC', 'VIRTUAL', 'XTZ'];
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
  const end = walkSingle(candles, k + 1, plan, short);
  if (end) return { ...plan, ...end, scaled };
  // still open: where it stands at the last close, in R
  const last = candles.at(-1);
  return { ...plan, R: k < candles.length - 1 ? (short ? entry - last.c : last.c - entry) / risk : 0, scaled };
}
// 🎯→ The plan's exit: when the target is touched the trade isn't closed. From the candle that touched it,
// the stop trails behind each closed 4h candle's low (a short: its high), only ever tightening, and the
// trade ends when a candle trades through it (a stop order: taker fee). It leaves room for breakouts:
// in the backtest it made +2.18R a plan trade against +1.77R for closing at the target.
// From candle `j` (the one that touched the target) with the stop at `stop`: { px, t } when it's out,
// or { open: true, stop } while it's still trailing at the last candle.
export function trailFrom(candles, j, stop, short) {
  const d = short ? -1 : 1;
  let ts = stop;
  for (let m = j; m < candles.length; m++) {
    const c = candles[m];
    if (m > j && d * ((short ? c.h : c.l) - ts) <= 0) return { px: ts, t: c.t };
    const lv = short ? c.h : c.l;
    if (d * (lv - ts) > 0) ts = lv;
  }
  return { open: true, stop: ts };
}
// One entry from candle `from` on: the stop, the target (then the trail, trailFrom), or (a far target, 15R+)
// the 🛡️ lock at +3R once +7R was reached, from the next candle on. A candle that touches both counts as the
// stop. null: still open (trailing included). result 'win' means it reached the target; R is where the trail let it out.
export function walkSingle(candles, from, { entry, sl, tp }, short) {
  const d = short ? -1 : 1, risk = Math.abs(entry - sl), far = risk > 0 && Math.abs(tp - entry) / risk >= FAR_LOCK.rr;
  let stop = sl, locked = false;
  for (let j = from; j < candles.length; j++) {
    const x = candles[j];
    if (d * ((short ? x.h : x.l) - stop) <= 0) return locked ? { result: 'lock', R: FAR_LOCK.to, exitT: x.t } : { result: 'loss', R: -1, exitT: x.t };
    if (d * ((short ? x.l : x.h) - tp) >= 0) {
      const tr = trailFrom(candles, j, stop, short);
      return tr.open ? null : { result: 'win', trail: true, R: d * (tr.px - entry) / risk, exitT: tr.t, tpT: x.t };
    }
    if (far && !locked && d * ((short ? x.l : x.h) - entry) >= FAR_LOCK.at * risk) { locked = true; stop = entry + d * FAR_LOCK.to * risk; }
  }
  return null;
}

// Bybit's standard fees: market orders in and at the stop (the trail's exit too), a limit at a fixed target.
export const TAKER_FEE = 0.00055, MAKER_FEE = 0.0002;
// The same trade run with the scaling plan (scalePlan, below): adds at +1R and
// +2R, stops to the entry after the first and to the whole position's
// break-even after the second. An add hit during a candle counts from the next
// one, and a candle that touches the stop and the target counts as the stop.
// `R` and `net` (after fees) are in units of the first entry's risk; `rr` is
// what the full plan makes at the target. result: 'win' (reached the target, then out on the trail), 'loss' (the
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
  // 🛡️ a far target (15R+ on the first entry): once +7R is reached the stop moves to +3R (FAR_LOCK)
  const far = risk > 0 && Math.abs(tp - entry) / risk >= FAR_LOCK.rr;
  let stop = sl, next = 0, locked = false;
  for (let j = k + 1; j < candles.length; j++) {
    const x = candles[j], adverse = short ? x.h : x.l, favour = short ? x.l : x.h;
    if (dir * (adverse - stop) <= 0) return out(locked ? 'lock' : next === 0 ? 'loss' : next === 1 ? 'entry' : 'be', stop, x.t, TAKER_FEE);
    if (dir * (favour - tp) >= 0) {
      const tr = trailFrom(candles, j, stop, short);
      return tr.open ? { ...out('open', candles.at(-1).c, null, 0), trailing: true, trailStop: tr.stop, tpT: x.t } : { ...out('win', tr.px, tr.t, TAKER_FEE), trail: true, tpT: x.t };
    }
    while (next < sp.adds.length && dir * (favour - sp.adds[next].price) >= 0) {
      const a = sp.adds[next++];
      legs.push({ px: a.price, size: a.size });
      stop = locked ? stop : a.stop;
    }
    if (far && !locked && dir * (favour - entry) >= FAR_LOCK.at * risk) { const lk = entry + dir * FAR_LOCK.to * risk; if (dir * (lk - stop) > 0) stop = lk; locked = true; }
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

// ---- Monitoring: the forming candle against the levels it could sweep ----
// Every live level the forming `candle` could make a signal at, by detect's own rules (old enough, in the
// outer part of the 7-day range, not used or broken), and where the candle stands against it:
//   'swept'   the wick went past and price is back inside: it signals if it closes here
//   'beyond'  price is past the level now: it needs to close back inside to signal
//   'near'    not reached yet; `toGo` is how far the wick still has to go (a share of price), `atr` in 4h ATRs
// Nearest first within each state. `history` is closed 4h candles ending right before `candle`.
export function nearLevels(history, candle, opts = ALERT_SETTINGS) {
  const o = { ...SFP_DEFAULTS, ...opts }, last = history.at(-1);
  if (!last || !candle) return [];
  // a flat stand-in for the forming candle: the levels as they are when it opened (none swept or broken by it)
  const flat = { t: candle.t, o: last.c, h: last.c, l: last.c, c: last.c };
  const { live } = detect([...history, flat], o);
  const k = history.length, back = history.slice(-Math.round((o.rangeDays ? o.rangeDays * 86_400_000 : o.lookbackDays * 86_400_000) / H4));
  const rHi = Math.max(...back.map(x => x.h)), rLo = Math.min(...back.map(x => x.l));
  const atr = atrAt(history, k - 1) || null, px = candle.c, order = { swept: 0, beyond: 1, near: 2 };
  return live.filter(l => k - l.i >= o.minAge).map(l => {
    const high = l.kind === 'high', pos = rHi > rLo ? (l.price - rLo) / (rHi - rLo) : null;
    if (o.edge && (pos === null || (high ? pos < 1 - o.edge : pos > o.edge))) return null;   // mid-range: wouldn't count
    const past = high ? l.price * (1 + o.minSweep) : l.price * (1 - o.minSweep);
    const swept = high ? candle.h > past : candle.l < past, beyond = high ? px > l.price : px < l.price;
    const toGo = swept ? 0 : (high ? past - candle.h : candle.l - past) / px;
    return { kind: l.kind, side: high ? 'Short' : 'Long', price: l.price, t: l.t, pos, state: swept ? (beyond ? 'beyond' : 'swept') : 'near',
      toGo, atr: atr ? (toGo * px) / atr : null, inside: (high ? l.price - px : px - l.price) / px, wick: high ? candle.h : candle.l };
  }).filter(Boolean).sort((a, b) => order[a.state] - order[b.state] || a.toGo - b.toGo || Math.abs(a.inside) - Math.abs(b.inside));
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
export const GRADE_ORDER = ['S++', 'S+', 'S', 'A+', 'A++', 'A', 'B+', 'C++', 'C+', 'B', 'C'];
// The tiers above and beside the A grades (tierOf):
//   S+  an A grade that's both a 💥 Full swing failure (fullSweep) and a ⭐ Golden R:R (goldenRaw). 5 years,
//       35 long-lived pairs, at plan times, EMA100 shorts left out, with the adds: +3.34R a trade on 53,
//       +1.39R without the best 3 (positive in 3 of 5 years). Sized as the A grade under it (`from`).
//       (An A+ with BTC's 1h RSI 🧊 cooled off was briefly S: +2.00R a trade over 5 years on the long-lived
//       pairs, but +0.36R in the past year across the watchlist, behind the plain A grades. The 🧊 tag tracks it.)
//   C+  an A grade whose candle engulfed the one before it (candleShape), taken with a limit 70% back.
//       It was S until the current plan's numbers: +2.47R on 29 but −0.73R without the best 3. Tracking only.
export const A_GRADES = new Set(['A++', 'A+', 'A']);
// ⚠️ A short while BTC sits above its 4h EMA100 (the candle before the signal, as the trend is read):
// across 5 years these lost every year (all signals −0.28R a trade; A grades at plan times −0.39R on
// 585). Still shown, marked, and given no size (`skip: 'ema'`, see proposedRisk), so the bot passes too.
export const SHORT_EMA = 100;
// 🛡️ Far target: when the target was 15R+ from the entry, once the trade reaches +7R the stop moves to +3R.
// 5 years, A grades at plan times, EMA100 shorts left out, with the adds: 547R against 531R holding, and the
// worst drawdown 148R against 159R. Those targets are rarely reached (2 of 108 at 20R+), and most that got to
// +5R gave it back. Taking half off instead made less (418R); clipping every trade made less too.
export const FAR_LOCK = { rr: 15, at: 7, to: 3 };
// ⭐ Golden R:R: an A grade (or S) whose target, from the close, is 10–20R away and within 10 ATR(14) of
// the entry: room to pay, but a target the coin can reach. 5 years, A grades at plan times, with the adds:
// +1.05R a trade on 236 (+0.55R without the best 3), positive in 4 of 5 years. Found by slicing the R:R
// bands after the fact, so it's tracking only. `atr`: the coin's ATR(14) at the signal candle (atrAt).
export function atrAt(candles, k, n = 14) {
  if (k <= n) return null;
  let a = 0;
  for (let i = k - n; i < k; i++) a += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  return a / n;
}
export const goldenRaw = (trade, atr) => Boolean(trade && atr && trade.rr >= 10 && trade.rr < 20 && Math.abs(trade.tp - trade.entry) <= 10 * atr);
// the tag: A grades and what's built on them (S, and C+, which is always an A grade underneath)
export const goldenRR = (grade, trade, atr) => Boolean(grade && (A_GRADES.has(grade) || grade === 'S+' || grade === 'S' || grade === 'C+') && goldenRaw(trade, atr));
// 💥 Full swing failure: the signal's wick also went past the swing candle's own wick (the levels are the
// swing candle's body), at the furthest level swept. 5 years, A grades at plan times, EMA100 shorts left
// out, with the adds: +0.55R a trade on 515, +0.34R without the best 3, positive in all 5 years
// (body-only sweeps +0.38R, 2 losing years). `candleAt(t)`: the 4h candle starting at t.
export function fullSweep(s, candleAt) {
  if (!s?.levels?.length) return false;
  const short = s.side === 'Short', lv = s.levels.reduce((a, b) => (short ? (b.price > a.price ? b : a) : (b.price < a.price ? b : a)));
  const sc = candleAt(lv.t);
  return Boolean(sc) && (short ? s.high > sc.h : s.low < sc.l);
}
export const emaGuard = (g, side, btcAbove) => (g && side === 'Short' && btcAbove ? { ...g, skip: 'ema' } : g);
export function tierOf(g, { shape = null, full = false, grr = false, btcRsi = null, rr = null, whale = null, zone = false } = {}) {
  if (!g || !A_GRADES.has(g.grade)) return g;
  // S++: an S+ or S that's also a ⭐ golden R:R and in the ✨ golden zone (BTC's NY pullback). 1 year, 63 pairs,
  // with the adds: +10.59R a trade on 15 (+4.16R without the best 3), 5 of them 26R+; picked after the fact, so
  // sized as the A grade under it and forward-tested.
  // The S route skips S's 🧊 BTC cool-off: the ✨ golden zone already says BTC pulled back from NY's move.
  const t = tierOfBase(g, { shape, full, grr, btcRsi, rr, whale });
  const viaS = whale === 'absorbed' && (g.grade === 'A' || g.grade === 'A+');
  if (zone && grr && (t.grade === 'S+' || t.grade === 'S' || viaS)) return { ...t, grade: 'S++', from: g.grade, why: `${t.grade === 'S+' ? t.why : `${g.grade} (${g.why}) with 🐋 whale absorption`}, a ⭐ golden R:R in the ✨ golden zone` };
  return t;
}
function tierOfBase(g, { shape = null, full = false, grr = false, btcRsi = null, rr = null, whale = null } = {}) {
  if (!g || !A_GRADES.has(g.grade)) return g;
  if (full && grr) return { ...g, grade: 'S+', from: g.grade, why: `${g.grade} (${g.why}): a full swing failure with a golden R:R` };
  // S: an A or A+ with 🐋 Whale Absorption (whaleAbsorption). 1 year, plan trades with the adds: +2.61R a trade on 46
  // (A/A+ without it +0.79R); 10R+ runners 8.7% against 2.9%, but about −0.01R without the best 3 and ~8% odds
  // of luck, so it's sized as the A grade under it, like S+, and forward-tested.
  // …and BTC's 1h RSI 🧊 cooled off (35–45 read the trade's way): on the Signals view (wrong time hidden) S with it
  // made +1.81R on 31 with 5 winners, against 1 winner in 23 with BTC oversold / overbought against the trade.
  if (whale === 'absorbed' && btcRsi === 'cool' && (g.grade === 'A' || g.grade === 'A+')) return { ...g, grade: 'S', from: g.grade, why: `${g.grade} (${g.why}) with 🐋 whale absorption and 🧊 BTC cooled off` };
  if (shape?.engulf) return { ...g, grade: 'C+', from: g.grade, why: `${g.grade} (${g.why}) whose candle ${shape.engulf === 'wick' ? 'closed past the last candle’s wick' : 'engulfed the last candle’s body'}: tracking, a 🪜 ladder 70–90% back` };
  return g;
}

// BTC's 1h RSI at the close, read from the setup's side (a short sees 100 − RSI, so low is
// always "BTC stretched against the trade"). Backtest (A-grades, main closes Mon–Thu, past year):
//   35–45  🧊 BTC cooled: pulled back without breaking down      86 trades, +2.90R a trade without the best 3
//   ≤35    ⚠️ BTC oversold (overbought for a short): the pullback is a turn     104, −0.22R without the best 3
//   ≥60    ⚠️ BTC extended the trade's way (ran already)           45, −0.17R a trade, no quarter positive
//   (all A-grades there: +1.35R without the best 3). A tag for tracking: grades and sizes don't change.
export const BTC_RSI_BANDS = { deep: 35, cool: 45, chase: 60 };
export function btcRsiTag(side, r) {
  if (r == null || !Number.isFinite(r)) return null;
  const v = side === 'Short' ? 100 - r : r, n = Math.round(r), against = side === 'Short' ? 'overbought' : 'oversold';
  if (v <= BTC_RSI_BANDS.deep) return { kind: 'deep', rsi: n, text: `⚠️ BTC ${against} against it (1h RSI ${n}): the pullback may be a turn` };
  if (v <= BTC_RSI_BANDS.cool) return { kind: 'cool', rsi: n, text: `🧊 BTC cooled off (1h RSI ${n}): pulled back, not broken` };
  if (v >= BTC_RSI_BANDS.chase) return { kind: 'chase', rsi: n, text: `⚠️ BTC already extended the trade’s way (1h RSI ${n}): wait for a cool-off` };
  return null;
}

// The signal candle's shape. `away`: it already closed the trade's way (a long on a green
// candle, a short on a red one), so the close sits far from the swept level; a limit 70% of
// the candle back toward the wick gives the entry its R:R back (tracking: in the past year
// it made far more than taking the close, but not in the year before). `engulf`: it closed past the
// previous candle's wick ('wick') or only its body ('body').
export function candleShape(prev, c, side) {
  if (!c || !(c.h > c.l)) return null;
  const short = side === 'Short', away = short ? c.c < c.o : c.c > c.o;
  const engulf = !away || !prev ? null : (short ? c.c < prev.l : c.c > prev.h) ? 'wick' : (short ? c.c < Math.min(prev.o, prev.c) : c.c > Math.max(prev.o, prev.c)) ? 'body' : null;
  const back = f => (short ? c.l + f * (c.h - c.l) : c.h - f * (c.h - c.l));
  return { away, engulf, limit: back(0.7), ladder: LADDER.map(back) };
}

// 🪜 The entry for a candle that closed away from the level: five equal limits 70%, 75%, 80%, 85% and 90% of the
// candle back toward the wick, each risking a fifth of 1R to the same wick stop (so the deeper ones are bigger).
// 1 year, 68 pairs, closed-away plan trades with the adds: +1.43R a setup (+0.16R without the best 3) against
// +0.56R for one limit at 70% (−0.23R); A grades and up +1.13R against +0.81R. First entry only it's about even.
// Slippage at the tight stops of the deep rungs isn't modelled, so the real edge is smaller.
export const LADDER = [0.7, 0.75, 0.8, 0.85, 0.9];
// When the plan enters on the 🪜 ladder instead of the close: 'away', a candle that closed away from the level
// (every grade), or 'chase', BTC's 1h RSI has ⚠️ already run the trade's way on an A+, A++, B or C (the move
// is mostly done, so wait for the pullback). 1 year, plan trades tagged ⚠️: +1.90R a setup on the ladder against
// +0.95R at the close; A+ +2.10R and A++ +2.11R better, plain A worse (−0.68R, so it stays at the close). The
// gain comes from fewer, bigger runners (without the best 3 it's about even), and the samples are small.
export const CHASE_LADDER = new Set(['A+', 'A++', 'B', 'C']);
export function ladderWhy(grade, btcRsiKind, shape) {
  if (!shape?.ladder) return null;
  if (shape.away) return 'away';
  return btcRsiKind === 'chase' && CHASE_LADDER.has(grade) ? 'chase' : null;
}
const ladderSum = (rungs, f) => rungs.reduce((n, t) => n + 0.2 * f(t), 0);
// The trade as the five limits played out (limitTrade for each). R, net and the scaled result are in units of the
// whole setup's 1R (a rung that never filled adds 0). entry: the size-weighted average of the rungs that filled.
export function ladderTrade(candles, k, trade, short, prices) {
  if (!trade || !prices?.length) return trade;
  const placed = prices.map(px => limitTrade(candles, k, trade, short, px)).filter(t => t?.limit);
  if (!placed.length) return trade;
  const filled = placed.filter(t => !t.missed && !t.pending);
  const rr = ladderSum(placed, t => t.rr);
  const base = { ...trade, limit: true, ladder: { prices: placed.map(t => t.entry), filled: filled.map(t => t.entry) }, close: trade.entry, rr, riskPct: placed[0].riskPct };
  if (!filled.length) {
    if (placed.some(t => t.pending)) return { ...base, entry: placed[0].entry, R: 0, pending: true, scaled: { result: 'open', R: 0, net: null, exitT: null, adds: 0, rr } };
    return { ...base, entry: placed[0].entry, result: 'missed', missed: placed[0].missed, R: null, scaled: null };
  }
  const size = t => 1 / Math.abs(t.entry - t.sl);
  const entry = filled.reduce((n, t) => n + size(t) * t.entry, 0) / filled.reduce((n, t) => n + size(t), 0);
  const first = [...filled].sort((a, b) => a.fillT - b.fillT)[0];
  const open = filled.some(t => t.result === 'open');
  const singleNet = t => t.R - (MAKER_FEE + (t.result === 'win' && !t.trail ? MAKER_FEE : TAKER_FEE)) / t.riskPct;   // a limit in; out on a stop (the trail) or a limit
  const scOpen = filled.some(t => !t.scaled || t.scaled.result === 'open');
  return { ...base, entry, fillT: first.fillT, result: open ? 'open' : first.result, R: ladderSum(filled, t => t.R ?? 0),
    net: open ? null : ladderSum(filled, singleNet), exitT: open ? null : Math.max(...filled.map(t => t.exitT || 0)) || null,
    scaled: { result: scOpen ? 'open' : first.scaled.result, R: ladderSum(filled, t => t.scaled?.R ?? 0), net: scOpen ? null : ladderSum(filled, t => t.scaled.net),
      exitT: scOpen ? null : Math.max(...filled.map(t => t.scaled.exitT || 0)) || null, adds: Math.max(...filled.map(t => t.scaled?.adds || 0)), rr: ladderSum(placed, t => t.scaled?.rr ?? t.rr),
      ...trailOf(filled.map(t => t.scaled)) },
    ...trailOf(filled) };
}

// the trail's state across a ladder's rungs (they share the target, so they reach it together)
function trailOf(xs) {
  const hit = xs.filter(x => x?.tpT != null);
  if (!hit.length) return {};
  return { trail: xs.some(x => x?.trail), trailing: xs.some(x => x?.trailing), tpT: Math.min(...hit.map(x => x.tpT)), trailStop: hit.find(x => x.trailStop != null)?.trailStop };
}
// The same trade from a limit at `limit` (candleShape's 70% back) instead of the close: same stop and
// target, R:R from the limit. The order waits up to 24h (6 candles) and is cancelled if the target trades
// first (a candle that reaches both without a fill counts as cancelled; one that fills and hits the stop
// counts the stop). `missed`: 'ran' or 'expired' when it never filled. `fillT`: the candle it filled in.
export const LIMIT_WAIT = 6;
export function limitTrade(candles, k, trade, short, limit) {
  if (!trade || limit == null) return trade;
  const { sl, tp } = trade, risk = Math.abs(sl - limit);
  if (!(risk > 0) || (short ? !(limit < sl && limit > tp) : !(limit > sl && limit < tp))) return trade;
  const plan = { ...trade, entry: limit, rr: Math.abs(tp - limit) / risk, riskPct: risk / limit, result: 'open', R: null, exitT: null, limit: true, close: trade.entry };
  const rrScaled = scalePlan(plan, short ? 'Short' : 'Long').R;
  const missed = why => ({ ...plan, result: 'missed', missed: why, R: null, scaled: null });
  for (let j = k + 1; j < candles.length; j++) {
    const x = candles[j];
    if (j > k + LIMIT_WAIT) return missed('expired');
    const fills = short ? x.h >= limit : x.l <= limit, ran = short ? x.l <= tp : x.h >= tp;
    if (!fills) { if (ran) return missed('ran'); continue; }
    if (ran) return missed('ran');
    const fillT = x.t;
    if (short ? x.h >= sl : x.l <= sl) {
      const fee = (TAKER_FEE * limit + TAKER_FEE * sl) / risk;
      return { ...plan, fillT, result: 'loss', R: -1, exitT: x.t, scaled: { result: 'loss', R: -1, net: -1 - fee, exitT: x.t, adds: 0, rr: rrScaled } };
    }
    const scaled = scaledResult(candles, j, plan, short);
    const end = walkSingle(candles, j + 1, plan, short);
    if (end) return { ...plan, fillT, ...end, scaled };
    const last = candles.at(-1);
    return { ...plan, fillT, R: j < candles.length - 1 ? (short ? limit - last.c : last.c - limit) / risk : 0, scaled };
  }
  return { ...plan, R: 0, pending: true, scaled: { result: 'open', R: 0, net: null, exitT: null, adds: 0, rr: rrScaled } };   // waiting for the fill
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
//   at the target, trail the stop behind each closed 4h candle (trailFrom)
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

// 🐋 Whale Absorption: retail panicking into the sweep, and someone bigger soaking it up.
//   panic     funding (scaled to 8h) is against the trade's side: the crowd leans the other way
//   absorbed  the signal candle's aggressive market orders against the trade (taker sells for a long,
//             taker buys for a short; Binance 4h taker volume) were in the top 20% of the coin's last
//             30 days, yet the candle still closed back inside the level
//   crowded   the trade's own side pays heavy funding: the crowd is with you, nobody left to absorb
// 1 year, 63 pairs, plan trades with the adds, after fees (all: +1.28R a trade, +0.92R without the best 3):
//   panic + absorbed +2.43R on 84 (+1.03R without the best 3); panic without absorption +0.84R (+0.12R);
//   absorption without panic +0.29R (−0.33R); crowded −0.18R on 19 (−0.72R), negative in both halves.
// Tracking only: grades and sizes don't change.
export const WHALE = { panic: -0.00005, crowded: 0.00015, absorbed: 0.8, days: 30 };
export const WHALE_TIP = '🐋 Whale Absorption: retail panicking into the sweep while someone bigger takes the other side.\n' +
  '• Panic: funding is against your side (scaled to 8h), so the crowd is leaning the other way and paying for it.\n' +
  '• Absorbed: on the signal candle, market orders against you (sells for a long, buys for a short) were in the top 20% of the coin’s last 30 days, yet price still closed back inside the level. Someone soaked them up.\n' +
  '• Both together = 🐋. Your own side paying heavy funding (over 0.015% per 8h) = ⚠️ crowded: nobody left to absorb.\n' +
  'Backtest (1 year, plan trades, with adds, after fees): 🐋 +2.43R a trade on 84 (+1.03R without the best 3) vs +1.28R for all; panic alone +0.84R; absorption alone +0.29R; ⚠️ crowded −0.18R on 19. Tracking only, small samples: sizes don’t change.';
// funding: [{ t, rate }] oldest first (Bybit settlements); taker: [{ t, vol, buy }] 4h candles oldest first.
// `t`: the signal candle's start. Reads funding settled by the close and the signal candle's own taker flow.
export function whaleAbsorption(side, t, { funding = [], taker = [] } = {}) {
  const short = side === 'Short', close = t + H4, d = short ? -1 : 1;
  const fs = funding.filter(f => f.t <= close);
  if (fs.length < 2) return null;
  const last = fs.at(-1), iv = Math.max(3_600_000, last.t - fs.at(-2).t);
  const fund8h = d * last.rate * (8 * 3_600_000 / iv);                // read the trade's way: negative = we get paid
  const pct = r => `${(r * 100).toFixed(3)}%`;
  if (fund8h >= WHALE.crowded) return { kind: 'crowded', fund8h, text: `⚠️ Crowded: your side pays ${pct(fund8h)} funding per 8h, nobody left to absorb` };
  if (!(fund8h < WHALE.panic)) return null;
  const k = taker.findIndex(c => c.t === t);
  const n = WHALE.days * 6;
  if (k < n) return null;
  const against = c => (c.vol > 0 ? (short ? c.buy / c.vol : 1 - c.buy / c.vol) : null);
  const now = against(taker[k]), past = taker.slice(k - n, k).map(against).filter(x => x != null);
  if (now == null || past.length < n / 2) return null;
  const rank = past.filter(x => x < now).length / past.length;
  if (rank < WHALE.absorbed) return null;
  return { kind: 'absorbed', fund8h, rank, text: `🐋 Whale Absorption: funding against your side (${pct(-fund8h)} per 8h paid to you), and ${Math.round(now * 100)}% of the candle’s market orders hit against you (top ${Math.max(1, Math.round((1 - rank) * 100))}% of 30 days) yet it closed back inside` };
}

// ---- projected win rate: the grade, then each tag's lift on top of it ----
// Learned from closed signals (won = target or 🛡️ lock; with the adds, a stop at the entry or break-even
// isn't a win). Each tag's lift is measured against what its signals' grades alone would expect, so a tag
// that mostly rides on A grades doesn't get counted twice; small samples are pulled toward "no effect".
// The lifts are added in log-odds and damped (tags overlap), then the exact grade + tags combination is
// shown beside it when it has enough history. `tagsOf` lists the tags a signal carries.
export const WINRATE = { k: 20, damp: 0.7, minCombo: 10, lo: 0.02, hi: 0.9 };
const logit = p => Math.log(p / (1 - p)), sigm = x => 1 / (1 + Math.exp(-x));
// tags a grade already stands for (S is the 🐋, S+ the 💥 + ⭐): not counted again on top of it
const IMPLIED = { S: ['whale:absorbed', 'rsi:cool'], 'S+': ['full', 'grr'], 'S++': ['grr', 'nypull'] };   // an S++ via 🐋 keeps its 🐋 tag counted: it isn't implied by S+'s route
export function signalTags(s) {
  return rawTags(s).filter(t => !IMPLIED[s.grade?.grade]?.includes(t));
}
function rawTags(s) {
  const t = [s.full ? 'full' : 'body'];
  if (s.whale) t.push('whale:' + s.whale.kind);
  if (s.goldenRR) t.push('grr');
  if (s.golden != null) t.push('nypull');
  if (s.btcRsi) t.push('rsi:' + s.btcRsi.kind);
  if (s.shape?.engulf) t.push('engulf'); else if (s.shape?.away) t.push('away');
  if (s.grade?.skip === 'ema') t.push('ema');
  if (s.trend) t.push('trend:' + s.trend);
  return t;
}
// outcome(s) → true (won) / false (lost) / null (open, or never filled)
export function winModel(signals, outcome) {
  const done = signals.map(s => ({ s, w: outcome(s) })).filter(x => x.w != null && x.s.grade);
  if (done.length < 50) return null;
  const { k } = WINRATE, p0 = done.filter(x => x.w).length / done.length;
  const grades = {};
  for (const { s, w } of done) { const g = (grades[s.grade.grade] ||= { n: 0, w: 0 }); g.n++; g.w += w; }
  for (const g of Object.values(grades)) g.p = (g.w + k * p0) / (g.n + k);
  const tags = {}, combos = {};
  for (const { s, w } of done) {
    const e = grades[s.grade.grade].p, tg = signalTags(s);
    for (const t of tg) { const x = (tags[t] ||= { n: 0, w: 0, e: 0 }); x.n++; x.w += w; x.e += e; }
    const c = (combos[comboKey(s.grade.grade, tg)] ||= { n: 0, w: 0 }); c.n++; c.w += w;
  }
  for (const x of Object.values(tags)) { const exp = x.e / x.n; x.lift = logit(Math.min(0.99, Math.max(0.01, (x.w + k * exp) / (x.n + k)))) - logit(Math.min(0.99, Math.max(0.01, exp))); }
  for (const [key, c] of Object.entries(combos)) if (c.n < WINRATE.minCombo) delete combos[key];
  return { p0, n: done.length, grades, tags, combos, from: Math.min(...done.map(x => x.s.t)), to: Math.max(...done.map(x => x.s.t)) };
}
const comboKey = (g, tags) => g + '|' + [...tags].sort().join(',');
export function projectWin(s, m) {
  if (!m || !s?.grade) return null;
  const g = m.grades[s.grade.grade] || { n: 0, p: m.p0 };
  const parts = [];
  let x = logit(g.p);
  for (const t of signalTags(s)) { const tg = m.tags[t]; if (!tg) continue; const d = WINRATE.damp * tg.lift; x += d; parts.push({ tag: t, n: tg.n, d }); }
  const p = Math.min(WINRATE.hi, Math.max(WINRATE.lo, sigm(x)));
  // each tag's effect in percentage points, as it moved the estimate (in order, for the tooltip)
  let run = logit(g.p);
  for (const q of parts) { const before = sigm(run); run += q.d; q.pts = (sigm(run) - before) * 100; }
  return { p, grade: { g: s.grade.grade, n: g.n, p: g.p }, parts, combo: m.combos[comboKey(s.grade.grade, signalTags(s))] || null };
}
