// The Bybit client and the read-only check, shared by every function.
// Warm instances reuse the check for a few minutes instead of asking Bybit each call.
import { createClient, BybitError } from './bybit.mjs';

const env = k => (process.env[k] || '').trim();
let client = null, keyInfo = null, keyAt = 0;

export function bybit() {
  if (client) return client;
  const key = env('BYBIT_API_KEY'), secret = env('BYBIT_API_SECRET');
  if (!key || !secret) return null;
  client = createClient({ key, secret, base: env('BYBIT_BASE_URL').replace(/\/+$/, '') || 'https://api.bybit.com' });
  return client;
}

export async function checkKey(force = false) {
  const ttl = keyInfo?.ok ? 10 * 60_000 : 30_000;
  if (!force && keyInfo && Date.now() - keyAt < ttl) return keyInfo;
  keyInfo = await askBybit();
  keyAt = Date.now();
  return keyInfo;
}

async function askBybit() {
  const c = bybit(), KEY = env('BYBIT_API_KEY'), base = env('BYBIT_BASE_URL') || 'https://api.bybit.com';
  if (!c) return { ok: false, reason: 'missing', message: 'No API key yet. Set BYBIT_API_KEY and BYBIT_API_SECRET (in .env locally, or in the Vercel project settings).' };
  try {
    await c.syncClock();
    const k = await c.get('/v5/user/query-api');
    const info = {
      ok: k.readOnly === 1, uid: k.userID, readOnly: k.readOnly === 1, uta: k.uta === 1,
      keyHint: '…' + KEY.slice(-4), ips: k.ips || [], expiresAt: k.expiredAt || null,
      daysLeft: Number.isFinite(k.deadlineDay) ? k.deadlineDay : null, base,
    };
    if (!info.readOnly) { info.reason = 'writable'; info.message = 'This key can place orders or move funds. Create a Read-Only key in Bybit and use that instead.'; }
    return info;
  } catch (e) {
    const message = e instanceof BybitError
      ? `Bybit rejected the key: ${e.message}. Check the key and secret, and that BYBIT_BASE_URL matches your account's region.`
      : `Couldn't reach Bybit at ${base}: ${e.message}`;
    return { ok: false, reason: 'error', message, keyHint: '…' + KEY.slice(-4), base };
  }
}

// errors that mean "stop", as opposed to "this week has a problem"
export const FATAL = new Set([10003, 10004, 10005, 10007, 10009, 10010, 33004]);
export { BybitError };
