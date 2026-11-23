// Public, read-only storefront API.
import { rt } from '../runtime.js';
import { getSettings, effectiveLogo } from '../settings.js';
import { listProducts, getProduct, listBundles, getBundle, search } from '../catalog.js';
import { priceCart } from '../pricing.js';
import { onlineMethods } from '../payments/index.js';
import { HttpError, str, int, normalizePhone, tokens } from '../lib.js';
import { rateLimit } from '../http.js';

const BANNERS = `SELECT id, title, description, image, button_text, link FROM banners
   WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
   ORDER BY sort_order ASC, id DESC`;
const BRANCHES = `SELECT id, slug, name, address, phone, whatsapp, maps_url, hours, accepts_orders, delivers
   FROM branches WHERE active = 1 ORDER BY sort_order, id`;
const CATEGORIES = 'SELECT id, slug, name, kind FROM categories WHERE active = 1 ORDER BY sort_order, id';
const branchView = (b) => ({ ...b, accepts_orders: !!b.accepts_orders, delivers: !!b.delivers });

export const activeBranches = async () => (await rt.db.all(BRANCHES)).map(branchView);

/** Everything the storefront needs on first paint (also embedded into index.html). */
export async function bootstrapData() {
  const settings = { ...(await getSettings()) };
  settings.logo_url = effectiveLogo(settings);
  const now = new Date().toISOString();
  const [cats, branchRows, banners] = await rt.db.batch([[CATEGORIES], [BRANCHES], [BANNERS, now, now]]);
  const branches = branchRows.rows.map(branchView);
  const main = branches.find((b) => b.slug === settings.main_branch_slug) || branches[0] || null;
  return {
    settings,
    categories: cats.rows,
    branches,
    banners: banners.rows,
    mainBranchId: main?.id ?? null,
    payments: { cash: !!settings.cash_enabled, online: await onlineMethods() },
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
  r.get('/api/products/:id', async (ctx) => {
    const p = await getProduct(Number(ctx.params.id));
    if (!p) throw new HttpError(404, 'not_found', 'المنتج غير موجود');
    return p;
  });
  r.get('/api/bundles', async (ctx) => ({ items: await listBundles({ q: str(ctx.query.get('q') || '', { max: 80 }) }) }));
  r.get('/api/bundles/:id', async (ctx) => {
    const b = await getBundle(Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'not_found', 'الباقة غير موجودة');
    return b;
  });

  r.get('/api/search', async (ctx) => {
    if (!(await rateLimit(`search:${ctx.ip}`, 120, 60_000, { soft: true }))) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، انتظر قليلًا');
    const q = str(ctx.query.get('q') || '', { max: 80 });
    const limit = Math.min(Number(ctx.query.get('limit')) || 12, 40);
    return { q, tokens: tokens(q), ...(await search(q, limit)) };
  });

  // Authoritative re-pricing of a cart (the browser's numbers are display-only).
  r.post('/api/cart/price', async (ctx) => {
    const b = await ctx.json();
    const branchId = b.branchId ? int(b.branchId, { min: 1, field: 'branchId' }) : null;
    return priceCart(b.items, { fulfillment: b.fulfillment === 'delivery' ? 'delivery' : 'pickup', branchId });
  });

  r.get('/api/branches', async () => ({ items: await activeBranches() }));

  // Support requests (forgot password / forgot e-mail or phone / other). Never contains secrets.
  r.post('/api/support', async (ctx) => {
    if (!(await rateLimit(`support:${ctx.ip}`, 6, 3600_000))) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة، حاول لاحقًا');
    const b = await ctx.json();
    const kind = ['password', 'identifier', 'deletion', 'other'].includes(b.kind) ? b.kind : 'other';
    const name = str(b.name, { max: 80, field: 'name' });
    const phone = b.phone ? normalizePhone(b.phone) : '';
    const message = str(b.message, { max: 500, field: 'message' });
    await rt.db.run('INSERT INTO support_requests (user_id, kind, name, phone, message) VALUES (?, ?, ?, ?, ?)', ctx.user?.id ?? null, kind, name, phone, message);
    return { ok: true };
  });
}
