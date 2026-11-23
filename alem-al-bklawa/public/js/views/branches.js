import { html, setHtml } from '../util.js';
import { settings } from '../state.js';
import { api } from '../api.js';
import { branchCard, emptyState } from '../components.js';

export default async function branches({ el, setTitle, signal }) {
  setTitle(`فروعنا | ${settings().brand_name_ar}`);
  const { items } = await api('/api/branches', { signal });
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / الفروع</div><h1>فروعنا</h1>
    <p class="lead">اختر أقرب فرع إليك. تظهر أزرار الاتصال والاتجاهات عند توفر بيانات الفرع.</p></div>
    ${items.length ? html`<div class="bgrid">${items.map(branchCard)}</div>` : emptyState('لا توجد فروع معروضة حاليًا')}</div>`);
}
