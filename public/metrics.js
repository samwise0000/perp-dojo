// Report maths. Pure functions over normalized trades (see lib/trades.mjs),
// shared by the page and the tests. Money is USD; a trade is one close.

const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) || 0), 0);
const DAY = 86_400_000;

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const net = sum(trades, t => t.pnl);
  const grossWin = sum(wins, t => t.pnl), grossLoss = -sum(losses, t => t.pnl);
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const withFunding = trades.filter(t => t.funding !== null && t.funding !== undefined);

  // equity curve and drawdown, in time order
  let eq = 0, peak = 0, peakTime = trades[0]?.time ?? null, maxDD = 0, ddFrom = null, ddTo = null;
  const equity = [], drawdown = [];
  let run = 0, runPnl = 0, maxWinRun = 0, maxLossRun = 0, maxLossRunPnl = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) { peak = eq; peakTime = t.time; }
    const dd = eq - peak;
    if (dd < maxDD) { maxDD = dd; ddFrom = peakTime; ddTo = t.time; }
    equity.push({ x: t.time, y: eq });
    drawdown.push({ x: t.time, y: dd });
    // streaks; a breakeven close ends both
    const s = t.pnl > 0 ? 1 : t.pnl < 0 ? -1 : 0;
    if (s !== 0 && Math.sign(run) === s) { run += s; runPnl += t.pnl; } else { run = s; runPnl = t.pnl; }
    if (run > maxWinRun) maxWinRun = run;
    if (-run > maxLossRun) { maxLossRun = -run; maxLossRunPnl = runPnl; }
  }
  const byPnl = [...trades].sort((a, b) => a.pnl - b.pnl);
  const liqs = trades.filter(t => t.liquidation);
  const roms = trades.filter(t => t.margin > 0).map(t => t.pnl / t.margin);

  return {
    n, net,
    wins: wins.length, losses: losses.length, breakeven: n - wins.length - losses.length,
    winRate: n ? wins.length / n : null,
    grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgWin, avgLoss,
    payoff: avgWin !== null && avgLoss ? avgWin / avgLoss : null,
    expectancy: n ? net / n : null,
    pricePnl: sum(trades, t => t.gross),
    fees: sum(trades, t => t.fees),
    funding: withFunding.length ? sum(withFunding, t => t.funding) : null,
    volume: sum(trades, t => t.notional),
    best: byPnl[n - 1] || null, worst: byPnl[0] || null,
    maxDrawdown: maxDD, ddFrom, ddTo,
    currentDrawdown: n ? eq - peak : 0,
    maxWinStreak: maxWinRun, maxLossStreak: maxLossRun, maxLossStreakPnl: maxLossRunPnl,
    currentStreak: run,
    liquidations: liqs.length, liquidationPnl: sum(liqs, t => t.pnl),
    avgLeverage: n ? sum(trades, t => t.leverage) / n : null,
    avgReturnOnMargin: roms.length ? roms.reduce((a, b) => a + b, 0) / roms.length : null,
    first: trades[0]?.time ?? null, last: trades[n - 1]?.time ?? null,
    equity, drawdown,
  };
}

// Light-weight per-group stats for tables and bar charts.
export function groupStats(trades, keyOf) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups].map(([key, ts]) => {
    const wins = ts.filter(t => t.pnl > 0).length;
    const gw = sum(ts.filter(t => t.pnl > 0), t => t.pnl), gl = -sum(ts.filter(t => t.pnl < 0), t => t.pnl);
    return {
      key, n: ts.length, wins, net: sum(ts, t => t.pnl), fees: sum(ts, t => t.fees),
      volume: sum(ts, t => t.notional), winRate: wins / ts.length,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
      expectancy: sum(ts, t => t.pnl) / ts.length,
    };
  });
}

const pad = n => String(n).padStart(2, '0');
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// P&L per day, week (Monday start) or month in local time, with empty periods filled in.
export function periodPnl(trades, from, to) {
  if (!trades.length) return { unit: 'day', buckets: [] };
  const start = from ?? trades[0].time, end = to ?? trades[trades.length - 1].time;
  const span = (end - start) / DAY;
  const unit = span <= 92 ? 'day' : span <= 550 ? 'week' : 'month';
  const floor = ms => {
    const d = new Date(ms); d.setHours(0, 0, 0, 0);
    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    if (unit === 'month') d.setDate(1);
    return d;
  };
  const next = d => {
    const e = new Date(d);
    if (unit === 'day') e.setDate(e.getDate() + 1);
    else if (unit === 'week') e.setDate(e.getDate() + 7);
    else e.setMonth(e.getMonth() + 1);
    return e;
  };
  const map = new Map();
  for (const t of trades) {
    const k = dayKey(floor(t.time));
    const b = map.get(k) || { net: 0, n: 0 };
    b.net += t.pnl; b.n++; map.set(k, b);
  }
  const buckets = [];
  for (let d = floor(start); d.getTime() <= end; d = next(d)) {
    const b = map.get(dayKey(d)) || { net: 0, n: 0 };
    buckets.push({ start: d.getTime(), end: next(d).getTime() - 1, ...b });
  }
  return { unit, buckets };
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// `at` picks which moment counts: the close (default) or the open. Trades
// without that moment (an open from before the pulled fills) are left out.
const timed = (trades, at) => trades.filter(t => Number.isFinite(at(t)));

export function byWeekday(trades, at = t => t.time) {
  const g = groupStats(timed(trades, at), t => (new Date(at(t)).getDay() + 6) % 7);
  return WEEKDAYS.map((label, i) => ({ label, ...(g.find(x => x.key === i) || { n: 0, net: 0, winRate: null }) }));
}

export function byHour(trades, at = t => t.time) {
  const g = groupStats(timed(trades, at), t => new Date(at(t)).getHours());
  return Array.from({ length: 24 }, (_, h) => ({ label: pad(h), ...(g.find(x => x.key === h) || { n: 0, net: 0, winRate: null }) }));
}

// Trade P&L distribution: equal-width bins, with zero always on a bin edge.
export function histogram(trades, bins = 24) {
  if (trades.length < 2) return [];
  const vals = trades.map(t => t.pnl).sort((a, b) => a - b);
  // trim the extreme 1% each side so one outlier doesn't flatten everything
  const lo = vals[Math.floor(vals.length * 0.01)], hi = vals[Math.ceil(vals.length * 0.99) - 1];
  if (hi <= lo) return [];
  const raw = (hi - lo) / bins;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const width = [1, 2, 2.5, 5, 10].map(m => m * mag).find(w => w >= raw);
  const first = Math.floor(lo / width) * width;
  const count = Math.max(1, Math.ceil((hi - first) / width));
  const out = Array.from({ length: count }, (_, i) => ({ from: first + i * width, to: first + (i + 1) * width, n: 0 }));
  for (const v of vals) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((v - first) / width)));
    out[i].n++;
  }
  return out;
}

// Plain-language observations, most useful first. `fmt` formats signed USD.
export function insights(trades, s, fmt) {
  const out = [];
  if (s.n < 10) return out;
  const pct = x => Math.round(x * 100) + '%';

  const sides = groupStats(trades, t => t.dir);
  const L = sides.find(x => x.key === 'Long'), S = sides.find(x => x.key === 'Short');
  if (L && S && L.n >= 5 && S.n >= 5) {
    if (Math.sign(L.net) !== Math.sign(S.net)) {
      const [good, bad] = L.net > S.net ? [L, S] : [S, L];
      out.push(`Your ${good.key.toLowerCase()}s made ${fmt(good.net)} over ${good.n} trades, while your ${bad.key.toLowerCase()}s lost ${fmt(bad.net)} over ${bad.n}.`);
    } else {
      const [better, worse] = L.expectancy > S.expectancy ? [L, S] : [S, L];
      out.push(`${better.key}s are your stronger side: ${fmt(better.expectancy)} per trade, against ${fmt(worse.expectancy)} for ${worse.key.toLowerCase()}s.`);
    }
  }

  const syms = groupStats(trades, t => t.symbol).filter(x => x.n >= 3).sort((a, b) => a.net - b.net);
  const worstSym = syms[0], bestSym = syms[syms.length - 1];
  if (worstSym && worstSym.net < 0 && syms.length > 1)
    out.push(`${worstSym.key} cost you the most: ${fmt(worstSym.net)} across ${worstSym.n} trades at a ${pct(worstSym.winRate)} win rate.`);
  if (bestSym && bestSym.net > 0 && syms.length > 1)
    out.push(`${bestSym.key} was your best market: ${fmt(bestSym.net)} across ${bestSym.n} trades.`);

  if (s.winRate !== null && s.payoff !== null) {
    if (s.winRate >= 0.5 && s.payoff < 1 && s.net < 0)
      out.push(`You win often (${pct(s.winRate)} of trades), but the average loss (${fmt(-s.avgLoss)}) is bigger than the average win (${fmt(s.avgWin)}), and that's what sinks the total.`);
    else if (s.winRate < 0.4 && s.payoff > 2)
      out.push(`You win only ${pct(s.winRate)} of trades, but winners average ${s.payoff.toFixed(1)}× the size of losers.`);
  }

  if (s.grossWin > 0 && s.fees > 0 && s.fees / s.grossWin >= 0.1)
    out.push(`Trading fees came to ${fmt(-s.fees)}, which is ${pct(s.fees / s.grossWin)} of everything your winning trades made.`);

  if (s.funding !== null && Math.abs(s.funding) >= Math.max(1, Math.abs(s.net) * 0.05))
    out.push(s.funding > 0
      ? `You paid ${fmt(-s.funding)} in funding while holding positions.`
      : `You earned ${fmt(-s.funding)} from funding while holding positions.`);

  const losers = trades.filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  if (losers.length >= 15) {
    const top = -sum(losers.slice(0, 5), t => t.pnl);
    if (top / s.grossLoss >= 0.4)
      out.push(`Your 5 worst trades account for ${pct(top / s.grossLoss)} of all losses. Cutting those short would change the picture most.`);
  }

  if (s.liquidations > 0)
    out.push(`${s.liquidations} position${s.liquidations === 1 ? ' was' : 's were'} liquidated, for ${fmt(s.liquidationPnl)} in total.`);

  const days = byWeekday(trades).filter(d => d.n >= 5).sort((a, b) => a.net - b.net);
  if (days.length >= 3 && days[0].net < 0)
    out.push(`${fullDay(days[0].label)} was your worst day of the week: ${fmt(days[0].net)} over ${days[0].n} trades.`);

  const hi = trades.filter(t => t.leverage >= 20), lo = trades.filter(t => t.leverage < 20);
  if (hi.length >= 10 && lo.length >= 10) {
    const eh = sum(hi, t => t.pnl) / hi.length, el = sum(lo, t => t.pnl) / lo.length;
    if (Math.sign(eh) !== Math.sign(el) || Math.abs(eh - el) > Math.abs(el) * 0.5)
      out.push(`At 20× leverage or more you averaged ${fmt(eh)} per trade, and below 20× you averaged ${fmt(el)}.`);
  }

  const hs = holdStats(trades);
  const kw = hs.points.filter(t => t.pnl > 0).length, kl = hs.points.filter(t => t.pnl < 0).length;
  if (kw >= 8 && kl >= 8 && hs.medianWin && hs.medianLoss) {
    const r = hs.medianLoss / hs.medianWin;
    if (r >= 1.5) out.push(`You hold losing trades longer than winners: a median of ${fmtDuration(hs.medianLoss)} against ${fmtDuration(hs.medianWin)}.`);
    else if (r <= 0.67) out.push(`You cut losers faster than you take winners: a median hold of ${fmtDuration(hs.medianLoss)} on losses and ${fmtDuration(hs.medianWin)} on wins.`);
  }

  if (s.maxLossStreak >= 5)
    out.push(`Your longest losing run was ${s.maxLossStreak} trades in a row, for ${fmt(s.maxLossStreakPnl)}.`);

  return out;
}

const fullDay = d => ({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' })[d];

// ---- dashboard ----

// Net P&L per local calendar day: Map 'YYYY-MM-DD' → { net, n, wins, trades }
export function dailyMap(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = dayKey(new Date(t.time));
    const d = m.get(k) || { key: k, net: 0, n: 0, wins: 0, trades: [] };
    d.net += t.pnl; d.n++; if (t.pnl > 0) d.wins++; d.trades.push(t);
    m.set(k, d);
  }
  return m;
}

// Streaks counted over days you traded (days with no trades don't break a streak).
export function dayStreaks(daily) {
  const days = [...daily.values()].sort((a, b) => a.key.localeCompare(b.key));
  let run = 0, bestWin = 0, bestLoss = 0;
  for (const d of days) {
    const s = d.net > 0 ? 1 : d.net < 0 ? -1 : 0;
    run = s !== 0 && Math.sign(run) === s ? run + s : s;
    bestWin = Math.max(bestWin, run); bestLoss = Math.max(bestLoss, -run);
  }
  const green = days.filter(d => d.net > 0).length, red = days.filter(d => d.net < 0).length;
  return { current: run, bestWin, bestLoss, green, red, flat: days.length - green - red, days: days.length };
}

const clamp01 = x => Math.max(0, Math.min(1, x));

// A 0–100 score on six axes, each a plain transform of a standard stat so it
// can be explained in one line. No axis uses the account balance, so deposits
// and withdrawals can't move it. Needs at least 10 trades.
export function tradingScore(s, ds) {
  if (s.n < 10) return null;
  const rf = s.maxDrawdown < 0 ? s.net / -s.maxDrawdown : s.net > 0 ? 3 : 0;
  // drawdown measured in average losing trades: 3 or fewer scores 100, 20 or more scores 0
  const ddLosses = s.avgLoss ? -s.maxDrawdown / s.avgLoss : 0;
  const axes = [
    { key: 'winRate', label: 'Win %', value: 100 * clamp01(s.winRate), how: `${Math.round(s.winRate * 100)}% of trades closed in profit` },
    { key: 'pf', label: 'Profit factor', value: 100 * (s.profitFactor === Infinity ? 1 : clamp01(((s.profitFactor ?? 0) - 0.5) / 2)), how: 'Gross wins ÷ gross losses; 0.5 scores 0, 2.5 or more scores 100' },
    { key: 'payoff', label: 'Avg win/loss', value: 100 * clamp01((s.payoff ?? 0) / 2.5), how: 'Average win ÷ average loss; 2.5× or more scores 100' },
    { key: 'recovery', label: 'Recovery factor', value: 100 * clamp01((rf + 1) / 4), how: 'Net P&L ÷ max drawdown; −1 scores 0, 3 or more scores 100' },
    { key: 'drawdown', label: 'Max drawdown', value: 100 * clamp01(1 - (ddLosses - 3) / 17), how: `Deepest drop was ${ddLosses.toFixed(1)}× your average loss; 3× or less scores 100, 20× or more scores 0` },
    { key: 'consistency', label: 'Consistency', value: ds.days ? (100 * ds.green) / ds.days : 0, how: `${ds.green} of ${ds.days} trading days were green` },
  ];
  return { axes, score: axes.reduce((n, a) => n + a.value, 0) / axes.length };
}

// 45s · 12m · 3h 20m · 2d 4h
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

// Hold times, where the open could be reconstructed from fills.
export function holdStats(trades) {
  const known = trades.filter(t => t.duration !== null && t.duration !== undefined);
  const median = a => { if (!a.length) return null; const v = a.map(t => t.duration).sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  return {
    known: known.length, unknown: trades.length - known.length,
    median: median(known),
    medianWin: median(known.filter(t => t.pnl > 0)), medianLoss: median(known.filter(t => t.pnl < 0)),
    points: known,
  };
}

// Weeks (Mon–Sun) covering a calendar month, each day with its P&L.
export function calendarMonth(daily, year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  const weeks = [];
  for (let d = new Date(start); weeks.length < 6; ) {
    const days = [];
    for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      days.push({ key: k, date: new Date(d), inMonth: d.getMonth() === month, ...(daily.get(k) || { net: 0, n: 0, wins: 0, trades: [] }) });
    }
    weeks.push({ days, net: days.reduce((n, x) => n + x.net, 0), n: days.reduce((n, x) => n + x.n, 0) });
    if (d.getMonth() !== month && d > first) break;
  }
  const inMonth = weeks.flatMap(w => w.days).filter(d => d.inMonth);
  const trades = inMonth.flatMap(d => d.trades);
  return {
    weeks,
    n: trades.length, wins: trades.filter(t => t.pnl > 0).length,
    net: trades.reduce((n, t) => n + t.pnl, 0),
    greenDays: inMonth.filter(d => d.net > 0).length, redDays: inMonth.filter(d => d.net < 0).length,
  };
}

// The value that `share` of non-zero absolute day results fall under: a robust scale for color intensity.
export function scaleOf(values, share = 0.9) {
  const a = values.map(Math.abs).filter(v => v > 0).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * share))] : 0;
}

// ---- warnings ----
// Serious, actionable flags, most severe first. `recent` is every trade for the
// current market/side filter regardless of date range, so "last 24 hours" always
// means the real last 24 hours. Thresholds live here so they're easy to change.
export const WARN = {
  maxTradesPerDay: 2,          // more closes than this in 24h is overtrading
  feeShare: 0.10,              // fees above this share of gross winnings
  lossStreak: 3,               // consecutive losing trades or red days
  ddInLosses: 5,               // current drawdown deeper than this many average losses
  leverage: 25,                // average leverage over the last 7 days
  revengeMinutes: 15,          // reopening this soon after a losing close
  outsizedLoss: 3,             // a recent loss this many times the average loss
  dailyLossPct: 4,             // stop for the day after losing this % of the account
};

export function warnings({ recent, s, ds, now = Date.now(), keyDaysLeft = null, fmt, fmtAgo }) {
  const out = [];
  const add = (level, rank, text, detail) => out.push({ level, rank, text, detail });
  const day = now - DAY, week = now - 7 * DAY;
  const last24 = recent.filter(t => t.time >= day), last7 = recent.filter(t => t.time >= week);

  if (last24.length > WARN.maxTradesPerDay)
    add('critical', 100 + last24.length, `${last24.length} trades in the last 24 hours`, `More than your limit of ${WARN.maxTradesPerDay} a day. Slow down.`);

  const liq = last7.filter(t => t.liquidation).sort((a, b) => b.time - a.time);
  if (liq.length)
    add('critical', 95, liq.length === 1 ? `${liq[0].symbol} was liquidated ${fmtAgo(liq[0].time)}` : `${liq.length} liquidations this week`,
      `Liquidations this week cost ${fmt(liq.reduce((n, t) => n + t.pnl, 0))}.`);

  // revenge trading: a new position opened soon after a losing close
  const closes = [...recent].sort((a, b) => a.time - b.time);
  let revenge = 0;
  for (const t of last7) {
    if (!t.openedAt) continue;
    const prior = closes.filter(c => c.pnl < 0 && c.time <= t.openedAt && t.openedAt - c.time <= WARN.revengeMinutes * 60_000);
    if (prior.length) revenge++;
  }
  if (revenge)
    add('critical', 90 + revenge, `${revenge} trade${revenge === 1 ? '' : 's'} opened within ${WARN.revengeMinutes} min of a loss this week`, 'Re-entering straight after a loss is a classic revenge-trading pattern.');

  if (keyDaysLeft !== null && keyDaysLeft <= 14)
    add(keyDaysLeft <= 3 ? 'critical' : 'warning', keyDaysLeft <= 3 ? 85 : 40, `API key expires in ${keyDaysLeft} day${keyDaysLeft === 1 ? '' : 's'}`, 'Create a new read-only key in Bybit and update .env.');

  if (s.grossWin > 0 && s.fees / s.grossWin > WARN.feeShare)
    add('warning', 60 + Math.round((s.fees / s.grossWin) * 100), `Fees are ${Math.round((s.fees / s.grossWin) * 100)}% of your winnings`, `${fmt(-s.fees)} in fees against ${fmt(s.grossWin)} won in this range. Over ${Math.round(WARN.feeShare * 100)}% is a lot.`);

  if (-s.currentStreak >= WARN.lossStreak)
    add('warning', 70 - s.currentStreak, `${-s.currentStreak} losing trades in a row`, 'Consider stepping away before the next trade.');
  else if (ds && -ds.current >= WARN.lossStreak)
    add('warning', 68 - ds.current, `${-ds.current} red days in a row`, 'Consider stepping away before the next trade.');

  if (s.avgLoss && -s.currentDrawdown > WARN.ddInLosses * s.avgLoss)
    add('warning', 55, `${fmt(s.currentDrawdown)} below your peak`, `That's ${(-s.currentDrawdown / s.avgLoss).toFixed(1)}× your average loss.`);

  if (last7.length >= 3) {
    const lev = last7.reduce((n, t) => n + t.leverage, 0) / last7.length;
    if (lev >= WARN.leverage) add('warning', 50, `Average leverage ${lev.toFixed(0)}× this week`, `At or above ${WARN.leverage}×, small moves can liquidate a position.`);
  }

  if (s.avgLoss) {
    const big = last24.filter(t => t.pnl < 0 && -t.pnl > WARN.outsizedLoss * s.avgLoss).sort((a, b) => a.pnl - b.pnl)[0];
    if (big) add('warning', 65, `${fmt(big.pnl)} loss on ${big.symbol} in the last 24 hours`, `${(-big.pnl / s.avgLoss).toFixed(1)}× your average loss.`);
  }

  return out.sort((a, b) => (a.level === b.level ? b.rank - a.rank : a.level === 'critical' ? -1 : 1));
}


// ---- daily loss limit ----
// Today's realized P&L against WARN.dailyLossPct of the equity you started the
// day with (current equity minus today's closed P&L, so the base doesn't shrink
// as you lose). Without an equity figure, the limit can't be judged.
export function dailyLoss(trades, equity, now = Date.now(), pct = WARN.dailyLossPct) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = trades.filter(t => t.time >= start.getTime() && t.time <= now);
  const net = today.reduce((n, t) => n + t.pnl, 0);
  if (!Number.isFinite(equity) || equity <= 0) return { net, n: today.length, base: null, limit: null, lossPct: null, used: null, hit: false };
  const base = equity - net, limit = (base * pct) / 100;
  const loss = Math.max(0, -net);
  return { net, n: today.length, base, limit, lossPct: (loss / base) * 100, used: loss / limit, hit: loss >= limit };
}

// ---- weekly review ----
// Monday 00:00 local of the week containing `ms`.
export function weekStart(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// The week's trades, per-day breakdown, and how your rules held up.
// `checkinDone(dayKey)` and `journaled(dayKey)` come from the page.
export function weekReview(trades, start, { equity = null, maxTrades = WARN.maxTradesPerDay, lossPct = WARN.dailyLossPct, checkinDone = () => false, journaled = () => false } = {}) {
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const inWeek = trades.filter(t => t.time >= start && t.time < end.getTime()).sort((a, b) => a.time - b.time);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const k = dayKey(d), next = new Date(d); next.setDate(next.getDate() + 1);
    const ts = inWeek.filter(t => t.time >= d.getTime() && t.time < next.getTime());
    days.push({ key: k, date: d, trades: ts, n: ts.length, net: ts.reduce((n, t) => n + t.pnl, 0) });
  }
  const traded = days.filter(d => d.n);
  const saturday = days[5];
  const over = days.filter(d => d.n > maxTrades);
  const extra = over.flatMap(d => d.trades.slice(maxTrades));        // the 3rd trade onwards each day
  const limit = equity ? (equity * lossPct) / 100 : null;           // approximate: today's equity as the base
  const lossDays = limit ? days.filter(d => d.net <= -limit) : [];
  return {
    start, end: end.getTime() - 1, trades: inWeek, days, s: summarize(inWeek),
    rules: {
      saturday: { n: saturday.n, net: saturday.net },
      overtrading: { days: over, extraTrades: extra.length, extraNet: extra.reduce((n, t) => n + t.pnl, 0) },
      dailyLoss: { known: limit !== null, days: lossDays },
      checkin: { done: traded.filter(d => checkinDone(d.key)).length, of: traded.length },
      journal: { done: days.filter(d => journaled(d.key)).length, of: 7 },
    },
  };
}

// ---- timing: sessions, open times, hold time ----

// Market sessions in UTC hours, back to back so every trade lands in one.
// Fixed UTC times: they drift by an hour against London and New York when
// daylight saving changes, which is fine for this level of detail.
export const SESSIONS = [
  { key: 'asia', label: 'Asia', short: 'Asia', from: 0, to: 7 },
  { key: 'london', label: 'London', short: 'London', from: 7, to: 12 },
  { key: 'overlap', label: 'London + New York', short: 'LDN + NY', from: 12, to: 16 },
  { key: 'ny', label: 'New York', short: 'New York', from: 16, to: 21 },
  { key: 'quiet', label: 'Late / quiet', short: 'Late', from: 21, to: 24 },
];
export const sessionOf = ms => { const h = new Date(ms).getUTCHours(); return SESSIONS.find(x => h >= x.from && h < x.to); };

export function bySession(trades, at = t => t.time) {
  const g = groupStats(timed(trades, at), t => sessionOf(at(t)).key);
  return SESSIONS.map(x => ({ ...x, ...(g.find(r => r.key === x.key) || { n: 0, net: 0, winRate: null, expectancy: null, profitFactor: null }), key: x.key }));
}

// Weekday × hour of the open, in local time: where your entries pay.
export function openGrid(trades) {
  const cells = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => ({ d, h, n: 0, wins: 0, net: 0 })));
  for (const t of timed(trades, t => t.openedAt)) {
    const at = new Date(t.openedAt), c = cells[(at.getDay() + 6) % 7][at.getHours()];
    c.n++; c.net += t.pnl; if (t.pnl > 0) c.wins++;
  }
  for (const row of cells) for (const c of row) { c.winRate = c.n ? c.wins / c.n : null; c.expectancy = c.n ? c.net / c.n : null; }
  return cells;
}

// The best and worst opening windows with enough trades to mean something.
// A window is a weekday plus a 2-hour block, so thin data still adds up.
export function openWindows(trades, { minTrades = 3 } = {}) {
  const map = new Map();
  for (const t of timed(trades, t => t.openedAt)) {
    const at = new Date(t.openedAt), d = (at.getDay() + 6) % 7, h = at.getHours() - (at.getHours() % 2);
    const k = d * 24 + h, w = map.get(k) || { d, h, n: 0, wins: 0, net: 0 };
    w.n++; w.net += t.pnl; if (t.pnl > 0) w.wins++;
    map.set(k, w);
  }
  const ok = [...map.values()].filter(w => w.n >= minTrades).map(w => ({ ...w, winRate: w.wins / w.n, expectancy: w.net / w.n }));
  return {
    best: ok.filter(w => w.net > 0).sort((a, b) => b.net - a.net).slice(0, 3),
    worst: ok.filter(w => w.net < 0).sort((a, b) => a.net - b.net).slice(0, 3),
  };
}

export const HOLD_BUCKETS = [
  { label: '< 1m', max: 60_000 },
  { label: '1–5m', max: 5 * 60_000 },
  { label: '5–15m', max: 15 * 60_000 },
  { label: '15m–1h', max: 3_600_000 },
  { label: '1–4h', max: 4 * 3_600_000 },
  { label: '4–12h', max: 12 * 3_600_000 },
  { label: '12–24h', max: DAY },
  { label: '1–3d', max: 3 * DAY },
  { label: '3d +', max: Infinity },
];

export const holdBucketOf = ms => HOLD_BUCKETS.find(b => ms < b.max);

// Results by how long the position was held, and the hold time that pays best:
// the bucket with the highest P&L per trade among those with enough trades.
export function holdOutcome(trades) {
  const known = trades.filter(t => Number.isFinite(t.duration));
  const buckets = HOLD_BUCKETS.map((b, i) => {
    const ts = known.filter(t => t.duration < b.max && t.duration >= (i ? HOLD_BUCKETS[i - 1].max : 0));
    const wins = ts.filter(t => t.pnl > 0).length, net = sum(ts, t => t.pnl);
    return { ...b, n: ts.length, wins, net, winRate: ts.length ? wins / ts.length : null, expectancy: ts.length ? net / ts.length : null, avgHold: ts.length ? sum(ts, t => t.duration) / ts.length : null };
  });
  const minN = Math.max(3, Math.ceil(known.length * 0.05));
  const eligible = buckets.filter(b => b.n >= minN);
  const best = eligible.length ? eligible.reduce((a, b) => (b.expectancy > a.expectancy ? b : a)) : null;
  const avg = ts => (ts.length ? sum(ts, t => t.duration) / ts.length : null);
  return {
    known: known.length, unknown: trades.length - known.length, minN, buckets,
    best: best && best.expectancy > 0 ? best : null,
    avgWin: avg(known.filter(t => t.pnl > 0)), avgLoss: avg(known.filter(t => t.pnl < 0)),
  };
}

// ---- costs: fees and funding ----

// Where the money goes between price P&L and net P&L. Funding is positive
// when you paid it; trades where Bybit didn't give a fee split have no funding.
export function costBreakdown(trades) {
  const fees = sum(trades, t => t.fees);
  const withF = trades.filter(t => t.funding !== null && t.funding !== undefined);
  const fundingPaid = sum(withF.filter(t => t.funding > 0), t => t.funding);
  const fundingReceived = -sum(withF.filter(t => t.funding < 0), t => t.funding);
  const gross = sum(trades, t => t.gross), net = sum(trades, t => t.pnl);
  const grossWin = sum(trades.filter(t => t.gross > 0), t => t.gross);
  const cost = fees + fundingPaid - fundingReceived;
  const flippedByCost = trades.filter(t => t.gross > 0 && t.pnl <= 0);
  const months = new Map();
  for (const t of trades) {
    const d = new Date(t.time), k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const m = months.get(k) || { key: k, start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), fees: 0, funding: 0, gross: 0, net: 0, n: 0 };
    m.fees += t.fees || 0; m.funding += t.funding || 0; m.gross += t.gross || 0; m.net += t.pnl; m.n++;
    months.set(k, m);
  }
  const markets = groupStats(trades, t => t.symbol).map(g => {
    const ts = trades.filter(t => t.symbol === g.key);
    const funding = sum(ts, t => t.funding), gross = sum(ts, t => t.gross);
    return { key: g.key, n: g.n, fees: g.fees, funding, cost: g.fees + funding, gross, net: g.net, volume: g.volume, feeRate: g.volume ? g.fees / g.volume : null };
  });
  return {
    gross, fees, fundingPaid, fundingReceived, net, cost,
    costShare: grossWin > 0 ? cost / grossWin : null,
    feeRate: sum(trades, t => t.notional) ? fees / sum(trades, t => t.notional) : null,
    flipped: flippedByCost.length, flippedCost: sum(flippedByCost, t => t.gross - t.pnl),
    perTrade: trades.length ? cost / trades.length : null,
    months: [...months.values()].sort((a, b) => a.start - b.start),
    markets,
  };
}

// ---- trade tags ----

// Preset tags. `kind` sets the chip color: mistakes in the loss color, good habits in the gain color.
export const TRADE_TAGS = [
  { tag: 'Followed plan', kind: 'good' }, { tag: 'A+ setup', kind: 'good' }, { tag: 'Patient entry', kind: 'good' }, { tag: 'Good exit', kind: 'good' },
  { tag: 'FOMO', kind: 'mistake' }, { tag: 'Revenge', kind: 'mistake' }, { tag: 'Chased entry', kind: 'mistake' }, { tag: 'Oversized', kind: 'mistake' },
  { tag: 'Moved stop', kind: 'mistake' }, { tag: 'No stop', kind: 'mistake' }, { tag: 'Early exit', kind: 'mistake' }, { tag: 'Held too long', kind: 'mistake' },
  { tag: 'Broke rules', kind: 'mistake' }, { tag: 'Overtraded', kind: 'mistake' },
];
export const tagKind = tag => TRADE_TAGS.find(x => x.tag === tag)?.kind || 'custom';

// One row per tag; a trade with two tags counts in both.
export function tagStats(trades, tagsOf) {
  const map = new Map();
  for (const t of trades) for (const tag of tagsOf(t)) {
    if (!map.has(tag)) map.set(tag, []);
    map.get(tag).push(t);
  }
  return [...map].map(([tag, ts]) => {
    const wins = ts.filter(t => t.pnl > 0).length, net = sum(ts, t => t.pnl);
    return { key: tag, kind: tagKind(tag), n: ts.length, wins, winRate: wins / ts.length, net, expectancy: net / ts.length };
  }).sort((a, b) => a.net - b.net);
}

// ---- recap of one trading day ----

// What happened on one day and what to do about it. `history` is every trade
// (for comparisons with your usual day, sessions and hold times); the day's
// rules mirror the weekly review's.
export function dayRecap(history, dayStart, {
  maxTrades = WARN.maxTradesPerDay, lossPct = WARN.dailyLossPct, equity = null,
  tagsOf = () => [], noted = () => false, checkinDone = false, journaled = false, fmt = v => String(v), fmtDur = v => String(v),
} = {}) {
  const end = new Date(dayStart); end.setDate(end.getDate() + 1);
  const ts = history.filter(t => t.time >= dayStart && t.time < end.getTime()).sort((a, b) => a.time - b.time);
  const s = summarize(ts);
  const sorted = [...ts].sort((a, b) => a.pnl - b.pnl);
  const best = sorted.length && sorted[sorted.length - 1].pnl > 0 ? sorted[sorted.length - 1] : null;
  const worst = sorted.length && sorted[0].pnl < 0 ? sorted[0] : null;
  const costs = sum(ts, t => t.fees + (t.funding || 0));

  // your usual trading day over the 30 days before
  const before = history.filter(t => t.time < dayStart && t.time >= dayStart - 30 * DAY);
  const days = dailyMap(before);
  const avgDay = days.size ? sum([...days.values()], d => d.net) / days.size : null;
  const avgTrades = days.size ? before.length / days.size : null;

  // rules
  const extra = ts.slice(maxTrades);
  const closes = [...history].sort((a, b) => a.time - b.time);
  const revenge = ts.filter(t => Number.isFinite(t.openedAt) && closes.some(c => c.pnl < 0 && c !== t && c.time <= t.openedAt && t.openedAt - c.time <= WARN.revengeMinutes * 60_000));
  const base = equity ? equity : null;                                  // approximate: today's equity as the base
  const limit = base ? (base * lossPct) / 100 : null;
  const saturday = new Date(dayStart).getDay() === 6;
  const rules = [
    { key: 'trades', label: `At most ${maxTrades} trades`, ok: ts.length <= maxTrades, detail: ts.length <= maxTrades ? `${ts.length} taken` : `${ts.length} taken; the extra ${extra.length} netted ${fmt(sum(extra, t => t.pnl))}` },
    { key: 'loss', label: `Daily loss under ${lossPct}%`, ok: limit === null ? null : s.net > -limit, detail: limit === null ? 'Needs your account balance' : s.net > -limit ? `${fmt(s.net)} against a ${fmt(-limit)} limit` : `${fmt(s.net)}, past the ${fmt(-limit)} limit` },
    { key: 'revenge', label: `No trade within ${WARN.revengeMinutes} min of a loss`, ok: !revenge.length, detail: revenge.length ? `${revenge.length} re-entr${revenge.length === 1 ? 'y' : 'ies'}, net ${fmt(sum(revenge, t => t.pnl))}` : 'None' },
    ...(saturday ? [{ key: 'saturday', label: 'No Saturday trading', ok: !ts.length, detail: `${ts.length} trade${ts.length === 1 ? '' : 's'} on a Saturday` }] : []),
    { key: 'checkin', label: 'Checked in', ok: !!checkinDone, detail: checkinDone ? 'Done' : 'Not done' },
    { key: 'journal', label: 'Journaled', ok: !!journaled, detail: journaled ? 'Done' : 'No entry for the day' },
  ];

  // tags used that day
  const tagged = tagStats(ts, tagsOf);
  const mistakes = tagged.filter(x => x.kind === 'mistake');
  const untagged = ts.filter(t => !tagsOf(t).length && !noted(t));

  // where these trades sit against your history
  const sessions = bySession(history, t => t.openedAt).filter(x => x.n >= 5);
  const worstSes = sessions.length ? sessions.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  const inWorstSes = worstSes && worstSes.net < 0 ? ts.filter(t => Number.isFinite(t.openedAt) && sessionOf(t.openedAt).key === worstSes.key) : [];
  const hold = holdOutcome(history);
  const winHold = ts.filter(t => t.pnl > 0 && Number.isFinite(t.duration)), lossHold = ts.filter(t => t.pnl < 0 && Number.isFinite(t.duration));
  const avg = a => (a.length ? sum(a, t => t.duration) / a.length : null);

  // suggestions, most important first, at most four
  const tips = [];
  const tip = (rank, text) => tips.push({ rank, text });
  if (limit !== null && s.net <= -limit) tip(100, `You hit your ${lossPct}% daily loss limit. Trade smaller today, and stop at the first sign of the same pattern.`);
  if (extra.length) tip(90, `You took ${ts.length} trades against your limit of ${maxTrades}. The extra ${extra.length === 1 ? 'one' : extra.length} netted ${fmt(sum(extra, t => t.pnl))}. Stop after trade ${maxTrades} today.`);
  if (revenge.length) tip(88, `${revenge.length} trade${revenge.length === 1 ? ' was' : 's were'} opened within ${WARN.revengeMinutes} minutes of a loss (${fmt(sum(revenge, t => t.pnl))}). After a loss today, step away for ${WARN.revengeMinutes} minutes first.`);
  for (const m of mistakes.slice(0, 2)) tip(80, `You tagged ${m.n} trade${m.n === 1 ? '' : 's'} "${m.key}" (${fmt(m.net)}). ${TAG_ADVICE[m.key] || 'Write down what you will do differently next time.'}`);
  const wh = avg(winHold), lh = avg(lossHold);
  if (wh && lh && lh > 2 * wh && lossHold.length >= 1) tip(70, `Your losers were held ${fmtDur(lh)} on average against ${fmtDur(wh)} for winners. Cut losing trades sooner.`);
  if (inWorstSes.length) tip(60, `${inWorstSes.length} of these trades opened in ${worstSes.label}, your weakest session (${fmt(worstSes.net)} overall). Be pickier then.`);
  // costs against what the winning moves made before costs
  const priceWins = sum(ts.filter(t => t.gross > 0), t => t.gross);
  if (priceWins > 0 && costs / priceWins > 0.3) tip(55, `Fees and funding took ${Math.round((costs / priceWins) * 100)}% of what your winning moves made. Fewer trades with bigger targets, or limit orders, would keep more.`);
  const timedTs = ts.filter(t => Number.isFinite(t.duration));
  if (hold.best && timedTs.length && timedTs.every(t => holdBucketOf(t.duration).label !== hold.best.label))
    tip(40, `None of these trades were held ${hold.best.label}, your best-paying hold time (${fmt(hold.best.expectancy)} per trade).`);
  if (untagged.length) tip(30, `${untagged.length} trade${untagged.length === 1 ? ' has' : 's have'} no tags or notes. Tag ${untagged.length === 1 ? 'it' : 'them'} while you remember why you took ${untagged.length === 1 ? 'it' : 'them'}.`);
  if (!journaled) tip(25, 'Write a few lines about the day in your journal: what you saw, what you felt, what you would repeat.');
  if (!tips.some(t => t.rank >= 55) && s.net > 0) tip(20, 'You kept to your rules and finished green. Same process today: same size, same limits.');
  else if (!tips.some(t => t.rank >= 55) && ts.length) tip(20, 'A red day inside your rules is part of the job. Keep the same size and process today.');
  tips.sort((a, b) => b.rank - a.rank);

  return {
    dayStart, trades: ts, s, best, worst, costs, avgDay, avgTrades,
    avgHoldWin: wh, avgHoldLoss: lh,
    rules, tagged, mistakes, untagged,
    suggestions: tips.slice(0, 4).map(t => t.text),
  };
}

const TAG_ADVICE = {
  'FOMO': 'Only enter on a setup you planned before the move started.',
  'Revenge': 'After a loss, wait before the next entry.',
  'Chased entry': 'Set the entry price in advance and let a missed trade go.',
  'Oversized': 'Size from your stop: risk a fixed share of the account per trade.',
  'Moved stop': 'Set the stop when you enter and leave it, or only move it toward profit.',
  'No stop': 'Place a stop-loss with every entry.',
  'Early exit': 'Let the trade reach your target or stop. Decide the exit before entering.',
  'Held too long': 'Exit when the reason for the trade is gone, not when it hurts.',
  'Broke rules': 'Reread your rules before the first trade today.',
  'Overtraded': `Stop after your daily trade limit.`,
};
