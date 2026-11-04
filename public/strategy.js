// The Strategy tab: the whole 4h swing-failure strategy written out, with
// diagrams. Rules that live in code (risk, closes, RSI cut-off, sweep settings)
// are read from it, so the page can't drift from what the alerts and the
// playbook do. Backtest figures are a snapshot (past year to 4 Nov 2026,
// scaling plan, after Bybit fees) and say so on the page.
import { ALERT_SETTINGS, BPLUS_RSI, scalePlan, DEFAULT_PAIRS } from './sfp.js';
import { RISK_PCT, OFF_HOURS, OFF_HOURS_PCT, BPLUS_HOURS, SESSION, SLOTS, MAX_POSITIONS } from './day-playbook.js';
import { zonedToUtc, NY_TZ } from './bias.js';

const AS_OF = '4 Nov 2026';
const pct = v => `${+v.toFixed(2)}%`;
const hh = h => `${String(h).padStart(2, '0')}:00`;
const badge = g => `<span class="sig-grade g-${g.toLowerCase().replace('+', 'plus')}">${g === 'A+' ? '★ A+' : g}</span>`;
const pairs = DEFAULT_PAIRS.split(' ').length;

// today's NY session (8 AM – 5 PM New York) in the viewer's local time
function nyLocal() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number);
  const t = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${t(zonedToUtc(y, m, d, 8, 0))}–${t(zonedToUtc(y, m, d, 17, 0))}`;
}

// ---------- diagrams (inline SVG, coloured by the theme's tokens) ----------

// A short setup on a 4h chart: the swing, its confirmation, the sweep and the trade.
const CANDLES = [[20, 32, 16, 30], [30, 48, 28, 45], [45, 66, 43, 62], [62, 80, 58, 74], [74, 77, 60, 63], [63, 67, 50, 54], [54, 58, 30, 34],
  [34, 45, 30, 42], [42, 52, 40, 50], [50, 56, 46, 52], [52, 62, 50, 60], [60, 68, 58, 66], [66, 73, 63, 72], [72, 84, 68, 69]];
function candlesSvg({ trade = false } = {}) {
  const X = i => 46 + i * 38, Y = p => 268 - p * 2.75, out = [];
  const level = 74, entry = 69, stop = 84, target = 34, sig = CANDLES.length - 1;
  if (trade) {
    out.push(`<rect x="${X(sig) - 14}" y="${Y(stop)}" width="128" height="${Y(entry) - Y(stop)}" class="st-risk"/>`);
    out.push(`<rect x="${X(sig) - 14}" y="${Y(entry)}" width="128" height="${Y(target) - Y(entry)}" class="st-reward"/>`);
  }
  // the level: from the swing candle's body top to the signal
  out.push(`<line x1="${X(3)}" x2="${X(sig) + 112}" y1="${Y(level)}" y2="${Y(level)}" class="st-level"/>`);
  if (trade) out.push(`<line x1="${X(6)}" x2="${X(sig) + 112}" y1="${Y(target)}" y2="${Y(target)}" class="st-level st-level-2"/>`);
  CANDLES.forEach(([o, h, l, c], i) => {
    const up = c >= o, cls = up ? 'st-up' : 'st-down', fade = trade && i < sig && i !== 3 && i !== 6 ? ' st-fade' : '';
    out.push(`<g class="${cls}${fade}"><line x1="${X(i)}" x2="${X(i)}" y1="${Y(h)}" y2="${Y(l)}"/><rect x="${X(i) - 8}" y="${Y(Math.max(o, c))}" width="16" height="${Math.max(2, Math.abs(Y(o) - Y(c)))}" rx="2"/></g>`);
  });
  if (!trade) {
    out.push(`<circle cx="${X(3)}" cy="${Y(level)}" r="4" class="st-dot"/>`);
    out.push(`<text x="${X(3) - 30}" y="${Y(level) - 32}" class="st-note">Swing high: the level is</text><text x="${X(3) - 30}" y="${Y(level) - 18}" class="st-note"><tspan class="st-em">the BODY top</tspan>, not the wick</text>`);
    out.push(`<path d="M${X(4) - 8} ${Y(30) + 26} h${X(6) - X(4) + 16}" class="st-brace"/><text x="${X(5)}" y="${Y(30) + 42}" class="st-note" text-anchor="middle">3 closes confirm it</text>`);
    out.push(`<path d="M${X(3)} 262 H${X(sig)}" class="st-span"/><text x="${(X(3) + X(sig)) / 2}" y="257" class="st-note" text-anchor="middle">at least ${ALERT_SETTINGS.minAge} candles old (a major level)</text>`);
    out.push(`<text x="${X(sig) + 18}" y="${Y(84) + 4}" class="st-note"><tspan class="st-em">Wick sweeps through</tspan></text><text x="${X(sig) + 18}" y="${Y(84) + 18}" class="st-note">by ≥ ${ALERT_SETTINGS.minSweep * 100}%…</text>`);
    out.push(`<text x="${X(sig) + 18}" y="${Y(69) + 12}" class="st-note">…and the 4h <tspan class="st-em">closes back</tspan></text><text x="${X(sig) + 18}" y="${Y(69) + 26}" class="st-note">below: a failed breakout</text>`);
  } else {
    const lab = (y, t, c) => `<text x="${X(sig) + 120}" y="${Y(y) + 4}" class="st-tag ${c}">${t}</text>`;
    out.push(lab(stop, 'Stop · the wick', 'neg'), lab(entry, 'Entry · the 4h close', ''), lab(target, 'Target · opposing level', 'pos'));
    out.push(`<text x="${X(6) + 12}" y="${Y(target) + 18}" class="st-note">where the move into the sweep started (the lowest body)</text>`);
    out.push(`<text x="${X(sig) + 50}" y="${(Y(stop) + Y(entry)) / 2 + 4}" class="st-zone" text-anchor="middle">1R</text>`);
    out.push(`<text x="${X(sig) + 50}" y="${(Y(entry) + Y(target)) / 2 + 4}" class="st-zone" text-anchor="middle">${((entry - target) / (stop - entry)).toFixed(1)}R</text>`);
  }
  return `<svg viewBox="0 0 ${trade ? 860 : 700} 280" class="st-svg" role="img" aria-label="${trade ? 'The trade: entry at the close, stop at the wick, target at the opposing level' : 'Anatomy of a swing failure short'}">${out.join('')}</svg>`;
}

// The grade as a decision tree.
function treeSvg() {
  const box = (x, y, w, t, cls = 'q') => {
    const lines = t.split('\n');
    return `<g class="st-node ${cls}"><rect x="${x}" y="${y - 10 - lines.length * 8}" width="${w}" height="${20 + lines.length * 16}" rx="10"/>${lines.map((l, i) => `<text x="${x + w / 2}" y="${y + 4 - (lines.length - 1) * 8 + i * 16}" text-anchor="middle">${l}</text>`).join('')}</g>`;
  };
  const gk = g => 'g-' + g.toLowerCase().replace('+', 'plus');
  const leaf = (x, y, g, sub, w = 104) => `<g class="st-leaf ${gk(g)}"><rect x="${x}" y="${y - 20}" width="${w}" height="${sub ? 44 : 38}" rx="12"/><text x="${x + w / 2}" y="${y + (sub ? 0 : 5)}" text-anchor="middle" class="st-leaf-g">${g === 'A+' ? '★ A+' : g}</text>${sub ? `<text x="${x + w / 2}" y="${y + 16}" text-anchor="middle" class="st-leaf-s">${sub}</text>` : ''}</g>`;
  // a curved arrow, with its yes/no label placed by hand so it never sits on a line
  const arrow = (x1, y1, x2, y2, t, tx, ty, anchor = 'middle') => `<path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2 - 3} ${y2}" class="st-edge"/>${t ? `<text x="${tx}" y="${ty}" class="st-edge-t ${t}" text-anchor="${anchor}">${t}</text>` : ''}`;
  return `<svg viewBox="0 0 856 350" class="st-svg st-tree" role="img" aria-label="How a setup is graded">
    <defs><marker id="stArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="st-arrowhead"/></marker></defs>
    ${arrow(118, 160, 140, 160)}
    <path d="M201 186 V266" class="st-edge"/><text x="210" y="232" class="st-edge-t no">no</text>
    ${arrow(262, 160, 290, 160, 'yes', 276, 150)}
    ${arrow(412, 150, 450, 78, 'no', 424, 100, 'end')}
    ${arrow(412, 170, 450, 242, 'yes', 424, 228, 'end')}
    ${arrow(572, 66, 610, 36, 'yes', 586, 36, 'end')}
    ${arrow(572, 90, 610, 112, 'no', 586, 122, 'end')}
    ${arrow(572, 230, 610, 196, 'yes', 586, 198, 'end')}
    ${arrow(572, 254, 610, 284, 'no', 586, 290, 'end')}
    ${arrow(738, 274, 772, 246, 'yes', 754, 248, 'end')}
    ${arrow(738, 294, 772, 322, 'no', 754, 330, 'end')}
    ${box(10, 160, 108, 'A swing failure\nat the 4h close', 'start')}
    ${box(140, 160, 122, 'With yesterday’s\nNY bias?')}
    ${box(290, 160, 122, 'NY session\nopen right now?')}
    ${box(450, 78, 122, 'Did BTC sweep\nthe same way?')}
    ${box(450, 242, 122, 'Did BTC sweep\nthe same way?')}
    ${box(610, 284, 128, `4h RSI < ${BPLUS_RSI} (long)\nor > ${100 - BPLUS_RSI} (short)?`, 'q small')}
    ${leaf(610, 36, 'A+', 'the best')}
    ${leaf(610, 112, 'A', 'trade it')}
    ${leaf(610, 196, 'A', 'trade it')}
    ${leaf(772, 246, 'B+', '', 74)}
    ${leaf(772, 322, 'B', '', 74)}
    ${leaf(149, 290, 'C', 'avoid')}
  </svg>`;
}

// The scaling plan on a long that runs to a 6R target.
function scaleSvg() {
  const Y = r => 250 - r * 34;
  const be = (0 * 1 + 1 * 1 + 2 * 0.5) / 2.5;
  const path = [[40, 0], [80, 0.55], [110, 0.25], [160, 1], [190, 0.65], [240, 1.5], [268, 1.15], [320, 2], [350, 1.55], [410, 3.2], [440, 2.75], [510, 4.6], [540, 4.15], [600, 6]];
  const lines = [[-1, 'Stop −1R', 'neg'], [0, 'Entry', ''], [1, '+1R', ''], [2, '+2R', ''], [6, 'Target +6R', 'pos']];
  return `<svg viewBox="0 0 720 290" class="st-svg" role="img" aria-label="The scaling plan">
    ${lines.map(([r, t, c]) => `<line x1="30" x2="610" y1="${Y(r)}" y2="${Y(r)}" class="st-grid ${c}"/><text x="618" y="${Y(r) + 4}" class="st-tag ${c}">${t}</text>`).join('')}
    <path d="M40 ${Y(-1)} H160 V${Y(0)} H320 V${Y(be)} H600" class="st-stop"/>
    <text x="50" y="${Y(-1) - 6}" class="st-note neg">stop</text><text x="200" y="${Y(0) + 14}" class="st-note neg">stop → entry</text><text x="360" y="${Y(be) + 14}" class="st-note neg">stop → whole-position break-even (≈ +${be.toFixed(1)}R)</text>
    <polyline points="${path.map(([x, r]) => `${x},${Y(r)}`).join(' ')}" class="st-price"/>
    ${[[40, 0, 'Entry', '1 unit'], [160, 1, 'Add 1', '+1 unit'], [320, 2, 'Add 2', '+½ unit']].map(([x, r, t, s]) => `<g class="st-add"><circle cx="${x}" cy="${Y(r)}" r="6"/><text x="${x}" y="${Y(r) - 26}" text-anchor="middle" class="st-add-t">${t}</text><text x="${x}" y="${Y(r) - 12}" text-anchor="middle" class="st-note">${s}</text></g>`).join('')}
    <circle cx="600" cy="${Y(6)}" r="6" class="st-dot pos"/>
  </svg>`;
}

// The week: which closes take which grades, at what risk.
function weekGrid() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], idx = [1, 2, 3, 4, 5, 6, 0];
  const closes = [...SESSION, ...OFF_HOURS];
  const cell = (d, h) => {
    const i = SESSION.indexOf(h);
    if (i >= 0) {
      const q = SLOTS[d][i];
      return q === 'weak' ? ['weak', 'Weak', 'A+ / A at half size'] : q === 'prime' ? ['prime', 'Prime', `A+ ${pct(RISK_PCT['A+'])} · A ${pct(RISK_PCT.A)}`] : ['ok', 'OK', `A+ ${pct(RISK_PCT['A+'])} · A ${pct(RISK_PCT.A)}`];
    }
    // a late close counts on the weekday it closes: 20:00 is the same day, 00:00 and 04:00 the next
    const day = h === 20 ? d : (d + 1) % 7;
    if (day < 1 || day > 4) return ['off', '—', 'no new trades'];
    return ['late', 'Late', BPLUS_HOURS.includes(h) ? `A+ · B+ at ${pct(OFF_HOURS_PCT)}` : `A+ only · ${pct(OFF_HOURS_PCT)}`];
  };
  const head = `<div class="st-wk-h"></div>${closes.map((h, i) => `<div class="st-wk-h${i === SESSION.length ? ' st-wk-gap' : ''}">${hh(h)}${i >= SESSION.length && h !== 20 ? '<small>next day</small>' : ''}</div>`).join('')}`;
  const rows = idx.map((d, r) => `<div class="st-wk-d">${days[r]}</div>${closes.map((h, i) => { const [c, t, s] = cell(d, h); return `<div class="st-wk-c ${c}${i === SESSION.length ? ' st-wk-gap' : ''}" title="${days[r]} ${hh(h)}: ${s}"><b>${t}</b><span>${s}</span></div>`; }).join('')}`).join('');
  return `<div class="st-wk-wrap"><div class="st-wk">${head}${rows}</div></div>`;
}

// ---------- grades ----------
const GRADES = [
  { g: 'A+', title: 'Everything lines up', checks: [1, 1, 1, null],
    means: 'The setup goes the same way as yesterday’s New York session, today’s session isn’t running, and BTC printed its own swing failure in the same direction on the same 4h candle. The whole market is rejecting the same way at the same moment.',
    stats: [['+1.73R', 'a trade after fees, all closes'], ['49%', 'reached the target'], ['~3', 'a month: rare']],
    trade: () => `Full plan at ${pct(RISK_PCT['A+'])} on the main closes (half on a weak one). Also at ${pct(OFF_HOURS_PCT)} at the 20:00, 00:00 and 04:00 closes, Mon–Thu.` },
  { g: 'A', title: 'With the bias', checks: [1, 1, 0, null], alt: [1, 0, 1, null],
    means: 'With yesterday’s NY bias while today’s session is closed, but BTC didn’t sweep with it. Or: with the bias while the session is open, but BTC swept the same way, which confirms the bias is still alive.',
    stats: [['+0.61R', 'a trade after fees, all closes'], ['+2.20R', 'A/A+ at the main closes, Mon–Thu'], ['~1 in 12', 'runs to 5R or more']],
    trade: () => `Full plan at ${pct(RISK_PCT.A)} on the main closes (half on a weak one). Not at the late closes.` },
  { g: 'B+', title: 'A stretched B', checks: [1, 0, 0, 1],
    means: `A B setup (below) where the pair’s 4h RSI(14) at the close is stretched the trade’s way: under ${BPLUS_RSI} for a long, over ${100 - BPLUS_RSI} for a short. The move into the level has run far enough that a failure there tends to stick.`,
    stats: [['+1.61R', `a trade at ${BPLUS_HOURS.map(hh).join(' / ')}, Mon–Thu`], ['+0.59R', 'a trade, all closes'], ['−0.62R', 'at 20:00: skipped']],
    trade: () => `Only at the ${BPLUS_HOURS.map(hh).join(' and ')} closes, Mon–Thu, at ${pct(OFF_HOURS_PCT)}, full plan. Tracking size until the forward test confirms it.` },
  { g: 'B', title: 'Bias may be going stale', checks: [1, 0, 0, 0],
    means: 'With yesterday’s bias, but today’s NY session is open and could be turning the other way, and nothing else (BTC sweep, stretched RSI) backs it up. B only happens while New York trades, which is outside your main closes.',
    stats: [['−0.18R', 'a trade after fees, all closes'], ['−0.41R', 'at the late closes'], ['26%', 'reached the target']],
    trade: () => 'Be cautious: it lost money in the backtest. Monitor it; the playbook suggests no risk for it. Cutting B trades early made them worse, not better.' },
  { g: 'C', title: 'Against the bias', checks: [0, null, null, null],
    means: 'Against yesterday’s NY bias, or no bias to go by. Before fees these break even; after fees they lose. Every filter tried on top failed to rescue them.',
    stats: [['−0.14R', 'a trade after fees, all closes'], ['−0.22R', 'at the main closes'], ['≈ 0R', 'before fees: no edge']],
    trade: () => 'Mostly avoid. They stay logged in Signals and the alerts, so you can spot something the grade misses.' },
];
const CHECK_NAMES = ['With yesterday’s NY bias', 'NY session closed', 'BTC swept the same way', `4h RSI stretched (< ${BPLUS_RSI} / > ${100 - BPLUS_RSI})`];
const mark = v => (v === 1 ? '<i class="yes">✓</i>' : v === 0 ? '<i class="no">✗</i>' : '<i class="any">·</i>');
function gradeCard({ g, title, checks, alt, means, stats, trade }) {
  const ck = row => `<ul class="st-checks">${CHECK_NAMES.map((n, i) => `<li>${mark(row[i])}<span>${n}</span></li>`).join('')}</ul>`;
  return `<article class="st-grade g-${g.toLowerCase().replace('+', 'plus')}">
    <header>${badge(g)}<h3>${title}</h3></header>
    <p>${means}</p>
    <div class="st-grade-cols">
      <div>${ck(checks)}${alt ? `<p class="st-or">or</p>${ck(alt)}` : ''}</div>
      <dl class="st-stats">${stats.map(([v, l]) => `<div><dt>${v}</dt><dd>${l}</dd></div>`).join('')}</dl>
    </div>
    <p class="st-how"><b>How to trade it:</b> ${trade()}</p>
  </article>`;
}
const MATRIX = `<table class="data compact st-matrix"><thead><tr><th>Grade</th>${CHECK_NAMES.map(n => `<th>${n}</th>`).join('')}<th>Risk</th></tr></thead><tbody>
  <tr><td>${badge('A+')}</td><td>✓</td><td>✓</td><td>✓</td><td>·</td><td>${pct(RISK_PCT['A+'])}</td></tr>
  <tr><td>${badge('A')}</td><td>✓</td><td>✓</td><td>✗</td><td>·</td><td>${pct(RISK_PCT.A)}</td></tr>
  <tr><td>${badge('A')}</td><td>✓</td><td>✗</td><td>✓</td><td>·</td><td>${pct(RISK_PCT.A)}</td></tr>
  <tr><td>${badge('B+')}</td><td>✓</td><td>✗</td><td>✗</td><td>✓</td><td>${pct(OFF_HOURS_PCT)}, late closes</td></tr>
  <tr><td>${badge('B')}</td><td>✓</td><td>✗</td><td>✗</td><td>✗</td><td>monitor</td></tr>
  <tr><td>${badge('C')}</td><td>✗</td><td>·</td><td>·</td><td>·</td><td>avoid</td></tr>
</tbody></table><p class="muted small">✓ must be true · ✗ must be false · · doesn’t matter</p>`;

const TESTED = [
  ['BTC’s 4h trend instead of the NY bias', 'Much worse. The NY close is the better read on direction.'],
  ['Cutting B trades early when price stalls', 'Made them lose more: the few that recover pay for the rest.'],
  ['Minor swing highs from impulses as levels', 'Not robust. Only major levels (10+ candles old, at the range edge).'],
  ['Calling the day off once the NY low breaks', 'Removed good trades with the bad. Not worth it.'],
  ['15m SMT against BTC as a confluence', 'Hurt results.'],
  ['Skipping trades when BTC rejects a level against you', 'Worked at 0.5%, reversed at 1%: noise.'],
  ['RSI on A / A+', 'Over-extended (< 30 / > 70) is the worst group. Not used.'],
  ['A 1:1 target for B and C', 'Doubles the hit rate, still loses after fees. B+ loses its edge.'],
  ['Rescuing C (BTC sweep, R:R, RSI, BOS entries)', 'Nothing holds in both halves of the year.'],
  ['Smaller first entry, heavier adds later', 'Halves the losses but also the runners. Worse per unit of drawdown.'],
  ['Both adds on a 15m break of structure', 'The one promising change: smaller drawdown, same return. Forward-testing it.'],
];

export function renderStrategy(root) {
  if (root.dataset.built) return;
  root.dataset.built = '1';
  const S = ALERT_SETTINGS;
  root.innerHTML = `
  <div class="card c12 st-hero">
    <div class="kicker">The strategy</div>
    <h2>4h swing failures, graded by the New York session</h2>
    <p class="st-lede">Price runs a major 4h high or low, then the candle closes back inside: the breakout failed, and the stops behind the level were the fuel. You enter at that close, stop at the wick, and target where the move started. Each setup is graded by whether yesterday’s New York session, BTC and momentum agree with it. Only the good grades, at the good hours, get real risk, and the winners are left alone to run.</p>
    <div class="st-kpis">
      <div><b>${pairs}</b><span>pairs watched</span></div>
      <div><b>+2.20R</b><span>avg A/A+ trade, main closes</span></div>
      <div><b>24%</b><span>hit the target</span></div>
      <div><b>1 in 12</b><span>runs 5R or more</span></div>
    </div>
    <nav class="st-toc" aria-label="On this page">${[['st-setup', 'The setup'], ['st-trade', 'The trade'], ['st-grades', 'Grades'], ['st-when', 'When'], ['st-risk', 'Risk'], ['st-scale', 'Scaling in'], ['st-manage', 'Managing'], ['st-tested', 'What we tested'], ['st-honest', 'Caveats']].map(([id, t], i) => `<a href="#strategy" data-to="${id}"><i>${i + 1}</i>${t}</a>`).join('')}</nav>
  </div>

  <section id="st-setup" class="card c12 accented st-sec" style="--a: var(--a2)">
    <div class="kicker">1 · The setup</div>
    <h2>A swing failure (SFP)</h2>
    <div class="st-fig">${candlesSvg()}</div>
    <div class="st-cols">
      <div><h3>The level</h3><ul class="st-list">
        <li>A <b>swing high or low</b> on the 4h: a candle with ${S.left} candles on each side that don’t reach it.</li>
        <li>The level is that candle’s <b>body</b> top (or bottom), not the wick.</li>
        <li>It counts once ${S.right} candles have <b>closed</b> after it, and only when it’s at least <b>${S.minAge} candles old</b>, so it’s a level people have been watching.</li>
        <li>Levels from the last <b>${S.lookbackDays} days</b>, in the <b>outer ${S.edge * 100}%</b> of the last ${S.rangeDays} days’ range. A level in the middle of the range isn’t a real extreme.</li>
      </ul></div>
      <div><h3>The signal</h3><ul class="st-list">
        <li>A 4h candle <b>wicks through</b> the level by at least ${S.minSweep * 100}%…</li>
        <li>…and <b>closes back inside</b> it. A long under a low, a short over a high.</li>
        <li>Only on the 4h <b>close</b>. The alert’s heads-up 5 minutes before is a warning, not an entry.</li>
        <li>A level that closes beyond is broken and gone. Each level gives <b>one signal</b>; a level that keeps failing isn’t counted twice.</li>
        <li>Several levels swept at once give one setup.</li>
      </ul></div>
    </div>
  </section>

  <section id="st-trade" class="card c12 accented st-sec" style="--a: var(--a3)">
    <div class="kicker">2 · The trade</div>
    <h2>Entry, stop, target</h2>
    <div class="st-fig">${candlesSvg({ trade: true })}</div>
    <div class="st-three">
      <div class="st-pill"><b>Entry</b><span>At the signal candle’s close. No waiting for a retest: the best runners never come back.</span></div>
      <div class="st-pill neg"><b>Stop</b><span>Just beyond the signal candle’s wick. That distance is 1R, your risk.</span></div>
      <div class="st-pill pos"><b>Target</b><span>The <b>opposing level</b>: the most extreme opposite swing body between the swept swing and the signal, where the move into the sweep started.</span></div>
    </div>
    <p class="muted small">If one candle touches both the stop and the target, the backtest counts it as a loss.</p>
  </section>

  <section id="st-grades" class="card c12 accented st-sec" style="--a: var(--a1)">
    <div class="kicker">3 · Grades</div>
    <h2>How every setup is graded</h2>
    <p>The edge comes from trading <b>with the market’s direction</b>, and the best read on that turned out to be yesterday’s New York session on BTC. Each setup gets a grade from four questions:</p>
    <div class="st-defs">
      <div><b>NY bias</b><span>Bullish if BTC’s last New York session (8 AM–5 PM New York, ${nyLocal()} your time today) closed above where it opened, bearish if below. Weekends have no session, so Monday uses Friday’s.</span></div>
      <div><b>NY session open</b><span>While New York is trading, today’s session could be turning the other way, so yesterday’s bias may be going stale.</span></div>
      <div><b>BTC swept</b><span>BTC printed its own swing failure, by the same rules, in the same direction on the same 4h candle. The whole market is rejecting together.</span></div>
      <div><b>RSI stretched</b><span>The pair’s 4h RSI(14) at the close is under ${BPLUS_RSI} for a long or over ${100 - BPLUS_RSI} for a short. Only used to split B into B+ and B.</span></div>
    </div>
    <div class="st-fig st-scroll">${treeSvg()}</div>
    <div class="table-wrap">${MATRIX}</div>
    <div class="st-grades">${GRADES.map(gradeCard).join('')}</div>
    <p class="muted small">Grade figures: past year to ${AS_OF}, ${pairs} pairs, with the scaling plan, after Bybit fees. The Signals tab has the live numbers per grade.</p>
  </section>

  <section id="st-when" class="card c12 accented st-sec" style="--a: var(--a5)">
    <div class="kicker">4 · When</div>
    <h2>The closes you trade</h2>
    <p>The same setup does very differently by hour and weekday. Most of the profit came from the <b>08:00, 12:00 and 16:00 closes, Monday to Thursday</b> (your time). Outside those, A/A+ trades lost money overall (−0.30R a trade over 529). Only a few setups are taken there, at tracking size.</p>
    ${weekGrid()}
    <div class="st-legend"><span class="prime">Prime</span> the best close <span class="ok">OK</span> positive <span class="weak">Weak</span> lost money: half size, skip B <span class="late">Late</span> tracking size only <span class="off">—</span> no new trades</div>
    <p class="muted small">No new trades between closes. Late closes count on the day they close: Monday 00:00 is in, Friday 00:00 is out.</p>
  </section>

  <section id="st-risk" class="card c6 accented st-sec" style="--a: var(--a4)">
    <div class="kicker">5 · Risk</div>
    <h2>Size by grade</h2>
    <div class="table-wrap"><table class="data compact st-risk-t"><thead><tr><th>Grade</th><th>Main closes</th><th>Weak close</th><th>Late closes (Mon–Thu)</th></tr></thead><tbody>
      <tr><td>${badge('A+')}</td><td>${pct(RISK_PCT['A+'])}</td><td>${pct(RISK_PCT['A+'] / 2)}</td><td>${pct(OFF_HOURS_PCT)}</td></tr>
      <tr><td>${badge('A')}</td><td>${pct(RISK_PCT.A)}</td><td>${pct(RISK_PCT.A / 2)}</td><td>—</td></tr>
      <tr><td>${badge('B+')}</td><td>—</td><td>—</td><td>${pct(OFF_HOURS_PCT)} at ${BPLUS_HOURS.map(hh).join(' / ')}</td></tr>
      <tr><td>${badge('B')}</td><td>—</td><td>—</td><td>monitor</td></tr>
      <tr><td>${badge('C')}</td><td>—</td><td>—</td><td>avoid</td></tr>
    </tbody></table></div>
    <ul class="st-list">
      <li>Risk is the loss <b>to the stop</b>, as a share of your equity. Size the position from it: the trade guide on each signal does the maths.</li>
      <li>At most <b>${MAX_POSITIONS} positions</b> open. Alts often signal together on one close and all move with BTC, so they’re really one bet.</li>
      <li>Never move a stop further away, never average down.</li>
    </ul>
  </section>

  <section id="st-scale" class="card c6 accented st-sec" style="--a: var(--a3)">
    <div class="kicker">6 · Scaling in</div>
    <h2>Add to winners, never to losers</h2>
    <ol class="st-steps">
      <li><b>Entry</b> at the close, 1 unit, stop at the wick.</li>
      <li><b>At +1R</b> add the same size. Move <b>all</b> stops to your entry.</li>
      <li><b>At +2R</b> add half size. Move all stops to the <b>whole position’s break-even</b> (its average entry, plus ~0.15% for fees).</li>
      <li><b>All out at the target.</b> Adds the target comes before are skipped.</li>
    </ol>
    <p class="muted small">Each add risks 1R back to the entry, so a trade that reaches +2R can no longer lose.</p>
  </section>

  <div class="card c12 st-sec st-figcard"><div class="st-fig st-scroll">${scaleSvg()}</div><p class="st-cap">A long that runs to a 6R target. With the adds it makes <b>+${scalePlan({ entry: 100, sl: 99, tp: 106 }, 'Long').R.toFixed(0)}R</b> at the target, against +6R on the entry alone. After Add 2 the stop sits at the whole position’s break-even, so a pullback from there costs nothing.</p></div>

  <section id="st-manage" class="card c12 accented st-sec" style="--a: var(--a2)">
    <div class="kicker">7 · Managing the trade</div>
    <h2>Don’t touch it</h2>
    <div class="st-cols">
      <div>
        <p>This is a <b>low hit rate, big winner</b> strategy. About three in four A/A+ trades stop out or scratch. The rest pay for everything, and a handful pay for the year:</p>
        <div class="st-bar" role="img" aria-label="15 of 370 trades made 789R of 814R">
          <div class="st-bar-row"><span>15 trades (4%)</span><i style="--w: 97%" class="pos"></i><b>789R</b></div>
          <div class="st-bar-row"><span>the other 355</span><i style="--w: 3%"></i><b>25R</b></div>
        </div>
        <p class="muted small">Past year, A/A+ at the main closes, with the plan, after fees: 370 trades, 814R. The biggest single trade made 155R.</p>
      </div>
      <div><ul class="st-list">
        <li><b>Set the stop and target, then leave it.</b> The only changes are the plan’s adds and stop moves.</li>
        <li><b>Don’t take profit early.</b> The median trade lasts 8 hours, but 20R+ runners take about <b>2.7 days</b>.</li>
        <li><b>Hold through the weekend.</b> Trades already open going into it were the biggest winners. Just don’t open new ones then.</li>
        <li><b>Expect losing streaks.</b> Losing days are normal and a 5R+ runner only comes about 1 trade in 12, so skipping trades after a few losses is how you miss the one that pays.</li>
      </ul></div>
    </div>
  </section>

  <section id="st-tested" class="card c12 accented st-sec" style="--a: var(--a5)">
    <div class="kicker">8 · What we tested</div>
    <h2>Ideas that didn’t make the cut</h2>
    <div class="st-tested">${TESTED.map(([a, b], i) => `<div class="${i === TESTED.length - 1 ? 'maybe' : ''}"><b>${a}</b><span>${b}</span></div>`).join('')}</div>
  </section>

  <section id="st-honest" class="card c12 accented st-sec" style="--a: var(--neg)">
    <div class="kicker">9 · Caveats</div>
    <h2>What could make this wrong</h2>
    <div class="st-cols">
      <ul class="st-list">
        <li><b>Tuned on the same year it’s scored on.</b> The grades, hours and filters were picked after seeing this data. Live results usually come in well under a backtest.</li>
        <li><b>Outliers.</b> Without its 15 biggest winners, the strategy is about break-even. A year without big alt runs would be flat or down.</li>
      </ul>
      <ul class="st-list">
        <li><b>Fills.</b> The backtest fills exactly at the close, the stop and each add. Thin coins in a squeeze will fill worse.</li>
        <li><b>The plan:</b> forward-test about 100 trades at small size before going to full risk. The goal is to see the runners actually come, and that you hold them.</li>
      </ul>
    </div>
  </section>`;
  // the contents links scroll within the page (the hash stays #strategy)
  root.querySelectorAll('.st-toc a').forEach(a => (a.onclick = e => { e.preventDefault(); root.querySelector('#' + a.dataset.to)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }));
}
