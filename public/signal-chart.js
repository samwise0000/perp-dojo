// Signal charts: the 4h candle cache (IndexedDB, so a reload only fetches what
// has closed since) and the replay window for one signal, with its levels, the
// trade and the scaling plan drawn, and a plain-English trade guide.
import { scalePlan, closedOnly, H4 } from './sfp.js';
import { idbGet, idbSet } from './db.js';

let ctx = null;
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
    [5, 6, 0].includes(new Date(s.t + H4).getDay()) ? 'Weekend setup: half size or skip' : null,
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
