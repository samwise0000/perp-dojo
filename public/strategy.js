// The Strategy tab: the whole 4h swing-failure strategy written out, with
// diagrams. Rules that live in code (risk, closes, RSI cut-off, sweep settings)
// are read from it, so the page can't drift from what the alerts and the
// playbook do. Backtest figures are a snapshot (past year to 4 Nov 2026,
// scaling plan, after Bybit fees) and say so on the page.
import { ALERT_SETTINGS, BPLUS_RSI, scalePlan, DEFAULT_PAIRS } from './sfp.js';
import { RISK_PCT, OFF_HOURS, OFF_HOURS_PCT, BPLUS_HOURS, MIDNIGHT_HOURS, LATE_APP_PCT, SESSION, SLOTS, MAX_POSITIONS, PICKS_PER_CLOSE, CAUTION } from './day-playbook.js';
import { zonedToUtc, NY_TZ } from './bias.js';

const AS_OF = '4 Nov 2026';
const pct = v => `${+v.toFixed(2)}%`;
const hh = h => `${String(h).padStart(2, '0')}:00`;
const badge = g => `<span class="sig-grade g-${g.toLowerCase().replace(/\+/g, 'plus')}">${g === 'A++' ? '★ A++' : g}</span>`;
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
  const gk = g => 'g-' + g.toLowerCase().replace(/\+/g, 'plus');
  const leaf = (x, y, g, sub, w = 104) => `<g class="st-leaf ${gk(g)}"><rect x="${x}" y="${y - 20}" width="${w}" height="${sub ? 44 : 38}" rx="12"/><text x="${x + w / 2}" y="${y + (sub ? 0 : 5)}" text-anchor="middle" class="st-leaf-g">${g === 'A++' ? '★ A++' : g}</text>${sub ? `<text x="${x + w / 2}" y="${y + 16}" text-anchor="middle" class="st-leaf-s">${sub}</text>` : ''}</g>`;
  // a curved arrow, with its yes/no label placed by hand so it never sits on a line
  const arrow = (x1, y1, x2, y2, t, tx, ty, anchor = 'middle') => `<path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2 - 3} ${y2}" class="st-edge"/>${t ? `<text x="${tx}" y="${ty}" class="st-edge-t ${t}" text-anchor="${anchor}">${t}</text>` : ''}`;
  return `<svg viewBox="0 0 900 350" class="st-svg st-tree" role="img" aria-label="How a setup is graded">
    <defs><marker id="stArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" class="st-arrowhead"/></marker></defs>
    ${arrow(118, 160, 140, 160)}
    <path d="M201 186 V266" class="st-edge"/><text x="210" y="232" class="st-edge-t no">no</text>
    ${arrow(262, 160, 290, 160, 'yes', 276, 150)}
    ${arrow(412, 150, 450, 78, 'no', 424, 100, 'end')}
    ${arrow(412, 170, 450, 242, 'yes', 424, 228, 'end')}
    ${arrow(572, 66, 610, 36, 'yes', 586, 36, 'end')}
    ${arrow(572, 90, 610, 112, 'no', 586, 122, 'end')}
    ${arrow(738, 102, 772, 82, 'yes', 754, 84, 'end')}
    ${arrow(738, 122, 772, 144, 'no', 754, 152, 'end')}
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
    ${leaf(610, 36, 'A++', 'the best')}
    ${box(610, 112, 128, `4h RSI < ${BPLUS_RSI} (long)\nor > ${100 - BPLUS_RSI} (short)?`, 'q small')}
    ${leaf(772, 82, 'A+', '', 74)}
    ${leaf(772, 144, 'A', '', 74)}
    ${leaf(610, 196, 'A', 'trade it')}
    ${leaf(772, 246, 'A++', 'B+ if a NY fade', 116)}
    ${leaf(772, 322, 'B', '', 74)}
    ${leaf(131, 290, 'C', 'avoid · C++ if a NY fade', 140)}
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
      if (q === 'skip') return ['off', 'Skip', 'no new trades, hold runners'];
      const full = `A++ ${pct(RISK_PCT['A++'])} · A+ ${pct(RISK_PCT['A+'])} · A ${pct(RISK_PCT.A)}`;
      if (q === 'caution') return ['caution', 'Caution', `best A-grade only · A++ ${pct(RISK_PCT['A++'] * CAUTION.share)} · A+ / A ${pct(RISK_PCT.A * CAUTION.share)}`];
      return q === 'weak' ? ['weak', 'Weak', 'A++ / A+ / A at half size'] : q === 'prime' ? ['prime', 'Prime', full] : ['ok', 'OK', full];
    }
    // a late close counts on the weekday it closes: 20:00 is the same day, 00:00 and 04:00 the next
    const day = h === 20 ? d : (d + 1) % 7;
    // Friday night's 00:00 / 04:00 (they close on Saturday): the same late setups, trade-cautiously
    if ((day === 5 || day === 6) && BPLUS_HOURS.includes(h)) return ['caution', 'Caution', `best one only · 🌃 A++ ${pct(LATE_APP_PCT * CAUTION.share)} · ${MIDNIGHT_HOURS.includes(h) ? '🌙 A' : '🌊 NY fade'} ${pct(OFF_HOURS_PCT * CAUTION.share)}`];
    if (day < 1 || day > 4 || !BPLUS_HOURS.includes(h)) return ['off', '—', 'no new trades'];
    return [h === 0 ? 'night mid' : 'night four', h === 0 ? 'Midnight' : '4 AM', BPLUS_HOURS.includes(h) ? `🌃 A++ ${pct(LATE_APP_PCT)} · ${MIDNIGHT_HOURS.includes(h) ? '🌙 A' : '🌊 NY fade'} ${pct(OFF_HOURS_PCT)}` : 'no new trades'];
  };
  const head = `<div class="st-wk-h"></div>${closes.map((h, i) => `<div class="st-wk-h${i === SESSION.length ? ' st-wk-gap' : ''}">${hh(h)}${i >= SESSION.length && h !== 20 ? '<small>next day</small>' : ''}</div>`).join('')}`;
  const rows = idx.map((d, r) => `<div class="st-wk-d">${days[r]}</div>${closes.map((h, i) => { const [c, t, s] = cell(d, h); return `<div class="st-wk-c ${c}${i === SESSION.length ? ' st-wk-gap' : ''}" title="${days[r]} ${hh(h)}: ${s}"><b>${t}</b><span>${s}</span></div>`; }).join('')}`).join('');
  return `<div class="st-wk-wrap"><div class="st-wk">${head}${rows}</div></div>`;
}

// ---------- grades ----------
const GRADES = [
  { g: 'A++', title: 'Everything lines up', checks: [1, 1, 1, null], alt: [1, 0, 0, 1],
    means: 'The setup goes the same way as yesterday’s New York session, today’s session isn’t running, and BTC printed its own swing failure in the same direction on the same 4h candle. The whole market is rejecting the same way at the same moment.',
    trade: () => `Full plan at ${pct(RISK_PCT['A++'])} on the main closes Mon–Thu (half at Thursday 16:00). The thinnest sample of the A grades (19 trades on 4 days): it’s on top for what it is, the whole market reversing together, and the forward test will say if it earns it. Not at the late closes (⛔): there it made +0.23R a trade.<br><br>The second form, <b>🌃 Late A++</b>: with the bias while New York is open, no BTC sweep, and the 4h RSI stretched, at the 00:00 and 04:00 closes Mon–Thu, at ${pct(LATE_APP_PCT)} (+1.69R a trade on 135 over the year, positive in both halves). At 20:00 it lost (⛔). When it also fades a violent NY session it’s the 🌊 NY fade instead.` },
  { g: 'A+', title: 'With the bias, stretched', checks: [1, 1, 0, 1],
    means: `With yesterday’s NY bias, today’s session isn’t running, BTC didn’t sweep, and the pair’s 4h RSI(14) is stretched the trade’s way: under ${BPLUS_RSI} for a long, over ${100 - BPLUS_RSI} for a short. The move into the level has run far enough that the failure tends to stick. The best zone is 30–40 (60–70 for shorts).`,
    trade: () => `Full plan at ${pct(RISK_PCT['A+'])} on the main closes Mon–Thu (half at Thursday 16:00). Not at the late closes: there it lost (⛔).` },
  { g: 'A', title: 'With the bias', checks: [1, 1, 0, 0], alt: [1, 0, 1, null],
    means: 'With yesterday’s NY bias while today’s session is closed, but neither BTC sweeping with it nor a stretched RSI backs it up. Or: with the bias while the session is open and BTC swept the same way, which confirms the bias is still alive (at 00:00 that’s the 🌙 Midnight sweep).',
    trade: () => `Full plan at ${pct(RISK_PCT.A)} on the main closes Mon–Thu (half at Thursday 16:00). At the late closes only as the <b>🌙 Midnight sweep</b>: an A where BTC swept the same way while New York trades, at the 00:00 close, Mon–Thu, at ${pct(OFF_HOURS_PCT)} (+2.64R a trade over 7 days in the backtest, positive in both halves; thin, so tracking size).` },
  { g: 'B+', title: '🌊 NY fade', checks: [1, 0, 0, 1],
    means: `The 🌃 Late A++ setup (NY open, 4h RSI stretched) at the 04:00 close when it also fades a violent NY session: BTC 2%+ since the NY open and near its session high or low. It did well (+2.29R a trade over the year) but on only 8 days, so it keeps its own name and size to be tracked on its own.`,
    trade: () => `At the 04:00 close, Mon–Thu, at ${pct(OFF_HOURS_PCT)}, full plan. The alerts mark it 🌊 NY fade.` },
  { g: 'B', title: 'Bias may be going stale', checks: [1, 0, 0, 0],
    means: 'With yesterday’s bias, but today’s NY session is open and could be turning the other way, and nothing else (BTC sweep, stretched RSI) backs it up. B only happens while New York trades, which is outside your main closes.',
    trade: () => 'Be cautious: it lost money in the backtest. Monitor it; the playbook suggests no risk for it. Cutting B trades early made them worse, not better.' },
  { g: 'C++', title: 'Fading a violent NY session', checks: [0, null, null, null],
    means: 'A C setup at the 4h close in the last 2 hours of the NY session (04:00 your time) that goes against BTC’s session move, when BTC has moved 2%+ since the NY open and sits near its session high or low. Late in the session the move is usually done; the same fade mid-session loses.',
    trade: () => 'Tracking only, no size. Tracked with fixed targets at 2R and 3R (first entry, no adds): in the backtest those were steadier than the plan, positive in both halves and without the best trades. The alerts flag it 🌊 and show both prices.' },
  { g: 'C', title: 'Against the bias', checks: [0, null, null, null],
    means: 'Against yesterday’s NY bias, or no bias to go by. Before fees these break even; after fees they lose. Every filter tried on top failed to rescue them.',
    trade: () => 'Mostly avoid. They stay logged in Signals and the alerts, so you can spot something the grade misses.' },
];
// Every setup by grade, where and how it's taken, with its backtest (past year,
// full plan with adds unless a fixed target is named, after fees; Mon–Thu by the
// close's day in UTC+8). take: 'yes' | 'track' (tracking size or none) | 'no'.
const SETUPS = [
  { grades: ['A++'], name: '★ A++', when: 'Main closes, Mon–Thu', risk: () => pct(RISK_PCT['A++']), c: [1, 1, 1, null, null], take: 'yes', n: 19, days: 4, avg: 3.24, total: 62, wo: 9, prof: 84, how: 'Full plan: adds at +1R and +2R, hold to the opposing level.' },
  { grades: ['A++'], name: '★ A++ · 🌃 Late A++', when: '00:00 / 04:00, Mon–Thu, NY open, RSI stretched', c: [1, 0, 0, 1, 0], risk: () => pct(LATE_APP_PCT), take: 'yes', n: 135, days: 54, avg: 1.69, total: 228, wo: 125, prof: 36, how: 'Full plan at half a percent. What used to be B+.' },
  { grades: ['A+'], name: 'A+', when: 'Main closes, Mon–Thu', risk: () => `${pct(RISK_PCT['A+'])} (½ on Thu 16:00)`, c: [1, 1, 0, 1, null], take: 'yes', n: 229, days: 96, avg: 2.70, total: 619, wo: 297, prof: 35, how: 'Full plan. The best-proven setup: the core of the strategy.' },
  { grades: ['A'], name: 'A', when: 'Main closes, Mon–Thu', risk: () => `${pct(RISK_PCT.A)} (½ on Thu 16:00)`, c: [1, 1, 0, 0, null], take: 'yes', n: 122, days: 75, avg: 1.10, total: 134, wo: 33, prof: 49, how: 'Full plan. Weaker without the RSI stretch, still positive in both halves.' },
  { grades: ['A++', 'A+', 'A'], name: 'A++ / A+ / A', when: 'Main closes, Friday (trade cautiously)', c: [1, 1, null, null, null], risk: () => `¼, best one only: A++ ${pct(RISK_PCT['A++'] * CAUTION.share)} · A+ / A ${pct(RISK_PCT.A * CAUTION.share)}`, take: 'track', n: 64, days: 28, avg: -0.47, total: -30, wo: -48, prof: 25, how: 'Trade cautiously: Friday entries lost in both halves of the year, mostly stopped before the weekend, but a runner into it can still start here. The best setup of a close only, at a quarter size.' },
  { grades: ['A'], name: 'A · 🌙 Midnight sweep', when: '00:00, Mon–Thu, BTC swept the same way', c: [1, 0, 1, null, null], risk: () => pct(OFF_HOURS_PCT), take: 'track', n: 15, days: 7, avg: 2.64, total: 40, wo: 8, prof: 60, how: 'Full plan at tracking size. Thin sample.' },
  { grades: ['B+'], name: 'B+ · 🌊 NY fade', when: '04:00, Mon–Thu, fading a 2%+ NY session', risk: () => pct(OFF_HOURS_PCT), c: [1, 0, 0, 1, 1], take: 'track', n: 19, days: 4, avg: 1.09, total: 21, wo: -4, prof: 68, how: 'Part of B+, tracked on its own: +2.29R over 32 trades on all days, but only 8 days. Full plan at tracking size.' },
  { grades: ['C++'], name: '🏅 C++', when: '04:00, Mon–Thu (NY fade), full plan', c: [0, null, null, null, 1], risk: () => 'tracking', take: 'track', n: 45, days: 13, avg: 1.22, total: 55, wo: -19, prof: 40, how: 'For reference: depends on its best few days.' },
  { grades: ['C++'], name: '🏅 C++', when: '…with a 2R target', c: [0, null, null, null, 1], risk: () => 'tracking', take: 'track', n: 45, days: 13, avg: 0.37, total: 17, wo: 11, prof: 49, how: 'First entry only, no adds.' },
  { grades: ['C++'], name: '🏅 C++', when: '…with a 3R target', c: [0, null, null, null, 1], risk: () => 'tracking', take: 'track', n: 45, days: 13, avg: 0.50, total: 23, wo: 14, prof: 40, how: 'First entry only, no adds. The steadiest version.' },
  // to avoid
  { grades: ['A++'], name: '★ A++', when: 'Late closes, Mon–Thu', wrongTime: true, risk: () => 'skip', c: [1, 1, 1, null, null], take: 'no', n: 11, days: 3, avg: 0.23, total: 3, wo: -3, prof: 73, how: 'Barely positive over the year (+3R in all): not worth the late night.' },
  { grades: ['A++', 'A+', 'A'], name: 'A++ / A+ / A', when: 'Main closes, Sat–Sun', wrongTime: true, c: [1, 1, null, null, null], risk: () => 'skip', take: 'no', n: 170, days: 63, avg: -0.45, total: -77, wo: -111, prof: 28, how: 'New weekend entries lost in both halves. Hold runners from the week; don’t open new ones.' },
  { grades: ['A+', 'A'], name: 'A+ / A', when: 'Other late closes (20:00, 04:00, 00:00 without a BTC sweep)', wrongTime: true, c: [1, null, null, null, null], risk: () => 'skip', take: 'no', n: 118, days: 48, avg: -0.33, total: -39, wo: -67, prof: 37, how: 'Outside the main closes an A needs BTC sweeping with it.' },
  { grades: ['A++'], name: '★ A++ · 🌃 Late A++', when: '20:00, Mon–Thu, NY open, RSI stretched', wrongTime: true, c: [1, 0, 0, 1, 0], risk: () => 'skip', take: 'no', n: 48, days: 35, avg: -0.62, total: -30, wo: -34, prof: 33, how: 'Lost in both halves: right at the NY open the move isn’t done.' },
  { grades: ['B'], name: 'B', when: 'Any close', c: [1, 0, 0, 0, null], risk: () => 'monitor', take: 'no', n: 264, days: 130, avg: -0.24, total: -64, wo: -90, prof: 32, how: 'The bias may be going stale and nothing backs it up.' },
  { grades: ['C'], name: 'C', when: 'Any close', c: [0, null, null, null, 0], risk: () => 'avoid', take: 'no', n: 2299, days: 333, avg: -0.12, total: -272, wo: -519, prof: 26, how: 'Against yesterday’s NY bias: break-even before fees, a loss after.' },
  { grades: ['C'], name: 'C', when: 'Main closes, Mon–Thu', c: [0, null, null, null, 0], risk: () => 'avoid', take: 'no', n: 755, days: 157, avg: -0.22, total: -164, wo: -282, prof: 27, how: 'Even at the best closes.' },
];
// the conditions as coloured dots: green must be true, red must be false, grey either way
// The conditions a setup needs, as a word for the NY session and dots for the rest: only
// what's required is shown. The NY bias is red where a setup needs to be against it (C, C++).
const COND = [['NY bias', 'Yesterday’s NY bias'], ['NY session', 'The NY session at the signal'], ['BTC swept', 'BTC swept the same way on the same candle'], ['RSI', `4h RSI stretched the trade’s way (< ${BPLUS_RSI} long / > ${100 - BPLUS_RSI} short)`], ['NY fade', 'Fades a 2%+ NY session at its last close (BTC near its session high or low)']];
const cell = (v, i) => {
  if (i === 0) return v === 1 ? `<span class="st-cdot yes" title="With yesterday’s NY bias"></span>` : v === 0 ? `<span class="st-cdot no" title="Against yesterday’s NY bias (or none)"></span>` : '<span class="st-cdot any" title="Yesterday’s NY bias: not needed"></span>';
  if (i === 1) return v === 1 ? '<span class="st-cdot no" title="The NY session is closed at the signal"></span>' : v === 0 ? '<span class="st-cdot yes" title="The NY session is open at the signal"></span>' : '<span class="st-cdot any" title="The NY session: either"></span>';
  return v === 1 ? `<span class="st-cdot yes" title="${COND[i][1]}: needed"></span>` : `<span class="st-cdot any" title="${COND[i][1]}: not needed"></span>`;
};
const condLegend = `<p class="st-clegend">Columns: ${COND.map(c => c[0]).join(' · ')}. <span class="st-cdot yes"></span> needed <span class="st-cdot no"></span> against the bias <span class="st-cdot any"></span> not needed. NY session: <span class="st-cdot yes"></span> open <span class="st-cdot no"></span> closed. A setup that fits two rows takes the one with more conditions (a 🌃 Late A++ that also fades the NY session is the 🌊 NY fade).</p>`;
const rf = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}R`, tf = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}R`;
const gc = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const setupBadge = x => (x.grades.length > 1 ? x.grades.map(badge).join(' ') : badge(x.grades[0])) + (x.name.includes('🌙') ? ' <span class="st-tag">🌙 Midnight sweep</span>' : x.name.includes('🌊 NY fade') ? ' <span class="st-tag">🌊 NY fade</span>' : x.name.includes('🌃') ? ' <span class="st-tag">🌃 Late A++</span>' : '') + (x.wrongTime ? ' <span class="st-wrong">⛔ wrong time</span>' : '');
function setupTable(list, avoid = false) {
  return `<div class="table-wrap"><table class="data compact st-setup-t${avoid ? ' avoid' : ''}"><thead><tr><th>Grade</th><th class="st-cth" title="${COND.map(c => c[1]).join(' · ')}">${COND.map(([k]) => `<span>${k}</span>`).join('')}</th><th>Closes</th><th>Risk</th><th class="num">Trades</th><th class="num">Avg</th><th class="num">Total R</th><th class="num">Without best 3</th><th class="num">In profit</th><th>${avoid ? 'Why not' : 'How'}</th></tr></thead><tbody>
    ${list.map(x => `<tr><td><span class="st-gcell">${setupBadge(x)}</span></td><td class="st-ctd">${x.c.map((v, i) => `<span class="st-slot">${cell(v, i)}</span>`).join('')}</td><td class="st-when">${x.when}</td><td class="st-risk-c">${x.risk()}</td><td class="num">${x.n.toLocaleString()}<small class="st-days">${x.days} days</small></td><td class="num ${gc(x.avg)}">${rf(x.avg)}</td><td class="num ${gc(x.total)}"><b>${tf(x.total)}</b></td><td class="num ${gc(x.wo)}">${tf(x.wo)}</td><td class="num">${x.prof}%</td><td class="st-why" title="${x.how.replace(/"/g, '&quot;')}"><span>${x.how}</span></td></tr>`).join('')}
  </tbody></table></div>${condLegend}`;
}
const CHECK_NAMES = ['With yesterday’s NY bias', 'NY session closed', 'BTC swept the same way', `4h RSI stretched (< ${BPLUS_RSI} / > ${100 - BPLUS_RSI})`];
const mark = v => (v === 1 ? '<i class="yes">✓</i>' : v === 0 ? '<i class="no">✗</i>' : '<i class="any">·</i>');
function gradeCard({ g, title, checks, alt, means, trade }) {
  const ck = row => `<ul class="st-checks">${CHECK_NAMES.map((n, i) => `<li>${mark(row[i])}<span>${n}</span></li>`).join('')}</ul>`;
  return `<article class="st-grade g-${g.toLowerCase().replace(/\+/g, 'plus')}">
    <header>${badge(g)}<h3>${title}</h3></header>
    <p>${means}</p>
    <div>${ck(checks)}${alt ? `<p class="st-or">or</p>${ck(alt)}` : ''}</div>
    <ul class="st-setups">${SETUPS.filter(x => x.grades.includes(g)).map(x => `<li class="${x.take}"><i>${x.wrongTime ? '⛔' : x.take === 'yes' ? '✓' : x.take === 'track' ? '◐' : '✗'}</i><span><b>${x.when}</b> · ${x.wrongTime ? 'wrong time, skip' : x.risk()}<small>${x.n.toLocaleString()} trades · ${rf(x.avg)} avg · ${tf(x.total)} total · ${tf(x.wo)} without the best 3</small></span></li>`).join('')}</ul>
    <p class="st-how"><b>How to trade it:</b> ${trade()}</p>
  </article>`;
}
const MATRIX = `<table class="data compact st-matrix"><thead><tr><th>Grade</th>${CHECK_NAMES.map(n => `<th>${n}</th>`).join('')}<th>Risk</th></tr></thead><tbody>
  <tr><td>${badge('A++')}</td><td>✓</td><td>✓</td><td>✓</td><td>·</td><td>${pct(RISK_PCT['A++'])}</td></tr>
  <tr><td>${badge('A+')}</td><td>✓</td><td>✓</td><td>✗</td><td>✓</td><td>${pct(RISK_PCT['A+'])}</td></tr>
  <tr><td>${badge('A')}</td><td>✓</td><td>✓</td><td>✗</td><td>✗</td><td>${pct(RISK_PCT.A)}</td></tr>
  <tr><td>${badge('A')}</td><td>✓</td><td>✗</td><td>✓</td><td>·</td><td>${pct(RISK_PCT.A)}</td></tr>
  <tr><td>${badge('A++')} 🌃</td><td>✓</td><td>✗</td><td>✗</td><td>✓</td><td>${pct(LATE_APP_PCT)} at 00:00 / 04:00</td></tr>
  <tr><td>${badge('B+')} 🌊</td><td>✓</td><td>✗</td><td>✗</td><td>✓ + NY fade</td><td>${pct(OFF_HOURS_PCT)} at 04:00</td></tr>
  <tr><td>${badge('B')}</td><td>✓</td><td>✗</td><td>✗</td><td>✗</td><td>monitor</td></tr>
  <tr><td>${badge('C++')}</td><td>✗</td><td>·</td><td>·</td><td>·</td><td>tracking (NY fade at 04:00)</td></tr>
  <tr><td>${badge('C')}</td><td>✗</td><td>·</td><td>·</td><td>·</td><td>avoid</td></tr>
</tbody></table><p class="muted small">✓ must be true · ✗ must be false · · doesn’t matter</p>`;

const TESTED = [
  ['BTC’s 4h trend instead of the NY bias', 'Much worse. The NY close is the better read on direction.'],
  ['Cutting B trades early when price stalls', 'Made them lose more: the few that recover pay for the rest.'],
  ['Minor swing highs from impulses as levels', 'Not robust. Only major levels (10+ candles old, at the range edge).'],
  ['Calling the day off once the NY low breaks', 'Removed good trades with the bad. Not worth it.'],
  ['15m SMT against BTC as a confluence', 'Hurt results.'],
  ['Skipping trades when BTC rejects a level against you', 'Worked at 0.5%, reversed at 1%: noise.'],
  ['RSI on A setups', 'Stretched (30–40 / 60–70) is the best group: that became A+ (1% for now, more once the forward test confirms it). Over-extended (< 30 / > 70) is weaker and depends on its best trades.'],
  ['A 1:1 target for B and C', 'Doubles the hit rate, still loses after fees. The late NY-open setups lose their edge.'],
  ['Rescuing C (BTC sweep, R:R, RSI, BOS entries)', 'Nothing holds in both halves of the year.'],
  ['Smaller first entry, heavier adds later', 'Halves the losses but also the runners. Worse per unit of drawdown.'],
  ['🌙 Midnight sweep: BTC SFP at the 00:00 close', 'Alt SFPs on the same candle as a BTC SFP the same way, mid NY session, Mon–Thu: +2.96R a trade over 14 days; the A ones (with the bias) +2.64R over 7, in both halves. One day made most of it, so A ones are taken at 0.25%; the C ones stay a skip. Without a BTC SFP, 00:00 loses.'],
  ['Fading a violent NY session at 04:00', 'BTC 2%+ in the session and closing near its high or low: setups against it at the 04:00 close averaged about +1R, in both halves; the same fade at 00:00 lost. Much of that came from the stretched-RSI setups you already take (now 🌊 NY fade); the C ones depend on a few days, so they’re C++, tracking only. 5%+ sessions are too rare to judge (4 a year).'],
  ['One long and one short at a time', 'Halves the profit; the worst day shrinks but return per drawdown falls. Replaced by at most 2 new a close (A++ first, then the highest R:R).'],
  ['A+ at 1.5%', 'Same edge per trade, but ~14 more points of drawdown. Back to 1% until the forward test confirms it.'],
  ['Adding into the weekend', 'Trades in profit into the weekend kept running, but only if the add doesn’t move the stop: moving it to a new break-even cost 90–180R. Shown as a note on open positions only.'],
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
      <div><b>+2.32R</b><span>avg trade the plan takes</span></div>
      <div><b>21%</b><span>hit the target</span></div>
      <div><b>1 in 10</b><span>runs 5R or more</span></div>
    </div>
    <nav class="st-toc" aria-label="On this page">${[['st-setup', 'The setup'], ['st-trade', 'The trade'], ['st-grades', 'Grades'], ['st-every', 'Every setup'], ['st-avoid', 'Avoid'], ['st-when', 'When'], ['st-risk', 'Risk'], ['st-scale', 'Scaling in'], ['st-manage', 'Managing'], ['st-tested', 'What we tested'], ['st-honest', 'Caveats']].map(([id, t], i) => `<a href="#strategy" data-to="${id}"><i>${i + 1}</i>${t}</a>`).join('')}</nav>
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
      <div><b>RSI stretched</b><span>The pair’s 4h RSI(14) at the close is under ${BPLUS_RSI} for a long or over ${100 - BPLUS_RSI} for a short. Splits A into A+ and A, and a NY-open B into 🌃 Late A++ and B.</span></div>
    </div>
    <div class="st-fig st-scroll">${treeSvg()}</div>
    <div class="table-wrap">${MATRIX}</div>
    <div class="st-grades">${GRADES.map(gradeCard).join('')}</div>
    <p class="muted small">Figures: past year to ${AS_OF}, ${pairs} pairs, with the scaling plan, after Bybit fees. ✓ taken at full size · ◐ tracking size or none · ⛔ right grade, wrong time · ✗ avoid. The Signals tab has live numbers per grade.</p>
  </section>

  <section id="st-every" class="card c12 accented st-sec" style="--a: var(--a5)">
    <div class="kicker">4 · Every setup</div>
    <h2>What you take, and how it did</h2>
    <p>Each grade, split by where it’s taken. A+ and A at the main closes Monday to Thursday are the engine; the 🌃 Late A++ is the strongest of the late closes.</p>
    ${setupTable(SETUPS.filter(x => x.take !== 'no'))}
    <p class="muted small">Past year to ${AS_OF}, ${pairs} pairs, full plan with adds unless a fixed target is named, after fees. Total R adds up R regardless of size: a 1R 🌃 Late A++ at 0.5% is worth a quarter of a 1R A++ at 2%. “Without best 3” drops the three biggest winners, to show what the setup does when the outliers don’t come.</p>
  </section>

  <section id="st-avoid" class="card c12 accented st-sec" style="--a: var(--neg)">
    <div class="kicker">5 · Setups to avoid</div>
    <h2>Two kinds of setup the plan skips</h2>
    <p>Both lost money over the year, and lost without their best trades too. They still show up in Signals and the alerts so you can see them, but they aren’t part of the plan.</p>
    <h3 class="st-avoid-h">⛔ Good setup, wrong time</h3>
    <p>The grade is right: these are the same A++, A+ and A setups that make the money at the right closes. The hour or the day is what’s wrong. The alerts mark them ⛔ so they don’t look tradeable.</p>
    ${setupTable(SETUPS.filter(x => x.take === 'no' && x.wrongTime), true)}
    <h3 class="st-avoid-h">✗ Weak grades</h3>
    <p>The setup itself has no edge: B because yesterday’s bias may be going stale with nothing backing it up, C because it trades against the bias.</p>
    ${setupTable(SETUPS.filter(x => x.take === 'no' && !x.wrongTime), true)}
    <p class="muted small">The weekend row is the costliest: new A-grade entries on Saturday and Sunday lost in both halves of the year, so the playbook skips them. Friday lost too, but stays open with caution: the best A-grade setup of a close, at a quarter size. Runners already open from the week are a different story: hold them.</p>
  </section>

  <section id="st-when" class="card c12 accented st-sec" style="--a: var(--a5)">
    <div class="kicker">6 · When</div>
    <h2>The closes you trade</h2>
    <p>The same setup does very differently by hour and weekday. Most of the profit came from the <b>08:00, 12:00 and 16:00 closes, Monday to Thursday</b> (your time). Outside those, A-grade trades lost money overall (−0.30R a trade over 529). Only a few setups are taken there, at a half or a quarter percent (the 🌃 Late A++, 🌊 NY fade and 🌙 Midnight sweep), Friday is trade-cautiously (the best A-grade setup only, a quarter size), and nothing new on Saturday and Sunday.</p>
    ${weekGrid()}
    <div class="st-legend"><span class="prime">Prime</span> the best close <span class="ok">OK</span> positive <span class="weak">Weak</span> lost money: half size, skip B <span class="caution">Caution</span> trade cautiously: the best A-grade only, a quarter size <span class="off">Skip</span> weekend: no new trades <span class="mid">Midnight</span> <span class="four">4 AM</span> late setups at tracking size <span class="off">—</span> no new trades</div>
    <p class="muted small">No new trades between closes. Late closes count on the day they close: Monday 00:00 is in, Thursday and Friday nights’ 00:00 / 04:00 are trade-cautiously.</p>
  </section>

  <section id="st-risk" class="card c6 accented st-sec" style="--a: var(--a4)">
    <div class="kicker">7 · Risk</div>
    <h2>Size by grade</h2>
    <div class="table-wrap"><table class="data compact st-risk-t"><thead><tr><th>Grade</th><th>Main closes, Mon–Thu</th><th>Weak: Thu 16:00</th><th>Caution: Friday</th><th>Late closes (Mon–Thu)</th></tr></thead><tbody>
      <tr><td>${badge('A++')}</td><td>${pct(RISK_PCT['A++'])}</td><td>${pct(RISK_PCT['A++'] / 2)}</td><td>${pct(RISK_PCT['A++'] * CAUTION.share)}</td><td>${pct(LATE_APP_PCT)} as 🌃 Late A++ (00:00 / 04:00)</td></tr>
      <tr><td>${badge('A+')}</td><td>${pct(RISK_PCT['A+'])}</td><td>${pct(RISK_PCT['A+'] / 2)}</td><td>${pct(RISK_PCT['A+'] * CAUTION.share)}</td><td>— (⛔)</td></tr>
      <tr><td>${badge('A')}</td><td>${pct(RISK_PCT.A)}</td><td>${pct(RISK_PCT.A / 2)}</td><td>${pct(RISK_PCT.A * CAUTION.share)}</td><td>${pct(OFF_HOURS_PCT)} at 00:00 as the 🌙 Midnight sweep</td></tr>
      <tr><td>${badge('B+')} 🌊</td><td>—</td><td>—</td><td>—</td><td>${pct(OFF_HOURS_PCT)} at 04:00</td></tr>
      <tr><td>${badge('B')}</td><td>—</td><td>—</td><td>—</td><td>monitor</td></tr>
      <tr><td>${badge('C++')}</td><td>—</td><td>—</td><td>tracking</td></tr>
      <tr><td>${badge('C')}</td><td>—</td><td>—</td><td>avoid</td></tr>
    </tbody></table></div>
    <ul class="st-list">
      <li>Risk is the loss <b>to the stop</b>, as a share of your equity. Size the position from it: the trade guide on each signal does the maths.</li>
      <li>At most <b>${PICKS_PER_CLOSE} new trades per close</b> and <b>${MAX_POSITIONS} open</b> in all. Alts often signal together on one close and all move with BTC, so they’re really one bet: this halved the worst day (−7R vs −14R) for about 17% less profit.</li>
      <li>When more qualify, take <b>the best grade first (A++, A+, A), then the highest R:R</b>. The pick mattered: the highest R:R made far more than a random choice. The alerts mark the picks 👉.</li>
      <li>Never move a stop further away, never average down.</li>
    </ul>
  </section>

  <section id="st-scale" class="card c6 accented st-sec" style="--a: var(--a3)">
    <div class="kicker">8 · Scaling in</div>
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
    <div class="kicker">9 · Managing the trade</div>
    <h2>Don’t touch it</h2>
    <div class="st-cols">
      <div>
        <p>This is a <b>low hit rate, big winner</b> strategy. About seven in ten trades stop out or scratch. The rest pay for everything, and a handful pay for the year:</p>
        <div class="st-bar" role="img" aria-label="15 of 370 trades made 789R of 814R">
          <div class="st-bar-row"><span>15 trades (4%)</span><i style="--w: 89%" class="pos"></i><b>785R</b></div>
          <div class="st-bar-row"><span>the other 366</span><i style="--w: 11%"></i><b>99R</b></div>
        </div>
        <p class="muted small">Past year, every setup the plan takes, with its limits (2 new a close, 5 open), the full plan and fees: 381 trades, 884R. The biggest single trade made 155R.</p>
      </div>
      <div><ul class="st-list">
        <li><b>Set the stop and target, then leave it.</b> The only changes are the plan’s adds and stop moves.</li>
        <li><b>Don’t take profit early.</b> The median trade lasts 8 hours, but 20R+ runners take about <b>2.7 days</b>.</li>
        <li><b>Hold through the weekend.</b> Trades already open going into it were the biggest winners. Don’t open new ones on Saturday or Sunday, and keep Friday to the best setup at a quarter size.</li>
        <li><b>Expect losing streaks.</b> Losing days are normal and a 5R+ runner only comes about 1 trade in 12, so skipping trades after a few losses is how you miss the one that pays.</li>
      </ul></div>
    </div>
  </section>

  <section id="st-tested" class="card c12 accented st-sec" style="--a: var(--a5)">
    <div class="kicker">10 · What we tested</div>
    <h2>Ideas that didn’t make the cut</h2>
    <div class="st-tested">${TESTED.map(([a, b], i) => `<div class="${/Midnight sweep|violent NY session|15m break of structure/.test(a) ? 'maybe' : ''}"><b>${a}</b><span>${b}</span></div>`).join('')}</div>
  </section>

  <section id="st-honest" class="card c12 accented st-sec" style="--a: var(--neg)">
    <div class="kicker">11 · Caveats</div>
    <h2>What could make this wrong</h2>
    <div class="st-cols">
      <ul class="st-list">
        <li><b>Tuned on the same year it’s scored on.</b> The grades, hours and filters were picked after seeing this data. Live results usually come in well under a backtest.</li>
        <li><b>Outliers.</b> Without its 15 biggest winners, the plan makes about +99R over the year (+0.27R a trade): positive, but thin. A year without big alt runs would be close to flat.</li>
        <li><b>Many ideas tested on one year.</b> The grade ladder, the late-close setups and the fades were all found on this data. Checking both halves and removing the best trades screens out the worst flukes, but some will turn out to be noise.</li>
      </ul>
      <ul class="st-list">
        <li><b>Fills.</b> The backtest fills exactly at the close, the stop and each add. Thin coins in a squeeze will fill worse.</li>
        <li><b>Size.</b> At full size the backtest’s worst drawdown is about −27% compounded (−54% added up). Forward-test at half size or less: about −15%.</li>
        <li><b>The plan:</b> forward-test about 100 trades (the Forward test tab) before going to full risk. The goal is to see the runners actually come, that you hold them, and that A++ and A+ beat A.</li>
      </ul>
    </div>
  </section>`;
  // the contents links scroll within the page (the hash stays #strategy)
  root.querySelectorAll('.st-toc a').forEach(a => (a.onclick = e => { e.preventDefault(); root.querySelector('#' + a.dataset.to)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }));
}
