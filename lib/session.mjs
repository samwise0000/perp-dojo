// The Bybit client and the read-only check, shared by every function.
// Warm instances reuse the check for a few minutes instead of asking Bybit each call.
import { createClient, BybitError } from './bybit.mjs';

const env = k => (process.env[k] || '').trim();
// A demo-trading key only works on Bybit's demo server. BYBIT_DEMO=1 or 0 forces one side;
// left unset, a key the live API calls invalid is tried on the demo server once, and kept there
// if it works. Market data stays on the live API either way.
const DEMO_BASE = 'https://api-demo.bybit.com';
const demoSetting = () => { const v = env('BYBIT_DEMO'); return /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : null; };
const liveBase = () => env('BYBIT_BASE_URL').replace(/\/+$/, '') || 'https://api.bybit.com';
let client = null, keyInfo = null, keyAt = 0, detectedDemo = false;
const isDemo = () => demoSetting() ?? detectedDemo;
const accountBase = () => isDemo() ? DEMO_BASE : liveBase();

export function bybit() {
  if (client) return client;
  const key = env('BYBIT_API_KEY'), secret = env('BYBIT_API_SECRET');
  if (!key || !secret) return null;
  client = createClient({ key, secret, base: accountBase() });
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
  const KEY = env('BYBIT_API_KEY');
  if (!bybit()) return { ok: false, reason: 'missing', message: 'No API key yet. Set BYBIT_API_KEY and BYBIT_API_SECRET (in .env locally, or in the Vercel project settings).' };
  let r = await tryKey(KEY);
  // invalid on live with nothing forced: maybe it's a demo-trading key
  if (r.invalid && demoSetting() === null && !detectedDemo) {
    detectedDemo = true; client = null; bybit();
    const d = await tryKey(KEY);
    if (d.invalid || d.unreachable) { detectedDemo = false; client = null; bybit(); } else r = d;
  }
  delete r.invalid; delete r.unreachable;
  return r;
}

async function tryKey(KEY) {
  const c = bybit(), base = accountBase(), demo = isDemo();
  try {
    await c.syncClock();
    const k = await c.get('/v5/user/query-api');
    const info = {
      ok: k.readOnly === 1, uid: k.userID, readOnly: k.readOnly === 1, uta: k.uta === 1,
      keyHint: '…' + KEY.slice(-4), ips: k.ips || [], expiresAt: k.expiredAt || null,
      daysLeft: Number.isFinite(k.deadlineDay) ? k.deadlineDay : null, base, demo,
    };
    if (!info.readOnly) { info.reason = 'writable'; info.message = 'This key can place orders or move funds. Create a Read-Only key in Bybit and use that instead.'; }
    return info;
  } catch (e) {
    const hint = demoSetting() === true ? 'BYBIT_DEMO is on, so this needs a key made under Demo Trading; unset it for a live key.'
      : demoSetting() === false ? 'BYBIT_DEMO is off, so this needs a live key.'
      : 'It was tried on both the live and the demo server. Check the key and secret, and that BYBIT_BASE_URL matches your account\'s region.';
    const message = e instanceof BybitError
      ? `Bybit rejected the key: ${e.message}. ${hint}`
      : `Couldn't reach Bybit at ${base}: ${e.message}`;
    return { ok: false, reason: 'error', message, keyHint: '…' + KEY.slice(-4), base, demo, invalid: e instanceof BybitError && e.code === 10003, unreachable: !(e instanceof BybitError) };
  }
}

// errors that mean "stop", as opposed to "this week has a problem"
export const FATAL = new Set([10003, 10004, 10005, 10007, 10009, 10010, 33004]);
export { BybitError };
