// Today's playbook on the dashboard: the day and its plan with four gauges beside it
// (NY bias, BTC's 1h RSI, today's strategies, room under the caps), the local day as a
// timeline with every close and a live countdown, and the short guidelines.
import { playbookData, strategiesToday, guidelines, pbHour, pbR, MAX_POSITIONS } from './day-playbook.js';
import { NY_TZ, zonedDate, zonedToUtc, NY_HOURS } from './bias.js';
import { BTC_RSI_BANDS } from './sfp.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const BIAS = { bullish: ['Bullish', '▲'], bearish: ['Bearish', '▼'], flat: ['No bias', '■'] };
const sideOf = x => (x.read?.dir === 'Long' ? 'longs' : x.read?.dir === 'Short' ? 'shorts' : null);
const nextSlot = x => (x.next ? x.slots[x.next.i] : null);
const gauge = (label, body, cls = '') => { const c = el('div', 'pbo-g ' + cls); c.append(el('span', 'pbo-gl', label), body); return c; };

// a countdown with seconds, ticked every second by tickSeconds: "1h 05m 32s", "4m 09s", then "now" for 5 minutes, then "done"
export function secLeft(at, now = Date.now()) {
  const ms = at - now;
  if (ms <= 0) return now - at < 5 * 60_000 ? 'now' : 'done';
  const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}h ${String(m).padStart(2, '0')}m ${sec}s` : `${m}m ${sec}s`;
}
export function tickSeconds(root, now = Date.now()) { for (const e of root.querySelectorAll('[data-sec]')) { const t = secLeft(Number(e.dataset.sec), now); if (e.textContent !== t) e.textContent = t; } }
const secEl = (cls, at) => { const e = el('span', cls, secLeft(at)); e.dataset.sec = at; return e; };

// the bias: an arrow in a ring, the word, the side to look for, and what New York did
function biasGauge(x) {
  const bias = x.read?.bias || 'none', hist = x.history || [], last = hist.at(-1);
  const g = el('div', 'pbo-g bias-card ' + bias);
  const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
  const wd = h => new Date(`${h.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  const mark = b => (b === 'bullish' ? '▲' : b === 'bearish' ? '▼' : '■');
  // the label, and the session that set it
  const top = el('div', 'bc-top'); top.append(el('span', 'pbo-gl', 'NY bias'));
  if (last) top.append(el('span', 'bc-src ' + last.bias, `${wd(last)} ${mark(last.bias)} ${pct(last.change)}`));
  // the call as what to do
  const call = el('div', 'bc-call');
  call.append(el('b', '', x.read?.bias && x.read.bias !== 'flat' ? x.read.bias[0].toUpperCase() + x.read.bias.slice(1) : 'No bias'), el('small', '', x.read?.dir ? `${x.read.dir} bias` : 'Stand aside'));
  // the last sessions, oldest first: a fresh flip or a run?
  const runs = el('div', 'bc-runs');
  for (const h of hist) { const r = el('span', h.bias); r.append(el('em', '', wd(h)), el('i', '', mark(h.bias))); r.title = `${h.date}: ${h.bias} ${pct(h.change || 0)}`; runs.append(r); }
  const streak = (() => { let n = 0; for (const h of [...hist].reverse()) { if (h.bias === last?.bias) n++; else break; } return n; })();
  // what's next
  const next = x.live ? `Today so far ${pct(x.live.change)} · can flip at ${new Date(x.read?.liveEnd).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : streak > 1 ? `${streak} ${last.bias} sessions in a row` : last ? `Flipped ${last.bias} on ${wd(last)}` : '';
  g.append(top, call, runs, el('small', 'bc-next', next));
  g.title = x.read?.story || '';
  return g;
}

// BTC's 1h RSI: the number big, what it means, and a 0–100 meter with its zones coloured from the bias's side
function rsiGauge(x) {
  const rsi = x.btc?.rsi, long = x.read?.dir !== 'Short', t = x.rsiTag, z = BTC_RSI_BANDS;
  const top = el('div', 'pbo-rsi-top');
  top.append(el('b', 'pbo-rsi-n ' + (t ? (t.kind === 'cool' ? 'cool' : 'warn') : ''), Number.isFinite(rsi) ? String(Math.round(rsi)) : '—'),
    el('span', 'pbo-rsi-what', !Number.isFinite(rsi) ? '' : !t ? 'neutral' : { cool: '🧊 cooled off: good', deep: `⚠️ stretched against ${sideOf(x)}`, chase: '⚠️ extended: wait for a cool-off' }[t.kind]));
  const zones = long ? [[0, z.deep, 'warn', 'stretched'], [z.deep, z.cool, 'cool', 'cooled'], [z.cool, z.chase, 'mid', 'neutral'], [z.chase, 100, 'warn', 'extended']]
    : [[0, 100 - z.chase, 'warn', 'extended'], [100 - z.chase, 100 - z.cool, 'mid', 'neutral'], [100 - z.cool, 100 - z.deep, 'cool', 'cooled'], [100 - z.deep, 100, 'warn', 'stretched']];
  const track = el('div', 'pbo-track rsi'), labels = el('div', 'pbo-zl');
  for (const [a, c, k, name] of zones) {
    const s = el('i', k); s.style.left = a + '%'; s.style.width = (c - a) + '%'; track.append(s);
    if (!labels.querySelector('.' + k + '[data-n="' + name + '"]')) { const l = el('span', k, name); l.dataset.n = name; labels.append(l); }
  }
  if (Number.isFinite(rsi)) { const m = el('b', 'pbo-mark'); m.style.left = Math.max(0, Math.min(100, rsi)) + '%'; track.append(m); }
  const body = el('div', 'pbo-meter');
  body.append(top, track, labels);
  return gauge('BTC 1h RSI', body, 'rsi');
}

// the setups for now and their size: the main closes while any are left today, then tonight's late ones
function stratGauge(x, now) {
  const all = strategiesToday(new Date(now)), day = all.filter(s => !s.tonight), night = all.filter(s => s.tonight);
  const daytime = Boolean(x.next) && day.length > 0, list = daytime ? day : night;
  const ul = el('ul', 'pbo-strats');
  if (!list.length) ul.append(el('li', 'none', daytime ? 'No new trades today: hold runners.' : 'No late trades tonight.'));
  for (const s of list) {
    const li = el('li', s.caution ? 'caution' : ''), nm = el('span', 'nm');
    nm.append(el('b', '', s.name));
    if (s.note) nm.append(el('small', '', s.tonight ? s.note : s.note.replace(/ at /g, ' at ')));
    li.append(nm, el('span', 'size', s.pct));
    li.title = s.what + (s.caution ? ' · trade cautiously: the best one of a close only' : '');
    ul.append(li);
  }
  return gauge(daytime ? `${x.day}’s strategies` : 'Tonight’s strategies', ul, 'strats');
}

// room under the caps: the count big, a slot per position (filled with its coin), and what the next close allows
function roomGauge(x, held = []) {
  const box = el('div', 'pbo-room'), n = x.open ?? held.length;
  const top = el('div', 'pbo-room-top');
  top.append(el('b', 'pbo-room-n', x.open === null ? '—' : `${n}/${MAX_POSITIONS}`), el('span', '', 'open'));
  const slots = el('div', 'pbo-slots');
  for (let i = 0; i < MAX_POSITIONS; i++) {
    const p = held[i], s = el('i', i < n ? 'on' + (p ? ' ' + (p.dir === 'Long' ? 'long' : 'short') : '') : '');
    if (p) s.title = `${p.symbol} ${p.dir.toLowerCase()}`;
    slots.append(s);
  }
  const nx = x.next ? x.slots[x.next.i] : null;
  const coins = el('div', 'pbo-coins');
  for (const p of held) coins.append(el('span', p.dir === 'Long' ? 'long' : 'short', `${p.dir === 'Long' ? '▲' : '▼'} ${p.symbol.replace(/USDT$/, '')}`));
  box.append(top, slots, coins, el('small', x.room === 0 ? 'full' : '', x.open === null ? 'positions unknown' : !nx ? 'no more closes today' : x.room ? `room for ${x.room} new at ${pbHour(nx.h)}` : 'full: wait for one to close'));
  return gauge('Positions', box, 'room');
}

// the local day as a line: the NY session shaded, each close coloured by tier, now, and a live countdown over the next close
function timeline(x, now) {
  const day0 = new Date(now).setHours(0, 0, 0, 0), pos = t => ((t - day0) / 864e5) * 100;
  const line = el('div', 'pbo-line hero');
  for (const back of [-1, 0, 1]) {
    const [y, m, d] = zonedDate(day0 + 12 * 36e5 + back * 864e5, NY_TZ), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const [oh, om] = NY_HOURS.session.open.split(':').map(Number), [ch, cm] = NY_HOURS.session.close.split(':').map(Number);
    const a = Math.max(0, pos(zonedToUtc(y, m, d, oh, om))), b = Math.min(100, pos(zonedToUtc(y, m, d, ch, cm)));
    if (b <= 0 || a >= 100) continue;
    const ny = el('i', 'pbo-ny'); ny.style.left = a + '%'; ny.style.width = (b - a) + '%'; ny.title = 'New York session (8 AM – 5 PM ET)'; line.append(ny);
  }
  const n = nextSlot(x);
  for (const c of x.closes) {
    const next = n && c.at === n.at;
    const m = el('div', 'pbo-tick ' + c.tier + (c.at < now - 5 * 60_000 ? ' past' : '') + (next ? ' next' : ''));
    m.style.left = pos(c.at) + '%';
    const time = el('b', '', pbHour(c.h));
    if (next) { const cd = el('span', 'pbo-in'); cd.append(' in ', secEl('pbo-cd-in', n.at)); time.append(cd); }   // "12:00 in 47m 12s", the time stays under its dot
    m.append(el('i', ''), time, el('small', '', c.label));
    line.append(m);
  }
  // the part of the day gone by fills in, and a live dot pulses at the current moment
  const past = el('i', 'pbo-past'); past.style.width = pos(now) + '%'; line.prepend(past);
  const nowM = el('div', 'pbo-now'); nowM.style.left = pos(now) + '%';
  nowM.title = `Now · ${new Date(now).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  nowM.append(el('i', 'pbo-pulse'), el('i', 'pbo-dot'));
  line.append(nowM);
  return line;
}

// nyLive, sessions, btc ({ pull, rsi }), open (positions open, or null), equity / hidden / money for the guidelines
export function renderPlaybook(root, opts = {}) {
  const now = opts.now || new Date(), x = playbookData({ ...opts, now });
  // rebuild only when something shown changes (and once a minute, for the now line)
  const key = [now.toDateString(), Math.floor(now.getTime() / 60_000), x.nyLive, x.read?.story, x.live?.change?.toFixed(3), x.open, (opts.held || []).map(p => p.symbol).join(','), Number.isFinite(x.btc?.rsi) ? Math.round(x.btc.rsi) : '-', opts.equity === null ? '-' : Math.round(opts.equity ?? 0), opts.hidden].join(':');
  if (root.dataset.key === key && root.childElementCount) return;
  root.dataset.key = key;

  const t = el('div', 'pbo-ht');
  const top = el('div', 'pbo-ht-top');
  top.append(el('span', 'pbo-hday', x.day), el('span', 'pbo-hl ' + x.verdict, x.verdictText), el('span', 'pbo-bl-stat', `${pbR(x.avg)} a trade · ${x.win}% hit target`));
  // the title row folds the card to just this line (remembered for today)
  const chev = el('button', 'pbo-fold'); chev.type = 'button';
  chev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>';
  top.append(chev);
  const foldKey = 'perp-dojo:playbook-folded', today = now.toDateString();
  const isFolded = () => { try { return localStorage.getItem(foldKey) === today; } catch { return false; } };
  const setFold = on => {
    root.classList.toggle('folded', on);
    chev.setAttribute('aria-expanded', String(!on)); chev.setAttribute('aria-label', on ? 'Expand the playbook' : 'Collapse the playbook'); chev.title = on ? 'Expand' : 'Collapse';
    try { on ? localStorage.setItem(foldKey, today) : localStorage.removeItem(foldKey); } catch {}
  };
  top.addEventListener('click', e => { if (!e.target.closest('a, button:not(.pbo-fold), input')) setFold(!root.classList.contains('folded')); });
  const n = nextSlot(x);
  if (n) { const peek = el('span', 'pbo-peek'); peek.append(`${pbHour(n.h)} ${n.text} in `, secEl('', n.at)); top.insertBefore(peek, top.lastChild); }
  t.append(top, el('p', 'pbo-bl-plan', x.play[1]), el('p', 'pbo-bl-plays', x.play[0]));
  const gauges = el('div', 'pbo-minis');
  gauges.append(biasGauge(x), rsiGauge(x), stratGauge(x, now.getTime()), roomGauge(x, opts.held || []));
  const head = el('div', 'pbo-hh');
  head.append(t, gauges);

  root.replaceChildren(head, timeline(x, now.getTime()), guidelines(opts));
  root.className = 'day-playbook pbo-hero c12 pb-' + x.verdict + ' ' + x.verdict;
  setFold(isFolded());
  root.hidden = false;
}
