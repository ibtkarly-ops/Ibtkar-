import { html, setHtml } from '../util.js';
import { settings } from '../state.js';

export default async function notFound({ el, setTitle }) {
  setTitle(`الصفحة غير موجودة | ${settings().brand_name_ar}`);
  setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>الصفحة غير موجودة</b>ربما تغيّر الرابط أو لم تعد الصفحة متاحة.
    <div class="row mt" style="justify-content:center"><a class="btn btn-primary" href="/">الرئيسية</a><a class="btn btn-ghost" href="/shop">المتجر</a></div></div></div>`);
}
