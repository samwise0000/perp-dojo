// Signal charts: the 4h candle cache (IndexedDB, so a reload only fetches what
// has closed since) and the replay window for one signal, with its levels, the
// trade and the scaling plan drawn, and a plain-English trade guide.
import { scalePlan, closedOnly, H4, TAKER_FEE, MAKER_FEE, FAR_LOCK, isGodTier } from './sfp.js';
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
export const outcomeOf = t => outcomeIn(t, adds.on);
export function outcomeIn(t, withAdds) {
  if (!t || t.missed) return null;                              // a limit that never filled: no trade
  if (withAdds && t.scaled) return t.scaled;
  const net = t.result === 'open' ? null : t.net ?? t.R - (TAKER_FEE + (t.result === 'win' && !t.trail ? MAKER_FEE : TAKER_FEE)) / t.riskPct;   // a 🪜 ladder brings its own
  return { result: t.result, R: t.R, net, exitT: t.exitT, adds: 0, rr: t.rr, trail: t.trail, tpT: t.tpT };
}
// a ladder's R:R on its filled rungs alone: their own R:Rs, averaged (each risks the same fifth)
function rrOfFilled(t) {
  const d = t.tp > t.sl ? 1 : -1, xs = t.ladder.filled.map(px => d * (t.tp - px) / Math.abs(px - t.sl)).filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
// the page hands over apiJson, price formatting and the replay window once
export const bindCharts = c => { if (!ctx) ctx = c; };
// the Signals page fills this in: a signal → its grade + tags' record over the past year (the guide's header)
export const hooks = { history: null };

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
  const end = tr ? (o?.exitT ?? (tr.missed ? s.t + 7 * H4 : Math.floor(Date.now() / H4) * H4)) : s.t;
  const plan = scalePlan(tr, s.side);                          // adds at +1R and +2R, stops stepped up behind them
  // the break-even stop to the entry's precision (rounded toward the safe side)
  if (plan?.adds[1]) { const dec = (p(tr.entry).replace(/,/g, '').split('.')[1] || '').length, k = 10 ** dec; plan.adds[1].stop = (short ? Math.floor : Math.ceil)(plan.adds[1].stop * k) / k; }
  // the trade guide above the chart: plain-English steps, prices in **bold**
  const coin = s.symbol.replace(/USDT$/, ''), buy = short ? 'Short' : 'Buy', beyond = short ? 'above' : 'below';
  const lv = s.levels.map(l => `**${p(l.price)}**`).join(', '), cpp = s.grade?.grade === 'C++';
  // short on purpose: the card heads already show each price, the stop distance and the R
  const entry = [`Swept ${lv}, closed back ${short ? 'below' : 'above'} at ${when(s.t)}.`];
  if (s.late && (s.side === 'Short' ? s.grade?.grade === 'A++' && s.late.late : s.grade?.grade === 'A+' && !s.late.late)) entry.push(s.side === 'Short'
    ? `⏳ Late sweep: the wick first went past the high ${Math.round((s.late.at - s.t) / 3_600_000)}h into the candle, so the rejection came into the close. A++ shorts like this did better over 5 years (+0.71R vs −0.39R a trade), in both the latest year and years 2–5. Tracking only.`
    : `⚡ Early sweep: the wick first went under the low ${Math.round((s.late.at - s.t) / 3_600_000)}h into the candle and price held above it to the close. A+ longs like this did better over 5 years (+1.95R vs +0.24R a trade), in both the latest year and years 2–5. Tracking only.`);
  if (isGodTier(s.side, s.full, s.lean, s.grade)) entry.push(short ? '🔱 God tier (short): 🔥 sellers already leaning in on an A-grade short, the strongest short combination tested (+1.26R a trade on 38 over 5 years, winners capped). At least 1% whatever the time.' : '🔱 God tier: a 💥 full swing failure with 🔥 buyers already leaning in, the strongest combination tested (+0.39R a trade vs −0.34R over 5 years, winners capped). At least 1% whatever the grade or time.');
  if (s.lean?.on) entry.push(`🔥 ${s.side === 'Short' ? 'Sellers' : 'Buyers'} Positioning: ${(s.lean.share * 100).toFixed(1)}% of the last 24h’s market orders were ${s.side === 'Short' ? 'sells' : 'buys'}, top ${Math.max(1, Math.round((1 - s.lean.rank) * 100))}% of this coin’s month. ${s.side === 'Short' ? 'Sellers' : 'Buyers'} were leaning in before the sweep: more of these ran to +3R. Tracking only.`);
  if (s.nyx?.at) entry.push(`🗽 At NY ${short ? 'high' : 'low'}: the level is ${Math.abs(s.nyx.d).toFixed(2)} ATR from the previous NY session’s ${short ? 'high' : 'low'} (**${p(short ? s.nyx.high : s.nyx.low)}**). In the backtest plan trades here won ${short ? '36% vs 27%' : '34% vs 28%'} elsewhere. Tracking only.`);
  if (s.kz) entry.push(`⚔️ Killzone: a ${s.kz.days}-day ${short ? 'falling' : 'rising'} line meets the level here. These broke within 24h 55% of the time. Tracking only.`);
  const manage = [], exit = [];
  // the proposed risk: % of equity by grade and close (day-playbook.js), and the size it means
  const pr = s.grade && tr ? proposedRisk(s.grade.grade, s.t + H4, { tag: s.grade.tag, from: s.grade.from, skip: s.grade.skip, god: isGodTier(s.side, s.full, s.lean, s.grade) }) : null;
  const eq = ctx.equity?.(), hidden = ctx.balanceHidden?.();
  const usd = pr && eq ? eq * pr.pct / 100 : null;
  const qty = usd ? usd / Math.abs(tr.entry - tr.sl) : null;
  const q = v => (v >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3)).toString();
  const sizeText = n => (qty && !hidden ? ` · **${q(qty * n)} ${coin}**` : '');
  if (pr) entry.push(pr.pct
    ? `Risk **${+pr.pct.toFixed(2)}%**${usd && !hidden ? ` (**${ctx.fmt.money(usd, { sign: false, dp: 0 })}**)` : ''}: ${pr.why}.`
    : `No size: ${pr.why}.`);
  const far = tr && !cpp && tr.rr >= FAR_LOCK.rr;
  if (tr) {
    if (tr.ladder) {
      entry.push(`${tr.ladderWhy === 'chase' ? 'BTC’s RSI already ran, so wait for the pullback' : 'Closed away'}: 🪜 ${tr.ladder.prices.map(x => `**${p(x)}**`).join(' · ')}, ⅕ risk each. Cancel after 24h or if TP trades first.`);
      // the ladder's R:R (a fifth of each rung's) against entering at the close
      const c0 = s.atClose?.rr, got = tr.ladder.filled.length;
      entry.push(`R:R **${tr.rr.toFixed(1)}R** if all 5 fill${Number.isFinite(c0) ? `, vs ${c0.toFixed(1)}R at the close` : ''}${got && got < 5 && !tr.pending ? `. ${got} of 5 filled: **${(got / 5 * rrOfFilled(tr)).toFixed(1)}R** at the target` : ''}.`);
    }
    else if (tr.limit) entry.push(`Closed away: limit **${p(tr.entry)}**${pr?.pct ? sizeText(1) : ''}. Cancel after 24h or if TP trades first.`);
    else entry.push(`${buy} at the close **${p(tr.entry)}**${pr?.pct ? sizeText(1) : ''}.`);
    entry.push(`Stop ${beyond} the wick, **${p(tr.sl)}**: that’s 1R.`);
    for (const a of cpp ? [] : plan?.adds || []) manage.push(a.n === 1
      ? `**+1R ${p(a.price)}**: add 1×${pr?.pct ? sizeText(1) : ''}, stops to entry **${p(a.stop)}**.`
      : `**+2R ${p(a.price)}**: add ½×${pr?.pct ? sizeText(0.5) : ''}, stops to break-even **${p(a.stop)}**.`);
    if (far) manage.push(`🛡️ At **+${FAR_LOCK.at}R**, stop to **+${FAR_LOCK.to}R**.`);
    if (cpp) manage.push('No adds on a C++.');
    else if (!manage.length) manage.push('No adds before TP: the stop stays at the wick.');
    if (cpp) { const at = n => tr.entry + (short ? -1 : 1) * n * Math.abs(tr.entry - tr.sl); exit.push(`C++ fixed targets: **${p(at(2))}** (2R) or **${p(at(3))}** (3R), first entry only.`); }
    else {
      exit.push(`At TP **don’t close**: trail the stop to each closed 4h candle’s ${short ? 'high' : 'low'}.`);
      exit.push('Or take half off at TP and trail the rest: ~0.2R less a trade, half the give-back.');
      exit.push('Optional on a parabolic run: add half size at each 4h close past TP, stop at the trail. Pays on the rare big run.');
    }
  } else exit.push('No trade: no opposing level to aim for.');
  const n = o?.exitT ? Math.round((o.exitT - s.t) / H4) : 0;
  const outcome = !tr ? null
    : tr.missed ? { text: tr.missed === 'ran' ? 'Never filled: price ran to TP first. No trade.' : 'Never filled within 24h. No trade.', cls: '' }
    : tr.pending ? { text: 'Waiting for the limit to fill (up to 24h).', cls: '' }
    : o.result === 'win' ? { text: `${o.trail ? `TP after ${Math.round((o.tpT - s.t) / H4)} candles, trailed out at ${n}` : `TP after ${n} candles`}: **${rText(o.R)}**${adds.on && o.adds ? ` (${rText(tr.R)} first entry)` : ''}.`, cls: o.R > 0 ? 'pos' : 'neg' }
    : o.result === 'loss' ? { text: `Stopped out after ${n} candles: **−1R**.`, cls: 'neg' }
    : o.result === 'entry' ? { text: `Stopped at entry after add 1, ${n} candles in: **${rText(o.R)}**.`, cls: 'neg' }
    : o.result === 'be' ? { text: `Break-even stop after both adds, ${n} candles in: **${rText(o.R)}**.`, cls: o.R > 0 ? 'pos' : 'neg' }
    : o.result === 'lock' ? { text: `🛡️ Locked +3R, hit ${n} candles in: **${rText(o.R)}**.`, cls: 'pos' }
    : o.trailing || (o.result === 'open' && tr.scaled?.trailing) ? { text: `Trailing past TP: **${rText(o.R)}** now, stop **${p((o.trailStop ?? tr.scaled.trailStop))}**.`, cls: 'pos' }
    : { text: `Open: **${rText(o.R)}** at the last close${adds.on && o.adds ? `, ${o.adds === 1 ? 'add 1' : 'both adds'} in` : ''}.`, cls: '' };
  const endTip = { win: `${o?.trail ? 'Out on the trail' : 'Target hit'} · ${rText(o?.R ?? 0)}`, loss: 'Stopped out · −1R', entry: `Stopped at the entry · ${rText(o?.R ?? 0)}`, be: `Break-even stop · ${rText(o?.R ?? 0)}`, lock: `🛡️ Locked +3R · ${rText(o?.R ?? 0)}` }[o?.result];
  const context = [
    s.grade && !hooks.history ? `Grade ${s.grade.grade}: ${s.grade.why}` : null,
    [5, 6, 0].includes(new Date(s.t + H4).getDay()) ? 'Weekend: no new trades' : null,
    s.btc ? `BTC 4h ${s.btc.up ? 'up' : 'down'} (${s.counter ? 'against' : 'with'})` : null,
    s.counter && s.smt?.alt ? `15m SMT vs BTC: ${smtText(s)}` : null,
    s.range?.high ? `level at ${rangeText(s)} of 7d range` : null,
    s.after24h !== null && s.after24h !== undefined ? `${pctS(s.after24h)} after 24h` : null,
  ].filter(Boolean).join(' · ');
  return {
    symbol: s.symbol, category: 'linear', dir: s.side, entry: s.close, exit: s.close, size: 0, leverage: 1, pnl: 0, fees: 0, funding: 0,
    openedAt: firstSwing, time: end + H4, duration: end + H4 - firstSwing,
    view: {
      interval: '240',
      trimTo: tr ? end + 2 * H4 : undefined,                    // a couple of candles after the trade ends
      title: `${s.symbol} · SFP ${s.side.toLowerCase()} · ${when(s.t)}`,
      guide: {
        history: hooks.history?.(s) ?? null,
        context,
        outcome,
        sections: [
          { key: 'entry', title: 'Entry', steps: entry,
            figure: tr ? (tr.ladder ? `🪜 ${p(tr.ladder.prices[0])} – ${p(tr.ladder.prices.at(-1))}` : `${tr.limit ? 'LO ' : ''}${p(tr.entry)}`) : '—',
            sub: tr ? (tr.ladder ? `${tr.ladderWhy === 'chase' ? '⚠️ BTC ran' : 'closed away'} · ${tr.rr.toFixed(1)}R if all fill` : `stop ${p(tr.sl)} · ${(tr.riskPct * 100).toFixed(2)}%`) : '',
            state: !tr ? 'skip' : tr.missed ? 'skip' : tr.pending ? 'wait' : 'done',
            badge: !tr ? 'no trade' : tr.missed ? 'never filled' : tr.pending ? 'waiting' : tr.ladder ? `${tr.ladder.filled.length}/5 filled` : 'filled' },
          { key: 'manage', title: 'Trade management', steps: manage,
            figure: cpp ? 'no adds' : plan?.adds.length ? plan.adds.map(a => `+${a.n}R`).join(' · ') : far ? `🛡️ ${FAR_LOCK.at}R → +${FAR_LOCK.to}R` : 'hold',
            sub: cpp ? 'stop at the wick' : plan?.adds.length ? (plan.adds.length === 2 ? 'add 1 · add ½' : 'add 1') + (far ? ' · 🛡️ lock' : '') : 'stop at the wick',
            state: !tr || tr.missed || tr.pending ? 'skip' : o?.adds ? 'done' : o?.result === 'open' ? 'wait' : 'idle',
            badge: !tr || tr.missed || tr.pending ? '' : o?.adds ? (o.adds === 1 ? 'add 1 in' : 'both adds in') : o?.result === 'open' ? 'watching' : 'no adds hit' },
          { key: 'exit', title: 'Exit', steps: exit,
            figure: tr ? (cpp ? p(tr.tp) : `${p(tr.tp)} → trail`) : '—', sub: tr ? `${tr.rr.toFixed(1)}R${tr.ladder ? ' (🪜)' : ''}${plan?.adds.length && !cpp ? ` · ${rText(plan.R)} with adds` : ''}${cpp ? '' : ' · then each 4h candle'}` : '',
            state: !outcome || !o || tr.missed || tr.pending ? 'skip' : o.result === 'open' ? 'wait' : outcome.cls || 'idle',
            badge: !o || tr.missed || tr.pending ? '' : o.result === 'open' ? (o.trailing ? 'trailing' : 'open') : rText(o.R) },
        ],
      },
      // ⚔️ the killzone's trendline, from its first wick tip to a couple of days past the signal
      trendlines: s.kz ? [{ from: s.kz.from, to: s.kz.to, end: s.t + 12 * H4, color: '#8b5cf6' }] : [],
      lines: [
        ...s.levels.map(l => ({ price: l.price, color: 'ink', from: l.t, to: s.t })),     // swing levels in neutral gray
        ...(tr ? [
          { price: tr.tp, color: 'ink', from: tr.tpT, to: s.t },                      // the opposing level, from its swing
          // the position, drawn to the right of the candles
          // 🪜 the five limits, and where the filled ones average (LO)
          ...(tr.ladder ? tr.ladder.prices.map((x, i) => ({ price: x, color: 'muted', after: true, title: `🪜${i + 1}${tr.ladder.filled.includes(x) ? ' ✓' : ''}` })) : []),
          { price: tr.entry, color: 'entry', after: true, title: tr.ladder ? 'LO avg' : tr.limit ? 'LO' : 'Entry' },
          { price: tr.sl, color: 'neg', after: true, title: 'SL' },
          { price: tr.tp, color: 'pos', after: true, title: cpp ? 'TP' : 'TP → trail' },
          // C++ is tracked with fixed 2R / 3R targets, so those replace the add levels
          ...(cpp ? [2, 3].map(n => ({ price: tr.entry + (short ? -1 : 1) * n * Math.abs(tr.entry - tr.sl), color: '#e8955a', after: true, title: `${n}R` })) : [
            ...(plan?.adds || []).map(a => ({ price: a.price, color: 'muted', after: true, title: `Add ${a.n}` })),
            ...(plan?.adds.length === 2 ? [{ price: plan.adds[1].stop, color: 'muted', after: true, title: 'B/E' }] : []),
          ]),
        ] : []),
      ],
      boxes: [
        ...(tr ? [
          { after: true, price: tr.sl, base: tr.entry, color: 'neg' },
          { after: true, price: tr.tp, base: tr.entry, color: 'pos' },
        ] : []),
        ...killzoneBox(s.kz, lvOf(s), s.atr, s.t),
      ],
      marks: [
        ...s.levels.map(l => ({ t: l.t, position: short ? 'aboveBar' : 'belowBar', shape: 'circle', color: 'ink', tip: [`Swing ${short ? 'high' : 'low'} · level ${p(l.price)}`, new Date(l.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })] })),
        ...(tr ? [{ t: tr.tpT, position: short ? 'belowBar' : 'aboveBar', shape: 'circle', color: 'ink', tip: [`Opposing swing ${short ? 'low' : 'high'} · target ${p(tr.tp)}`] }] : []),
        ...killzoneMark(s.kz, lvOf(s), s.t, s.side, p, s.whale?.kind === 'absorbed'),
        { t: s.t, position: short ? 'aboveBar' : 'belowBar', shape: short ? 'arrowDown' : 'arrowUp', color: short ? 'neg' : 'pos', tip: [tr?.limit ? `SFP ${s.side.toLowerCase()} · closed ${p(s.close)}, limit ${p(tr.entry)}` : `SFP ${s.side.toLowerCase()} · entry ${p(s.close)}`, `Wick ${p(short ? s.high : s.low)} is the stop`] },
        ...(o?.tpT && o.tpT !== o.exitT ? [{ t: o.tpT, position: short ? 'belowBar' : 'aboveBar', shape: 'circle', color: 'pos', tip: [`Target ${p(tr.tp)} touched · trailing the stop from here`] }] : []),
        ...(o?.exitT ? [{ t: o.exitT, position: o.result === 'win' ? (short ? 'belowBar' : 'aboveBar') : (short ? 'aboveBar' : 'belowBar'), shape: 'square', color: o.R > 0 ? 'pos' : 'neg', tip: [endTip] }] : []),
      ],
      note: (tr?.ladder ? `${tr.ladderWhy === 'chase' ? 'BTC’s 1h RSI had already run the trade’s way' : 'This candle closed away from the level'}, so the entry is a 🪜 ladder of 5 limits 70–90% of the candle back toward the wick (LO is where the filled ones average), not its close;` : tr?.limit ? 'This candle closed away from the level, so the entry is a limit 70% of the candle back toward the wick (LO), not its close;' : 'Entry at the signal candle’s close,') + ' stop at its wick, target at the opposing swing level the move started from; once it’s touched, the stop trails each closed 4h candle. The position is drawn to the right of the candles: red is the risk, the other zone the reward. Circles mark the swing candles; the square marks where the trade ended.',
    },
  };
}
// The chart window steps through `list` oldest to newest, whatever order it's shown in.
export function showOnChart(s, list) {
  const sorted = [...list].sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
  const items = sorted.map(chartItem);
  ctx.openReplay(items[sorted.indexOf(s)], items, { apiJson: ctx.apiJson, fmt: { money: ctx.fmt.money, price: ctx.fmt.price, dateTime: ctx.fmt.dateTime, duration: () => '' } });
}

// ⚔️ the killzone on the chart: a purple box where the trendline meets the level (3 candles either side, the two
// prices with a little room), and a ⚔️ marker on the signal candle that says what it is. The line itself is drawn
// from `view.trendlines`.
const KZ_COLOR = '#8b5cf6';
const lvOf = s => (s.lv ?? (s.side === 'Short' ? Math.max(...s.levels.map(l => l.price)) : Math.min(...s.levels.map(l => l.price))));
export function killzoneBox(kz, level, atr, t) {
  if (!kz || !(atr > 0)) return [];
  const pad = 0.35 * atr, hi = Math.max(kz.at, level) + pad, lo = Math.min(kz.at, level) - pad;
  return [{ from: t - 3 * H4, to: t + 3 * H4, price: hi, base: lo, color: KZ_COLOR, alpha: 0.24 }];
}
export function killzoneMark(kz, level, t, side, p, whale) {
  if (!kz) return [];
  const short = side === 'Short';
  return [{ t, position: short ? 'belowBar' : 'aboveBar', shape: 'square', color: KZ_COLOR, tip: [`⚔️ Killzone: the ${kz.days}-day ${short ? 'falling' : 'rising'} line is at ${p(kz.at)} here, on the level ${p(level)}`, 'Breaks within 24h about half the time'] }];
}
