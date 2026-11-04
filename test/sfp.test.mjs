import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swings, detect as detectAny, closedOnly, H4 } from '../public/sfp.js';

// most cases sweep a level soon after its swing; the age rule has its own test
const detect = (c, o = {}) => detectAny(c, { minAge: 0, edge: 0, ...o });

// candles from [open, high, low, close]
const T0 = Date.UTC(2026, 9, 1);
const mk = rows => rows.map(([o, h, l, c], i) => ({ t: T0 + i * H4, o, h, l, c }));

// a swing high with a body top of 110 at index 3 (wick to 115), then lower bodies
const base = [
  [100, 101, 99, 100], [100, 103, 99, 102], [102, 106, 101, 105],
  [105, 115, 104, 110],                       // swing high: body top 110
  [109, 110, 103, 104], [104, 106, 100, 101], [101, 103, 98, 100],
];

test('swing high: body top above 3 candles each side, confirmed after the 3rd close', () => {
  const s = swings(mk(base)).filter(x => x.kind === 'high');
  assert.equal(s.length, 1);
  assert.equal(s[0].price, 110);
  assert.equal(s[0].confirmedAt, 6);
});

test('SFP: wick above the body level (not the wick high), close back at or below it', () => {
  const c = mk([...base, [100, 111, 99, 108]]);   // wick 111 > 110 but < 115; closes 108
  const { signals } = detect(c);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'Short');
  assert.equal(signals[0].levels[0].price, 110);
  assert.ok(Math.abs(signals[0].sweepPct - 1 / 110) < 1e-12);
});

test('no signal on the confirming candles, or when the close is beyond the level', () => {
  // a sweep before confirmation doesn't count: index 5 wicks to 112 but the swing isn't confirmed yet
  const early = mk([...base.slice(0, 5), [104, 112, 100, 101], ...base.slice(6)]);
  assert.equal(detect(early).signals.length, 0);
  // closing above breaks the level, so a later wick-and-fail doesn't trigger
  const broken = mk([...base, [100, 113, 99, 112], [111, 114, 105, 106]]);
  assert.equal(detect(broken).signals.filter(s => s.levels.some(l => l.price === 110)).length, 0);
  // unless breaking is turned off
  assert.equal(detect(broken, { breakOnClose: false }).signals.filter(s => s.levels.some(l => l.price === 110)).length, 1);
});

test('a level gives one signal by default; it can repeat if once is turned off', () => {
  const c = mk([...base, [100, 111, 99, 108], [108, 112, 104, 105]]);
  assert.equal(detect(c).signals.length, 1);
  assert.equal(detect(c, { once: false }).signals.length, 2);
});

test('levels older than the lookback are dropped', () => {
  const filler = Array.from({ length: 200 }, () => [100, 101, 99, 100]);
  const c = mk([...base, ...filler, [100, 111, 99, 108]]);
  assert.equal(detect(c, { lookbackDays: 30 }).signals.length, 0);       // 200 candles ≈ 33 days later
  assert.equal(detect(c, { lookbackDays: 40 }).signals.length, 1);
});

test('one signal lists every level failed at; longs mirror shorts at body bottoms', () => {
  const lows = [
    [100, 101, 99, 100], [100, 101, 97, 98], [98, 99, 94, 95],
    [95, 96, 85, 90],                          // swing low: body bottom 90
    [91, 97, 90, 96], [96, 100, 95, 99], [99, 101, 98, 100],
  ];
  const c = mk([...lows, [100, 101, 89, 92]]);
  const { signals } = detect(c);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'Long');
  assert.equal(signals[0].levels[0].price, 90);
});

test('only closed candles are used', () => {
  const c = mk(base);
  const now = c[c.length - 1].t + H4 / 2;          // last one still forming
  assert.equal(closedOnly(c, now).length, c.length - 1);
});

test('touching candles (each opens at the last close): the first candle at the peak is the swing', () => {
  // green to 110, then red opening at 110: both bodies top out at 110
  const c = mk([[100, 101, 99, 101], [101, 104, 100, 103], [103, 106, 102, 105], [105, 112, 104, 110],
    [110, 111, 104, 106], [106, 107, 101, 102], [102, 104, 99, 100], [100, 103, 98, 101]]);
  const s = swings(c).filter(x => x.kind === 'high');
  assert.equal(s.length, 1);
  assert.equal(s[0].i, 3);
  assert.equal(s[0].price, 110);
  assert.equal(s[0].confirmedAt, 6);
});

test('level lifetimes: from the candle it became usable to when it broke', () => {
  const c = mk([...base, [100, 111, 99, 108], [108, 113, 104, 112]]);   // signal, then a close above
  const l = detect(c, { once: false }).levels.find(x => x.price === 110);
  assert.equal(l.from, c[7].t);
  assert.equal(l.until, c[8].t);
  assert.equal(l.why, 'broken');
  assert.equal(l.hits, 1);
  // by default a level is used up by its one signal
  const used = detect(c).levels.find(x => x.price === 110);
  assert.equal(used.why, 'used');
  assert.equal(used.until, c[7].t);
});

test('a level can only be tested once its swing is at least minAge candles back', () => {
  const sweep = [100, 111, 99, 108];
  const young = mk([...base, sweep]);                               // swing at 3, sweep at 7: 4 candles
  assert.equal(detectAny(young, { minAge: 12, edge: 0 }).signals.length, 0);
  const filler = Array.from({ length: 8 }, () => [100, 101, 99, 100.5]);
  const old = mk([...base, ...filler, sweep]);                      // sweep at 15: 12 candles
  assert.equal(detectAny(old, { minAge: 12, edge: 0 }).signals.length, 1);
  assert.equal(detectAny(old, { minAge: 13, edge: 0 }).signals.length, 0);
});

test('range edge: a sweep of a level in the middle of the range is filtered out', () => {
  // range 80–120 from earlier candles; a swing high body top at 100 (the middle), then a sweep of it
  const c = mk([[90, 120, 89, 91], [91, 92, 80, 82], [82, 95, 81, 94], [94, 101, 93, 100], [99, 100, 95, 96],
    [96, 97, 92, 93], [93, 95, 90, 92], [92, 103, 91, 98]]);
  assert.equal(detectAny(c, { minAge: 0, edge: 0 }).signals.length, 1);
  assert.equal(detectAny(c, { minAge: 0, edge: 0.25 }).signals.length, 0);       // 100 is at 50% of 80–120
  assert.equal(detectAny(c, { minAge: 0, edge: 0.5 }).signals.length, 1);
  assert.ok(Math.abs(detectAny(c, { minAge: 0, edge: 0 }).signals[0].range.pos - 0.5) < 1e-9);
});

test('outermost: an inner level is skipped while a higher level is still live', () => {
  // two swing highs: 110 then a lower 105; a sweep of 105 that stays under 110
  const c = mk([[100, 101, 99, 100], [100, 103, 99, 102], [102, 106, 101, 105], [105, 112, 104, 110],
    [109, 110, 101, 102], [102, 104, 100, 101], [101, 103, 99, 100], [100, 104, 99, 103], [103, 107, 102, 105],
    [104, 105, 100, 101], [101, 102, 98, 99], [99, 101, 97, 98], [98, 106, 97, 103]]);
  const inner = s => s.levels.some(l => l.price === 105);
  assert.equal(detectAny(c, { minAge: 0, edge: 0 }).signals.filter(inner).length, 1);
  assert.equal(detectAny(c, { minAge: 0, edge: 0, outermost: true }).signals.filter(inner).length, 0);
});

import { trendMap, counterTrend, smt, M15 } from '../public/sfp.js';

test('BTC trend: close above its EMA is up; counter-trend is a long in a downtrend or a short in an uptrend', () => {
  const up = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H4, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }));
  const tr = trendMap(up, 50);
  const last = up.at(-1).t;
  assert.equal(tr.get(last).up, true);
  assert.equal(counterTrend({ t: last, side: 'Short' }, tr), true);
  assert.equal(counterTrend({ t: last, side: 'Long' }, tr), false);
  assert.equal(counterTrend({ t: up[10].t, side: 'Long' }, tr), null);      // EMA not settled yet
});

test('15m SMT: one market takes its recent low while the other holds, in either form', () => {
  const sig = { t: T0 + 100 * M15, side: 'Long' };
  const m = (lows) => lows.map((l, i) => ({ t: sig.t - 32 * M15 + i * M15, o: l + 1, h: l + 2, l, c: l + 1 }));
  const before = Array(32).fill(100), during = Array(16).fill(101);
  const alt = m([...before, ...during.map((x, i) => (i === 5 ? 98 : x))]);     // lower low during the signal candle
  const btcHolds = m([...before, ...during]);                                   // BTC stays above 100
  const btcBreaks = m([...before, ...during.map((x, i) => (i === 5 ? 99 : x))]);
  // 'sweep': the pair takes its low, BTC holds
  assert.equal(smt(sig, alt, btcHolds, { type: 'sweep' }).ok, true);
  assert.equal(smt(sig, alt, btcBreaks, { type: 'sweep' }).ok, false);
  // 'strength' (default): BTC takes its low, the pair holds
  const altHolds = m([...before, ...during]);
  assert.equal(smt(sig, altHolds, btcBreaks).ok, true);
  assert.equal(smt(sig, alt, btcBreaks).ok, false);                              // both took it: no divergence
  assert.equal(smt(sig, altHolds, btcHolds).ok, false);                          // neither did
});

test('BTC neutral zone: close to its EMA, nothing is counter-trend', () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H4, o: 100, h: 101, l: 99, c: i === 59 ? 100.5 : 100 }));
  const tr = trendMap(flat, 50), t = flat.at(-1).t;
  assert.equal(counterTrend({ t, side: 'Short' }, tr), true);              // 0.5% above the EMA: up
  assert.equal(counterTrend({ t, side: 'Short' }, tr, 0.01), false);       // inside a 1% band: neutral
});

test('range window: a short range catches the local top that a long one calls mid-range', () => {
  // an old spike to 140, then a 7-day range of 100–120 with a swing high body top at 118 that gets swept
  const spike = [[110, 140, 109, 111]];
  const flat = Array.from({ length: 40 }, () => [110, 111, 101, 105]);
  const swing = [[105, 112, 104, 110], [110, 116, 109, 115], [115, 121, 114, 118], [118, 119, 112, 113], [113, 114, 108, 109], [109, 110, 104, 105]];
  const wait = Array.from({ length: 8 }, () => [105, 107, 100, 104]);
  const c = mk([...spike, ...flat, ...swing, ...wait, [104, 120, 103, 108]]);
  const o = { minAge: 0, edge: 0.35 };
  assert.equal(detectAny(c, { ...o, rangeDays: 30 }).signals.filter(s => s.side === 'Short').length, 0);   // 118 is mid-range against 140
  assert.equal(detectAny(c, { ...o, rangeDays: 7 }).signals.filter(s => s.side === 'Short').length, 1);
});

// ---- the trade: entry at the close, stop at the wick, target at the opposing level ----
const tradeBase = [
  [100, 101, 99, 100], [100, 103, 99, 102], [102, 106, 101, 105], [105, 115, 104, 110],   // swing high: body top 110
  [109, 110, 103, 104], [104, 106, 100, 101], [101, 103, 98, 100], [100, 101, 95, 97],
  [97, 98, 90, 92],                                                                         // swing low: body bottom 92, where the rally starts
  [92, 96, 91, 95], [95, 99, 94, 98], [98, 102, 97, 101], [101, 104, 100, 103],
  [103, 111, 102, 108],                                                                     // sweep of 110, close 108: the signal
];
const tradeOf = rows => detect(mk(rows)).signals.find(s => s.k === 13).trade;

test('trade: entry at the close, stop at the wick, target at the swing the move started from', () => {
  const t = tradeOf(tradeBase);
  assert.equal(t.entry, 108);
  assert.equal(t.sl, 111);
  assert.equal(t.tp, 92);
  assert.ok(Math.abs(t.rr - 16 / 3) < 1e-12);
  assert.equal(t.result, 'open');
});

test('trade: target hit is a win of rr, stop hit is −1R, both in one candle counts as the stop', () => {
  assert.deepEqual([tradeOf([...tradeBase, [108, 109, 100, 101], [101, 102, 91, 93]]).result], ['win']);
  assert.ok(Math.abs(tradeOf([...tradeBase, [108, 109, 100, 101], [101, 102, 91, 93]]).R - 16 / 3) < 1e-12);
  const lost = tradeOf([...tradeBase, [108, 112, 105, 106]]);
  assert.equal(lost.result, 'loss');
  assert.equal(lost.R, -1);
  assert.equal(tradeOf([...tradeBase, [108, 112, 91, 95]]).result, 'loss');
});

test('the scaling plan: adds at +1R and +2R, stops stepped up behind them', async () => {
  const { scalePlan, BE_FEES } = await import('../public/sfp.js');
  const short = scalePlan({ entry: 100, sl: 102, tp: 80 }, 'Short');
  assert.deepEqual(short.adds.map(a => [a.price, a.size]), [[98, 1], [96, 0.5]]);
  assert.equal(short.adds[0].stop, 100);
  assert.ok(Math.abs(short.adds[1].stop - (100 - 0.8 * 2) * (1 - BE_FEES)) < 1e-9);  // average entry 98.4
  assert.equal(short.R, 10 + 9 + 0.5 * 8);
  assert.equal(scalePlan({ entry: 100, sl: 99, tp: 101.5 }, 'Long').adds.length, 1); // the target comes before +2R
  assert.equal(scalePlan(null, 'Long'), null);
});

test('proposed risk: by grade, half on a weak close, none outside the trading day', async () => {
  const { proposedRisk } = await import('../public/day-playbook.js');
  const at = (d, h) => new Date(2026, 10, 1 + d, h).getTime();      // Nov 2 2026 is a Monday (local time)
  assert.equal(proposedRisk('A+', at(1, 8)).pct, 2);                  // Monday 08:00, prime
  assert.equal(proposedRisk('A', at(1, 12)).pct, 1);
  assert.equal(proposedRisk('A', at(4, 16)).pct, 0.5);                 // Thursday 16:00 is weak: half
  assert.equal(proposedRisk('A', at(5, 8)).pct, 0.5);                  // Friday: half
  assert.equal(proposedRisk('A', at(1, 20)).pct, 0);                   // outside the trading day
  assert.equal(proposedRisk('A+', at(1, 20)).pct, 0.25);               // ...except A+, Mon–Thu, at a quarter percent
  assert.equal(proposedRisk('A+', at(4, 4)).pct, 0.25);
  assert.equal(proposedRisk('A+', at(5, 0)).pct, 0);                   // not on Friday
  assert.equal(proposedRisk('A+', at(1, 21)).pct, 0);                  // not between closes
  assert.equal(proposedRisk('B', at(5, 8)).pct, 0);                    // B on a weak close: skip
  assert.equal(proposedRisk('B+', at(2, 0)).pct, 0.25);               // B+ at 00:00 / 04:00, Mon–Thu
  assert.equal(proposedRisk('B+', at(4, 4)).pct, 0.25);
  assert.equal(proposedRisk('B+', at(1, 20)).pct, 0);                  // ...not at 20:00
  assert.equal(proposedRisk('B+', at(5, 0)).pct, 0);                   // ...not on Friday
  assert.equal(proposedRisk('B', at(2, 0)).pct, 0);                    // plain B: never
  assert.equal(proposedRisk('C', at(1, 8)).pct, 0);
});

test('position notes: NY bias, plan step, weekend', async () => {
  const { positionNotes } = await import('../public/day-playbook.js');
  const day = 864e5, t0 = Date.UTC(2026, 10, 2, 22);
  const sessions = [{ end: t0, bias: 'bearish' }, { end: t0 - day, bias: 'bullish' }];
  const wed = new Date(2026, 10, 4, 10);
  const short = { dir: 'Short', entry: 100, sl: 102, mark: 97, openedAt: t0 - day / 2 };
  const n = positionNotes(short, { sessions, now: wed }).map(x => x.text);
  assert.match(n[0], /NY flipped your way since entry ▼/);
  assert.match(n[1], /^\+1\.5R: past \+1R/);
  assert.match(positionNotes({ ...short, dir: 'Long', sl: 98, mark: 100.5 }, { sessions, now: wed }).map(x => x.text).join('|'), /Against the NY bias ▼.*\+0\.3R: stop at the wick, first add at 102/);
  assert.match(positionNotes({ ...short, sl: 99.5 }, { sessions, now: wed })[1].text, /protected/);
  assert.match(positionNotes(short, { sessions, now: new Date(2026, 10, 7, 10) }).at(-1).text, /Weekend/);
});

test('playbook countdowns', async () => {
  const { countdown } = await import('../public/day-playbook.js');
  const at = Date.UTC(2026, 10, 4, 8);
  assert.equal(countdown(at, at - 83 * 60_000), 'in 1h 23m');
  assert.equal(countdown(at, at - 5 * 60_000), 'in 5m');
  assert.equal(countdown(at, at + 60_000), 'now');
  assert.equal(countdown(at, at + 10 * 60_000), 'done');
});

test('trade results with the scaling plan', async () => {
  const { scaledResult } = await import('../public/sfp.js');
  const c = (t, o, h, l, cl) => ({ t, o, h, l, c: cl });
  const trade = { entry: 100, sl: 99, tp: 110 }, sig = c(0, 100, 100, 99, 100);
  // both adds fill (101, 102), then the target: 10 + 9 + 0.5 × 8 = 23R
  const win = scaledResult([sig, c(1, 100, 101.5, 100, 101.5), c(2, 101.5, 102.5, 101, 102.4), c(3, 102.4, 110.5, 102, 110)], 0, trade, false);
  assert.equal(win.result, 'win'); assert.equal(win.R, 23); assert.equal(win.rr, 23); assert.equal(win.adds, 2);
  assert.ok(win.net < 23 && win.net > 22.5);
  // add 1 fills, then back to the entry: the add loses its 1R
  const entry = scaledResult([sig, c(1, 100, 101.5, 100, 101.5), c(2, 101.5, 101.6, 99.8, 100)], 0, trade, false);
  assert.equal(entry.result, 'entry'); assert.equal(entry.R, -1);
  // straight to the stop; and a short that hasn't ended
  assert.equal(scaledResult([sig, c(1, 100, 100.5, 98.9, 99)], 0, trade, false).result, 'loss');
  const open = scaledResult([c(0, 100, 101, 100, 100), c(1, 100, 100.5, 99.5, 99)], 0, { entry: 100, sl: 101, tp: 90 }, true);
  assert.equal(open.result, 'open'); assert.equal(open.R, 1); assert.equal(open.net, null);
});

test('RSI (Wilder, 14) and the B+ stretch', async () => {
  const { rsi, rsiStretched } = await import('../public/sfp.js');
  const up = Array.from({ length: 30 }, (_, i) => ({ c: 100 + i }));
  assert.equal(rsi(up)[13], null);
  assert.equal(rsi(up)[14], 100);                                      // only gains
  const zig = Array.from({ length: 40 }, (_, i) => ({ c: 100 + (i % 2 ? 1 : -1) }));
  assert.ok(Math.abs(rsi(zig).at(-1) - 50) < 5);                       // even gains and losses ≈ 50
  const down = Array.from({ length: 30 }, (_, i) => ({ c: 130 - i }));
  assert.equal(rsi(down).at(-1), 0);
  assert.ok(rsiStretched('Long', 39) && !rsiStretched('Long', 41) && rsiStretched('Short', 61) && !rsiStretched('Short', 59));
  assert.ok(!rsiStretched('Long', null));
});
