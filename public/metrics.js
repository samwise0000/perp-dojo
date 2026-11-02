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

export function byWeekday(trades) {
  const g = groupStats(trades, t => (new Date(t.time).getDay() + 6) % 7);
  return WEEKDAYS.map((label, i) => ({ label, ...(g.find(x => x.key === i) || { n: 0, net: 0, winRate: null }) }));
}

export function byHour(trades) {
  const g = groupStats(trades, t => new Date(t.time).getHours());
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
