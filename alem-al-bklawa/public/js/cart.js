// Cart: persisted locally (and to the account when signed in); prices are always re-checked on the server.
import { api } from './api.js';
import { store, debounce, html, setHtml, money, icon, $, $$, raw } from './util.js';
import { emit, on, state } from './state.js';
import { toast, lockScroll, trapFocus } from './ui.js';

const KEY = 'abk_cart_v1';
export const lineKey = (type, id, variantId) => `${type}:${id}:${variantId || 0}`;

const clean = (arr) => (Array.isArray(arr) ? arr : []).filter((i) => i && (i.type === 'product' || i.type === 'bundle') && Number(i.id) > 0 && Number(i.qty) >= 1)
  .slice(0, 40).map((i) => ({ type: i.type, id: Number(i.id), variantId: i.variantId ? Number(i.variantId) : null, qty: Math.min(Number(i.qty), 100), note: String(i.note || '').slice(0, 200), name: String(i.name || ''), variantName: i.variantName || null, price: Number(i.price) || 0, image: i.image || null }));

let items = clean(store.get(KEY, []));
let priced = null;       // last authoritative pricing from the server
let changed = [];        // lines whose price changed since the customer last saw them

const save = () => { store.set(KEY, items); emit('cart', items); if (state.user) syncUp(); };
const syncUp = debounce(() => api('/api/account/cart', { method: 'PUT', body: { items } }).catch(() => {}), 1200);

export const cart = {
  items: () => items,
  count: () => items.reduce((n, i) => n + i.qty, 0),
  priced: () => priced,
  changed: () => changed,
  ackChanges: () => { changed = []; },
  add(item, qty = 1) {
    const key = lineKey(item.type, item.id, item.variantId);
    const ex = items.find((i) => lineKey(i.type, i.id, i.variantId) === key);
    const max = item.type === 'bundle' ? (item.maxQty || 10) : 50;
    if (ex) ex.qty = Math.min(ex.qty + qty, max); else items.push({ ...item, qty: Math.min(qty, max), note: item.note || '' });
    priced = null; save();
  },
  setQty(key, qty) {
    const it = items.find((i) => lineKey(i.type, i.id, i.variantId) === key);
    if (!it) return;
    if (qty < 1) return cart.remove(key);
    it.qty = Math.min(qty, 100); priced = null; save();
  },
  setNote(key, note) { const it = items.find((i) => lineKey(i.type, i.id, i.variantId) === key); if (it) { it.note = String(note).slice(0, 200); save(); } },
  remove(key) { items = items.filter((i) => lineKey(i.type, i.id, i.variantId) !== key); priced = null; save(); },
  clear() { items = []; priced = null; changed = []; save(); },
  /** Ask the server for authoritative prices/availability; update local snapshots; remember what changed. */
  async refresh({ fulfillment = 'pickup', branchId = null, signal } = {}) {
    if (!items.length) { priced = { lines: [], subtotal: 0, deliveryFee: 0, total: 0, ok: false, problems: [] }; return priced; }
    const res = await api('/api/cart/price', { method: 'POST', body: { items, fulfillment, branchId }, signal });
    priced = res;
    for (const l of res.lines) {
      const it = items.find((i) => lineKey(i.type, i.id, i.variantId) === l.key);
      if (!it) continue;
      if (!l.problem && l.unitPrice !== it.price && it.price) changed.push({ name: l.name, from: it.price, to: l.unitPrice });
      if (!l.problem) { it.price = l.unitPrice; it.name = l.name; it.variantName = l.variantName; it.image = l.image; }
    }
    store.set(KEY, items);
    emit('cart-priced', priced);
    return priced;
  },
  /** After login: merge what's saved on the account with this device's cart. */
  async restore() {
    try {
      const srv = (await api('/api/account/cart')).items || [];
      for (const s of srv) {
        const ex = items.find((i) => lineKey(i.type, i.id, i.variantId) === lineKey(s.type, s.id, s.variantId));
        if (ex) ex.qty = Math.max(ex.qty, s.qty); else items.push({ ...s, name: '', price: 0 });
      }
      items = clean(items); priced = null; store.set(KEY, items); emit('cart', items);
      if (items.length) { await cart.refresh().catch(() => {}); api('/api/account/cart', { method: 'PUT', body: { items } }).catch(() => {}); }
    } catch { /* offline: keep local cart */ }
  },
};

// ── Drawer UI ──────────────────────────────────────────────────────────────
let drawer, overlay, releaseTrap;

function lineView(it, l) {
  const key = lineKey(it.type, it.id, it.variantId);
  const price = l ? l.unitPrice : it.price; const name = l?.name || it.name || 'منتج';
  const problem = l?.problem; const max = l?.maxQty || (it.type === 'bundle' ? 10 : 50);
  return html`<div class="cl ${problem ? 'problem' : ''}" data-key="${key}">
    <div class="cl-img">${it.image ? raw(`<img src="${it.image}" alt="" loading="lazy">`) : icon(it.type === 'bundle' ? 'gift' : 'bag')}</div>
    <div>
      <div class="cl-name">${name}</div>
      <div class="cl-sub">${[it.type === 'bundle' ? 'باقة' : '', l?.variantName || it.variantName, price ? money(price) : ''].filter(Boolean).join(' · ')}</div>
      ${problem ? html`<div class="warn">${problem === 'unavailable' ? 'هذا الصنف غير متوفر حاليًا — احذفه لمتابعة الطلب' : 'يرجى مراجعة هذا الصنف'}</div>` : ''}
      <div class="cl-row">
        <div class="qty" role="group" aria-label="الكمية">
          <button type="button" data-act="dec" aria-label="تقليل الكمية">−</button><output aria-live="polite">${it.qty}</output>
          <button type="button" data-act="inc" aria-label="زيادة الكمية" ${it.qty >= max ? 'disabled' : ''}>+</button>
        </div>
        <span class="cl-total">${problem ? '' : money(price * it.qty)}</span>
      </div>
      <button class="cl-rm" type="button" data-act="rm">حذف</button>
    </div>
  </div>`;
}

function renderDrawer() {
  if (!drawer) return;
  const body = $('.drawer-body', drawer); const foot = $('.drawer-foot', drawer);
  if (!items.length) {
    setHtml(body, html`<div class="empty"><b>سلتك فارغة</b>أضف بعض المنتجات اللذيذة وسنجهّزها لك.</div>`);
    setHtml(foot, html`<a class="btn btn-primary btn-block" href="/shop">تصفح المنتجات</a>`);
    return;
  }
  const lines = new Map((priced?.lines || []).map((l) => [l.key, l]));
  setHtml(body, html`${changed.length ? html`<div class="notice notice-warn" role="status">تغيّر سعر: ${changed.map((c) => `${c.name} (${money(c.from)} ← ${money(c.to)})`).join('، ')}</div>` : ''}${items.map((it) => lineView(it, lines.get(lineKey(it.type, it.id, it.variantId))))}`);
  const subtotal = priced ? priced.subtotal : items.reduce((s, i) => s + i.price * i.qty, 0);
  const blocked = priced && !priced.ok;
  setHtml(foot, html`<div class="sum-total"><span>المجموع</span><b>${money(subtotal)}</b></div>
    <a class="btn btn-primary btn-block ${blocked ? 'is-disabled' : ''}" href="/checkout" ${blocked ? 'aria-disabled="true"' : ''}>إتمام الطلب</a>
    <p class="cl-sub mt" style="margin:10px 0 0">الأسعار النهائية تُحسب على الخادم عند تأكيد الطلب.</p>`);
}

export async function openCart() {
  if (drawer?.classList.contains('open')) return;
  drawer = $('#cart-drawer'); overlay = $('#cart-overlay');
  overlay.hidden = false; drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); lockScroll(true);
  releaseTrap = trapFocus(drawer, closeCart);
  renderDrawer();
  $('.drawer-head button', drawer).focus();
  try { await cart.refresh(); } catch { /* offline: show local snapshot */ }
  renderDrawer();
}
export function closeCart() {
  if (!drawer || !drawer.classList.contains('open')) return;
  drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); overlay.hidden = true; lockScroll(false);
  releaseTrap?.();
}

export function mountCartDrawer() {
  drawer = $('#cart-drawer'); overlay = $('#cart-overlay');
  overlay.addEventListener('click', closeCart);
  $('[data-close-cart]', drawer).addEventListener('click', closeCart);
  drawer.addEventListener('click', (e) => {
    if (e.target.closest('a[href]')) { closeCart(); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const key = b.closest('[data-key]').dataset.key; const it = items.find((i) => lineKey(i.type, i.id, i.variantId) === key); if (!it) return;
    if (b.dataset.act === 'inc') cart.setQty(key, it.qty + 1);
    else if (b.dataset.act === 'dec') cart.setQty(key, it.qty - 1);
    else cart.remove(key);
    renderDrawer();
    cart.refresh().then(renderDrawer).catch(() => {});
  });
  on('navigate', closeCart);
}

/** Add helper used by product/bundle UIs: validates, adds, shows a single toast with a shortcut to the cart. */
export function addToCart(entry, qty = 1) {
  cart.add(entry, qty);
  toast(`أُضيف «${entry.name}» إلى السلة`, 'ok', { action: 'عرض السلة', onAction: openCart });
}
