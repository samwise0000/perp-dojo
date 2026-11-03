import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, nySessions, currentBias, NY_HOURS } from '../public/bias.js';

const M15 = 15 * 60_000;
// 15m candles from `from` for `n` candles, each moving by step(i)
function candles(from, n, step = () => 1, start = 100) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) { const o = p; p += step(i); out.push({ t: from + i * M15, o, h: Math.max(o, p) + 0.5, l: Math.min(o, p) - 0.5, c: p }); }
  return out;
}

test('NY wall-clock times follow daylight saving', () => {
  assert.equal(new Date(zonedToUtc(2026, 7, 15, 8, 0)).toISOString(), '2026-07-15T12:00:00.000Z');   // EDT
  assert.equal(new Date(zonedToUtc(2026, 12, 15, 8, 0)).toISOString(), '2026-12-15T13:00:00.000Z');  // EST
  assert.equal(new Date(zonedToUtc(2026, 11, 2, 17, 0)).toISOString(), '2026-11-02T22:00:00.000Z');  // day after DST ends
});

test('bias is the last finished session: close above open is bullish', () => {
  // Thu Nov 5 2026: 08:00 ET = 13:00 UTC. Candles from Wed 00:00 UTC to Thu 23:00 UTC.
  const from = Date.UTC(2026, 10, 4, 0, 0);
  const cs = candles(from, 48 * 4, i => (i < 96 ? 1 : -1));     // up all Wednesday, down all Thursday
  const now = Date.UTC(2026, 10, 5, 23, 0);
  const s = nySessions(cs, { now, days: 2 });
  assert.deepEqual(s.map(x => [x.date, x.bias, x.live]), [['2026-11-05', 'bearish', false], ['2026-11-04', 'bullish', false]]);
  assert.equal(currentBias(s).date, '2026-11-05');
  assert.equal(s[0].open, cs.find(c => c.t === Date.UTC(2026, 10, 5, 13)).o);
  assert.equal(s[0].close, cs.find(c => c.t === Date.UTC(2026, 10, 5, 21, 45)).c);
});

test('a session in progress is live and does not set the bias', () => {
  const from = Date.UTC(2026, 10, 4, 0, 0);
  const cs = candles(from, 40 * 4, i => (i < 96 ? 1 : -1));
  const now = Date.UTC(2026, 10, 5, 15, 7);                     // 10:07 ET Thursday
  const s = nySessions(cs.filter(c => c.t < now), { now, days: 2 });
  assert.equal(s[0].live, true);
  assert.equal(s[0].upTo, Date.UTC(2026, 10, 5, 15, 0));        // only closed candles count
  assert.equal(currentBias(s).date, '2026-11-04');
});

test('weekends are skipped, so Monday morning uses Friday', () => {
  const from = Date.UTC(2026, 10, 6, 0, 0);                     // Fri Nov 6
  const cs = candles(from, 4 * 24 * 4, i => (i % 2 ? 1 : -0.5));
  const now = Date.UTC(2026, 10, 9, 11, 0);                     // Mon 06:00 ET, before the open
  const s = nySessions(cs, { now, days: 1 });
  assert.equal(s[0].date, '2026-11-06');
  assert.equal(s[0].bias, 'bullish');
});

test('stock-market hours start at 9:30', () => {
  const from = Date.UTC(2026, 10, 5, 0, 0);
  const cs = candles(from, 24 * 4);
  const s = nySessions(cs, { now: Date.UTC(2026, 10, 5, 23), days: 1, hours: NY_HOURS.stocks });
  assert.equal(s[0].start, Date.UTC(2026, 10, 5, 14, 30));
  assert.equal(s[0].end, Date.UTC(2026, 10, 5, 21, 0));
});
