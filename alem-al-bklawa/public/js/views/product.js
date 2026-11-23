import { html, setHtml, money, $, $$, raw } from '../util.js';
import { settings } from '../state.js';
import { api, ApiError } from '../api.js';
import { addToCart } from '../cart.js';
import { toast } from '../ui.js';

export default async function product({ el, params, setTitle, signal }) {
  let p;
  try { p = await api(`/api/products/${Number(params.id)}`, { signal }); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) { setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>المنتج غير موجود</b>ربما لم يعد متوفرًا في المتجر.<div class="mt"><a class="btn btn-primary" href="/shop">تصفح المنتجات</a></div></div></div>`); setTitle(`منتج غير موجود | ${settings().brand_name_ar}`); return; }
    throw e;
  }
  setTitle(`${p.name} | ${settings().brand_name_ar}`);
  const vs = p.variants; let variant = vs.find((v) => v.available) || null; let qty = 1;
  const showCompare = !vs.length && p.compare_price && p.compare_price > p.price;
  setHtml(el, html`<div class="wrap"><div class="crumbs mt"><a href="/">الرئيسية</a> / <a href="/shop">المتجر</a> / <a href="/shop?category=${p.category_slug}">${p.category_name}</a></div>
    <div class="pd">
      <div class="pd-media">${p.image ? raw(`<img src="${p.image}" alt="" decoding="async" fetchpriority="high">`) : html`<span class="sec-eyebrow" style="font-size:20px">${p.category_name}</span>`}</div>
      <div>
        <h1>${p.name}</h1>
        <div class="pd-price" id="price"></div>
        ${p.available ? '' : html`<div class="notice notice-warn">هذا المنتج غير متوفر حاليًا.</div>`}
        ${p.description ? html`<p class="lead pre">${p.description}</p>` : ''}
        ${vs.length ? html`<div class="label" id="vl">اختر الحجم / النوع</div><div class="opts" role="group" aria-labelledby="vl">${vs.map((v) => html`<button class="opt" type="button" data-v="${v.id}" aria-pressed="false" ${v.available ? '' : 'disabled'}>${v.name}<small>${money(v.price)}</small></button>`)}</div>` : ''}
        <div class="row mt" style="gap:16px"><div class="qty"><button type="button" data-q="-1" aria-label="تقليل الكمية">−</button><output id="q" aria-live="polite">1</output><button type="button" data-q="1" aria-label="زيادة الكمية">+</button></div>
          <button class="btn btn-primary" type="button" id="add" style="flex:1;max-width:320px" ${p.available ? '' : 'disabled'}>أضف للسلة</button></div>
      </div></div></div>`);
  const paint = () => {
    const unit = vs.length ? variant?.price : p.price;
    $('#price', el).innerHTML = unit == null ? 'اختر الحجم لعرض السعر' : `${money(unit * qty)}${showCompare ? ` <s>${money(p.compare_price * qty)}</s>` : ''}`;
    $('#q', el).textContent = qty;
    $('#add', el).disabled = !p.available || (vs.length > 0 && !variant);
    $$('[data-v]', el).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === variant?.id)));
  };
  el.addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]'); if (v) { variant = vs.find((x) => x.id === Number(v.dataset.v)); paint(); }
    const q = e.target.closest('[data-q]'); if (q) { qty = Math.min(50, Math.max(1, qty + Number(q.dataset.q))); paint(); }
  });
  $('#add', el).addEventListener('click', () => {
    if (vs.length && !variant) { toast('اختر الحجم أولًا', 'err'); return; }
    addToCart({ type: 'product', id: p.id, variantId: variant?.id || null, name: p.name, variantName: variant?.name || null, price: variant?.price ?? p.price, image: p.image }, qty);
  });
  paint();
}
