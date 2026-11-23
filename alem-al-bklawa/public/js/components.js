// Shared storefront components: product / bundle / branch cards, product picker, catalog (chips + grid).
import { api, isAbort } from './api.js';
import { html, setHtml, money, icon, raw, $, $$, displayPhone, telLink, waLink, tiktokIcon } from './util.js';
import { state } from './state.js';
import { addToCart } from './cart.js';
import { openModal, toast } from './ui.js';

const registry = { product: new Map(), bundle: new Map() };
export const reg = (type, list) => list.forEach((x) => registry[type].set(x.id, x));
const slug = (s) => encodeURIComponent(String(s).trim().replace(/\s+/g, '-').slice(0, 60));
export const productUrl = (p) => `/product/${p.id}/${slug(p.name)}`;
export const bundleUrl = (b) => `/bundle/${b.id}/${slug(b.name)}`;

export function productCard(p) {
  const hasVar = p.variants?.length > 0;
  const showCompare = !hasVar && p.compare_price && p.compare_price > p.price;
  return html`<article class="card ${p.available ? '' : 'is-out'}">
    ${p.available ? '' : html`<span class="tag">غير متوفر</span>`}
    ${p.image
      ? html`<a class="card-media" href="${productUrl(p)}" tabindex="-1" aria-hidden="true"><img src="${p.image}" alt="" loading="lazy" decoding="async" width="400" height="300"></a>`
      : html`<a class="card-txt" href="${productUrl(p)}" tabindex="-1" aria-hidden="true"><span class="cat">${p.category_name}</span></a>`}
    <div class="card-body">
      <h3 class="card-name"><a href="${productUrl(p)}">${p.name}</a></h3>
      ${p.description ? html`<p class="card-desc">${p.description}</p>` : ''}
      <div class="card-foot">
        <span class="price">${hasVar ? html`<small>ابتداءً من</small>` : ''}${money(p.price_from ?? p.price)}${showCompare ? html`<s>${money(p.compare_price)}</s>` : ''}</span>
        <button class="btn btn-primary" type="button" data-pick="${p.id}" ${p.available ? '' : 'disabled'}>${p.available ? (hasVar ? 'اختر الحجم' : 'أضف للسلة') : 'غير متوفر'}</button>
      </div>
    </div>
  </article>`;
}

export function bundleCard(b) {
  const first = b.items.slice(0, 3);
  return html`<article class="card bcard ${b.available ? '' : 'is-out'}">
    ${b.available ? '' : html`<span class="tag">غير متوفرة</span>`}
    ${b.image ? html`<a class="card-media" href="${bundleUrl(b)}" tabindex="-1" aria-hidden="true"><img src="${b.image}" alt="" loading="lazy" decoding="async" width="400" height="300"></a>` : ''}
    <div class="card-body">
      <span class="eyebrow">باقة مناسبات</span>
      <h3 class="card-name"><a href="${bundleUrl(b)}">${b.name}</a></h3>
      ${b.description ? html`<p class="card-desc">${b.description}</p>` : ''}
      ${first.length ? html`<ul class="bcard-items">${first.map((i) => html`<li>${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.label}</li>`)}${b.items.length > 3 ? html`<li>و${b.items.length - 3} أصناف أخرى</li>` : ''}</ul>` : ''}
      <div class="card-foot"><span class="price">${money(b.price)}</span>
        <span class="row" style="gap:6px"><a class="btn btn-ghost" href="${bundleUrl(b)}">التفاصيل</a>
        <button class="btn btn-primary" type="button" data-bundle-add="${b.id}" ${b.available ? '' : 'disabled'}>أضف للسلة</button></span></div>
    </div>
  </article>`;
}

export function branchCard(b) {
  const phone = b.phone ? displayPhone(b.phone) : '';
  const wa = b.whatsapp;
  return html`<article class="branch">
    <h3>${icon('pin')}${b.name}</h3>
    <dl>
      <div><dt>العنوان</dt><dd>${b.address || html`<span class="pending">سيُضاف العنوان قريبًا</span>`}</dd></div>
      <div><dt>الهاتف</dt><dd>${phone ? html`<bdi dir="ltr">${phone}</bdi>` : html`<span class="pending">غير متوفر حاليًا</span>`}</dd></div>
      ${b.hours ? html`<div><dt>ساعات العمل</dt><dd>${b.hours}</dd></div>` : ''}
    </dl>
    <div class="branch-actions">
      ${b.phone ? html`<a class="btn btn-primary btn-sm" href="${telLink(b.phone)}">${icon('phone')} اتصال</a>` : ''}
      ${b.maps_url ? html`<a class="btn btn-ghost btn-sm" href="${b.maps_url}" target="_blank" rel="noopener noreferrer">${icon('pin')} الاتجاهات</a>` : ''}
      ${wa ? html`<a class="btn btn-ghost btn-sm" href="${waLink(wa)}" target="_blank" rel="noopener noreferrer">${icon('chat')} واتساب</a>` : ''}
    </div>
  </article>`;
}

export const skeletons = (n = 8) => html`${Array.from({ length: n }, () => html`<div class="skel" aria-hidden="true"></div>`)}`;
export const emptyState = (title, text = '') => html`<div class="empty"><b>${title}</b>${text}</div>`;

// ── Product picker (variants + quantity) ───────────────────────────────────
export function openProductPicker(p) {
  const vs = p.variants || [];
  let variant = vs.find((v) => v.available) || null; let qty = 1;
  const { el, close } = openModal(p.name, html`
    ${p.description ? html`<p class="card-desc" style="-webkit-line-clamp:4">${p.description}</p>` : ''}
    ${vs.length ? html`<div class="label" id="vl">اختر الحجم / النوع</div><div class="opts" role="group" aria-labelledby="vl">${vs.map((v) => html`<button type="button" class="opt" data-v="${v.id}" aria-pressed="${variant?.id === v.id}" ${v.available ? '' : 'disabled'}>${v.name}<small>${money(v.price)}</small></button>`)}</div>` : ''}
    <div class="row mt" style="justify-content:space-between"><div class="qty"><button type="button" data-q="-1" aria-label="تقليل">−</button><output id="q">1</output><button type="button" data-q="1" aria-label="زيادة">+</button></div><b class="price" id="pp"></b></div>
    <button class="btn btn-primary btn-block mt" type="button" id="padd">أضف للسلة</button>`);
  const price = () => (vs.length ? variant?.price ?? 0 : p.price) * qty;
  const paint = () => { $('#q', el).textContent = qty; $('#pp', el).textContent = money(price()); $('#padd', el).disabled = vs.length > 0 && !variant; $$('[data-v]', el).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === variant?.id))); };
  el.addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]'); if (v) { variant = vs.find((x) => x.id === Number(v.dataset.v)); paint(); }
    const q = e.target.closest('[data-q]'); if (q) { qty = Math.min(50, Math.max(1, qty + Number(q.dataset.q))); paint(); }
  });
  $('#padd', el).addEventListener('click', () => {
    addToCart({ type: 'product', id: p.id, variantId: variant?.id || null, name: p.name, variantName: variant?.name || null, price: variant?.price ?? p.price, image: p.image }, qty);
    close();
  });
  paint();
}

/** Delegated clicks for cards inside a container. */
export function bindCards(container) {
  container.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const p = registry.product.get(Number(pick.dataset.pick)); if (!p) return;
      if (p.variants?.length) openProductPicker(p);
      else addToCart({ type: 'product', id: p.id, variantId: null, name: p.name, price: p.price, image: p.image });
      return;
    }
    const ba = e.target.closest('[data-bundle-add]');
    if (ba) {
      const b = registry.bundle.get(Number(ba.dataset.bundleAdd)); if (!b) return;
      addToCart({ type: 'bundle', id: b.id, variantId: null, name: b.name, price: b.price, image: b.image, maxQty: b.max_qty });
    }
  });
}

// ── Catalog: category chips (text only) + grid, no page reloads ────────────
export function mountCatalog(el, { limit = 12, initial = 'all', syncUrl = false, moreLink = false } = {}) {
  const cats = state.boot.categories;
  let active = cats.some((c) => c.slug === initial) ? initial : 'all';
  let ctl = null; let items = []; let total = 0; let bundlesShown = false;
  setHtml(el, html`
    <div class="chips" role="group" aria-label="أقسام المتجر">
      <button class="chip" type="button" data-cat="all" aria-pressed="${active === 'all'}">الكل</button>
      ${cats.map((c) => html`<button class="chip" type="button" data-cat="${c.slug}" aria-pressed="${active === c.slug}">${c.name}</button>`)}
    </div>
    <div data-grid aria-live="polite"></div>
    <div class="center mt" data-more></div>`);
  const grid = $('[data-grid]', el); const more = $('[data-more]', el);
  bindCards(el);

  async function load(reset) {
    ctl?.abort(); ctl = new AbortController(); const sig = ctl.signal;
    const cat = cats.find((c) => c.slug === active);
    if (reset) { items = []; total = 0; bundlesShown = false; setHtml(grid, html`<div class="grid">${skeletons(Math.min(limit, 8))}</div>`); setHtml(more, ''); }
    try {
      let out = '';
      if (cat?.kind === 'bundles') {
        const { items: bs } = await api('/api/bundles', { signal: sig }); reg('bundle', bs);
        setHtml(grid, bs.length ? html`<div class="grid grid-wide fade">${bs.map(bundleCard)}</div>` : emptyState('لا توجد باقات حاليًا', 'سنضيف باقات جديدة قريبًا.'));
        if (bs.length && moreLink) setHtml(more, html`<a class="btn btn-ghost" href="/bundles">كل الباقات</a>`);
        return;
      }
      const res = await api(`/api/products?category=${encodeURIComponent(active)}&limit=${limit}&offset=${items.length}`, { signal: sig });
      reg('product', res.items); items = items.concat(res.items); total = res.total;
      out = items.map(productCard);
      let extra = '';
      if (active === 'all' && items.length >= total) {
        const { items: bs } = await api('/api/bundles', { signal: sig }); reg('bundle', bs); bundlesShown = bs.length > 0;
        if (bs.length) extra = html`<h3 class="mt2">باقات المناسبات</h3><div class="grid grid-wide">${bs.map(bundleCard)}</div>`;
      }
      if (!items.length && !bundlesShown) setHtml(grid, emptyState(active === 'all' ? 'لا توجد منتجات بعد' : 'لا توجد منتجات في هذا القسم حاليًا', 'يمكنك تجربة قسم آخر أو العودة لاحقًا.'));
      else setHtml(grid, html`${items.length ? html`<div class="grid fade">${out}</div>` : ''}${extra}`);
      if (items.length < total) setHtml(more, html`<button class="btn btn-ghost" type="button" data-loadmore>عرض المزيد</button>`);
      else if (moreLink && items.length) setHtml(more, html`<a class="btn btn-ghost" href="/shop${active === 'all' ? '' : `?category=${active}`}">عرض كل المنتجات</a>`);
      else setHtml(more, '');
    } catch (e) {
      if (isAbort(e)) return;
      setHtml(grid, html`<div class="empty"><b>تعذّر تحميل المنتجات</b>${e.message}<div class="mt"><button class="btn btn-primary" type="button" data-retry>إعادة المحاولة</button></div></div>`);
    }
  }

  el.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (chip && chip.dataset.cat !== active) {
      active = chip.dataset.cat;
      $$('[data-cat]', el).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.cat === active)));
      if (syncUrl) history.replaceState(history.state, '', active === 'all' ? location.pathname : `${location.pathname}?category=${active}`);
      load(true);
    }
    if (e.target.closest('[data-loadmore]')) load(false);
    if (e.target.closest('[data-retry]')) load(true);
  });
  const ready = load(true);
  return { destroy: () => ctl?.abort(), ready };
}

// ── Section heading + contact cards (home & about) ─────────────────────────
export const sectionHead = (eyebrow, title, href, linkText) => html`<div class="sec-head"><div><div class="sec-eyebrow">${eyebrow}</div><h2 class="sec-title">${title}</h2></div>${href ? html`<a class="link-more" href="${href}">${linkText} ←</a>` : ''}</div>`;

export function contactCards(s, main) {
  return html`<div class="contact-grid">
    <div class="contact-card"><h3>دعم العملاء</h3><div class="num"><bdi dir="ltr">${displayPhone(s.support_phone)}</bdi></div>
      <div class="row"><a class="btn btn-primary btn-sm" href="${telLink(s.support_phone)}">${icon('phone')} اتصال</a>
      <a class="btn btn-ghost btn-sm" href="${waLink(s.support_whatsapp)}" target="_blank" rel="noopener noreferrer">${icon('chat')} واتساب</a></div></div>
    ${main?.phone ? html`<div class="contact-card"><h3>فرع ${main.name}</h3><div class="num"><bdi dir="ltr">${displayPhone(main.phone)}</bdi></div>
      <div class="row"><a class="btn btn-primary btn-sm" href="${telLink(main.phone)}">${icon('phone')} اتصال</a>
      ${main.whatsapp ? html`<a class="btn btn-ghost btn-sm" href="${waLink(main.whatsapp)}" target="_blank" rel="noopener noreferrer">${icon('chat')} واتساب</a>` : ''}</div></div>` : ''}
    ${s.tiktok_url ? html`<div class="contact-card"><h3>تيك توك</h3><div class="num" style="direction:ltr">@${s.tiktok_handle}</div>
      <div class="row"><a class="btn btn-ghost btn-sm" href="${s.tiktok_url}" target="_blank" rel="noopener noreferrer">${tiktokIcon()} تابعنا</a></div></div>` : ''}
  </div>`;
}
