import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, verdict, summaryText, recommendations, rulesText, workingText, keyNumbers, monthCompare } from '../public/report.js';
import { summarize } from '../public/metrics.js';

const f = {
  money: (v, o = {}) => (v < 0 ? '−' : o.sign === false ? '' : v > 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2),
  compact: v => '$' + Math.round(v), date: ms => new Date(ms).toISOString().slice(0, 10), dateTime: ms => new Date(ms).toISOString(),
};
const D = 86_400_000, mon = new Date(2026, 8, 7, 10).getTime();   // a Monday
const T = (day, pnl, extra = {}) => ({ time: mon + day * D, pnl, gross: pnl + 2, fees: 2, funding: 0, notional: 1000, margin: 100, leverage: 10, symbol: 'BTCUSDT', dir: 'Long', liquidation: false, duration: null, ...extra });

test('losing while winning often: the summary explains the size problem', () => {
  // 12 small wins, 8 bigger losses → 60% win rate, payoff < 1, net negative
  const trades = [...Array.from({ length: 12 }, (_, i) => T(i, 20)), ...Array.from({ length: 8 }, (_, i) => T(i + 0.5, -45, { symbol: 'SOLUSDT' }))];
  const a = analyze(trades);
  assert.equal(verdict(a).level, 'poor');
  const text = summaryText(a, f).join(' ');
  assert.match(text, /won 60% of your trades/);
  assert.match(text, /average loss \(\$45\.00\) was bigger than the average win \(\$20\.00\)/);
  assert.match(text, /need about 69% winners to break even/);      // 1 / (1 + 20/45)
  const recs = recommendations(a, f).map(r => r.title).join(' | ');
  assert.match(recs, /Cut losers sooner/);
  assert.match(recs, /Stop trading SOLUSDT/);
});

test('rules: Saturday trades and trades beyond the daily limit are costed', () => {
  const trades = [T(0, 30), T(0.01, -10), T(0.02, -25), T(0.03, -15), T(5, -40)];   // 4 on Monday, 1 on Saturday
  const a = analyze(trades, { maxTrades: 2 });
  assert.equal(a.rules.saturday.n, 1);
  assert.equal(a.rules.overtrading.extra, 2);
  assert.equal(a.rules.overtrading.extraNet, -40);
  const text = rulesText(a, f).join(' ');
  assert.match(text, /Breaking your rules cost you \$80\.00/);
  assert.match(text, /1 Saturday trade \(−\$40\.00\)/);
  assert.match(recommendations(a, f).map(r => r.title).join(' | '), /Stop at 2 trades a day/);
});

test('a healthy period reads as profitable and says to keep going', () => {
  const trades = Array.from({ length: 30 }, (_, i) => T(i, i % 3 ? 60 : -30));
  const a = analyze(trades);
  assert.equal(verdict(a).level, 'good');
  assert.match(summaryText(a, f).join(' '), /finished up/);
  assert.ok(keyNumbers(a, f).find(r => r[0] === 'Profit factor')[2].startsWith('Strong'));
});

test('longs and shorts pulling in opposite directions is called out', () => {
  const trades = [...Array.from({ length: 6 }, (_, i) => T(i, 40)), ...Array.from({ length: 6 }, (_, i) => T(i + 0.3, -30, { dir: 'Short' }))];
  assert.match(workingText(analyze(trades), f).join(' '), /longs made \+\$240\.00 while your shorts lost −\$180\.00/);
});

test('small samples are flagged; an empty period still produces a report', () => {
  assert.match(summaryText(analyze([T(0, 10), T(1, -5)]), f).join(' '), /early signs/);
  const empty = analyze([]);
  assert.equal(verdict(empty).level, 'none');
  assert.equal(recommendations(empty, f).length, 1);
});

test('month in progress: compared with the same days of last month', () => {
  const cur = summarize([T(0, 50), T(1, -20), T(2, 30)]), prev = summarize([T(-30, 10), T(-29, -40)]);
  const c = monthCompare(cur, prev, { partial: true, curName: 'This month', prevName: 'October', prevSpan: 'Oct 1 – Oct 3', f });
  assert.equal(c.title, 'Against the same days last month');
  assert.deepEqual(c.head, ['', 'This month', 'October, same days']);
  const text = c.lines.join(' ');
  assert.match(text, /By this point in October \(Oct 1 – Oct 3\) you had closed 2 trades for −\$30\.00/);
  assert.match(text, /This month you are \$90\.00 ahead of that pace, on more trades \(3 against 2\)/);
  assert.deepEqual(c.rows[0], ['Net P&L', '+$60.00', '−$30.00']);
});

test('past month: compared with the whole previous month, empty months handled', () => {
  const c = monthCompare(summarize([T(0, -10)]), summarize([]), { curName: 'October 2026', prevName: 'September', f });
  assert.equal(c.title, 'Against September');
  assert.match(c.lines[0], /In September you had no closed trades/);
  assert.deepEqual(c.rows[1], ['Trades', '1', '0']);
  const d = monthCompare(summarize([T(0, -10), T(1, -10), T(2, -10), T(3, 5)]), summarize([T(-30, 20), T(-29, 20)]), { curName: 'October 2026', prevName: 'September', f });
  assert.match(d.lines.join(' '), /October 2026 finished \$65\.00 behind it/);
  assert.match(d.lines.join(' '), /More trades for a worse result/);
});
