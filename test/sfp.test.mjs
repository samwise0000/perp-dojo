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

test('trade: at the target the stop trails each closed 4h candle; stop hit is −1R; both in one candle counts as the stop', () => {
  // a short from 108 (stop 111, target 92): touches 92, then breaks out lower; the stop follows each candle's high
  const run = [[108, 109, 100, 101], [101, 102, 91, 93], [93, 94, 80, 81], [81, 84, 75, 76], [76, 85, 76, 84]];
  const won = tradeOf([...tradeBase, ...run]);
  assert.equal(won.result, 'win'); assert.equal(won.trail, true);
  assert.ok(Math.abs(won.R - (108 - 84) / 3) < 1e-12, 'out at 84, the last closed candle’s high: 8R, past the 5.3R target');
  assert.equal(tradeOf([...tradeBase, ...run.slice(0, 4)]).result, 'open', 'still trailing');
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
  assert.equal(proposedRisk('A++', at(1, 8)).pct, 1);                 // Monday 08:00, prime
  assert.equal(proposedRisk('A+', at(1, 8)).pct, 1);
  assert.equal(proposedRisk('A+', at(1, 20)).pct, 0);                  // the RSI A+ isn't taken at the late closes
  assert.equal(proposedRisk('A', at(1, 12)).pct, 0.5);
  assert.equal(proposedRisk('A', at(4, 16)).pct, 0.25);                // Thursday 16:00 is weak: half
  assert.equal(proposedRisk('A', at(5, 8)).pct, 0.125);                // Friday: trade cautiously, a quarter size
  assert.equal(proposedRisk('A++', at(5, 16)).pct, 0.25);
  assert.equal(proposedRisk('B', at(5, 12)).pct, 0);                   // no B
  const { picksAt } = await import('../public/day-playbook.js');
  assert.equal(picksAt(at(5, 12)), 1); assert.equal(picksAt(at(2, 12)), 2);   // the best setup only on Friday
  // Friday night (Saturday's 00:00 / 04:00): the late setups, trade-cautiously
  assert.equal(proposedRisk('A++', at(6, 0), { tag: 'late' }).pct, 0.125);
  assert.equal(proposedRisk('A++', at(6, 4), { tag: 'late' }).slot, 'caution');
  assert.equal(proposedRisk('A', at(6, 0), { tag: 'midnight' }).pct, 0.0625);
  assert.equal(proposedRisk('A+', at(6, 0)).pct, 0);                    // still only the late setups
  assert.equal(proposedRisk('A++', at(5, 0), { tag: 'late' }).pct, 0.125);   // Thursday night: caution too
  assert.match(proposedRisk('A++', at(5, 4), { tag: 'late' }).why, /Thursday night: trade cautiously/);
  assert.equal(picksAt(at(6, 4)), 1);
  assert.equal(proposedRisk('A++', at(6, 12)).pct, 0);                 // nor Saturday
  assert.match(proposedRisk('A', at(0, 16)).why, /weekend/);
  assert.equal(proposedRisk('A', at(1, 20)).pct, 0);                   // outside the trading day
  assert.equal(proposedRisk('A++', at(1, 20)).pct, 0);                 // not even A++ at the late closes
  assert.equal(proposedRisk('A++', at(4, 4)).pct, 0);
  assert.equal(proposedRisk('A++', at(5, 0)).pct, 0);                  // not on Friday
  assert.equal(proposedRisk('A++', at(1, 21)).pct, 0);                 // not between closes
  assert.equal(proposedRisk('B', at(5, 8)).pct, 0);                    // B on a weak close: skip
  assert.equal(proposedRisk('B+', at(2, 0)).pct, 0.25);               // B+ at 00:00 / 04:00, Mon–Thu
  assert.equal(proposedRisk('A++', at(2, 0), { tag: 'late' }).pct, 0.5);    // 🌃 Late A++
  assert.equal(proposedRisk('A++', at(1, 20), { tag: 'late' }).pct, 0);     // not at 20:00
  assert.equal(proposedRisk('A++', at(2, 0)).pct, 0);                  // the main-close A++ is a skip late
  assert.equal(proposedRisk('B+', at(4, 4)).pct, 0.25);
  assert.equal(proposedRisk('B+', at(1, 20)).pct, 0);                  // ...not at 20:00
  assert.equal(proposedRisk('B+', at(5, 0)).pct, 0.0625);              // Thursday night: a quarter
  assert.equal(proposedRisk('B', at(2, 0)).pct, 0);                    // plain B: never
  assert.equal(proposedRisk('A', at(2, 0), { tag: 'midnight' }).pct, 0.25);   // 🌙 Midnight sweep: Tue 00:00
  assert.match(proposedRisk('A', at(2, 0), { tag: 'midnight' }).why, /Midnight sweep/);
  assert.equal(proposedRisk('A', at(2, 0)).pct, 0);                    // an A at 00:00 without BTC's sweep: no
  assert.equal(proposedRisk('A', at(2, 4), { tag: 'midnight' }).pct, 0);      // only at 00:00
  assert.equal(proposedRisk('A', at(5, 0), { tag: 'midnight' }).pct, 0.0625);   // Thursday night: a quarter
  assert.equal(proposedRisk('A', at(1, 8), { tag: 'midnight' }).pct, 0.5);    // at a main close it's just an A
  assert.equal(proposedRisk('C', at(1, 8)).pct, 0);
});

test('position notes: NY bias, plan step, weekend', async () => {
  const { positionNotes } = await import('../public/day-playbook.js');
  const day = 864e5, t0 = Date.UTC(2026, 10, 2, 22);
  const sessions = [{ end: t0, bias: 'bearish' }, { end: t0 - day, bias: 'bullish' }];
  const wed = new Date(2026, 10, 4, 10);
  const short = { dir: 'Short', entry: 100, sl: 102, mark: 97, openedAt: t0 - day / 2 };
  const n = positionNotes(short, { sessions, now: wed }).map(x => x.text);
  assert.match(n[0], /NY flipped your way ▼/);
  assert.match(n[1], /^\+1\.5R: add the same size, stops to entry/);
  assert.match(positionNotes({ ...short, dir: 'Long', sl: 98, mark: 100.5 }, { sessions, now: wed }).map(x => x.text).join('|'), /Against the NY bias ▼.*\+0\.3R: stop at the wick, first add at 102/);
  assert.match(positionNotes({ ...short, sl: 99.5 }, { sessions, now: wed })[1].text, /protected/);
  const sat = new Date(2026, 10, 7, 10);
  assert.match(positionNotes(short, { sessions, now: sat }).at(-1).text, /^Weekend, in profit: add on a dip/);   // +1.5R
  assert.match(positionNotes({ ...short, mark: 99.5 }, { sessions, now: sat }).at(-1).text, /^Weekend: hold your runner/);       // +0.25R
  assert.match(positionNotes({ ...short, sl: 99.5 }, { sessions, now: sat }).at(-1).text, /add on a dip/);                   // stop past entry, in profit
  assert.match(positionNotes({ ...short, sl: 99.5, mark: 101 }, { sessions, now: sat }).at(-1).text, /hold your runner/);         // stop past entry, but underwater
  const thu = new Date(2026, 10, 5, 10);
  assert.match(positionNotes(short, { sessions, now: thu }).at(-1).text, /^Thursday: weekend ahead, consider holding/);
  assert.doesNotMatch(positionNotes({ ...short, mark: 101 }, { sessions, now: thu }).map(x => x.text).join('|'), /Thursday/);   // underwater, stop at the wick
  assert.doesNotMatch(positionNotes(short, { sessions, now: wed }).map(x => x.text).join('|'), /Thursday/);
});

test('position notes: BTC breaks its 4h high but the alt doesn’t, in the first 3 candles', async () => {
  const { positionNotes, smtCheck } = await import('../public/day-playbook.js');
  const H4 = 4 * 3_600_000, t0 = Date.UTC(2026, 10, 4, 4);             // entry at a 12:00 close (UTC+8)
  const c = (t, h, l = 90) => ({ t, o: 95, h, l, c: 95 });
  const long = { symbol: 'ETHFIUSDT', dir: 'Long', entry: 100, sl: 98, mark: 100.5, openedAt: t0 + 3 * 60_000 };
  const btc = [c(t0 - H4, 100), c(t0, 101), c(t0 + H4, 102)];
  const altLag = [c(t0 - H4, 100), c(t0, 99.5), c(t0 + H4, 101)];       // BTC made a higher high in the first candle, the alt didn't
  const altWith = [c(t0 - H4, 100), c(t0, 100.5), c(t0 + H4, 101)];
  assert.deepEqual(smtCheck(long, altLag, btc, t0 + H4 + 1), { state: 'diverged', t: t0 });
  assert.deepEqual(smtCheck(long, altWith, btc, t0 + H4 + 1), { state: 'watch', until: t0 + 3 * H4 });
  assert.deepEqual(smtCheck(long, altWith, btc, t0 + 1), { state: 'watch', until: t0 + 3 * H4 });
  assert.equal(smtCheck({ ...long, openedAt: t0 - 2 * 60_000 }, altLag, btc, t0 + H4 + 1).state, 'diverged');   // entered just before the close
  const text = smt => positionNotes(long, { smt }).map(x => x.text).join('|');
  assert.match(text({ state: 'diverged' }), /BTC broke its 4h high, ETHFI didn’t: closing is reasonable/);
  assert.match(text({ state: 'watch', until: t0 + 3 * H4 }), /(^|\|)If SMT is present against BTC, closing early is reasonable(\||$)/);
  assert.doesNotMatch(positionNotes({ ...long, mark: 102.5 }, { smt: { state: 'diverged' } }).map(x => x.text).join('|'), /BTC broke/);   // past +1R: the plan's stops handle it
  assert.doesNotMatch(positionNotes({ ...long, sl: 100 }, { smt: { state: 'diverged' } }).map(x => x.text).join('|'), /BTC broke/);      // stop at entry
  const short = { ...long, dir: 'Short', sl: 102, mark: 99.8 };
  assert.match(positionNotes(short, { smt: { state: 'watch', until: t0 } }).map(x => x.text).join('|'), /If SMT is present against BTC, closing early is reasonable/);
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
  // then the trail: the stop follows each closed candle's low (102, then 109) and is hit at 109: 9 + 8 + 0.5 × 7 = 20.5R
  const toTp = [sig, c(1, 100, 101.5, 100, 101.5), c(2, 101.5, 102.5, 101, 102.4), c(3, 102.4, 110.5, 102, 110)];
  const win = scaledResult([...toTp, c(4, 110, 115, 109, 114), c(5, 114, 114.5, 108, 109)], 0, trade, false);
  assert.equal(win.result, 'win'); assert.equal(win.trail, true); assert.equal(win.R, 20.5); assert.equal(win.rr, 23); assert.equal(win.adds, 2);
  assert.ok(win.net < 20.5 && win.net > 20);
  const trailing = scaledResult(toTp, 0, trade, false);
  assert.equal(trailing.result, 'open'); assert.equal(trailing.trailing, true); assert.equal(trailing.trailStop, 102);
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

test('forward test: positions, matching to signals, R by the signal stop', async () => {
  const { positionsFrom, entryOrders, matchSignal, forwardReport } = await import('../public/forward.js');
  const H4 = 4 * 3_600_000, T0 = Date.UTC(2026, 10, 3, 0);              // signal candle start; it closes at T0 + 4h
  const close = T0 + H4;
  const trades = [                                                        // one long closed in two parts, one unrelated short
    { category: 'linear', symbol: 'HYPEUSDT', dir: 'Long', openedAt: close + 60_000, time: close + 5 * H4, pnl: 30, fees: 1, size: 10 },
    { category: 'linear', symbol: 'HYPEUSDT', dir: 'Long', openedAt: close + 60_000, time: close + 6 * H4, pnl: 50, fees: 1, size: 15 },
    { category: 'linear', symbol: 'SUIUSDT', dir: 'Short', openedAt: close + 3 * H4, time: close + 4 * H4, pnl: -12, fees: 1, size: 100 },
    { category: 'linear', symbol: 'ZECUSDT', dir: 'Long', openedAt: null, time: close, pnl: 5, fees: 0, size: 1 },   // open time unknown: skipped
  ];
  const ps = positionsFrom(trades);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].pnl, 80); assert.equal(ps[0].parts, 2); assert.equal(ps[0].size, 25);
  const execs = {
    a: { c: 'linear', s: 'HYPEUSDT', side: 'Buy', q: 6, cs: 0, t: close + 60_000, o: 'o1' },
    b: { c: 'linear', s: 'HYPEUSDT', side: 'Buy', q: 4, cs: 0, t: close + 61_000, o: 'o1' },          // same first order, second fill
    c: { c: 'linear', s: 'HYPEUSDT', side: 'Buy', q: 10, cs: 0, t: close + H4, o: 'o2' },             // add 1
    d: { c: 'linear', s: 'HYPEUSDT', side: 'Buy', q: 5, cs: 0, t: close + 2 * H4, o: 'o3' },          // add 2
    e: { c: 'linear', s: 'HYPEUSDT', side: 'Sell', q: 10, cs: 10, t: close + 5 * H4, o: 'o4' },       // a close, not an add
  };
  assert.deepEqual(entryOrders(ps[0], execs), { first: 10, adds: 2 });
  const sig = { symbol: 'HYPEUSDT', side: 'Long', t: T0, grade: { grade: 'A' }, trade: { entry: 40, sl: 39, tp: 46, rr: 6, scaled: { net: 12.5 } } };
  const early = { ...sig, t: T0 - 2 * H4 };
  assert.equal(matchSignal(ps[0], [early, sig]), sig);
  assert.equal(matchSignal(ps[1], [sig]), null);                          // different pair
  assert.equal(matchSignal({ ...ps[0], openedAt: close + H4 + 1 }, [sig]), null);   // opened after the next candle
  // Tue 08:00 local is a main close only in some time zones, so use whatever this machine's proposedRisk says
  const rep = forwardReport({ trades, execs, signals: [sig], start: close - DAY_MS() });
  const hype = rep.rows.find(r => r.symbol === 'HYPEUSDT');
  assert.equal(hype.R, 8);                                                // 80 ÷ (10 × 1)
  assert.equal(hype.plan, 12.5);
  assert.equal(hype.adds, 2);
  assert.equal(rep.rows.find(r => r.symbol === 'SUIUSDT').sig, null);
});
function DAY_MS() { return 864e5; }

test('playbook read: New York in plain English, the bias, and what to look for', async () => {
  const { nyRead, lookingFor } = await import('../public/day-playbook.js');
  const wed = { date: '2026-11-04', start: 0, end: 1, open: 100, close: 102.5, high: 103, low: 99.5, change: 0.025, bias: 'bullish' };
  const r = nyRead([wed]);
  assert.equal(r.story, 'BTC rose 2.5% in Wednesday’s NY session and closed near its high.');
  assert.equal(r.dir, 'Long'); assert.equal(r.live, null);
  assert.match(nyRead([{ ...wed, close: 100.1, change: 0.001, bias: 'bullish' }]).story, /went nowhere/);
  assert.match(nyRead([{ date: '2026-11-05', live: true, change: -0.006 }, wed]).live, /open: −0\.6% so far/);
  const thu11 = new Date(2026, 10, 5, 11);                                // Thursday 11:00 local: 12:00 and 16:00 left
  const lf = lookingFor(r, { now: thu11, open: 4 });
  assert.equal(lf.lines[0].text, 'Longs at 12:00 · 16:00: a sweep of a low that closes back above it.');
  assert.match(lf.lines.map(x => x.text).join('|'), /Skip shorts: against the bias they grade C\.\|Room for 1 new at 12:00 \(4 of 5 open\)/);
  const { btcChips } = await import('../public/day-playbook.js');
  assert.deepEqual(btcChips(r, { pull: { dir: 'Long', back: 0.6 }, rsi: 41 }).map(c => c.cls), ['gold', 'cool']);
  assert.match(btcChips(r, { pull: { dir: 'Long', back: 0.2 }, rsi: 69 }).map(c => c.text).join('|'), /gave back 20% of NY’s move\|⚠️ 1h RSI 69: overbought, wait for a cool-off/);
  assert.match(lookingFor(r, { now: new Date(2026, 10, 7, 11) }).lines[0].text, /No new trades today/);           // Saturday
  assert.match(lookingFor(r, { now: new Date(2026, 10, 6, 11) }).lines.map(x => x.text).join('|'), /quarter size/);   // Friday
  assert.match(lookingFor({ ...r, dir: null }).lines[0].text, /Stand aside/);
});

test('candleShape: closed away from the level, body and wick engulfs, the 70% limit', async () => {
  const { candleShape } = await import('../public/sfp.js');
  const prev = { o: 100, h: 104, l: 96, c: 102 };
  assert.equal(candleShape(prev, { o: 102, h: 106, l: 98, c: 99 }, 'Long').away, false);                    // a long on a red candle: at the level
  const body = candleShape(prev, { o: 102, h: 103, l: 94, c: 103.5 }, 'Long');                              // green, past the body (102) but not the wick (104)
  assert.deepEqual([body.away, body.engulf], [true, 'body']);
  assert.ok(Math.abs(body.limit - (103 - 0.7 * 9)) < 1e-9);                                                 // 70% back toward the low wick
  assert.equal(candleShape(prev, { o: 102, h: 105, l: 94, c: 104.5 }, 'Long').engulf, 'wick');
  const sh = candleShape(prev, { o: 103, h: 108, l: 95, c: 95.5 }, 'Short');                                 // red, below the previous low
  assert.deepEqual([sh.away, sh.engulf], [true, 'wick']);
  assert.ok(Math.abs(sh.limit - (95 + 0.7 * 13)) < 1e-9);
  assert.equal(candleShape(prev, { o: 101, h: 105, l: 100, c: 100.5 }, 'Short').engulf, null);               // red but not past the body
});

test('limitTrade: entry at the limit, R:R from it, missed when price runs or waits too long', async () => {
  const { limitTrade, LIMIT_WAIT } = await import('../public/sfp.js');
  const c = (h, l, cl = (h + l) / 2) => ({ t: 0, o: cl, h, l, c: cl });
  const trade = { entry: 109, sl: 100, tp: 130, rr: 21 / 9, riskPct: 9 / 109, result: 'win', R: 21 / 9 };
  const k = 0, mk = (...xs) => [c(110, 100, 109), ...xs].map((x, i) => ({ ...x, t: i * 14_400_000 }));
  // long, limit at 103: R:R (130 − 103) / 3 = 9
  const win = limitTrade(mk(c(108, 102.5), c(131, 104), c(140, 125), c(130, 120)), k, trade, false, 103);   // the target, then out on the trail at 125
  assert.deepEqual([win.entry, win.result, +win.rr.toFixed(2)], [103, 'win', 9]);
  assert.equal(limitTrade(mk(c(108, 99.5)), k, trade, false, 103).result, 'loss');                    // filled and stopped in one candle
  assert.equal(limitTrade(mk(c(131, 104)), k, trade, false, 103).missed, 'ran');                       // went to the target without filling
  assert.equal(limitTrade(mk(...Array.from({ length: LIMIT_WAIT + 1 }, () => c(110, 105))), k, trade, false, 103).missed, 'expired');
  assert.equal(limitTrade(mk(c(110, 105)), k, trade, false, 103).pending, true);                       // still waiting
});

test('S and C+: an A grade that is a full swing failure with a golden R:R is S; an A grade that engulfed is C+', async () => {
  const { tierOf, GRADE_ORDER } = await import('../public/sfp.js');
  const { proposedRisk } = await import('../public/day-playbook.js');
  assert.deepEqual(GRADE_ORDER.slice(0, 6), ['S++', 'S+', 'S', 'A+', 'A++', 'A']);
  // 💎 S++: an S+ or an S that's also a ⭐ golden R:R in the ✨ golden zone
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { full: true, grr: true, zone: true }).grade, 'S++');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'cool', grr: true, zone: true }).grade, 'S++');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'cool', grr: true, zone: true }).from, 'A+');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'cool', zone: true }).grade, 'S', 'an S without ⭐ stays S');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'deep', grr: true, zone: true }).grade, 'S++', 'S++ via 🐋 skips the cool-off');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'deep', grr: true }).grade, 'A+', 'no golden zone, no cool-off: stays A+');
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { full: true, grr: true }).grade, 'S+', 'no golden zone: S+');
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { grr: true, zone: true }).grade, 'A', 'an A with ⭐ and ✨ alone stays A');
  // 🐋 S: an A or A+ with whale absorption; S+ still wins when both apply; A++ and B stay as they are
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { whale: 'absorbed', btcRsi: 'cool' }).grade, 'S');
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { whale: 'absorbed' }).grade, 'A', 'no BTC cool-off: stays A');
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { whale: 'absorbed', btcRsi: 'deep' }).grade, 'A');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', btcRsi: 'cool' }).from, 'A+');
  assert.equal(tierOf({ grade: 'A+', why: 'x' }, { whale: 'absorbed', full: true, grr: true }).grade, 'S+');
  assert.equal(tierOf({ grade: 'A++', why: 'x' }, { whale: 'absorbed' }).grade, 'A++');
  assert.equal(tierOf({ grade: 'B', why: 'x' }, { whale: 'absorbed' }).grade, 'B');
  assert.equal(tierOf({ grade: 'A', why: 'x' }, { whale: 'crowded' }).grade, 'A');
  const a = { grade: 'A++', why: 'with the NY bias ▲, BTC swept too' };
  assert.equal(tierOf(a, { full: true, grr: true }).grade, 'S+');
  assert.equal(tierOf(a, { full: true, grr: true }).from, 'A++');
  const ap = { grade: 'A+', why: '4h RSI 36 (stretched)' };
  assert.equal(tierOf(ap, { btcRsi: 'cool', rr: 12 }).grade, 'A+');                         // BTC cooled off is a tag (🧊), not a tier
  assert.equal(tierOf(a, { btcRsi: 'cool', rr: 12 }).grade, 'A++');                         // only A+
  assert.equal(tierOf(ap, { btcRsi: 'cool', rr: 12, full: true, grr: true }).grade, 'S+'); // both: S+
  assert.equal(tierOf(a, { full: true, grr: false }), a);                                   // needs both
  assert.equal(tierOf(a, { shape: { away: true, engulf: 'body' } }).grade, 'C+');            // an engulf: tracking
  assert.equal(tierOf(a, { shape: { away: true, engulf: 'body' }, full: true, grr: true }).grade, 'S+');   // S+ comes first
  assert.equal(tierOf({ grade: 'B', why: '' }, { full: true, grr: true }).grade, 'B');      // only A grades
  const tue12 = new Date(2026, 10, 3, 12).getTime();
  assert.equal(proposedRisk('S+', tue12, { from: 'A++' }).pct, proposedRisk('A++', tue12).pct);
  assert.equal(proposedRisk('C+', tue12, { from: 'A' }).pct, 0);
  assert.equal(proposedRisk('S', new Date(2026, 10, 7, 12).getTime(), { from: 'A' }).pct, 0);   // Saturday: skip, like its A
});

test('emaGuard: a short while BTC is above its 4h EMA100 is marked and gets no size', async () => {
  const { emaGuard } = await import('../public/sfp.js');
  const { proposedRisk } = await import('../public/day-playbook.js');
  const a = { grade: 'A', why: '' };
  assert.equal(emaGuard(a, 'Short', true).skip, 'ema');
  assert.equal(emaGuard(a, 'Long', true), a);               // longs aren't touched
  assert.equal(emaGuard(a, 'Short', false), a);             // BTC below its EMA100: a normal short
  const tue12 = new Date(2026, 10, 3, 12).getTime();
  assert.ok(proposedRisk('A', tue12).pct > 0);
  assert.equal(proposedRisk('A', tue12, { skip: 'ema' }).pct, 0);
});

test('Golden R:R: an A grade with a 10–20R target within 10 ATR', async () => {
  const { goldenRR, atrAt } = await import('../public/sfp.js');
  const flat = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100 }));
  assert.equal(atrAt(flat, 15), 2);
  assert.equal(atrAt(flat, 14), null);                                                    // not enough history
  const t = (rr, dist) => ({ entry: 100, tp: 100 + dist, rr });
  assert.equal(goldenRR('A+', t(15, 15), 2), true);                                        // 15R, target 7.5 ATR away
  assert.equal(goldenRR('A+', t(15, 25), 2), false);                                       // target 12.5 ATR away: out of reach
  assert.equal(goldenRR('A+', t(25, 15), 2), false);                                       // 20R and up: no
  assert.equal(goldenRR('A+', t(8, 15), 2), false);                                        // under 10R: no
  assert.equal(goldenRR('B', t(15, 15), 2), false);                                        // A grades (and S) only
  assert.equal(goldenRR('S+', t(15, 15), 2), true);
});

test('fullSweep: the signal wick clears the swing candle’s own wick at the furthest level', async () => {
  const { fullSweep } = await import('../public/sfp.js');
  const candles = new Map([[1, { t: 1, o: 100, h: 104, l: 99, c: 102 }], [2, { t: 2, o: 101, h: 103, l: 98, c: 102 }]]);
  const at = t => candles.get(t);
  const short = { side: 'Short', high: 104.5, low: 99, levels: [{ price: 102, t: 1 }, { price: 101.5, t: 2 }] };
  assert.equal(fullSweep(short, at), true);                                                   // 104.5 > 104 (the furthest level's swing wick)
  assert.equal(fullSweep({ ...short, high: 103.5 }, at), false);                              // past the body (102), not the wick
  const long = { side: 'Long', high: 103, low: 97.5, levels: [{ price: 101, t: 2 }] };
  assert.equal(fullSweep(long, at), true);
  assert.equal(fullSweep({ ...long, low: 98.5 }, at), false);
});

test('far target: at +7R the position hint says lock +3R, then +3R locked', async () => {
  const { positionNotes } = await import('../public/day-playbook.js');
  const plan = { entry: 100, sl: 99, tp: 120 };
  const text = mark => positionNotes({ dir: 'Long', entry: 100, sl: 100, mark }, { plan, price: v => String(v) }).map(n => n.text).join('|');
  assert.match(text(108), /Far target \(20R\), past \+7R: lock \+3R, stop to 103/);
  assert.doesNotMatch(text(105), /Far target/);
  assert.match(positionNotes({ dir: 'Long', entry: 100, sl: 103, mark: 108 }, { plan }).map(n => n.text).join('|'), /\+3R locked/);
});

test('the backtest locks +3R on a far target once +7R is reached', async () => {
  const { walkSingle, scaledResult } = await import('../public/sfp.js');
  const c = (t, o, h, l, cl) => ({ t, o, h, l, c: cl });
  const candles = [c(0, 100, 100, 99, 100), c(1, 100, 107.5, 100, 107), c(2, 107, 107, 102.5, 103)];
  const far = { entry: 100, sl: 99, tp: 120 }, near = { entry: 100, sl: 99, tp: 110 };
  assert.deepEqual(walkSingle(candles, 1, far, false), { result: 'lock', R: 3, exitT: 2 });       // reached +7.5R, came back to 102.5
  assert.equal(walkSingle(candles, 1, near, false), null);                                          // a 10R target: no lock, still open
  const sc = scaledResult(candles, 0, { ...far, rr: 20, riskPct: 0.01 }, false);
  assert.equal(sc.result, 'lock');
  assert.ok(sc.R > 3);                                                                              // with both adds in, more than the first entry's +3R
});

test('whaleAbsorption: retail panic absorbed = 🐋, our side paying heavy funding = ⚠️ crowded', async () => {
  const { whaleAbsorption, H4: h4 } = await import('../public/sfp.js');
  const t = 400 * h4, H8 = 8 * 3_600_000;
  // 30 days of ordinary taker flow (half the volume is taker buys), then the signal candle
  const taker = Array.from({ length: 200 }, (_, i) => ({ t: t - (200 - i) * h4, vol: 100, buy: 50 + (i % 5) }));
  const fund = rate => [{ t: t - H8, rate }, { t: t + h4 - 1, rate }];
  // a long: shorts pay (negative funding) and the candle's market orders were 80% sells, yet it closed inside
  const dump = [...taker, { t, vol: 100, buy: 20 }];
  assert.equal(whaleAbsorption('Long', t, { funding: fund(-0.0002), taker: dump })?.kind, 'absorbed');
  // the same flow without the panic: no tag
  assert.equal(whaleAbsorption('Long', t, { funding: fund(0.00005), taker: dump }), null);
  // panic, but ordinary taker flow: no tag
  assert.equal(whaleAbsorption('Long', t, { funding: fund(-0.0002), taker: [...taker, { t, vol: 100, buy: 52 }] }), null);
  // longs paying heavily for a long: crowded, whatever the flow
  assert.equal(whaleAbsorption('Long', t, { funding: fund(0.0003), taker: dump })?.kind, 'crowded');
  // a short reads it mirrored: longs paying = the crowd against the short; 80% taker buys = absorbed
  assert.equal(whaleAbsorption('Short', t, { funding: fund(0.0002), taker: [...taker, { t, vol: 100, buy: 80 }] })?.kind, 'absorbed');
  // 4h funding is scaled to 8h: −0.00004 every 4h = −0.00008 per 8h, past the panic line
  const f4 = [{ t, rate: -0.00004 }, { t: t + h4, rate: -0.00004 }];
  assert.equal(whaleAbsorption('Long', t, { funding: f4, taker: dump })?.kind, 'absorbed');
  // no data, no tag
  assert.equal(whaleAbsorption('Long', t, {}), null);
});

test('projected win rate: the grade sets the base, a tag that wins more lifts it, small samples barely move it', async () => {
  const { winModel, projectWin } = await import('../public/sfp.js');
  const sig = (g, extra = {}, won = false, i = 0) => ({ t: i, grade: { grade: g }, full: false, trend: 'neutral', ...extra, won });
  const list = [];
  for (let i = 0; i < 200; i++) list.push(sig('A', {}, i % 4 === 0, i));                 // A: 25%
  for (let i = 0; i < 200; i++) list.push(sig('C', {}, i % 10 === 0, i));                // C: 10%
  for (let i = 0; i < 100; i++) list.push(sig('A', { full: true }, i % 2 === 0, i));     // A + 💥: 50%
  for (let i = 0; i < 3; i++) list.push(sig('C', { goldenRR: true }, true, i));         // 3 lucky ⭐: too few to trust
  const m = winModel(list, s => s.won);
  const a = projectWin(sig('A'), m).p, c = projectWin(sig('C'), m).p, af = projectWin(sig('A', { full: true }), m);
  assert.ok(a > c, 'A above C');
  assert.ok(af.p > a + 0.05, 'the full sweep lifts an A');
  assert.equal(af.combo.n, 100);
  assert.ok(projectWin(sig('C', { goldenRR: true }), m).p < 0.25, 'three wins don’t make a 100% tag');
  assert.equal(winModel(list.slice(0, 10), s => s.won), null);
});

test('🪜 ladder: five limits 70–90% back, each a fifth of the risk; a rung that never fills adds 0R', async () => {
  const { ladderTrade, candleShape, LADDER } = await import('../public/sfp.js');
  const h = 4 * 3_600_000;
  // a long whose signal candle closed green near its high (100 → 110, low 98): rungs at 101.6 … 99.2, stop 98, target 120
  const c = [{ t: 0, o: 105, h: 106, l: 99, c: 100 }, { t: h, o: 100, h: 110, l: 98, c: 109 }];
  const sh = candleShape(c[0], c[1], 'Long');
  assert.equal(sh.ladder.length, LADDER.length);
  assert.ok(Math.abs(sh.ladder[0] - (110 - 0.7 * 12)) < 1e-9 && Math.abs(sh.ladder[4] - (110 - 0.9 * 12)) < 1e-9);
  const trade = { entry: 109, sl: 98, tp: 120, rr: 1, riskPct: 0.1 };
  // price dips to 100.5: the 101.6 and 101.0 rungs fill, 100.4 and deeper don't; then it runs to the target
  // (then the trail: the stop to that candle's low, 103, then 118, hit at 118)
  const after = [...c, { t: 2 * h, o: 109, h: 109, l: 100.5, c: 104 }, { t: 3 * h, o: 104, h: 121, l: 103, c: 120 }, { t: 4 * h, o: 120, h: 125, l: 118, c: 124 }, { t: 5 * h, o: 124, h: 124, l: 115, c: 116 }];
  const lt = ladderTrade(after, 1, trade, false, sh.ladder);
  assert.equal(lt.ladder.filled.length, 2);                                  // 101.6 and 101.0 filled, 100.4 and below didn't
  assert.equal(lt.trail, true); assert.equal(lt.scaled.trail, true);
  const rungR = px => (118 - px) / (px - 98);
  assert.ok(Math.abs(lt.R - 0.2 * (rungR(sh.ladder[0]) + rungR(sh.ladder[1]))) < 1e-9);
  assert.equal(lt.result, 'win');
  // no fill at all: missed
  const run = [...c, { t: 2 * h, o: 109, h: 121, l: 108, c: 120 }];
  assert.equal(ladderTrade(run, 1, trade, false, sh.ladder).missed, 'ran');
});

test('monitoring: the forming candle against the levels it could sweep (near, swept, beyond)', async () => {
  const { nearLevels, signalsIf, H4, ALERT_SETTINGS } = await import('../public/sfp.js');
  const rows = Array.from({ length: 50 }, (_, i) => (i === 40 ? [100, 109, 99, 108] : [100, 103, 97, 100]));
  const hist = rows.map(([o, h, l, c], i) => ({ t: i * H4, o, h, l, c }));            // a swing high at 108 (its body)
  const at = c => nearLevels(hist, { t: 50 * H4, ...c });
  const near = at({ o: 100, h: 107, l: 99, c: 106 });
  assert.deepEqual(near.map(x => [x.side, x.price, x.state]), [['Short', 108, 'near']]);
  assert.ok(near[0].toGo > 0.01 && near[0].toGo < 0.011);                           // 107 → past 108.108
  const swept = { o: 100, h: 109, l: 99, c: 107 };
  assert.equal(at(swept)[0].state, 'swept');
  assert.equal(signalsIf(hist, { t: 50 * H4, ...swept }, ALERT_SETTINGS).length, 1, 'swept and back inside is exactly what signals');
  assert.equal(at({ o: 100, h: 109, l: 99, c: 108.5 })[0].state, 'beyond');
  assert.equal(signalsIf(hist, { t: 50 * H4, o: 100, h: 109, l: 99, c: 108.5 }, ALERT_SETTINGS).length, 0);
});

test('🪜 the ladder entry: every closed-away candle, and A+ / A++ / B / C when BTC’s RSI already ran', async () => {
  const { ladderWhy } = await import('../public/sfp.js');
  const at = { away: false, ladder: [1, 2, 3, 4, 5] }, away = { away: true, ladder: [1, 2, 3, 4, 5] };
  assert.equal(ladderWhy('A', null, away), 'away');
  for (const g of ['A+', 'A++', 'B', 'C']) assert.equal(ladderWhy(g, 'chase', at), 'chase', g);
  for (const g of ['A', 'S', 'S+', 'S++', 'B+']) assert.equal(ladderWhy(g, 'chase', at), null, g);
  assert.equal(ladderWhy('A+', 'cool', at), null);
  assert.equal(ladderWhy('A+', 'chase', null), null);
});
