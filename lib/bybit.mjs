// Minimal signed client for Bybit's V5 REST API — GET requests only.
// https://bybit-exchange.github.io/docs/v5/guide
import crypto from 'node:crypto';

const RECV_WINDOW = 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class BybitError extends Error {
  constructor(code, msg, path) {
    super(`Bybit ${path}: ${msg} (retCode ${code})`);
    this.code = code;
  }
}

export function createClient({ key, secret, base = 'https://api.bybit.com' }) {
  let clockOffset = 0;

  async function syncClock() {
    const r = await fetch(base + '/v5/market/time');
    const j = await r.json();
    clockOffset = Number(j.time) - Date.now();
  }

  async function get(path, params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();

    for (let attempt = 0; attempt < 6; attempt++) {
      const ts = String(Date.now() + clockOffset);
      const sign = crypto.createHmac('sha256', secret).update(ts + key + RECV_WINDOW + qs).digest('hex');
      const res = await fetch(base + path + (qs ? '?' + qs : ''), {
        headers: {
          'X-BAPI-API-KEY': key,
          'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-SIGN': sign,
          'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
        },
      });
      // 403/429 at the HTTP level are IP rate limits: back off and retry
      if (res.status === 403 || res.status === 429) { await sleep(1000 * 2 ** attempt); continue; }
      const j = await res.json();
      if (j.retCode === 10006) { await sleep(1000 * 2 ** attempt); continue; }   // too many visits
      if (j.retCode === 10002) { await syncClock(); continue; }                  // clock drift
      if (j.retCode !== 0) throw new BybitError(j.retCode, j.retMsg, path);
      // stay well clear of the per-endpoint limit
      const remaining = Number(res.headers.get('x-bapi-limit-status'));
      if (Number.isFinite(remaining) && remaining <= 2) await sleep(1000);
      return j.result;
    }
    throw new Error(`Bybit ${path}: still rate-limited after several retries, try again in a minute`);
  }

  async function getAll(path, params) {
    const out = [];
    let cursor;
    do {
      const r = await get(path, { ...params, cursor });
      out.push(...(r.list || []));
      cursor = r.nextPageCursor || undefined;
      if (cursor) await sleep(60);
    } while (cursor);
    return out;
  }

  return { get, getAll, syncClock };
}
