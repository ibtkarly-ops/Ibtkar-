import { html, setHtml } from '../util.js';
import { settings } from '../state.js';

const PAGES = { '/privacy': ['سياسة الخصوصية', 'privacy_text'], '/terms': ['شروط الاستخدام', 'terms_text'], '/rights': ['حقوق العملاء', 'rights_text'] };

export default async function policy({ el, path, setTitle }) {
  const s = settings(); const [title, key] = PAGES[path.replace(/\/$/, '')] || PAGES['/privacy'];
  setTitle(`${title} | ${s.brand_name_ar}`);
  const paras = String(s[key] || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / ${title}</div><h1>${title}</h1></div>
    <div class="panel narrow" style="max-width:760px;margin-inline:0">${paras.length ? paras.map((p) => html`<p>${p}</p>`) : html`<p>لم تُضف هذه الصفحة بعد.</p>`}</div></div>`);
}
