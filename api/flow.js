// GET /api/flow?symbol=SOLUSDT&start=ms[&end=ms]
// Funding settlements (Bybit) and 4h taker volume (Binance) for the 🐋 Whale Absorption tag.
// Public market data, no key.
import { json, authorized, query } from '../lib/http.mjs';
import { flowFor } from '../lib/flow.mjs';

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const q = query(req), start = Number(q.start), end = q.end ? Number(q.end) : Date.now();
  if (!/^[A-Z0-9]{2,30}$/.test(q.symbol || '') || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 2000 * 86_400_000)
    return json(res, 400, { error: 'Expected a symbol and a start/end window (at most 2,000 days).' });
  try { json(res, 200, await flowFor(q.symbol, start, end)); }
  catch (e) { json(res, 502, { error: `Couldn't read order flow: ${e.message}` }); }
}
