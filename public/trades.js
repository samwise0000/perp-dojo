// Turns Bybit closed-P&L records into report-ready trades, all money in USD.
//
// Bybit's closedPnl is the net result of a close: price P&L minus the opening
// and closing fees minus funding paid while the position was open. The API
// doesn't return funding per close, so it's derived as what is left over:
//   funding = price P&L − fees − closedPnl      (positive = paid)
// Inverse contracts settle in the coin; those amounts are converted to USD at
// the exit price, which is close enough for a report.

const num = x => (x === undefined || x === null || x === '' ? NaN : Number(x));
const or0 = x => (Number.isFinite(x) ? x : 0);

export function settleCoin(category, symbol) {
  if (category === 'inverse') return symbol.replace(/USD.*$/, '');
  return symbol.includes('USDT') ? 'USDT' : 'USDC';
}

// `closingSide` is the side of the order that closed the position: a Sell closes a long.
export function normalize(r, category, { flipSides = false } = {}) {
  const inverse = category === 'inverse';
  let long = r.side === 'Sell';
  if (flipSides) long = !long;
  const dir = long ? 1 : -1;
  const entryV = or0(num(r.cumEntryValue)), exitV = or0(num(r.cumExitValue));
  // linear values are in quote currency; inverse values are in coin, which moves the other way
  const gross = (inverse ? entryV - exitV : exitV - entryV) * dir;
  const net = or0(num(r.closedPnl));
  const hasFees = Number.isFinite(num(r.openFee)) || Number.isFinite(num(r.closeFee));
  const fees = hasFees ? or0(num(r.openFee)) + or0(num(r.closeFee)) : gross - net;
  const funding = hasFees ? gross - fees - net : null;
  const exit = or0(num(r.avgExitPrice));
  const usd = inverse ? exit : 1;
  const size = or0(num(r.closedSize));
  const notional = inverse ? size : entryV;   // inverse contracts are quoted in USD already
  const leverage = or0(num(r.leverage)) || 1;
  return {
    id: `${category}:${r.orderId}:${r.updatedTime}`,
    category,
    symbol: r.symbol,
    coin: settleCoin(category, r.symbol),
    dir: long ? 'Long' : 'Short',
    size,
    entry: or0(num(r.avgEntryPrice)),
    exit,
    leverage,
    orderType: r.orderType || '',
    execType: r.execType || 'Trade',
    liquidation: r.execType === 'BustTrade',
    adl: r.execType === 'AdlTrade',
    time: Number(r.updatedTime) || Number(r.createdTime),
    pnl: net * usd,
    gross: gross * usd,
    fees: fees * usd,
    funding: funding === null ? null : funding * usd,
    notional,
    margin: notional / leverage,
  };
}

// Sanity check on what `side` means. With the right reading, the leftover
// (funding) is small next to the price move; with the wrong one it's about
// twice the price move. If most trades say we have it backwards, flip.
export function sidesLookFlipped(raw) {
  let votes = 0, flipped = 0;
  for (const { r, category } of raw) {
    const a = normalize(r, category), b = normalize(r, category, { flipSides: true });
    if (a.funding === null || Math.abs(a.gross) < 1e-9) continue;
    votes++;
    if (Math.abs(b.funding) < Math.abs(a.funding)) flipped++;
  }
  return votes >= 5 && flipped / votes > 0.8;
}

// When was each closed position opened? Bybit's closed P&L only has the close,
// so this replays fills in time order and keeps a book per market and side:
// a fill's closedSize reduces the opposite side, the rest adds to its own side.
// That reading works in one-way and hedge mode, including flips through zero.
// Returns Map(closing orderId → openedAt). A close whose position opened before
// the fills we have gets no entry, so its hold time stays unknown.
export function openTimes(execs) {
  const fills = Object.values(execs || {}).sort((a, b) => a.t - b.t);
  const book = new Map(), out = new Map();
  const key = (f, side) => `${f.c}:${f.s}:${side}`;
  for (const f of fills) {
    const closes = f.side === 'Buy' ? 'Short' : 'Long', opens = f.side === 'Buy' ? 'Long' : 'Short';
    const closed = Math.min(f.cs || 0, f.q);
    if (closed > 0) {
      const b = book.get(key(f, closes));
      if (b) {
        if (!out.has(f.o)) out.set(f.o, b.openedAt);
        b.size -= closed;
        if (b.size <= b.peak * 1e-9) book.delete(key(f, closes));
      }
    }
    const opened = f.q - closed;
    if (opened > 0) {
      const b = book.get(key(f, opens));
      if (b) { b.size += opened; b.peak = Math.max(b.peak, b.size); }
      else book.set(key(f, opens), { size: opened, peak: opened, openedAt: f.t });
    }
  }
  return out;
}

export function normalizeAll(rawById, execs) {
  const raw = Object.values(rawById);
  const flipSides = sidesLookFlipped(raw);
  const opened = openTimes(execs);
  const trades = raw.map(({ r, category }) => {
    const t = normalize(r, category, { flipSides });
    const at = opened.get(r.orderId);
    t.openedAt = at ?? null;
    t.duration = at !== undefined && t.time >= at ? t.time - at : null;
    return t;
  });
  trades.sort((a, b) => a.time - b.time);
  return { trades, flipSides };
}
