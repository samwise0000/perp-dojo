import { test } from 'node:test';
import assert from 'node:assert/strict';
import { H4, M5, candleAt, signalsIf, holdLine } from '../public/sfp.js';
import { runAlerts, windowFor } from '../lib/sfp-alert.mjs';
import { chunks } from '../lib/telegram.mjs';

const OPTS = { left: 3, right: 3, minAge: 0, edge: 0, lookbackDays: 30, rangeDays: 7, breakOnClose: true, once: true, trendEma: 50, neutralBand: 0.01 };
const T0 = Date.UTC(2026, 9, 1);
// a swing high with a body top of 110 at index 3, confirmed by index 6
const history = [
  [100, 101, 99, 100], [100, 103, 99, 102], [102, 106, 101, 105], [105, 115, 104, 110],
  [109, 110, 103, 104], [104, 106, 100, 101], [101, 103, 98, 100],
].map(([o, h, l, c], i) => ({ t: T0 + i * H4, o, h, l, c }));
const START = T0 + 7 * H4, CLOSE = START + H4;

// The window's 48 5m candles: price drifts from 100 to `at` by the heads-up
// (wicking to `wick` on the way if given), then the last 5m candle ends at `last`.
function window5m({ at, wick, last, lastWick }) {
  const out = []; let p = 100;
  for (let i = 0; i < 48; i++) {
    const c = i === 47 ? last : 100 + (at - 100) * ((i + 1) / 47);
    const o = p;
    let h = Math.max(o, c) + 0.05, l = Math.min(o, c) - 0.05;
    if (wick && i === 30) h = wick;
    if (lastWick && i === 47) h = lastWick;
    out.push({ t: START + i * M5, o, h, l, c }); p = c;
  }
  return out;
}
const fetcher = parts => async (symbol, interval) => {
  if (interval === '5') return parts;
  if (symbol === 'BTCUSDT') return [];
  const whole = candleAt(parts, START, CLOSE);
  return [...history, whole];                     // Bybit includes the forming candle
};
const run = (phase, parts) => runAlerts({ phase, now: phase === 'pre' ? CLOSE - 4 * 60_000 : CLOSE + 30_000, pairs: ['AAVEUSDT'], opts: OPTS, fetchCandles: fetcher(parts) });

test('runs are about the right candle', () => {
  assert.deepEqual(windowFor('pre', CLOSE - 4 * 60_000), { start: START, close: CLOSE, cut: CLOSE - 5 * 60_000 });
  assert.deepEqual(windowFor('close', CLOSE + 30_000), { start: START, close: CLOSE, cut: CLOSE - 5 * 60_000 });
});

test('the 4h candle as it stood 5 minutes before the close', () => {
  const parts = window5m({ at: 108, wick: 111, last: 107 });
  const c = candleAt(parts, START, CLOSE - 5 * 60_000);
  assert.equal(c.h, 111);
  assert.equal(c.c, 108);
  assert.equal(c.o, 100);
  const sig = signalsIf(history, c, OPTS)[0];
  assert.equal(sig.side, 'Short');
  const { line, inside } = holdLine(sig);
  assert.equal(line, 110);
  assert.ok(Math.abs(inside - 2 / 110) < 1e-12);
});

test('heads-up, then confirmed', async () => {
  const parts = window5m({ at: 108, wick: 111, last: 107 });
  const pre = await run('pre', parts);
  assert.match(pre.message, /^<b>Swing Failures Spotted<\/b> 👀\n\n⏳ 4h close in 5m/);
  assert.match(pre.message, /🔴 <b>AAVE short<\/b>  108\n├ 🎯 110 · 1\.8% in\n(├ 🛑 .*\n)?└ BTC trend: unknown/);
  const post = await run('close', parts);
  assert.match(post.message, /✅ <b>AAVE short<\/b>  107/);
});

test('heads-up, then price closed back above the level: no signal', async () => {
  const parts = window5m({ at: 108, wick: 111, last: 112 });
  assert.match((await run('pre', parts)).message, /AAVE short/);
  assert.match((await run('close', parts)).message, /❌ <b>AAVE short<\/b>  112 · lost 🎯 110/);
});

test('a setup that only formed in the last 5 minutes', async () => {
  const parts = window5m({ at: 108, last: 108.5, lastWick: 111 });
  assert.equal((await run('pre', parts)).message, null);
  assert.match((await run('close', parts)).message, /🆕 <b>AAVE short<\/b>  108\.5\n├ 🎯 110 · late setup\n└ BTC trend/);
});

test('quiet candles send nothing', async () => {
  const parts = window5m({ at: 104, last: 105 });
  assert.equal((await run('pre', parts)).message, null);
  assert.equal((await run('close', parts)).message, null);
});

test('long messages split on line breaks', () => {
  const parts = chunks(Array.from({ length: 300 }, (_, i) => `line ${i} `.repeat(4)).join('\n'), 1000);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 1000));
  assert.equal(parts.join('\n').split('\n').length, 300);
});

test('a scheduled run picks its phase from the time, and skips stale ones', async () => {
  const { phaseAt } = await import('../lib/sfp-alert.mjs');
  const min = 60_000;
  assert.equal(phaseAt(CLOSE - 5 * min), 'pre');
  assert.equal(phaseAt(CLOSE - 5 * min + 40_000), 'pre');
  assert.equal(phaseAt(CLOSE + 20_000), 'close');
  assert.equal(phaseAt(CLOSE + 4 * min), 'close');
  assert.equal(phaseAt(CLOSE - 30_000), null);            // a heads-up 30s before the close is too late
  assert.equal(phaseAt(CLOSE + 6 * min), null);           // woke from sleep well after the close
  assert.equal(phaseAt(CLOSE - 2 * 3_600_000), null);     // mid-candle
});

test('each setup says whether it goes with or against BTC', async () => {
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const sig = side => ({ side, close: 100, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {} });
  const w = { close: CLOSE };
  const msg = (side, trend) => preMessage([{ symbol: 'ONDOUSDT', pre: [sig(side)] }], w, { trend });
  assert.match(msg('Long', { up: true, neutral: false }), /└ BTC trend: Aligned 👍/);
  assert.match(msg('Long', { up: false, neutral: false }), /└ BTC trend: Countertrend ⚠️/);
  assert.match(msg('Short', { up: false, neutral: false }), /└ BTC trend: Aligned 👍/);
  assert.match(msg('Short', { up: true, neutral: true }), /└ BTC trend: Neutral ➖/);
});

test('each heads-up setup gets a chart image', async () => {
  const { chartImages } = await import('../lib/sfp-alert.mjs');
  const out = await run('pre', window5m({ at: 108, wick: 111, last: 107 }));
  const imgs = await chartImages(out);
  assert.equal(imgs.length, 1);
  assert.deepEqual([...imgs[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);          // PNG
  assert.match(imgs[0].caption, /^🔴 <b>AAVE short<\/b>/);            // no opposing swing in this history, so no trade line
  assert.deepEqual(await chartImages(await run('pre', window5m({ at: 104, last: 105 }))), []);
});
