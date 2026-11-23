// Admin pages. Each export is a page renderer: ({el, signal, user, boot, refreshBoot, go}) => Promise.
import { html, setHtml, money, fmtDate, $, $$, displayPhone, waLink, raw } from '/js/util.js';
import { api } from '/js/api.js';
import { toast, openModal, confirmDialog } from '/js/ui.js';
import { openForm, table, pager, yesNo, lyd } from '/admin/kit.js';

const STATUS = [['new', 'جديد'], ['confirming', 'قيد التأكيد'], ['preparing', 'قيد التحضير'], ['ready', 'جاهز للاستلام'], ['delivered', 'تم التسليم'], ['cancelled', 'ملغي']];
const PAY = [['unpaid', 'غير مدفوع'], ['pending', 'بانتظار الدفع'], ['paid', 'مدفوع'], ['failed', 'فشل الدفع'], ['cancelled', 'أُلغي الدفع'], ['refunded', 'مسترد']];
const statusChip = (o) => html`<span class="status s-${o.status}">${o.status_label}</span>`;
const payChip = (o) => html`<span class="status p-${o.payment_status}">${o.payment_status_label}</span>`;
const ok = (msg = 'تم الحفظ') => toast(msg, 'ok');

// ── Dashboard ──────────────────────────────────────────────────────────────
export async function dashboard({ el, signal }) {
  const d = await api('/api/admin/dashboard', { signal });
  const c = d.counts; const pend = c.confirming + c.preparing + c.ready;
  const st = d.setup; const steps = [
    ['أضف أول منتج (أو أكثر) من «المنتجات»', st.products > 0, '/admin/products', 'products'],
    ['أضف إعلانات البانر (صور تتبدّل تلقائيًا)', st.banners > 0, '/admin/banners', 'banners'],
    ['أكمل بيانات الفروع: الهاتف ورابط الخريطة', st.branchesIncomplete === 0, '/admin/branches', 'branches'],
    ['اربط بوابة الدفع الإلكتروني (اختياري)', st.gateways > 0, '/admin/payments', 'payments'],
  ]; const done = steps.filter((x) => x[1]).length;
  setHtml(el, html`
    ${done < steps.length ? html`<section class="card2" style="margin-bottom:16px;border-color:var(--gold)"><h2>ابدأ إعداد متجرك <span class="status">${done} من ${steps.length}</span></h2>
      <ul class="tl" style="gap:8px">${steps.map(([t, ok_, href, key]) => html`<li style="border-inline-start-color:${ok_ ? 'var(--ok)' : 'var(--gold)'}">${ok_ ? '✓' : '○'} ${ok_ ? html`<s style="color:var(--muted)">${t}</s>` : html`<a href="${href}" data-r="${key}">${t}</a>`}</li>`)}</ul></section>` : ''}
    <div class="stats">
      <div class="stat ${c.new ? 'hot' : ''}"><b>${c.new}</b><span>طلبات جديدة</span></div>
      <div class="stat"><b>${pend}</b><span>قيد التأكيد / التحضير / الجاهزة</span></div>
      <div class="stat"><b>${c.delivered}</b><span>طلبات مكتملة</span></div>
      <div class="stat"><b>${d.total}</b><span>إجمالي الطلبات</span></div>
      <div class="stat"><b>${money(d.sales)}</b><span>إجمالي المبيعات (المسلَّمة)</span></div>
      <div class="stat"><b>${money(d.open)}</b><span>قيمة الطلبات المفتوحة</span></div>
      <div class="stat"><b>${money(d.paidOnline)}</b><span>مدفوع (مؤكد الدفع)</span></div>
      <div class="stat"><b>${d.openSupport}</b><span>طلبات دعم مفتوحة</span></div>
    </div>
    ${d.gateways.enabled ? '' : html`<div class="notice notice-info mt">الدفع الإلكتروني غير مفعّل بعد. الدفع عند الاستلام هو المتاح للعملاء. أضف مفاتيح بوابتك من <a href="/admin/payments" data-r="payments">بوابات الدفع</a>.</div>`}
    <div class="cols">
      <section class="card2"><h2>الأكثر طلبًا</h2>${d.top.length ? table([{ h: 'الصنف', v: (r) => r.name }, { h: 'الكمية', v: (r) => r.qty }, { h: 'الإيراد', v: (r) => money(r.revenue) }], d.top) : html`<div class="empty">لا توجد طلبات بعد، ستظهر هنا الأصناف الأكثر طلبًا.</div>`}</section>
      <section class="card2"><h2>غير متوفر حاليًا</h2>${d.unavailable.length + d.unavailableBundles.length ? html`<ul style="margin:0;padding-inline-start:18px">${d.unavailable.map((p) => html`<li>${p.name}</li>`)}${d.unavailableBundles.map((p) => html`<li>${p.name} (باقة)</li>`)}</ul>` : html`<div class="empty">كل المنتجات الظاهرة متوفرة.</div>`}</section>
    </div>
    <section class="card2 mt"><h2>أحدث الطلبات</h2>${d.recent.length ? table([
    { h: 'الطلب', v: (o) => html`<a href="/admin/orders" data-r="orders"><b>${o.number}</b></a>` }, { h: 'العميل', v: (o) => o.customer_name }, { h: 'الفرع', v: (o) => o.branch.name },
    { h: 'الإجمالي', v: (o) => money(o.total) }, { h: 'الحالة', v: statusChip }, { h: 'التاريخ', v: (o) => fmtDate(o.created_at) }], d.recent) : html`<div class="empty">لا توجد طلبات بعد.</div>`}</section>`);
}

// ── Orders ─────────────────────────────────────────────────────────────────
export async function orders({ el, signal, user, boot }) {
  const f = { status: '', branch: '', payment: '', q: '', from: '', to: '', page: 1 };
  setHtml(el, html`<form class="bar" id="flt"><select class="select" name="status"><option value="">كل الحالات</option>${STATUS.map(([k, t]) => html`<option value="${k}">${t}</option>`)}</select>
    <select class="select" name="branch"><option value="">كل الفروع</option>${boot.branches.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select>
    <select class="select" name="payment"><option value="">كل حالات الدفع</option>${PAY.map(([k, t]) => html`<option value="${k}">${t}</option>`)}</select>
    <input class="input" name="q" placeholder="بحث: رقم الطلب / الاسم / الهاتف" type="search"><input class="input" name="from" type="date" aria-label="من تاريخ"><input class="input" name="to" type="date" aria-label="إلى تاريخ">
    <button class="btn btn-ghost btn-sm" type="button" id="reload">تحديث</button></form><div id="list"></div>`);
  const list = $('#list', el);
  async function load() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const r = await api(`/api/admin/orders?${qs}`, { signal });
    setHtml(list, html`${table([
      { h: 'الطلب', v: (o) => html`<b>${o.number}</b>${o.source === 'whatsapp' ? html` <span class="status">واتساب</span>` : ''}` }, { h: 'العميل', v: (o) => html`${o.customer_name}<div class="cl-sub"><bdi dir="ltr">${displayPhone(o.customer_phone)}</bdi></div>` },
      { h: 'الفرع', v: (o) => o.branch.name }, { h: 'الإجمالي', v: (o) => money(o.total) }, { h: 'الدفع', v: payChip }, { h: 'الحالة', v: statusChip }, { h: 'التاريخ', v: (o) => fmtDate(o.created_at) }],
    r.items, { empty: 'لا توجد طلبات مطابقة.', rowAttr: (o) => `data-open="${o.id}"` })}${pager(f.page, r.total, r.pageSize)}`);
    list.dataset.items = JSON.stringify(r.items.map((o) => o.number));
  }
  el.addEventListener('input', (e) => { if (e.target.name === 'q') { clearTimeout(orders._t); orders._t = setTimeout(() => { f.q = e.target.value.trim(); f.page = 1; load(); }, 300); } });
  el.addEventListener('change', (e) => { const n = e.target.name; if (n && n in f && n !== 'q') { f[n] = e.target.value; f.page = 1; load(); } });
  $('#reload', el).addEventListener('click', load);
  list.addEventListener('click', (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = Number(p.dataset.page); load(); return; }
    const row = e.target.closest('[data-open]'); if (row) openOrder(row.dataset.open, user, load);
  });
  await load();
}

async function openOrder(id, user, reload) {
  paintOrder(await api(`/api/admin/orders/${id}`), user, reload);
}

function paintOrder(d, user, reload) {
  const o = d.order; let modal;
  const online = o.payment_method.startsWith('online');
  const final = o.status === 'delivered' || o.status === 'cancelled';
  const locked = user.role === 'staff' && final;
  modal = openModal(`طلب ${o.number}`, html`
    <div class="order-grid">
      <div class="panel2"><h3 style="font-size:16px">العميل</h3><dl class="kv"><dt>الاسم</dt><dd>${o.customer_name}</dd><dt>الهاتف</dt><dd><bdi dir="ltr">${displayPhone(o.customer_phone)}</bdi> ${o.customer_phone && o.customer_phone !== 'deleted' ? html`<a href="${waLink(o.customer_phone)}" target="_blank" rel="noopener noreferrer">واتساب</a>` : ''}</dd>
        ${o.customer_email ? html`<dt>البريد</dt><dd>${o.customer_email}</dd>` : ''}<dt>الفرع</dt><dd>${o.branch.name}</dd><dt>الاستلام</dt><dd>${o.fulfillment === 'delivery' ? 'توصيل' : 'من الفرع'}</dd>${o.address ? html`<dt>العنوان</dt><dd>${o.address}</dd>` : ''}
        ${o.notes ? html`<dt>ملاحظات</dt><dd>${o.notes}</dd>` : ''}<dt>التاريخ</dt><dd>${fmtDate(o.created_at)}</dd><dt>المصدر</dt><dd>${o.source === 'whatsapp' ? 'باقة عبر واتساب' : 'الموقع'}</dd></dl></div>
      <div class="panel2"><h3 style="font-size:16px">الدفع</h3><p style="margin:0 0 8px">${payChip(o)} <span class="cl-sub">${online ? 'إلكتروني' : 'عند الاستلام'}</span></p>
        ${d.payments.length ? html`<ul class="tl">${d.payments.map((p) => html`<li><b>${p.provider}</b> — ${p.status} — ${money(p.amount)}<br><small>${p.provider_ref || ''} ${p.failure_reason || ''}</small></li>`)}</ul>` : ''}
        ${online ? html`<p class="cl-sub">حالة الدفع الإلكتروني تأتي من مزوّد الدفع فقط.</p>${o.payment_status === 'paid' ? html`<button class="btn btn-ghost btn-sm" data-pay="refunded" type="button">تسجيل «مسترد» (بعد الاسترداد لدى المزود)</button>` : ''}`
    : html`<div class="row">${o.payment_status !== 'paid' ? html`<button class="btn btn-primary btn-sm" data-pay="paid" type="button">تأكيد استلام المبلغ</button>` : html`<button class="btn btn-ghost btn-sm" data-pay="unpaid" type="button">إلغاء تأكيد الدفع</button><button class="btn btn-ghost btn-sm" data-pay="refunded" type="button">تسجيل «مسترد»</button>`}</div>`}</div></div>
    <h3 class="mt" style="font-size:16px">الأصناف</h3>
    ${table([{ h: 'الصنف', v: (i) => html`${i.name}${i.variant_name ? ` — ${i.variant_name}` : ''}${i.note ? html`<div class="cl-sub">ملاحظة: ${i.note}</div>` : ''}` }, { h: 'السعر', v: (i) => money(i.unit_price) }, { h: 'الكمية', v: (i) => i.quantity }, { h: 'المجموع', v: (i) => money(i.line_total) }], o.items)}
    <p style="text-align:end;margin:10px 0">${o.delivery_fee ? html`رسوم التوصيل: ${money(o.delivery_fee)} · ` : ''}<b style="font-size:18px">الإجمالي: ${money(o.total)}</b></p>
    <div class="panel2"><h3 style="font-size:16px">تحديث الحالة</h3>${locked ? html`<p class="cl-sub">الطلب مكتمل/ملغي — تعديله للمدير فقط.</p>` : html`
      <form class="form" id="stf"><div class="fgrid"><div class="field"><label for="st">الحالة</label><select class="select" id="st" name="status">${STATUS.map(([k, t]) => html`<option value="${k}" ${k === o.status ? 'selected' : ''}>${t}</option>`)}</select></div>
      <div class="field"><label for="sn">ملاحظة (اختياري)</label><input class="input" id="sn" name="note" maxlength="300"></div></div>
      ${!online ? html`<label class="check"><input type="checkbox" name="markPaid" ${o.payment_status === 'paid' ? 'disabled' : ''}> عند «تم التسليم»: سجّل أنه تم استلام المبلغ</label>` : ''}
      <div><button class="btn btn-primary" type="submit">حفظ الحالة</button></div></form>`}</div>
    <h3 class="mt" style="font-size:16px">سجل الطلب</h3><ul class="tl">${o.events.map((e) => html`<li>${e.kind === 'status' ? `الحالة: ${e.from_value || ''} ← ${e.to_value}` : e.kind === 'payment' ? `الدفع: ${e.from_value || ''} ← ${e.to_value}` : e.note || e.kind}${e.kind !== 'created' && e.note ? ` — ${e.note}` : ''}<br><small>${fmtDate(e.created_at)}</small></li>`)}</ul>`, { wide: true });
  const refresh = async () => { modal.close(); reload?.(); const nd = await api(`/api/admin/orders/${o.id}`); paintOrder(nd, user, reload); };
  $('#stf', modal.el)?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api(`/api/admin/orders/${o.id}/status`, { method: 'POST', body: { status: f.status.value, note: f.note.value, markPaid: f.markPaid?.checked } }); ok('تم تحديث الحالة'); await refresh(); }
    catch (err) { toast(err.message, 'err'); }
  });
  $$('[data-pay]', modal.el).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/admin/orders/${o.id}/payment`, { method: 'POST', body: { status: b.dataset.pay } }); ok('تم تحديث حالة الدفع'); await refresh(); } catch (err) { toast(err.message, 'err'); }
  }));
}

// ── Products ───────────────────────────────────────────────────────────────
const productFields = (cats) => [
  { name: 'name', label: 'اسم المنتج', required: true, max: 100, wide: true },
  { name: 'category_id', label: 'القسم', type: 'select', options: cats.filter((c) => c.kind === 'products').map((c) => [c.id, c.name]) },
  { name: 'price', label: 'السعر (د.ل)', type: 'price', required: true, hint: 'يُستخدم عند عدم وجود أحجام/خيارات' },
  { name: 'compare_price', label: 'السعر السابق (اختياري)', type: 'price', hint: 'يظهر مشطوبًا إن كان أعلى من السعر' },
  { name: 'description', label: 'الوصف', type: 'textarea', wide: true, rows: 3 },
  { name: 'image', label: 'الصورة (اختيارية)', type: 'image' },
  { name: 'variants', label: 'الأحجام / الخيارات (لكل خيار سعره)', type: 'repeater', addText: 'إضافة خيار', hint: 'إن وُجدت خيارات فسعرها يحل محل السعر الأساسي.', sub: [{ name: 'name', label: 'اسم الخيار (مثل: صغير)', flex: 2 }, { name: 'price', label: 'السعر (د.ل)', type: 'price' }, { name: 'available', label: 'متوفر', type: 'checkbox', def: true }] },
  { name: 'keywords', label: 'كلمات مرتبطة للبحث (اختياري)', wide: true, hint: 'مثال: بقلاوة، فستق' },
  { name: 'sort_order', label: 'الترتيب', type: 'number', def: 0 },
  { name: 'available', label: 'متوفر للطلب', type: 'checkbox', def: true }, { name: 'active', label: 'ظاهر في المتجر', type: 'checkbox', def: true },
];

export async function products({ el, signal, refreshBoot }) {
  const cats = (await api('/api/admin/categories', { signal })).items;
  const f = { q: '', category: '', page: 1 };
  setHtml(el, html`<div class="bar"><input class="input" id="pq" type="search" placeholder="بحث باسم المنتج"><select class="select" id="pc"><option value="">كل الأقسام</option>${cats.filter((c) => c.kind === 'products').map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select><span class="sp"></span><button class="btn btn-primary" id="addp" type="button">＋ منتج جديد</button></div><div id="list"></div>`);
  const list = $('#list', el);
  async function load() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const r = await api(`/api/admin/products?${qs}`, { signal });
    setHtml(list, html`${table([
      { h: 'صورة', v: (p) => (p.image ? raw(`<img class="thumb" src="${p.image}" alt="" loading="lazy">`) : '—') }, { h: 'المنتج', v: (p) => html`<b>${p.name}</b>${p.variant_count ? html`<div class="cl-sub">${p.variant_count} خيارات</div>` : ''}` },
      { h: 'القسم', v: (p) => p.category_name }, { h: 'السعر', v: (p) => money(p.price) },
      { h: 'متوفر', v: (p) => html`<label class="sw"><input type="checkbox" role="switch" data-avail="${p.id}" ${p.available ? 'checked' : ''} aria-label="التوفر"></label>` }, { h: 'ظاهر', v: (p) => yesNo(p.active) },
      { h: 'إجراءات', v: (p) => html`<span class="acts"><button class="btn btn-ghost mini" data-edit="${p.id}" type="button">تعديل</button><button class="btn btn-ghost mini" data-del="${p.id}" data-name="${p.name}" type="button" style="color:var(--err)">حذف</button></span>` }], r.items, { empty: 'لا توجد منتجات بعد. اضغط «منتج جديد» لإضافة أول منتج.' })}${pager(f.page, r.total, r.pageSize)}`);
  }
  const edit = async (id) => {
    const p = id ? await api(`/api/admin/products/${id}`) : { available: true, active: true, category_id: cats.find((c) => c.kind === 'products')?.id, variants: [], sort_order: 0 };
    openForm({ title: id ? 'تعديل المنتج' : 'منتج جديد', fields: productFields(cats), values: p, onSubmit: async (v, close) => {
      v.variants = v.variants.map((x) => ({ ...x }));
      await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: v }); close(); ok(); load();
    } });
  };
  $('#addp', el).addEventListener('click', () => edit(0));
  $('#pq', el).addEventListener('input', (e) => { clearTimeout(products._t); products._t = setTimeout(() => { f.q = e.target.value.trim(); f.page = 1; load(); }, 300); });
  $('#pc', el).addEventListener('change', (e) => { f.category = e.target.value; f.page = 1; load(); });
  list.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = Number(p.dataset.page); load(); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) return edit(ed.dataset.edit);
    const del = e.target.closest('[data-del]');
    if (del && await confirmDialog('حذف المنتج', `سيُحذف «${del.dataset.name}» نهائيًا. (الطلبات السابقة تحتفظ باسمه وسعره). للإخفاء المؤقت استخدم «ظاهر في المتجر» من التعديل.`, { ok: 'حذف', danger: true })) {
      await api(`/api/admin/products/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); load();
    }
  });
  list.addEventListener('change', async (e) => {
    const a = e.target.closest('[data-avail]'); if (!a) return;
    try { await api(`/api/admin/products/${a.dataset.avail}/availability`, { method: 'PATCH', body: { available: a.checked } }); ok(a.checked ? 'أصبح متوفرًا' : 'أصبح غير متوفر'); }
    catch (err) { a.checked = !a.checked; toast(err.message, 'err'); }
  });
  await load();
}

// ── Categories ─────────────────────────────────────────────────────────────
export async function categories({ el, signal, refreshBoot }) {
  async function load() {
    const { items } = await api('/api/admin/categories', { signal });
    setHtml(el, html`<div class="bar"><p class="cl-sub" style="margin:0">«الكل» قسم تلقائي يعرض كل المنتجات. قسم «باقات المناسبات» أساسي (يمكن إخفاؤه أو إعادة تسميته).</p><span class="sp"></span><button class="btn btn-primary" id="addc" type="button">＋ قسم جديد</button></div>
      ${table([{ h: 'الترتيب', v: (c) => c.sort_order }, { h: 'القسم', v: (c) => html`<b>${c.name}</b>${c.kind === 'bundles' ? html` <span class="status">باقات</span>` : ''}` }, { h: 'المنتجات', v: (c) => (c.kind === 'bundles' ? '—' : c.product_count) }, { h: 'ظاهر', v: (c) => yesNo(c.active) },
      { h: 'إجراءات', v: (c) => html`<span class="acts"><button class="btn btn-ghost mini" data-edit="${c.id}" type="button">تعديل</button>${c.kind === 'bundles' ? '' : html`<button class="btn btn-ghost mini" data-del="${c.id}" data-name="${c.name}" type="button" style="color:var(--err)">حذف</button>`}</span>` }], items)}`);
    const fields = [{ name: 'name', label: 'اسم القسم', required: true, max: 40 }, { name: 'sort_order', label: 'الترتيب (الأصغر يظهر أولًا)', type: 'number', def: 0 }, { name: 'active', label: 'ظاهر في المتجر', type: 'checkbox', def: true }];
    const edit = (c) => openForm({ title: c ? 'تعديل القسم' : 'قسم جديد', fields, values: c || { active: true, sort_order: (items.length + 1) * 10 }, onSubmit: async (v, close) => { await api(c ? `/api/admin/categories/${c.id}` : '/api/admin/categories', { method: c ? 'PUT' : 'POST', body: v }); close(); ok(); await refreshBoot(); load(); } });
    $('#addc', el).onclick = () => edit(null);
    el.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) return edit(items.find((c) => c.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('حذف القسم', `حذف «${del.dataset.name}»؟`, { ok: 'حذف', danger: true })) {
        try { await api(`/api/admin/categories/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); await refreshBoot(); load(); } catch (err) { toast(err.message, 'err', { ms: 6000 }); }
      }
    };
  }
  await load();
}

// ── Bundles ────────────────────────────────────────────────────────────────
const bundleFields = [
  { name: 'name', label: 'اسم الباقة', required: true, max: 100, wide: true },
  { name: 'price', label: 'السعر (د.ل)', type: 'price', required: true }, { name: 'max_qty', label: 'أقصى كمية للطلب الواحد', type: 'number', def: 10 },
  { name: 'description', label: 'وصف الباقة', type: 'textarea', wide: true, rows: 3 }, { name: 'image', label: 'الصورة (اختيارية)', type: 'image' },
  { name: 'items', label: 'محتويات الباقة', type: 'repeater', addText: 'إضافة محتوى', sub: [{ name: 'label', label: 'الصنف (مثل: بكلاوه مشكلة 1 كغ)', flex: 3 }, { name: 'quantity', label: 'العدد', type: 'number', def: 1 }] },
  { name: 'keywords', label: 'كلمات مرتبطة للبحث', wide: true }, { name: 'sort_order', label: 'الترتيب', type: 'number', def: 0 },
  { name: 'available', label: 'متوفرة للطلب', type: 'checkbox', def: true }, { name: 'active', label: 'ظاهرة في المتجر', type: 'checkbox', def: true },
];
export async function bundles({ el, signal }) {
  async function load() {
    const { items } = await api('/api/admin/bundles', { signal });
    setHtml(el, html`<div class="bar"><span class="sp"></span><button class="btn btn-primary" id="addb" type="button">＋ باقة جديدة</button></div>
      ${table([{ h: 'صورة', v: (b) => (b.image ? raw(`<img class="thumb" src="${b.image}" alt="" loading="lazy">`) : '—') }, { h: 'الباقة', v: (b) => html`<b>${b.name}</b><div class="cl-sub">${b.item_count} محتويات</div>` }, { h: 'السعر', v: (b) => money(b.price) },
      { h: 'متوفرة', v: (b) => yesNo(b.available) }, { h: 'ظاهرة', v: (b) => yesNo(b.active) },
      { h: 'إجراءات', v: (b) => html`<span class="acts"><button class="btn btn-ghost mini" data-edit="${b.id}" type="button">تعديل</button><button class="btn btn-ghost mini" data-del="${b.id}" data-name="${b.name}" type="button" style="color:var(--err)">حذف</button></span>` }], items, { empty: 'لا توجد باقات بعد. أضف أول باقة مناسبات.' })}`);
    const edit = async (id) => {
      const b = id ? await api(`/api/admin/bundles/${id}`) : { available: true, active: true, items: [], max_qty: 10, sort_order: 0 };
      openForm({ title: id ? 'تعديل الباقة' : 'باقة جديدة', fields: bundleFields, values: b, onSubmit: async (v, close) => { await api(id ? `/api/admin/bundles/${id}` : '/api/admin/bundles', { method: id ? 'PUT' : 'POST', body: v }); close(); ok(); load(); } });
    };
    $('#addb', el).onclick = () => edit(0);
    el.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) return edit(ed.dataset.edit);
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('حذف الباقة', `حذف «${del.dataset.name}» نهائيًا؟`, { ok: 'حذف', danger: true })) { await api(`/api/admin/bundles/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); load(); }
    };
  }
  await load();
}

// ── Banners ────────────────────────────────────────────────────────────────
const bannerFields = [
  { name: 'image', label: 'صورة الإعلان (تُعرض كشريحة ضمن البانر المتغيّر)', type: 'image', max: 1600, hint: 'يفضّل صورة أفقية 1600×650. أضف عدة إعلانات لتتبدّل تلقائيًا.' },
  { name: 'title', label: 'العنوان (اختياري إذا وُجدت صورة)', max: 100, wide: true }, { name: 'description', label: 'الوصف (اختياري)', type: 'textarea', rows: 2, wide: true }, { name: 'button_text', label: 'نص الزر (مثل: اكتشف منتجاتنا)' }, { name: 'link', label: 'الرابط (داخلي مثل /shop أو https://…)', dir: 'ltr' },
  { name: 'starts_at', label: 'يبدأ في (اختياري)', type: 'datetime' }, { name: 'ends_at', label: 'ينتهي في (اختياري)', type: 'datetime' }, { name: 'sort_order', label: 'الترتيب', type: 'number', def: 0 }, { name: 'active', label: 'مفعّل', type: 'checkbox', def: true },
];
export async function banners({ el, signal }) {
  async function load() {
    const { items } = await api('/api/admin/banners', { signal });
    const now = Date.now(); const live = (b) => b.active && (!b.starts_at || Date.parse(b.starts_at) <= now) && (!b.ends_at || Date.parse(b.ends_at) >= now);
    setHtml(el, html`<div class="bar"><p class="cl-sub" style="margin:0">كل إعلان نشط ضمن فترته يظهر كشريحة في البانر الذي يتبدّل تلقائيًا (المدة من «الإعدادات»). الترتيب الأصغر أولًا.</p><span class="sp"></span><button class="btn btn-primary" id="addn" type="button">＋ إعلان جديد</button></div>
      ${table([{ h: 'الإعلان', v: (b) => html`${b.image ? raw(`<img class="thumb" src="${b.image}" alt="" loading="lazy" style="float:inline-start;margin-inline-end:10px;width:72px;height:44px">`) : ''}<b>${b.title || '(صورة فقط)'}</b><div class="cl-sub">${b.description}</div>` }, { h: 'الترتيب', v: (b) => b.sort_order }, { h: 'الفترة', v: (b) => (b.starts_at || b.ends_at ? html`${b.starts_at ? fmtDate(b.starts_at) : '…'} ← ${b.ends_at ? fmtDate(b.ends_at) : '…'}` : 'دائم') },
      { h: 'الحالة', v: (b) => (live(b) ? html`<span class="status s-delivered">يُعرض الآن</span>` : b.active ? html`<span class="status s-preparing">خارج الفترة</span>` : html`<span class="status s-cancelled">معطّل</span>`) },
      { h: 'إجراءات', v: (b) => html`<span class="acts"><button class="btn btn-ghost mini" data-edit="${b.id}" type="button">تعديل</button><button class="btn btn-ghost mini" data-del="${b.id}" type="button" style="color:var(--err)">حذف</button></span>` }], items, { empty: 'لا توجد إعلانات. بدونها تظهر مقدمة المتجر الافتراضية.' })}`);
    const edit = (b) => openForm({ title: b ? 'تعديل الإعلان' : 'إعلان جديد', fields: bannerFields, values: b || { active: true, sort_order: 0 }, onSubmit: async (v, close) => { await api(b ? `/api/admin/banners/${b.id}` : '/api/admin/banners', { method: b ? 'PUT' : 'POST', body: v }); close(); ok(); load(); } });
    $('#addn', el).onclick = () => edit(null);
    el.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) return edit(items.find((x) => x.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('حذف الإعلان', 'حذف هذا الإعلان؟', { ok: 'حذف', danger: true })) { await api(`/api/admin/banners/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); load(); }
    };
  }
  await load();
}

// ── Branches ───────────────────────────────────────────────────────────────
const branchFields = [
  { name: 'name', label: 'اسم الفرع', required: true, max: 60 }, { name: 'sort_order', label: 'الترتيب', type: 'number', def: 0 },
  { name: 'address', label: 'العنوان', wide: true, hint: 'اتركه فارغًا إن لم يتوفر — لن يُعرض عنوان مخترع' },
  { name: 'phone', label: 'رقم الهاتف', type: 'tel', dir: 'ltr' }, { name: 'whatsapp', label: 'رقم واتساب (اختياري)', type: 'tel', dir: 'ltr', hint: 'يقبل 09… أو 2189…' },
  { name: 'maps_url', label: 'رابط الخريطة (Google Maps — https)', type: 'url', dir: 'ltr', wide: true, hint: 'افتح الفرع في Google Maps ثم «مشاركة» وانسخ الرابط. لا يظهر زر الخريطة بدونه.' },
  { name: 'hours', label: 'ساعات العمل', wide: true }, { name: 'accepts_orders', label: 'يستقبل الطلبات', type: 'checkbox', def: true }, { name: 'delivers', label: 'يوفّر التوصيل', type: 'checkbox', def: false }, { name: 'active', label: 'ظاهر في المتجر', type: 'checkbox', def: true },
];
export async function branches({ el, signal, refreshBoot }) {
  async function load() {
    const { items } = await api('/api/admin/branches', { signal });
    setHtml(el, html`<div class="bar"><span class="sp"></span><button class="btn btn-primary" id="addbr" type="button">＋ فرع جديد</button></div>
      ${table([{ h: 'الفرع', v: (b) => html`<b>${b.name}</b>` }, { h: 'الهاتف', v: (b) => (b.phone ? html`<bdi dir="ltr">${displayPhone(b.phone)}</bdi>` : html`<span class="cl-sub">لم يُضف</span>`) }, { h: 'العنوان', v: (b) => b.address || html`<span class="cl-sub">لم يُضف</span>` },
      { h: 'الخريطة', v: (b) => (b.maps_url ? html`<a href="${b.maps_url}" target="_blank" rel="noopener noreferrer">فتح</a>` : html`<span class="cl-sub">لم يُضف</span>`) }, { h: 'يستقبل طلبات', v: (b) => yesNo(b.accepts_orders) }, { h: 'ظاهر', v: (b) => yesNo(b.active) },
      { h: 'إجراءات', v: (b) => html`<span class="acts"><button class="btn btn-ghost mini" data-edit="${b.id}" type="button">تعديل</button><button class="btn btn-ghost mini" data-del="${b.id}" data-name="${b.name}" type="button" style="color:var(--err)">حذف</button></span>` }], items)}`);
    const edit = (b) => openForm({ title: b ? `تعديل فرع ${b.name}` : 'فرع جديد', fields: branchFields, values: b || { active: true, accepts_orders: true, sort_order: (items.length + 1) * 10 }, onSubmit: async (v, close) => { await api(b ? `/api/admin/branches/${b.id}` : '/api/admin/branches', { method: b ? 'PUT' : 'POST', body: v }); close(); ok(); await refreshBoot(); load(); } });
    $('#addbr', el).onclick = () => edit(null);
    el.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) return edit(items.find((x) => x.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('حذف الفرع', `حذف فرع «${del.dataset.name}»؟ الطلبات السابقة تحتفظ باسمه.`, { ok: 'حذف', danger: true })) {
        try { await api(`/api/admin/branches/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); await refreshBoot(); load(); } catch (err) { toast(err.message, 'err', { ms: 6000 }); }
      }
    };
  }
  await load();
}

// ── Customers & support ────────────────────────────────────────────────────
export async function customers({ el, signal, user }) {
  let tab = 'support'; const f = { q: '', page: 1 };
  const shell = () => setHtml(el, html`<div class="tabs" role="tablist"><button class="tab" role="tab" data-t="support" aria-selected="${tab === 'support'}">طلبات الدعم</button><button class="tab" role="tab" data-t="customers" aria-selected="${tab === 'customers'}">العملاء</button></div><div id="tb"></div>`);
  const resetLink = async (c) => {
    const r = await api(`/api/admin/customers/${c.id}/reset-link`, { method: 'POST' });
    const phone = c.phone;
    const msg = `السلام عليكم ${c.name}، هذا رابط خاص لتعيين كلمة مرور جديدة لحسابك في عالم البكلاوه (صالح لمدة ساعة ولمرة واحدة):\n${r.url}`;
    const { el: m } = openModal('رابط استعادة الحساب', html`<div class="notice notice-warn">أرسل الرابط فقط بعد التحقق من هوية العميل (مثلًا بالاتصال على رقمه المسجّل). الرابط صالح ${r.expiresInMinutes} دقيقة ولمرة واحدة ولن يظهر مرة أخرى.</div>
      <div class="linkbox"><input class="input" id="lk" readonly value="${r.url}"><button class="btn btn-primary btn-sm" id="cp" type="button">نسخ</button></div>
      ${phone ? html`<p class="mt"><a class="btn btn-wa btn-sm" href="${waLink(phone, msg)}" target="_blank" rel="noopener noreferrer">إرسال للعميل عبر واتساب</a></p>` : ''}`);
    $('#cp', m).onclick = async () => { try { await navigator.clipboard.writeText(r.url); ok('تم النسخ'); } catch { $('#lk', m).select(); } };
  };
  async function paint() {
    const tb = $('#tb', el); $$('[data-t]', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === tab)));
    if (tab === 'support') {
      const { items } = await api('/api/admin/support', { signal });
      const KIND = { password: 'نسيت كلمة المرور', identifier: 'نسيت البريد/الهاتف', deletion: 'حذف حساب', other: 'أخرى' };
      setHtml(tb, table([{ h: 'النوع', v: (s) => KIND[s.kind] }, { h: 'الاسم', v: (s) => s.name || '—' }, { h: 'الهاتف', v: (s) => (s.phone ? html`<bdi dir="ltr">${displayPhone(s.phone)}</bdi>` : '—') }, { h: 'الرسالة', v: (s) => s.message },
      { h: 'الحالة', v: (s) => html`<select class="select" data-sup="${s.id}" style="min-height:36px;width:auto">${[['open', 'مفتوح'], ['in_progress', 'قيد المعالجة'], ['resolved', 'تم']].map(([k, t]) => html`<option value="${k}" ${k === s.status ? 'selected' : ''}>${t}</option>`)}</select>` },
      { h: 'التاريخ', v: (s) => fmtDate(s.created_at) },
      { h: 'إجراء', v: (s) => (s.kind === 'password' || s.kind === 'identifier') && s.phone && user.role === 'admin' ? html`<button class="btn btn-ghost mini" data-find="${s.phone}" type="button">بحث عن الحساب</button>` : '' }], items, { empty: 'لا توجد طلبات دعم.' }));
    } else {
      const r = await api(`/api/admin/customers?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`, { signal });
      setHtml(tb, html`<div class="bar"><input class="input" id="cq" type="search" placeholder="بحث: الاسم / الهاتف / البريد" value="${f.q}"></div>${table([{ h: 'العميل', v: (c) => html`<b>${c.name}</b>` }, { h: 'الهاتف', v: (c) => (c.phone ? html`<bdi dir="ltr">${displayPhone(c.phone)}</bdi>` : '—') }, { h: 'البريد', v: (c) => c.email || '—' },
      { h: 'الطلبات', v: (c) => c.orders }, { h: 'تاريخ التسجيل', v: (c) => fmtDate(c.created_at) }, { h: 'إجراء', v: (c) => (user.role === 'admin' ? html`<button class="btn btn-ghost mini" data-reset="${c.id}" type="button">رابط استعادة</button>` : '') }], r.items, { empty: 'لا يوجد عملاء مسجّلون بعد.' })}${pager(f.page, r.total, r.pageSize)}`);
      tb._items = r.items;
    }
  }
  shell(); await paint();
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-t]'); if (t) { tab = t.dataset.t; paint(); return; }
    const p = e.target.closest('[data-page]'); if (p) { f.page = Number(p.dataset.page); paint(); return; }
    const rs = e.target.closest('[data-reset]'); if (rs) { const c = $('#tb', el)._items.find((x) => x.id === Number(rs.dataset.reset)); if (await confirmDialog('إنشاء رابط استعادة', `هل تحققت من هوية ${c.name}؟ سيُنشأ رابط يتيح تعيين كلمة مرور جديدة.`, { ok: 'إنشاء الرابط' })) resetLink(c).catch((er) => toast(er.message, 'err')); return; }
    const fd = e.target.closest('[data-find]'); if (fd) { tab = 'customers'; f.q = displayPhone(fd.dataset.find); shell(); paint(); }
  });
  el.addEventListener('change', async (e) => { const s = e.target.closest('[data-sup]'); if (s) { try { await api(`/api/admin/support/${s.dataset.sup}`, { method: 'PATCH', body: { status: s.value } }); ok('تم تحديث الحالة'); } catch (err) { toast(err.message, 'err'); } } });
  el.addEventListener('input', (e) => { if (e.target.id === 'cq') { clearTimeout(customers._t); customers._t = setTimeout(() => { f.q = e.target.value.trim(); f.page = 1; paint().then(() => { const i = $('#cq', el); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); } });
}

// ── Settings ───────────────────────────────────────────────────────────────
const SECTION_LABELS = { hero: 'المقدمة / الإعلان', products: 'الأقسام والمنتجات', bundles: 'باقات المناسبات', branches: 'الفروع', about: 'من نحن', contact: 'التواصل' };
export async function settings({ el, signal, refreshBoot }) {
  const { settings: s } = await api('/api/admin/settings', { signal });
  const branches = (await api('/api/admin/branches', { signal })).items;
  let sections = s.home_sections.map((x) => ({ ...x }));
  const T = (name, label, type = 'text', extra = '') => html`<div class="field"><label for="s_${name}">${label}</label><input class="input" id="s_${name}" name="${name}" type="${type}" value="${type === 'number' ? lyd(s[name]) : s[name] ?? ''}" ${extra}></div>`;
  const A = (name, label, rows = 4) => html`<div class="field wide"><label for="s_${name}">${label}</label><textarea class="textarea" id="s_${name}" name="${name}" rows="${rows}">${s[name] ?? ''}</textarea></div>`;
  const C = (name, label, hint = '') => html`<div class="field wide"><label class="check"><input type="checkbox" name="${name}" ${s[name] ? 'checked' : ''}> ${label}</label>${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
  const paintSections = () => setHtml($('#secs', el), html`<ul class="tl" style="gap:6px">${sections.map((x, i) => html`<li style="display:flex;align-items:center;gap:10px;border:0;padding:6px 10px;background:#fff;border:1px solid var(--line);border-radius:10px"><label class="check" style="flex:1"><input type="checkbox" data-sec="${i}" ${x.enabled ? 'checked' : ''}> ${SECTION_LABELS[x.key]}</label><span class="updown"><button class="btn btn-ghost mini" type="button" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="أعلى">↑</button><button class="btn btn-ghost mini" type="button" data-down="${i}" ${i === sections.length - 1 ? 'disabled' : ''} aria-label="أسفل">↓</button></span></li>`)}</ul>`);
  setHtml(el, html`<form id="sf" class="form" novalidate>
    <section class="sect panel2"><h2>الهوية</h2><div class="fgrid">${T('brand_name_ar', 'اسم المتجر (عربي)')}${T('brand_name_en', 'الاسم الإنجليزي', 'text', 'dir="ltr"')}${T('tagline', 'الوصف المختصر')}${A('meta_description', 'وصف محركات البحث (SEO)', 2)}
      <div class="field wide" id="logo-box"><span class="label">الشعار</span><input type="hidden" name="logo_url" value="${s.logo_url}"><div class="img-pick"><div class="img-prev" style="width:110px;height:110px;border-radius:50%">${s.logo_url ? raw(`<img src="${s.logo_url}" alt="">`) : html`<span class="cl-sub" style="text-align:center">لم يُرفع شعار</span>`}</div>
      <div><label class="btn btn-ghost btn-sm" style="cursor:pointer">رفع الشعار الأصلي<input type="file" accept="image/*" hidden id="logo-file"></label> <button type="button" class="btn btn-ghost btn-sm" id="logo-rm" ${s.logo_url ? '' : 'hidden'}>إزالة</button><p class="hint cl-sub">يُقصّ تلقائيًا داخل دائرة بخلفية عنابية دون تعديل الملف الأصلي. ارفع الشعار الأصلي بدون تعديل.</p></div></div></div></div></section>
    <section class="sect panel2"><h2>التواصل</h2><div class="fgrid">${T('support_phone', 'هاتف دعم العملاء', 'tel', 'dir="ltr"')}${T('support_whatsapp', 'واتساب الدعم (بصيغة دولية)', 'tel', 'dir="ltr"')}
      <div class="field"><label for="s_main_branch_slug">فرع الواتساب الرئيسي (للباقات)</label><select class="select" id="s_main_branch_slug" name="main_branch_slug">${branches.map((b) => html`<option value="${b.slug}" ${b.slug === s.main_branch_slug ? 'selected' : ''}>${b.name}</option>`)}</select></div>
      ${T('tiktok_handle', 'حساب تيك توك (بدون @)', 'text', 'dir="ltr"')}${T('tiktok_url', 'رابط تيك توك', 'url', 'dir="ltr"')}</div>
      <p class="hint cl-sub">رقم واتساب فرع سوق الجمعة وهاتفه يُعدَّلان من «الفروع».</p></section>
    <section class="sect panel2"><h2>البانر الإعلاني</h2><div class="fgrid"><div class="field"><label for="s_banner_interval_s">مدة بقاء كل صورة (بالثواني)</label><input class="input" id="s_banner_interval_s" name="banner_interval_s" type="number" min="1.5" max="15" step="0.5" value="${(s.banner_interval_ms || 2500) / 1000}"><span class="hint">الافتراضي 2.5 ثانية. تُضاف الصور من «الإعلانات».</span></div></div></section>
    <section class="sect panel2"><h2>المقدمة (تظهر عند عدم وجود إعلان نشط)</h2><div class="fgrid">${T('hero_title', 'العنوان')}${T('hero_button_text', 'نص الزر')}${A('hero_text', 'النص', 2)}${T('hero_button_link', 'رابط الزر', 'text', 'dir="ltr"')}</div></section>
    <section class="sect panel2"><h2>ترتيب أقسام الصفحة الرئيسية</h2><div id="secs"></div></section>
    <section class="sect panel2"><h2>من نحن والسياسات</h2><div class="fgrid">${T('about_title', 'عنوان «من نحن»')}<span></span>${A('about_text', 'نص «من نحن»', 5)}${A('privacy_text', 'سياسة الخصوصية', 6)}${A('terms_text', 'شروط الاستخدام', 6)}${A('rights_text', 'حقوق العملاء', 5)}</div><p class="hint cl-sub">النصوص الافتراضية مسودات عامة — راجعها وعدّلها بما يناسب نشاطك قبل الاعتماد.</p></section>
    <section class="sect panel2"><h2>التوصيل</h2><div class="fgrid">${C('delivery_enabled', 'تفعيل التوصيل', 'لا يظهر خيار التوصيل للعميل ما لم يُفعَّل هنا وفي الفرع المعني.')}${T('delivery_fee', 'رسوم التوصيل (د.ل)', 'number', 'step="0.001" min="0"')}${T('delivery_note', 'ملاحظة التوصيل')}</div></section>
    <section class="sect panel2"><h2>الدفع والعملة</h2><div class="fgrid">${C('cash_enabled', 'الدفع عند الاستلام')}
      <div class="field wide"><span class="hint">الدفع الإلكتروني وبوابات الدفع تُضبط من صفحة <a href="/admin/payments" data-r="payments">بوابات الدفع</a>.</span></div>
      ${T('currency', 'رمز العملة', 'text', 'dir="ltr" maxlength="3"')}${T('currency_label', 'اسم العملة المعروض')}</div></section>
    <div class="savebar"><button class="btn btn-primary" type="submit">حفظ الإعدادات</button></div></form>`);
  paintSections();
  const f = $('#sf', el);
  el.addEventListener('click', (e) => {
    const up = e.target.closest('[data-up]'); const dn = e.target.closest('[data-down]');
    if (up) { const i = +up.dataset.up; [sections[i - 1], sections[i]] = [sections[i], sections[i - 1]]; paintSections(); }
    if (dn) { const i = +dn.dataset.down; [sections[i + 1], sections[i]] = [sections[i], sections[i + 1]]; paintSections(); }
  });
  el.addEventListener('change', (e) => { const c = e.target.closest('[data-sec]'); if (c) sections[+c.dataset.sec].enabled = c.checked; });
  const { uploadImage } = await import('/admin/kit.js');
  $('#logo-file', el).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return; const prev = $('#logo-box .img-prev', el);
    try { const url = await uploadImage(file, { max: 1024 }); f.logo_url.value = url; prev.innerHTML = `<img src="${url}" alt="">`; $('#logo-rm', el).hidden = false; } catch (err) { toast(err.message, 'err'); }
  });
  $('#logo-rm', el).addEventListener('click', () => { f.logo_url.value = ''; $('#logo-box .img-prev', el).innerHTML = '<span class="cl-sub" style="text-align:center">لم يُرفع شعار</span>'; $('#logo-rm', el).hidden = true; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); const b = f.querySelector('[type=submit]'); b.disabled = true;
    const body = {};
    for (const i of f.elements) { if (!i.name) continue; body[i.name] = i.type === 'checkbox' ? i.checked : i.value; }
    body.home_sections = sections; body.banner_interval_ms = Math.round(Number(body.banner_interval_s) * 1000); delete body.banner_interval_s;
    try { await api('/api/admin/settings', { method: 'PUT', body }); await refreshBoot(); ok('تم حفظ الإعدادات. تظهر التغييرات فورًا في المتجر.'); }
    catch (err) { toast(err.message, 'err', { ms: 6000 }); }
    b.disabled = false;
  });
}

// ── Team + audit log ───────────────────────────────────────────────────────
export async function team({ el, signal, user }) {
  async function load() {
    const [{ items }, aud] = await Promise.all([api('/api/admin/staff', { signal }), api('/api/admin/audit', { signal })]);
    setHtml(el, html`<div class="bar"><p class="cl-sub" style="margin:0">الموظف يدير الطلبات والدعم فقط. المدير يملك كل الصلاحيات.</p><span class="sp"></span><button class="btn btn-primary" id="addt" type="button">＋ إضافة موظف / مدير</button></div>
      ${table([{ h: 'الاسم', v: (u) => html`<b>${u.name}</b>` }, { h: 'البريد', v: (u) => u.email || '—' }, { h: 'الدور', v: (u) => (u.role === 'admin' ? 'مدير' : 'موظف') }, { h: 'آخر دخول', v: (u) => (u.last_login_at ? fmtDate(u.last_login_at) : '—') },
      { h: 'إجراء', v: (u) => (u.id === user.id ? html`<span class="cl-sub">أنت</span>` : html`<button class="btn btn-ghost mini" data-del="${u.id}" data-name="${u.name}" type="button" style="color:var(--err)">إزالة</button>`) }], items)}
      <h2 class="mt2" style="font-size:18px">آخر العمليات</h2>${table([{ h: 'الوقت', v: (a) => fmtDate(a.created_at) }, { h: 'المستخدم', v: (a) => a.user_name || '—' }, { h: 'العملية', v: (a) => a.action }, { h: 'العنصر', v: (a) => `${a.entity || ''} ${a.entity_id || ''}` }], aud.items, { empty: 'لا توجد عمليات مسجّلة.' })}`);
    $('#addt', el).onclick = () => openForm({ title: 'إضافة حساب إدارة', fields: [
      { name: 'name', label: 'الاسم', required: true }, { name: 'email', label: 'البريد الإلكتروني', type: 'email', required: true, dir: 'ltr' }, { name: 'password', label: 'كلمة مرور مؤقتة (8 أحرف+)', type: 'password', required: true },
      { name: 'role', label: 'الدور', type: 'select', options: [['staff', 'موظف (طلبات ودعم)'], ['admin', 'مدير (كل الصلاحيات)']] }], onSubmit: async (v, close) => { await api('/api/admin/staff', { method: 'POST', body: v }); close(); ok('تمت الإضافة'); load(); } });
    el.onclick = async (e) => {
      const d = e.target.closest('[data-del]');
      if (d && await confirmDialog('إزالة الحساب', `إزالة «${d.dataset.name}» وإنهاء جلساته؟`, { ok: 'إزالة', danger: true })) { try { await api(`/api/admin/staff/${d.dataset.del}`, { method: 'DELETE' }); ok('تمت الإزالة'); load(); } catch (err) { toast(err.message, 'err'); } }
    };
  }
  await load();
}

// ── Payment gateways (keys are entered here; secrets are stored encrypted and never shown again) ──
export async function payments({ el, signal, refreshBoot }) {
  async function load() {
    const { items, types, siteUrl } = await api('/api/admin/payment-gateways', { signal });
    const typeOf = (t) => types.find((x) => x.type === t);
    setHtml(el, html`
      <div class="notice notice-info">أضف بوابتك هنا ثم فعّلها لتظهر للعملاء عند إتمام الطلب. تُحفظ المفاتيح مشفّرة ولا تُعرض مرة أخرى. لا يُعتبر الطلب «مدفوعًا» إلا بعد تأكيد موقَّع من البوابة نفسها (Webhook أو توقيع العودة أو استعلام من الخادم) ومطابقة المبلغ.</div>
      <div class="bar"><span class="sp"></span><button class="btn btn-primary" id="addg" type="button">＋ إضافة بوابة دفع</button></div>
      ${items.length ? html`<div style="display:grid;gap:12px">${items.map((g) => html`<section class="panel2" data-g="${g.id}">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div><b style="font-size:17px">${g.label}</b> <span class="status">${g.type_label}</span> <span class="status ${g.mode === 'test' ? 's-preparing' : 's-delivered'}">${g.mode === 'test' ? 'تجريبي' : 'فعلي'}</span>
            ${g.available ? '' : html`<span class="status s-cancelled">هذا النوع غير متاح في هذه البيئة</span>`}</div>
          <label class="sw"><input type="checkbox" role="switch" data-toggle="${g.id}" ${g.enabled ? 'checked' : ''} aria-label="تفعيل البوابة"> ${g.enabled ? 'مفعّلة للعملاء' : 'معطّلة'}</label></div>
        <div class="linkbox mt"><input class="input" readonly value="${g.webhook_url}" aria-label="رابط الـ Webhook"><button class="btn btn-ghost btn-sm" data-copy="${g.webhook_url}" type="button">نسخ رابط الـ Webhook</button></div>
        <p class="cl-sub" style="margin:6px 0 0">ضع هذا الرابط في لوحة مزوّد الدفع كعنوان إشعارات (Callback / Webhook) إن طلب ذلك.</p>
        <div class="row mt"><button class="btn btn-ghost btn-sm" data-edit="${g.id}" type="button">تعديل المفاتيح والإعدادات</button><button class="btn btn-ghost btn-sm" data-del="${g.id}" data-name="${g.label}" type="button" style="color:var(--err)">حذف</button></div>
      </section>`)}</div>` : html`<div class="empty"><b>لا توجد بوابات دفع بعد</b>العملاء يدفعون حاليًا عند الاستلام فقط. أضف بوابة لتفعيل الدفع الإلكتروني.</div>`}`);

    const toFields = (t, g) => [
      { name: 'label', label: 'اسم البوابة كما يراه العميل', required: true, max: 60, wide: true, def: g?.label || t.label.split(' — ')[0] },
      { name: 'mode', label: 'الوضع', type: 'select', options: [['live', 'فعلي (حسابك الحقيقي)'], ['test', 'تجريبي (مفاتيح اختبار)']] },
      { name: 'sort_order', label: 'الترتيب', type: 'number', def: 0 },
      ...t.fields.map((f) => {
        if (f.kind === 'secret') return { name: 's_' + f.key, label: f.label + (f.required ? ' *' : ''), type: 'password', dir: 'ltr', placeholder: g?.secrets_masked?.[f.key] ? `محفوظ ${g.secrets_masked[f.key]} — اتركه فارغًا للإبقاء` : '' };
        const base = { name: 'c_' + f.key, label: f.label + (f.required ? ' *' : ''), hint: f.hint, def: f.def };
        if (f.input === 'select') return { ...base, type: 'select', options: f.options };
        if (f.input === 'textarea') return { ...base, type: 'textarea', rows: f.key === 'create_body' ? 8 : 3, wide: true, mono: true };
        return { ...base, type: f.input === 'url' ? 'url' : 'text', dir: 'ltr', wide: f.input === 'url' };
      }),
      { name: 'enabled', label: 'تفعيل البوابة للعملاء الآن', type: 'checkbox', def: false },
    ];
    const openGateway = (t, g) => {
      const fields = toFields(t, g);
      const values = { label: g?.label, mode: g?.mode || 'live', sort_order: g?.sort_order ?? 0, enabled: g?.enabled ?? false };
      for (const f of t.fields) if (f.kind !== 'secret') values['c_' + f.key] = g?.config?.[f.key] ?? f.def ?? '';
      openForm({
        title: g ? `تعديل «${g.label}»` : `إضافة بوابة: ${t.label}`, fields, values, submitText: 'حفظ البوابة',
        extra: html`<div class="notice notice-warn" style="margin:0">${t.description} لا تشارك مفاتيحك مع أحد. تُحفظ مشفّرة على الخادم${g ? '، والحقول الفارغة تبقى كما هي' : ''}.</div>`,
        onSubmit: async (v, close) => {
          const body = { type: t.type, label: v.label, mode: v.mode, sort_order: v.sort_order, enabled: v.enabled, config: {}, secrets: {} };
          for (const [k, val] of Object.entries(v)) { if (k.startsWith('c_')) body.config[k.slice(2)] = val; else if (k.startsWith('s_')) body.secrets[k.slice(2)] = val; }
          await api(g ? `/api/admin/payment-gateways/${g.id}` : '/api/admin/payment-gateways', { method: g ? 'PUT' : 'POST', body });
          close(); ok(g ? 'تم حفظ البوابة' : 'تمت إضافة البوابة'); await refreshBoot(); load();
        },
      });
    };
    $('#addg', el).onclick = () => {
      const { el: m, close } = openModal('اختر نوع البوابة', html`<div class="radio-cards">${types.map((t) => html`<button type="button" class="rc" data-type="${t.type}" style="text-align:start"><span><b>${t.label}</b><small>${t.description}</small></span></button>`)}</div>`);
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { close(); openGateway(typeOf(b.dataset.type), null); } });
    };
    el.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) { const g = items.find((x) => x.id === Number(ed.dataset.edit)); return openGateway(typeOf(g.type), g); }
      const cp = e.target.closest('[data-copy]'); if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); ok('تم النسخ'); } catch { toast('انسخ الرابط يدويًا', 'err'); } return; }
      const del = e.target.closest('[data-del]');
      if (del && await confirmDialog('حذف البوابة', `حذف «${del.dataset.name}» ومفاتيحها؟`, { ok: 'حذف', danger: true })) { try { await api(`/api/admin/payment-gateways/${del.dataset.del}`, { method: 'DELETE' }); ok('تم الحذف'); await refreshBoot(); load(); } catch (err) { toast(err.message, 'err', { ms: 7000 }); } }
    };
    el.onchange = async (e) => {
      const t = e.target.closest('[data-toggle]'); if (!t) return;
      const g = items.find((x) => x.id === Number(t.dataset.toggle));
      try { await api(`/api/admin/payment-gateways/${g.id}`, { method: 'PUT', body: { type: g.type, label: g.label, mode: g.mode, sort_order: g.sort_order, enabled: t.checked, config: g.config, secrets: {} } }); ok(t.checked ? 'تم تفعيل البوابة' : 'تم تعطيل البوابة'); await refreshBoot(); load(); }
      catch (err) { t.checked = !t.checked; toast(err.message, 'err', { ms: 7000 }); }
    };
  }
  await load();
}
