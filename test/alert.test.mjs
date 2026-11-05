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
  assert.match(pre.message, /🔴 <b>AAVE short<\/b>  108  ·  🥉 <b>C<\/b>\n├ 🎯 110 · 1\.8% in\n(├ 🛑 .*\n)?└ BTC trend: unknown/);
  const post = await run('close', parts);
  assert.match(post.message, /✅ <b>AAVE short<\/b>  107  ·  🥉 <b>C<\/b>/);
});

test('heads-up, then price closed back above the level: no signal', async () => {
  const parts = window5m({ at: 108, wick: 111, last: 112 });
  assert.match((await run('pre', parts)).message, /AAVE short/);
  assert.match((await run('close', parts)).message, /❌ <b>AAVE short<\/b>  112 · lost 🎯 110/);
});

test('a setup that only formed in the last 5 minutes', async () => {
  const parts = window5m({ at: 108, last: 108.5, lastWick: 111 });
  assert.match((await run('pre', parts)).message, /No setups/);
  assert.match((await run('close', parts)).message, /🆕 <b>AAVE short<\/b>  108\.5  ·  🥉 <b>C<\/b>\n├ 🎯 110 · late setup\n(├ 🛑 .*\n)?└ BTC trend/);
});

test('quiet candles send nothing', async () => {
  const parts = window5m({ at: 104, last: 105 });
  const pre = await run('pre', parts);
  assert.ok(pre.quiet);
  assert.match(pre.message, /^😴 <b>No setups<\/b> · 4h close .*\n1 pairs checked$/);
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
  assert.match(imgs[0].caption, /^🔴 <b>AAVE short<\/b>/);            
  assert.deepEqual(await chartImages(await run('pre', window5m({ at: 104, last: 105 }))), []);
});

test('each setup gets a grade with the reason', async () => {
  const { preMessage, closeMessage } = await import('../lib/sfp-alert.mjs');
  const { gradeSetup } = await import('../public/sfp.js');
  const bear = { bias: 'bearish', during: false };
  assert.equal(gradeSetup('Short', { ny: bear, swept: true }).grade, 'A++');
  assert.equal(gradeSetup('Short', { ny: bear, rsi: 66 }).grade, 'A+');                       // stretched, no sweep
  assert.equal(gradeSetup('Long', { ny: { bias: 'bullish', during: false }, rsi: 35 }).grade, 'A+');
  assert.equal(gradeSetup('Short', { ny: bear, rsi: 55 }).grade, 'A');                        // not stretched
  assert.equal(gradeSetup('Short', { ny: bear, swept: true, rsi: 70 }).grade, 'A++');         // the sweep outranks RSI
  assert.equal(gradeSetup('Short', { ny: bear }).grade, 'A');
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true }, swept: true }).grade, 'A');
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true }, swept: true }).tag, 'midnight');
  assert.equal(gradeSetup('Short', { ny: bear }).tag, undefined);
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true } }).grade, 'B');
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true }, rsi: 64 }).grade, 'A++');  // NY open + stretched: 🌃 Late A++
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true }, rsi: 64 }).tag, 'late');
  assert.equal(gradeSetup('Short', { ny: { ...bear, during: true }, rsi: 36 }).grade, 'B');    // stretched the wrong way
  assert.equal(gradeSetup('Long', { ny: { bias: 'bullish', during: true }, rsi: 33 }).grade, 'A++');
  assert.equal(gradeSetup('Long', { ny: { bias: 'bullish', during: true }, rsi: 33, fade: true }).grade, 'B+');   // …unless it fades the session
  assert.equal(gradeSetup('Short', { ny: bear, rsi: 80 }).grade, 'A+');                        // stretched lifts A too
  assert.equal(gradeSetup('Long', { ny: bear, fade: true }).grade, 'C++');                      // a C fading a violent NY session
  assert.equal(gradeSetup('Long', { fade: true }).grade, 'C++');
  assert.equal(gradeSetup('Short', { ny: bear, fade: true }).grade, 'A');                       // the fade only lifts C
  assert.equal(gradeSetup('Long', { ny: bear, swept: true }).grade, 'C');
  assert.equal(gradeSetup('Long', {}).grade, 'C');
  const sig = (side, close = 100) => ({ side, close, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {} });
  const w = { close: CLOSE };
  const res = [{ symbol: 'ONDOUSDT', pre: [sig('Short')], final: [sig('Short')], closed: { c: 100 } }, { symbol: 'AAVEUSDT', pre: [sig('Long', 50)], final: [], closed: { c: 50 } }];
  const pre = preMessage(res, w, { ny: bear, btcSweep: { pre: ['Short'] } });
  assert.match(pre, /ONDO short<\/b>  100  ·  🏆 <b>A\+\+<\/b>\n/);
  assert.match(pre, /BTC trend: unknown\n\n🟢 <b>AAVE long<\/b>  50  ·  🥉 <b>C<\/b>/);     // a blank line between setups
  assert.ok(pre.indexOf('ONDO') < pre.indexOf('AAVE'));                 // best grade first
  assert.match(closeMessage(res, w, { ny: { ...bear, during: true } }), /✅ <b>ONDO short<\/b>  100  ·  🥈 <b>B<\/b>\n/);
});

test('more than 2 takeable setups on one close: the 2 picks are marked', async () => {
  const { preMessage, closeMessage, picksOf } = await import('../lib/sfp-alert.mjs');
  const tz = 'Asia/Makassar', close = Date.UTC(2026, 10, 3, 4);           // Tue 12:00 in UTC+8, a main close
  const bear = { bias: 'bearish', during: false };
  const sig = (rr, side = 'Short') => ({ side, close: 100, line: 101, inside: 0.01, levels: [{ price: 101 }], range: {}, trade: { entry: 100, sl: 102, tp: 100 - 2 * rr, rr } });
  const a = sig(3), b = sig(8), c = sig(5), d = sig(9, 'Long');         // the long is a C (against the bias): not takeable
  const ctx = { ny: bear, btcSides: [] };
  const pk = picksOf([a, b, c, d], ctx, close, tz);
  assert.equal(pk.n, 3);
  assert.deepEqual([...pk.picks], [b, c]);                              // highest R:R first
  assert.equal(picksOf([a, b, d], ctx, close, tz).picks.size, 0);       // only 2 takeable: nothing to choose
  const pkA = picksOf([a, b, c], { ny: bear, btcSides: ['Short'] }, close, tz);   // all A+ now
  assert.equal(pkA.picks.size, 2);
  const res = ['AAVEUSDT', 'HYPEUSDT', 'SUIUSDT', 'ONDOUSDT'].map((symbol, i) => ({ symbol, pre: [[a, b, c, d][i]], final: [[a, b, c, d][i]], closed: { c: 100 } }));
  const w = { close };
  const pre = preMessage(res, w, { tz, ny: bear });
  assert.match(pre, /👉 3 setups you could take: the 2 picks are marked/);
  assert.match(pre, /HYPE short<\/b>  100  ·  🥇 <b>A<\/b>  ·  👉 <b>pick<\/b>/);
  assert.match(pre, /SUI short<\/b>  100  ·  🥇 <b>A<\/b>  ·  👉 <b>pick<\/b>/);
  assert.doesNotMatch(pre, /AAVE short<\/b>  100  ·  🥇 <b>A<\/b>  ·  👉/);
  assert.ok(pre.indexOf('HYPE') < pre.indexOf('AAVE'));                  // picks listed first within the grade
  assert.match(closeMessage(res, w, { tz, ny: bear }), /✅ <b>HYPE short<\/b>  100  ·  🥇 <b>A<\/b>  ·  👉 <b>pick<\/b>/);
  const fri = Date.UTC(2026, 10, 6, 16);                                 // Sat 00:00 in UTC+8: nothing takeable at a late weekend close
  assert.equal(picksOf([a, b, c], ctx, fri, tz).n, 0);
});

test('NY fade note at the close in the last 2 hours of the NY session', async () => {
  const { nyFadeAt, preMessage, closeMessage } = await import('../lib/sfp-alert.mjs');
  const M15 = 15 * 60_000, start = Date.UTC(2026, 10, 3, 13);           // 8 AM New York (EST)
  const path = (from, to, n = 28) => Array.from({ length: n }, (_, i) => { const a = from + (to - from) * i / n, b = from + (to - from) * (i + 1) / n; return { t: start + i * M15, o: a, c: b, h: Math.max(a, b) + 0.05, l: Math.min(a, b) - 0.05 }; });
  const close = Date.UTC(2026, 10, 3, 20);                               // 3 PM New York: 2h left
  const down = nyFadeAt(path(100, 97), close);
  assert.equal(down.dir, 'down'); assert.ok(Math.abs(down.move + 0.03) < 0.002);
  assert.equal(nyFadeAt(path(100, 97).slice(0, 12), Date.UTC(2026, 10, 3, 16)), null);   // mid-session close
  assert.equal(nyFadeAt(path(100, 99), close), null);                    // only −1%
  const bounced = [...path(100, 96, 20), ...path(96, 99, 8).map((c, i) => ({ ...c, t: start + (20 + i) * M15 }))];
  assert.equal(nyFadeAt(bounced, close), null);                          // −1% but well off the low
  assert.equal(nyFadeAt(path(100, 103), close).dir, 'up');
  const sig = side => ({ side, close: 100, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {}, trade: { entry: 100, sl: 99, tp: 104, rr: 4 } });
  const w = { close };
  const pre = preMessage([{ symbol: 'HYPEUSDT', pre: [sig('Long')] }, { symbol: 'SUIUSDT', pre: [sig('Short')] }], w, { fade: down });
  assert.match(pre, /🌊 BTC −3\.0% in today’s NY session and closing near its low\. Longs here fade it/);
  assert.match(pre, /HYPE long[^]*├ 🌊 NY fade\n├ 🛑/);
  const bear = { bias: 'bearish', during: true };                        // a long here is a C: the fade makes it C++
  assert.match(preMessage([{ symbol: 'HYPEUSDT', pre: [sig('Long')] }], w, { fade: down, ny: bear }), /HYPE long<\/b>  100  ·  🏅 <b>C\+\+<\/b>/);
  assert.match(preMessage([{ symbol: 'HYPEUSDT', pre: [sig('Long')] }], w, { fade: down, ny: bear }), /├ 🎯 C\+\+ targets: 2R 102 · 3R 103\n/);   // entry 100, stop 99
  assert.doesNotMatch(pre.split('SUI short')[1], /C\+\+ targets/);         // the short doesn't fade: no targets
  assert.doesNotMatch(pre.split('SUI short')[1], /🌊/);
  assert.doesNotMatch(preMessage([{ symbol: 'SUIUSDT', pre: [sig('Short')] }], w, { fade: down }), /🌊/);   // nothing fades it: no note
  const fin = closeMessage([{ symbol: 'HYPEUSDT', pre: [sig('Long')], final: [sig('Long')], closed: { c: 100 } }], w, { fade: down });
  assert.match(fin, /✅ <b>HYPE long[^]*├ 🌊 NY fade/);
});

test('🌙 Midnight sweep line at the 00:00 close', async () => {
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const tz = 'Asia/Makassar', bear = { bias: 'bearish', during: true };
  const sig = { side: 'Short', close: 100, line: 101, inside: 0.01, levels: [{ price: 101 }], range: {}, trade: { entry: 100, sl: 102, tp: 94, rr: 3 } };
  const msg = close => preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close }, { tz, ny: bear, btcSweep: { pre: ['Short'] } });
  assert.match(msg(Date.UTC(2026, 10, 3, 16)), /🥇 <b>A<\/b>[^]*├ 🌙 Midnight sweep: BTC swept with it mid-NY session/);   // Wed 00:00 UTC+8
  assert.doesNotMatch(msg(Date.UTC(2026, 10, 3, 20)), /Midnight sweep/);       // 04:00
  assert.match(msg(Date.UTC(2026, 10, 6, 16)), /🌙 Midnight sweep: BTC swept with it mid-NY session \(tracking, 0\.06%, trade cautiously\)/);   // Sat 00:00: Friday night, a quarter
  assert.match(msg(Date.UTC(2026, 10, 5, 16)), /├ 🌙 Midnight sweep: BTC swept with it mid-NY session \(tracking, 0\.06%, trade cautiously\)/);   // Fri 00:00: Thursday night, caution
});

test('⛔ a good grade at a close the plan skips', async () => {
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const tz = 'Asia/Makassar', bear = { bias: 'bearish', during: false };
  const sig = { side: 'Short', close: 100, line: 101, inside: 0.01, levels: [{ price: 101 }], range: {}, trade: { entry: 100, sl: 102, tp: 94, rr: 3 } };
  const msg = close => preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close }, { tz, ny: bear });
  assert.match(msg(Date.UTC(2026, 10, 3, 12)), /🥇 <b>A<\/b>[^]*├ ⛔ Wrong time/);     // Tue 20:00 UTC+8: an A, skipped
  assert.doesNotMatch(msg(Date.UTC(2026, 10, 3, 4)), /Wrong time/);                // Tue 12:00: a main close
  assert.doesNotMatch(msg(Date.UTC(2026, 10, 6, 4)), /Wrong time|Weekend/);   // Fri 12:00: a weak day, taken at half size
  assert.match(msg(Date.UTC(2026, 10, 7, 4)), /├ 📅 Weekend: not a plan trade, your call/);   // Sat 12:00: weekend, shown but your call
  assert.doesNotMatch(preMessage([{ symbol: 'HYPEUSDT', pre: [{ ...sig, side: 'Long' }] }], { close: Date.UTC(2026, 10, 3, 12) }, { tz, ny: bear }), /Wrong time/);   // a C: no ⛔, it's just a C
});

test('🌊 NY fade: a B+ that also fades the NY session', async () => {
  const { gradeSetup } = await import('../public/sfp.js');
  const { setupName } = await import('../public/day-playbook.js');
  const ny = { bias: 'bullish', during: true };
  const g = gradeSetup('Long', { ny, rsi: 33, fade: true });
  assert.equal(g.grade, 'B+'); assert.equal(g.tag, 'fade');
  assert.equal(setupName(g.grade, Date.now(), g.tag), '🌊 NY fade');
  assert.equal(gradeSetup('Long', { ny, rsi: 33 }).tag, 'late');               // no fade: 🌃 Late A++
  assert.equal(gradeSetup('Long', { ny, rsi: 50, fade: true }).grade, 'B');     // a B that fades stays B
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const M15 = 15 * 60_000, start = Date.UTC(2026, 10, 3, 13), close = Date.UTC(2026, 10, 3, 20);
  const fade = { dir: 'down', move: -0.03, pos: 0.05 };
  const sig = { side: 'Long', close: 100, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {}, rsi: 33, trade: { entry: 100, sl: 99, tp: 104, rr: 4 } };
  assert.match(preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close }, { ny, fade, tz: 'Asia/Makassar' }), /🎖️ <b>B\+<\/b>[^]*├ 🌊 NY fade: a B\+ that also fades the NY session/);
});

test('🌃 Late A++ at 00:00 / 04:00 at 0.5%', async () => {
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const tz = 'Asia/Makassar', ny = { bias: 'bearish', during: true };
  const sig = { side: 'Short', close: 100, line: 101, inside: 0.01, levels: [{ price: 101 }], range: {}, rsi: 66, trade: { entry: 100, sl: 102, tp: 94, rr: 3 } };
  const msg = close => preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close }, { tz, ny });
  assert.match(msg(Date.UTC(2026, 10, 3, 20)), /🏆 <b>A\+\+<\/b>[^]*├ 🌃 Late A\+\+: NY open, 4h RSI stretched \(0\.5%\)/);   // Wed 04:00
  assert.match(msg(Date.UTC(2026, 10, 3, 12)), /├ ⛔ Wrong time/);                                                       // Tue 20:00
});

test('every alert ends with what to take and why', async () => {
  const { recommendation, preMessage } = await import('../lib/sfp-alert.mjs');
  const tz = 'Asia/Makassar', bear = { bias: 'bearish', during: false };
  const sig = (rr, side = 'Short', rsi = 50) => ({ side, rsi, close: 100, line: 101, inside: 0.01, levels: [{ price: 101 }], range: {}, trade: { entry: 100, sl: 102, tp: 100 - 2 * rr, rr } });
  const hits = [['HYPEUSDT', sig(8)], ['SUIUSDT', sig(5, 'Short', 70)], ['AAVEUSDT', sig(3)], ['ONDOUSDT', sig(9, 'Long')]].map(([symbol, s]) => ({ symbol, s }));
  const tue12 = Date.UTC(2026, 10, 3, 4), ctx = { ny: bear, btcSides: [] };
  const rec = recommendation(hits, ctx, tue12, tz);
  assert.match(rec, /🧭 <b>Take<\/b>\n• <b>SUI short<\/b> · A\+ · 1% · 5\.0R: with the NY bias ▼, 4h RSI 70 \(stretched\)\n• <b>HYPE short<\/b> · A · 1%/);   // best grade first, then R:R
  assert.match(rec, /Also qualifies, but 2 a close is the limit: AAVE short/);
  assert.match(rec, /Skip\n• ONDO long · C, against the NY bias ▼: C had no edge in the backtest/);
  assert.match(recommendation(hits.slice(0, 1), ctx, Date.UTC(2026, 10, 3, 12), tz), /Take: nothing<\/b>\n• HYPE short · A, with the NY bias ▼: the plan skips 20:00/);
  const fri = recommendation(hits, ctx, Date.UTC(2026, 10, 6, 4), tz);   // Friday 12:00: trade cautiously, the best one at a quarter size
  assert.match(fri, /🧭 <b>Take<\/b>\n• <b>SUI short<\/b> · A\+ · 0\.25% · 5\.0R: .*\(trade cautiously, a quarter size\)\n• Also qualifies, but 1 a close is the limit today: HYPE short, AAVE short/);
  assert.match(fri, /At most 1 new trade a close/);
  assert.match(fri, /📅 Friday: trade cautiously\. The best setup only, at a quarter size/);
  const sat = recommendation(hits, ctx, Date.UTC(2026, 10, 7, 4), tz);   // Saturday 12:00: nothing is a plan trade, the call is yours
  assert.match(sat, /🧭 <b>Saturday: no plan trades, your call<\/b>\nBest on the board:\n• <b>SUI short<\/b> · A\+ · 5\.0R: with the NY bias ▼, 4h RSI 70 \(stretched\)\n• <b>HYPE short<\/b> · A · 8\.0R/);
  assert.match(sat, /Weekend entries lost money in every backtest we ran/);
  assert.match(sat, /The rest\n• AAVE short · A, with the NY bias ▼: no new trades on weekends/);
  assert.match(recommendation(hits.slice(3), ctx, Date.UTC(2026, 10, 7, 4), tz), /Take: nothing<\/b>\n• ONDO long · C/);   // only a C: nothing to name
  assert.doesNotMatch(rec, /Thursday/);                                  // a Tuesday
  assert.match(recommendation(hits, ctx, Date.UTC(2026, 10, 5, 0), tz), /📅 Thursday: the weekend is coming\. If it works, consider leaving it open for a few days/);   // Thu 08:00
  assert.doesNotMatch(recommendation(hits.slice(3), ctx, Date.UTC(2026, 10, 5, 0), tz), /Thursday/);   // nothing to take
  const pre = preMessage(hits.map(h => ({ symbol: h.symbol, pre: [h.s] })), { close: tue12 }, { tz, ny: bear });
  assert.match(pre, /🧭 <b>Take if it closes like this<\/b>/);
  assert.ok(pre.indexOf('🧭') > pre.lastIndexOf('BTC trend') || !pre.includes('BTC trend'));
});

test('✨ golden zone: BTC gave back half of the last NY session, tagged at 12:00 and 16:00', async () => {
  const { nyPullbackAt, inGoldenZone } = await import('../public/bias.js');
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  const H = 3_600_000, open = Date.UTC(2026, 10, 3, 13);                // Tue 8 AM New York (EST); the session ends 22:00 UTC
  const px = t => (t < open ? 100 : t < open + 9 * H ? 100 + (t - open) / H : 109 - (t - open - 9 * H) / H);   // +9 in NY, then back 1 an hour
  const cs = Array.from({ length: 40 }, (_, i) => { const t = open - 2 * H + i * H; return { t, o: px(t), h: px(t), l: px(t), c: px(t + H) }; });
  const noon = Date.UTC(2026, 10, 4, 4);                                 // Wed 12:00 in UTC+8: 6h after NY closed
  const p = nyPullbackAt(cs, noon);
  assert.equal(p.dir, 'Long'); assert.ok(Math.abs(p.back - 6 / 9) < 1e-9);   // 6 of the 9 given back
  assert.ok(inGoldenZone('Long', p, 12) && inGoldenZone('Long', p, 16));
  assert.ok(!inGoldenZone('Short', p, 12) && !inGoldenZone('Long', p, 8));    // against the move, or another close
  assert.ok(!inGoldenZone('Long', nyPullbackAt(cs, Date.UTC(2026, 10, 4, 0)), 12));   // 2 of 9 back: not yet
  const sig = { side: 'Long', rsi: 50, close: 100, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {}, trade: { entry: 100, sl: 99, tp: 104, rr: 4 } };
  const msg = preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close: noon }, { tz: 'Asia/Makassar', ny: { bias: 'bullish', during: false }, pull: p });
  assert.match(msg, /├ ✨ BTC in golden zone \/ NY pullback: 67% of NY’s move given back/);
  assert.match(msg, /• <b>HYPE long<\/b> · A · 1% · 4\.0R: with the NY bias ▲ · ✨ BTC in golden zone/);
});

test('BTC 1h RSI tag: 🧊 cooled off at 35–45 from the setup’s side, ⚠️ when stretched', async () => {
  const { btcRsiTag } = await import('../public/sfp.js');
  const { preMessage } = await import('../lib/sfp-alert.mjs');
  assert.equal(btcRsiTag('Long', 40).kind, 'cool');
  assert.equal(btcRsiTag('Short', 60).kind, 'cool');                   // 100 − 60 = 40
  assert.match(btcRsiTag('Long', 33).text, /BTC oversold against it \(1h RSI 33\)/);
  assert.match(btcRsiTag('Short', 70).text, /BTC overbought against it/);
  assert.match(btcRsiTag('Long', 64).text, /BTC already extended the trade’s way \(1h RSI 64\): wait for a cool-off/);
  assert.equal(btcRsiTag('Long', 50), null); assert.equal(btcRsiTag('Long', null), null);
  const sig = { side: 'Long', rsi: 50, close: 100, line: 99, inside: 0.01, levels: [{ price: 99 }], range: {}, trade: { entry: 100, sl: 99, tp: 104, rr: 4 } };
  const msg = preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close: Date.UTC(2026, 10, 3, 4) }, { tz: 'Asia/Makassar', ny: { bias: 'bullish', during: false }, btcRsi: 41.6 });
  assert.match(msg, /├ 🧊 BTC cooled off \(1h RSI 42\): pulled back, not broken\n/);
  assert.match(msg, /• <b>HYPE long<\/b> · A · 1% · 4\.0R: with the NY bias ▲ · 🧊 BTC cooled off/);
  const c = preMessage([{ symbol: 'HYPEUSDT', pre: [sig] }], { close: Date.UTC(2026, 10, 3, 4) }, { tz: 'Asia/Makassar', ny: { bias: 'bearish', during: false }, btcRsi: 41.6 });
  assert.doesNotMatch(c, /BTC cooled/);                                   // a C (against the NY bias): no tag
});
