// Tooltips everywhere, fast. Native `title` tooltips wait about a second and can't be sped up, so on
// hover an element's title moves to data-ttl (no native one) and this shows it in the app's style after
// a short pause. It's a popover, so it sits above open dialogs (the chart replay) as well.
const DELAY = 120;
let box = null, cur = null, timer = null, last = { x: 0, y: 0 };

function el() {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'tip tip-text'; box.setAttribute('popover', 'manual'); box.setAttribute('role', 'tooltip');
  document.body.appendChild(box);
  return box;
}
const textOf = n => n.dataset.ttl || '';
// Light formatting, from the plain text every title already has (built as nodes, never as HTML):
// • a blank line starts a new section; each line keeps its break; "• " lines are a list
// • a short label before the first ": " of a line is bold ("⚔️ Killzone:", "Why it matters:", "Record:")
// • **bold** is bold; R values are coloured: +0.66R green, −0.38R red
const LABEL = /^([^:\n]{1,72}?):\s/, INLINE = /(\*\*[^*]+\*\*|[+−-]\d+(?:\.\d+)?R\b)/g;
function inline(line, into) {
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) into.append(line.slice(last, m.index));
    const x = m[0], e = document.createElement(x.startsWith('**') ? 'b' : 'span');
    if (x.startsWith('**')) e.textContent = x.slice(2, -2);
    else { e.textContent = x; e.className = x[0] === '+' ? 'tt-pos' : 'tt-neg'; }
    into.append(e); last = m.index + x.length;
  }
  if (last < line.length) into.append(line.slice(last));
}
function render(text, into) {
  into.replaceChildren();
  for (const block of text.split(/\n\s*\n/)) {
    const b = document.createElement('div'); b.className = 'tt-block';
    for (let line of block.split('\n')) {
      if (!line.trim()) continue;
      const d = document.createElement('div'); d.className = 'tt-line';
      if (/^\s*[•·-]\s/.test(line)) { d.classList.add('tt-bullet'); line = line.replace(/^\s*[•·-]\s/, ''); }
      const m = line.match(LABEL);
      // a label: short, and not a sentence that happens to contain a colon
      if (m && m[1].split(' ').length <= 10) { const l = document.createElement('b'); l.className = 'tt-lab'; l.textContent = m[1] + ':'; d.append(l, ' '); line = line.slice(m[0].length); }
      inline(line, d);
      b.append(d);
    }
    if (b.childElementCount) into.append(b);
  }
}
function place() {
  const b = el(), pad = 14, w = b.offsetWidth, h = b.offsetHeight;
  let x = last.x + pad, y = last.y + pad + 4;
  if (x + w > innerWidth - 8) x = Math.max(8, last.x - w - pad);
  if (y + h > innerHeight - 8) y = Math.max(8, last.y - h - pad);
  b.style.left = x + 'px'; b.style.top = y + 'px';
}
function show(n) {
  const t = textOf(n); if (!t) return;
  const b = el();
  render(t, b);
  try { if (b.matches(':popover-open')) b.hidePopover(); b.showPopover(); } catch { b.style.display = 'block'; }   // re-show: back on top of a dialog opened since
  place();
}
function hide() {
  clearTimeout(timer); timer = null; cur = null;
  if (box) { try { box.hidePopover(); } catch { box.style.display = ''; } }
}
// take over the title: keep the text, drop the native tooltip
function adopt(n) { if (n.hasAttribute('title')) { const t = n.getAttribute('title'); n.removeAttribute('title'); if (t) n.dataset.ttl = t; else delete n.dataset.ttl; } }

document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch') return;
  const n = e.target.closest?.('[title], [data-ttl]');
  if (n === cur) return;
  hide();
  if (!n) return;
  // the parents' titles too, or the browser shows theirs on top of this one (a tag inside a titled row)
  for (let a = n; a && a !== document.body; a = a.parentElement) adopt(a);
  if (!textOf(n)) return;
  cur = n; last = { x: e.clientX, y: e.clientY };
  timer = setTimeout(() => { timer = null; if (cur === n) show(n); }, DELAY);
}, true);
document.addEventListener('pointermove', e => { if (!cur) return; last = { x: e.clientX, y: e.clientY }; if (!timer && box) place(); }, { passive: true });
document.addEventListener('pointerout', e => { if (cur && !cur.contains(e.relatedTarget)) hide(); }, true);
for (const ev of ['pointerdown', 'keydown', 'scroll', 'blur']) addEventListener(ev, hide, { capture: true, passive: true });
