// The PDF review: a written report, not a copy of the dashboard.
// analyze() turns trades into findings; the *Text functions turn findings into
// plain-English sentences; writeReport() lays it all out with charts.
// The analysis and text are pure, so they can be tested without a browser.
import {
  summarize, groupStats, byWeekday, byHour, histogram, dailyMap, dayStreaks, holdStats,
  fmtDuration, periodPnl, WARN,
} from './metrics.js';
import { lineChart, columnChart, hbarChart } from './charts.js';

const DAY = 86_400_000;
const FOOT = 'Each trade is one close as Bybit reports it. Net P&L is after opening and closing fees and funding. Deposits and withdrawals are never counted. The daily-loss check uses current equity as the base for past days, so treat it as approximate.';
const pad = n => String(n).padStart(2, '0');
const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
const pctTxt = v => (v === null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const fullDay = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

// ---------- analysis ----------
export function analyze(trades, {
  equity = null, strategyOf = () => '', checkinDone = () => false, journaled = () => false,
  maxTrades = WARN.maxTradesPerDay, lossPct = WARN.dailyLossPct,
} = {}) {
  const t = [...trades].sort((a, b) => a.time - b.time);
  const s = summarize(t);
  const markets = groupStats(t, x => x.symbol).sort((a, b) => b.net - a.net);
  const sides = groupStats(t, x => x.dir);
  const labeled = t.filter(x => strategyOf(x));
  const strategies = groupStats(labeled, x => strategyOf(x)).sort((a, b) => b.net - a.net);
  const weekdays = byWeekday(t).filter(d => d.n);
  const hours = byHour(t).map((h, i) => ({ ...h, hour: i })).filter(h => h.n);
  const daily = dailyMap(t);
  const days = [...daily.values()].sort((a, b) => a.key.localeCompare(b.key));
  const ds = dayStreaks(daily);
  const months = groupStats(t, x => { const d = new Date(x.time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; })
    .sort((a, b) => a.key.localeCompare(b.key));

  // recent form: the last 30 days against everything before
  const cut = (s.last ?? 0) - 30 * DAY;
  const recent = summarize(t.filter(x => x.time > cut)), earlier = summarize(t.filter(x => x.time <= cut));

  // rules
  const saturday = t.filter(x => new Date(x.time).getDay() === 6);
  const overDays = days.filter(d => d.n > maxTrades);
  const extra = overDays.flatMap(d => [...d.trades].sort((a, b) => a.time - b.time).slice(maxTrades));
  const lossLimit = equity ? (equity * lossPct) / 100 : null;
  const lossDays = lossLimit ? days.filter(d => d.net <= -lossLimit) : null;

  const losers = t.filter(x => x.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  const winners = t.filter(x => x.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const hi = t.filter(x => x.leverage >= 20), lo = t.filter(x => x.leverage < 20);

  return {
    t, s, markets, sides, strategies, unlabeled: t.length - labeled.length, weekdays, hours, days, ds, months,
    breakeven: s.payoff ? 1 / (1 + s.payoff) : null,
    recent, earlier,
    rules: {
      maxTrades, lossPct,
      saturday: { n: saturday.length, net: sum(saturday, x => x.pnl) },
      overtrading: { days: overDays.length, extra: extra.length, extraNet: sum(extra, x => x.pnl) },
      lossLimit: lossDays === null ? null : { days: lossDays.length, net: sum(lossDays, d => d.net) },
      checkin: { done: days.filter(d => checkinDone(d.key)).length, of: days.length },
      journal: { done: days.filter(d => journaled(d.key)).length, of: days.length },
    },
    hold: holdStats(t),
    concentration: losers.length && s.grossLoss ? -sum(losers.slice(0, 5), x => x.pnl) / s.grossLoss : null,
    bigWins: winners.slice(0, 5), bigLosses: losers.slice(0, 5),
    leverage: hi.length >= 5 && lo.length >= 5 ? { hi: summarize(hi), lo: summarize(lo) } : null,
  };
}

// This month against last month. When the month is still running, `partial`
// compares with the same stretch of last month (day 1 to the same day), so a
// half-finished month isn't measured against a whole one.
export function monthCompare(cur, prev, { partial = false, curName, prevName, prevSpan = '', f }) {
  const pf = x => (x.profitFactor === null ? '—' : x.profitFactor === Infinity ? '∞' : x.profitFactor.toFixed(2));
  const title = partial ? 'Against the same days last month' : `Against ${prevName}`;
  const lines = [];
  const when = partial ? `By this point in ${prevName}${prevSpan ? ` (${prevSpan})` : ''}` : `In ${prevName}`;
  if (!prev.n) lines.push(`${when} you had no closed trades, so there's nothing to compare against yet.`);
  else {
    lines.push(`${when} you had closed ${prev.n} trade${prev.n === 1 ? '' : 's'} for ${f.money(prev.net)} with a ${pctTxt(prev.winRate)} win rate.`);
    if (cur.n) {
      const d = cur.net - prev.net;
      const pace = Math.abs(d) < 1 ? 'level with' : d > 0 ? `${f.money(d, { sign: false })} ahead of` : `${f.money(-d, { sign: false })} behind`;
      lines.push(`${partial ? 'This month you are' : `${curName} finished`} ${pace} ${partial ? 'that pace' : 'it'}${cur.n !== prev.n ? `, on ${cur.n > prev.n ? 'more' : 'fewer'} trades (${cur.n} against ${prev.n})` : ''}.${cur.winRate !== null && prev.winRate !== null && Math.abs(cur.winRate - prev.winRate) >= 0.1 ? ` Your win rate ${cur.winRate > prev.winRate ? 'rose' : 'fell'} from ${pctTxt(prev.winRate)} to ${pctTxt(cur.winRate)}.` : ''}`);
      if (cur.n > prev.n * 1.5 && cur.net < prev.net) lines.push('More trades for a worse result: check whether the extra ones met your entry criteria.');
    }
  }
  const row = (k, a, b) => [k, a, b];
  const rows = [
    row('Net P&L', f.money(cur.net), f.money(prev.net)),
    row('Trades', String(cur.n), String(prev.n)),
    row('Win rate', pctTxt(cur.winRate), pctTxt(prev.winRate)),
    row('Profit factor', pf(cur), pf(prev)),
    row('Per trade', cur.n ? f.money(cur.expectancy) : '—', prev.n ? f.money(prev.expectancy) : '—'),
    row('Fees', f.money(-cur.fees), f.money(-prev.fees)),
    row('Max drawdown', f.money(cur.maxDrawdown), f.money(prev.maxDrawdown)),
  ];
  return { title, lines, head: ['', curName, partial ? `${prevName}, same days` : prevName], rows };
}

// ---------- plain-English conclusions ----------
export function verdict(a) {
  const { s } = a;
  if (!s.n) return { level: 'none', label: 'No trades', line: 'There were no closed trades in this period.' };
  if (s.net > 0 && (s.profitFactor ?? 0) >= 1.3) return { level: 'good', label: 'Profitable', line: 'A profitable period with a healthy edge.' };
  if (s.net > 0) return { level: 'mixed', label: 'Slightly profitable', line: 'Profitable, but the margin is thin.' };
  if ((s.profitFactor ?? 0) >= 0.9) return { level: 'mixed', label: 'Close to breakeven', line: 'Roughly breakeven: small changes would tip it either way.' };
  return { level: 'poor', label: 'Losing money', line: 'A losing period: the sections below show where the money went.' };
}

export function summaryText(a, f) {
  const { s } = a, out = [];
  if (!s.n) return ['There were no closed trades in this period, so there is nothing to review yet.'];
  const mk = a.markets.length;
  out.push(`${f.date(s.first) === f.date(s.last) ? `On ${f.date(s.first)}` : `Between ${f.date(s.first)} and ${f.date(s.last)}`} you closed ${s.n} trade${s.n === 1 ? '' : 's'} across ${mk} market${mk === 1 ? '' : 's'} and ${s.net >= 0 ? 'finished up' : 'finished down'} ${f.money(Math.abs(s.net), { sign: false })} after fees and funding.`);

  // the shape of the edge
  const wr = pctTxt(s.winRate), be = a.breakeven;
  if (s.avgWin === null || s.avgLoss === null) out.push(s.losses ? 'Every trade in this period lost money.' : 'Every trade in this period was a winner.');
  else if (s.net < 0 && s.winRate >= 0.5 && s.payoff < 1)
    out.push(`You won ${wr} of your trades, but the average loss (${f.money(s.avgLoss, { sign: false })}) was bigger than the average win (${f.money(s.avgWin, { sign: false })}), so the winners couldn't cover the losers. At this win size you'd need about ${pctTxt(be)} winners to break even.`);
  else if (s.net < 0 && s.payoff >= 1)
    out.push(`Your winners were bigger than your losers (${s.payoff.toFixed(2)}× on average), but you won only ${wr} of trades. At that payoff you need roughly ${pctTxt(be)} winners to break even, so the problem is how often you win, not how much.`);
  else if (s.net < 0)
    out.push(`You won ${wr} of trades and your average loss was larger than your average win. Both sides of the edge need work: picking better entries and keeping losses smaller.`);
  else
    out.push(`You won ${wr} of trades, and winners averaged ${s.payoff.toFixed(2)}× the size of losers, for a profit factor of ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}.${be !== null ? ` The break-even win rate at this payoff is ${pctTxt(be)}, so you have ${s.winRate - be >= 0.05 ? 'a comfortable' : 'only a small'} margin above it.` : ''}`);

  // costs
  if (s.grossWin > 0) {
    const share = s.fees / s.grossWin;
    out.push(`Trading fees came to ${f.money(s.fees, { sign: false })}, ${pctTxt(share)} of everything your winning trades made${share >= 0.15 ? ', a large drag' : share >= 0.08 ? ', which is noticeable' : ''}.${s.funding !== null && Math.abs(s.funding) >= 1 ? ` You ${s.funding > 0 ? 'paid' : 'received'} ${f.money(Math.abs(s.funding), { sign: false })} in funding.` : ''}`);
  }

  // risk
  if (s.maxDrawdown < 0)
    out.push(`The deepest drawdown was ${f.money(-s.maxDrawdown, { sign: false })}, from ${f.date(s.ddFrom)} to ${f.date(s.ddTo)}${s.currentDrawdown < 0 ? `, and you finished the period ${f.money(-s.currentDrawdown, { sign: false })} below your best point` : ', and you finished at a new high'}.${s.liquidations ? ` ${s.liquidations} position${s.liquidations === 1 ? ' was' : 's were'} liquidated, costing ${f.money(Math.abs(s.liquidationPnl), { sign: false })}.` : ''}`);

  if (s.n < 20) out.push(`With only ${s.n} trades, treat these conclusions as early signs rather than firm findings.`);
  return out;
}

// key numbers, each with a one-line reading
export function keyNumbers(a, f) {
  const { s } = a, be = a.breakeven;
  return [
    ['Net P&L', f.money(s.net), s.net >= 0 ? 'After fees and funding.' : 'After fees and funding: a net loss.'],
    ['Win rate', pctTxt(s.winRate), be === null ? '' : `Break-even at your win size is ${pctTxt(be)}, so you're ${s.winRate >= be ? 'above' : 'below'} it.`],
    ['Profit factor', s.profitFactor === null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2),
      s.profitFactor === null ? '' : s.profitFactor >= 1.5 ? 'Strong: wins clearly outweigh losses.' : s.profitFactor >= 1 ? 'Thin: wins only just outweigh losses.' : 'Below 1: losses outweigh wins.'],
    ['Avg win / avg loss', s.avgWin !== null && s.avgLoss !== null ? `${f.money(s.avgWin, { sign: false })} / ${f.money(s.avgLoss, { sign: false })}` : '—',
      s.payoff === null ? '' : s.payoff >= 1 ? `Winners are ${s.payoff.toFixed(2)}× the size of losers.` : `Losers are ${(1 / s.payoff).toFixed(2)}× the size of winners.`],
    ['Expectancy', s.n ? `${f.money(s.expectancy)} / trade` : '—', s.n ? `What an average trade made or lost.` : ''],
    ['Max drawdown', f.money(s.maxDrawdown), s.ddFrom ? `${f.date(s.ddFrom)} → ${f.date(s.ddTo)}.` : 'No drawdown.'],
    ['Fees', f.money(-s.fees), s.grossWin > 0 ? `${pctTxt(s.fees / s.grossWin)} of gross winnings.` : ''],
    ['Funding', s.funding === null ? '—' : f.money(-s.funding), s.funding === null ? '' : s.funding > 0 ? 'Paid, net.' : 'Received, net.'],
  ];
}

export function timeText(a, f) {
  const out = [], { months, recent, earlier } = a;
  if (months.length >= 2) {
    const best = months.reduce((x, y) => (y.net > x.net ? y : x)), worst = months.reduce((x, y) => (y.net < x.net ? y : x));
    const name = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); };
    out.push(`Your best month was ${name(best.key)} (${f.money(best.net)} over ${best.n} trades) and your worst was ${name(worst.key)} (${f.money(worst.net)}). ${months.filter(m => m.net > 0).length} of ${months.length} months were profitable.`);
  }
  if (recent.n >= 8 && earlier.n >= 8) {
    const better = recent.expectancy > earlier.expectancy;
    out.push(`Over the last 30 days you averaged ${f.money(recent.expectancy)} per trade with a ${pctTxt(recent.winRate)} win rate, against ${f.money(earlier.expectancy)} and ${pctTxt(earlier.winRate)} before that. ${better ? 'Recent results are better than earlier ones, which is worth noting.' : 'Recent results are weaker than earlier ones, so look closely at what changed.'}`);
  }
  return out;
}

export function workingText(a, f) {
  const out = [];
  const m = a.markets.filter(x => x.n >= 3);
  if (m.length >= 2) {
    const best = m[0], worst = m[m.length - 1];
    if (best.net > 0) out.push(`${best.key} was your best market: ${f.money(best.net)} across ${best.n} trades with a ${pctTxt(best.winRate)} win rate.`);
    if (worst.net < 0) {
      const share = a.s.grossLoss ? -worst.net / a.s.grossLoss : 0;
      out.push(`${worst.key} cost you the most: ${f.money(worst.net)} across ${worst.n} trades (${pctTxt(worst.winRate)} won)${share >= 0.3 ? `, which is ${pctTxt(share)} of all your losses` : ''}.`);
    }
  }
  const L = a.sides.find(x => x.key === 'Long'), S = a.sides.find(x => x.key === 'Short');
  if (L && S && L.n >= 3 && S.n >= 3) {
    if (Math.sign(L.net) !== Math.sign(S.net)) {
      const [g, b] = L.net > S.net ? [L, S] : [S, L];
      out.push(`Your ${g.key.toLowerCase()}s made ${f.money(g.net)} while your ${b.key.toLowerCase()}s lost ${f.money(b.net)}. The ${b.key.toLowerCase()} side is where the edge breaks down.`);
    } else {
      const [g, b] = L.expectancy > S.expectancy ? [L, S] : [S, L];
      out.push(`${g.key}s were the stronger side at ${f.money(g.expectancy)} per trade, against ${f.money(b.expectancy)} for ${b.key.toLowerCase()}s.`);
    }
  }
  if (a.strategies.length) {
    const best = a.strategies[0], worst = a.strategies[a.strategies.length - 1];
    out.push(`${best.key} was your best strategy (${f.money(best.net)} over ${best.n} trades, ${pctTxt(best.winRate)} won)${a.strategies.length > 1 && worst.net < 0 ? `, while ${worst.key} lost ${f.money(worst.net)} over ${worst.n}` : ''}.${a.unlabeled ? ` ${a.unlabeled} trade${a.unlabeled === 1 ? ' has' : 's have'} no strategy label yet.` : ''}`);
  }
  const wd = a.weekdays.filter(d => d.n >= 3);
  if (wd.length >= 3) {
    const best = wd.reduce((x, y) => (y.net > x.net ? y : x)), worst = wd.reduce((x, y) => (y.net < x.net ? y : x));
    out.push(`By day of the week, ${fullDay[best.label]} was best (${f.money(best.net)}) and ${fullDay[worst.label]} was worst (${f.money(worst.net)}).`);
  }
  const hr = a.hours.filter(h => h.n >= 3);
  if (hr.length >= 3) {
    const best = hr.reduce((x, y) => (y.net > x.net ? y : x)), worst = hr.reduce((x, y) => (y.net < x.net ? y : x));
    out.push(`Your best hour to close trades was ${hourLabel(best.hour)}–${hourLabel((best.hour + 1) % 24)} (${f.money(best.net)}); your worst was ${hourLabel(worst.hour)}–${hourLabel((worst.hour + 1) % 24)} (${f.money(worst.net)}).`);
  }
  return out;
}

export function riskText(a, f) {
  const out = [], { s, ds } = a;
  if (s.maxLossStreak >= 3) out.push(`Your longest losing run was ${s.maxLossStreak} trades in a row (${f.money(s.maxLossStreakPnl)}), and ${ds.bestLoss} red day${ds.bestLoss === 1 ? '' : 's'} in a row at worst.`);
  if (a.leverage) {
    const { hi, lo } = a.leverage;
    out.push(`At 20× leverage or more you averaged ${f.money(hi.expectancy)} per trade (${hi.n} trades), against ${f.money(lo.expectancy)} below 20× (${lo.n} trades). ${hi.expectancy < lo.expectancy ? 'Higher leverage made results worse.' : 'Higher leverage hasn’t hurt so far.'}`);
  }
  if (a.concentration !== null && a.bigLosses.length >= 5 && a.concentration >= 0.35)
    out.push(`Your 5 biggest losses make up ${pctTxt(a.concentration)} of all losses: a handful of trades did most of the damage.`);
  return out;
}

export function rulesText(a, f) {
  const R = a.rules, out = [], costs = [];
  if (R.saturday.n) costs.push([`${R.saturday.n} Saturday trade${R.saturday.n === 1 ? '' : 's'}`, R.saturday.net]);
  if (R.overtrading.extra) costs.push([`${R.overtrading.extra} trade${R.overtrading.extra === 1 ? '' : 's'} beyond your ${R.maxTrades}-a-day limit`, R.overtrading.extraNet]);
  if (!costs.length) out.push(`You kept your trading-time rules: no Saturday trades and never more than ${R.maxTrades} trades in a day.`);
  else {
    const net = sum(costs, c => c[1]);
    out.push(`Breaking your rules ${net < 0 ? `cost you ${f.money(-net, { sign: false })}` : `happened to make ${f.money(net, { sign: false })}, but that's luck, not a reason to keep doing it`}: ${costs.map(c => `${c[0]} (${f.money(c[1])})`).join(' and ')}.`);
  }
  if (R.lossLimit && R.lossLimit.days) out.push(`On ${R.lossLimit.days} day${R.lossLimit.days === 1 ? '' : 's'} you lost more than ${R.lossPct}% of the account (measured against today's equity), ${f.money(R.lossLimit.net)} in total.`);
  if (R.checkin.of) out.push(`You completed the daily check-in on ${R.checkin.done} of ${R.checkin.of} trading days and journaled ${R.journal.done} of them.`);
  return out;
}

export function qualityText(a, f) {
  const out = [], h = a.hold;
  if (h.known >= 10 && h.medianWin && h.medianLoss) {
    const r = h.medianLoss / h.medianWin;
    out.push(`The median trade was held for ${fmtDuration(h.median)}: winners ${fmtDuration(h.medianWin)}, losers ${fmtDuration(h.medianLoss)}. ${r >= 1.5 ? 'You hold losing trades noticeably longer than winners, a sign of hoping instead of exiting.' : r <= 0.67 ? 'You cut losers faster than you take winners, which is healthy.' : 'Winners and losers are held for similar times.'}`);
  }
  if (a.bigWins.length && a.bigLosses.length)
    out.push(`Your biggest win was ${f.money(a.bigWins[0].pnl)} on ${a.bigWins[0].symbol} and your biggest loss was ${f.money(a.bigLosses[0].pnl)} on ${a.bigLosses[0].symbol}.`);
  return out;
}

// 3–5 concrete actions, most important first
export function recommendations(a, f) {
  const { s, rules: R } = a, recs = [];
  if (!s.n) return [{ title: 'Pull some trades first', why: 'There is nothing to review in this period yet.' }];
  if (s.payoff !== null && s.payoff < 1 && s.winRate >= 0.45)
    recs.push({ title: 'Cut losers sooner or let winners run further', why: `Your average loss is ${(1 / s.payoff).toFixed(2)}× your average win. Even a small shift here would change the result, since you already win ${pctTxt(s.winRate)} of the time.` });
  const worst = a.markets.filter(m => m.n >= 5).sort((x, y) => x.net - y.net)[0];
  if (worst && worst.net < 0 && s.grossLoss && -worst.net / s.grossLoss >= 0.2)
    recs.push({ title: `Stop trading ${worst.key}, or trade it smaller`, why: `It lost ${f.money(-worst.net, { sign: false })} over ${worst.n} trades with a ${pctTxt(worst.winRate)} win rate.` });
  if (R.overtrading.extra && R.overtrading.extraNet < 0)
    recs.push({ title: `Stop at ${R.maxTrades} trades a day`, why: `The ${R.overtrading.extra} trades beyond your limit lost ${f.money(-R.overtrading.extraNet, { sign: false })}.` });
  if (R.saturday.n)
    recs.push({ title: 'Keep Saturdays off', why: `${R.saturday.n} Saturday trade${R.saturday.n === 1 ? '' : 's'} ${R.saturday.net < 0 ? `lost ${f.money(-R.saturday.net, { sign: false })}` : 'broke your own rule'}.` });
  if (s.grossWin > 0 && s.fees / s.grossWin >= 0.15)
    recs.push({ title: 'Bring fees down', why: `Fees took ${pctTxt(s.fees / s.grossWin)} of your winnings. Limit orders, fewer trades or larger targets would all help.` });
  const L = a.sides.find(x => x.key === 'Long'), S = a.sides.find(x => x.key === 'Short');
  if (L && S && L.n >= 5 && S.n >= 5 && Math.sign(L.net) !== Math.sign(S.net)) {
    const b = L.net < S.net ? L : S;
    recs.push({ title: `Be much more selective with ${b.key.toLowerCase()}s`, why: `They lost ${f.money(-b.net, { sign: false })} over ${b.n} trades while the other side made money.` });
  }
  if (a.hold.known >= 10 && a.hold.medianWin && a.hold.medianLoss && a.hold.medianLoss / a.hold.medianWin >= 1.5)
    recs.push({ title: 'Exit losing trades on your plan, not on hope', why: `Losers were held ${fmtDuration(a.hold.medianLoss)} on average against ${fmtDuration(a.hold.medianWin)} for winners.` });
  if (R.checkin.of && R.checkin.done / R.checkin.of < 0.8)
    recs.push({ title: 'Do the check-in before every trading day', why: `It was done on ${R.checkin.done} of ${R.checkin.of} trading days.` });
  if (!recs.length)
    recs.push({ title: 'Keep doing what works', why: `The numbers are healthy: ${pctTxt(s.winRate)} win rate and a profit factor of ${s.profitFactor === Infinity ? '∞' : (s.profitFactor ?? 0).toFixed(2)}. Protect it by keeping size and rules the same.` });
  return recs.slice(0, 5);
}

// ---------- layout ----------
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function section(root, n, title, accent) {
  const sec = h('section', 'rp-section');
  sec.style.setProperty('--a', `var(${accent})`);
  const head = h('div', 'rp-h');
  head.append(h('span', 'rp-num', String(n).padStart(2, '0')), h('h2', '', title));
  sec.append(head);
  root.append(sec);
  return sec;
}
const paras = (parent, lines) => { for (const l of lines) parent.append(h('p', 'rp-p', l)); };
function figure(parent, caption, height) {
  const fig = h('figure', 'rp-fig'), box = h('div', 'rp-chart');
  if (height) box.style.minHeight = height + 'px';
  fig.append(box);
  if (caption) fig.append(h('figcaption', '', caption));
  parent.append(fig);
  return box;
}
function table(parent, head, rows, numFrom = 1) {
  const t = h('table', 'rp-table'), tr = h('tr');
  head.forEach((x, i) => tr.append(h('th', i >= numFrom ? 'num' : '', x)));
  const thead = h('thead'); thead.append(tr);
  const body = h('tbody');
  for (const r of rows) {
    const row = h('tr');
    r.forEach((x, i) => { const td = h('td', i >= numFrom ? 'num' : ''); if (x instanceof Node) td.append(x); else td.textContent = x; row.append(td); });
    body.append(row);
  }
  t.append(thead, body);
  parent.append(t);
  return t;
}

export function writeReport(root, trades, ctx) {
  const f = ctx.fmt;
  const a = analyze(trades, ctx);
  const { s } = a, v = verdict(a);
  root.replaceChildren();

  // cover
  const cover = h('header', 'rp-cover');
  const brand = h('div', 'rp-brand');
  const img = h('img'); img.src = 'logo.png'; img.alt = ''; img.width = 44; img.height = 44;
  const bt = h('div'); bt.append(h('div', 'rp-kicker', ctx.kicker || 'Perp Dojo'), h('h1', '', ctx.title || 'Trading review'));
  brand.append(img, bt);
  const meta = h('div', 'rp-meta');
  meta.append(h('div', '', s.n ? `${f.date(ctx.from ?? s.first)} – ${f.date(ctx.to ?? s.last)}` : 'No trades in range'), h('div', '', ctx.scope), h('div', '', `Generated ${f.dateTime(Date.now())}${ctx.uid ? ` · UID ${ctx.uid}` : ''}`));
  cover.append(brand, meta);
  const vbox = h('div', `rp-verdict ${v.level}`);
  vbox.append(h('span', 'rp-badge', v.label), h('span', '', v.line));
  const big = h('div', 'rp-big');
  for (const [k, val, cls] of [['Net P&L', f.money(s.net), s.net >= 0 ? 'pos' : 'neg'], ['Trades', String(s.n), ''], ['Win rate', pctTxt(s.winRate), ''], ['Profit factor', s.profitFactor === null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), '']]) {
    const d = h('div', 'rp-bigitem ' + cls); d.append(h('span', '', k), h('b', '', val)); big.append(d);
  }
  root.append(cover);
  // a month still in progress says so up front
  if (ctx.sofar) { const so = h('div', 'rp-sofar'); so.append(h('b', '', 'So far this month:'), h('span', '', ' ' + ctx.sofar)); root.append(so); }
  else if (ctx.note) root.append(h('div', 'rp-sofar', ctx.note));
  root.append(vbox, big);

  let n = 1;
  const sum1 = section(root, n++, 'Summary', '--a1');
  paras(sum1, summaryText(a, f));

  // side by side with the previous month (or the same stretch of it)
  if (ctx.compare) {
    const cs = section(root, n++, ctx.compare.title, '--a4');
    paras(cs, ctx.compare.lines);
    table(cs, ctx.compare.head, ctx.compare.rows);
  }
  if (!s.n) return;

  // key numbers
  const kn = section(root, n++, 'Key numbers', '--a2');
  const kt = h('dl', 'rp-kv');
  for (const [k, val, note] of keyNumbers(a, f)) { const dt = h('dt', '', k), dd = h('dd'); dd.append(h('b', '', val), h('span', '', note)); kt.append(dt, dd); }
  kn.append(kt);

  // over time
  const ot = section(root, n++, 'Performance over time', '--a5');
  lineChart(figure(ot, 'Cumulative net P&L, by close time. Cyan above $0, rose below.', 200), {
    points: [{ x: s.equity[0].x - 1, y: 0 }, ...s.equity], height: 200, signed: true, smooth: true, fmtTick: f.compact, label: 'Cumulative net P&L', tipTitle: () => '', tipRows: () => [],
  });
  const per = periodPnl(a.t, s.first, s.last);
  const unitName = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[per.unit];
  columnChart(figure(ot, `${unitName} P&L.`, 150), {
    height: 150, fmtTick: f.compact, label: `${unitName} P&L`,
    bars: per.buckets.map(b => ({ label: new Date(b.start).toLocaleDateString(undefined, per.unit === 'month' ? { month: 'short' } : { month: 'short', day: 'numeric' }), value: b.net, tipTitle: '', tipRows: [] })),
  });
  paras(ot, timeText(a, f));

  // working / not working
  const wk = section(root, n++, 'What’s working, and what isn’t', '--a3');
  paras(wk, workingText(a, f));
  const top = [...a.markets].sort((x, y) => Math.abs(y.net) - Math.abs(x.net)).slice(0, 8).sort((x, y) => y.net - x.net);
  hbarChart(figure(wk, 'Net P&L by market (largest 8).'), { label: 'Net P&L by market', rows: top.map(m => ({ label: m.key, value: m.net, valueText: f.compact(m.net), tipTitle: '', tipRows: [] })) });
  if (a.strategies.length) table(wk, ['Strategy', 'Trades', 'Win rate', 'Per trade', 'Net P&L'], a.strategies.map(x => [x.key, String(x.n), pctTxt(x.winRate), f.money(x.expectancy), f.money(x.net)]));
  const two = h('div', 'rp-two'); wk.append(two);
  columnChart(figure(two, 'Net P&L by weekday.', 140), { height: 140, fmtTick: f.compact, label: 'By weekday', bars: byWeekday(a.t).map(d => ({ label: d.label, value: d.net, tipTitle: '', tipRows: [] })) });
  columnChart(figure(two, 'Net P&L by hour closed (local time).', 140), { height: 140, fmtTick: f.compact, labelEvery: 4, label: 'By hour', bars: byHour(a.t).map(d => ({ label: d.label, value: d.net, tipTitle: '', tipRows: [] })) });

  // risk & discipline
  const rk = section(root, n++, 'Risk and discipline', '--a4');
  paras(rk, riskText(a, f));
  lineChart(figure(rk, 'Drawdown from the running peak.', 120), {
    points: [{ x: s.drawdown[0].x - 1, y: 0 }, ...s.drawdown], height: 120, color: 'neg', fmtTick: f.compact, label: 'Drawdown', tipTitle: () => '', tipRows: () => [],
  });
  const R = a.rules;
  const rules = h('ul', 'rp-rules');
  const rule = (ok, title, detail) => { const li = h('li', ok === null ? 'na' : ok ? 'ok' : 'bad'); li.append(h('span', 'rp-mark', ok === null ? '–' : ok ? '✓' : '✗'), h('b', '', title), h('span', '', detail)); rules.append(li); };
  rule(!R.saturday.n, 'No trades on Saturday', R.saturday.n ? `${R.saturday.n} trades, ${f.money(R.saturday.net)}` : 'Kept');
  rule(!R.overtrading.days, `At most ${R.maxTrades} trades a day`, R.overtrading.days ? `Over on ${R.overtrading.days} day${R.overtrading.days === 1 ? '' : 's'}; extra trades ${f.money(R.overtrading.extraNet)}` : 'Kept');
  rule(R.lossLimit ? !R.lossLimit.days : null, `Daily loss under ${R.lossPct}%`, !R.lossLimit ? 'Needs account equity' : R.lossLimit.days ? `Broken on ${R.lossLimit.days} day${R.lossLimit.days === 1 ? '' : 's'}` : 'Kept');
  rule(R.checkin.of ? R.checkin.done === R.checkin.of : null, 'Daily check-in', `${R.checkin.done} of ${R.checkin.of} trading days`);
  rule(R.journal.of ? R.journal.done === R.journal.of : null, 'Journaled trading days', `${R.journal.done} of ${R.journal.of}`);
  rk.append(rules);
  paras(rk, rulesText(a, f));

  // trade quality
  const tq = section(root, n++, 'Trade quality', '--a2');
  paras(tq, qualityText(a, f));
  const bins = histogram(a.t);
  if (bins.length) columnChart(figure(tq, 'How many trades landed at each result.', 130), {
    height: 130, fmtTick: v => String(Math.round(v)), label: 'Distribution', colorBy: b => (b.mid >= 0 ? 'pos' : 'neg'),
    bars: bins.map(b => ({ label: f.compact(b.from), value: b.n, mid: (b.from + b.to) / 2, tipTitle: '', tipRows: [] })),
  });
  const two2 = h('div', 'rp-two'); tq.append(two2);
  const tradeRows = list => list.map(t => [f.date(t.time), `${t.symbol} ${t.dir.toLowerCase()}`, f.money(t.pnl)]);
  const w1 = h('div'), w2 = h('div'); two2.append(w1, w2);
  w1.append(h('h3', 'rp-h3', 'Biggest wins')); table(w1, ['Date', 'Trade', 'Net P&L'], tradeRows(a.bigWins), 2);
  w2.append(h('h3', 'rp-h3', 'Biggest losses')); table(w2, ['Date', 'Trade', 'Net P&L'], tradeRows(a.bigLosses), 2);

  // recommendations
  const rc = section(root, n++, 'Recommendations', '--a1');
  const ol = h('ol', 'rp-recs');
  for (const r of recommendations(a, f)) { const li = h('li'); li.append(h('b', '', r.title), h('span', '', r.why)); ol.append(li); }
  rc.append(ol);

  // journal
  const notes = (ctx.journalEntries || []).filter(e => e.time >= (ctx.from ?? s.first) - DAY && e.time <= (ctx.to ?? Date.now()));
  const weekly = (ctx.weekly || []).filter(w => w.time >= (ctx.from ?? s.first) - 7 * DAY && w.time <= (ctx.to ?? Date.now()));
  if (notes.length || weekly.length) {
    const jr = section(root, n++, 'From your journal', '--a5');
    for (const w of weekly.slice(-3)) {
      const q = h('blockquote', 'rp-quote');
      q.append(h('div', 'rp-qhead', `Week of ${f.date(w.time)} · reflection`), h('p', '', w.text.trim().slice(0, 600)));
      jr.append(q);
    }
    for (const e of notes.slice(-6)) {
      const q = h('blockquote', 'rp-quote');
      q.append(h('div', 'rp-qhead', `${f.date(e.time)}${e.rating ? ' · ' + '★'.repeat(e.rating) : ''}${e.net !== null ? ' · ' + f.money(e.net) : ''}`), h('p', '', e.text.trim().slice(0, 420)));
      jr.append(q);
    }
  }

  // appendix (a single month doesn't need one)
  if (ctx.appendix === false) { root.append(h('p', 'rp-foot', FOOT)); return; }
  const ap = section(root, n++, 'Appendix: month by month', '--a3');
  table(ap, ['Month', 'Trades', 'Win rate', 'Profit factor', 'Fees', 'Net P&L'], a.months.map(m => {
    const [y, mo] = m.key.split('-').map(Number);
    return [new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), String(m.n), pctTxt(m.winRate),
      m.profitFactor === null ? '—' : m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2), f.money(-m.fees), f.money(m.net)];
  }));
  root.append(h('p', 'rp-foot', FOOT));
}
