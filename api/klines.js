// GET /api/klines?category=linear&symbol=BTCUSDT&interval=15&start=ms&end=ms[&price=mark]
// Candles for the trade replay, from Bybit's public market data. No key is
// used: this is the same chart data anyone can read. Oldest candle first.
import { json, authorized, query } from '../lib/http.mjs';

const CATEGORIES = new Set(['linear', 'inverse']);
const INTERVALS = new Set(['1', '3', '5', '15', '30', '60', '120', '240', '360', '720', 'D', 'W']);
const base = () => (process.env.BYBIT_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.bybit.com';

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const q = query(req);
  const start = Number(q.start), end = Number(q.end);
  if (!CATEGORIES.has(q.category) || !INTERVALS.has(q.interval) || !/^[A-Z0-9]{2,30}$/.test(q.symbol || '') ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return json(res, 400, { error: 'Expected category, symbol, interval and a start/end window.' });
  const path = q.price === 'mark' ? '/v5/market/mark-price-kline' : '/v5/market/kline';
  const qs = new URLSearchParams({ category: q.category, symbol: q.symbol, interval: q.interval, start, end, limit: 1000 });
  try {
    const r = await fetch(`${base()}${path}?${qs}`);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return json(res, 502, { error: `Bybit answered ${r.status} for candles.` });
    if (j.retCode !== 0) return json(res, 502, { error: `Bybit: ${j.retMsg} (retCode ${j.retCode})` });
    const candles = (j.result?.list || [])
      .map(c => ({ t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]) }))
      .sort((a, b) => a.t - b.t);
    json(res, 200, { candles });
  } catch (e) {
    json(res, 502, { error: `Couldn't reach Bybit for candles: ${e.message}` });
  }
}
