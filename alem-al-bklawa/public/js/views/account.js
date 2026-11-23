// Account: orders, profile, password, delete account (explicit two-step).
import { html, setHtml, money, fmtDate, $, $$, displayPhone } from '../util.js';
import { settings, state, setUser, waitUser } from '../state.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { toast, openModal, confirmDialog, showFieldError, clearFieldErrors } from '../ui.js';
import { cart } from '../cart.js';


export default async function account({ el, query, setTitle, signal }) {
  setTitle(`حسابي | ${settings().brand_name_ar}`);
  await waitUser();
  if (!state.user) { navigate('/login?next=/account', { replace: true }); return; }
  let tab = ['orders', 'profile', 'security'].includes(query.get('tab')) ? query.get('tab') : 'orders';
  const u = () => state.user;

  const frame = () => setHtml(el, html`<div class="wrap"><div class="page-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><h1>أهلًا ${u().name}</h1><p class="lead" style="margin:0">إدارة طلباتك وبياناتك</p></div>
    <div class="row">${u().role !== 'customer' ? html`<a class="btn btn-ghost btn-sm" href="/admin" data-native>لوحة الإدارة</a>` : ''}<button class="btn btn-ghost btn-sm" id="logout" type="button">تسجيل الخروج</button></div></div>
    <div class="tabs" role="tablist">${[['orders', 'طلباتي'], ['profile', 'بياناتي'], ['security', 'الأمان وحذف الحساب']].map(([k, t]) => html`<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${tab === k}">${t}</button>`)}</div>
    <div id="tabbody"></div></div>`);

  async function paintTab() {
    $$('[data-tab]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const body = $('#tabbody', el);
    if (tab === 'orders') {
      setHtml(body, html`<div class="skel" style="min-height:120px"></div>`);
      try {
        const { items } = await api('/api/account/orders', { signal });
        setHtml(body, items.length ? html`<div class="olist">${items.map((o) => html`<a class="ocard" href="/order/${o.number}"><div><b style="direction:ltr;display:inline-block">${o.number}</b><div class="cl-sub">${fmtDate(o.created_at)} · ${o.item_count} صنف · ${o.branch.name}</div></div>
          <div class="row"><span class="status s-${o.status}">${o.status_label}</span><span class="status p-${o.payment_status}">${o.payment_status_label}</span><b>${money(o.total)}</b></div></a>`)}</div>`
          : html`<div class="empty"><b>لا توجد طلبات بعد</b>عندما تطلب ستظهر طلباتك هنا مع حالتها.<div class="mt"><a class="btn btn-primary" href="/shop">ابدأ التسوق</a></div></div>`);
      } catch (e) { if (e.code !== 'aborted') setHtml(body, html`<div class="notice notice-err">${e.message}</div>`); }
    } else if (tab === 'profile') {
      setHtml(body, html`<form class="panel form narrow" id="pf" novalidate style="margin-inline:0">
        <div class="field"><label for="pn">الاسم</label><input class="input" id="pn" name="name" required maxlength="80" value="${u().name}"></div>
        <div class="field"><label for="pp">رقم الهاتف</label><input class="input" id="pp" name="phone" type="tel" dir="ltr" style="text-align:right" required value="${u().phone ? displayPhone(u().phone) : ''}"></div>
        <div class="field"><label for="pe">البريد الإلكتروني</label><input class="input" id="pe" name="email" type="email" dir="ltr" style="text-align:right" value="${u().email || ''}"></div>
        <button class="btn btn-primary" type="submit">حفظ التعديلات</button></form>`);
      const f = $('#pf', el);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); clearFieldErrors(f); const b = f.querySelector('button'); b.disabled = true;
        try { const r = await api('/api/account', { method: 'PATCH', body: { name: f.name.value, phone: f.phone.value, email: f.email.value } }); setUser(r.user); toast('تم حفظ بياناتك', 'ok'); frame(); paintTab(); bind(); }
        catch (err) { if (!(err.data?.field && showFieldError(f, err.data.field, err.message))) toast(err.message, 'err'); b.disabled = false; }
      });
    } else {
      setHtml(body, html`<form class="panel form narrow" id="wf" novalidate style="margin-inline:0"><h2 style="font-size:19px;margin:0">تغيير كلمة المرور</h2>
        <div class="field"><label for="wc">كلمة المرور الحالية</label><input class="input" id="wc" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="wn">كلمة المرور الجديدة</label><input class="input" id="wn" name="password" type="password" autocomplete="new-password" required minlength="8"></div>
        <button class="btn btn-primary" type="submit">تغيير كلمة المرور</button><p class="cl-sub" style="margin:0">سيتم تسجيل خروجك من الأجهزة الأخرى.</p></form>
        ${u().role === 'customer' ? html`<section class="panel narrow danger-zone mt2" style="margin-inline:0"><h2 style="font-size:19px;color:var(--err)">حذف الحساب</h2>
          <p>عند حذف حسابك تُحذف بياناتك الشخصية (الاسم والهاتف والبريد) وتُزال من طلباتك السابقة. تبقى مبالغ الطلبات وأصنافها فقط لأغراض المحاسبة. لا يمكن التراجع عن هذا الإجراء.</p>
          <button class="btn btn-danger" id="del" type="button">حذف حسابي…</button></section>` : ''}`);
      const f = $('#wf', el);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); clearFieldErrors(f); const b = f.querySelector('button'); b.disabled = true;
        try { await api('/api/account/password', { method: 'POST', body: { current: f.current.value, password: f.password.value } }); toast('تم تغيير كلمة المرور', 'ok'); f.reset(); }
        catch (err) { if (!(err.data?.field && showFieldError(f, err.data.field, err.message))) toast(err.message, 'err'); }
        b.disabled = false;
      });
      $('#del', el)?.addEventListener('click', startDelete);
    }
  }

  async function startDelete() {
    const ok = await confirmDialog('هل تريد حذف حسابك؟', 'ستُحذف بياناتك الشخصية نهائيًا ولن تتمكن من استرجاع الحساب. الطلبات الجارية تمنع الحذف حتى تكتمل.', { ok: 'متابعة', danger: true });
    if (!ok) return;
    const { el: m, close } = openModal('تأكيد حذف الحساب', html`<form class="form" id="df" novalidate>
      <div class="field"><label for="dp">كلمة المرور</label><input class="input" id="dp" name="password" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="dc">اكتب كلمة «حذف» للتأكيد النهائي</label><input class="input" id="dc" name="confirm" autocomplete="off" required></div>
      <button class="btn btn-danger" type="submit">حذف حسابي نهائيًا</button></form>`);
    const f = $('#df', m);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); clearFieldErrors(f); const b = f.querySelector('button'); b.disabled = true;
      try {
        await api('/api/account', { method: 'DELETE', body: { password: f.password.value, confirm: f.confirm.value.trim() } });
        close(); setUser(null); cart.clear(); toast('تم حذف حسابك', 'ok'); navigate('/', { replace: true });
      } catch (err) { if (!(err.data?.field && showFieldError(f, err.data.field, err.message))) toast(err.message, 'err', { ms: 6000 }); b.disabled = false; }
    });
  }

  function bind() {
    $('#logout', el).addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setUser(null); toast('تم تسجيل الخروج', 'ok'); navigate('/', { replace: true }); });
    el.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; history.replaceState(history.state, '', `/account?tab=${tab}`); paintTab(); } });
  }
  frame(); bind(); await paintTab();
}
