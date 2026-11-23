// A single event bundle: add to cart, or register the order and continue on WhatsApp (Souq Al-Jumaa branch).
import { html, setHtml, money, $, raw, waLink, uid } from '../util.js';
import { settings, state, mainBranch } from '../state.js';
import { api, ApiError } from '../api.js';
import { addToCart } from '../cart.js';
import { openModal, toast, showFieldError, clearFieldErrors } from '../ui.js';

/** The ready-made WhatsApp message (never empty). */
export function bundleMessage({ bundle, qty, notes, branchName, number, name, phone }) {
  return [
    'السلام عليكم، أرغب بطلب باقة من عالم البكلاوه:',
    `الباقة: ${bundle.name}`,
    `السعر: ${money(bundle.price)}`,
    `الكمية: ${qty}`,
    `الإجمالي: ${money(bundle.price * qty)}`,
    `الفرع: ${branchName}`,
    `ملاحظات: ${notes || 'لا توجد'}`,
    name ? `الاسم: ${name}` : '',
    phone ? `الهاتف: ${phone}` : '',
    number ? `رقم الطلب: ${number}` : 'لم يُسجَّل الطلب في الموقع بعد.',
  ].filter(Boolean).join('\n');
}

export default async function bundle({ el, params, setTitle, signal }) {
  let b;
  try { b = await api(`/api/bundles/${Number(params.id)}`, { signal }); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) { setHtml(el, html`<div class="wrap"><div class="empty mt2"><b>الباقة غير موجودة</b><div class="mt"><a class="btn btn-primary" href="/bundles">كل الباقات</a></div></div></div>`); return; }
    throw e;
  }
  const s = settings(); const branch = mainBranch(); let qty = 1;
  setTitle(`${b.name} | ${s.brand_name_ar}`);
  setHtml(el, html`<div class="wrap"><div class="crumbs mt"><a href="/">الرئيسية</a> / <a href="/bundles">باقات المناسبات</a></div>
    <div class="pd"><div class="pd-media">${b.image ? raw(`<img src="${b.image}" alt="" decoding="async" fetchpriority="high">`) : html`<span class="sec-eyebrow" style="font-size:20px">باقة مناسبات</span>`}</div>
    <div><div class="sec-eyebrow">باقة مناسبات</div><h1>${b.name}</h1><div class="pd-price" id="price"></div>
      ${b.available ? '' : html`<div class="notice notice-warn">هذه الباقة غير متوفرة حاليًا.</div>`}
      ${b.description ? html`<p class="lead pre">${b.description}</p>` : ''}
      ${b.items.length ? html`<h2 style="font-size:18px">محتويات الباقة</h2><ul class="contents">${b.items.map((i) => html`<li><b>×${i.quantity}</b><span>${i.label}</span></li>`)}</ul>` : ''}
      <div class="field"><label for="notes">ملاحظاتك على الطلب (اختياري)</label><textarea class="textarea" id="notes" maxlength="200" placeholder="مثال: موعد الاستلام، تغليف هدية…"></textarea></div>
      <div class="row mt" style="gap:16px"><div class="qty"><button type="button" data-q="-1" aria-label="تقليل الكمية">−</button><output id="q" aria-live="polite">1</output><button type="button" data-q="1" aria-label="زيادة الكمية">+</button></div>
        <button class="btn btn-primary" type="button" id="add" ${b.available ? '' : 'disabled'}>أضف للسلة</button>
        <button class="btn btn-wa" type="button" id="wa" ${b.available ? '' : 'disabled'}>اطلب الباقة عبر واتساب</button></div>
      <p class="cl-sub mt">اختيار «اطلب عبر واتساب» يسجّل طلبك في الموقع ثم يفتح محادثة مع فرع ${branch?.name || ''} برسالة جاهزة. الطلب لا يُعتبر مؤكدًا إلا بعد رد الفرع.</p>
    </div></div></div>`);
  const paint = () => { $('#price', el).textContent = money(b.price * qty) + (qty > 1 ? ` (${qty} × ${money(b.price)})` : ''); $('#q', el).textContent = qty; };
  el.addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (q) { qty = Math.min(b.max_qty, Math.max(1, qty + Number(q.dataset.q))); paint(); } });
  $('#add', el).addEventListener('click', () => {
    addToCart({ type: 'bundle', id: b.id, variantId: null, name: b.name, price: b.price, image: b.image, maxQty: b.max_qty, note: $('#notes', el).value.trim() }, qty);
  });
  $('#wa', el).addEventListener('click', () => openWhatsAppOrder(b, qty, $('#notes', el).value.trim()));
  paint();
}

/** Step 1: ask name/phone and register the order. Step 2: a normal link (user click) opens WhatsApp. */
function openWhatsAppOrder(b, qty, notes) {
  const branch = mainBranch(); const u = state.user;
  const key = uid();
  const { el, body, close } = openModal('اطلب الباقة عبر واتساب', html`
    <form class="form" id="wf" novalidate>
      <p class="cl-sub" style="margin:0">${b.name} × ${qty} — ${money(b.price * qty)} · الفرع: ${branch?.name}</p>
      <div class="field"><label for="wn">الاسم</label><input class="input" id="wn" name="name" autocomplete="name" required maxlength="80" value="${u?.name || ''}"></div>
      <div class="field"><label for="wp">رقم الهاتف</label><input class="input" id="wp" name="phone" type="tel" inputmode="tel" autocomplete="tel" required dir="ltr" style="text-align:right" value="${u?.phone ? '0' + u.phone.slice(3) : ''}"></div>
      <div class="notice notice-info" style="margin:0">سنسجّل طلبك أولًا لنعطيك رقمًا، ثم تضغط زر واتساب لإرسال التفاصيل للفرع.</div>
      <div class="row"><button class="btn btn-primary" type="submit" id="wgo">تسجيل الطلب</button>
        <a class="btn btn-ghost" id="wnoreg" href="${waLink(branch?.whatsapp || s0().main_whatsapp, bundleMessage({ bundle: b, qty, notes, branchName: branch?.name }))}" target="_blank" rel="noopener noreferrer">إرسال عبر واتساب بدون تسجيل</a></div>
    </form>`);
  const form = $('#wf', el);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clearFieldErrors(form);
    const btn = $('#wgo', el); btn.disabled = true; btn.textContent = 'جارٍ التسجيل…';
    try {
      const r = await api('/api/orders', { method: 'POST', body: {
        items: [{ type: 'bundle', id: b.id, qty, note: notes }], name: form.name.value, phone: form.phone.value, branchId: branch.id,
        fulfillment: 'pickup', paymentMethod: 'cash', source: 'whatsapp', notes, idempotencyKey: key, expectedTotal: b.price * qty } });
      const msg = bundleMessage({ bundle: b, qty, notes, branchName: branch.name, number: r.order.number, name: form.name.value.trim(), phone: form.phone.value.trim() });
      setHtml(body, html`<div class="notice notice-ok" role="status"><b>تم تسجيل طلبك برقم ${r.order.number}</b><br>حالته الآن «${r.order.status_label}». لم يُؤكَّد بعد — سيؤكده الفرع عبر واتساب أو الهاتف.</div>
        <a class="btn btn-wa btn-block" href="${waLink(branch.whatsapp || s0().main_whatsapp, msg)}" target="_blank" rel="noopener noreferrer">أرسل تفاصيل الطلب إلى فرع ${branch.name} عبر واتساب</a>
        <p class="center mt"><a href="/order/${r.order.number}?t=${r.token}">متابعة حالة الطلب</a></p>`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'تسجيل الطلب';
      if (err.data?.field && showFieldError(form, err.data.field, err.message)) return;
      if (err.code === 'price_changed') { toast('تغيّر سعر الباقة. أعد فتح الصفحة لرؤية السعر الجديد.', 'err'); close(); return; }
      toast(err.message, 'err');
    }
  });
}
const s0 = () => settings();
