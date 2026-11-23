import { html, setHtml, $ } from '../util.js';
import { settings } from '../state.js';
import { api } from '../api.js';
import { mountCatalog, productCard, bundleCard, bindCards, reg, emptyState, skeletons } from '../components.js';

export default async function shop({ el, query, setTitle, signal }) {
  const brand = settings().brand_name_ar;
  const q = (query.get('q') || '').trim();

  if (q) {
    setTitle(`نتائج البحث: ${q} | ${brand}`);
    setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / <a href="/shop">المتجر</a></div><h1>نتائج البحث عن «${q}»</h1></div><div data-res class="grid">${skeletons(4)}</div></div>`);
    const out = $('[data-res]', el);
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=40`, { signal });
    reg('product', r.products); reg('bundle', r.bundles);
    if (!r.products.length && !r.bundles.length && !r.categories.length) {
      out.className = '';
      setHtml(out, emptyState(`لا توجد نتائج لـ «${q}»`, 'تأكد من كتابة الكلمة، أو جرّب اسمًا آخر أو تصفح الأقسام.'));
      out.insertAdjacentHTML('beforeend', '<p class="center mt"><a class="btn btn-primary" href="/shop">تصفح كل المنتجات</a></p>');
      return;
    }
    out.className = '';
    setHtml(out, html`${r.categories.length ? html`<div class="row" style="margin-bottom:14px">${r.categories.map((c) => html`<a class="chip" style="display:inline-flex;align-items:center;text-decoration:none" href="${c.kind === 'bundles' ? '/bundles' : `/shop?category=${c.slug}`}">${c.name}</a>`)}</div>` : ''}
      ${r.products.length ? html`<div class="grid">${r.products.map(productCard)}</div>` : ''}
      ${r.bundles.length ? html`<h2 class="mt2">باقات المناسبات</h2><div class="grid grid-wide">${r.bundles.map(bundleCard)}</div>` : ''}`);
    bindCards(out);
    return;
  }

  setTitle(`المتجر | ${brand}`);
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / المتجر</div><h1>المتجر</h1></div><div data-catalog></div></div>`);
  await mountCatalog($('[data-catalog]', el), { limit: 12, initial: query.get('category') || 'all', syncUrl: true }).ready;
}
