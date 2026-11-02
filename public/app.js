import {
  summarize, groupStats, periodPnl, byWeekday, byHour, histogram, insights,
  dailyMap, dayStreaks, tradingScore, calendarMonth, scaleOf, dayKey, WEEKDAYS, warnings, WARN, dailyLoss, weekStart, weekReview,
} from './metrics.js';
import { normalizeAll } from './trades.js';
import { pull } from './sync.js';
import { idbGet, idbSet } from './db.js';
import { writeReport } from './report.js';
import { lineChart, columnChart, hbarChart, gauge, splitBar, sparkline, radar, heatClass, tipOn, hideTip, calm, setCalm, donut, meter } from './charts.js';

const $ = s => document.querySelector(s);
const DAY = 86_400_000;
const MINUS = '−';

// ---------- formatting ----------
const money = (v, { sign = true, dp } = {}) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), d = dp ?? (a >= 1000 ? 0 : 2);
  return (v < 0 ? MINUS : sign && v > 0 ? '+' : '') + '$' + a.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const compact = v => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K' : a.toFixed(a < 10 && a % 1 ? 1 : 0);
  return (v < 0 ? MINUS : '') + '$' + s.replace(/\.0(?=[KM]?$)/, '');
};
const signedCompact = v => (v > 0 ? '+' : '') + compact(v);
const pct = (v, dp = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v * 100).toFixed(dp) + '%');
const signedPct = v => (v === null || !Number.isFinite(v) ? '—' : (v < 0 ? MINUS : v > 0 ? '+' : '') + Math.abs(v * 100).toFixed(1) + '%');
const ratio = v => (v === null || v === undefined ? '—' : v === Infinity ? '∞' : v.toFixed(2));
const price = v => (v ? v.toLocaleString(undefined, { maximumSignificantDigits: 6 }) : '—');
const dateTime = ms => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const date = ms => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const longDate = d => d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const ago = ms => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
// Numbers ease from their last value to the new one. Text is always the final
// formatted value at the end; with reduced motion it's set straight away.
function countTo(node, value, fmt) {
  cancelAnimationFrame(node._raf);
  const from = node._v ?? 0;
  node._v = value;
  if (!Number.isFinite(value) || !Number.isFinite(from) || calm() || from === value) { node.textContent = fmt(value); return; }
  const t0 = performance.now(), dur = 700;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
    node.textContent = fmt(k < 1 ? from + (value - from) * e : value);
    if (k < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}
// calendar cells are narrow: whole dollars from $100 up
const calMoney = v => money(v, { dp: Math.abs(v) >= 100 ? 0 : 2 });
const pnlRow = v => ({ value: money(v), key: v >= 0 ? 'pos' : 'neg' });
const sign = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
// date inputs <-> local-day timestamps
const toInput = ms => dayKey(new Date(ms));
const fromInput = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const endOfDay = ms => { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); };
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ---------- per-viewer preferences ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('perp-report:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('perp-report:' + k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------
let all = [], status = null, account = null, coveredSpans = [];
const filters = { range: 'all', from: null, to: null, symbol: 'all', side: 'all', strategy: 'all', ...store.get('filters', {}) };
let view = store.get('view', 'dashboard');
let cal = null;                                  // { y, m } shown in the calendar
const tableState = { sort: 'time', dir: -1, shown: 50 };

// ---------- theme ----------
// Each theme: id, name, mode, a one-line tagline and four swatch colours (page, card, accent, gain).
const THEMES = [
  { id: 'polar', name: 'Dark Polar', mode: 'dark', note: 'Gunmetal and neon', sw: ['#0d0f12', '#171a1f', '#fb923c', '#0ea5c6'] },
  { id: 'classic', name: 'Classic Light', mode: 'light', note: 'Clean and quiet', sw: ['#f4f5f7', '#ffffff', '#2563eb', '#dc3d3d'] },
  { id: 'cream', name: 'Cream Pastel', mode: 'light', note: 'Soft paper, candy accents', sw: ['#f6efe3', '#fffaf0', '#e993b7', '#a99ae6'] },
  { id: 'terminal', name: 'Terminal', mode: 'dark', note: 'Phosphor green, monospace', sw: ['#050805', '#0b100b', '#39ff7a', '#ffb000'] },
  { id: 'atelier', name: 'Atelier', mode: 'light', note: 'Bold ink, editorial serif', sw: ['#f3ede2', '#141414', '#f2b705', '#e2401f'] },
  { id: 'dojo', name: 'Dojo Ink', mode: 'dark', note: 'Lacquer, gold and mincho', sw: ['#12100d', '#1d1914', '#d4a24c', '#e35a43'] },
  { id: 'glass', name: 'Glass', mode: 'dark', note: 'Frosted panes over drifting colour', sw: ['#7c5cff', '#22d3ee', '#f472b6', '#fbbf77'] },
  { id: 'synthwave', name: 'Synthwave', mode: 'dark', note: 'Neon sun, endless grid', sw: ['#120a24', '#ff4fd8', '#22e5ff', '#ffd23f'] },
  { id: 'broadsheet', name: 'Broadsheet', mode: 'light', note: 'The morning paper', sw: ['#f1ece0', '#1a1a1a', '#b8322a', '#1f5fa8'] },
  { id: 'arcade', name: 'Arcade', mode: 'dark', note: '8-bit console, insert coin', sw: ['#1d2b53', '#ffec27', '#ff77a8', '#00e436'] },
];
const LEGACY_THEME = { dark: 'polar', light: 'classic' };
const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'polar' : 'classic');
const savedTheme = () => { const t = store.get('theme', null); const id = LEGACY_THEME[t] || t; return THEMES.some(x => x.id === id) ? id : null; };
function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  document.documentElement.dataset.mode = t.mode;
  $('#themeBtn').title = 'Theme: ' + t.name;
  $('#themeMenu').querySelectorAll('.theme-opt').forEach(b => b.setAttribute('aria-checked', String(b.dataset.theme === t.id)));
}
// Lives on <body>: inside the sticky sidebar's stacking context, dashboard cards would paint over it.
document.body.appendChild($('#themeMenu'));
$('#themeMenu').innerHTML = THEMES.map(t => `<button class="theme-opt" type="button" role="menuitemradio" data-theme="${t.id}" aria-checked="false">
  <span class="theme-sw">${t.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>
  <span class="theme-name">${t.name}<small>${t.note}</small></span><span class="theme-check">✓</span></button>`).join('');
// Fixed-positioned so the sidebar's scroll box can't clip it: opens above the button, or below when there's no room.
function themeMenu(open) {
  const m = $('#themeMenu'), r = $('#themeBtn').getBoundingClientRect();
  if (open) {
    const w = Math.min(470, innerWidth - 16), left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    Object.assign(m.style, { left: left + 'px', width: w + 'px' });
    if (r.top > innerHeight / 2) Object.assign(m.style, { top: '', bottom: innerHeight - r.top + 8 + 'px', maxHeight: r.top - 16 + 'px' });
    else Object.assign(m.style, { bottom: '', top: r.bottom + 8 + 'px', maxHeight: innerHeight - r.bottom - 16 + 'px' });
  }
  m.classList.toggle('open', open); $('#themeBtn').setAttribute('aria-expanded', String(open));
}
addEventListener('resize', () => themeMenu(false));
$('#themeBtn').onclick = e => { e.stopPropagation(); themeMenu(!$('#themeMenu').classList.contains('open')); };
$('#themeMenu').onclick = e => {
  const b = e.target.closest('.theme-opt'); if (!b) return;
  store.set('theme', b.dataset.theme); applyTheme(b.dataset.theme); themeMenu(false);
};
document.addEventListener('click', e => { if (!e.target.closest('.theme-wrap, #themeMenu')) themeMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') themeMenu(false); });
applyTheme(savedTheme() || systemTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!savedTheme()) applyTheme(systemTheme()); });

// ---------- views ----------
const TITLES = { dashboard: 'Dashboard', analytics: 'Analytics', journal: 'Journal', review: 'Weekly review', playbook: 'Playbook', wizard: 'Entry wizard', trades: 'Trades' };
function setView(v, { hash = true } = {}) {
  view = v; store.set('view', v);
  if (hash) syncHash();
  document.querySelectorAll('[data-view]').forEach(b => (b.dataset.view === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  for (const k of Object.keys(TITLES)) $('#view-' + k).hidden = k !== v;
  $('#viewTitle').textContent = TITLES[v];
  if (all.length || status) render();
}
document.querySelectorAll('[data-view]').forEach(b => (b.onclick = () => setView(b.dataset.view)));

function show(id) {
  const first = id === 'report' && $('#report').hidden;
  for (const s of ['setup', 'empty', 'report']) $('#' + s).hidden = s !== id;
  if (first && !calm()) {
    // cards rise in, left to right and top to bottom, once per page load
    document.querySelectorAll('#report .head, .grid > .card, .stack > .card').forEach((c, i) => c.style.setProperty('--i', i));
    document.body.classList.add('intro');
    setTimeout(() => document.body.classList.remove('intro'), 1600);
  }
}

document.querySelectorAll('[data-info]').forEach(b => tipOn(b, '', [{ value: '', label: b.dataset.info }]));

// ---------- API: every call carries the password, if one is set ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const pw = store.get('password', null);
  if (pw) headers['x-perp-key'] = pw;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401) {
    if (await askPassword(pw ? 'That password didn’t work. Try again.' : '')) return api(path, opts);
    throw new Error('Perp Dojo needs its password to talk to the server.');
  }
  return r;
}
async function apiJson(path, opts) {
  const r = await api(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}
function askPassword(note) {
  const dlg = $('#pwDlg');
  $('#pwNote').textContent = note || '';
  $('#pwNote').hidden = !note;
  $('#pwInput').value = '';
  dlg.showModal();
  return new Promise(resolve => {
    $('#pwForm').onsubmit = e => { e.preventDefault(); const v = $('#pwInput').value; if (!v) return; store.set('password', v); dlg.close(); resolve(true); };
    $('#pwCancel').onclick = () => { dlg.close(); resolve(false); };
  });
}

// ---------- data lives in this browser; the server only proxies Bybit ----------
let cache = null;                                   // raw closed P&L + fills, as stored in IndexedDB
const uidKey = k => `${k}:${status?.key?.uid ?? 'local'}`;

async function loadStatus(recheck) {
  status = await apiJson('/api/status' + (recheck ? '?recheck' : ''));
  const k = status.key;
  $('#account').textContent = k.ok ? `UID ${k.uid} · ${k.keyHint}` : '';
  for (const id of ['#pullBtn', '#syncBtn', '#saveBtn', '#loadBtn']) $(id).hidden = !k.ok;
  if (!k.ok) { show('setup'); $('#setupMsg').textContent = k.message; paintConnection(); return; }
  const warn = k.daysLeft !== null && k.daysLeft <= 14 ? `This API key expires in ${k.daysLeft} day${k.daysLeft === 1 ? '' : 's'}.` : '';
  $('#keyWarn').textContent = warn; $('#keyWarn').hidden = !warn;
  try { cache = await idbGet(uidKey('cache')); } catch { cache = null; }
  paintServerState();
  if (!cache || !Object.keys(cache.raw || {}).length) { all = []; coveredSpans = []; show('empty'); paintCoverage(); return; }
  applyCache();
  loadAccount();
}

function applyCache() {
  all = normalizeAll(cache.raw, cache.execs).trades;
  paintBanners();
  coveredSpans = cache.covered || [];
  $('#syncState').textContent = cache.syncedAt ? `Pulled ${ago(cache.syncedAt)}` : '';
  paintCoverage();
  const syms = [...new Set(all.map(t => t.symbol))].sort();
  const sel = $('#symbolFilter');
  sel.replaceChildren(new Option('All markets', 'all'), ...syms.map(s => new Option(s, s)));
  if (!syms.includes(filters.symbol)) filters.symbol = 'all';
  sel.value = filters.symbol;
  $('#sideFilter').value = filters.side;
  paintStrategyFilter();
  if (!cal) cal = monthOf(rangeEnd());
  show('report');
  setView(view);
}

async function loadAccount() {
  try { account = await apiJson('/api/account'); } catch { account = null; }
  paintConnection();
  if (view === 'dashboard') paintAccount();
  if (view === 'wizard') renderWizard();
}

function paintCoverage() {
  const spans = coveredSpans, short = ms => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  const c = $('#coverage');
  c.textContent = !spans.length ? 'No data yet' : `${short(spans[0][0])} – ${short(spans[spans.length - 1][1])}`;
  $('#pullBtn').dataset.tip = `Choose exact days to fetch from Bybit. Replaces what's loaded${spans.length ? ` (${date(spans[0][0])} – ${date(spans[spans.length - 1][1])}, ${all.length.toLocaleString()} trades)` : ''}.`;
  c.dataset.tip = !spans.length ? 'No data pulled yet. Use the link icon to pull from Bybit.'
    : `Loaded ${spans.map(s => `${date(s[0])} – ${date(s[1])}`).join(', ')} · ${all.length.toLocaleString()} trades`;
}

async function runSync({ from, to, replace = false }) {
  const bar = $('#progress'), fill = bar.firstElementChild;
  const buttons = ['#syncBtn', '#pullBtn', '#pullBtn2', '#saveBtn', '#loadBtn', '#loadBtn2'];
  bar.hidden = false; fill.style.width = '2%';
  for (const b of buttons) $(b).disabled = true;
  $('#report').classList.add('refreshing');
  $('#syncState').textContent = 'Pulling from Bybit…';
  try {
    const r = await pull(cache, { from, to, replace, earliest: status.earliest }, {
      fetchWindow: w => apiJson('/api/pull?' + new URLSearchParams({ category: w.category, start: w.start, end: w.end, ...(w.fillsOnly ? { fillsOnly: 1 } : {}) })),
      onProgress: p => {
        fill.style.width = Math.max(2, (100 * p.done) / p.total) + '%';
        $('#syncState').textContent = `Pulling… ${Math.round((100 * p.done) / p.total)}%`;
      $('#syncState').dataset.tip = `${p.category === 'linear' ? 'USDT/USDC perps' : 'Inverse'} through ${date(p.through)} · ${p.added} new so far`;
      },
    });
    cache = r.cache;
    await idbSet(uidKey('cache'), cache);
    markLocalChange();
    if (replace) {
      // a fresh dataset: show all of it, starting from its latest month
      Object.assign(filters, { range: 'all', from: null, to: null, symbol: 'all', side: 'all' });
      saveFilters();
      cal = null;
    }
    applyCache();
    loadAccount();
    if (r.warnings.length) alertBox(r.warnings.slice(0, 3).join(' '));
    $('#syncState').textContent = replace
      ? `Loaded ${r.total.toLocaleString()} trade${r.total === 1 ? '' : 's'}`
      : r.added ? `+${r.added} new trade${r.added === 1 ? '' : 's'}` : 'Up to date';
  } catch (e) {
    $('#syncState').textContent = '';
    alertBox(`Pull stopped: ${e.message} Your previous data is unchanged.`);
  } finally {
    bar.hidden = true;
    for (const b of buttons) $(b).disabled = false;
    $('#report').classList.remove('refreshing');
  }
}
function alertBox(msg) { const a = $('#alert'); a.textContent = msg; a.hidden = false; }
$('#alert').onclick = () => ($('#alert').hidden = true);
$('#recheck').onclick = () => loadStatus(true);
$('#syncBtn').onclick = () => runSync({});

// ---------- server copy: only on Save / Load, never automatically ----------
// One gzip snapshot per click keeps Blob usage to a single write per save.
const gzip = s => new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
const gunzip = buf => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
function markLocalChange() { store.set(uidKey('localChangedAt'), Date.now()); paintServerState(); }
function paintServerState() {
  const saved = store.get(uidKey('serverSavedAt'), null), changed = store.get(uidKey('localChangedAt'), null);
  const unsaved = changed && (!saved || changed > saved);
  const none = status?.storage === 'none';
  $('#saveBtn').classList.toggle('unsaved', !!unsaved && !none);
  $('#saveBtn').disabled = none;
  $('#loadBtn').disabled = none;
  $('#serverState').textContent = none ? 'No server storage'
    : unsaved ? 'Unsaved changes' : saved ? `Saved ${ago(saved)}` : 'Saved in browser';
  $('#saveBtn').dataset.tip = none ? 'No server storage connected yet. Everything stays in this browser.'
    : unsaved ? (saved ? `You have unsaved changes. Last saved ${ago(saved)}.` : 'Not saved to the server yet. Uploads your trades, journal and playbook.') : saved ? `Everything's saved. Last saved ${ago(saved)}.` : 'Upload your trades, journal and playbook as one snapshot.';
}
async function saveToServer() {
  const btn = $('#saveBtn'); btn.disabled = true;
  try {
    flushJournal();
    const savedAt = Date.now();
    flushPlaybook();
    flushToday(); flushReview();
    const snap = { app: 'perp-dojo', v: 4, uid: status.key.uid, savedAt, cache, journal: journalAll(), playbook: playbookAll(), labels: labelsAll(), pledges: pledgeList(), weekly: weeklyAll() };
    const body = await gzip(JSON.stringify(snap));
    const r = await apiJson('/api/snapshot', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
    store.set(uidKey('serverSavedAt'), savedAt);
    $('#serverState').textContent = `Saved to server just now · ${Math.round(r.bytes / 1024).toLocaleString()} KB`;
    setTimeout(paintServerState, 4000);
  } catch (e) {
    alertBox(`Couldn't save to the server: ${e.message} Everything is still safe in this browser.`);
  } finally { btn.disabled = status?.storage === 'none'; paintServerState(); }
}
async function loadFromServer() {
  if (!confirm('Replace the trades and journal in this browser with the copy saved on the server?')) return;
  try {
    const r = await api('/api/snapshot');
    if (r.status === 404) return alertBox('Nothing has been saved to the server yet.');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Server error ${r.status}`);
    const snap = JSON.parse(await gunzip(await r.arrayBuffer()));
    if (snap.app !== 'perp-dojo' || !snap.cache) throw new Error('That file isn’t a Perp Dojo snapshot.');
    cache = snap.cache;
    await idbSet(uidKey('cache'), cache);
    store.set(journalKey(), snap.journal || {});
    journalCache = null;
    store.set(playbookKey(), snap.playbook || []);
    store.set(labelsKey(), snap.labels || {});
    if (snap.pledges) store.set(pledgesKey(), snap.pledges);
    if (snap.weekly) store.set(weeklyKey(), snap.weekly);
    pbCache = null; labelsCache = null;
    pb.id = null;
    store.set(uidKey('serverSavedAt'), snap.savedAt);
    store.set(uidKey('localChangedAt'), snap.savedAt);
    cal = null;
    applyCache();
    paintServerState();
    $('#serverState').textContent = `Loaded the server copy from ${date(snap.savedAt)}`;
  } catch (e) {
    alertBox(`Couldn't load from the server: ${e.message}`);
  }
}
$('#saveBtn').onclick = saveToServer;
$('#loadBtn').onclick = $('#loadBtn2').onclick = loadFromServer;

// ---------- pull dialog: exact days ----------
const pullDlg = $('#pullDlg');
function openPull() {
  const today = startOfDay(Date.now());
  $('#pullFrom').value = toInput(coveredSpans.length ? coveredSpans[0][0] : today - 29 * DAY);
  $('#pullTo').value = toInput(today);
  $('#pullFrom').min = $('#pullTo').min = toInput(status?.earliest ?? today - 729 * DAY);
  $('#pullFrom').max = $('#pullTo').max = toInput(today);
  $('#pullError').hidden = true;
  paintPullNote();
  pullDlg.showModal();
}
function paintPullNote() {
  const f = $('#pullFrom').value, t = $('#pullTo').value;
  const have = coveredSpans.length ? `This replaces the ${all.length.toLocaleString()} trades loaded now (${coveredSpans.map(s => `${date(s[0])} – ${date(s[1])}`).join(', ')}).` : '';
  if (!f || !t) { $('#pullNote').textContent = have; return; }
  const days = Math.round((fromInput(t) - fromInput(f)) / DAY) + 1;
  const weeks = Math.ceil(days / 7);
  $('#pullNote').textContent = `${days.toLocaleString()} day${days === 1 ? '' : 's'}, about ${Math.max(1, Math.round(weeks * 2 * 0.15))} seconds. ${have}`;
}
$('#pullFrom').oninput = $('#pullTo').oninput = paintPullNote;
$('#pullQuick').querySelectorAll('button').forEach(b => (b.onclick = () => {
  const today = startOfDay(Date.now());
  const from = b.dataset.days === 'max' ? (status?.earliest ?? today - 729 * DAY) : today - (Number(b.dataset.days) - 1) * DAY;
  $('#pullFrom').value = toInput(from); $('#pullTo').value = toInput(today); paintPullNote();
}));
$('#pullBtn').onclick = $('#pullBtn2').onclick = openPull;
$('#pullCancel').onclick = () => pullDlg.close();
$('#pullForm').onsubmit = e => {
  e.preventDefault();
  const f = $('#pullFrom').value, t = $('#pullTo').value;
  const err = m => { $('#pullError').textContent = m; $('#pullError').hidden = false; };
  if (!f || !t) return err('Pick both a start and an end day.');
  const from = fromInput(f), to = Math.min(endOfDay(fromInput(t)), Date.now());
  if (from > to) return err('The start day is after the end day.');
  if (status?.earliest && from < startOfDay(status.earliest)) return err(`Bybit keeps about two years. The earliest day you can pull is ${date(status.earliest)}.`);
  pullDlg.close();
  runSync({ from, to, replace: true });
};

// ---------- range (view filter) ----------
const PRESETS = [
  ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'],
  ['month', 'This month'], ['lastMonth', 'Last month'], ['ytd', 'Year to date'], ['1y', 'Last 12 months'], ['all', 'All time'],
];
function rangeBounds(r = filters) {
  const now = Date.now(), today = startOfDay(now), d = new Date();
  switch (r.range) {
    case 'today': return [today, now];
    case '7d': return [today - 6 * DAY, now];
    case '30d': return [today - 29 * DAY, now];
    case '90d': return [today - 89 * DAY, now];
    case 'month': return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), now];
    case 'lastMonth': return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 1];
    case 'ytd': return [new Date(d.getFullYear(), 0, 1).getTime(), now];
    case '1y': return [today - 364 * DAY, now];
    case 'custom': return [r.from, r.to];
    default: return [null, null];
  }
}
function rangeLabel() {
  if (filters.range === 'custom') return `${date(filters.from)} – ${date(filters.to)}`;
  return PRESETS.find(p => p[0] === filters.range)?.[1] || 'All time';
}
const rangeDlg = $('#rangeDlg');
$('#rangeBtn').onclick = () => {
  const box = $('#presets');
  box.replaceChildren(...PRESETS.map(([k, label]) => {
    const b = el('button'); b.type = 'button';
    b.append(el('span', 'check', filters.range === k ? '✓' : ''), document.createTextNode(label));
    b.onclick = () => { setFilters({ range: k, from: null, to: null }); rangeDlg.close(); };
    return b;
  }));
  const [f, t] = rangeBounds();
  const first = all[0]?.time ?? Date.now(), last = all[all.length - 1]?.time ?? Date.now();
  $('#rangeFrom').value = toInput(f ?? first);
  $('#rangeTo').value = toInput(t ?? last);
  rangeDlg.showModal();
};
$('#rangeCancel').onclick = () => rangeDlg.close();
$('#rangeForm').onsubmit = e => {
  e.preventDefault();
  let from = fromInput($('#rangeFrom').value), to = endOfDay(fromInput($('#rangeTo').value));
  if (from > to) [from, to] = [startOfDay(to), endOfDay(from)];
  setFilters({ range: 'custom', from, to });
  rangeDlg.close();
};
const saveFilters = () => store.set('filters', { range: filters.range, from: filters.from, to: filters.to, side: filters.side, strategy: filters.strategy });
function setFilters(patch) {
  Object.assign(filters, patch);
  saveFilters();
  tableState.shown = 50;
  if ('range' in patch) cal = monthOf(rangeEnd());
  render();
}
// the last day the current range covers: its end, today, or the latest trade for "all time"
function rangeEnd() {
  const [, to] = rangeBounds();
  if (to !== null) return Math.min(to, Date.now());
  return all.length ? all[all.length - 1].time : Date.now();
}
const monthOf = ms => { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth() }; };
$('#symbolFilter').onchange = e => setFilters({ symbol: e.target.value });
$('#sideFilter').onchange = e => setFilters({ side: e.target.value });
$('#strategyFilter').onchange = e => setFilters({ strategy: e.target.value });

// market + side only
const strategyMatch = t => filters.strategy === 'all' || (filters.strategy === 'none' ? !strategyOf(t) : strategyOf(t) === filters.strategy);
const scoped = () => all.filter(t => (filters.symbol === 'all' || t.symbol === filters.symbol) && (filters.side === 'all' || t.dir === filters.side) && strategyMatch(t));
function filtered() {
  const [from, to] = rangeBounds();
  return scoped().filter(t => (from === null || t.time >= from) && (to === null || t.time <= to));
}

// ---------- render ----------
function render() {
  if ($('#report').hidden) return;
  $('#rangeLabel').textContent = rangeLabel();
  const trades = filtered();
  const s = summarize(trades);
  const [from, to] = rangeBounds();
  $('#rangeText').textContent = s.n
    ? `${s.n.toLocaleString()} closed trade${s.n === 1 ? '' : 's'} · ${date(from ?? s.first)} – ${date(to ?? s.last)}${filters.symbol !== 'all' ? ' · ' + filters.symbol : ''}${filters.side !== 'all' ? ' · ' + filters.side.toLowerCase() + 's' : ''}${filters.strategy !== 'all' ? ' · ' + (filters.strategy === 'none' ? 'unlabeled' : strategyName(filters.strategy)) : ''}`
    : 'No closed trades in this range.';
  // the journal is about days, not the filtered range: no filters, its own subtitle
  $('#report .filters').hidden = ['journal', 'playbook', 'wizard', 'review'].includes(view);
  if (view === 'review') $('#rangeText').textContent = 'One week at a time: the numbers, your rules, and what to change';
  if (view === 'wizard') $('#rangeText').textContent = 'Check the setup, get the amount to risk';
  if (view === 'journal') {
    const n = Object.keys(journalAll()).filter(journalHas).length;
    $('#rangeText').textContent = `${n} entr${n === 1 ? 'y' : 'ies'} · pick any day, or click one on the dashboard calendar`;
  }
  paintStatusStats(s);
  if (view === 'dashboard') renderDashboard(trades, s, from, to);
  else if (view === 'analytics') renderAnalytics(trades, s, from, to);
  else if (view === 'journal') renderJournal();
  else if (view === 'playbook') renderPlaybook();
  else if (view === 'wizard') renderWizard();
  else if (view === 'review') renderReview();
  else renderTrades(trades);
}

// ===== dashboard =====
function renderDashboard(trades, s, from, to) {
  renderToday();
  const daily = dailyMap(trades);
  const ds = dayStreaks(daily);

  // net P&L
  countTo($('#netValue'), s.net, v => money(v));
  $('#netMark').className = 'mark-glyph ' + (s.net >= 0 ? 'pos' : 'neg');
  $('#netMark').textContent = s.n ? (s.net >= 0 ? '▲' : '▼') : '';
  sparkline($('#netSpark'), { values: s.n ? [0, ...s.equity.map(p => p.y)] : [], color: 'hero', bleed: true });

  // trade win %: wins / breakeven / losses
  countTo($('#winValue'), s.winRate, v => pct(v, 1));
  gauge($('#winGauge'), { size: 84, label: `Trade win rate ${pct(s.winRate, 1)}`, parts: s.n ? [{ share: s.wins / s.n, cls: 'pos' }, { share: s.breakeven / s.n, cls: 'mid' }, { share: s.losses / s.n, cls: 'neg' }] : null, frac: s.n ? undefined : null });
  chips($('#winChips'), [[s.wins, 'pos', 'won'], [s.breakeven, 'mid', 'breakeven'], [s.losses, 'neg', 'lost']], 'trades');

  // profit factor
  countTo($('#pfValue'), s.profitFactor, ratio);
  $('#pfSub').textContent = s.n ? `${compact(s.grossWin)} / ${compact(s.grossLoss)}` : '';
  donut($('#pfDonut'), { a: s.grossWin, b: s.grossLoss, size: 54, label: `Gross wins ${money(s.grossWin, { sign: false })}, gross losses ${money(s.grossLoss, { sign: false })}` });

  // day win %: green / flat / red days
  countTo($('#dayValue'), ds.days ? ds.green / ds.days : null, v => pct(v, 1));
  gauge($('#dayGauge'), { size: 84, label: `Day win rate ${ds.days ? pct(ds.green / ds.days, 1) : '—'}`, parts: ds.days ? [{ share: ds.green / ds.days, cls: 'pos' }, { share: ds.flat / ds.days, cls: 'mid' }, { share: ds.red / ds.days, cls: 'neg' }] : null, frac: ds.days ? undefined : null });
  chips($('#dayChips'), [[ds.green, 'pos', 'green'], [ds.flat, 'mid', 'flat'], [ds.red, 'neg', 'red']], 'days');

  // avg win / avg loss
  countTo($('#payoffValue'), s.payoff, ratio);
  splitBar($('#payoffBar'), { left: s.avgWin || 0, right: s.avgLoss || 0, label: `Average win ${money(s.avgWin, { sign: false })}, average loss ${money(s.avgLoss, { sign: false })}` });
  $('#avgWin').textContent = money(s.avgWin, { sign: false });
  $('#avgLoss').textContent = money(-s.avgLoss || null);

  renderWarnings(s, ds);

  // cumulative P&L
  const tradeAt = new Map(trades.map(t => [t.time, t]));
  lineChart($('#netChart'), {
    points: s.n ? [{ x: s.equity[0].x - 1, y: 0 }, ...s.equity] : [], height: 170, signed: true, smooth: true, fmtTick: compact, label: 'Cumulative net P&L',
    tipTitle: p => dateTime(p.x),
    tipRows: p => { const t = tradeAt.get(p.x); return [{ value: money(p.y), label: 'cumulative', key: 'line' }, ...(t ? [{ value: money(t.pnl), label: `${t.symbol} ${t.dir.toLowerCase()}`, key: sign(t.pnl) || 'line' }] : [])]; },
  });

  renderCalendar();
  paintAccount();

  // streaks
  const run = (node, n, unit) => {
    node.replaceChildren();
    if (!n) { node.textContent = '—'; return; }
    const g = el('span', 'glyph ' + (n > 0 ? 'pos' : 'neg'), n > 0 ? '▲' : '▼'); g.setAttribute('aria-hidden', 'true');
    node.append(g, document.createTextNode(`${Math.abs(n)} ${n > 0 ? 'winning' : 'losing'} ${unit}${Math.abs(n) === 1 ? '' : 's'}`));
  };
  const count = (node, n, unit, s) => {
    node.replaceChildren();
    if (!n) { node.textContent = '—'; return; }
    const g = el('span', 'glyph ' + s, s === 'pos' ? '▲' : '▼'); g.setAttribute('aria-hidden', 'true');
    node.append(g, document.createTextNode(`${n} ${unit}${n === 1 ? '' : 's'}`));
  };
  run($('#stCurDays'), ds.current, 'day');
  run($('#stCurTrades'), s.currentStreak, 'trade');
  count($('#stWinDays'), ds.bestWin, 'day', 'pos');
  count($('#stWinTrades'), s.maxWinStreak, 'trade', 'pos');
  count($('#stLossDays'), ds.bestLoss, 'day', 'neg');
  count($('#stLossTrades'), s.maxLossStreak, 'trade', 'neg');

  // score
  const sc = tradingScore(s, ds);
  if (sc) {
    radar($('#radar'), { score: null, label: `Trading score ${sc.score.toFixed(1)} of 100`, axes: sc.axes.map(a => ({ ...a, tipRows: [{ value: `${Math.round(a.value)} / 100` }, { value: '', label: a.how }] })) });
    countTo($('#scoreValue'), sc.score, v => v.toFixed(1));
    meter($('#scoreMeter'), { value: sc.score, label: 'Trading score' });
  } else {
    $('#radar').replaceChildren(el('p', 'empty', 'Needs at least 10 trades in this range.'));
    $('#scoreValue').textContent = '—'; $('#scoreValue')._v = null;
    meter($('#scoreMeter'), { value: 0, label: 'Trading score' });
  }

  renderHeatmap();
  renderThisWeek(trades);
  renderBestHour(trades);
  renderPerf(trades, s, daily, from, to);
  renderRisk(s);
  const list = insights(trades, s, v => money(v));
  $('#insightsCard').hidden = !list.length;
  $('#insights').replaceChildren(...list.slice(0, 6).map(t => el('li', '', t)));
}

// ---- warnings line: the three most serious, critical first ----
const WARN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.2v3.6M8 11.6v.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function renderWarnings(s, ds) {
  const box = $('#warnings');
  const list = warnings({ recent: scoped(), s, ds, keyDaysLeft: status?.key?.daysLeft ?? null, fmt: v => money(v), fmtAgo: ago });
  const dl = lossToday();
  if (dl.hit) list.push({ level: 'critical', rank: 99, text: `Daily loss limit hit: ${money(dl.net)} today`, detail: `That's ${dl.lossPct.toFixed(1)}% of the account, past your ${WARN.dailyLossPct}% limit. Stop for today.` });
  else if (dl.used >= 0.5) list.push({ level: 'warning', rank: 85, text: `Down ${dl.lossPct.toFixed(1)}% today · limit ${WARN.dailyLossPct}%`, detail: `${money(dl.net)} today. ${money(-(dl.limit + dl.net), { sign: false })} left before the daily limit.` });
  const ck = checkin();
  if (!ck.complete) {
    list.push({ level: 'warning', rank: 80, text: 'Daily check-in not done', detail: `${ck.affirmed.length} of ${ck.list.length} commitments affirmed${ck.wrote ? '' : ', and nothing written in today’s journal yet'}. Finish it at the top of the dashboard before you trade.` });
  }
  list.sort((a, b) => (a.level === b.level ? b.rank - a.rank : a.level === 'critical' ? -1 : 1));
  box.replaceChildren();
  box.classList.toggle('clear', !list.length);
  if (!list.length) { box.append(el('span', 'warn-ok', '✓ No warnings')); return; }
  for (const w of list.slice(0, 3)) {
    const item = el('span', 'warn ' + w.level);
    item.tabIndex = 0;
    const icon = el('span', 'warn-icon'); icon.innerHTML = WARN_ICON;
    item.append(icon, el('span', 'warn-label', w.level === 'critical' ? 'Critical' : 'Warning'), el('span', 'warn-text', w.text));
    tipOn(item, w.level === 'critical' ? 'Critical' : 'Warning', [{ value: w.text }, { value: '', label: w.detail }]);
    box.append(item);
  }
  if (list.length > 3) {
    const more = el('span', 'warn-more', `+${list.length - 3} more`);
    more.tabIndex = 0;
    tipOn(more, 'Also flagged', list.slice(3).map(w => ({ value: w.text, label: w.level })));
    box.append(more);
  }
}

// count chips under a gauge: [[n, cls, label]]
function chips(node, items, unit) {
  node.replaceChildren(...items.map(([n, cls, label]) => {
    const c = el('span', 'chip ' + cls, String(n));
    tipOn(c, '', [{ value: `${n} ${label}`, label: unit, key: cls === 'mid' ? '' : cls }]);
    return c;
  }));
}

// the eye button masks the balance; remembered in this browser
const EYE_OPEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S4.8 4 10 4s8.5 6 8.5 6-3.3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.6"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S4.8 4 10 4s8.5 6 8.5 6-3.3 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.6"/><path d="M3 17 17 3"/></svg>';
const MASK = '******';
let balanceHidden = store.get('hideBalance', false);
function paintEye() {
  const b = $('#eyeBtn');
  b.innerHTML = balanceHidden ? EYE_SHUT : EYE_OPEN;
  b.setAttribute('aria-pressed', String(balanceHidden));
  const label = balanceHidden ? 'Show balance' : 'Hide balance';
  b.setAttribute('aria-label', label); b.title = label;
}
$('#eyeBtn').onclick = () => { balanceHidden = !balanceHidden; store.set('hideBalance', balanceHidden); paintEye(); paintAccount(); paintStatusStats(); };
paintEye();

function paintAccount() {
  if (account?.available && balanceHidden) {
    const v = $('#equityValue'); cancelAnimationFrame(v._raf); v._v = null; v.textContent = '$' + MASK;
    $('#equitySub').textContent = `${MASK} unrealized · ${MASK} wallet · as of ${time(account.at)}`;
    $('#equityNote').hidden = false;
    return;
  }
  if (!account?.available) {
    $('#equityValue').textContent = '—';
    $('#equitySub').textContent = account?.error ? 'Bybit didn’t return a balance for this key.' : 'Loading…';
    return;
  }
  countTo($('#equityValue'), account.equity, v => money(v, { sign: false, dp: 2 }));
  const parts = [];
  if (account.unrealized !== null) parts.push(`${money(account.unrealized)} unrealized`);
  if (account.wallet !== null) parts.push(`${money(account.wallet, { sign: false })} wallet`);
  $('#equitySub').textContent = parts.join(' · ') + ` · as of ${time(account.at)}`;
  $('#equityNote').hidden = false;
}

// ---- calendar ----
$('#calPrev').onclick = () => { cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } renderCalendar(); };
$('#calNext').onclick = () => { cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } renderCalendar(); };
$('#calToday').onclick = () => { const d = new Date(); cal = { y: d.getFullYear(), m: d.getMonth() }; renderCalendar(); };

function renderCalendar() {
  const daily = dailyMap(filtered());
  const [rf, rt] = rangeBounds();
  const inRange = d => (rf === null || d.getTime() + DAY > rf) && (rt === null || d.getTime() <= rt);
  const month = calendarMonth(daily, cal.y, cal.m);
  $('#calTitle').textContent = new Date(cal.y, cal.m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const stat = (k, v) => { const d = el('div'); d.append(el('dt', '', k), el('dd', '', v)); return d; };
  $('#calStats').replaceChildren(
    stat('Trades', month.n.toLocaleString()), stat('Wins', month.wins.toLocaleString()),
    stat('Win rate', month.n ? pct(month.wins / month.n) : '—'), stat('Net P&L', money(month.net)),
  );
  const days = month.weeks.flatMap(w => w.days).filter(d => d.inMonth && d.n);
  const scale = scaleOf(days.map(d => d.net));
  const weekScale = scaleOf(month.weeks.map(w => w.net));
  const todayKey = dayKey(new Date());
  // best day of the month: the highest positive net among the month's days in range
  const best = days.filter(d => inRange(d.date) && d.net > 0).reduce((a, b) => (!a || b.net > a.net ? b : a), null);
  const grid = $('#calendar');
  const monthKey = `${cal.y}-${cal.m}`;
  grid.classList.toggle('cal-in', grid._month !== monthKey && !calm());
  grid._month = monthKey;
  let cellNo = 0;
  grid.replaceChildren(...WEEKDAYS.map(d => el('div', 'cal-dow', d)), el('div', 'cal-dow week', 'Week'));
  const tint = (v, sc) => `${Math.round(10 + 22 * Math.min(1, Math.abs(v) / (sc || 1)))}%`;
  for (const w of month.weeks) {
    for (const d of w.days) {
      const has = d.n > 0, past = d.key <= todayKey;
      const cell = el(past ? 'button' : 'div', `cal-day ${d.inMonth && inRange(d.date) ? '' : 'out'} ${has ? sign(d.net) : ''} ${d.key === todayKey ? 'today' : ''}`);
      cell.style.setProperty('--d', cellNo++);
      if (past) { cell.type = 'button'; cell.onclick = () => openJournal(d.key); }
      if (has) cell.style.setProperty('--tint', tint(d.net, scale));
      const isBest = best && d.key === best.key;
      cell.setAttribute('aria-label', `${longDate(d.date)}${has ? `: ${money(d.net)}, ${d.n} trade${d.n === 1 ? "" : "s"}` : ', no trades'}${best && d.key === best.key ? ', best day of the month' : ''}${journalHas(d.key) ? ', has a journal entry' : ''}. Open journal`);
      const top = el('span', 'cal-top'), dl = el('span', 'cal-dl');
      dl.append(el('span', 'cal-date', String(d.date.getDate())));
      if (isBest) { const star = el('span', 'best-star', '★'); star.title = 'Best day of the month'; star.setAttribute('aria-hidden', 'true'); dl.append(star); }
      if (journalHas(d.key)) { const pen = el('span', 'jr-mark', '✎'); pen.title = 'Has a journal entry'; pen.setAttribute('aria-hidden', 'true'); dl.append(pen); }
      top.append(dl);
      cell.append(top);
      if (has) {
        top.append(el('span', 'cal-n', `${d.n} trade${d.n === 1 ? '' : 's'}`));
        cell.append(el('span', 'cal-pnl', calMoney(d.net)), el('span', 'cal-pnl short', signedCompact(d.net)));
        tipOn(cell, longDate(d.date), [pnlRow(d.net), { value: String(d.n), label: d.n === 1 ? 'trade' : 'trades' }, { value: pct(d.wins / d.n), label: 'won' }, ...(isBest ? [{ value: '★', label: 'best day of the month' }] : []), { value: '', label: journalHas(d.key) ? 'Click to read the journal entry' : 'Click to write a journal entry' }]);
      }
      grid.append(cell);
    }
    const wk = el('div', `cal-day week ${w.n ? sign(w.net) : ''}`);
    wk.style.setProperty('--d', cellNo++);
    if (w.n) wk.style.setProperty('--tint', tint(w.net, weekScale));
    // the column header already says Week, so each cell carries just its count and total
    const wtop = el('span', 'cal-top');
    wtop.append(el('span', 'cal-n', w.n ? `${w.n} trade${w.n === 1 ? '' : 's'}` : 'No trades'));
    wk.append(wtop);
    if (w.n) wk.append(el('span', 'cal-pnl', calMoney(w.net)));
    grid.append(wk);
  }
}

// ---- heatmap: 52 weeks ending with the range, Mon–Sun rows ----
function renderHeatmap() {
  const WEEKS = 52;
  const daily = dailyMap(filtered());
  const today = new Date(startOfDay(rangeEnd()));
  const isNow = dayKey(today) === dayKey(new Date());
  $('#heatTitle').textContent = isNow ? 'Last 12 months' : `12 months to ${date(today.getTime())}`;
  const start = new Date(today); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const cells = [], months = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    cells.push({ d, future: d > today, ...(daily.get(dayKey(d)) || { net: 0, n: 0 }) });
    if (i % 7 === 0 && (i === 0 || d.getDate() <= 7)) months.push({ col: i / 7, label: d.toLocaleDateString(undefined, { month: 'short' }) });
  }
  // a label needs ~3 columns; drop the first if the next month starts sooner
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
  const scale = scaleOf(cells.filter(c => c.n).map(c => c.net));
  const box = $('#heatmap');
  const monthRow = el('div', 'heat-months'); monthRow.style.gridTemplateColumns = `repeat(${WEEKS}, minmax(0, 1fr))`;
  for (const m of months) { const s = el('span', '', m.label); s.style.gridColumn = `${m.col + 1} / span 3`; monthRow.append(s); }
  const dows = el('div', 'heat-dows');
  WEEKDAYS.forEach((d, i) => dows.append(el('span', '', i % 2 === 0 ? d : '')));
  const grid = el('div', 'heat-grid'); grid.style.gridTemplateColumns = `repeat(${WEEKS}, minmax(0, 1fr))`;
  for (const c of cells) {
    const i = el('i', c.future ? '' : c.n ? heatClass(c.net, scale) : 'heat-none');
    if (!c.future) {
      i.tabIndex = -1;
      tipOn(i, longDate(c.d), c.n ? [pnlRow(c.net), { value: String(c.n), label: c.n === 1 ? 'trade' : 'trades' }] : [{ value: 'No trades' }]);
      i.onclick = () => openJournal(dayKey(c.d));
      i.style.cursor = 'pointer';
    }
    grid.append(i);
  }
  box.replaceChildren(el('span'), monthRow, dows, grid);
}

// ---- this week ----
function renderThisWeek(rangeTrades) {
  // the week the range ends in: this week for open-ended ranges
  const today = new Date(startOfDay(rangeEnd()));
  const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const thisMon = new Date(startOfDay(Date.now())); thisMon.setDate(thisMon.getDate() - ((thisMon.getDay() + 6) % 7));
  $('#weekTitle').textContent = mon.getTime() === thisMon.getTime() ? 'This week' : `Week of ${date(mon.getTime())}`;
  const daily = dailyMap(rangeTrades);
  const days = WEEKDAYS.map((label, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { label, d, ...(daily.get(dayKey(d)) || { net: 0, n: 0 }) }; });
  const net = days.reduce((n, d) => n + d.net, 0), n = days.reduce((k, d) => k + d.n, 0);
  countTo($('#weekValue'), net, v => money(v));
  // average over the weeks you traded in the selected range
  const wk = groupStats(rangeTrades, t => { const d = new Date(t.time); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); });
  const avg = wk.length ? wk.reduce((a, w) => a + w.net, 0) / wk.length : null;
  $('#weekSub').textContent = `${n} trade${n === 1 ? '' : 's'}` + (avg !== null ? ` · your average week is ${money(avg)}` : '');
  columnChart($('#weekChart'), {
    height: 150, lollipop: true, fmtTick: compact, label: 'This week by day',
    bars: days.map(d => ({ label: d.label[0], value: d.net, tipTitle: longDate(d.d), tipRows: [pnlRow(d.net), { value: String(d.n), label: 'trades' }] })),
  });
}

// ---- best hour ----
function renderBestHour(trades) {
  const hours = byHour(trades);
  const traded = hours.filter(h => h.n);
  const strip = $('#hourStrip');
  if (!traded.length) { $('#hourValue').textContent = '—'; $('#hourSub').textContent = ''; strip.replaceChildren(); return; }
  const best = traded.reduce((a, b) => (b.net > a.net ? b : a));
  const h = Number(best.label);
  const fmtH = x => new Date(2000, 0, 1, x).toLocaleTimeString(undefined, { hour: 'numeric' });
  $('#hourValue').textContent = `${fmtH(h)} – ${fmtH((h + 1) % 24)}`;
  $('#hourSub').textContent = `${money(best.net)} over ${best.n} trade${best.n === 1 ? '' : 's'}, ${pct(best.winRate)} won`;
  const scale = scaleOf(traded.map(x => x.net));
  strip.replaceChildren(...hours.map((x, i) => {
    const c = el('i', (x.n ? heatClass(x.net, scale) : 'heat-none') + (i === h ? ' best' : ''));
    tipOn(c, `${fmtH(i)} – ${fmtH((i + 1) % 24)}`, x.n ? [pnlRow(x.net), { value: String(x.n), label: 'trades' }, { value: pct(x.winRate), label: 'win rate' }] : [{ value: 'No trades' }]);
    return c;
  }));
}

// ---- performance & risk lists ----
function kv(node, rows) {
  node.replaceChildren(...rows.flatMap(([k, v, sub]) => {
    const dd = el('dd', '', v);
    if (sub) dd.append(el('small', '', sub));
    return [el('dt', '', k), dd];
  }));
}
function renderPerf(trades, s, daily, from, to) {
  const days = [...daily.values()];
  const bestDay = days.reduce((a, b) => (!a || b.net > a.net ? b : a), null);
  const worstDay = days.reduce((a, b) => (!a || b.net < a.net ? b : a), null);
  const spanDays = s.n ? Math.max(1, ((Math.min(to ?? Date.now(), Date.now())) - (from ?? s.first)) / DAY) : 0;
  const ds = dayStreaks(daily);
  kv($('#perfList'), [
    ['Net P&L', money(s.net)],
    ['Per trading day', days.length ? money(s.net / days.length) : '—', `${days.length} days traded`],
    ['Per week', spanDays ? money((s.net / spanDays) * 7) : '—'],
    ['Per month', spanDays ? money((s.net / spanDays) * 30.44) : '—'],
    ['Green days', days.length ? `${ds.green} / ${days.length}` : '—', days.length ? pct(ds.green / days.length) : ''],
    ['Best day', bestDay ? money(bestDay.net) : '—', bestDay ? date(fromInput(bestDay.key)) : ''],
    ['Worst day', worstDay ? money(worstDay.net) : '—', worstDay ? date(fromInput(worstDay.key)) : ''],
    ['Volume', compact(s.volume)],
  ]);
}
function renderRisk(s) {
  kv($('#riskList'), [
    ['Max drawdown', money(s.maxDrawdown), s.ddFrom ? `${date(s.ddFrom)} → ${date(s.ddTo)}` : ''],
    ['Below peak now', money(s.currentDrawdown)],
    ['Worst trade', s.worst ? money(s.worst.pnl) : '—', s.worst ? `${s.worst.symbol} ${s.worst.dir.toLowerCase()} · ${date(s.worst.time)}` : ''],
    ['Longest losing run', `${s.maxLossStreak} trades`, s.maxLossStreak ? money(s.maxLossStreakPnl) : ''],
    ['Liquidations', String(s.liquidations), s.liquidations ? money(s.liquidationPnl) : ''],
    ['Trading fees', money(-s.fees)],
    ['Funding', s.funding === null ? '—' : money(-s.funding), s.funding === null ? '' : s.funding > 0 ? 'paid, net' : 'received, net'],
    ['Avg leverage', s.avgLeverage ? `${s.avgLeverage.toFixed(1)}×` : '—', s.avgReturnOnMargin !== null ? `${signedPct(s.avgReturnOnMargin)} avg on margin` : ''],
  ]);
}

// ===== analytics =====
function renderAnalytics(trades, s, from, to) {
  const tradeAt = new Map(trades.map(t => [t.time, t]));
  lineChart($('#equityChart'), {
    points: s.n ? [{ x: s.equity[0].x - 1, y: 0 }, ...s.equity] : [], color: 'pos', fmtTick: compact, label: 'Cumulative net P&L',
    tipTitle: p => dateTime(p.x),
    tipRows: p => { const t = tradeAt.get(p.x); return [{ value: money(p.y), label: 'cumulative', key: 'line' }, ...(t ? [{ value: money(t.pnl), label: `${t.symbol} ${t.dir.toLowerCase()}`, key: sign(t.pnl) || 'line' }] : [])]; },
  });
  lineChart($('#ddChart'), {
    points: s.n ? [{ x: s.drawdown[0].x - 1, y: 0 }, ...s.drawdown] : [], color: 'neg', height: 150, fmtTick: compact, label: 'Drawdown from peak',
    tipTitle: p => dateTime(p.x), tipRows: p => [{ value: money(p.y, { sign: false }), label: 'below peak', key: 'neg' }],
  });

  const { unit, buckets } = periodPnl(trades, from ?? undefined, Math.min(to ?? Date.now(), Date.now()));
  $('#periodTitle').textContent = { day: 'Daily P&L', week: 'Weekly P&L', month: 'Monthly P&L' }[unit];
  const lab = b => new Date(b.start).toLocaleDateString(undefined, unit === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
  columnChart($('#periodChart'), {
    fmtTick: compact, label: $('#periodTitle').textContent,
    bars: buckets.map(b => ({ label: lab(b), value: b.net, tipTitle: unit === 'day' ? date(b.start) : `${date(b.start)} – ${date(b.end)}`, tipRows: [pnlRow(b.net), { value: String(b.n), label: b.n === 1 ? 'trade' : 'trades' }] })),
  });

  const g = groupStats(trades, t => t.symbol).sort((a, b) => b.net - a.net);
  const top = new Set([...g].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12).map(x => x.key));
  const rows = g.filter(x => top.has(x.key)), rest = g.filter(x => !top.has(x.key));
  if (rest.length) rows.push({ key: `Other (${rest.length})`, n: rest.reduce((n, x) => n + x.n, 0), net: rest.reduce((n, x) => n + x.net, 0), winRate: null });
  hbarChart($('#symbolChart'), {
    label: 'Net P&L by market',
    rows: rows.map(r => ({ label: r.key, value: r.net, valueText: signedCompact(r.net), tipTitle: r.key, tipRows: [pnlRow(r.net), { value: String(r.n), label: 'trades' }, ...(r.winRate !== null ? [{ value: pct(r.winRate), label: 'win rate' }] : [])] })),
  });
  sortableTable($('#symbolTable'), g, [
    { key: 'key', label: 'Market', fmt: v => v, align: 'left' },
    { key: 'n', label: 'Trades', fmt: v => v.toLocaleString() },
    { key: 'winRate', label: 'Win rate', fmt: v => pct(v) },
    { key: 'net', label: 'Net P&L', fmt: v => money(v) },
    { key: 'expectancy', label: 'Per trade', fmt: v => money(v) },
    { key: 'profitFactor', label: 'Profit factor', fmt: ratio },
    { key: 'fees', label: 'Fees', fmt: v => money(-v) },
    { key: 'volume', label: 'Volume', fmt: compact },
  ], { sort: 'net', dir: -1 });

  const sides = groupStats(trades, t => t.dir);
  const L = sides.find(x => x.key === 'Long'), S = sides.find(x => x.key === 'Short');
  const t = $('#sideTable'); t.replaceChildren();
  const head = el('tr'); head.append(el('th', '', ''), el('th', 'num', 'Long'), el('th', 'num', 'Short'));
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const [label, f] of [['Trades', x => x.n.toLocaleString()], ['Win rate', x => pct(x.winRate)], ['Net P&L', x => money(x.net)], ['Per trade', x => money(x.expectancy)], ['Profit factor', x => ratio(x.profitFactor)], ['Fees', x => money(-x.fees)]]) {
    const tr = el('tr'); tr.append(el('th', '', label), el('td', 'num', L ? f(L) : '—'), el('td', 'num', S ? f(S) : '—')); body.append(tr);
  }
  t.append(thead, body);

  const bars = arr => arr.map(d => ({ label: d.label, value: d.net, tipTitle: d.label, tipRows: [pnlRow(d.net), { value: String(d.n), label: 'trades' }, ...(d.n ? [{ value: pct(d.winRate), label: 'win rate' }] : [])] }));
  columnChart($('#weekdayChart'), { bars: bars(byWeekday(trades)), fmtTick: compact, height: 200, label: 'Net P&L by weekday' });
  columnChart($('#hourChart'), { bars: bars(byHour(trades)).map(b => ({ ...b, tipTitle: `${b.label}:00 – ${b.label}:59` })), fmtTick: compact, height: 200, labelEvery: 3, label: 'Net P&L by hour' });

  const bins = histogram(trades);
  columnChart($('#histChart'), {
    fmtTick: v => String(Math.round(v)), height: 200, label: 'Distribution of trade P&L', colorBy: b => (b.mid >= 0 ? 'pos' : 'neg'),
    bars: bins.map(b => ({ label: compact(b.from), value: b.n, mid: (b.from + b.to) / 2, tipTitle: `${money(b.from)} to ${money(b.to)}`, tipRows: [{ value: String(b.n), label: b.n === 1 ? 'trade' : 'trades' }] })),
  });
}

// ===== tables =====
function sortableTable(table, rows, cols, init) {
  table._sort = table._sort || { ...init };
  const draw = () => {
    const { sort, dir } = table._sort;
    const sorted = [...rows].sort((a, b) => { const x = a[sort], y = b[sort]; return (typeof x === 'string' ? x.localeCompare(y) : (x ?? -Infinity) - (y ?? -Infinity)) * dir; });
    table.replaceChildren();
    const head = el('tr');
    for (const c of cols) {
      const th = el('th', c.align === 'left' ? '' : 'num');
      const b = el('button', 'sort', c.label);
      if (c.key === sort) { b.append(el('span', 'arrow', dir > 0 ? ' ↑' : ' ↓')); th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending'); }
      b.onclick = () => { table._sort = { sort: c.key, dir: c.key === sort ? -dir : (c.align === 'left' ? 1 : -1) }; draw(); };
      th.append(b); head.append(th);
    }
    const thead = el('thead'); thead.append(head);
    const body = el('tbody');
    for (const r of sorted) { const tr = el('tr'); for (const c of cols) tr.append(el('td', c.align === 'left' ? '' : 'num', c.fmt(r[c.key], r))); body.append(tr); }
    table.append(thead, body);
  };
  draw();
}

const pnlCell = v => { const td = el('td', 'num'); const p = el('i', 'pill ' + sign(v)); td.append(p, document.createTextNode(money(v))); return td; };
const TRADE_COLS = [
  { key: 'time', label: 'Closed', fmt: v => dateTime(v), align: 'left' },
  { key: 'symbol', label: 'Market', fmt: (v, t) => v + (t.liquidation ? ' · liquidated' : t.adl ? ' · ADL' : ''), align: 'left' },
  { key: 'dir', label: 'Side', fmt: v => v, align: 'left' },
  { key: 'strategyName', label: 'Strategy', cell: (v, t) => strategyCell(t), align: 'left' },
  { key: 'size', label: 'Size', fmt: v => v.toLocaleString(undefined, { maximumFractionDigits: 6 }) },
  { key: 'entry', label: 'Entry', fmt: price },
  { key: 'exit', label: 'Exit', fmt: price },
  { key: 'leverage', label: 'Lev.', fmt: v => v + '×' },
  { key: 'pnl', label: 'Net P&L', cell: pnlCell },
  { key: 'rom', label: 'On margin', fmt: v => signedPct(v) },
  { key: 'fees', label: 'Fees', fmt: v => money(-v) },
  { key: 'funding', label: 'Funding', fmt: v => (v === null ? '—' : money(-v)) },
];
const DAY_COLS = [{ ...TRADE_COLS[0], label: 'Time', fmt: v => time(v) }, ...TRADE_COLS.slice(1)];

function tradeTable(table, rows, cols, state) {
  table.replaceChildren();
  const head = el('tr');
  for (const c of cols) {
    const th = el('th', c.align === 'left' ? '' : 'num');
    if (state) {
      const b = el('button', 'sort', c.label);
      if (c.key === state.sort) { b.append(el('span', 'arrow', state.dir > 0 ? ' ↑' : ' ↓')); th.setAttribute('aria-sort', state.dir > 0 ? 'ascending' : 'descending'); }
      b.onclick = () => { state.dir = c.key === state.sort ? -state.dir : -1; state.sort = c.key; render(); };
      th.append(b);
    } else th.textContent = c.label;
    head.append(th);
  }
  const thead = el('thead'); thead.append(head);
  const body = el('tbody');
  for (const t of rows) {
    const r = { ...t, rom: t.margin > 0 ? t.pnl / t.margin : null, strategyName: strategyName(strategyOf(t)) };
    const tr = el('tr'); if (t.liquidation) tr.className = 'liq';
    for (const c of cols) tr.append(c.cell ? c.cell(r[c.key], r) : el('td', c.align === 'left' ? '' : 'num', c.fmt(r[c.key], r)));
    body.append(tr);
  }
  table.append(thead, body);
}

function renderTrades(trades) {
  const { sort, dir } = tableState;
  const rows = trades.map(t => ({ ...t, rom: t.margin > 0 ? t.pnl / t.margin : null, strategyName: strategyName(strategyOf(t)) }))
    .sort((a, b) => { const x = a[sort], y = b[sort]; return (typeof x === 'string' ? x.localeCompare(y) : (x ?? -Infinity) - (y ?? -Infinity)) * dir; });
  tradeTable($('#tradeTable'), rows.slice(0, tableState.shown), TRADE_COLS, tableState);
  const more = $('#moreBtn');
  more.hidden = rows.length <= tableState.shown;
  more.textContent = `Show ${Math.min(100, rows.length - tableState.shown)} more of ${rows.length - tableState.shown}`;
  more.onclick = () => { tableState.shown += 100; renderTrades(trades); };
  $('#tradeCount').textContent = rows.length ? `${rows.length.toLocaleString()} in range` : '';
}

function exportCsv() {
  const cols = ['time', 'symbol', 'category', 'dir', 'size', 'entry', 'exit', 'leverage', 'pnl', 'gross', 'fees', 'funding', 'notional', 'margin', 'orderType', 'execType', 'strategy'];
  const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['closed_at', ...cols.slice(1)].join(',')];
  for (const t of filtered()) lines.push(cols.map(c => esc(c === 'time' ? new Date(t.time).toISOString() : c === 'strategy' ? strategyName(strategyOf(t)) : t[c])).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `perp-dojo-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#csvBtn').onclick = exportCsv;
$('#exportCsv').onclick = () => { if (!all.length) return alertBox('Pull some data first, then export.'); exportCsv(); };

// ===== PDF review =====
// A written report (public/report.js) built from the trades in the current
// filters, then printed with the browser's Save as PDF. Nothing is animated.
let printing = false, titleBefore = '';
function preparePrint() {
  if (printing) return;
  printing = true;
  titleBefore = document.title;
  setCalm(true);
  document.body.classList.add('printing');
  const doc = $('#reportDoc');
  doc.hidden = false;
  const [from, to] = rangeBounds();
  const scope = [rangeLabel(), filters.symbol !== 'all' ? filters.symbol : 'All markets',
    filters.strategy !== 'all' ? (filters.strategy === 'none' ? 'Unlabeled trades' : strategyName(filters.strategy)) : null,
    filters.side !== 'all' ? filters.side + 's only' : null].filter(Boolean).join(' · ');
  const daily = dailyMap(all);
  const journalEntries = Object.entries(journalAll()).filter(([, e]) => e.text?.trim())
    .map(([k, e]) => ({ time: fromInput(k), text: e.text, rating: e.rating, net: daily.get(k)?.net ?? null }))
    .sort((x, y) => x.time - y.time);
  const weekly = Object.entries(weeklyAll()).filter(([, w]) => w.text?.trim())
    .map(([k, w]) => ({ time: fromInput(k), text: w.text })).sort((x, y) => x.time - y.time);
  writeReport(doc, filtered(), {
    fmt: { money, compact, date, dateTime },
    equity: account?.available ? account.equity : null,
    strategyOf: t => strategyName(strategyOf(t)),
    checkinDone: checkinDoneOn, journaled: journalHas,
    from, to: to === null ? null : Math.min(to, Date.now()), scope, uid: status?.key?.uid,
    journalEntries, weekly,
  });
  document.title = `Perp Dojo review ${date(Date.now())}`;
}
function finishPrint() {
  if (!printing) return;
  printing = false;
  document.body.classList.remove('printing');
  $('#reportDoc').hidden = true;
  $('#reportDoc').replaceChildren();
  setCalm(false);
  document.title = titleBefore;
}
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', finishPrint);
$('#exportPdf').onclick = () => {
  if (!all.length) return alertBox('Pull some data first, then export.');
  preparePrint();
  // let the re-drawn charts settle before the print dialog takes a snapshot
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => window.print(), 120)));
};



// ===== strategy labels on trades =====
// Map of trade id → strategy id, per Bybit account, in this browser; included
// in "Save to server" snapshots. A label to a deleted strategy reads as none.
const labelsKey = () => 'labels:' + (status?.key?.uid ?? 'local');
let labelsCache = null;
function labelsAll() {
  if (!labelsCache || labelsCache.key !== labelsKey()) labelsCache = { key: labelsKey(), data: store.get(labelsKey(), {}) };
  return labelsCache.data;
}
function strategyOf(t) {
  const sid = labelsAll()[t.id];
  return sid && playbookAll().some(x => x.id === sid) ? sid : null;
}
function strategyName(sid) {
  if (!sid) return '';
  const x = playbookAll().find(y => y.id === sid);
  return x ? (x.name.trim() || 'Untitled strategy') : '';
}
function setLabel(tradeId, sid) {
  const data = labelsAll();
  if (sid) data[tradeId] = sid; else delete data[tradeId];
  store.set(labelsKey(), data);
  markLocalChange();
}
function strategyCell(t) {
  const td = el('td', 'strategy-cell');
  const list = playbookAll();
  const sel = el('select', 'strategy-select' + (strategyOf(t) ? ' set' : ''));
  sel.setAttribute('aria-label', `Strategy for ${t.symbol} ${t.dir.toLowerCase()} closed ${dateTime(t.time)}`);
  sel.append(new Option(list.length ? '—' : 'Add strategies in Playbook', ''), ...list.map(x => new Option(x.name.trim() || 'Untitled strategy', x.id)));
  sel.value = strategyOf(t) || '';
  sel.disabled = !list.length;
  sel.onchange = () => {
    setLabel(t.id, sel.value || null);
    sel.classList.toggle('set', !!sel.value);
    // a label can move the trade in or out of the current filter
    if (filters.strategy !== 'all') render();
  };
  td.append(sel);
  return td;
}
function paintStrategyFilter() {
  const sel = $('#strategyFilter'), list = playbookAll();
  sel.replaceChildren(new Option('All strategies', 'all'), ...list.map(x => new Option(x.name.trim() || 'Untitled strategy', x.id)), new Option('Unlabeled', 'none'));
  if (filters.strategy !== 'all' && filters.strategy !== 'none' && !list.some(x => x.id === filters.strategy)) filters.strategy = 'all';
  sel.value = filters.strategy;
}


// ===== entry wizard =====
// Risk per trade as a % of account equity. The 4H zone is required; each other
// confirmation adds to the base. Change the numbers here.
const RISK = { base: 0.5, smt: 0.75, btc: 0.75, rej: 0.5 };
const fmtPctPts = v => `${(+v.toFixed(2)).toString()}%`;

function wizardEquity() {
  const manual = parseFloat($('#wzManual').value);
  if (account?.available && Number.isFinite(account.equity)) return { value: account.equity, source: 'account' };
  if (Number.isFinite(manual) && manual > 0) return { value: manual, source: 'manual' };
  return { value: null, source: 'none' };
}

function renderWizard() {
  for (const n of document.querySelectorAll('.wz-bonus, .wz-tag.plus')) n.textContent = (n.classList.contains('plus') ? '+' : '') + fmtPctPts(RISK[n.dataset.k]);
  $('#wzRule').textContent = `Base risk is ${fmtPctPts(RISK.base)} of account equity.`;
  const zone = $('#wzZone').checked, close = $('#wzClose').checked, smt = $('#wzSmt').checked, btc = $('#wzBtc').checked, rej = $('#wzRej').checked;
  // SMT is optional when BTC's 4H direction agrees, and required when it doesn't
  const smtRequired = !btc;
  const smtRow = $('#wzSmt').closest('.wz-check');
  smtRow.classList.toggle('required', smtRequired);
  $('#wzSmtTag').textContent = smtRequired ? 'Required' : '+' + fmtPctPts(RISK.smt);
  $('#wzSmtTag').classList.toggle('plus', !smtRequired);
  $('#wzSmtWhy').textContent = smtRequired ? 'Required while BTC 4H isn’t aligned. ' : '';
  // every required box must be ticked, or there's no trade
  const missing = [
    [zone, 'Chart at a 4H zone', 'The chart isn’t at a 4H zone.'],
    [close, 'Trading a 4H candle close', 'You’re not trading a 4H candle close.'],
    [!smtRequired || smt, 'SMT (BTC 4H not aligned)', 'BTC 4H isn’t aligned, so SMT is required.'],
    [!lossToday().hit, 'Daily loss limit', `You’ve hit your ${WARN.dailyLossPct}% daily loss limit. No more trades today.`],
  ].filter(([ok]) => !ok);
  const eq = wizardEquity();
  const box = $('#wzResult');

  // where the equity comes from
  $('#wzManualWrap').hidden = eq.source === 'account';
  $('#wzEquityLabel').textContent = eq.source === 'account'
    ? `Based on account equity ${balanceHidden ? '$' + MASK : money(eq.value, { sign: false, dp: 2 })} · as of ${time(account.at)}`
    : eq.source === 'manual' ? 'Based on the equity you typed' : 'No account equity available yet. Type it in below.';

  const rows = [];
  if (missing.length) {
    box.className = 'card c5 wz-result no';
    $('#wzVerdict').textContent = 'Do not trade';
    const a = $('#wzAmount'); cancelAnimationFrame(a._raf); a._v = null; a.textContent = '$0';
    $('#wzPct').textContent = missing.map(m => m[2]).join(' ');
    for (const [, label] of missing) rows.push([label, 'missing', 'no']);
  } else {
    const pct = RISK.base + (smt ? RISK.smt : 0) + (btc ? RISK.btc : 0) + (rej ? RISK.rej : 0);
    box.className = 'card c5 wz-result go' + (pct > RISK.base ? ' plus' : '');
    $('#wzVerdict').textContent = 'Take the trade';
    if (eq.value) countTo($('#wzAmount'), eq.value * pct / 100, v => money(v, { sign: false, dp: 2 }));
    else { $('#wzAmount')._v = null; $('#wzAmount').textContent = '—'; }
    $('#wzPct').textContent = `${fmtPctPts(pct)} of equity at risk`;
    rows.push(['Base risk: 4H zone and close', fmtPctPts(RISK.base), 'yes']);
    rows.push(['SMT present', smt ? '+' + fmtPctPts(RISK.smt) : '—', smt ? 'yes' : 'off']);
    rows.push(['BTC 4H aligned', btc ? '+' + fmtPctPts(RISK.btc) : '—', btc ? 'yes' : 'off']);
    rows.push(['BTC at rejection level', rej ? '+' + fmtPctPts(RISK.rej) : '—', rej ? 'yes' : 'off']);
  }
  $('#wzBreakdown').replaceChildren(...rows.map(([k, v, c]) => { const li = el('li', c); li.append(el('span', '', k), el('b', '', v)); return li; }));

  // your other rules, as reminders: they don't change the number
  const notes = [];
  if (new Date().getDay() === 6) notes.push('It’s Saturday, your no-trade day.');
  const ck = checkin();
  if (!ck.complete) notes.push(`Today’s check-in isn’t done: ${ck.affirmed.length} of ${ck.list.length} affirmed${ck.wrote ? '' : ', no journal yet'}.`);
  const today = all.filter(t => t.time >= startOfDay(Date.now())).length;
  if (today > WARN.maxTradesPerDay) notes.push(`You've already closed ${today} trades today, over your limit of ${WARN.maxTradesPerDay}.`);
  $('#wzNotes').replaceChildren(...notes.map(n => { const d = el('div', 'wz-note'); d.innerHTML = WARN_ICON; d.append(el('span', '', n)); return d; }));
}
for (const id of ['#wzZone', '#wzClose', '#wzSmt', '#wzBtc', '#wzRej']) $(id).addEventListener('change', renderWizard);
$('#wzManual').addEventListener('input', renderWizard);
$('#wzReset').onclick = () => { for (const id of ['#wzZone', '#wzClose', '#wzSmt', '#wzBtc', '#wzRej']) $(id).checked = false; renderWizard(); };
$('#wzRefresh').onclick = async () => { $('#wzRefresh').disabled = true; await loadAccount(); $('#wzRefresh').disabled = false; renderWizard(); };


// ===== Today: daily check-in and a quick journal box =====
// Affirmations live on that day's journal entry (entry.pledges = the texts you
// affirmed), so every day starts fresh and the Journal keeps the history.
const DEFAULT_PLEDGES = ['I am clear minded.', 'I am rested.', 'I will follow my strategy.', 'I will only take two trades maximum today.'];
const pledgesKey = () => 'pledges:' + (status?.key?.uid ?? 'local');
const pledgeList = () => store.get(pledgesKey(), DEFAULT_PLEDGES);
// Complete means every commitment affirmed AND something written in today's
// journal; the writing counts as one more step.
function checkin() {
  const list = pledgeList(), e = journalEntry(dayKey(new Date()));
  const affirmed = (e?.pledges || []).filter(t => list.includes(t));
  const wrote = !!e?.text?.trim();
  const pledgesDone = affirmed.length === list.length;
  return { list, affirmed, wrote, pledgesDone, done: affirmed.length + (wrote ? 1 : 0), total: list.length + 1, complete: pledgesDone && wrote };
}
let todayShown = null, tdTimer = 0, tdPending = null;

function renderToday() {
  const key = dayKey(new Date());
  todayShown = key;
  $('#tdDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const ck = checkin();
  const card = $('.today-card');
  card.classList.toggle('done', ck.complete);
  card.classList.toggle('pending', !ck.complete);
  $('.today-note').classList.toggle('todo', !ck.wrote);
  // once you're checked in, the card can fold to a single line (remembered for today only)
  const collapsed = ck.complete && store.get('todayCollapsed', null) === key;
  card.classList.toggle('collapsed', collapsed);
  $('#tdCollapse').hidden = !ck.complete;
  $('#tdCollapse').setAttribute('aria-expanded', String(!collapsed));
  $('#tdCollapse').title = collapsed ? 'Expand' : 'Collapse';
  $('#tdEdit').hidden = collapsed;
  const note = (journalEntry(key)?.text || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  $('#tdPeek').textContent = collapsed && note ? note : '';
  $('#tdStatus').textContent = ck.complete ? '✓ Checked in · ready to trade'
    : ck.pledgesDone ? `Write today's journal to finish · ${ck.done}/${ck.total}` : `Check in before trading · ${ck.done}/${ck.total}`;
  $('#tdPledges').replaceChildren(...ck.list.map(t => {
    const on = ck.affirmed.includes(t);
    const b = el('button', 'pledge' + (on ? ' on' : '')); b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.append(el('span', 'pledge-mark', on ? '✓' : ''), el('span', '', t));
    b.onclick = () => {
      const cur = journalEntry(key)?.pledges || [];
      journalPut(key, { pledges: on ? cur.filter(x => x !== t) : [...cur, t] });
      renderToday();
      if (view === 'dashboard') renderWarnings(summarize(filtered()), dayStreaks(dailyMap(filtered())));
    };
    return b;
  }));
  const ta = $('#tdText'), e = journalEntry(key);
  if (ta._day !== key || (document.activeElement !== ta && ta.value !== (e?.text || ''))) { ta.value = e?.text || ''; ta._day = key; }
  $('#tdSaved').textContent = e?.text ? `Saved to today's journal · ${ago(e.updatedAt)}` : 'Saves to today’s journal.';
}
function flushToday() {
  if (!tdPending) return;
  clearTimeout(tdTimer);
  const { day, text } = tdPending; tdPending = null;
  journalPut(day, { text });
}
$('#tdText').addEventListener('input', e => {
  tdPending = { day: e.target._day || dayKey(new Date()), text: e.target.value };
  $('#tdSaved').textContent = 'Saving…';
  clearTimeout(tdTimer);
  tdTimer = setTimeout(() => {
    flushToday();
    renderToday();      // the check-in may have just completed
    if (view === 'dashboard') renderWarnings(summarize(filtered()), dayStreaks(dailyMap(filtered())));
    $('#tdSaved').textContent = 'Saved to today’s journal · just now';
  }, 400);
});
window.addEventListener('beforeunload', flushToday);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('pointerdown', flushToday));

$('#tdCollapse').onclick = e => {
  e.stopPropagation();
  const key = dayKey(new Date()), folded = store.get('todayCollapsed', null) === key;
  flushToday();
  store.set('todayCollapsed', folded ? null : key);
  renderToday();
};
// clicking anywhere on the folded line opens it again
$('.today-head').addEventListener('click', e => { if ($('.today-card').classList.contains('collapsed') && !e.target.closest('button')) $('#tdCollapse').click(); });
$('#tdOpen').onclick = () => { flushToday(); openJournal(dayKey(new Date())); };

// edit the list
$('#tdEdit').onclick = () => { $('#pledgeInput').value = pledgeList().join('\n'); $('#pledgeDlg').showModal(); };
$('#pledgeCancel').onclick = () => $('#pledgeDlg').close();
$('#pledgeReset').onclick = () => { $('#pledgeInput').value = DEFAULT_PLEDGES.join('\n'); };
$('#pledgeForm').onsubmit = e => {
  e.preventDefault();
  const list = [...new Set($('#pledgeInput').value.split('\n').map(x => x.trim()).filter(Boolean))].slice(0, 12);
  store.set(pledgesKey(), list.length ? list : DEFAULT_PLEDGES);
  markLocalChange();
  $('#pledgeDlg').close();
  render();
};

// a new day: start the check-in fresh even if the page stayed open overnight
setInterval(() => { if (todayShown && todayShown !== dayKey(new Date()) && view === 'dashboard') render(); }, 60_000);


// ===== status bar: Bybit connection + the main stats =====
// "Live" means the server just reached Bybit with the key (the account check);
// it's re-checked every minute and whenever the browser goes on- or offline.
function paintConnection() {
  const el_ = $('#sbConn'), label = el_.querySelector('span');
  const live = navigator.onLine && !!status?.key?.ok && !!account?.available;
  el_.className = 'sb-conn ' + (live ? 'live' : 'down');
  label.textContent = live ? 'Live' : 'Disconnected';
  el_.dataset.tip = live ? `Connected to Bybit · checked ${time(account.at)}`
    : !navigator.onLine ? 'This browser is offline' : !status?.key?.ok ? (status?.key?.message || 'The Bybit key isn’t working') : 'Couldn’t reach Bybit on the last check';
  if (view === 'wizard') renderWizard();
  // the loss limit depends on equity, which arrives after the first render
  if (view === 'dashboard' && !$('#report').hidden) renderWarnings(summarize(filtered()), dayStreaks(dailyMap(filtered())));
  paintStatusStats();
  paintLossLimit();
}
let lastStats = null;
function paintStatusStats(s = lastStats) {
  if (!s) return;
  lastStats = s;
  const item = (k, v, cls = '') => { const x = el('span', cls, k); x.append(el('b', '', v)); return x; };
  const eq = account?.available ? (balanceHidden ? '$' + MASK : money(account.equity, { sign: false, dp: 0 })) : '—';
  const dl = lossToday();
  const todayItem = item('Today', money(dl.net) + (dl.limit ? ` · ${Math.round((dl.used || 0) * 100)}% of limit` : ''), dl.n ? (dl.net >= 0 ? 'pos' : 'neg') : '');
  if (dl.hit) todayItem.classList.add('sb-hit');
  $('#sbStats').replaceChildren(
    todayItem,
    item('Net P&L', money(s.net), s.n ? (s.net >= 0 ? 'pos' : 'neg') : ''),
    item('Win rate', pct(s.winRate, 1)),
    item('Profit factor', ratio(s.profitFactor)),
    item('Trades', s.n.toLocaleString()),
    item('Equity', eq),
  );
}
async function checkConnection() {
  if (!status?.key?.ok) { paintConnection(); return; }
  await loadAccount();
}
setInterval(checkConnection, 60_000);
window.addEventListener('online', checkConnection);
window.addEventListener('offline', paintConnection);


// ===== footer tooltips: instant, in the app's own style (native titles are slow) =====
for (const [id, name] of [
  ['#sbConn', 'Bybit connection'], ['#coverage', 'Loaded data'],
  ['#pullBtn', 'Pull data'], ['#syncBtn', 'Refresh'], ['#saveBtn', 'Save to server'], ['#loadBtn', 'Load from server'],
]) {
  const n = $(id);
  n.removeAttribute('title');
  if (n.tagName === 'SPAN') n.tabIndex = 0;
  tipOn(n, name, () => [{ value: '', label: n.dataset.tip || '' }]);
  n.addEventListener('click', hideTip);
}

// ===== pinned stats row: a shadow once it's stuck to the top =====
new IntersectionObserver(([e]) => $('.stats').classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 0))
  .observe($('#statsSentinel'));


// ===== 4H close countdown =====
// 4H candles close every four hours from 00:00 UTC; ms since the epoch line up with that.
const H4 = 4 * 3_600_000;
function tick4h() {
  const now = Date.now(), next = Math.floor(now / H4) * H4 + H4, left = next - now;
  const hh = Math.floor(left / 3_600_000), mm = Math.floor(left / 60_000) % 60, ss = Math.floor(left / 1000) % 60;
  $('#sb4hTime').textContent = `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const c = $('#sb4h');
  c.classList.toggle('soon', left <= 30 * 60_000 && left > 5 * 60_000);
  c.classList.toggle('now', left <= 5 * 60_000);
  const utc = new Date(next).toISOString().slice(11, 16);
  c.dataset.tip = `Next 4H candle closes at ${utc} UTC (${time(next)} your time). Turns amber 30 minutes before.`;
}
tick4h();
setInterval(tick4h, 1000);
{ const c = $('#sb4h'); c.tabIndex = 0; tipOn(c, '4H candle close', () => [{ value: '', label: c.dataset.tip }]); }

// ===== weekly review =====
// Reflections: { 'YYYY-MM-DD' (Monday): { text, updatedAt } }, per account, in this browser + snapshots.
const weeklyKey = () => 'weekly:' + (status?.key?.uid ?? 'local');
const weeklyAll = () => store.get(weeklyKey(), {});
let rvPending = null;
function flushReview() {
  if (!rvPending) return;
  clearTimeout(rv.timer);
  const { week, text } = rvPending; rvPending = null;
  const data = weeklyAll();
  if (text.trim()) data[week] = { text, updatedAt: Date.now() }; else delete data[week];
  store.set(weeklyKey(), data);
  markLocalChange();
}
function checkinDoneOn(k) {
  const e = journalEntry(k), list = pledgeList();
  return !!e && !!e.text?.trim() && list.every(t => (e.pledges || []).includes(t));
}

function renderReview() {
  if (!rv.week) rv.week = weekStart(Date.now());
  syncHash();
  const start = rv.week, equity = account?.available ? account.equity : null;
  const opts = { equity, checkinDone: checkinDoneOn, journaled: journalHas };
  const r = weekReview(all, start, opts);
  const prev = weekReview(all, start - 7 * DAY, opts);
  const s = r.s;
  const endDate = new Date(r.end);
  $('#rvTitle').textContent = `${new Date(start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  $('#rvNext').disabled = start >= weekStart(Date.now());
  // compared with last week and your average week
  const weeks = groupStats(all, t => weekStart(t.time));
  const avg = weeks.length ? weeks.reduce((n, w) => n + w.net, 0) / weeks.length : null;
  $('#rvCompare').textContent = s.n
    ? `${s.net - prev.s.net >= 0 ? '▲' : '▼'} ${money(s.net - prev.s.net)} vs last week${avg !== null ? ` · average week ${money(avg)}` : ''}`
    : 'No trades this week.';
  const stat = (k, v) => { const x = el('div'); x.append(el('dt', '', k), el('dd', '', v)); return x; };
  $('#rvStats').replaceChildren(
    stat('Net P&L', money(s.net)), stat('Trades', String(s.n)), stat('Win rate', pct(s.winRate)),
    stat('Profit factor', ratio(s.profitFactor)), stat('Best', s.best ? money(s.best.pnl) : '—'), stat('Worst', s.worst ? money(s.worst.pnl) : '—'),
  );
  columnChart($('#rvDays'), {
    height: 180, fmtTick: compact, label: 'P&L by day this week',
    bars: r.days.map(d => ({ label: WEEKDAYS[(d.date.getDay() + 6) % 7], value: d.net, tipTitle: longDate(d.date), tipRows: [pnlRow(d.net), { value: String(d.n), label: d.n === 1 ? 'trade' : 'trades' }] })),
  });

  // rules scorecard
  const R = r.rules, rows = [];
  const rule = (ok, title, detail) => rows.push({ ok, title, detail });
  rule(R.saturday.n === 0, 'No trades on Saturday', R.saturday.n ? `${R.saturday.n} trade${R.saturday.n === 1 ? '' : 's'} on Saturday, ${money(R.saturday.net)}` : 'Kept');
  rule(!R.overtrading.days.length, `At most ${WARN.maxTradesPerDay} trades a day`, R.overtrading.days.length
    ? `Over on ${R.overtrading.days.map(d => `${WEEKDAYS[(d.date.getDay() + 6) % 7]} (${d.n})`).join(', ')}. The ${R.overtrading.extraTrades} extra trade${R.overtrading.extraTrades === 1 ? '' : 's'} made ${money(R.overtrading.extraNet)}`
    : 'Kept');
  rule(R.dailyLoss.known ? !R.dailyLoss.days.length : null, `Daily loss under ${WARN.dailyLossPct}%`, !R.dailyLoss.known ? 'Needs your account equity' : R.dailyLoss.days.length
    ? `Broken on ${R.dailyLoss.days.map(d => `${WEEKDAYS[(d.date.getDay() + 6) % 7]} (${money(d.net)})`).join(', ')}` : 'Kept');
  rule(R.checkin.of ? R.checkin.done === R.checkin.of : null, 'Checked in on trading days', R.checkin.of ? `${R.checkin.done} of ${R.checkin.of} trading days` : 'No trading days');
  rule(R.journal.done >= Math.max(1, r.days.filter(d => d.n).length), 'Journaled', `${R.journal.done} of 7 days have an entry`);
  $('#rvRules').replaceChildren(...rows.map(x => {
    const li = el('li', x.ok === null ? 'na' : x.ok ? 'ok' : 'bad');
    li.append(el('span', 'rv-mark', x.ok === null ? '–' : x.ok ? '✓' : '✗'), el('span', 'rv-rule', x.title), el('span', 'rv-detail', x.detail));
    return li;
  }));

  // by strategy
  const g = groupStats(r.trades, t => strategyName(strategyOf(t)) || 'Unlabeled').sort((a, b) => b.net - a.net);
  const tbl = $('#rvStrats');
  if (!g.length) tbl.replaceChildren(el('caption', 'muted small', 'No trades this week.'));
  else {
    const head = el('tr'); for (const h of ['Strategy', 'Trades', 'Win rate', 'Net P&L']) head.append(el('th', h === 'Strategy' ? '' : 'num', h));
    const thead = el('thead'); thead.append(head);
    const body = el('tbody');
    for (const x of g) { const tr = el('tr'); tr.append(el('td', '', x.key), el('td', 'num', String(x.n)), el('td', 'num', pct(x.winRate)), pnlCell(x.net)); body.append(tr); }
    tbl.replaceChildren(thead, body);
  }

  // the week's journal
  const days = r.days.filter(d => journalHas(d.key));
  $('#rvJournal').replaceChildren(...(days.length ? days.map(d => {
    const e = journalEntry(d.key), li = el('li'), b = el('button', 'jr-recent-item'); b.type = 'button';
    const head = el('span', 'jr-recent-head');
    head.append(el('b', '', d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), el('span', 'jr-recent-pnl ' + (d.n ? sign(d.net) : ''), d.n ? money(d.net) : 'no trades'));
    const line = (e.text || '').split('\n').map(x => x.trim()).find(x => x && !/^[\w\u2019' ]{1,24}:$/.test(x));
    b.append(head, el('span', 'jr-recent-text', (e.rating ? '★'.repeat(e.rating) + ' ' : '') + (line || (e.tags || []).map(t => '#' + t).join(' ') || '—')));
    b.onclick = () => openJournal(d.key);
    li.append(b); return li;
  }) : [el('li', 'muted small', 'No journal entries this week.')]));

  // reflection
  const wk = dayKey(new Date(start)), ta = $('#rvText'), saved = weeklyAll()[wk];
  if (ta._week !== wk || (document.activeElement !== ta && ta.value !== (saved?.text || ''))) { ta.value = saved?.text || ''; ta._week = wk; autosize(ta); }
  $('#rvSaved').textContent = saved ? `Saved in this browser · ${ago(saved.updatedAt)}` : 'Saved in this browser as you type.';
}
$('#rvText').addEventListener('input', e => {
  autosize(e.target);
  rvPending = { week: e.target._week, text: e.target.value };
  $('#rvSaved').textContent = 'Saving…';
  clearTimeout(rv.timer);
  rv.timer = setTimeout(() => { flushReview(); $('#rvSaved').textContent = 'Saved in this browser · just now'; }, 400);
});
window.addEventListener('beforeunload', flushReview);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('pointerdown', flushReview));
$('#rvTemplate').onclick = () => {
  const ta = $('#rvText');
  const tpl = 'What went well:\n\nWhat didn\u2019t:\n\nRules I broke, and why:\n\nOne thing to do differently next week:\n';
  ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') + tpl : tpl;
  ta.dispatchEvent(new Event('input')); ta.focus();
};
$('#rvPrev').onclick = () => { flushReview(); rv.week -= 7 * DAY; rv.week = weekStart(rv.week + 12 * 3_600_000); renderReview(); };
$('#rvNext').onclick = () => { flushReview(); rv.week = weekStart(rv.week + 7 * DAY + 12 * 3_600_000); renderReview(); };
$('#rvThis').onclick = () => { flushReview(); rv.week = weekStart(Date.now()); renderReview(); };

// ===== journal =====
// One entry per calendar day: { text, rating 1–5, tags[], updatedAt }.
// Kept in this browser's localStorage for now, per Bybit account, until the
// cloud store is set up; nothing is sent anywhere.
const jr = { day: null, month: null, saveTimer: 0 };
const pb = { id: null, timer: 0 };
const rv = { week: null, timer: 0 };                // weekly review: Monday of the week shown                 // playbook state; declared early because readHash() uses it
const journalKey = () => 'journal:' + (status?.key?.uid ?? 'local');
let journalCache = null;
function journalAll() {
  if (!journalCache || journalCache.key !== journalKey()) journalCache = { key: journalKey(), data: store.get(journalKey(), {}) };
  return journalCache.data;
}
const journalEntry = k => journalAll()[k] || null;
const journalHas = k => { const e = journalEntry(k); return !!e && (!!e.text?.trim() || !!e.rating || !!e.tags?.length); };
function journalPut(k, patch) {
  const data = journalAll();
  const next = { text: '', rating: 0, tags: [], ...data[k], ...patch, updatedAt: Date.now() };
  if (!next.text.trim() && !next.rating && !next.tags.length && !next.pledges?.length) delete data[k]; else data[k] = next;
  store.set(journalKey(), data);
  markLocalChange();
}
const keyToDate = k => new Date(fromInput(k));
const shiftDay = (k, n) => { const d = keyToDate(k); d.setDate(d.getDate() + n); return dayKey(d); };

function openJournal(key) {
  jr.day = key;
  const d = keyToDate(key); jr.month = { y: d.getFullYear(), m: d.getMonth() };
  setView('journal');
  window.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' });
}

// #journal/2026-10-14 deep-links to a day; #analytics etc. to a view
function syncHash() {
  const want = view === 'journal' && jr.day ? `#journal/${jr.day}` : view === 'playbook' && pb.id ? `#playbook/${pb.id}` : view === 'review' && rv.week ? `#review/${dayKey(new Date(rv.week))}` : `#${view}`;
  if (location.hash !== want) history.replaceState(null, '', want);
}
function readHash() {
  const m = location.hash.match(/^#(dashboard|analytics|journal|review|playbook|wizard|trades)(?:\/([\w-]+))?$/);
  if (!m) return false;
  if (m[1] === 'journal' && /^\d{4}-\d{2}-\d{2}$/.test(m[2] || '')) { jr.day = m[2]; const d = keyToDate(m[2]); jr.month = { y: d.getFullYear(), m: d.getMonth() }; }
  if (m[1] === 'playbook' && m[2]) pb.id = m[2];
  if (m[1] === 'review' && /^\d{4}-\d{2}-\d{2}$/.test(m[2] || '')) rv.week = weekStart(fromInput(m[2]));
  view = m[1];
  return true;
}
window.addEventListener('hashchange', () => { if (readHash() && !$('#report').hidden) setView(view, { hash: false }); });
readHash();

function renderJournal() {
  const today = dayKey(new Date());
  if (!jr.day) jr.day = today;
  if (!jr.month) { const d = keyToDate(jr.day); jr.month = { y: d.getFullYear(), m: d.getMonth() }; }
  syncHash();
  const daily = dailyMap(all);
  renderJournalCalendar(daily, today);
  renderJournalRecent();

  // header and the day's numbers
  const d = keyToDate(jr.day), day = daily.get(jr.day);
  $('#jrTitle').textContent = longDate(d);
  $('#jrNextDay').disabled = jr.day >= today;
  const later = [...daily.keys()].filter(k => k > jr.day).sort()[0];
  $('#jrNextTraded').disabled = !later;
  const stat = (k, v) => { const x = el('div'); x.append(el('dt', '', k), el('dd', '', v)); return x; };
  if (day) {
    const ds = summarize([...day.trades].sort((a, b) => a.time - b.time));
    $('#jrStats').replaceChildren(stat('Net P&L', money(ds.net)), stat('Trades', String(ds.n)), stat('Win rate', pct(ds.winRate)), stat('Fees', money(-ds.fees)), stat('Best', money(ds.best?.pnl)), stat('Worst', money(ds.worst?.pnl)));
    $('#jrTradesWrap').hidden = false;
    tradeTable($('#jrTrades'), [...day.trades].sort((a, b) => a.time - b.time), DAY_COLS);
  } else {
    $('#jrStats').replaceChildren(stat('Trades', 'None'), stat('Net P&L', '—'));
    $('#jrTradesWrap').hidden = true;
  }

  // the entry
  const e = journalEntry(jr.day) || { text: '', rating: 0, tags: [] };
  const ta = $('#jrText');
  if (ta._day !== jr.day || (document.activeElement !== ta && ta.value !== e.text)) { ta.value = e.text; ta._day = jr.day; autosize(ta); }
  const done = e.pledges || [];
  $('#jrCheckin').replaceChildren(...(done.length
    ? [el('span', 'kicker', `Check-in · ${done.length} affirmed`), ...done.map(t => el('span', 'jr-pledge', '✓ ' + t))]
    : jr.day === today ? [el('span', 'muted small', 'Today’s check-in is on the dashboard.')] : []));
  paintRating(e.rating);
  paintTags(e.tags);
  $('#jrSaved').textContent = e.updatedAt ? `Saved in this browser · ${ago(e.updatedAt)}` : 'Saved in this browser only. Entries move to cloud storage once that’s set up.';
}

function renderJournalCalendar(daily, today) {
  const { y, m } = jr.month;
  $('#jrMonthTitle').textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const month = calendarMonth(daily, y, m);
  const scale = scaleOf(month.weeks.flatMap(w => w.days).filter(x => x.inMonth && x.n).map(x => x.net));
  const grid = $('#jrCalendar');
  grid.replaceChildren(...WEEKDAYS.map(x => el('div', 'cal-dow', x[0])));
  for (const w of month.weeks) for (const x of w.days) {
    const future = x.key > today;
    const b = el(future ? 'div' : 'button', `jr-day ${x.inMonth ? '' : 'out'} ${x.n ? sign(x.net) : ''} ${x.key === jr.day ? 'on' : ''} ${x.key === today ? 'today' : ''}`);
    b.textContent = String(x.date.getDate());
    if (x.n) b.style.setProperty('--tint', `${Math.round(14 + 30 * Math.min(1, Math.abs(x.net) / (scale || 1)))}%`);
    if (journalHas(x.key)) b.append(el('i', 'jr-dot'));
    if (!future) {
      b.type = 'button';
      b.setAttribute('aria-label', `${longDate(x.date)}${x.n ? `, ${money(x.net)}` : ''}${journalHas(x.key) ? ', has an entry' : ''}`);
      if (x.key === jr.day) b.setAttribute('aria-current', 'date');
      b.onclick = () => { jr.day = x.key; if (!x.inMonth) jr.month = { y: x.date.getFullYear(), m: x.date.getMonth() }; renderJournal(); };
    }
    grid.append(b);
  }
}

function renderJournalRecent() {
  const data = journalAll();
  const keys = Object.keys(data).filter(journalHas).sort().reverse().slice(0, 8);
  const daily = dailyMap(all);
  const list = $('#jrRecent');
  if (!keys.length) { list.replaceChildren(el('li', 'muted small', 'No entries yet. Pick a day and start writing.')); return; }
  list.replaceChildren(...keys.map(k => {
    const li = el('li'), b = el('button', 'jr-recent-item' + (k === jr.day ? ' on' : '')); b.type = 'button';
    const day = daily.get(k);
    const head = el('span', 'jr-recent-head');
    head.append(el('b', '', keyToDate(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })), el('span', 'jr-recent-pnl ' + (day ? sign(day.net) : ''), day ? money(day.net) : 'no trades'));
    // preview: the first line that's actual writing, not a bare template heading like "Plan:"
    const line = (data[k].text || '').split('\n').map(x => x.trim()).find(x => x && !/^[\w\u2019' ]{1,24}:$/.test(x));
    b.append(head, el('span', 'jr-recent-text', line || (data[k].tags || []).map(t => '#' + t).join(' ') || '—'));
    b.onclick = () => { jr.day = k; const d = keyToDate(k); jr.month = { y: d.getFullYear(), m: d.getMonth() }; renderJournal(); };
    li.append(b); return li;
  }));
}

function paintRating(r) {
  const box = $('#jrRating');
  box.replaceChildren(...[1, 2, 3, 4, 5].map(n => {
    const b = el('button', 'jr-pip' + (n <= r ? ' on' : ''), String(n)); b.type = 'button';
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(n === r)); b.title = ['', 'Off plan', 'Shaky', 'OK', 'Good', 'Followed my plan'][n];
    b.onclick = () => { journalPut(jr.day, { rating: n === r ? 0 : n }); renderJournal(); };
    return b;
  }));
}
function paintTags(tags) {
  $('#jrTags').replaceChildren(...tags.map(t => {
    const c = el('button', 'jr-tag', '#' + t); c.type = 'button'; c.title = 'Remove tag';
    c.onclick = () => { journalPut(jr.day, { tags: tags.filter(x => x !== t) }); renderJournal(); };
    return c;
  }));
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(220, ta.scrollHeight + 2) + 'px'; }

$('#jrText').addEventListener('input', e => {
  autosize(e.target);
  clearTimeout(jr.saveTimer);
  $('#jrSaved').textContent = 'Saving…';
  const day = jr.day, text = e.target.value;
  jr.saveTimer = setTimeout(() => { journalPut(day, { text }); $('#jrSaved').textContent = 'Saved in this browser · just now'; renderJournalCalendar(dailyMap(all), dayKey(new Date())); renderJournalRecent(); }, 400);
});
// never lose the last keystrokes when switching days or closing the tab
const flushJournal = () => { if (jr.saveTimer) { clearTimeout(jr.saveTimer); jr.saveTimer = 0; const ta = $('#jrText'); if (ta._day) journalPut(ta._day, { text: ta.value }); } };
window.addEventListener('beforeunload', flushJournal);
for (const id of ['#jrPrevDay', '#jrNextDay', '#jrNextTraded', '#jrToday', '#jrPrevMonth', '#jrNextMonth']) $(id).addEventListener('pointerdown', flushJournal);
$('#jrCalendar').addEventListener('pointerdown', flushJournal);
$('#jrRecent').addEventListener('pointerdown', flushJournal);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('pointerdown', flushJournal));

$('#jrTagInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  const t = e.target.value.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
  if (!t) return;
  const cur = journalEntry(jr.day)?.tags || [];
  if (!cur.includes(t)) journalPut(jr.day, { tags: [...cur, t] });
  e.target.value = '';
  renderJournal();
});
$('#jrTemplate').onclick = () => {
  const ta = $('#jrText');
  const tpl = 'Plan:\n\nWhat happened:\n\nWhat I did well:\n\nWhat I’d change:\n\nLesson:\n';
  ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') + tpl : tpl;
  ta.dispatchEvent(new Event('input')); ta.focus();
};
$('#jrPrevDay').onclick = () => { jr.day = shiftDay(jr.day, -1); const d = keyToDate(jr.day); jr.month = { y: d.getFullYear(), m: d.getMonth() }; renderJournal(); };
$('#jrNextDay').onclick = () => { jr.day = shiftDay(jr.day, 1); const d = keyToDate(jr.day); jr.month = { y: d.getFullYear(), m: d.getMonth() }; renderJournal(); };
$('#jrNextTraded').onclick = () => {
  const next = [...dailyMap(all).keys()].filter(k => k > jr.day).sort()[0];
  if (next) { jr.day = next; const d = keyToDate(next); jr.month = { y: d.getFullYear(), m: d.getMonth() }; renderJournal(); }
};
$('#jrToday').onclick = () => { jr.day = dayKey(new Date()); jr.month = null; renderJournal(); };
$('#jrPrevMonth').onclick = () => { jr.month.m--; if (jr.month.m < 0) { jr.month.m = 11; jr.month.y--; } renderJournalCalendar(dailyMap(all), dayKey(new Date())); $('#jrMonthTitle').focus?.(); };
$('#jrNextMonth').onclick = () => { jr.month.m++; if (jr.month.m > 11) { jr.month.m = 0; jr.month.y++; } renderJournalCalendar(dailyMap(all), dayKey(new Date())); };


// ===== playbook =====
// Strategies: { id, name, overview, entry, exit, tags[], createdAt, updatedAt }.
// Kept in this browser per Bybit account (like the journal) and included in
// "Save to server" snapshots.
const playbookKey = () => 'playbook:' + (status?.key?.uid ?? 'local');
// cached in memory: strategy lookups run once per trade on every render
let pbCache = null;
const playbookAll = () => (pbCache?.key === playbookKey() ? pbCache.data : (pbCache = { key: playbookKey(), data: store.get(playbookKey(), []) }).data);
function playbookWrite(list) { pbCache = { key: playbookKey(), data: list }; store.set(playbookKey(), list); markLocalChange(); }
function playbookPatch(id, patch) {
  const list = playbookAll(), i = list.findIndex(x => x.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch, updatedAt: Date.now() };
  playbookWrite(list);
}
function addStrategy() {
  flushPlaybook();
  const s = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '', overview: '', entry: '', exit: '', tags: [], createdAt: Date.now(), updatedAt: Date.now() };
  playbookWrite([...playbookAll(), s]);
  pb.id = s.id;
  renderPlaybook();
  $('#pbName').focus();
}

function renderPlaybook() {
  const list = playbookAll();
  paintStrategyFilter();
  $('#rangeText').textContent = `${list.length} strateg${list.length === 1 ? 'y' : 'ies'} · your rules for each setup`;
  if (!list.find(x => x.id === pb.id)) pb.id = list[0]?.id ?? null;
  syncHash();
  // the list
  $('#pbList').replaceChildren(...(list.length ? list : []).map(x => {
    const li = el('li'), b = el('button', 'pb-item' + (x.id === pb.id ? ' on' : '')); b.type = 'button';
    b.append(el('b', '', x.name.trim() || 'Untitled strategy'));
    if (x.tags.length) { const t = el('span', 'pb-item-tags'); t.append(...x.tags.slice(0, 4).map(tag => el('span', 'jr-tag static', '#' + tag))); b.append(t); }
    const mine = all.filter(t => strategyOf(t) === x.id);
    if (mine.length) {
      const net = mine.reduce((n, t) => n + t.pnl, 0), wins = mine.filter(t => t.pnl > 0).length;
      b.append(el('span', 'pb-item-stats ' + sign(net), `${mine.length} trade${mine.length === 1 ? '' : 's'} · ${money(net)} · ${pct(wins / mine.length)} won`));
    }
    const first = (x.overview || x.entry || '').trim().split('\n')[0];
    if (first) b.append(el('span', 'pb-item-text', first));
    b.onclick = () => { flushPlaybook(); pb.id = x.id; renderPlaybook(); };
    li.append(b); return li;
  }));
  if (!list.length) $('#pbList').replaceChildren(el('li', 'muted small', 'No strategies yet.'));
  $('#pbEmpty').hidden = !!list.length;
  $('#pbForm').hidden = !list.length;
  if (!list.length) return;
  // the editor
  const x = list.find(y => y.id === pb.id);
  for (const [id, k] of [['#pbName', 'name'], ['#pbOverview', 'overview'], ['#pbEntry', 'entry'], ['#pbExit', 'exit']]) {
    const f = $(id);
    if (f._id !== x.id) { f.value = x[k] || ''; f._id = x.id; if (f.tagName === 'TEXTAREA') autosize(f); }
  }
  $('#pbTags').replaceChildren(...x.tags.map(t => {
    const c = el('button', 'jr-tag', '#' + t); c.type = 'button'; c.title = 'Remove tag';
    c.onclick = () => { playbookPatch(x.id, { tags: x.tags.filter(y => y !== t) }); renderPlaybook(); };
    return c;
  }));
  $('#pbSaved').textContent = `Saved in this browser · ${ago(x.updatedAt)}`;
}

// typing autosaves after a short pause; switching away saves immediately
const pbFields = { '#pbName': 'name', '#pbOverview': 'overview', '#pbEntry': 'entry', '#pbExit': 'exit' };
let pbPending = null;
function flushPlaybook() {
  if (!pbPending) return;
  clearTimeout(pb.timer);
  const { id, patch } = pbPending; pbPending = null;
  playbookPatch(id, patch);
}
for (const [sel, key] of Object.entries(pbFields)) {
  $(sel).addEventListener('input', e => {
    if (e.target.tagName === 'TEXTAREA') autosize(e.target);
    if (!pb.id) return;
    pbPending = { id: pb.id, patch: { ...(pbPending?.id === pb.id ? pbPending.patch : {}), [key]: e.target.value } };
    $('#pbSaved').textContent = 'Saving…';
    clearTimeout(pb.timer);
    pb.timer = setTimeout(() => { flushPlaybook(); renderPlaybook(); }, 400);
  });
}
window.addEventListener('beforeunload', flushPlaybook);
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('pointerdown', flushPlaybook));
$('#pbList').addEventListener('pointerdown', flushPlaybook);
$('#pbAdd').onclick = $('#pbAdd2').onclick = addStrategy;
$('#pbDelete').onclick = () => {
  const x = playbookAll().find(y => y.id === pb.id);
  if (!x || !confirm(`Delete "${x.name.trim() || 'Untitled strategy'}"? This can't be undone.`)) return;
  pbPending = null; clearTimeout(pb.timer);
  playbookWrite(playbookAll().filter(y => y.id !== x.id));
  const labels = labelsAll();
  for (const k of Object.keys(labels)) if (labels[k] === x.id) delete labels[k];
  store.set(labelsKey(), labels);
  if (filters.strategy === x.id) { filters.strategy = 'all'; saveFilters(); }
  pb.id = null;
  for (const f of Object.keys(pbFields)) $(f)._id = null;
  renderPlaybook();
};
$('#pbTagInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  const t = e.target.value.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
  if (!t || !pb.id) return;
  flushPlaybook();
  const x = playbookAll().find(y => y.id === pb.id);
  if (!x.tags.includes(t)) playbookPatch(pb.id, { tags: [...x.tags, t] });
  e.target.value = '';
  renderPlaybook();
});

// ===== Saturday: a no-trade day =====
function paintSaturday() {
  const now = new Date(), banner = $('#saturday');
  const isSat = now.getDay() === 6;
  banner.hidden = !isSat;
  if (!isSat) return;
  const start = startOfDay(now.getTime());
  const today = all.filter(t => t.time >= start).length;
  $('#satSub').textContent = today
    ? `You've already closed ${today} trade${today === 1 ? '' : 's'} today. Stop here, and journal why it happened.`
    : 'Close the charts. Review the week, update your playbook, and come back fresh.';
}
// ===== too many trades today =====
// Same limit as the warnings line (WARN.maxTradesPerDay), counted over today's
// calendar day across all markets. It knows about trades once they're pulled.
function paintOvertrade() {
  const start = startOfDay(Date.now());
  const n = all.filter(t => t.time >= start).length, limit = WARN.maxTradesPerDay;
  // on a Saturday the Saturday banner already says how many trades you've closed
  const show = n > limit && new Date().getDay() !== 6;
  $('#overtrade').hidden = !show;
  if (!show) return;
  $('#otTitle').textContent = `You've closed ${n} trades today.`;
  $('#otSub').textContent = `That's over your limit of ${limit} a day. Step away for the rest of the day and write down what happened.`;
}
$('#otJournal').onclick = () => openJournal(dayKey(new Date()));

// ===== daily loss limit (WARN.dailyLossPct of today's starting equity) =====
const lossToday = () => dailyLoss(all, account?.available ? account.equity : null);
function paintLossLimit() {
  const dl = lossToday();
  const show = dl.hit && new Date().getDay() !== 6;        // Saturday's banner already says stop
  $('#losslimit').hidden = !show;
  if (!show) return;
  $('#llTitle').textContent = `Daily loss limit hit: ${money(dl.net)} today.`;
  $('#llSub').textContent = `That's ${dl.lossPct.toFixed(1)}% of your account, past your ${WARN.dailyLossPct}% limit. Stop trading for today.`;
}
$('#llJournal').onclick = () => openJournal(dayKey(new Date()));
$('#satReview').onclick = () => { rv.week = weekStart(Date.now()); setView('review'); };
const paintBanners = () => { paintSaturday(); paintOvertrade(); paintLossLimit(); };
paintBanners();
setInterval(paintBanners, 60_000);

loadStatus().catch(e => { show('setup'); $('#setupMsg').textContent = 'Could not reach the local server: ' + e.message; });
