import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagStats, tagKind, dayRecap } from '../public/metrics.js';

const MIN = 60_000, HOUR = 60 * MIN;
const day = new Date(2026, 10, 2).getTime();            // a Monday, local time
const trade = (o = {}) => ({ symbol: 'BTCUSDT', time: day + 10 * HOUR, openedAt: day + 9 * HOUR, duration: HOUR, pnl: 0, gross: 0, fees: 1, funding: 0, ...o });

test('tags: kinds, and a trade with two tags counts in both', () => {
  assert.equal(tagKind('FOMO'), 'mistake');
  assert.equal(tagKind('Followed plan'), 'good');
  assert.equal(tagKind('Breakout'), 'custom');
  const a = trade({ id: 'a', pnl: -30 }), b = trade({ id: 'b', pnl: 10 });
  const tags = { a: ['FOMO', 'Oversized'], b: ['FOMO'] };
  const rows = tagStats([a, b], t => tags[t.id] || []);
  assert.equal(rows.find(r => r.key === 'FOMO').n, 2);
  assert.equal(rows.find(r => r.key === 'FOMO').net, -20);
  assert.equal(rows[0].key, 'Oversized');          // worst first
});

test('recap: overtrading, revenge and mistake tags become rules and suggestions', () => {
  const ts = [
    trade({ id: 1, time: day + 9 * HOUR, openedAt: day + 8 * HOUR, pnl: -50 }),
    trade({ id: 2, time: day + 10 * HOUR, openedAt: day + 9 * HOUR + 5 * MIN, pnl: -40 }),   // 5 min after a loss
    trade({ id: 3, time: day + 12 * HOUR, openedAt: day + 11 * HOUR, pnl: 20 }),               // third trade
  ];
  const tags = { 2: ['Revenge'] };
  const r = dayRecap(ts, day, { tagsOf: t => tags[t.id] || [], fmt: v => v.toFixed(0), fmtDur: v => `${v / MIN}m` });
  assert.equal(r.s.n, 3);
  assert.equal(r.rules.find(x => x.key === 'trades').ok, false);
  assert.equal(r.rules.find(x => x.key === 'revenge').ok, false);
  assert.equal(r.rules.find(x => x.key === 'loss').ok, null);          // no balance known
  assert.match(r.suggestions[0], /3 trades against your limit of 2/);
  assert.ok(r.suggestions.some(x => /tagged 1 trade "Revenge"/.test(x)));
  assert.ok(r.suggestions.length <= 4);
  assert.equal(r.worst.pnl, -50);
  assert.equal(r.best.pnl, 20);
});

test('recap: a clean green day says to keep the same process', () => {
  const ts = [trade({ id: 1, pnl: 40, gross: 41 })];
  const r = dayRecap(ts, day, { tagsOf: () => ['Followed plan'], checkinDone: true, journaled: true, equity: 10_000, fmt: String });
  assert.ok(r.rules.every(x => x.ok));
  assert.match(r.suggestions.at(-1), /Same process today/);
});

test('recap: the daily loss limit, from your balance', () => {
  const r = dayRecap([trade({ pnl: -500 })], day, { equity: 10_000, fmt: String });
  assert.equal(r.rules.find(x => x.key === 'loss').ok, false);
  assert.match(r.suggestions[0], /hit your 4% daily loss limit/);
});

test('recap: costs are measured against winning moves before costs', () => {
  const r = dayRecap([trade({ pnl: 5, gross: 15, fees: 10 })], day, { fmt: String });
  assert.ok(r.suggestions.some(x => /took 67% of what your winning moves made/.test(x)));
});
