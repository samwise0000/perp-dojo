// GET /api/pull?category=linear&start=ms&end=ms[&fillsOnly=1]
// One window (Bybit allows at most 7 days) of closed P&L and fills. The page
// calls this once per week of the range, so no single call runs long.
import { json, authorized, query } from '../lib/http.mjs';
import { bybit, checkKey, FATAL, BybitError } from '../lib/session.mjs';

const WEEK = 7 * 86_400_000;
const CATEGORIES = new Set(['linear', 'inverse']);

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const q = query(req);
  const start = Number(q.start), end = Number(q.end);
  if (!CATEGORIES.has(q.category) || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start >= WEEK)
    return json(res, 400, { error: 'Expected category=linear|inverse and a start/end window of at most 7 days.' });
  const key = await checkKey();
  if (!key.ok) return json(res, 403, { error: key.message });
  const c = bybit();
  try {
    const rows = q.fillsOnly === '1' ? [] : await c.getAll('/v5/position/closed-pnl', { category: q.category, startTime: start, endTime: end, limit: 100 });
    const fills = (await c.getAll('/v5/execution/list', { category: q.category, startTime: start, endTime: end, limit: 100 }))
      .filter(f => f.execType !== 'Funding')
      .map(f => ({ id: f.execId, c: q.category, s: f.symbol, side: f.side, q: Number(f.execQty) || 0, cs: Number(f.closedSize) || 0, t: Number(f.execTime), o: f.orderId }));
    json(res, 200, { uid: key.uid, rows, fills });
  } catch (e) {
    if (e instanceof BybitError && !FATAL.has(e.code)) return json(res, 200, { uid: key.uid, rows: [], fills: [], warning: e.message });
    json(res, 502, { error: e.message });
  }
}
