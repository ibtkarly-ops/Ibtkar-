// Banner slideshow: cross-fades between the banners set in the admin panel.
// Auto-advances every `interval` ms. Pauses on hover/focus/touch, when the tab is hidden, and has a pause button.
// Visitors whose system asks for reduced motion get manual navigation only.
import { html, setHtml, $, $$, icon, raw, prefersReducedMotion } from './util.js';

const isExternal = (u) => /^https?:/i.test(u);

function slide(b, i, n) {
  const first = i === 0;
  return html`<div class="slide ${first ? 'active' : ''}" role="group" aria-roledescription="شريحة" aria-label="${i + 1} من ${n}" ${first ? '' : raw('aria-hidden="true"')}>
    ${b.image ? raw(`<img src="${b.image.replace(/"/g, '')}" alt="" decoding="async" ${first ? 'fetchpriority="high"' : 'fetchpriority="low"'}>`) : ''}
    <div class="slide-shade"></div>
    <div class="slide-copy">${b.title ? html`<h2>${b.title}</h2>` : ''}${b.description ? html`<p>${b.description}</p>` : ''}
      ${b.button_text && b.link ? html`<a class="btn btn-gold" href="${b.link}" ${isExternal(b.link) ? raw('target="_blank" rel="noopener noreferrer"') : ''} ${first ? '' : raw('tabindex="-1"')}>${b.button_text}</a>` : ''}</div>
  </div>`;
}

/** Renders the slideshow into `el` and returns { destroy }. */
export function mountSlider(el, banners, { interval = 2500, brand = '', signal } = {}) {
  const n = banners.length;
  setHtml(el, html`<section class="slider" aria-roledescription="شرائح إعلانية" aria-label="إعلانات ${brand}">
    <div class="slides" aria-live="off">${banners.map((b, i) => slide(b, i, n))}</div>
    ${n > 1 ? html`<button class="sl-btn sl-arrows sl-prev" type="button" aria-label="الشريحة السابقة">${raw('›')}</button><button class="sl-btn sl-arrows sl-next" type="button" aria-label="الشريحة التالية">${raw('‹')}</button>
      <div class="slider-ctl"><button class="sl-btn" type="button" data-pp aria-label="إيقاف التبديل التلقائي" style="width:30px;height:30px;font-size:13px">❚❚</button>${banners.map((_, i) => html`<button class="dot" type="button" data-dot="${i}" aria-label="الشريحة ${i + 1}" aria-current="${i === 0}"></button>`)}</div>` : ''}</section>`);
  const root = $('.slider', el);
  if (n < 2) return { destroy() {} };

  const slides = $$('.slide', root); const dots = $$('[data-dot]', root); const pp = $('[data-pp]', root);
  const reduced = prefersReducedMotion();
  let cur = 0; let timer = null; let userPaused = reduced; let hover = false;

  const show = (i) => {
    cur = (i + n) % n;
    slides.forEach((s, k) => { const on = k === cur; s.classList.toggle('active', on); s.setAttribute('aria-hidden', String(!on)); $$('a', s).forEach((a) => (on ? a.removeAttribute('tabindex') : a.setAttribute('tabindex', '-1'))); });
    dots.forEach((d, k) => d.setAttribute('aria-current', String(k === cur)));
  };
  const stop = () => { clearTimeout(timer); timer = null; };
  const schedule = () => { stop(); if (userPaused || hover || document.hidden) return; timer = setTimeout(() => { show(cur + 1); schedule(); }, interval); };
  const paintPP = () => { pp.textContent = userPaused ? '▶' : '❚❚'; pp.setAttribute('aria-label', userPaused ? 'تشغيل التبديل التلقائي' : 'إيقاف التبديل التلقائي'); };

  root.addEventListener('click', (e) => {
    if (e.target.closest('.sl-prev')) { show(cur - 1); schedule(); }
    else if (e.target.closest('.sl-next')) { show(cur + 1); schedule(); }
    else if (e.target.closest('[data-pp]')) { userPaused = !userPaused; paintPP(); schedule(); }
    else { const d = e.target.closest('[data-dot]'); if (d) { show(Number(d.dataset.dot)); schedule(); } }
  });
  root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hover = true; stop(); } });
  root.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover = false; schedule(); } });
  root.addEventListener('focusin', () => { hover = true; stop(); });
  root.addEventListener('focusout', () => { hover = false; schedule(); });
  let x0 = null;
  root.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  root.addEventListener('pointerup', (e) => { if (x0 === null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 45) { show(cur + (dx < 0 ? 1 : -1)); schedule(); } });
  root.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { show(cur + 1); schedule(); } else if (e.key === 'ArrowRight') { show(cur - 1); schedule(); } });
  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  paintPP(); schedule();

  const destroy = () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  signal?.addEventListener('abort', destroy);
  return { destroy };
}
