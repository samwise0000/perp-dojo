// A 4h chart of one SFP setup as a PNG, for the Telegram heads-up: the recent
// candles, the swept level and the target level from their swing candles (gray),
// the signal arrow, and the trade drawn to the right of the candles (risk in red,
// reward in blue, with Entry, SL and TP labels). Drawn as SVG, rendered by resvg.
import { Resvg } from '@resvg/resvg-js';

const W = 1000, H = 560;
const PAD = { top: 56, right: 112, bottom: 30, left: 16 };
const C = {
  bg: '#0d0f12', grid: '#1b1f26', axis: '#6b7280', text: '#e5e7eb', muted: '#8b93a1',
  up: '#38bdf8', down: '#f43f5e', level: '#9ca3af', entry: '#e5e7eb', risk: '#f43f5e', reward: '#38bdf8',
};
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = v => Number(v.toPrecision(5)).toString();

// candles: {t,o,h,l,c} oldest first, ending with the signal candle.
// sig: { side, levels:[{price,t}], trade:{entry,sl,tp,tpT,rr} | null }
export function chartSvg({ symbol, candles, sig, trend, closeLabel }) {
  const short = sig.side === 'Short', tr = sig.trade;
  const GAP = 2, BOX = 10;
  const n = candles.length, slots = n + GAP + BOX + 1;
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
  const step = plotW / slots, bodyW = Math.max(2, step * 0.62);
  const xOf = i => PAD.left + step * (i + 0.5);
  const idx = new Map(candles.map((c, i) => [c.t, i]));

  // price range: the candles plus the trade's stop and target
  const prices = [...candles.flatMap(c => [c.h, c.l]), ...(tr ? [tr.sl, tr.tp] : []), ...sig.levels.map(l => l.price)];
  let hi = Math.max(...prices), lo = Math.min(...prices);
  const m = (hi - lo) * 0.06; hi += m; lo -= m;
  const yOf = p => PAD.top + (hi - p) / (hi - lo) * plotH;

  const out = [];
  out.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  // grid and price axis, on round numbers
  const rough = (hi - lo) / 6, mag = 10 ** Math.floor(Math.log10(rough));
  const tick = [1, 2, 2.5, 5, 10].map(f => f * mag).find(x => x >= rough);
  for (let p = Math.ceil(lo / tick) * tick; p <= hi; p += tick) {
    const y = yOf(p);
    out.push(`<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`);
    out.push(`<text x="${W - PAD.right + 8}" y="${y + 4}" fill="${C.axis}" font-size="12">${px(p)}</text>`);
  }
  // levels, from their swing candles to the signal (gray)
  const last = n - 1;
  // a dot above a swing high's candle, below a swing low's
  const level = (price, t, high) => {
    const i = idx.has(t) ? idx.get(t) : 0;
    out.push(`<line x1="${xOf(i)}" x2="${xOf(last)}" y1="${yOf(price)}" y2="${yOf(price)}" stroke="${C.level}" stroke-width="1.5"/>`);
    if (idx.has(t)) out.push(`<circle cx="${xOf(i)}" cy="${high ? yOf(candles[i].h) - 9 : yOf(candles[i].l) + 9}" r="3.5" fill="${C.level}"/>`);
  };
  for (const l of sig.levels) level(l.price, l.t, short);
  if (tr) level(tr.tp, tr.tpT, !short);
  // candles
  for (const [i, c] of candles.entries()) {
    const col = c.c >= c.o ? C.up : C.down, x = xOf(i);
    out.push(`<line x1="${x}" x2="${x}" y1="${yOf(c.h)}" y2="${yOf(c.l)}" stroke="${col}" stroke-width="1"/>`);
    const top = yOf(Math.max(c.o, c.c)), h = Math.max(1, yOf(Math.min(c.o, c.c)) - top);
    out.push(`<rect x="${x - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" fill="${col}"/>`);
  }
  // the signal arrow
  const sc = candles[last], ax = xOf(last);
  if (short) { const y = yOf(sc.h) - 8; out.push(`<path d="M${ax - 6} ${y - 10} L${ax + 6} ${y - 10} L${ax} ${y} Z" fill="${C.down}"/>`); }
  else { const y = yOf(sc.l) + 8; out.push(`<path d="M${ax - 6} ${y + 10} L${ax + 6} ${y + 10} L${ax} ${y} Z" fill="${C.up}"/>`); }
  // the trade, to the right of the candles
  if (tr) {
    const x0 = xOf(last + GAP), x1 = xOf(last + GAP + BOX), yE = yOf(tr.entry), yS = yOf(tr.sl), yT = yOf(tr.tp);
    out.push(`<rect x="${x0}" y="${Math.min(yE, yS)}" width="${x1 - x0}" height="${Math.abs(yS - yE)}" fill="${C.risk}" fill-opacity="0.22"/>`);
    out.push(`<rect x="${x0}" y="${Math.min(yE, yT)}" width="${x1 - x0}" height="${Math.abs(yT - yE)}" fill="${C.reward}" fill-opacity="0.18"/>`);
    const line = (y, col, label) => {
      out.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="1.5"/>`);
      out.push(`<line x1="${x1}" x2="${W - PAD.right}" y1="${y}" y2="${y}" stroke="${col}" stroke-width="1" stroke-dasharray="2 3"/>`);
      out.push(`<rect x="${W - PAD.right + 2}" y="${y - 10}" width="${PAD.right - 4}" height="20" rx="3" fill="${col}"/>`);
      out.push(`<text x="${W - PAD.right + 8}" y="${y + 4}" fill="${C.bg}" font-size="12" font-weight="700">${esc(label)}</text>`);
    };
    line(yS, C.risk, `SL ${px(tr.sl)}`);
    line(yT, C.reward, `TP ${px(tr.tp)}`);
    line(yE, C.entry, `Entry ${px(tr.entry)}`);
    out.push(`<text x="${(x0 + x1) / 2}" y="${(yE + yT) / 2 + 5}" fill="${C.text}" font-size="14" font-weight="700" text-anchor="middle">${tr.rr.toFixed(1)}R</text>`);
  }
  // title
  const coin = symbol.replace(/USDT$/, '');
  out.push(`<text x="${PAD.left + 4}" y="32" fill="${short ? C.down : C.up}" font-size="22" font-weight="700">${short ? '▼' : '▲'} ${esc(coin)} ${short ? 'short' : 'long'}</text>`);
  const sub = [`4h swing failure${closeLabel ? ' · ' + closeLabel : ''}`, trend].filter(Boolean).join(' · ');
  out.push(`<text x="${W - PAD.right}" y="32" fill="${C.muted}" font-size="14" text-anchor="end">${esc(sub)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${out.join('')}</svg>`;
}

export function chartPng(opts) {
  const r = new Resvg(chartSvg(opts), { fitTo: { mode: 'width', value: W * 1.5 }, font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } });
  return Buffer.from(r.render().asPng());
}
