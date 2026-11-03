import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bySession, sessionOf, openGrid, openWindows, holdOutcome, costBreakdown, byHour } from '../public/metrics.js';

const MIN = 60_000, HOUR = 60 * MIN;
const utc = (h, m = 0, day = 5) => Date.UTC(2026, 9, day, h, m);
const trade = (o = {}) => ({ symbol: 'BTCUSDT', time: utc(10), openedAt: null, duration: null, pnl: 0, gross: 0, fees: 0, funding: 0, notional: 1000, ...o });

test('sessions: every UTC hour lands in exactly one session', () => {
  assert.equal(sessionOf(utc(3)).key, 'asia');
  assert.equal(sessionOf(utc(7)).key, 'london');
  assert.equal(sessionOf(utc(13, 30)).key, 'overlap');
  assert.equal(sessionOf(utc(20, 59)).key, 'ny');
  assert.equal(sessionOf(utc(23)).key, 'quiet');
});

test('sessions by open time leave out trades whose open is unknown', () => {
  const ts = [
    trade({ openedAt: utc(2), time: utc(9), pnl: 50 }),    // opened in Asia, closed in London
    trade({ openedAt: null, time: utc(14), pnl: -20 }),     // open unknown
  ];
  const open = bySession(ts, t => t.openedAt), close = bySession(ts);
  assert.equal(open.find(x => x.key === 'asia').net, 50);
  assert.equal(open.reduce((n, x) => n + x.n, 0), 1);
  assert.equal(close.find(x => x.key === 'london').net, 50);
  assert.equal(close.find(x => x.key === 'overlap').net, -20);
});

test('hour of day can count by open or close', () => {
  const t = trade({ openedAt: new Date(2026, 9, 5, 3).getTime(), time: new Date(2026, 9, 5, 11).getTime(), pnl: 10 });
  assert.equal(byHour([t], x => x.openedAt)[3].net, 10);
  assert.equal(byHour([t])[11].net, 10);
});

test('open grid and windows: weekday × hour of the open, thin windows ignored', () => {
  const mon9 = new Date(2026, 9, 5, 9, 15).getTime();     // a Monday, local time
  const ts = [
    ...[30, 20, -5].map(pnl => trade({ openedAt: mon9, pnl })),
    trade({ openedAt: mon9 + 3 * HOUR, pnl: -100 }),          // only one trade: not a window
  ];
  const g = openGrid(ts);
  assert.equal(g[0][9].n, 3);
  assert.equal(g[0][9].net, 45);
  const w = openWindows(ts);
  assert.equal(w.best.length, 1);
  assert.deepEqual([w.best[0].d, w.best[0].h, w.best[0].n], [0, 8, 3]);
  assert.equal(w.worst.length, 0);
});

test('hold time: buckets, best average hold, and averages for winners and losers', () => {
  const ts = [
    ...Array.from({ length: 4 }, () => trade({ duration: 30_000, pnl: -10 })),         // < 1m, losing
    ...Array.from({ length: 4 }, () => trade({ duration: 2 * HOUR, pnl: 25 })),        // 1–4h, best
    ...Array.from({ length: 4 }, () => trade({ duration: 20 * MIN, pnl: 5 })),         // 15m–1h
    trade({ duration: 2 * 86_400_000, pnl: 500 }),                                      // one big outlier, too few
    trade({ duration: null, pnl: 1 }),
  ];
  const h = holdOutcome(ts);
  assert.equal(h.known, 13);
  assert.equal(h.unknown, 1);
  assert.equal(h.best.label, '1–4h');
  assert.equal(h.best.expectancy, 25);
  assert.equal(h.buckets.find(b => b.label === '< 1m').net, -40);
  assert.equal(h.avgLoss, 30_000);
});

test('hold time: no best when nothing with enough trades is profitable', () => {
  const ts = Array.from({ length: 5 }, () => trade({ duration: 5 * MIN + 1, pnl: -1 }));
  assert.equal(holdOutcome(ts).best, null);
});

test('costs: fees, funding paid and received, and wins erased by costs', () => {
  const ts = [
    trade({ gross: 100, fees: 6, funding: 4, pnl: 90 }),
    trade({ gross: 5, fees: 6, funding: 0, pnl: -1, symbol: 'ETHUSDT' }),    // won on price, lost after fees
    trade({ gross: -50, fees: 2, funding: -3, pnl: -49 }),                   // received funding
    trade({ gross: 10, fees: 1, funding: null, pnl: 9 }),
  ];
  const c = costBreakdown(ts);
  assert.equal(c.fees, 15);
  assert.equal(c.fundingPaid, 4);
  assert.equal(c.fundingReceived, 3);
  assert.equal(c.cost, 16);
  assert.equal(c.flipped, 1);
  assert.equal(c.flippedCost, 6);
  assert.equal(c.costShare, 16 / 115);
  assert.equal(c.markets.find(m => m.key === 'ETHUSDT').fees, 6);
  assert.equal(c.months.length, 1);
});
