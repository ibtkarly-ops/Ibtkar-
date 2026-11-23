// Login, register, forgot (support via WhatsApp — never a password in a link), reset with one-time token.
import { html, setHtml, $, waLink, displayPhone, telLink, icon } from '../util.js';
import { settings, setUser, state, waitUser } from '../state.js';
import { api } from '../api.js';
import { cart } from '../cart.js';
import { navigate } from '../router.js';
import { toast, showFieldError, clearFieldErrors } from '../ui.js';

const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/account');
const pw = (id, name, label, auto) => html`<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" name="${name}" type="password" autocomplete="${auto}" required minlength="8" maxlength="128"></div>`;

async function submit(form, fn) {
  clearFieldErrors(form);
  const btn = form.querySelector('[type=submit]'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'لحظة…';
  try { await fn(); }
  catch (err) {
    if (!(err.data?.field && showFieldError(form, err.data.field, err.message))) toast(err.message, 'err');
  } finally { btn.disabled = false; btn.textContent = label; }
}

function login({ el, query }) {
  const next = safeNext(query.get('next'));
  setHtml(el, html`<div class="wrap"><div class="page-head center"><h1>تسجيل الدخول</h1></div>
    <form class="panel form narrow" id="lf" novalidate>
      <div class="field"><label for="li">رقم الهاتف أو البريد الإلكتروني</label><input class="input" id="li" name="identifier" autocomplete="username" required dir="ltr" style="text-align:right"></div>
      ${pw('lp', 'password', 'كلمة المرور', 'current-password')}
      <button class="btn btn-primary btn-block" type="submit">دخول</button>
      <div class="row" style="justify-content:space-between;font-size:14.5px"><a href="/forgot?type=password">نسيت كلمة المرور؟</a><a href="/forgot?type=identifier">نسيت البريد أو رقم الهاتف؟</a></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%"><p class="center" style="margin:0">ليس لديك حساب؟ <a href="/register?next=${encodeURIComponent(next)}">إنشاء حساب</a></p></form></div>`);
  const f = $('#lf', el);
  f.addEventListener('submit', (e) => { e.preventDefault(); submit(f, async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { identifier: f.identifier.value, password: f.password.value } });
    setUser(r.user); cart.restore(); toast(`أهلًا ${r.user.name}`, 'ok'); navigate(safeNext(next), { replace: true });
  }); });
}

function register({ el, query }) {
  const next = safeNext(query.get('next'));
  setHtml(el, html`<div class="wrap"><div class="page-head center"><h1>إنشاء حساب</h1><p class="lead">لمتابعة طلباتك وحفظ سلتك على كل أجهزتك.</p></div>
    <form class="panel form narrow" id="rf" novalidate>
      <div class="field"><label for="rn">الاسم</label><input class="input" id="rn" name="name" autocomplete="name" required maxlength="80"></div>
      <div class="field"><label for="rp">رقم الهاتف</label><input class="input" id="rp" name="phone" type="tel" inputmode="tel" autocomplete="tel" required dir="ltr" style="text-align:right"></div>
      <div class="field"><label for="re">البريد الإلكتروني (اختياري)</label><input class="input" id="re" name="email" type="email" autocomplete="email" dir="ltr" style="text-align:right"></div>
      ${pw('rw', 'password', 'كلمة المرور (8 أحرف على الأقل)', 'new-password')}
      <button class="btn btn-primary btn-block" type="submit">إنشاء الحساب</button>
      <p class="center" style="margin:0">لديك حساب؟ <a href="/login?next=${encodeURIComponent(next)}">تسجيل الدخول</a></p></form></div>`);
  const f = $('#rf', el);
  f.addEventListener('submit', (e) => { e.preventDefault(); submit(f, async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { name: f.name.value, phone: f.phone.value, email: f.email.value, password: f.password.value } });
    setUser(r.user); cart.restore(); toast('تم إنشاء حسابك', 'ok'); navigate(next, { replace: true });
  }); });
}

// Recovery goes through the support team on WhatsApp. Nothing secret is ever put in the message.
function forgot({ el, query }) {
  const s = settings();
  const type = query.get('type') === 'identifier' ? 'identifier' : 'password';
  const MSG = {
    password: 'السلام عليكم، أحتاج إلى استعادة حسابي في موقع عالم البكلاوه. أرجو مساعدتي في التحقق من الحساب وإعادة تعيين كلمة المرور بطريقة آمنة.',
    identifier: 'السلام عليكم، نسيت البريد الإلكتروني أو رقم الهاتف المرتبط بحسابي في موقع عالم البكلاوه. أرجو مساعدتي في التحقق من هويتي واستعادة الوصول إلى الحساب.',
  };
  setHtml(el, html`<div class="wrap"><div class="page-head center"><h1>استعادة الحساب</h1></div>
    <div class="panel narrow form">
      <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" data-t="password" aria-selected="${type === 'password'}">نسيت كلمة المرور</button><button class="tab" role="tab" type="button" data-t="identifier" aria-selected="${type === 'identifier'}">نسيت البريد / الهاتف</button></div>
      <p style="margin:0">${type === 'password' ? 'حفاظًا على أمان حسابك، لا نرسل كلمة مرور ولا نعرض القديمة. سيتحقق فريق الدعم من هويتك ثم يمنحك رابطًا خاصًا لتعيين كلمة مرور جديدة (صالح لمرة واحدة وساعة واحدة).' : 'لن نكشف البريد أو الرقم المرتبط بالحساب قبل التحقق. تواصل مع الدعم ليتحقق من هويتك ويساعدك.'}</p>
      <div class="field"><label for="fn">اسمك (اختياري، يساعد الدعم)</label><input class="input" id="fn" autocomplete="name" maxlength="80"></div>
      <div class="field"><label for="fp">رقم هاتف للتواصل (اختياري)</label><input class="input" id="fp" type="tel" inputmode="tel" dir="ltr" style="text-align:right" autocomplete="tel"></div>
      <a class="btn btn-wa btn-block" id="fwa" href="${waLink(s.support_whatsapp, MSG[type])}" target="_blank" rel="noopener noreferrer">${icon('chat')} تواصل مع الدعم عبر واتساب</a>
      <p class="cl-sub center" style="margin:0">أو اتصل بنا: <a href="${telLink(s.support_phone)}"><bdi dir="ltr">${displayPhone(s.support_phone)}</bdi></a></p>
      <p class="cl-sub center" style="margin:0">لا تُرسل كلمة مرورك أبدًا في أي رسالة. لدينا رابط استعادة آمن فقط.</p></div></div>`);
  const a = $('#fwa', el);
  const upd = () => { const n = $('#fn', el).value.trim(); const p = $('#fp', el).value.trim(); a.href = waLink(s.support_whatsapp, MSG[type] + (n ? `\nالاسم: ${n}` : '') + (p ? `\nرقم التواصل: ${p}` : '')); };
  $('#fn', el).addEventListener('input', upd); $('#fp', el).addEventListener('input', upd);
  a.addEventListener('click', () => { // log the request for the admin queue (best effort; the WhatsApp link opens regardless)
    api('/api/support', { method: 'POST', body: { kind: type, name: $('#fn', el).value, phone: $('#fp', el).value, message: MSG[type] } }).catch(() => {});
  });
  el.addEventListener('click', (e) => { const t = e.target.closest('[data-t]'); if (t) navigate(`/forgot?type=${t.dataset.t}`, { replace: true }); });
}

function reset({ el, query }) {
  const token = query.get('token') || '';
  if (!token) { setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>رابط غير صالح</b>اطلب رابطًا جديدًا من الدعم.<div class="mt"><a class="btn btn-primary" href="/forgot">استعادة الحساب</a></div></div></div>`); return; }
  setHtml(el, html`<div class="wrap"><div class="page-head center"><h1>تعيين كلمة مرور جديدة</h1></div>
    <form class="panel form narrow" id="sf" novalidate>${pw('sp', 'password', 'كلمة المرور الجديدة (8 أحرف على الأقل)', 'new-password')}${pw('sp2', 'confirm', 'تأكيد كلمة المرور', 'new-password')}<button class="btn btn-primary btn-block" type="submit">حفظ</button></form></div>`);
  const f = $('#sf', el);
  f.addEventListener('submit', (e) => { e.preventDefault(); submit(f, async () => {
    if (f.password.value !== f.confirm.value) { showFieldError(f, 'confirm', 'كلمتا المرور غير متطابقتين'); return; }
    await api('/api/auth/reset', { method: 'POST', body: { token, password: f.password.value } });
    setUser(null); toast('تم تغيير كلمة المرور. سجّل الدخول بها.', 'ok'); navigate('/login', { replace: true });
  }); });
}

export default async function auth(ctx) {
  const name = ctx.path.replace(/\/$/, '');
  ctx.setTitle(`${{ '/login': 'تسجيل الدخول', '/register': 'إنشاء حساب', '/forgot': 'استعادة الحساب', '/reset': 'كلمة مرور جديدة' }[name]} | ${settings().brand_name_ar}`);
  await waitUser();
  if (state.user && (name === '/login' || name === '/register')) { navigate(safeNext(ctx.query.get('next')), { replace: true }); return; }
  ({ '/login': login, '/register': register, '/forgot': forgot, '/reset': reset }[name])(ctx);
}
