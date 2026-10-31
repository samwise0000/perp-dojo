import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, normalizeAll } from '../public/trades.js';
import { summarize, periodPnl, histogram, groupStats } from '../public/metrics.js';
import { makeTrades, makeFills } from './mock-bybit.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('linear long: price P&L, fees and derived funding', () => {
  const t = normalize({
    symbol: 'BTCUSDT', orderId: 'a', side: 'Sell', closedSize: '0.1', cumEntryValue: '6000', cumExitValue: '6100',
    avgEntryPrice: '60000', avgExitPrice: '61000', openFee: '3.3', closeFee: '3.355', closedPnl: '92.345', leverage: '10', updatedTime: '1',
  }, 'linear');
  assert.equal(t.dir, 'Long');
  close(t.gross, 100);
  close(t.fees, 6.655);
  close(t.funding, 1);          // 100 − 6.655 − 92.345
  close(t.margin, 600);
});

test('linear short profits when price falls', () => {
  const t = normalize({ symbol: 'ETHUSDT', orderId: 'b', side: 'Buy', closedSize: '1', cumEntryValue: '3000', cumExitValue: '2900',
    avgEntryPrice: '3000', avgExitPrice: '2900', openFee: '0', closeFee: '0', closedPnl: '100', leverage: '5', updatedTime: '1' }, 'linear');
  assert.equal(t.dir, 'Short');
  close(t.gross, 100);
  close(t.funding, 0);
});

test('inverse long converts coin P&L to USD at exit', () => {
  // 1000 contracts long BTCUSD from 50k to 55k: 0.02 − 0.0181818 BTC
  const entryV = 1000 / 50000, exitV = 1000 / 55000;
  const t = normalize({ symbol: 'BTCUSD', orderId: 'c', side: 'Sell', closedSize: '1000', cumEntryValue: String(entryV), cumExitValue: String(exitV),
    avgEntryPrice: '50000', avgExitPrice: '55000', openFee: '0', closeFee: '0', closedPnl: String(entryV - exitV), leverage: '2', updatedTime: '1' }, 'inverse');
  assert.equal(t.coin, 'BTC');
  close(t.pnl, (entryV - exitV) * 55000);
  close(t.funding, 0);
  assert.equal(t.notional, 1000);
});

test('records without fee fields put all costs in fees and leave funding unknown', () => {
  const t = normalize({ symbol: 'BTCUSDT', orderId: 'd', side: 'Sell', closedSize: '1', cumEntryValue: '100', cumExitValue: '110',
    avgEntryPrice: '100', avgExitPrice: '110', closedPnl: '9', leverage: '1', updatedTime: '1' }, 'linear');
  close(t.fees, 1);
  assert.equal(t.funding, null);
});

test('synthetic history: side reading is not flipped and funding stays small', () => {
  const raw = Object.fromEntries(makeTrades({ count: 200 }).map(r => [r.orderId, { r, category: r.category }]));
  const { trades, flipSides } = normalizeAll(raw);
  assert.equal(flipSides, false);
  for (const t of trades) assert.ok(Math.abs(t.funding) <= Math.abs(t.notional) * 0.001 + 1e-6, `${t.symbol} funding ${t.funding}`);
});

test('side reading flips when Bybit means the opposite', () => {
  const raw = Object.fromEntries(makeTrades({ count: 200 }).map(r => [r.orderId, { r: { ...r, side: r.side === 'Sell' ? 'Buy' : 'Sell' }, category: r.category }]));
  assert.equal(normalizeAll(raw).flipSides, true);
});

test('summary: win rate, profit factor, drawdown and streaks', () => {
  const pnl = [100, -50, -30, 200, -10, -20, -40, 60];
  const trades = pnl.map((p, i) => ({ pnl: p, gross: p, fees: 1, funding: 0, notional: 1000, margin: 100, leverage: 10, time: i * 1000, symbol: 'X', dir: 'Long' }));
  const s = summarize(trades);
  assert.equal(s.n, 8);
  close(s.net, 210);
  close(s.winRate, 3 / 8);
  close(s.profitFactor, 360 / 150);
  close(s.maxDrawdown, -80);           // peak 100 after trade 1, trough 20 after trade 3 (deeper than 220 → 150)
  assert.equal(s.maxLossStreak, 3);
  close(s.maxLossStreakPnl, -70);
  assert.equal(s.maxWinStreak, 1);
  assert.equal(s.currentStreak, 1);
});

test('period buckets fill empty days and pick coarser units for long spans', () => {
  const day = 86_400_000, t0 = new Date(2026, 0, 5, 12).getTime();
  const trades = [{ time: t0, pnl: 5 }, { time: t0 + 3 * day, pnl: -2 }];
  const p = periodPnl(trades, t0, t0 + 3 * day);
  assert.equal(p.unit, 'day');
  assert.equal(p.buckets.length, 4);
  assert.deepEqual(p.buckets.map(b => b.net), [5, 0, 0, -2]);
  assert.equal(periodPnl(trades, t0 - 200 * day, t0).unit, 'week');
  assert.equal(periodPnl(trades, t0 - 700 * day, t0).unit, 'month');
});

test('histogram keeps zero on a bin edge and counts every trimmed trade', () => {
  const trades = Array.from({ length: 300 }, (_, i) => ({ pnl: (i % 61) - 30 + 0.5 }));
  const h = histogram(trades);
  assert.ok(h.some(b => Math.abs(b.from) < 1e-9 || Math.abs(b.to) < 1e-9));
  assert.equal(h.reduce((n, b) => n + b.n, 0), 300);
});

test('groupStats', () => {
  const g = groupStats([{ symbol: 'A', pnl: 2, fees: 0, notional: 1 }, { symbol: 'A', pnl: -1, fees: 0, notional: 1 }, { symbol: 'B', pnl: 3, fees: 0, notional: 1 }], t => t.symbol);
  const a = g.find(x => x.key === 'A');
  assert.equal(a.n, 2);
  close(a.winRate, 0.5);
  close(a.profitFactor, 2);
});

import { addCovered, pull, emptyCache } from '../public/sync.js';
import { dailyMap, dayStreaks, calendarMonth, tradingScore } from '../public/metrics.js';

test('covered spans merge when they touch or overlap', () => {
  let c = addCovered([], 10, 20);
  c = addCovered(c, 30, 40);
  assert.deepEqual(c, [[10, 20], [30, 40]]);
  c = addCovered(c, 21, 29);
  assert.deepEqual(c, [[10, 40]]);
  assert.deepEqual(addCovered(c, 5, 12), [[5, 40]]);
});

test('day streaks skip days without trades', () => {
  const at = (y, m, d, pnl) => ({ time: new Date(y, m, d, 12).getTime(), pnl });
  const daily = dailyMap([at(2026, 0, 5, 10), at(2026, 0, 6, 5), at(2026, 0, 9, 3), at(2026, 0, 12, -4), at(2026, 0, 12, 1)]);
  const s = dayStreaks(daily);
  assert.equal(s.bestWin, 3);       // 5th, 6th, 9th
  assert.equal(s.current, -1);      // the 12th nets −3
  assert.equal(s.green, 3);
});

test('calendar month: Monday-first weeks covering the whole month', () => {
  const daily = dailyMap([{ time: new Date(2026, 0, 1, 9).getTime(), pnl: 7 }, { time: new Date(2025, 11, 31, 9).getTime(), pnl: 100 }]);
  const m = calendarMonth(daily, 2026, 0);    // January 2026 starts on a Thursday
  assert.equal(m.weeks[0].days[0].key, '2025-12-29');
  assert.equal(m.weeks[m.weeks.length - 1].days[6].key, '2026-02-01');
  assert.equal(m.weeks.length, 5);
  assert.equal(m.n, 1);              // Dec 31 is shown but not counted in January
  close(m.net, 7);
  close(m.weeks[0].net, 107);        // the week total includes every day in its row
});

test('trading score stays within 0–100 and needs 10 trades', () => {
  const t = (p, i) => ({ pnl: p, gross: p, fees: 0, funding: 0, notional: 1, margin: 1, leverage: 1, time: i * DAY_MS, symbol: 'X', dir: 'Long' });
  const DAY_MS = 86_400_000;
  const few = Array.from({ length: 5 }, (_, i) => t(1, i));
  assert.equal(tradingScore(summarize(few), dayStreaks(dailyMap(few))), null);
  const many = Array.from({ length: 30 }, (_, i) => t(i % 3 ? 10 : -12, i));
  const sc = tradingScore(summarize(many), dayStreaks(dailyMap(many)));
  for (const a of sc.axes) assert.ok(a.value >= 0 && a.value <= 100, a.key);
  assert.ok(sc.score > 0 && sc.score < 100);
});

import { startMock, MOCK_KEY, MOCK_SECRET } from './mock-bybit.mjs';
import { createClient } from '../lib/bybit.mjs';

// fetchWindow the way /api/pull answers it, but straight from the mock
const windowFetcher = client => async ({ category, start, end, fillsOnly }) => ({
  uid: 123456,
  rows: fillsOnly ? [] : await client.getAll('/v5/position/closed-pnl', { category, startTime: start, endTime: end, limit: 100 }),
  fills: (await client.getAll('/v5/execution/list', { category, startTime: start, endTime: end, limit: 100 }))
    .map(f => ({ id: f.execId, c: category, s: f.symbol, side: f.side, q: +f.execQty, cs: +f.closedSize, t: +f.execTime, o: f.orderId })),
});

test('pulling: replace keeps only the days asked for, refresh merges, a failure leaves the cache alone', async () => {
  const now = Date.now(), D = 86_400_000;
  const { server } = await startMock({ port: 9997, trades: makeTrades({ days: 120, count: 240, now }) });
  const client = createClient({ key: MOCK_KEY, secret: MOCK_SECRET, base: 'http://127.0.0.1:9997' });
  try {
    const wide = (await pull(null, { from: now - 100 * D, to: now, replace: true, now }, { fetchWindow: windowFetcher(client) })).cache;
    const n = Object.keys(wide.raw).length;
    assert.ok(n > 150);
    assert.ok(Object.keys(wide.execs).length >= n);            // fills came along

    const r = await pull(wide, { from: now - 20 * D, to: now - 10 * D, replace: true, now }, { fetchWindow: windowFetcher(client) });
    const times = Object.values(r.cache.raw).map(x => +x.r.updatedTime);
    assert.ok(r.total > 0 && r.total < n);
    assert.ok(times.every(t => t >= now - 20 * D && t <= now - 10 * D));
    assert.equal(Object.keys(wide.raw).length, n, 'the input cache is never modified');

    const merged = await pull(r.cache, { from: now - 40 * D, to: now - 30 * D, now }, { fetchWindow: windowFetcher(client) });
    assert.ok(merged.total > r.total);
    assert.equal(merged.cache.covered.length, 2);

    const broken = async () => { throw new Error('Bybit rejected the key'); };
    await assert.rejects(pull(r.cache, { from: now - 90 * D, to: now, replace: true, now }, { fetchWindow: broken }));
    assert.equal(Object.keys(r.cache.raw).length, r.total);
  } finally { server.close(); }
});

import { openTimes } from '../public/trades.js';
import { holdStats, fmtDuration } from '../public/metrics.js';

const fill = (t, side, q, cs, o, s = 'BTCUSDT') => ({ c: 'linear', s, side, q, cs, t, o });

test('open times: open, scale in, partial closes and a flip through zero', () => {
  const m = openTimes({
    a: fill(100, 'Buy', 1, 0, 'open1'),          // long 1 opens at 100
    b: fill(200, 'Buy', 1, 0, 'add1'),           // scale in to 2; still opened at 100
    c: fill(300, 'Sell', 1, 1, 'close1'),        // partial close → opened 100
    d: fill(400, 'Sell', 3, 1, 'flip'),          // closes the last 1 (opened 100) and opens short 2 at 400
    e: fill(500, 'Buy', 2, 2, 'close2'),         // closes the short → opened 400
  });
  assert.equal(m.get('close1'), 100);
  assert.equal(m.get('flip'), 100);
  assert.equal(m.get('close2'), 400);
  assert.equal(m.has('open1'), false);
});

test('open times: hedge mode keeps long and short books apart', () => {
  const m = openTimes({
    a: fill(100, 'Buy', 1, 0, 'L'),             // long opens
    b: fill(150, 'Sell', 1, 0, 'S'),            // short opens separately
    c: fill(300, 'Buy', 1, 1, 'closeS'),        // closes the short → 150
    d: fill(400, 'Sell', 1, 1, 'closeL'),       // closes the long → 100
  });
  assert.equal(m.get('closeS'), 150);
  assert.equal(m.get('closeL'), 100);
});

test('open times: a position opened before the data stays unknown', () => {
  const m = openTimes({ a: fill(100, 'Sell', 1, 1, 'early'), b: fill(200, 'Buy', 1, 0, 'o'), c: fill(300, 'Sell', 1, 1, 'late') });
  assert.equal(m.has('early'), false);
  assert.equal(m.get('late'), 200);
});

test('synthetic history: hold times rebuilt from mock fills', () => {
  const raw = makeTrades({ count: 60, days: 365 });
  const execs = Object.fromEntries(makeFills(raw).map((f, i) => [i, { c: f.category, s: f.symbol, side: f.side, q: +f.execQty, cs: +f.closedSize, t: +f.execTime, o: f.orderId }]));
  const { trades } = normalizeAll(Object.fromEntries(raw.map(r => [r.orderId, { r, category: r.category }])), execs);
  const hs = holdStats(trades);
  assert.ok(hs.known >= 50, `${hs.known} of 60 have a hold time`);
  for (const t of trades) if (t.duration !== null) assert.ok(t.duration > 0 && t.duration <= 3 * 86_400_000);
});

test('duration labels', () => {
  assert.equal(fmtDuration(45_000), '45s');
  assert.equal(fmtDuration(12 * 60_000), '12m');
  assert.equal(fmtDuration((3 * 60 + 20) * 60_000), '3h 20m');
  assert.equal(fmtDuration((2 * 24 + 4) * 3_600_000), '2d 4h');
});

import { warnings, WARN } from '../public/metrics.js';

test('warnings: overtrading, fees, streaks, revenge trades; critical first', () => {
  const now = Date.UTC(2026, 9, 31, 12), H = 3_600_000;
  const t = (hAgo, pnl, extra = {}) => ({ time: now - hAgo * H, pnl, gross: pnl, fees: 6, funding: 0, notional: 1000, margin: 100, leverage: 10, symbol: 'BTCUSDT', dir: 'Long', openedAt: null, ...extra });
  const recent = [
    t(200, 50), t(150, 40), t(100, 60),
    t(5, -20), t(3, -25, { openedAt: now - 5 * H + 5 * 60_000 }),   // opened 5 min after the previous loss
    t(1, -30),
  ];
  const s = summarize(recent), ds = dayStreaks(dailyMap(recent));
  const w = warnings({ recent, s, ds, now, fmt: v => `$${v.toFixed(0)}`, fmtAgo: () => 'just now' });
  const texts = w.map(x => x.text).join(' | ');
  assert.match(texts, /3 trades in the last 24 hours/);
  assert.match(texts, /opened within 15 min of a loss/);
  assert.match(texts, /3 losing trades in a row/);
  assert.match(texts, /Fees are \d+% of your winnings/);          // 36 fees / 150 won = 24%
  const firstWarning = w.findIndex(x => x.level === 'warning');
  assert.ok(w.slice(0, firstWarning).every(x => x.level === 'critical'));
  assert.ok(w.slice(firstWarning).every(x => x.level === 'warning'));
});

test('warnings: a quiet, profitable account gets none', () => {
  const now = Date.UTC(2026, 9, 31, 12), D = 86_400_000;
  const recent = [3, 6, 9, 12].map(d => ({ time: now - d * D, pnl: 100, gross: 101, fees: 1, funding: 0, notional: 1000, margin: 200, leverage: 5, symbol: 'ETHUSDT', dir: 'Long', openedAt: null }));
  const s = summarize(recent);
  assert.deepEqual(warnings({ recent, s, ds: dayStreaks(dailyMap(recent)), now, fmt: String, fmtAgo: String }), []);
  assert.equal(WARN.maxTradesPerDay, 2);
});
