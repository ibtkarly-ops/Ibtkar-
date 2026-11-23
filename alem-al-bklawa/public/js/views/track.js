import { html, setHtml, $ } from '../util.js';
import { settings } from '../state.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { clearFieldErrors } from '../ui.js';

export default async function track({ el, setTitle }) {
  setTitle(`تتبّع طلب | ${settings().brand_name_ar}`);
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / تتبّع طلب</div><h1>تتبّع طلبك</h1><p class="lead">أدخل رقم الطلب ورقم الهاتف المستخدم عند الطلب.</p></div>
    <form class="panel form narrow" id="tf" novalidate style="margin-inline:0"><div id="te"></div>
      <div class="field"><label for="tn">رقم الطلب</label><input class="input" id="tn" name="number" placeholder="ABK-1001" dir="ltr" style="text-align:right" required autocomplete="off"></div>
      <div class="field"><label for="tp">رقم الهاتف</label><input class="input" id="tp" name="phone" type="tel" inputmode="tel" dir="ltr" style="text-align:right" required></div>
      <button class="btn btn-primary" type="submit">عرض الطلب</button></form></div>`);
  const f = $('#tf', el);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); clearFieldErrors(f); setHtml($('#te', el), '');
    const btn = f.querySelector('button'); btn.disabled = true;
    try { const r = await api('/api/orders/lookup', { method: 'POST', body: { number: f.number.value, phone: f.phone.value } }); navigate(`/order/${encodeURIComponent(r.order.number)}?t=${r.token}`); }
    catch (err) { setHtml($('#te', el), html`<div class="notice notice-err" role="alert">${err.message}</div>`); btn.disabled = false; }
  });
}
