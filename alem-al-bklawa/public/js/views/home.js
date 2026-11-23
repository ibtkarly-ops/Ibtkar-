import { html, setHtml, $, raw } from '../util.js';
import { state, settings, mainBranch } from '../state.js';
import { api } from '../api.js';
import { mountCatalog, bundleCard, branchCard, sectionHead, contactCards, bindCards, reg } from '../components.js';
import { reveal } from '../ui.js';
import { mountSlider } from '../slider.js';

// With banners: a slideshow (images/text set in the admin panel). Without: the plain intro from settings.
function intro() {
  const s = settings();
  return html`<section class="wrap" aria-label="مقدمة"><div class="hero no-img"><div class="hero-in"><div><div class="hero-eyebrow">${s.brand_name_en}</div><h1>${s.hero_title}</h1>${s.hero_text ? html`<p>${s.hero_text}</p>` : ''}
    <div class="hero-actions">${s.hero_button_text && s.hero_button_link ? html`<a class="btn btn-gold" href="${s.hero_button_link}">${s.hero_button_text}</a>` : ''}<a class="btn btn-outline-light" href="/bundles">باقات المناسبات</a></div></div></div></div></section>`;
}

export default async function home({ el, setTitle, signal }) {
  const s = settings();
  setTitle(`${s.brand_name_ar} | ${s.tagline}`);
  const sections = (s.home_sections || []).filter((x) => x.enabled);
  const slots = {};
  setHtml(el, html`${sections.map((x) => (x.key === 'hero' ? (state.boot.banners.length ? html`<section class="wrap" data-slider><h1 class="sr">${s.brand_name_ar}</h1><div data-slider-box></div></section>` : intro()) : html`<section class="section wrap reveal" id="sec-${x.key}" data-slot="${x.key}"></section>`))}`);
  const sliderBox = $('[data-slider-box]', el);
  if (sliderBox) mountSlider(sliderBox, state.boot.banners, { interval: s.banner_interval_ms || 2500, brand: s.brand_name_ar, signal });
  let ready = Promise.resolve();
  for (const { key } of sections) {
    const slot = $(`[data-slot="${key}"]`, el); if (!slot) continue; slots[key] = slot;
    if (key === 'products') {
      setHtml(slot, html`${sectionHead('تسوّق', 'منتجاتنا')}<div data-catalog></div>`);
      ready = mountCatalog($('[data-catalog]', slot), { limit: 8, moreLink: true }).ready;
    } else if (key === 'bundles') {
      api('/api/bundles').then(({ items }) => {
        if (!items.length) { slot.remove(); return; }
        reg('bundle', items);
        setHtml(slot, html`${sectionHead('للمناسبات', 'باقات المناسبات', '/bundles', 'كل الباقات')}<div class="grid grid-wide">${items.slice(0, 3).map(bundleCard)}</div>`);
        bindCards(slot); reveal(slot);
      }).catch(() => slot.remove());
    } else if (key === 'branches') {
      setHtml(slot, html`${sectionHead('تفضّل بزيارتنا', 'فروعنا', '/branches', 'تفاصيل الفروع')}<div class="bgrid">${state.boot.branches.map(branchCard)}</div>`);
    } else if (key === 'about') {
      setHtml(slot, html`<div class="about-card"><div class="sec-eyebrow" style="color:var(--gold)">${s.brand_name_en}</div><h2>${s.about_title}</h2><p>${s.about_text}</p><a class="btn btn-gold" href="/about">اعرف المزيد</a></div>`);
    } else if (key === 'contact') {
      setHtml(slot, html`${sectionHead('نسعد بخدمتك', 'تواصل معنا')}${contactCards(s, mainBranch())}`);
    }
  }
  reveal(el);
  await Promise.race([ready, new Promise((r) => setTimeout(r, 6000))]);
}
