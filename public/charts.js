// Small hand-rolled SVG charts: a line/area with crosshair, signed columns,
// and signed horizontal bars. Colors come from CSS tokens; gains and losses
// use the diverging pair (--pos / --neg), always alongside a signed number.

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// ---- tooltip: one shared element, text only ----
let tip;
function tooltip() {
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip); }
  return tip;
}
// rows: [{value, label, key?:'pos'|'neg'|'line'}]
export function showTip(x, y, title, rows) {
  const t = tooltip();
  t.replaceChildren();
  if (title) { const h = document.createElement('div'); h.className = 'tip-title'; h.textContent = title; t.appendChild(h); }
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'tip-row';
    if (r.key) { const k = document.createElement('i'); k.className = 'tip-key ' + r.key; row.appendChild(k); }
    const v = document.createElement('b'); v.textContent = r.value; row.appendChild(v);
    if (r.label) { const l = document.createElement('span'); l.textContent = r.label; row.appendChild(l); }
    t.appendChild(row);
  }
  t.hidden = false;
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let left = x + pad, top = y - h - pad;
  if (left + w > innerWidth - 8) left = x - w - pad;
  if (top < 8) top = y + pad;
  t.style.left = left + scrollX + 'px';
  t.style.top = top + scrollY + 'px';
}
export const hideTip = () => { if (tip) tip.hidden = true; };

// ---- scales ----
function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return ticks;
}
const linear = (d0, d1, r0, r1) => v => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

// Column/bar path: 4px rounded at the data end, square at the baseline.
function barPath(x, w, y0, y1) {
  const h = Math.abs(y1 - y0), r = Math.min(4, w / 2, h);
  if (h < 0.5) return `M${x},${y0}h${w}`;
  if (y1 < y0) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}
function hBarPath(x0, x1, y, h) {
  const w = Math.abs(x1 - x0), r = Math.min(4, h / 2, w);
  if (w < 0.5) return `M${x0},${y}v${h}`;
  if (x1 > x0) return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 - r},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + h - r}Q${x1},${y + h} ${x1 + r},${y + h}H${x0}Z`;
}

// Re-render on resize. draw(width, fresh): `fresh` is true for the first
// render after new data, which animates in; resizes redraw without motion.
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function responsive(el, draw) {
  if (el._ro) el._ro.disconnect();
  let last = 0;
  el._ro = new ResizeObserver(() => { const w = el.clientWidth; if (w && Math.abs(w - last) > 2) { const fresh = !last; last = w; draw(w, fresh && !calm()); } });
  el._ro.observe(el);
  last = el.clientWidth; if (last) draw(last, !calm());
}

function yAxis(svg, ticks, y, left, right, fmtTick) {
  for (const v of ticks) {
    const yy = Math.round(y(v)) + 0.5;
    svg.appendChild(svgEl('line', { x1: left, x2: right, y1: yy, y2: yy, class: v === 0 ? 'baseline' : 'grid' }));
    const t = svgEl('text', { x: left - 8, y: yy, class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    t.textContent = fmtTick(v); svg.appendChild(t);
  }
}

function timeTicks(x0, x1, width) {
  const count = Math.max(2, Math.min(7, Math.floor(width / 110)));
  const span = x1 - x0, out = [];
  for (let i = 0; i <= count; i++) out.push(x0 + (span * i) / count);
  return out;
}
const fmtDate = (ms, span) => new Date(ms).toLocaleDateString(undefined,
  span > 300 * 86_400_000 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });

// Monotone cubic (Fritsch–Carlson) through [x, y] screen points.
function monotonePath(P) {
  const n = P.length;
  if (n < 3) return P.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
  const dx = [], m = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0] || 1e-6; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${P[i][0] + h},${P[i][1] + h * t[i]} ${P[i + 1][0] - h},${P[i + 1][1] - h * t[i + 1]} ${P[i + 1][0]},${P[i + 1][1]}`;
  }
  return d;
}

// ---- line / area over time, with crosshair ----
// opts: { points:[{x,y}], color:'pos'|'neg', area:boolean, fmt(v), fmtTick(v), tipTitle(p), tipRows(p), height }
export function lineChart(el, opts) {
  const { points, color = 'pos', area = true, fmtTick, height = 260 } = opts;
  el.replaceChildren();
  if (points.length < 2) { el.innerHTML = '<p class="empty">Not enough trades in this range.</p>'; return; }
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const m = opts.compact ? { t: 8, r: 8, b: 22, l: 48 } : { t: 14, r: 16, b: 28, l: 64 };
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.label || 'chart' });
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const ticks = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys), opts.compact ? 3 : 5);
    const x = linear(x0, x1, m.l, width - m.r), y = linear(ticks[0], ticks[ticks.length - 1], height - m.b, m.t);
    yAxis(svg, ticks, y, m.l, width - m.r, fmtTick);
    for (const tx of timeTicks(x0, x1, width - m.l - m.r)) {
      const t = svgEl('text', { x: x(tx), y: height - 8, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = fmtDate(tx, x1 - x0); svg.appendChild(t);
    }
    // step-after by default (equity only changes at a close); `smooth` draws a
    // monotone curve through the same points, which never overshoots them
    const d = opts.smooth ? monotonePath(points.map(p => [x(p.x), y(p.y)])) : points.reduce((acc, p, i) => acc + (i ? `H${x(p.x)}V${y(p.y)}` : `M${x(p.x)},${y(p.y)}`), '');
    const last = points[points.length - 1];
    let dotCls = color;
    if (opts.signed) {
      // one gradient, split hard at the zero line: the curve is cyan above $0 and rose below,
      // and the fill fades from each color toward zero
      const id = 'g' + Math.random().toString(36).slice(2, 8);
      const z = Math.max(0, Math.min(1, (y(0) - m.t) / (height - m.b - m.t)));
      const defs = svgEl('defs');
      const grad = (gid, stops) => {
        const g = svgEl('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: 0, y1: m.t, x2: 0, y2: height - m.b });
        for (const [o, c, a] of stops) g.appendChild(svgEl('stop', { offset: o, style: `stop-color:var(--${c});stop-opacity:${a}` }));
        defs.appendChild(g);
      };
      grad(id + 's', [[0, 'pos', 1], [z, 'pos', 1], [z, 'neg', 1], [1, 'neg', 1]]);
      grad(id + 'f', [[0, 'pos', .34], [z, 'pos', .02], [z, 'neg', .02], [1, 'neg', .34]]);
      svg.appendChild(defs);
      if (area) svg.appendChild(svgEl('path', { d: d + `V${y(0)}H${x(points[0].x)}Z`, fill: `url(#${id}f)`, class: 'area-signed' + (fresh ? ' fade-in' : '') }));
      svg.appendChild(svgEl('path', { d, stroke: `url(#${id}s)`, class: 'line line-halo' + (fresh ? ' draw' : ''), pathLength: 1 }));
      svg.appendChild(svgEl('path', { d, stroke: `url(#${id}s)`, class: 'line' + (fresh ? ' draw' : ''), pathLength: 1 }));
      dotCls = last.y >= 0 ? 'pos' : 'neg';
    } else {
      if (area) svg.appendChild(svgEl('path', { d: d + `V${y(0)}H${x(points[0].x)}Z`, class: 'area ' + color + (fresh ? ' fade-in' : '') }));
      svg.appendChild(svgEl('path', { d, class: 'line glow ' + color + (fresh ? ' draw' : ''), pathLength: 1 }));
    }
    svg.appendChild(svgEl('circle', { cx: x(last.x), cy: y(last.y), r: 4, class: 'pulse-ring ' + dotCls }));
    svg.appendChild(svgEl('circle', { cx: x(last.x), cy: y(last.y), r: 4, class: 'dot ' + dotCls + (fresh ? ' pop-late' : '') }));

    // crosshair
    const hair = svgEl('line', { y1: m.t, y2: height - m.b, class: 'hair', visibility: 'hidden' });
    const mark = svgEl('circle', { r: 4, class: 'dot ' + color, visibility: 'hidden' });
    svg.append(hair, mark);
    const hit = svgEl('rect', { x: m.l, y: 0, width: width - m.l - m.r, height, fill: 'transparent', tabindex: 0 });
    const nearest = px => {
      const target = x0 + ((px - m.l) / (width - m.l - m.r)) * (x1 - x0);
      let lo = 0, hi = points.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (points[mid].x <= target) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const show = (i, cx, cy) => {
      const p = points[i];
      hair.setAttribute('x1', x(p.x)); hair.setAttribute('x2', x(p.x)); hair.setAttribute('visibility', 'visible');
      mark.setAttribute('cx', x(p.x)); mark.setAttribute('cy', y(p.y)); mark.setAttribute('visibility', 'visible');
      if (opts.signed) mark.setAttribute('class', 'dot ' + (p.y >= 0 ? 'pos' : 'neg'));
      showTip(cx, cy, opts.tipTitle(p), opts.tipRows(p));
    };
    let focusI = points.length - 1;
    hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); focusI = nearest(e.clientX - r.left); show(focusI, e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); mark.setAttribute('visibility', 'hidden'); hideTip(); });
    hit.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); focusI = Math.max(0, Math.min(points.length - 1, focusI + (e.key === 'ArrowRight' ? 1 : -1)));
      const r = svg.getBoundingClientRect(); show(focusI, r.left + x(points[focusI].x), r.top + y(points[focusI].y));
    });
    hit.addEventListener('blur', () => hit.dispatchEvent(new Event('pointerleave')));
    svg.appendChild(hit);
    el.appendChild(svg);
  });
}

// ---- signed columns (P&L per period / weekday / hour / histogram) ----
// opts: { bars:[{label, value, signOf?, tipTitle, tipRows}], fmtTick, height, labelEvery, colorBy:(bar)=>'pos'|'neg'|'muted' }
export function columnChart(el, opts) {
  const { bars, fmtTick, height = 220 } = opts;
  el.replaceChildren();
  if (!bars.length) { el.innerHTML = '<p class="empty">No trades in this range.</p>'; return; }
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const m = { t: 12, r: 12, b: 28, l: 64 };
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.label || 'chart' });
    const vals = bars.map(b => b.value);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), height < 160 ? 2 : 5);
    const y = linear(ticks[0], ticks[ticks.length - 1], height - m.b, m.t);
    yAxis(svg, ticks, y, m.l, width - m.r, fmtTick);
    const band = (width - m.l - m.r) / bars.length;
    const w = Math.max(1, Math.min(24, band - 2));       // capped thickness, ≥2px gap between bars
    const every = opts.labelEvery || Math.max(1, Math.ceil(bars.length / Math.floor((width - m.l - m.r) / 44)));
    bars.forEach((b, i) => {
      const bx = m.l + i * band + (band - w) / 2;
      const cls = (opts.colorBy ? opts.colorBy(b) : (b.value >= 0 ? 'pos' : 'neg'));
      const g = svgEl('g', { class: 'mark', tabindex: 0 });
      g.appendChild(svgEl('rect', { x: m.l + i * band, y: m.t, width: band, height: height - m.t - m.b, fill: 'transparent' }));
      if (opts.lollipop) {
        // a stem from zero and a glowing head at the value
        const cx = bx + w / 2;
        const stem = svgEl('line', { x1: cx, x2: cx, y1: y(0), y2: y(b.value), class: 'stem ' + cls + (fresh ? ' grow-y' : '') });
        const head = svgEl('circle', { cx, cy: y(b.value), r: b.value ? 6 : 3, class: 'lolli ' + (b.value ? cls : 'zero') + (fresh ? ' pop-in' : '') });
        if (fresh) { stem.style.cssText = `transform-origin:${cx}px ${y(0)}px;animation-delay:${i * 60}ms`; head.style.animationDelay = `${300 + i * 60}ms`; }
        g.append(stem, head);
      } else {
        const bar = svgEl('path', { d: barPath(bx, w, y(0), y(b.value)), class: 'bar ' + cls + (fresh ? ' grow-y' : '') });
        if (fresh) bar.style.cssText = `transform-origin:${bx + w / 2}px ${y(0)}px;animation-delay:${Math.min(i * 14, 500)}ms`;
        g.appendChild(bar);
      }
      const on = e => {
        const r = e.type === 'focus' ? g.getBoundingClientRect() : null;
        showTip(r ? r.left + r.width / 2 : e.clientX, r ? r.top : e.clientY, b.tipTitle, b.tipRows);
      };
      g.addEventListener('pointermove', on); g.addEventListener('focus', on);
      g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
      svg.appendChild(g);
      if (i % every === 0) {
        const t = svgEl('text', { x: bx + w / 2, y: height - 8, class: 'tick', 'text-anchor': 'middle' });
        t.textContent = b.label; svg.appendChild(t);
      }
    });
    el.appendChild(svg);
  });
}

// ---- signed horizontal bars with labels (per symbol) ----
// opts: { rows:[{label, value, valueText, tipTitle, tipRows}] }
export function hbarChart(el, opts) {
  const { rows } = opts;
  el.replaceChildren();
  if (!rows.length) { el.innerHTML = '<p class="empty">No trades in this range.</p>'; return; }
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const rowH = 30, barH = 18, labelW = Math.min(120, width * 0.28), valueW = 84;
    const height = rows.length * rowH + 8;
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.label || 'chart' });
    const vals = rows.map(r => r.value);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    const left = labelW + (lo < 0 ? valueW : 8), right = width - (hi > 0 ? valueW : 8);
    const x = linear(lo, hi || 1, left, right);
    const zx = Math.round(x(0)) + 0.5;
    rows.forEach((r, i) => {
      const yy = 4 + i * rowH, by = yy + (rowH - barH) / 2;
      const g = svgEl('g', { class: 'mark', tabindex: 0 });
      g.appendChild(svgEl('rect', { x: 0, y: yy, width, height: rowH, fill: 'transparent' }));
      const name = svgEl('text', { x: 0, y: yy + rowH / 2, class: 'label', 'dominant-baseline': 'middle' });
      name.textContent = r.label; g.appendChild(name);
      const bar = svgEl('path', { d: hBarPath(x(0), x(r.value), by, barH), class: 'bar ' + (r.value >= 0 ? 'pos' : 'neg') + (fresh ? ' grow-x' : '') });
      if (fresh) bar.style.cssText = `transform-origin:${x(0)}px ${by}px;animation-delay:${i * 40}ms`;
      g.appendChild(bar);
      const vt = svgEl('text', { x: r.value >= 0 ? x(r.value) + 6 : x(r.value) - 6, y: yy + rowH / 2, class: 'value', 'dominant-baseline': 'middle', 'text-anchor': r.value >= 0 ? 'start' : 'end' });
      vt.textContent = r.valueText; g.appendChild(vt);
      const on = e => {
        const b = e.type === 'focus' ? g.getBoundingClientRect() : null;
        showTip(b ? b.left + x(r.value) : e.clientX, b ? b.top : e.clientY, r.tipTitle, r.tipRows);
      };
      g.addEventListener('pointermove', on); g.addEventListener('focus', on);
      g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
      svg.appendChild(g);
    });
    svg.appendChild(svgEl('line', { x1: zx, x2: zx, y1: 0, y2: height, class: 'baseline' }));
    el.appendChild(svg);
  });
}

// ---- dashboard widgets ----

// Semicircle gauge: the share `frac` in pos, the rest in neg, a 2px surface gap between.
export function gauge(el, { frac, label, size = 160, parts }) {
  el.replaceChildren();
  const w = size, r = size * 0.4, sw = Math.max(6, size * 0.075), cx = w / 2, cy = r + sw / 2 + 2, h = cy + sw / 2 + 2;
  const svg = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label });
  const pt = a => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const arc = (a0, a1, cls) => {
    if (a0 - a1 < 0.001) return;
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    const p = svgEl('path', { d: `M${x0},${y0}A${r},${r} 0 0 1 ${x1},${y1}`, class: 'gauge ' + cls + (calm() || cls === 'track' ? '' : ' sweep'), 'stroke-width': sw, pathLength: 1 });
    if (cls !== 'pos' && cls !== 'track') p.style.animationDelay = '380ms';
    svg.appendChild(p);
  };
  // parts: [{share, cls}] left→right; or frac: pos share with the rest neg
  const segs = parts || (frac === null || !Number.isFinite(frac) ? [{ share: 1, cls: 'muted' }] : [{ share: frac, cls: 'pos' }, { share: 1 - frac, cls: 'neg' }]);
  const shown = segs.filter(p => p.share > 0.004);
  arc(Math.PI, 0, 'track');
  const gap = shown.length > 1 ? (sw + 3) / r : 0;     // room for the rounded ends plus a 2–3px gap
  let a = Math.PI;
  shown.forEach((p, i) => {
    const a1 = a - Math.PI * p.share;
    arc(a - (i ? gap / 2 : 0), a1 + (i < shown.length - 1 ? gap / 2 : 0), p.cls);
    a = a1;
  });
  el.appendChild(svg);
}

// Horizontal bar split by share: left pos, right neg, 2px gap, rounded ends.
export function splitBar(el, { left, right, label }) {
  el.replaceChildren();
  const bar = document.createElement('div');
  bar.className = 'split'; bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', label);
  const total = (left || 0) + (right || 0);
  const l = document.createElement('i'), r = document.createElement('i');
  l.className = 'pos'; r.className = 'neg';
  l.style.flexGrow = total ? left / total : 1; r.style.flexGrow = total ? right / total : 1;
  bar.append(l, r);
  el.appendChild(bar);
}

// Tiny line with a soft area, no axes. values: numbers in order.
// `bleed` draws edge to edge as a card background: thinned to ~48 points,
// smoothed, and filled with a fade toward the bottom.
export function sparkline(el, { values, color = 'pos', height = 40, bleed = false }) {
  el.replaceChildren();
  if (values.length < 2) return;
  let vals = values;
  if (bleed && vals.length > 48) {
    const step = (vals.length - 1) / 47;
    vals = Array.from({ length: 48 }, (_, i) => values[Math.round(i * step)]);
  }
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const h = bleed ? el.clientHeight || height : height;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = bleed ? 0 : 2, top = bleed ? h * 0.12 : 3, bottom = bleed ? 6 : 3;
    const x = i => pad + (i / (vals.length - 1)) * (width - 2 * pad);
    const y = v => h - bottom - ((v - lo) / (hi - lo || 1)) * (h - top - bottom);
    const pts = vals.map((v, i) => [x(i), y(v)]);
    const svg = svgEl('svg', { width, height: h, viewBox: `0 0 ${width} ${h}`, 'aria-hidden': 'true', preserveAspectRatio: 'none' });
    const d = bleed ? monotonePath(pts) : pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
    let fill = null;
    if (bleed) {
      const id = 'sf' + Math.random().toString(36).slice(2, 8);
      const g = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
      g.append(svgEl('stop', { offset: 0, class: 'spark-stop', 'stop-opacity': .32 }), svgEl('stop', { offset: 1, class: 'spark-stop', 'stop-opacity': 0 }));
      const defs = svgEl('defs'); defs.appendChild(g); svg.appendChild(defs);
      fill = `url(#${id})`;
    }
    const area = svgEl('path', { d: `${d}L${x(vals.length - 1)},${h}L${x(0)},${h}Z`, class: (bleed ? 'spark-fill ' : 'area ') + color + (fresh ? ' fade-in' : '') });
    if (fill) area.setAttribute('fill', fill);
    svg.appendChild(area);
    svg.appendChild(svgEl('path', { d, class: 'line glow ' + color + (bleed ? ' spark-line' : '') + (fresh ? ' draw' : ''), pathLength: 1 }));
    el.appendChild(svg);
  });
}

// Radar: axes [{label, value 0..100, tipRows}], filled polygon, overall score in the middle.
export function radar(el, { axes, score, label }) {
  el.replaceChildren();
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const size = Math.min(width, 300), h = size * 0.86, cx = width / 2, cy = h / 2 + 4, R = size * 0.3;
    const svg = svgEl('svg', { width, height: h, viewBox: `0 0 ${width} ${h}`, role: 'img', 'aria-label': label });
    const ang = i => -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    const at = (i, f) => [cx + R * f * Math.cos(ang(i)), cy + R * f * Math.sin(ang(i))];
    for (const f of [0.25, 0.5, 0.75, 1])
      svg.appendChild(svgEl('polygon', { points: axes.map((_, i) => at(i, f).join(',')).join(' '), class: 'radar-ring' }));
    axes.forEach((_, i) => { const [x, y] = at(i, 1); svg.appendChild(svgEl('line', { x1: cx, y1: cy, x2: x, y2: y, class: 'radar-ring' })); });
    const shape = svgEl('g', { class: fresh ? 'bloom' : '' });
    if (fresh) shape.style.transformOrigin = `${cx}px ${cy}px`;
    shape.appendChild(svgEl('polygon', { points: axes.map((a, i) => at(i, Math.max(0.02, a.value / 100)).join(',')).join(' '), class: 'radar-shape' }));
    axes.forEach((a, i) => { const [x, y] = at(i, a.value / 100); shape.appendChild(svgEl('circle', { cx: x, cy: y, r: 4, class: 'dot radar-dot' })); });
    svg.appendChild(shape);
    axes.forEach((a, i) => {
      const [lx, ly] = at(i, 1.22);
      const g = svgEl('g', { class: 'mark', tabindex: 0 });
      const anchor = Math.abs(lx - cx) < 4 ? 'middle' : lx > cx ? 'start' : 'end';
      const t = svgEl('text', { x: lx, y: ly, class: 'label', 'text-anchor': anchor, 'dominant-baseline': 'middle' });
      t.textContent = a.label;
      const v = svgEl('text', { x: lx, y: ly + 15, class: 'value', 'text-anchor': anchor, 'dominant-baseline': 'middle' });
      v.textContent = Math.round(a.value);
      g.append(svgEl('rect', { x: lx - (anchor === 'end' ? 90 : anchor === 'middle' ? 45 : 0), y: ly - 12, width: 90, height: 34, fill: 'transparent' }), t, v);
      const on = e => { const r = e.type === 'focus' ? g.getBoundingClientRect() : null; showTip(r ? r.left : e.clientX, r ? r.top : e.clientY, a.label, a.tipRows); };
      g.addEventListener('pointermove', on); g.addEventListener('focus', on);
      g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
      svg.appendChild(g);
    });
    if (score !== null && score !== undefined) {
      const s = svgEl('text', { x: cx, y: cy, class: 'radar-score', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      s.textContent = Math.round(score);
      svg.appendChild(s);
    }
    el.appendChild(svg);
  });
}

// Heat cell class for a signed value: pos/neg with intensity 1–4 against a scale.
export function heatClass(v, scale) {
  if (v === null || v === undefined) return 'heat-none';
  if (v === 0 || !scale) return 'heat-zero';
  const q = Math.min(1, Math.abs(v) / scale);
  const step = q > 0.75 ? 4 : q > 0.5 ? 3 : q > 0.25 ? 2 : 1;
  return `heat-${v > 0 ? 'pos' : 'neg'}-${step}`;
}

// Attach the shared tooltip to any HTML element.
export function tipOn(node, title, rows) {
  const on = e => { const r = e.type === 'focus' ? node.getBoundingClientRect() : null; showTip(r ? r.left + r.width / 2 : e.clientX, r ? r.top : e.clientY, title, typeof rows === 'function' ? rows() : rows); };
  node.addEventListener('pointermove', on); node.addEventListener('focus', on);
  node.addEventListener('pointerleave', hideTip); node.addEventListener('blur', hideTip);
}

// Ring split by two amounts (profit factor: gross wins vs gross losses).
export function donut(el, { a, b, label, size = 64 }) {
  el.replaceChildren();
  const sw = Math.max(5, size * 0.1), r = size / 2 - sw / 2 - 1, c = size / 2, C = 2 * Math.PI * r;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': label });
  const total = (a || 0) + (b || 0);
  if (!total) { svg.appendChild(svgEl('circle', { cx: c, cy: c, r, class: 'gauge muted', 'stroke-width': sw })); el.appendChild(svg); return; }
  svg.appendChild(svgEl('circle', { cx: c, cy: c, r, class: 'gauge track', 'stroke-width': sw }));
  const gap = a && b ? sw + 3 : 0;                      // rounded ends need their own room
  const seg = (len, offset, cls, delay) => {
    if (len <= 0) return;
    const p = svgEl('circle', { cx: c, cy: c, r, class: 'gauge ' + cls, 'stroke-width': sw, 'stroke-dasharray': `${Math.max(0.1, len - gap)} ${C}`, 'stroke-dashoffset': -(offset + gap / 2), transform: `rotate(-90 ${c} ${c})` });
    if (!calm()) { p.style.animation = `ringIn .9s cubic-bezier(.2,.8,.2,1) ${delay}ms both`; p.style.setProperty('--len', Math.max(0, len - gap)); p.style.setProperty('--C', C); }
    svg.appendChild(p);
  };
  seg((a / total) * C, 0, 'pos', 0);
  seg((b / total) * C, (a / total) * C, 'neg', 250);
  el.appendChild(svg);
}

// 0–100 meter as a row of LED blocks: one block per 5 points, lit up to the value.
export function meter(el, { value, label }) {
  el.replaceChildren();
  const v = Math.max(0, Math.min(100, value ?? 0)), lit = Math.round(v / 5);
  const wrap = document.createElement('div'); wrap.className = 'meter'; wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-valuemin', '0'); wrap.setAttribute('aria-valuemax', '100'); wrap.setAttribute('aria-valuenow', String(Math.round(v))); wrap.setAttribute('aria-label', label);
  const row = document.createElement('div'); row.className = 'leds';
  for (let i = 0; i < 20; i++) {
    const b = document.createElement('i');
    if (i < lit) { b.className = 'on'; b.style.animationDelay = `${i * 35}ms`; }
    row.appendChild(b);
  }
  const ticks = document.createElement('div'); ticks.className = 'meter-ticks';
  for (const t of [0, 25, 50, 75, 100]) { const s = document.createElement('span'); s.textContent = t; ticks.appendChild(s); }
  wrap.append(row, ticks);
  el.appendChild(wrap);
}

// Scatter of trade P&L against hold time, log time axis, nearest-point hover.
// opts: { points:[{x: ms, y: $, t}], fmtTick, fmtX, tipTitle, tipRows, height }
export function scatterChart(el, opts) {
  const { points, fmtTick, height = 280 } = opts;
  el.replaceChildren();
  if (points.length < 2) { el.innerHTML = '<p class="empty">Not enough trades with a known open time in this range.</p>'; return; }
  responsive(el, (width, fresh) => {
    el.replaceChildren();
    const m = { t: 12, r: 14, b: 30, l: 64 };
    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.label || 'chart' });
    const xs = points.map(p => Math.log10(Math.max(1000, p.x))), ys = points.map(p => p.y);
    const lx0 = Math.min(...xs), lx1 = Math.max(...xs);
    const pad = (lx1 - lx0) * 0.04 || 0.2;
    const x = linear(lx0 - pad, lx1 + pad, m.l, width - m.r);
    const ticks = niceTicks(Math.min(0, ...ys), Math.max(0, ...ys));
    const y = linear(ticks[0], ticks[ticks.length - 1], height - m.b, m.t);
    yAxis(svg, ticks, y, m.l, width - m.r, fmtTick);
    const STEPS = [[1e3, '1s'], [1e4, '10s'], [6e4, '1m'], [3e5, '5m'], [9e5, '15m'], [36e5, '1h'], [144e5, '4h'], [864e5, '1d'], [2592e5, '3d'], [6048e5, '1w'], [2592e6, '30d']];
    const inView = STEPS.filter(([ms]) => { const v = Math.log10(ms); return v >= lx0 - pad && v <= lx1 + pad; });
    const every = Math.max(1, Math.ceil(inView.length / Math.max(2, Math.floor((width - m.l - m.r) / 56))));
    inView.forEach(([ms, lab], i) => {
      if (i % every) return;
      const xx = Math.round(x(Math.log10(ms))) + 0.5;
      svg.appendChild(svgEl('line', { x1: xx, x2: xx, y1: m.t, y2: height - m.b, class: 'grid' }));
      const t = svgEl('text', { x: xx, y: height - 10, class: 'tick', 'text-anchor': 'middle' }); t.textContent = lab; svg.appendChild(t);
    });
    const dots = points.map((p, i) => {
      const c = svgEl('circle', { cx: x(xs[i]), cy: y(p.y), r: 4, class: 'dot ' + (p.y >= 0 ? 'pos' : 'neg') + (fresh ? ' pop-in' : '') });
      if (fresh) c.style.animationDelay = `${Math.min(900, i * 4)}ms`;
      svg.appendChild(c); return c;
    });
    // nearest point within 24px gets the tooltip
    const hit = svgEl('rect', { x: m.l, y: 0, width: width - m.l - m.r, height, fill: 'transparent', tabindex: 0 });
    let on = null;
    const clear = () => { if (on) on.classList.remove('hot'); on = null; hideTip(); };
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let best = -1, bd = 24 * 24;
      points.forEach((p, i) => { const dx = x(xs[i]) - px, dy = y(p.y) - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
      if (best < 0) return clear();
      if (on !== dots[best]) { if (on) on.classList.remove('hot'); on = dots[best]; on.classList.add('hot'); svg.appendChild(on); svg.appendChild(hit); }
      showTip(e.clientX, e.clientY, opts.tipTitle(points[best]), opts.tipRows(points[best]));
    });
    hit.addEventListener('pointerleave', clear);
    svg.appendChild(hit);
    el.appendChild(svg);
  });
}
