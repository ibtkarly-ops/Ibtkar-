// Order confirmation / tracking. Never claims "paid" unless the server says so.
import { html, setHtml, money, fmtDate, $, displayPhone, telLink, waLink, icon } from '../util.js';
import { settings } from '../state.js';
import { api, ApiError } from '../api.js';
import { toast } from '../ui.js';

const FLOW = [['new', 'جديد'], ['confirming', 'قيد التأكيد'], ['preparing', 'قيد التحضير'], ['ready', 'جاهز للاستلام'], ['delivered', 'تم التسليم']];
const FINAL = new Set(['delivered', 'cancelled']);

function nextStep(o) {
  if (o.status === 'cancelled') return 'تم إلغاء هذا الطلب. للاستفسار تواصل مع الفرع أو دعم العملاء.';
  if (o.payment_method.startsWith('online') && o.payment_status !== 'paid') {
    if (o.payment_status === 'failed' || o.payment_status === 'cancelled') return 'لم تكتمل عملية الدفع. يمكنك إعادة المحاولة بالزر أدناه، ولن يتم تحضير الطلب قبل تأكيد الدفع.';
    return 'بانتظار تأكيد الدفع من مزوّد الدفع. إن أكملت الدفع فحدّث الصفحة بعد لحظات.';
  }
  switch (o.status) {
    case 'new': return o.fulfillment === 'delivery' ? 'استلمنا طلبك. سيؤكده الفرع قريبًا ويتواصل معك على رقم هاتفك.' : 'استلمنا طلبك. سيؤكده الفرع قريبًا ويتواصل معك على رقم هاتفك. ادفع عند الاستلام.';
    case 'confirming': return 'الفرع يراجع طلبك ويؤكده معك.';
    case 'preparing': return 'طلبك قيد التحضير الآن.';
    case 'ready': return o.fulfillment === 'delivery' ? 'طلبك جاهز وسيصلك قريبًا.' : `طلبك جاهز للاستلام من فرع ${o.branch.name}.`;
    case 'delivered': return 'تم تسليم الطلب. نتمنى أن ينال إعجابك!';
    default: return '';
  }
}

function waText(o) {
  return ['السلام عليكم، بخصوص طلبي من عالم البكلاوه:', `رقم الطلب: ${o.number}`, `الاسم: ${o.customer_name}`, `الإجمالي: ${money(o.total)}`, `الفرع: ${o.branch.name}`].join('\n');
}

export default async function order({ el, params, query, setTitle, signal }) {
  const s = settings(); const number = params.number; const token = query.get('t') || '';
  setTitle(`طلب ${number} | ${s.brand_name_ar}`);
  const fresh = query.get('new') === '1';
  let data;
  const fetchOrder = () => api(`/api/orders/${encodeURIComponent(number)}${token ? `?t=${encodeURIComponent(token)}` : ''}`, { signal });
  try { data = await fetchOrder(); }
  catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
      setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>لم نجد هذا الطلب</b>تأكد من الرابط، أو تتبّع طلبك برقم الطلب ورقم هاتفك.<div class="row mt" style="justify-content:center"><a class="btn btn-primary" href="/track">تتبّع طلب</a><a class="btn btn-ghost" href="/login?next=${encodeURIComponent('/order/' + number)}">تسجيل الدخول</a></div></div></div>`);
      return;
    }
    throw e;
  }
  let o = data.order; const tk = data.token || token;

  function paint() {
    const idx = FLOW.findIndex(([k]) => k === o.status);
    const cancelled = o.status === 'cancelled';
    const payBad = o.payment_method.startsWith('online') && ['unpaid', 'pending', 'failed', 'cancelled'].includes(o.payment_status) && !cancelled;
    setHtml(el, html`<div class="wrap"><div class="page-head"><div class="crumbs"><a href="/">الرئيسية</a> / طلب ${o.number}</div></div>
      ${fresh && o.payment_status !== 'paid' && !cancelled ? html`<div class="notice notice-ok" role="status"><b>تم تسجيل طلبك</b> — ${o.payment_method.startsWith('online') ? 'بانتظار إتمام الدفع الإلكتروني.' : 'سيؤكده الفرع قريبًا.'}</div>` : ''}
      ${fresh && o.payment_status === 'paid' ? html`<div class="notice notice-ok" role="status"><b>تم تأكيد الدفع</b> وتسجيل طلبك.</div>` : ''}
      <div class="layout-2"><div class="grid-stack" style="display:grid;gap:16px">
        <section class="panel"><div class="row" style="justify-content:space-between"><div><div class="cl-sub">رقم الطلب</div><h1 style="margin:0;font-size:28px;direction:ltr;text-align:right">${o.number}</h1></div>
          <div class="row"><span class="status s-${o.status}">${o.status_label}</span><span class="status p-${o.payment_status}">${o.payment_status_label}</span></div></div>
          ${cancelled ? '' : html`<div class="steps" aria-label="مراحل الطلب">${FLOW.map(([k, t], i) => html`<div class="step ${i < idx || o.status === 'delivered' ? 'done' : ''} ${i === idx ? 'now' : ''}" ${i === idx ? 'aria-current="step"' : ''}>${t}</div>`)}</div>`}
          <p style="margin:12px 0 0"><b>الخطوة التالية:</b> ${nextStep(o)}</p>
          ${payBad ? html`<div class="mt"><button class="btn btn-primary" id="repay" type="button">${o.payment_status === 'pending' ? 'متابعة الدفع' : 'إعادة محاولة الدفع'}</button></div>` : ''}</section>
        <section class="panel"><h2 style="font-size:19px">الأصناف</h2>
          <table class="tbl"><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th></tr></thead><tbody>
          ${o.items.map((i) => html`<tr><td>${i.name}${i.variant_name ? ` — ${i.variant_name}` : ''}${i.note ? html`<div class="cl-sub">ملاحظة: ${i.note}</div>` : ''}</td><td>${i.quantity}</td><td>${money(i.line_total)}</td></tr>`)}</tbody></table>
          <div class="mt"><div class="sum-row"><span>المجموع الفرعي</span><span>${money(o.subtotal)}</span></div>
          ${o.delivery_fee ? html`<div class="sum-row"><span>رسوم التوصيل</span><span>${money(o.delivery_fee)}</span></div>` : ''}
          <div class="sum-total"><span>الإجمالي</span><b>${money(o.total)}</b></div></div></section></div>
        <aside style="display:grid;gap:16px" class="sticky"><section class="panel"><h2 style="font-size:19px">الفرع</h2>
          <p style="margin:0"><b>${o.branch.name}</b>${o.branch.address ? html`<br><span class="cl-sub">${o.branch.address}</span>` : ''}</p>
          <div class="row mt">${o.branch.phone ? html`<a class="btn btn-ghost btn-sm" href="${telLink(o.branch.phone)}">${icon('phone')} اتصال</a>` : ''}
            ${o.branch.maps_url ? html`<a class="btn btn-ghost btn-sm" href="${o.branch.maps_url}" target="_blank" rel="noopener noreferrer">${icon('pin')} الاتجاهات</a>` : ''}
            ${o.branch.whatsapp ? html`<a class="btn btn-wa btn-sm" href="${waLink(o.branch.whatsapp, waText(o))}" target="_blank" rel="noopener noreferrer">${icon('chat')} راسل الفرع</a>` : ''}</div></section>
        <section class="panel"><h2 style="font-size:19px">تفاصيل</h2><dl class="kv">
          <dt>الاسم</dt><dd>${o.customer_name}</dd><dt>الهاتف</dt><dd><bdi dir="ltr">${displayPhone(o.customer_phone)}</bdi></dd>
          <dt>الاستلام</dt><dd>${o.fulfillment === 'delivery' ? 'توصيل' : 'من الفرع'}</dd>${o.address ? html`<dt>العنوان</dt><dd>${o.address}</dd>` : ''}
          <dt>الدفع</dt><dd>${o.payment_method === 'cash' ? 'عند الاستلام' : 'إلكتروني'}</dd><dt>التاريخ</dt><dd>${fmtDate(o.created_at)}</dd>${o.notes ? html`<dt>ملاحظات</dt><dd>${o.notes}</dd>` : ''}</dl></section>
        </aside></div></div>`);
    $('#repay', el)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const r = await api(`/api/orders/${encodeURIComponent(o.number)}/pay?t=${tk}`, { method: 'POST' }); location.assign(r.redirectUrl); }
      catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    });
  }
  paint();

  // Live status: poll while the order is open. One toast per change.
  if (!FINAL.has(o.status) || o.payment_status === 'pending') {
    const timer = setInterval(async () => {
      if (signal.aborted) { clearInterval(timer); return; }
      if (document.hidden) return;
      try {
        const d = await fetchOrder(); const prev = o; o = d.order;
        if (o.status !== prev.status) toast(`حالة طلبك الآن: ${o.status_label}`, 'ok');
        if (o.payment_status !== prev.payment_status && o.payment_status === 'paid') toast('تم تأكيد الدفع', 'ok');
        if (o.status !== prev.status || o.payment_status !== prev.payment_status) paint();
        if (FINAL.has(o.status) && o.payment_status !== 'pending') clearInterval(timer);
      } catch { /* try again next tick */ }
    }, 20000);
    signal.addEventListener('abort', () => clearInterval(timer));
  }
}
