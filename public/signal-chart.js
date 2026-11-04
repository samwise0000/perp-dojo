// Signal charts: the 4h candle cache (IndexedDB, so a reload only fetches what
// has closed since) and the replay window for one signal, with its levels, the
// trade and the scaling plan drawn, and a plain-English trade guide.
import { scalePlan, closedOnly, H4, TAKER_FEE, MAKER_FEE } from './sfp.js';
import { idbGet, idbSet } from './db.js';
import { proposedRisk } from './day-playbook.js';

let ctx = null;

// Which result the Signals page shows: the full scaling plan (default) or the
// first entry alone. Remembered per browser.
const ADDS_KEY = 'perp-dojo:signal-adds';
export const adds = { on: true };
try { adds.on = localStorage.getItem(ADDS_KEY) !== 'off'; } catch {}
export const setAdds = on => { adds.on = on; try { localStorage.setItem(ADDS_KEY, on ? 'on' : 'off'); } catch {} };
// A trade's outcome in the current mode: result (win, loss, entry, be, open),
// R before fees, net after fees (null while open), when it ended, adds filled,
// and rr, what it makes at the target. In R of the first entry's risk.
export function outcomeOf(t) {
  if (!t) return null;
  if (adds.on && t.scaled) return t.scaled;
  const net = t.result === 'open' ? null : t.R - (TAKER_FEE + (t.result === 'win' ? MAKER_FEE : TAKER_FEE)) / t.riskPct;
  return { result: t.result, R: t.R, net, exitT: t.exitT, adds: 0, rr: t.rr };
}
// the page hands over apiJson, price formatting and the replay window once
export const bindCharts = c => { if (!ctx) ctx = c; };

// Closed 4h candles from `start` to now, cached per market.
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

// Run `fn` over `items`, `n` at a time, keeping the order.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const pctS = v => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(2) + '%');
const when = t => new Date(t + H4).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function smtText(s) {
  const a = s.smt.alt, b = s.smt.btc, f = ctx.fmt.price;
  const what = `${s.smt.ref * 15 / 60}h ${s.side === 'Long' ? 'low' : 'high'}`;
  const did = x => `${x.took ? 'took' : 'held'} its ${what} (${f(x.extreme)} vs ${f(x.ref)})`;
  return `${s.smt.ok ? 'Yes' : 'No'}: ${s.symbol.replace(/USDT$/, '')} ${did(a)}, BTC ${did(b)}`;
}

// where the level sits in the 7-day range: 0% the low, 100% the high
const rangeText = s => (s.range?.pos === null || s.range?.pos === undefined ? '—' : Math.round(s.range.pos * 100) + '%');

// ---- the chart: the replay window, on 4h candles, with the levels drawn ----
const rText = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
export function chartItem(s) {
  const short = s.side === 'Short', tr = s.trade, p = ctx.fmt.price;
  const firstSwing = Math.min(...s.levels.map(l => l.t), tr ? tr.tpT : Infinity);
  // the chart runs to where the trade ended (or now, if it's still open)
  const o = outcomeOf(tr);
  const end = tr ? (o.exitT ?? Math.floor(Date.now() / H4) * H4) : s.t;
  const plan = scalePlan(tr, s.side);                          // adds at +1R and +2R, stops stepped up behind them
  // the break-even stop to the entry's precision (rounded toward the safe side)
  if (plan?.adds[1]) { const dec = (p(tr.entry).replace(/,/g, '').split('.')[1] || '').length, k = 10 ** dec; plan.adds[1].stop = (short ? Math.floor : Math.ceil)(plan.adds[1].stop * k) / k; }
  // the trade guide above the chart: plain-English steps, prices in **bold**
  const coin = s.symbol.replace(/USDT$/, ''), buy = short ? 'Short' : 'Buy', beyond = short ? 'above' : 'below', toward = short ? 'down' : 'up';
  const lv = s.levels.map(l => `**${p(l.price)}**`).join(', '), cpp = s.grade?.grade === 'C++';
  const steps = [`The 4h candle that closed ${when(s.t)} wicked ${short ? 'above' : 'below'} ${s.levels.length > 1 ? 'the levels' : 'the level'} ${lv} and closed back ${short ? 'below' : 'above'}: a failed ${short ? 'breakout' : 'breakdown'}.`];
  // the proposed risk: % of equity by grade and close (day-playbook.js), and the size it means
  const pr = s.grade && tr ? proposedRisk(s.grade.grade, s.t + H4, { tag: s.grade.tag }) : null;
  const eq = ctx.equity?.(), hidden = ctx.balanceHidden?.();
  const usd = pr && eq ? eq * pr.pct / 100 : null;
  const qty = usd ? usd / Math.abs(tr.entry - tr.sl) : null;
  const q = v => (v >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3)).toString();
  const sizeText = n => (qty && !hidden ? ` (**${q(qty * n)} ${coin}**, about ${ctx.fmt.money(qty * n * tr.entry, { sign: false, dp: 0 })})` : '');
  if (pr) steps.push(pr.pct
    ? `Risk **${+pr.pct.toFixed(2)}%** of your equity${usd && !hidden ? `: **${ctx.fmt.money(usd, { sign: false, dp: 0 })}**` : eq === null ? ' (connect your account to see it in dollars)' : ''}. ${pr.why[0].toUpperCase() + pr.why.slice(1)}.`
    : `Proposed risk: **none**. ${pr.why[0].toUpperCase() + pr.why.slice(1)}. The steps below are for reference.`);
  if (tr) {
    steps.push(`${buy} ${coin} at the close: **${p(tr.entry)}**${pr?.pct ? sizeText(1) : ''}.`);
    steps.push(`Put your stop just ${beyond} the wick at **${p(tr.sl)}**, ${(tr.riskPct * 100).toFixed(2)}% away. That distance is 1R, your risk.`);
    for (const a of cpp ? [] : plan?.adds || []) steps.push(a.n === 1
      ? `If price gets to **${p(a.price)}** (+1R), add the same size again${pr?.pct ? sizeText(1) : ''} and move all stops ${toward} to your entry, **${p(a.stop)}**.`
      : `If price gets to **${p(a.price)}** (+2R), add half your entry size${pr?.pct ? sizeText(0.5) : ''} and move all stops to break-even for the whole position, **${p(a.stop)}**.`);
    steps.push(`Take everything off at **${p(tr.tp)}**, the opposing level the move started from: ${tr.rr.toFixed(1)}R on the first entry${plan?.adds.length ? `, ${rText(plan.R)} with the adds` : ''}.`);
    // C++ (a NY fade) is tracked with fixed targets: the bounce tends to be quick and limited
    if (s.grade?.grade === 'C++') { const at = n => tr.entry + (short ? -1 : 1) * n * Math.abs(tr.entry - tr.sl); steps.push(`C++ targets, tracked instead of the plan: **${p(at(2))}** (2R) or **${p(at(3))}** (3R), first entry only, no adds.`); }
  } else steps.push('No trade: there’s no opposing level beyond the entry to aim for.');
  const n = o?.exitT ? Math.round((o.exitT - s.t) / H4) : 0;
  const outcome = !tr ? null
    : o.result === 'win' ? { text: `Target hit after ${n} candles: ${rText(o.R)}${adds.on && o.adds ? ` with the adds (${rText(tr.R)} on the first entry)` : ' on the first entry'}.`, cls: 'pos' }
    : o.result === 'loss' ? { text: `Stopped out after ${n} candles: −1R.`, cls: 'neg' }
    : o.result === 'entry' ? { text: `Stopped at the entry after add 1, ${n} candles in: ${rText(o.R)}. The first entry broke even; the add lost its 1R.`, cls: 'neg' }
    : o.result === 'be' ? { text: `Stopped at break-even after both adds, ${n} candles in: ${rText(o.R)}.`, cls: o.R > 0 ? 'pos' : 'neg' }
    : { text: `Still open: ${rText(o.R)} at the last close${adds.on && o.adds ? ` with ${o.adds === 1 ? 'add 1' : 'both adds'} in` : ''}.`, cls: '' };
  const endTip = { win: `Target hit · ${rText(o?.R ?? 0)}`, loss: 'Stopped out · −1R', entry: `Stopped at the entry · ${rText(o?.R ?? 0)}`, be: `Break-even stop · ${rText(o?.R ?? 0)}` }[o?.result];
  const context = [
    s.grade ? `Grade ${s.grade.grade}: ${s.grade.why}` : null,
    [5, 6, 0].includes(new Date(s.t + H4).getDay()) ? 'Weekend setup: no new trades (hold runners from the week)' : null,
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
          // C++ is tracked with fixed 2R / 3R targets, so those replace the add levels
          ...(cpp ? [2, 3].map(n => ({ price: tr.entry + (short ? -1 : 1) * n * Math.abs(tr.entry - tr.sl), color: '#e8955a', after: true, title: `${n}R` })) : [
            ...(plan?.adds || []).map(a => ({ price: a.price, color: 'muted', after: true, title: `Add ${a.n}` })),
            ...(plan?.adds.length === 2 ? [{ price: plan.adds[1].stop, color: 'muted', after: true, title: 'B/E' }] : []),
          ]),
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
        ...(o?.exitT ? [{ t: o.exitT, position: o.result === 'win' ? (short ? 'belowBar' : 'aboveBar') : (short ? 'aboveBar' : 'belowBar'), shape: 'square', color: o.R > 0 ? 'pos' : 'neg', tip: [endTip] }] : []),
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
