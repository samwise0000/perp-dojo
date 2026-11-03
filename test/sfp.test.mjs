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
