import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movePnl, normalizePosition, openedAtFrom } from '../lib/positions.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('move P&L: linear in quote, inverse in coin converted at the new price', () => {
  close(movePnl({ inverse: false, long: true, size: 2, from: 100, to: 90 }), -20);
  close(movePnl({ inverse: false, long: false, size: 2, from: 100, to: 90 }), 20);
  // 1000 USD of inverse long from 50k to 40k: 1000 × (1/50k − 1/40k) BTC × 40k = −$200
  close(movePnl({ inverse: true, long: true, size: 1000, from: 50_000, to: 40_000 }), -200);
});

test('a position: stop-loss risk, take-profit, liquidation distance', () => {
  const p = normalizePosition({ symbol: 'BTCUSDT', side: 'Buy', size: '0.05', avgPrice: '76000', markPrice: '76400', positionValue: '3800',
    unrealisedPnl: '20', leverage: '10', liqPrice: '69100', stopLoss: '75200', takeProfit: '78400', positionIdx: 0 }, 'linear');
  assert.equal(p.dir, 'Long');
  close(p.slLoss, -40);
  close(p.tpGain, 120);
  close(p.liqDistance, (76400 - 69100) / 76400);
  close(p.upnlPct, 20 / 380);
  const q = normalizePosition({ symbol: 'SOLUSDT', side: 'Sell', size: '30', avgPrice: '150', markPrice: '154.5', unrealisedPnl: '-135', leverage: '25', liqPrice: '155.9', stopLoss: '', takeProfit: '0' }, 'linear');
  assert.equal(q.sl, null);
  assert.equal(q.tp, null);
  close(q.liqDistance, (155.9 - 154.5) / 154.5);
});

test('open time: the fill that started the current position, not an earlier one', () => {
  const pos = { side: 'Buy', size: 3 };
  const fills = [
    { side: 'Buy', q: 2, cs: 0, t: 100 },    // an earlier long…
    { side: 'Sell', q: 2, cs: 2, t: 200 },   // …closed
    { side: 'Buy', q: 1, cs: 0, t: 300 },    // current position starts here
    { side: 'Buy', q: 3, cs: 0, t: 400 },    // added
    { side: 'Sell', q: 1, cs: 1, t: 500 },   // trimmed
  ];
  assert.equal(openedAtFrom(fills, pos), 300);
});

test('open time: a flip through zero opens the new side; too old gives null', () => {
  // short 2, then one Buy of 5 closes 2 and opens a 3 long
  assert.equal(openedAtFrom([{ side: 'Sell', q: 2, cs: 0, t: 1 }, { side: 'Buy', q: 5, cs: 2, t: 2 }], { side: 'Buy', size: 3 }), 2);
  assert.equal(openedAtFrom([{ side: 'Buy', q: 1, cs: 0, t: 5 }], { side: 'Buy', size: 3 }), null);
});
