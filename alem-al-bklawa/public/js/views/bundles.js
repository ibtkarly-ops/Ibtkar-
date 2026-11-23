import { html, setHtml } from '../util.js';
import { settings } from '../state.js';
import { api } from '../api.js';
import { bundleCard, bindCards, reg, emptyState } from '../components.js';

export default async function bundles({ el, setTitle, signal }) {
  setTitle(`باقات المناسبات | ${settings().brand_name_ar}`);
  const { items } = await api('/api/bundles', { signal });
  reg('bundle', items);
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / باقات المناسبات</div><h1>باقات المناسبات</h1>
    <p class="lead">تشكيلات جاهزة للأفراح والاجتماعات والهدايا. اطلبها من الموقع أو عبر واتساب.</p></div>
    ${items.length ? html`<div class="grid grid-wide">${items.map(bundleCard)}</div>` : emptyState('لا توجد باقات حاليًا', 'ستظهر هنا الباقات فور إضافتها.')}</div>`);
  bindCards(el);
}
