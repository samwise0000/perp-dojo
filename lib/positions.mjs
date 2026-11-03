// Open positions from Bybit's /v5/position/list, in USD, plus when each was
// opened (from recent fills) and what it risks if the stop-loss is hit.

const num = x => (x === undefined || x === null || x === '' ? NaN : Number(x));
const opt = x => { const v = num(x); return Number.isFinite(v) && v > 0 ? v : null; };

// P&L in USD for moving `size` from `from` to `to`. Linear size is in coin;
// inverse size is in USD contracts and P&L settles in coin, converted at `to`.
export function movePnl({ inverse, long, size, from, to }) {
  if (!from || !to) return null;
  const dir = long ? 1 : -1;
  return inverse ? size * (1 / from - 1 / to) * dir * to : size * (to - from) * dir;
}

export function normalizePosition(p, category) {
  const inverse = category === 'inverse', long = p.side === 'Buy';
  const size = num(p.size) || 0, entry = num(p.avgPrice) || 0, mark = num(p.markPrice) || 0;
  const liq = opt(p.liqPrice), sl = opt(p.stopLoss), tp = opt(p.takeProfit);
  const upnl = (num(p.unrealisedPnl) || 0) * (inverse ? mark : 1);
  const value = inverse ? size : (num(p.positionValue) || size * entry);
  const leverage = num(p.leverage) || 1;
  // how far the mark is from liquidation, as a share of the mark price
  const liqDistance = liq && mark ? (long ? mark - liq : liq - mark) / mark : null;
  const slLoss = sl ? movePnl({ inverse, long, size, from: entry, to: sl }) : null;
  const tpGain = tp ? movePnl({ inverse, long, size, from: entry, to: tp }) : null;
  // stop-loss measured from where price is now: what you'd still lose from here
  const slFromMark = sl ? movePnl({ inverse, long, size, from: mark, to: sl }) : null;
  return {
    id: `${category}:${p.symbol}:${p.positionIdx ?? 0}`,
    category, symbol: p.symbol, dir: long ? 'Long' : 'Short', side: p.side,
    size, entry, mark, value, leverage, upnl,
    upnlPct: value ? upnl / (value / leverage) : null,      // on margin
    liq, liqDistance, sl, tp, slLoss, tpGain, slFromMark,
    trailing: opt(p.trailingStop),
    realized: (num(p.curRealisedPnl) || 0) * (inverse ? mark : 1),
    positionIdx: Number(p.positionIdx) || 0,
    updatedAt: num(p.updatedTime) || null,
    openedAt: null,
  };
}

// When did the current position start? Walk this market's fills newest first,
// undoing each, until the size before a fill was zero (or the other side).
// Fills that open this side add to it; fills on the other side close it by
// their closedSize. Works in one-way and hedge mode. null = not in these fills.
export function openedAtFrom(fills, pos) {
  let size = pos.size;
  const eps = pos.size * 1e-9;
  for (const f of [...fills].sort((a, b) => b.t - a.t)) {
    const opens = f.side === pos.side ? f.q - Math.min(f.cs, f.q) : 0;
    const closes = f.side !== pos.side ? Math.min(f.cs, f.q) : 0;
    size = size - opens + closes;
    if (opens > 0 && size <= eps) return f.t;
  }
  return null;
}
