// Page chrome: header, menu drawer, cart drawer container, footer. Search overlay.
import { html, setHtml, icon, tiktokIcon, logoDisc, displayPhone, telLink, waLink, money, $, $$, debounce, raw } from './util.js';
import { state, settings, on, mainBranch } from './state.js';
import { cart, openCart, mountCartDrawer } from './cart.js';
import { lockScroll, trapFocus } from './ui.js';
import { api, isAbort } from './api.js';
import { navigate } from './router.js';
import { productUrl, bundleUrl } from './components.js';

export const NAV = [['/', 'الرئيسية'], ['/shop', 'المتجر'], ['/bundles', 'باقات المناسبات'], ['/branches', 'الفروع'], ['/about', 'من نحن']];

function header() {
  const s = settings();
  return html`<header class="site-header"><div class="wrap hdr">
    <button class="icon-btn burger" type="button" id="open-menu" aria-label="القائمة" aria-controls="menu-drawer">${icon('menu')}</button>
    <a class="brand" href="/" aria-label="${s.brand_name_ar} — الصفحة الرئيسية">${logoDisc(s, 44)}<span>${s.brand_name_ar}</span></a>
    <nav class="nav" aria-label="التنقل الرئيسي">${NAV.map(([h, t]) => html`<a href="${h}" data-nav="${h}">${t}</a>`)}</nav>
    <div class="hdr-actions">
      <button class="icon-btn" type="button" id="open-search" aria-label="بحث">${icon('search')}</button>
      <a class="icon-btn" href="/account" id="acct-link" aria-label="حسابي">${icon('user')}</a>
      <button class="icon-btn" type="button" id="open-cart" aria-label="سلة المشتريات">${icon('bag')}<span class="badge" id="cart-badge" hidden>0</span></button>
    </div></div></header>`;
}

function footer() {
  const s = settings(); const b = state.boot; const main = mainBranch();
  return html`<footer class="site-footer"><div class="wrap">
    <div class="ft">
      <div><a class="brand" href="/">${logoDisc(s, 54)}<span>${s.brand_name_ar}</span></a><p>${s.tagline}</p>
        ${s.tiktok_url ? html`<a class="tiktok" href="${s.tiktok_url}" target="_blank" rel="noopener noreferrer">${tiktokIcon()}<span>تيك توك @${s.tiktok_handle}</span></a>` : ''}</div>
      <div><h3>الصفحات</h3><ul>${NAV.map(([h, t]) => html`<li><a href="${h}">${t}</a></li>`)}<li><a href="/track">تتبع طلب</a></li></ul></div>
      <div><h3>الأقسام</h3><ul>${b.categories.map((c) => html`<li><a href="${c.kind === 'bundles' ? '/bundles' : `/shop?category=${c.slug}`}">${c.name}</a></li>`)}</ul>
        <h3 style="margin-top:14px">الفروع</h3><ul>${b.branches.map((x) => html`<li><a href="/branches">${x.name}</a></li>`)}</ul></div>
      <div><h3>تواصل معنا</h3><ul>
        ${s.support_phone ? html`<li>دعم العملاء: <a href="${telLink(s.support_phone)}"><bdi dir="ltr">${displayPhone(s.support_phone)}</bdi></a></li>` : ''}
        ${s.support_whatsapp ? html`<li><a href="${waLink(s.support_whatsapp)}" target="_blank" rel="noopener noreferrer">واتساب الدعم</a></li>` : ''}
        ${main?.phone ? html`<li>فرع ${main.name}: <a href="${telLink(main.phone)}"><bdi dir="ltr">${displayPhone(main.phone)}</bdi></a></li>` : ''}
        <li><a href="/privacy">سياسة الخصوصية</a></li><li><a href="/terms">شروط الاستخدام</a></li><li><a href="/rights">حقوق العملاء</a></li></ul></div>
    </div>
    <div class="ft-bottom"><span>© ${new Date().getFullYear()} ${s.brand_name_ar}. جميع الحقوق محفوظة.</span><span class="made">صنع بواسطة ابتكار</span></div>
  </div></footer>`;
}

let menuRelease;
function menuDrawer() {
  return html`<div class="overlay" id="menu-overlay" hidden></div>
  <aside class="drawer drawer-menu" id="menu-drawer" aria-hidden="true" aria-label="القائمة">
    <div class="drawer-head"><h2>${settings().brand_name_ar}</h2><button class="icon-btn" type="button" data-close-menu aria-label="إغلاق القائمة">${icon('x')}</button></div>
    <div class="drawer-body"><nav class="menu-links" aria-label="القائمة">${NAV.map(([h, t]) => html`<a href="${h}" data-nav="${h}">${t}</a>`)}<a href="/track">تتبع طلب</a><a href="/account" data-account>حسابي</a></nav></div>
  </aside>
  <div class="overlay" id="cart-overlay" hidden></div>
  <aside class="drawer drawer-cart" id="cart-drawer" aria-hidden="true" aria-label="سلة المشتريات">
    <div class="drawer-head"><h2>سلة المشتريات</h2><button class="icon-btn" type="button" data-close-cart aria-label="إغلاق السلة">${icon('x')}</button></div>
    <div class="drawer-body"></div><div class="drawer-foot"></div>
  </aside>`;
}

function setMenu(open) {
  const d = $('#menu-drawer'); const o = $('#menu-overlay');
  if (open === d.classList.contains('open')) return;
  d.classList.toggle('open', open); o.hidden = !open; d.setAttribute('aria-hidden', String(!open)); lockScroll(open);
  if (open) menuRelease = trapFocus(d, () => setMenu(false)); else menuRelease?.();
}

export function mountShell(root) {
  setHtml(root, html`${header()}<main id="main" tabindex="-1"></main>${footer()}${menuDrawer()}`);
  mountCartDrawer();
  $('#open-menu').addEventListener('click', () => setMenu(true));
  $('#menu-overlay').addEventListener('click', () => setMenu(false));
  $('[data-close-menu]').addEventListener('click', () => setMenu(false));
  $('#menu-drawer').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  $('#open-cart').addEventListener('click', openCart);
  $('#open-search').addEventListener('click', openSearch);

  const badge = $('#cart-badge');
  const paintCart = () => { const n = cart.count(); badge.textContent = n > 99 ? '99+' : n; badge.hidden = n === 0; $('#open-cart').setAttribute('aria-label', `سلة المشتريات، ${n} منتج`); };
  on('cart', paintCart); paintCart();
  const paintUser = () => { const u = state.user; const a = $('#acct-link'); a.setAttribute('aria-label', u ? `حسابي (${u.name})` : 'تسجيل الدخول'); a.href = u ? '/account' : '/login'; $('[data-account]').textContent = u ? 'حسابي' : 'تسجيل الدخول'; $('[data-account]').href = a.href; };
  on('user', paintUser); paintUser();
  on('navigate', (path) => $$('[data-nav]').forEach((a) => { const h = a.dataset.nav; if (h === '/' ? path === '/' : path.startsWith(h)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }));
  return $('#main');
}

// ── Search overlay ─────────────────────────────────────────────────────────
function openSearch() {
  const box = document.createElement('div');
  box.className = 'search-box';
  setHtml(box, html`<div class="search-panel" role="dialog" aria-modal="true" aria-label="بحث">
    <form class="search-in" role="search">${icon('search')}<input type="search" id="q" placeholder="ابحث عن منتج، قسم أو باقة…" autocomplete="off" enterkeyhint="search" aria-label="بحث"><button class="icon-btn" type="button" data-x aria-label="إغلاق البحث">${icon('x')}</button></form>
    <div class="search-res" id="sres" aria-live="polite"></div></div>`);
  document.body.append(box); lockScroll(true);
  const input = $('#q', box); const res = $('#sres', box); input.focus();
  const release = trapFocus(box, close);
  let ctl;
  function close() { ctl?.abort(); release(); box.remove(); lockScroll(false); }
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  $('[data-x]', box).addEventListener('click', close);
  res.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
  $('form', box).addEventListener('submit', (e) => { e.preventDefault(); const q = input.value.trim(); if (q) { close(); navigate(`/shop?q=${encodeURIComponent(q)}`); } });
  const run = debounce(async () => {
    const q = input.value.trim(); ctl?.abort();
    if (q.length < 2) { setHtml(res, ''); return; }
    ctl = new AbortController();
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}&limit=6`, { signal: ctl.signal });
      const th = (img) => html`<span class="sr-th">${img ? raw(`<img src="${img}" alt="" loading="lazy">`) : icon('bag')}</span>`;
      if (!r.products.length && !r.bundles.length && !r.categories.length) { setHtml(res, html`<div class="empty" style="border:0">لا توجد نتائج لـ «${q}»<br>جرّب كلمة أخرى.</div>`); return; }
      setHtml(res, html`
        ${r.categories.length ? html`<div class="sr-group">الأقسام</div>${r.categories.map((c) => html`<a class="sr-item" href="${c.kind === 'bundles' ? '/bundles' : `/shop?category=${c.slug}`}"><span class="t">${c.name}</span></a>`)}` : ''}
        ${r.products.length ? html`<div class="sr-group">المنتجات</div>${r.products.map((p) => html`<a class="sr-item" href="${productUrl(p)}">${th(p.image)}<span><span class="t">${p.name}</span><br><span class="s">${p.category_name}${p.available ? '' : ' · غير متوفر'}</span></span><span class="p">${money(p.price_from ?? p.price)}</span></a>`)}` : ''}
        ${r.bundles.length ? html`<div class="sr-group">باقات المناسبات</div>${r.bundles.map((b) => html`<a class="sr-item" href="${bundleUrl(b)}">${th(b.image)}<span><span class="t">${b.name}</span></span><span class="p">${money(b.price)}</span></a>`)}` : ''}
        <a class="sr-item" href="/shop?q=${encodeURIComponent(q)}"><span class="t">عرض كل النتائج لـ «${q}»</span></a>`);
    } catch (e) { if (!isAbort(e)) setHtml(res, html`<div class="empty" style="border:0">${e.message}</div>`); }
  }, 220);
  input.addEventListener('input', run);
}
