// A stand-in for Bybit's V5 API, for testing without a real key.
//   node test/mock-bybit.mjs [port]          (default 9999)
// Then run the app with BYBIT_BASE_URL=http://127.0.0.1:9999,
// BYBIT_API_KEY=mock-key, BYBIT_API_SECRET=mock-secret.
// It checks signatures and the 7-day window the same way Bybit does, and
// serves a year of synthetic closes. MOCK_WRITABLE=1 simulates a trading key.
import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_KEY = 'mock-key', MOCK_SECRET = 'mock-secret';
const DAY = 86_400_000;

// deterministic pseudo-random numbers so runs are repeatable
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function makeTrades({ days = 365, count = 420, now = Date.now(), seed = 7 } = {}) {
  const rand = rng(seed);
  const markets = [
    { symbol: 'BTCUSDT', price: 62000, cat: 'linear', w: 0.35, edge: 0.002 },
    { symbol: 'ETHUSDT', price: 3100, cat: 'linear', w: 0.25, edge: 0.0005 },
    { symbol: 'SOLUSDT', price: 150, cat: 'linear', w: 0.2, edge: -0.002 },
    { symbol: '1000PEPEUSDT', price: 0.012, cat: 'linear', w: 0.12, edge: -0.006 },
    { symbol: 'BTCUSD', price: 62000, cat: 'inverse', w: 0.08, edge: 0.001 },
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    let r = rand(), m = markets[0];
    for (const x of markets) { if ((r -= x.w) <= 0) { m = x; break; } }
    const long = rand() < 0.58;
    const lev = [3, 5, 10, 10, 20, 25, 50][Math.floor(rand() * 7)];
    const entry = m.price * (0.8 + rand() * 0.4);
    const move = (rand() - 0.47) * 0.04 + m.edge * (long ? 1 : 0.3);
    const exit = entry * (1 + (long ? move : -move));
    const time = now - days * DAY + Math.floor(((i + rand()) / count) * days * DAY);
    const taker = 0.00055;
    let row;
    if (m.cat === 'linear') {
      const notional = 500 + rand() * 9500;
      const size = +(notional / entry).toPrecision(4);
      const entryV = size * entry, exitV = size * exit;
      const gross = (exitV - entryV) * (long ? 1 : -1);
      const openFee = entryV * taker, closeFee = exitV * taker;
      const funding = entryV * 0.0001 * Math.floor(rand() * 6) * (rand() < 0.75 ? 1 : -1) * (long ? 1 : -1);
      row = { cumEntryValue: entryV, cumExitValue: exitV, closedSize: size, openFee, closeFee, closedPnl: gross - openFee - closeFee - funding };
    } else {
      const size = Math.round(200 + rand() * 5000);           // USD contracts
      const entryV = size / entry, exitV = size / exit;      // coin
      const gross = (entryV - exitV) * (long ? 1 : -1);
      const openFee = entryV * taker, closeFee = exitV * taker;
      row = { cumEntryValue: entryV, cumExitValue: exitV, closedSize: size, openFee, closeFee, closedPnl: gross - openFee - closeFee };
    }
    const liq = lev >= 25 && move < -0.015 && rand() < 0.5;     // `move` is already the position's direction
    // hold time: log-uniform between ~20 seconds and ~2 days
    const hold = Math.round(Math.exp(Math.log(20e3) + rand() * (Math.log(2 * DAY) - Math.log(20e3))));
    out.push({
      symbol: m.symbol, category: m.cat,
      orderId: crypto.createHash('md5').update(String(i)).digest('hex'),
      side: long ? 'Sell' : 'Buy', qty: String(row.closedSize), orderPrice: String(exit), orderType: rand() < 0.6 ? 'Market' : 'Limit',
      execType: liq ? 'BustTrade' : 'Trade', closedSize: String(row.closedSize),
      cumEntryValue: String(row.cumEntryValue), avgEntryPrice: String(entry), cumExitValue: String(row.cumExitValue), avgExitPrice: String(exit),
      closedPnl: String(row.closedPnl), fillCount: '1', leverage: String(lev),
      openFee: String(row.openFee), closeFee: String(row.closeFee),
      createdTime: String(time - 1000), updatedTime: String(time),
      _hold: hold,
    });
  }
  return out;
}

// An opening and a closing fill for every close, so hold times can be rebuilt.
export function makeFills(trades) {
  const out = [];
  for (const t of trades) {
    const close = +t.updatedTime, open = close - t._hold;
    out.push({ category: t.category, symbol: t.symbol, execId: 'x-open-' + t.orderId, orderId: 'open-' + t.orderId, side: t.side === 'Sell' ? 'Buy' : 'Sell',
      execQty: t.closedSize, closedSize: '0', execTime: String(open), execType: 'Trade', execPrice: t.avgEntryPrice });
    out.push({ category: t.category, symbol: t.symbol, execId: 'x-close-' + t.orderId, orderId: t.orderId, side: t.side,
      execQty: t.closedSize, closedSize: t.closedSize, execTime: String(close), execType: t.execType, execPrice: t.avgExitPrice });
  }
  return out;
}

export function startMock({ port = 9999, writable = false, trades = makeTrades() } = {}) {
  const fills = makeFills(trades);
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body, retCode = 0, retMsg = 'OK') => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-bapi-limit-status': '40' });
      res.end(JSON.stringify({ retCode, retMsg, result: body, retExtInfo: {}, time: Date.now() }));
    };
    if (url.pathname === '/v5/market/time') return send({ timeSecond: String(Math.floor(Date.now() / 1000)) }, 0, 'OK');
    // auth, exactly as Bybit checks it
    const ts = req.headers['x-bapi-timestamp'], recv = req.headers['x-bapi-recv-window'];
    const qs = url.search.slice(1);
    const want = crypto.createHmac('sha256', MOCK_SECRET).update(ts + MOCK_KEY + recv + qs).digest('hex');
    if (req.headers['x-bapi-api-key'] !== MOCK_KEY) return send({}, 10003, 'API key is invalid.');
    if (req.headers['x-bapi-sign'] !== want) return send({}, 10004, 'error sign!');
    calls.push(url.pathname + '?' + qs);
    if (url.pathname === '/v5/user/query-api')
      return send({ apiKey: MOCK_KEY, readOnly: writable ? 0 : 1, userID: 123456, uta: 1, ips: [], expiredAt: '', deadlineDay: 83, permissions: {} });
    if (url.pathname === '/v5/account/wallet-balance')
      return send({ list: [{ accountType: 'UNIFIED', totalEquity: '26037.81', totalWalletBalance: '25980.10', totalPerpUPL: '57.71', coin: [] }] });
    if (url.pathname === '/v5/execution/list') {
      const p = Object.fromEntries(url.searchParams);
      const start = Number(p.startTime), end = Number(p.endTime);
      if (end - start > 7 * DAY) return send({}, 10001, 'The interval between startTime and endTime cannot exceed 7 days');
      const limit = Math.min(Number(p.limit) || 50, 100), offset = Number(p.cursor || 0);
      const rows = fills.filter(f => f.category === p.category && +f.execTime >= start && +f.execTime <= end).sort((a, b) => b.execTime - a.execTime);
      return send({ category: p.category, list: rows.slice(offset, offset + limit).map(({ category, ...f }) => f), nextPageCursor: offset + limit < rows.length ? String(offset + limit) : '' });
    }
    if (url.pathname === '/v5/position/closed-pnl') {
      const p = Object.fromEntries(url.searchParams);
      const start = Number(p.startTime), end = Number(p.endTime);
      if (end - start > 7 * DAY) return send({}, 10001, 'The interval between startTime and endTime cannot exceed 7 days');
      const limit = Math.min(Number(p.limit) || 50, 100), offset = Number(p.cursor || 0);
      const rows = trades.filter(t => t.category === p.category && +t.updatedTime >= start && +t.updatedTime <= end)
        .sort((a, b) => b.updatedTime - a.updatedTime);
      const page = rows.slice(offset, offset + limit).map(({ category, _hold, ...r }) => r);
      return send({ category: p.category, list: page, nextPageCursor: offset + limit < rows.length ? String(offset + limit) : '' });
    }
    send({}, 10005, 'Permission denied');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, calls, trades })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 9999;
  await startMock({ port, writable: process.env.MOCK_WRITABLE === '1' });
  console.log(`Mock Bybit on http://127.0.0.1:${port}`);
}
