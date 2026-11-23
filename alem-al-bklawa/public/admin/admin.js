// Admin app: login gate → sidebar layout → page router. Pages live in pages.js and load on demand.
import { html, setHtml, $, $$, logoDisc, icon } from '/js/util.js';
import { api, ApiError } from '/js/api.js';
import { toast, lockScroll, showFieldError, clearFieldErrors } from '/js/ui.js';

const NAV = [
  ['/admin', 'لوحة المعلومات', 'dashboard', 'staff'], ['/admin/orders', 'الطلبات', 'orders', 'staff'], ['/admin/products', 'المنتجات', 'products', 'admin'],
  ['/admin/categories', 'الأقسام', 'categories', 'admin'], ['/admin/bundles', 'باقات المناسبات', 'bundles', 'admin'], ['/admin/banners', 'الإعلانات', 'banners', 'admin'], ['/admin/payments', 'بوابات الدفع', 'payments', 'admin'],
  ['/admin/branches', 'الفروع', 'branches', 'admin'], ['/admin/customers', 'العملاء والدعم', 'customers', 'staff'], ['/admin/settings', 'الإعدادات', 'settings', 'admin'], ['/admin/team', 'الفريق وسجل العمليات', 'team', 'admin'],
];
const TITLES = Object.fromEntries(NAV.map(([, t, k]) => [k, t]));
let user = null; let boot = null; let navAbort = null; let pollTimer = null; let lastOrderId = null;
const root = $('#root');
document.getElementById('no-app')?.remove(); // admin.js loaded, so JavaScript works; noServerView() explains if the API is missing

async function loadBoot() {
  boot = await api('/api/bootstrap');
  if (!boot || !boot.settings) throw new Error('no-server');
}

// Shown when the page is opened without the Node.js server behind it (static hosting / opened as a file).
function noServerView() {
  setHtml(root, html`<div class="login-wrap"><div class="login-card form" style="max-width:560px"><h1 style="font-size:22px;margin:0">الخادم غير متصل</h1>
    <div class="notice notice-err">هذه اللوحة تحتاج إلى خادم Node.js (قاعدة البيانات وواجهة الـ API). فتحها كملف مباشر أو رفع المجلد على استضافة ملفات ثابتة لن يعمل.</div>
    <p style="margin:0"><b>التشغيل:</b></p>
    <ol style="margin:0;padding-inline-start:20px;line-height:2"><li>ثبّت Node.js 22 أو أحدث.</li><li>من داخل مجلد المتجر شغّل: <code dir="ltr">npm start</code></li><li>افتح <code dir="ltr">http://localhost:3000/admin</code></li></ol>
    <p class="cl-sub" style="margin:0">للنشر على سيرفر: <code dir="ltr">docker compose up -d --build</code> أو أي استضافة تدعم Node.js. تفاصيل أكثر في README.md.</p></div></div>`);
}

// First run: no admin exists yet → create the owner account right here.
function setupView(needsCode) {
  setHtml(root, html`<div class="login-wrap"><form class="login-card form" id="sf" novalidate style="max-width:460px">${logoDisc(boot.settings, 84)}
    <h1 style="text-align:center;font-size:22px;margin:0">إعداد المتجر لأول مرة</h1>
    <p class="cl-sub" style="text-align:center;margin:0">أنشئ حساب مدير المتجر. يظهر هذا النموذج مرة واحدة فقط، وبعد إنشاء الحساب يُغلق نهائيًا.</p>
    <div class="field"><label for="sn">اسمك</label><input class="input" id="sn" name="name" autocomplete="name" required maxlength="80"></div>
    <div class="field"><label for="se">البريد الإلكتروني (للدخول)</label><input class="input" id="se" name="email" type="email" autocomplete="username" required dir="ltr" style="text-align:right"></div>
    <div class="field"><label for="sp">كلمة المرور (8 أحرف على الأقل)</label><input class="input" id="sp" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
    <div class="field"><label for="sc">تأكيد كلمة المرور</label><input class="input" id="sc" name="confirm" type="password" autocomplete="new-password" required></div>
    ${needsCode ? html`<div class="field"><label for="sk">رمز الإعداد</label><input class="input" id="sk" name="code" autocomplete="off" required dir="ltr" style="text-align:right;letter-spacing:2px;text-transform:uppercase"><span class="hint">تجده في سجل تشغيل الخادم (سطر «إعداد أولي») أو في الملف <bdi dir="ltr">data/setup-code.txt</bdi>. من نفس جهاز الخادم لا تحتاجه.</span></div>` : ''}
    <button class="btn btn-primary btn-block" type="submit">إنشاء حساب المدير وبدء الإعداد</button></form></div>`);
  const f = $('#sf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); clearFieldErrors(f); const b = f.querySelector('[type=submit]'); b.disabled = true;
    try {
      const r = await api('/api/setup', { method: 'POST', body: { name: f.name.value, email: f.email.value, password: f.password.value, confirm: f.confirm.value, code: f.code?.value || '' } });
      user = r.user; toast('تم إنشاء حساب المدير. أهلًا بك!', 'ok'); start();
    } catch (err) {
      if (err.code === 'already_setup') { loginView('تم إعداد المتجر بالفعل. سجّل الدخول.'); return; }
      if (!(err.data?.field && showFieldError(f, err.data.field, err.message))) toast(err.message, 'err', { ms: 6000 });
      b.disabled = false;
    }
  });
  $('#sn').focus();
}
const settings = () => boot.settings;

function loginView(msg = '') {
  setHtml(root, html`<div class="login-wrap"><form class="login-card form" id="lf" novalidate>${logoDisc(boot.settings, 84)}<h1 style="text-align:center;font-size:22px;margin:0">لوحة الإدارة</h1><p class="cl-sub" style="text-align:center;margin:0">${boot.settings.brand_name_ar}</p>
    ${msg ? html`<div class="notice notice-err" role="alert">${msg}</div>` : ''}
    <div class="field"><label for="li">البريد الإلكتروني أو الهاتف</label><input class="input" id="li" name="identifier" autocomplete="username" required dir="ltr" style="text-align:right"></div>
    <div class="field"><label for="lp">كلمة المرور</label><input class="input" id="lp" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn btn-primary btn-block" type="submit">دخول</button><a class="cl-sub" style="text-align:center" href="/">← العودة إلى المتجر</a></form></div>`);
  const f = $('#lf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const b = f.querySelector('button'); b.disabled = true;
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { identifier: f.identifier.value, password: f.password.value } });
      if (r.user.role === 'customer') { await api('/api/auth/logout', { method: 'POST' }); loginView('هذا الحساب لا يملك صلاحية الدخول إلى لوحة الإدارة.'); return; }
      user = r.user; start();
    } catch (err) { loginView(err.message); }
  });
  $('#li').focus();
}

function can(level) { return level === 'staff' || user.role === 'admin'; }

function layout() {
  setHtml(root, html`<div class="shell">
    <aside class="side" id="side" aria-label="القائمة الجانبية"><div class="side-brand">${logoDisc(settings(), 40)}<span>${settings().brand_name_ar}</span></div>
      <nav>${NAV.filter(([, , , lvl]) => can(lvl)).map(([h, t, k]) => html`<a href="${h}" data-r="${k}">${t}${k === 'orders' ? html`<span class="cnt" id="new-cnt" hidden>0</span>` : ''}</a>`)}</nav>
      <div class="side-foot"><div>${user.name} · ${user.role === 'admin' ? 'مدير' : 'موظف'}</div><a href="/" target="_blank" rel="noopener">عرض المتجر ↗</a><a href="/account?tab=security" data-native>تغيير كلمة المرور</a><a href="#" id="logout">تسجيل الخروج</a></div></aside>
    <div class="scrim" id="scrim" hidden></div>
    <div class="main"><header class="top"><button class="icon-btn burger" id="burger" type="button" aria-label="القائمة">${icon('menu')}</button><h1 id="ptitle"></h1></header>
      <main class="content" id="page" tabindex="-1"></main></div></div>`);
  const side = $('#side'); const scrim = $('#scrim');
  const setSide = (o) => { side.classList.toggle('open', o); scrim.hidden = !o; lockScroll(o); };
  $('#burger').addEventListener('click', () => setSide(true));
  scrim.addEventListener('click', () => setSide(false));
  side.addEventListener('click', (e) => { if (e.target.closest('a[data-r]')) setSide(false); });
  $('#logout').addEventListener('click', async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); clearInterval(pollTimer); location.href = '/admin'; });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-r]'); if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); go(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => render());
}

export function go(path) { if (path !== location.pathname) history.pushState({}, '', path); render(); }

async function render() {
  navAbort?.abort(); navAbort = new AbortController();
  const path = location.pathname.replace(/\/+$/, '') || '/admin';
  const key = (NAV.find(([h]) => h === path) || NAV[0])[2];
  const lvl = NAV.find(([, , k]) => k === key)[3];
  $$('[data-r]').forEach((a) => (a.dataset.r === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  let page = $('#page'); const fresh = page.cloneNode(false); page.replaceWith(fresh); page = fresh; // drop listeners from the previous page
  $('#ptitle').textContent = TITLES[key]; document.title = `${TITLES[key]} | إدارة ${settings().brand_name_ar}`;
  if (!can(lvl)) { setHtml(page, html`<div class="empty"><b>غير مصرح</b>هذه الصفحة للمدير فقط.</div>`); return; }
  setHtml(page, html`<div class="skel" style="min-height:160px"></div>`);
  try {
    const mod = await import('/admin/pages.js');
    if (navAbort.signal.aborted) return;
    page.replaceChildren();
    await mod[key]({ el: page, signal: navAbort.signal, user, boot, refreshBoot: loadBoot, go });
  } catch (e) {
    if (e.code === 'aborted' || navAbort.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) { loginView('انتهت الجلسة. سجّل الدخول من جديد.'); return; }
    console.error(e); setHtml(page, html`<div class="empty"><b>تعذّر تحميل الصفحة</b>${e.message}<div class="mt"><button class="btn btn-primary" id="retry">إعادة المحاولة</button></div></div>`);
    $('#retry')?.addEventListener('click', render);
  }
  window.scrollTo(0, 0);
}

// New-order alerts: light polling (every 30 s) while the tab is visible.
async function poll() {
  if (document.hidden) return;
  try {
    const d = await api('/api/admin/dashboard');
    const cnt = $('#new-cnt'); if (cnt) { cnt.textContent = d.counts.new; cnt.hidden = d.counts.new === 0; }
    if (lastOrderId !== null && d.newestOrderId > lastOrderId) toast('وصل طلب جديد', 'ok', { action: 'عرض', onAction: () => go('/admin/orders'), ms: 6000 });
    lastOrderId = d.newestOrderId;
  } catch { /* offline */ }
}

function start() { layout(); render(); poll(); clearInterval(pollTimer); pollTimer = setInterval(poll, 30000); }

(async () => {
  try { await loadBoot(); } catch { noServerView(); return; }
  try { const r = await api('/api/auth/me'); if (r.user && r.user.role !== 'customer') { user = r.user; start(); return; } } catch { /* show login */ }
  try { const st = await api('/api/setup/status'); if (st.needsSetup) { setupView(st.needsCode); return; } } catch { /* fall through to login */ }
  loginView();
})();
