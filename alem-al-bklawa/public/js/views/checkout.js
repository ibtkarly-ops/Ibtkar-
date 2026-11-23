// Checkout: server-priced summary, branch + fulfilment, payment method, idempotent submit.
import { html, setHtml, money, icon, $, $$, store, uid, raw } from '../util.js';
import { state, settings, waitUser } from '../state.js';
import { api } from '../api.js';
import { cart, lineKey } from '../cart.js';
import { toast, showFieldError, clearFieldErrors } from '../ui.js';
import { navigate } from '../router.js';

export default async function checkout({ el, setTitle, signal }) {
  const boot = state.boot; const s = settings();
  setTitle(`إتمام الطلب | ${s.brand_name_ar}`);
  await waitUser();
  if (!cart.items().length) {
    setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>سلتك فارغة</b>أضف منتجات أولًا ثم أكمل الطلب.<div class="mt"><a class="btn btn-primary" href="/shop">تصفح المنتجات</a></div></div></div>`);
    return;
  }
  const branches = boot.branches.filter((b) => b.accepts_orders);
  const u = state.user;
  const online = boot.payments.online || [];
  const canDeliver = boot.delivery.enabled && branches.some((b) => b.delivers);
  let fulfillment = 'pickup';
  let branchId = Number(store.get('abk_branch')) || (branches.length === 1 ? branches[0].id : 0);
  if (!branches.some((b) => b.id === branchId)) branchId = branches.length === 1 ? branches[0].id : 0;
  let method = boot.payments.cash ? 'cash' : online.length ? `online:${online[0].id}` : '';
  let priced = null; let busy = false; let keyState = { hash: '', key: uid() };

  setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / إتمام الطلب</div><h1>إتمام الطلب</h1></div>
    ${u ? '' : html`<div class="notice notice-info">لديك حساب؟ <a href="/login?next=/checkout">سجّل الدخول</a> لحفظ بياناتك ومتابعة طلباتك. يمكنك أيضًا إتمام الطلب كضيف.</div>`}
    <div id="notices" aria-live="polite"></div>
    <div class="layout-2">
      <form id="co" class="form" novalidate>
        <section class="panel form" aria-labelledby="h-c"><h2 id="h-c" style="font-size:19px;margin:0">بياناتك</h2>
          <div class="row2"><div class="field"><label for="cn">الاسم</label><input class="input" id="cn" name="name" autocomplete="name" required maxlength="80" value="${u?.name || ''}"></div>
          <div class="field"><label for="cp">رقم الهاتف</label><input class="input" id="cp" name="phone" type="tel" inputmode="tel" autocomplete="tel" required dir="ltr" style="text-align:right" value="${u?.phone ? '0' + u.phone.slice(3) : ''}"><span class="hint">للتواصل بخصوص طلبك</span></div></div>
          <div class="field"><label for="ce">البريد الإلكتروني (اختياري)</label><input class="input" id="ce" name="email" type="email" autocomplete="email" dir="ltr" style="text-align:right" value="${u?.email || ''}"></div></section>
        <section class="panel form" aria-labelledby="h-b"><h2 id="h-b" style="font-size:19px;margin:0">الفرع وطريقة الاستلام</h2>
          <div class="field"><label for="cb">الفرع</label><select class="select" id="cb" name="branchId" required><option value="">اختر الفرع</option>${branches.map((b) => html`<option value="${b.id}" ${b.id === branchId ? 'selected' : ''}>${b.name}</option>`)}</select></div>
          <div id="ful"></div>
          <div class="field"><label for="cnote">ملاحظات على الطلب (اختياري)</label><textarea class="textarea" id="cnote" name="notes" maxlength="500"></textarea></div></section>
        <section class="panel form" aria-labelledby="h-p"><h2 id="h-p" style="font-size:19px;margin:0">طريقة الدفع</h2><div id="pay" class="radio-cards"></div></section>
      </form>
      <aside class="panel sticky" aria-labelledby="h-s"><h2 id="h-s" style="font-size:19px">ملخص الطلب</h2><div id="sum"><div class="skel" style="min-height:140px"></div></div></aside>
    </div></div>`);
  const form = $('#co', el);

  const paintFul = () => {
    const b = branches.find((x) => x.id === branchId);
    const deliveryOk = canDeliver && b?.delivers;
    if (!deliveryOk && fulfillment === 'delivery') fulfillment = 'pickup';
    setHtml($('#ful', el), html`${canDeliver ? html`<div class="radio-cards" role="radiogroup" aria-label="طريقة الاستلام">
        <label class="rc"><input type="radio" name="fulfillment" value="pickup" ${fulfillment === 'pickup' ? 'checked' : ''}><span><b>استلام من الفرع</b><small>تستلم طلبك بنفسك من الفرع المختار</small></span></label>
        <label class="rc" ${deliveryOk ? '' : raw('style="opacity:.55"')}><input type="radio" name="fulfillment" value="delivery" ${fulfillment === 'delivery' ? 'checked' : ''} ${deliveryOk ? '' : 'disabled'}><span><b>توصيل${boot.delivery.fee ? ` (+${money(boot.delivery.fee)})` : ''}</b><small>${deliveryOk ? (boot.delivery.note || 'يصلك الطلب إلى عنوانك') : 'غير متاح لهذا الفرع'}</small></span></label></div>` : ''}
      ${fulfillment === 'delivery' ? html`<div class="field mt"><label for="ca">عنوان التوصيل</label><textarea class="textarea" id="ca" name="address" maxlength="300" required></textarea></div>` : ''}`);
  };
  const paintPay = () => {
    const none = !boot.payments.cash && !online.length;
    setHtml($('#pay', el), none ? html`<div class="notice notice-err">لا توجد طريقة دفع متاحة حاليًا. تواصل مع الدعم.</div>` : html`
      ${boot.payments.cash ? html`<label class="rc"><input type="radio" name="pm" value="cash" ${method === 'cash' ? 'checked' : ''}><span><b>الدفع عند الاستلام</b><small>تدفع قيمة الطلب ${fulfillment === 'delivery' ? 'عند وصول الطلب' : 'عند استلامه من الفرع'}</small></span></label>` : ''}
      ${online.map((o) => html`<label class="rc"><input type="radio" name="pm" value="online:${o.id}" ${method === `online:${o.id}` ? 'checked' : ''}><span><b>${o.label}</b><small>ستنتقل إلى صفحة الدفع الآمنة. لا نخزّن بيانات بطاقتك.</small>${o.sandbox ? html`<span class="sandbox-flag">بيئة اختبار — لا خصم حقيقي</span>` : ''}</span></label>`)}`);
  };

  function paintSum(extra = '') {
    const box = $('#sum', el);
    if (!priced) return;
    const lines = priced.lines; const problems = lines.filter((l) => l.problem);
    const notices = [];
    if (cart.changed().length) notices.push(html`<div class="notice notice-warn" role="alert"><b>تغيّر السعر:</b> ${cart.changed().map((c) => `${c.name} (${money(c.from)} ← ${money(c.to)})`).join('، ')}. الإجمالي الجديد ${money(priced.total)} — راجع الطلب ثم اضغط «تأكيد الطلب».</div>`);
    if (extra) notices.push(html`<div class="notice notice-err" role="alert">${extra}</div>`);
    setHtml($('#notices', el), html`${notices}`);
    setHtml(box, html`
      ${lines.map((l) => html`<div class="cl" style="grid-template-columns:1fr" data-key="${l.key}">
        <div><div class="cl-name">${l.name || 'صنف غير متوفر'}${l.variantName ? ` — ${l.variantName}` : ''}</div>
        <div class="cl-row"><span class="cl-sub">${l.qty} × ${l.problem ? '—' : money(l.unitPrice)}</span><span class="cl-total">${l.problem ? '' : money(l.lineTotal)}</span></div>
        ${l.problem ? html`<div class="warn">${l.problem === 'unavailable' ? 'غير متوفر حاليًا' : 'يرجى مراجعة هذا الصنف'} <button class="cl-rm" type="button" data-rm="${l.key}">حذف من السلة</button></div>` : ''}
        ${l.note ? html`<div class="cl-sub">ملاحظة: ${l.note}</div>` : ''}</div></div>`)}
      <div class="sum-row"><span>المجموع الفرعي</span><span>${money(priced.subtotal)}</span></div>
      ${fulfillment === 'delivery' ? html`<div class="sum-row"><span>رسوم التوصيل</span><span>${money(priced.deliveryFee)}</span></div>` : ''}
      <div class="sum-total"><span>الإجمالي</span><b>${money(priced.total)}</b></div>
      <button class="btn btn-primary btn-block" type="submit" form="co" id="go" ${busy || problems.length || !method ? 'disabled' : ''}>${busy ? 'جارٍ تسجيل الطلب…' : method.startsWith('online') ? 'تأكيد الطلب والانتقال للدفع' : 'تأكيد الطلب'}</button>
      <p class="cl-sub mt" style="margin-bottom:0">بالضغط على التأكيد فأنت توافق على <a href="/terms">شروط الاستخدام</a>.</p>`);
  }

  async function reprice(extra) {
    try { priced = await cart.refresh({ fulfillment, branchId: branchId || null, signal }); paintSum(extra); }
    catch (e) { if (e.code !== 'aborted') setHtml($('#sum', el), html`<div class="notice notice-err">${e.message}</div>`); }
  }

  paintFul(); paintPay();
  await reprice();

  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'branchId') { branchId = Number(t.value) || 0; if (branchId) store.set('abk_branch', branchId); paintFul(); reprice(); }
    else if (t.name === 'fulfillment') { fulfillment = t.value; paintFul(); paintPay(); reprice(); }
    else if (t.name === 'pm') { method = t.value; paintSum(); }
  });
  $('#sum', el).addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]'); if (!rm) return;
    cart.remove(rm.dataset.rm);
    if (!cart.items().length) { navigate('/checkout', { replace: true }); return; }
    reprice();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); if (busy) return;
    clearFieldErrors(form);
    if (!branchId) { showFieldError(form, 'branchId', 'اختر الفرع'); return; }
    if (!method) { toast('اختر طريقة الدفع', 'err'); return; }
    const body = {
      items: cart.items().map((i) => ({ type: i.type, id: i.id, variantId: i.variantId, qty: i.qty, note: i.note })),
      name: form.name.value, phone: form.phone.value, email: form.email.value, branchId, fulfillment,
      address: form.address?.value || '', notes: form.notes.value, paymentMethod: method, expectedTotal: priced.total, source: 'web',
    };
    const hash = JSON.stringify(body); // a new idempotency key whenever the order content changes
    if (keyState.hash !== hash) keyState = { hash, key: uid() };
    busy = true; paintSum();
    try {
      const r = await api('/api/orders', { method: 'POST', body: { ...body, idempotencyKey: keyState.key } });
      cart.clear(); keyState = { hash: '', key: uid() };
      if (r.redirectUrl) { location.assign(r.redirectUrl); return; }
      if (r.paymentError) toast(r.paymentError, 'err', { ms: 6000 });
      navigate(`/order/${encodeURIComponent(r.order.number)}?t=${r.token}&new=1`);
    } catch (err) {
      busy = false;
      if (err.code === 'price_changed' && err.data.pricing) { priced = err.data.pricing; await cart.refresh({ fulfillment, branchId }).catch(() => {}); paintSum(); return; }
      if (err.code === 'cart_invalid') { await reprice('بعض الأصناف لم تعد متاحة. احذفها من السلة ثم أكمل الطلب.'); return; }
      if (err.data?.field && showFieldError(form, err.data.field, err.message)) { paintSum(); return; }
      paintSum(err.message);
    }
  });
}
