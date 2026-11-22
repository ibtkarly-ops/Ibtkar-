// Public, read-only storefront API.
import { all, get, run } from '../db.js';
import { getSettings } from '../settings.js';
import { listProducts, getProduct, listBundles, getBundle, search } from '../catalog.js';
import { priceCart } from '../pricing.js';
import { onlineMethods, paymentStatus } from '../payments/index.js';
import { HttpError, str, int, normalizePhone, tokens } from '../lib.js';
import { rateLimit } from '../http.js';

export function activeBanners() {
  const now = new Date().toISOString();
  return all(
    `SELECT id, title, description, image, button_text, link FROM banners
      WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
      ORDER BY sort_order ASC, id DESC`, now, now);
}
export const activeBranches = () =>
  all(`SELECT id, slug, name, address, phone, whatsapp, maps_url, hours, accepts_orders, delivers
         FROM branches WHERE active = 1 ORDER BY sort_order, id`).map((b) => ({ ...b, accepts_orders: !!b.accepts_orders, delivers: !!b.delivers }));
export const activeCategories = () =>
  all('SELECT id, slug, name, kind FROM categories WHERE active = 1 ORDER BY sort_order, id');

/** Everything the storefront needs on first paint (also embedded into index.html). */
export function bootstrapData() {
  const settings = getSettings();
  const branches = activeBranches();
  const main = branches.find((b) => b.slug === settings.main_branch_slug) || branches[0] || null;
  return {
    settings,
    categories: activeCategories(),
    branches,
    banners: activeBanners(),
    mainBranchId: main?.id ?? null,
    payments: { cash: !!settings.cash_enabled, online: onlineMethods(), gateway: { sandbox: paymentStatus().sandbox } },
    delivery: { enabled: !!settings.delivery_enabled, fee: settings.delivery_fee, note: settings.delivery_note },
  };
}

export function register(r) {
  r.get('/api/bootstrap', () => bootstrapData());

  r.get('/api/products', (ctx) => {
    const q = ctx.query;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 24, 1), 60);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);
    return listProducts({ category: str(q.get('category') || '', { max: 60 }), q: str(q.get('q') || '', { max: 80 }), limit, offset });
  });
  r.get('/api/products/:id', (ctx) => {
    const p = getProduct(Number(ctx.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'المنتج غير موجود');
    return p;
  });
  r.get('/api/bundles', (ctx) => ({ items: listBundles({ q: str(ctx.query.get('q') || '', { max: 80 }) }) }));
  r.get('/api/bundles/:id', (ctx) => {
    const b = getBundle(Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'not_found', 'الباقة غير موجودة');
    return b;
  });

  r.get('/api/search', (ctx) => {
    if (!rateLimit(`search:${ctx.ip}`, 120, 60_000)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا');
    const q = str(ctx.query.get('q') || '', { max: 80 });
    const limit = Math.min(Number(ctx.query.get('limit')) || 12, 40);
    const out = search(q, limit);
    return { q, tokens: tokens(q), ...out };
  });

  // Authoritative re-pricing of a cart (the browser's numbers are display-only).
  r.post('/api/cart/price', async (ctx) => {
    const b = await ctx.json();
    const branchId = b.branchId ? int(b.branchId, { min: 1, field: 'branchId' }) : null;
    return priceCart(b.items, { fulfillment: b.fulfillment === 'delivery' ? 'delivery' : 'pickup', branchId });
  });

  r.get('/api/branches', () => ({ items: activeBranches() }));

  // Support requests (forgot password / forgot e-mail or phone / other). Never contains secrets.
  r.post('/api/support', async (ctx) => {
    if (!rateLimit(`support:${ctx.ip}`, 6, 3600_000)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، حاول لاحقًا');
    const b = await ctx.json();
    const kind = ['password', 'identifier', 'deletion', 'other'].includes(b.kind) ? b.kind : 'other';
    const name = str(b.name, { max: 80, field: 'name' });
    const phone = b.phone ? normalizePhone(b.phone) : '';
    const message = str(b.message, { max: 500, field: 'message' });
    run('INSERT INTO support_requests (user_id, kind, name, phone, message) VALUES (?, ?, ?, ?, ?)', ctx.user?.id ?? null, kind, name, phone, message);
    return { ok: true };
  });
}
