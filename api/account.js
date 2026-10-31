// GET /api/account → current equity and wallet balance, read-only. For display
// only: no trading stat uses it, so deposits and withdrawals never skew them.
import { json, authorized } from '../lib/http.mjs';
import { bybit, checkKey } from '../lib/session.mjs';

export default async function handler(req, res) {
  if (!authorized(req, res)) return;
  const key = await checkKey();
  if (!key.ok) return json(res, 200, { available: false });
  try {
    const r = await bybit().get('/v5/account/wallet-balance', { accountType: key.uta ? 'UNIFIED' : 'CONTRACT' });
    const a = r.list?.[0] || {};
    const n = x => (x === '' || x === undefined ? null : Number(x));
    let equity = n(a.totalEquity);
    const wallet = n(a.totalWalletBalance), unrealized = n(a.totalPerpUPL);
    if (equity === null && Array.isArray(a.coin)) equity = a.coin.reduce((s, c) => s + (Number(c.usdValue) || 0), 0);
    json(res, 200, { available: equity !== null, equity, wallet, unrealized, at: Date.now() });
  } catch (e) {
    json(res, 200, { available: false, error: e.message });
  }
}
