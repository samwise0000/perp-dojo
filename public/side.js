// The left sidebar folds into a slim rail: icons only, the current view written
// down the middle, and a round chevron button that turns as it folds. The choice
// is remembered in this browser; "[" toggles it too. Phones keep the top bar.
const KEY = 'perp-dojo:side-collapsed';
const app = document.querySelector('.app'), side = document.querySelector('.side'), nav = side?.querySelector('.nav');

if (app && side && nav) {
  // wrap each label's text so it can fade and slide on its own
  for (const b of side.querySelectorAll('.nav button, .side-btn')) {
    for (const n of [...b.childNodes]) if (n.nodeType === 3 && n.textContent.trim()) { const s = document.createElement('span'); s.className = 'nav-label'; s.textContent = n.textContent.trim(); n.replaceWith(s); }
    const label = b.querySelector('.nav-label')?.textContent || '';
    b.dataset.tip = label; if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', label);
  }
  side.querySelectorAll('.nav button').forEach((b, i) => b.style.setProperty('--n', i));

  // the toggle: a ring with a chevron that turns, and a ripple on each press
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'side-toggle';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="st-ring" cx="12" cy="12" r="10.5"/><path class="st-chev a" d="M13.5 7.5 9 12l4.5 4.5"/><path class="st-chev b" d="M17.5 7.5 13 12l4.5 4.5"/></svg>';
  // it rides the sidebar's right edge, half over the border, and follows it as it folds
  document.body.append(btn);
  const place = () => { const r = side.getBoundingClientRect(); if (!r.width) return; btn.style.left = `${r.right - 15}px`; btn.style.top = `${r.top + 47}px`; };   // just above the first nav item
  new ResizeObserver(place).observe(side);
  addEventListener('resize', place); addEventListener('scroll', place, { passive: true });
  place();

  // the current view, written down the rail when folded
  const vert = document.createElement('div');
  vert.className = 'side-vert'; vert.setAttribute('aria-hidden', 'true');
  nav.after(vert);
  const setVert = () => { const cur = nav.querySelector('[aria-current="page"] .nav-label')?.textContent || 'Dashboard'; vert.innerHTML = `<i>✦</i><b>${cur}</b>`; };
  setVert();
  new MutationObserver(setVert).observe(nav, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });

  const apply = (on, animate = true) => {
    app.classList.toggle('side-folded', on);
    btn.classList.toggle('folded', on);
    btn.setAttribute('aria-expanded', String(!on));
    btn.setAttribute('aria-label', on ? 'Expand the sidebar' : 'Collapse the sidebar');
    btn.title = on ? 'Expand ( [ )' : 'Collapse ( [ )';
    if (animate) { btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse'); app.classList.add('side-anim'); clearTimeout(apply.t); apply.t = setTimeout(() => app.classList.remove('side-anim'), 650); }
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
  };
  let folded = false;
  try { folded = localStorage.getItem(KEY) === '1'; } catch {}
  // no slide on load: set the remembered state with transitions off
  app.classList.add('side-instant');
  apply(folded, false);
  void app.offsetWidth;
  requestAnimationFrame(() => app.classList.remove('side-instant'));
  btn.addEventListener('click', () => apply(!app.classList.contains('side-folded')));
  addEventListener('keydown', e => {
    if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable) return;
    apply(!app.classList.contains('side-folded'));
  });
}
