// GET /api/positions → every open perp position (linear USDT/USDC and inverse),
// read-only. The page polls this while the dashboard is open.
import { json, authorized } from '../lib/http.mjs';
import { bybit, checkKey } from '../lib/session.mjs';
import { normalizePosition, openedAtFrom } from '../lib/positions.mjs';

const WEEK = 7 * 86_400_000;
// When each position opened, kept while its size and entry don't change, so
// polling doesn't re-read fills every time.
const opened = new Map();

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const key = await checkKey();
  if (!key.ok) return json(res, 200, { available: false, error: key.message });
  const c = bybit();
  try {
    const lists = await Promise.all([
      ['linear', { settleCoin: 'USDT' }], ['linear', { settleCoin: 'USDC' }], ['inverse', {}],
    ].map(async ([category, extra]) => (await c.getAll('/v5/position/list', { category, limit: 200, ...extra })).map(p => ({ p, category }))));
    const positions = lists.flat().filter(({ p }) => Number(p.size) > 0).map(({ p, category }) => normalizePosition(p, category));

    for (const pos of positions) {
      const k = `${pos.id}:${pos.side}:${pos.size}:${pos.entry}`;
      if (!opened.has(k)) {
        const now = Date.now();
        const fills = (await c.getAll('/v5/execution/list', { category: pos.category, symbol: pos.symbol, startTime: now - WEEK + 60_000, endTime: now, limit: 100 }))
          .filter(f => f.execType !== 'Funding')
          .map(f => ({ side: f.side, q: Number(f.execQty) || 0, cs: Number(f.closedSize) || 0, t: Number(f.execTime) }));
        opened.set(k, openedAtFrom(fills, pos));
      }
      pos.openedAt = opened.get(k);
    }
    // forget positions that have closed
    const live = new Set(positions.map(p => `${p.id}:${p.side}:${p.size}:${p.entry}`));
    for (const k of opened.keys()) if (!live.has(k)) opened.delete(k);

    json(res, 200, { available: true, positions, at: Date.now() });
  } catch (e) {
    json(res, 200, { available: false, error: e.message });
  }
}
