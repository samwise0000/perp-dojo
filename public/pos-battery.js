// The open position's progress as a battery: one block per R from the entry to the
// target (a checkered finish block), lit up to where the trade is, with the 1R at risk to its left.
// The plan's adds (at +1R and +2R) sit as chips on the line above.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmtR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r) >= 10 ? Math.abs(r).toFixed(0) : Math.abs(r).toFixed(1).replace(/\.0$/, '')}R`;

// R from the entry against the stop (when the stop is still on the far side of the entry), and the target in R
export function rOf(p) {
  const d = p.dir === 'Long' ? 1 : -1, risk = p.sl ? d * (p.entry - p.sl) : null;
  if (!(risk > 0)) return null;
  const now = d * (p.mark - p.entry) / risk, tpR = p.tp ? d * (p.tp - p.entry) / risk : null;
  return { now, tpR };
}

// the battery for an open position, or null when there's no R to measure (no stop, or the stop past the entry)
export function batteryBody(p) {
  const r = rOf(p);
  const box = el('div', 'bat');
  if (!r) {
    box.append(el('p', 'bat-none', p.sl ? '🛡 Stop at or past the entry: the trade is protected, there’s no R left to lose.' : 'No stop set: set one to see the trade in R.'));
    return box;
  }
  const tpR = r.tpR ?? Math.max(3, Math.ceil(r.now) + 1), n = Math.max(1, Math.ceil(tpR));
  // the line above: R now of the target, and the adds as chips
  const line = el('div', 'bat-line');
  line.append(el('b', 'bat-r ' + (r.now >= 0 ? 'pos' : 'neg'), fmtR(r.now)), el('span', 'bat-of', `of ${fmtR(tpR)} target`));
  const adds = el('span', 'bat-adds');
  for (const [at, name, what] of [[1, 'Add 1', 'add the same size, stops to entry'], [2, 'Add 2', 'add half, stops to break-even']]) {
    if (at >= tpR) continue;
    const c = el('span', 'bat-add' + (r.now >= at ? ' done' : ''));
    c.append(el('i', '', r.now >= at ? '✓' : '◇'), `${name} `, el('small', '', fmtR(at)));
    c.title = `${name} at ${fmtR(at)}: ${what}`;
    adds.append(c);
  }
  line.append(adds);
  // the blocks: the 1R at risk, then one per R up to the bullseye
  const cells = el('div', 'bat-cells');
  const risk = el('span', 'cell risk' + (r.now < 0 ? ' lit' : '')); risk.style.setProperty('--f', Math.min(1, Math.max(0, -r.now))); risk.title = 'the 1R at risk';
  cells.append(risk);
  for (let i = 0; i < n; i++) {
    const c = el('span', 'cell' + (i === n - 1 ? ' tp' : '') + (i + 1 <= 2 && i + 1 < tpR ? ' add' : ''));
    const f = Math.max(0, Math.min(1, r.now - i));
    if (f > 0) { c.classList.add('lit'); c.style.setProperty('--f', f); }
    c.title = i === n - 1 ? `the target, ${fmtR(tpR)}` : `${fmtR(i)} → ${fmtR(i + 1)}`;
    cells.append(c);
  }
  box.append(line, cells);
  return box;
}

// with nothing open: the last trade, closed — its result and how it went
export function lastTradeBody(t, { money, price, hidden, fmtDuration, when }) {
  const box = el('div', 'bat bat-last');
  const head = el('div', 'bat-line');
  const long = t.dir === 'Long', move = (long ? 1 : -1) * ((t.exit - t.entry) / t.entry);
  head.append(el('span', 'bat-kick', 'No open positions · last trade'), el('span', 'muted small', when(t.time)));
  const row = el('div', 'bat-lrow');
  const name = el('div', 'bat-lname'); name.append(el('b', '', t.symbol.replace(/USDT$/, '')), el('span', 'pos-side ' + (long ? 'long' : 'short'), `${t.dir}${t.leverage ? ' ' + t.leverage + '×' : ''}`));
  const res = el('b', 'bat-lres ' + (hidden ? 'masked' : t.pnl >= 0 ? 'pos' : 'neg'), hidden ? '$••••' : money(t.pnl));
  const cell = (k, v) => { const c = el('div', 'pos-cell'); c.append(el('span', 'kicker', k), el('span', 'num', v)); return c; };
  row.append(name, res, cell('Entry → exit', `${price(t.entry)} → ${price(t.exit)}`), cell('Move', `${move >= 0 ? '+' : '−'}${Math.abs(move * 100).toFixed(2)}%`), cell('Held', t.duration ? fmtDuration(t.duration) : '—'));
  box.append(head, row, el('p', 'bat-none', 'Open a trade and it shows here as a battery: one block per R up to its target.'));
  return box;
}

// a position note's topic, for the colour of its edge (a warning stays amber whatever it's about)
export const noteTopic = t => (/NY bias|NY flipped|NY session/.test(t) ? 't-bias' : /R:|stop at|protected|first add/.test(t) ? 't-plan' : /Held|stop-out window/.test(t) ? 't-time' : /weekend|Weekend|Thursday/.test(t) ? 't-week' : /BTC broke|BTC breaks|Tip:/.test(t) ? 't-btc' : /Risking/.test(t) ? 't-size' : '');
