// Order flow for the 🐋 Whale Absorption tag (whaleAbsorption in public/sfp.js): Bybit's funding
// settlements and Binance's 4h taker volume (Bybit's candles don't split taker buys from sells).
// Both are public market data: no key.
const bybitBase = () => (process.env.BYBIT_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.bybit.com';
const H4 = 4 * 3_600_000, DAY = 86_400_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function json(url, tries = 3) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); const j = await r.json(); if (r.ok) return j; if (r.status === 400) return j; throw new Error(`HTTP ${r.status}`); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(400 * (i + 1)); }
  }
}
// funding settlements from `start` to `end`, oldest first: [{ t, rate }]
export async function fundingHistory(symbol, start, end = Date.now()) {
  const out = new Map();
  // newest first, 200 a page: page back from `end` until past `start`
  for (let e = end, i = 0; i < 40; i++) {
    const j = await json(`${bybitBase()}/v5/market/funding/history?${new URLSearchParams({ category: 'linear', symbol, endTime: e, limit: 200 })}`);
    const list = j?.retCode === 0 ? j.result?.list || [] : [];
    for (const x of list) out.set(Number(x.fundingRateTimestamp), Number(x.fundingRate));
    const oldest = Math.min(...list.map(x => Number(x.fundingRateTimestamp)));
    if (list.length < 200 || !(oldest > start)) break;
    e = oldest - 1;
  }
  return [...out].map(([t, rate]) => ({ t, rate })).filter(f => f.t >= start - 3 * DAY).sort((a, b) => a.t - b.t);
}
// Binance USDT-M 4h candles' volume and taker buy volume, oldest first: [{ t, vol, buy }]. [] when Binance doesn't list it.
export async function takerFlow(symbol, start, end = Date.now()) {
  const out = new Map();
  for (let s = Math.floor(start / H4) * H4; s < end; s += 1500 * H4) {
    const j = await json(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=1500&startTime=${s}&endTime=${end}`);
    if (!Array.isArray(j)) break;
    for (const k of j) out.set(k[0], { t: k[0], vol: Number(k[5]), buy: Number(k[9]) });
    if (j.length < 1500) break;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}
export async function flowFor(symbol, start, end = Date.now()) {
  const [funding, taker] = await Promise.all([fundingHistory(symbol, start, end).catch(() => []), takerFlow(symbol, start, end).catch(() => [])]);
  return { funding, taker };
}
