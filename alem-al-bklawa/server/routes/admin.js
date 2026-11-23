// Admin API. Staff: orders, support, customers (read). Admin: everything else.
import { rt, db } from '../runtime.js';
import { nowIso, qs } from '../dbutil.js';
import { getSettings, saveSettings, DEFAULTS, effectiveLogo } from '../settings.js';
import {
  HttpError, str, int, flag, bad, slugify, lydToDirham, normalizePhone, emailOrEmpty, safeUrl, safeImage, isoOrNull,
  ORDER_STATUSES,
} from '../lib.js';
import { requireStaff, requireAdmin, audit, hashPassword, checkPasswordPolicy, destroyUserSessionsStmt } from '../auth.js';
import { readBody, randomHex, sha256, originOf } from '../http.js';
import { refreshCategoryProducts, productSearchText, bundleSearchText } from '../catalog.js';
import { orderView, selectOrders, selectOrder, orderListView } from './orders.js';
import { paymentsForOrder, gatewaySummary, onlineMethods, webhookUrlForId } from '../payments/index.js';
import { types, catalog } from '../payments/registry.js';
import { seal, unseal, mask } from '../vault.js';

const price = (v, field) => {
  const d = lydToDirham(v);
  if (d === null || Number.isNaN(d)) throw bad('invalid_' + field, 'السعر غير صالح', { field });
  return d;
};
const optPrice = (v, field) => (v === '' || v === null || v === undefined ? null : price(v, field));
const page = (ctx, size = 30) => ({ size, offset: (Math.max(Number(ctx.query.get('page')) || 1, 1) - 1) * size });
// D1 limits LIKE patterns to 50 bytes → at most 20 characters of user text (+ the two %)
const like = (s) => `%${String(s).slice(0, 20).replace(/[%_\\]/g, (c) => '\\' + c)}%`;

async function uniqueSlug(table, base, exceptId) {
  let slug = slugify(base); let n = 2;
  while (await db.get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, slug, exceptId ?? -1)) slug = `${slugify(base)}-${n++}`;
  return slug;
}
const uniqueErr = (e) => /UNIQUE|constraint/i.test(String(e?.message));

export function register(r) {
  const staff = requireStaff; const admin = requireAdmin;

  // ── Dashboard ──────────────────────────────────────────────────────────────
  r.get('/api/admin/dashboard', staff, async () => {
    const [byStatus, money, top, unavailable, unavailableBundles, recentRows, counts2] = await db.batch([
      ['SELECT status, COUNT(*) AS n FROM orders GROUP BY status'],
      [`SELECT COALESCE(SUM(CASE WHEN status = 'delivered' THEN total END), 0) AS sales,
               COALESCE(SUM(CASE WHEN status NOT IN ('delivered','cancelled') THEN total END), 0) AS open,
               COALESCE(SUM(CASE WHEN payment_status = 'paid' AND status != 'cancelled' THEN total END), 0) AS paid,
               COALESCE(MAX(id), 0) AS newest FROM orders`],
      [`SELECT oi.name, SUM(oi.quantity) AS qty, SUM(oi.line_total) AS revenue FROM order_items oi
          JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelled'
         GROUP BY oi.kind, COALESCE(oi.product_id, oi.bundle_id, oi.name), oi.name ORDER BY qty DESC LIMIT 5`],
      ['SELECT p.id, p.name FROM products p WHERE p.active = 1 AND p.available = 0 ORDER BY p.name LIMIT 20'],
      ['SELECT id, name FROM bundles WHERE active = 1 AND available = 0 ORDER BY name LIMIT 20'],
      [`SELECT o.*, b.id AS b_id, b.name AS b_name, b.address AS b_address, b.phone AS b_phone, b.whatsapp AS b_whatsapp, b.maps_url AS b_maps_url, b.hours AS b_hours
          FROM orders o LEFT JOIN branches b ON b.id = o.branch_id ORDER BY o.id DESC LIMIT 6`],
      [`SELECT (SELECT COUNT(*) FROM support_requests WHERE status != 'resolved') AS support,
              (SELECT COUNT(*) FROM products WHERE active = 1) AS products, (SELECT COUNT(*) FROM bundles WHERE active = 1) AS bundles,
              (SELECT COUNT(*) FROM banners WHERE active = 1) AS banners,
              (SELECT COUNT(*) FROM branches WHERE active = 1 AND (phone = '' OR maps_url = '')) AS branches_incomplete`],
    ]);
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
    for (const row of byStatus.rows) counts[row.status] = row.n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const m = money.rows[0]; const c2 = counts2.rows[0]; const gateways = await gatewaySummary();
    return {
      counts, total, sales: m.sales, open: m.open, paidOnline: m.paid, top: top.rows, unavailable: unavailable.rows, unavailableBundles: unavailableBundles.rows,
      recent: await orderListView(recentRows.rows), openSupport: c2.support, newestOrderId: m.newest, gateways,
      // "get started" checklist: real state only
      setup: { logo: !!effectiveLogo(await getSettings()), products: c2.products, bundles: c2.bundles, banners: c2.banners, branchesIncomplete: c2.branches_incomplete, gateways: gateways.enabled },
    };
  });

  // ── Orders ─────────────────────────────────────────────────────────────────
  r.get('/api/admin/orders', staff, async (ctx) => {
    const q = ctx.query; const where = []; const params = [];
    const status = q.get('status'); if (status && ORDER_STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
    const branch = Number(q.get('branch')); if (branch) { where.push('o.branch_id = ?'); params.push(branch); }
    const pay = q.get('payment'); if (pay) { where.push('o.payment_status = ?'); params.push(pay); }
    const from = q.get('from'); if (from) { where.push('o.created_at >= ?'); params.push(new Date(from).toISOString()); }
    const to = q.get('to'); if (to) { const d = new Date(to); d.setDate(d.getDate() + 1); where.push('o.created_at < ?'); params.push(d.toISOString()); }
    const s = (q.get('q') || '').trim().slice(0, 60);
    if (s) { where.push("(o.number LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.customer_phone LIKE ? ESCAPE '\\')"); params.push(like(s), like(s), like(s.replace(/^0/, '218'))); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { size, offset } = page(ctx);
    const [count, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM orders o ${w}`, ...params),
      selectOrders(w, [...params, size, offset], 'ORDER BY o.id DESC LIMIT ? OFFSET ?'),
    ]);
    const items = (await orderListView(rows)).map((v, i) => ({ ...v, id: rows[i].id }));
    return { items, total: count.n, pageSize: size };
  });
  r.get('/api/admin/orders/:id', staff, async (ctx) => {
    const o = await selectOrder('o.id = ?', [int(ctx.params.id, { min: 1 })]);
    if (!o) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
    return { order: { ...(await orderView(o, { withEvents: true })), id: o.id, customer_email: o.customer_email }, payments: await paymentsForOrder(o.id) };
  });
  r.post('/api/admin/orders/:id/status', staff, async (ctx) => {
    const b = await ctx.json();
    const o = await db.get('SELECT * FROM orders WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!o) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
    if (!ORDER_STATUSES.includes(b.status)) throw bad('invalid_status', 'حالة غير صالحة');
    if (ctx.user.role === 'staff' && (o.status === 'delivered' || o.status === 'cancelled')) throw new HttpError(403, 'forbidden', 'لا يمكن للموظف تعديل طلب مكتمل أو ملغي');
    if (b.status === o.status) return { ok: true };
    const note = str(b.note, { max: 300, field: 'note' });
    const stmts = [
      ['UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', b.status, nowIso(), o.id],
      ["INSERT INTO order_events (order_id, kind, from_value, to_value, note, user_id) VALUES (?, 'status', ?, ?, ?, ?)", o.id, o.status, b.status, note || null, ctx.user.id],
    ];
    if (b.markPaid && b.status === 'delivered' && o.payment_method === 'cash' && o.payment_status !== 'paid') {
      stmts.push(["UPDATE orders SET payment_status = 'paid' WHERE id = ?", o.id]);
      stmts.push(["INSERT INTO order_events (order_id, kind, from_value, to_value, note, user_id) VALUES (?, 'payment', ?, 'paid', 'استلام المبلغ عند التسليم', ?)", o.id, o.payment_status, ctx.user.id]);
    }
    await db.batch(stmts);
    await audit(ctx, 'order.status', 'order', o.id, { from: o.status, to: b.status });
    return { ok: true };
  });
  r.post('/api/admin/orders/:id/payment', staff, async (ctx) => {
    const b = await ctx.json();
    const o = await db.get('SELECT * FROM orders WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!o) throw new HttpError(404, 'not_found', 'الطلب غير موجود');
    const next = b.status;
    if (!['paid', 'unpaid', 'refunded'].includes(next)) throw bad('invalid_status', 'حالة دفع غير صالحة');
    const online = o.payment_method.startsWith('online');
    if (online && next !== 'refunded') throw new HttpError(409, 'online_payment', 'حالة الدفع الإلكتروني تأتي من مزود الدفع فقط. يمكنك تسجيل «مسترد» بعد إتمام الاسترداد لدى المزود.');
    if (!online && next === 'refunded' && o.payment_status !== 'paid') throw new HttpError(409, 'not_paid', 'لا يمكن استرداد طلب غير مدفوع');
    if (next === o.payment_status) return { ok: true };
    await db.batch([
      ['UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', next, nowIso(), o.id],
      ["INSERT INTO order_events (order_id, kind, from_value, to_value, note, user_id) VALUES (?, 'payment', ?, ?, ?, ?)", o.id, o.payment_status, next, str(b.note, { max: 300 }) || 'تعديل يدوي', ctx.user.id],
    ]);
    await audit(ctx, 'order.payment', 'order', o.id, { from: o.payment_status, to: next });
    return { ok: true };
  });

  // ── Categories ─────────────────────────────────────────────────────────────
  r.get('/api/admin/categories', admin, async () => ({
    items: (await db.all('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c ORDER BY sort_order, id'))
      .map((c) => ({ ...c, active: !!c.active })),
  }));
  const catBody = async (ctx, existing) => {
    const b = await ctx.json();
    const name = str(b.name, { min: 2, max: 40, required: true, field: 'name' });
    return { name, sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }), active: flag(b.active, 1), slug: existing ? existing.slug : await uniqueSlug('categories', b.slug || name) };
  };
  r.post('/api/admin/categories', admin, async (ctx) => {
    const c = await catBody(ctx);
    const id = (await db.run("INSERT INTO categories (slug, name, kind, sort_order, active) VALUES (?, ?, 'products', ?, ?)", c.slug, c.name, c.sort_order, c.active)).lastInsertRowid;
    await audit(ctx, 'category.create', 'category', id); return { id };
  });
  r.put('/api/admin/categories/:id', admin, async (ctx) => {
    const ex = await db.get('SELECT * FROM categories WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!ex) throw new HttpError(404, 'not_found', 'القسم غير موجود');
    const c = await catBody(ctx, ex);
    await db.run('UPDATE categories SET name = ?, sort_order = ?, active = ?, updated_at = ? WHERE id = ?', c.name, c.sort_order, c.active, nowIso(), ex.id);
    await refreshCategoryProducts(ex.id); await audit(ctx, 'category.update', 'category', ex.id); return { ok: true };
  });
  r.delete('/api/admin/categories/:id', admin, async (ctx) => {
    const ex = await db.get('SELECT * FROM categories WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!ex) throw new HttpError(404, 'not_found', 'القسم غير موجود');
    if (ex.kind === 'bundles') throw new HttpError(409, 'system_category', 'قسم الباقات أساسي. يمكنك إخفاؤه بدل حذفه.');
    if (await db.get('SELECT 1 AS x FROM products WHERE category_id = ? LIMIT 1', ex.id)) throw new HttpError(409, 'not_empty', 'القسم يحتوي منتجات. انقلها لقسم آخر أو أخفِ القسم بدل حذفه.');
    await db.run('DELETE FROM categories WHERE id = ?', ex.id); await audit(ctx, 'category.delete', 'category', ex.id); return { ok: true };
  });

  // ── Products (with variants) ───────────────────────────────────────────────
  r.get('/api/admin/products', admin, async (ctx) => {
    const q = (ctx.query.get('q') || '').trim().slice(0, 60); const cat = Number(ctx.query.get('category')) || 0;
    const where = []; const params = [];
    if (q) { where.push("p.name LIKE ? ESCAPE '\\'"); params.push(like(q)); }
    if (cat) { where.push('p.category_id = ?'); params.push(cat); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { size, offset } = page(ctx, 50);
    const [count, rows] = await db.batch([
      [`SELECT COUNT(*) AS n FROM products p ${w}`, ...params],
      [`SELECT p.*, c.name AS category_name, (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count
          FROM products p JOIN categories c ON c.id = p.category_id ${w} ORDER BY p.sort_order, p.id DESC LIMIT ? OFFSET ?`, ...params, size, offset],
    ]);
    return { items: rows.rows.map((p) => ({ ...p, available: !!p.available, active: !!p.active })), total: count.rows[0].n, pageSize: size };
  });
  r.get('/api/admin/products/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    const [p, vs] = await db.batch([['SELECT * FROM products WHERE id = ?', id], ['SELECT id, name, price, available FROM product_variants WHERE product_id = ? ORDER BY sort_order, id', id]]);
    if (!p.rows[0]) throw new HttpError(404, 'not_found', 'المنتج غير موجود');
    return { ...p.rows[0], available: !!p.rows[0].available, active: !!p.rows[0].active, variants: vs.rows.map((v) => ({ ...v, available: !!v.available })) };
  });
  const productBody = async (ctx) => {
    const b = await ctx.json(32 * 1024);
    const category_id = int(b.category_id, { min: 1, field: 'category_id' });
    const cat = await db.get("SELECT name FROM categories WHERE id = ? AND kind = 'products'", category_id);
    if (!cat) throw bad('invalid_category_id', 'القسم غير صالح', { field: 'category_id' });
    const variants = (Array.isArray(b.variants) ? b.variants : []).slice(0, 30).map((v, i) => ({
      id: v.id ? Number(v.id) : null, name: str(v.name, { min: 1, max: 60, required: true, field: 'variant_name' }),
      price: price(v.price, 'variant_price'), available: flag(v.available, 1), sort_order: i,
    }));
    const p = {
      category_id, name: str(b.name, { min: 2, max: 100, required: true, field: 'name' }), description: str(b.description, { max: 1000, field: 'description' }),
      price: price(b.price, 'price'), compare_price: optPrice(b.compare_price, 'compare_price'), image: safeImage(b.image),
      available: flag(b.available, 1), active: flag(b.active, 1), sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }),
      keywords: str(b.keywords, { max: 300, field: 'keywords' }),
    };
    p.search_text = productSearchText(p, cat.name, variants.map((v) => v.name));
    return { p, variants };
  };
  /** Statements that make the product's variants exactly `variants` (updates keep ids; others are added/removed). */
  const variantStmts = async (productId, variants, idExpr) => {
    const existing = new Set(productId ? (await db.all('SELECT id FROM product_variants WHERE product_id = ?', productId)).map((x) => x.id) : []);
    const keep = new Set(); const stmts = [];
    for (const v of variants) {
      if (v.id && existing.has(v.id)) { stmts.push(['UPDATE product_variants SET name = ?, price = ?, available = ?, sort_order = ? WHERE id = ?', v.name, v.price, v.available, v.sort_order, v.id]); keep.add(v.id); }
      else stmts.push(['INSERT INTO product_variants (product_id, name, price, available, sort_order) VALUES (?, ?, ?, ?, ?)', idExpr, v.name, v.price, v.available, v.sort_order]);
    }
    for (const id of existing) if (!keep.has(id)) stmts.push(['DELETE FROM product_variants WHERE id = ?', id]);
    return stmts;
  };
  r.post('/api/admin/products', admin, async (ctx) => {
    const { p, variants } = await productBody(ctx);
    const id = (await db.run(`INSERT INTO products (category_id, name, description, price, compare_price, image, available, active, sort_order, keywords, search_text)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.category_id, p.name, p.description, p.price, p.compare_price, p.image, p.available, p.active, p.sort_order, p.keywords, p.search_text)).lastInsertRowid;
    if (variants.length) await db.batch(await variantStmts(null, variants, id));
    await audit(ctx, 'product.create', 'product', id); return { id };
  });
  r.put('/api/admin/products/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    if (!(await db.get('SELECT 1 AS x FROM products WHERE id = ?', id))) throw new HttpError(404, 'not_found', 'المنتج غير موجود');
    const { p, variants } = await productBody(ctx);
    await db.batch([
      [`UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, compare_price = ?, image = ?, available = ?, active = ?,
               sort_order = ?, keywords = ?, search_text = ?, updated_at = ? WHERE id = ?`, p.category_id, p.name, p.description, p.price, p.compare_price, p.image, p.available, p.active, p.sort_order, p.keywords, p.search_text, nowIso(), id],
      ...(await variantStmts(id, variants, id)),
    ]);
    await audit(ctx, 'product.update', 'product', id); return { ok: true };
  });
  r.patch('/api/admin/products/:id/availability', admin, async (ctx) => {
    const b = await ctx.json(); const id = int(ctx.params.id, { min: 1 });
    await db.run('UPDATE products SET available = ?, updated_at = ? WHERE id = ?', flag(b.available), nowIso(), id); await audit(ctx, 'product.availability', 'product', id, { available: flag(b.available) });
    return { ok: true };
  });
  r.delete('/api/admin/products/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 }); await db.run('DELETE FROM products WHERE id = ?', id); await audit(ctx, 'product.delete', 'product', id); return { ok: true };
  });

  // ── Bundles ────────────────────────────────────────────────────────────────
  r.get('/api/admin/bundles', admin, async () => ({
    items: (await db.all('SELECT b.*, (SELECT COUNT(*) FROM bundle_items i WHERE i.bundle_id = b.id) AS item_count FROM bundles b ORDER BY sort_order, id DESC')).map((b) => ({ ...b, available: !!b.available, active: !!b.active })),
  }));
  r.get('/api/admin/bundles/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    const [b, items] = await db.batch([['SELECT * FROM bundles WHERE id = ?', id], ['SELECT label, quantity FROM bundle_items WHERE bundle_id = ? ORDER BY sort_order, id', id]]);
    if (!b.rows[0]) throw new HttpError(404, 'not_found', 'الباقة غير موجودة');
    return { ...b.rows[0], available: !!b.rows[0].available, active: !!b.rows[0].active, items: items.rows };
  });
  const bundleBody = async (ctx) => {
    const b = await ctx.json(32 * 1024);
    const p = {
      name: str(b.name, { min: 2, max: 100, required: true, field: 'name' }), description: str(b.description, { max: 1000, field: 'description' }),
      price: price(b.price, 'price'), image: safeImage(b.image), max_qty: int(b.max_qty, { min: 1, max: 100, required: false, def: 10 }),
      available: flag(b.available, 1), active: flag(b.active, 1), sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }), keywords: str(b.keywords, { max: 300 }),
    };
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map((it, i) => ({ label: str(it.label, { min: 1, max: 120, required: true, field: 'item_label' }), quantity: int(it.quantity, { min: 1, max: 1000, required: false, def: 1 }), sort_order: i }));
    p.search_text = bundleSearchText(p, items.map((i) => i.label));
    return { p, items };
  };
  r.post('/api/admin/bundles', admin, async (ctx) => {
    const { p, items } = await bundleBody(ctx);
    const id = (await db.run(`INSERT INTO bundles (name, description, price, image, max_qty, available, active, sort_order, keywords, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name, p.description, p.price, p.image, p.max_qty, p.available, p.active, p.sort_order, p.keywords, p.search_text)).lastInsertRowid;
    if (items.length) await db.batch(items.map((it) => ['INSERT INTO bundle_items (bundle_id, label, quantity, sort_order) VALUES (?, ?, ?, ?)', id, it.label, it.quantity, it.sort_order]));
    await audit(ctx, 'bundle.create', 'bundle', id); return { id };
  });
  r.put('/api/admin/bundles/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    if (!(await db.get('SELECT 1 AS x FROM bundles WHERE id = ?', id))) throw new HttpError(404, 'not_found', 'الباقة غير موجودة');
    const { p, items } = await bundleBody(ctx);
    await db.batch([
      [`UPDATE bundles SET name = ?, description = ?, price = ?, image = ?, max_qty = ?, available = ?, active = ?, sort_order = ?, keywords = ?, search_text = ?, updated_at = ? WHERE id = ?`,
        p.name, p.description, p.price, p.image, p.max_qty, p.available, p.active, p.sort_order, p.keywords, p.search_text, nowIso(), id],
      ['DELETE FROM bundle_items WHERE bundle_id = ?', id],
      ...items.map((it) => ['INSERT INTO bundle_items (bundle_id, label, quantity, sort_order) VALUES (?, ?, ?, ?)', id, it.label, it.quantity, it.sort_order]),
    ]);
    await audit(ctx, 'bundle.update', 'bundle', id); return { ok: true };
  });
  r.delete('/api/admin/bundles/:id', admin, async (ctx) => { const id = int(ctx.params.id, { min: 1 }); await db.run('DELETE FROM bundles WHERE id = ?', id); await audit(ctx, 'bundle.delete', 'bundle', id); return { ok: true }; });

  // ── Banners ────────────────────────────────────────────────────────────────
  r.get('/api/admin/banners', admin, async () => ({ items: (await db.all('SELECT * FROM banners ORDER BY sort_order, id DESC')).map((b) => ({ ...b, active: !!b.active })) }));
  const bannerBody = async (ctx) => {
    const b = await ctx.json();
    const starts_at = isoOrNull(b.starts_at, 'starts_at'); const ends_at = isoOrNull(b.ends_at, 'ends_at');
    if (starts_at && ends_at && ends_at < starts_at) throw bad('invalid_ends_at', 'تاريخ النهاية قبل البداية', { field: 'ends_at' });
    if (!str(b.title, { max: 100, field: 'title' }) && !safeImage(b.image)) throw bad('invalid_title', 'أضف صورة أو عنوانًا للإعلان', { field: 'title' });
    return {
      title: str(b.title, { max: 100, field: 'title' }), description: str(b.description, { max: 300, field: 'description' }), image: safeImage(b.image),
      button_text: str(b.button_text, { max: 40, field: 'button_text' }), link: safeUrl(b.link, 'link'), starts_at, ends_at,
      active: flag(b.active, 1), sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }),
    };
  };
  r.post('/api/admin/banners', admin, async (ctx) => {
    const b = await bannerBody(ctx);
    const id = (await db.run(`INSERT INTO banners (title, description, image, button_text, link, starts_at, ends_at, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.title, b.description, b.image, b.button_text, b.link, b.starts_at, b.ends_at, b.active, b.sort_order)).lastInsertRowid;
    await audit(ctx, 'banner.create', 'banner', id); return { id };
  });
  r.put('/api/admin/banners/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 }); const b = await bannerBody(ctx);
    if (!(await db.run(`UPDATE banners SET title = ?, description = ?, image = ?, button_text = ?, link = ?, starts_at = ?, ends_at = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      b.title, b.description, b.image, b.button_text, b.link, b.starts_at, b.ends_at, b.active, b.sort_order, nowIso(), id)).changes) throw new HttpError(404, 'not_found');
    await audit(ctx, 'banner.update', 'banner', id); return { ok: true };
  });
  r.delete('/api/admin/banners/:id', admin, async (ctx) => { const id = int(ctx.params.id, { min: 1 }); await db.run('DELETE FROM banners WHERE id = ?', id); await audit(ctx, 'banner.delete', 'banner', id); return { ok: true }; });

  // ── Branches ───────────────────────────────────────────────────────────────
  r.get('/api/admin/branches', admin, async () => ({ items: (await db.all('SELECT * FROM branches ORDER BY sort_order, id')).map((b) => ({ ...b, active: !!b.active, accepts_orders: !!b.accepts_orders, delivers: !!b.delivers })) }));
  const branchBody = async (ctx, existing) => {
    const b = await ctx.json();
    const name = str(b.name, { min: 2, max: 60, required: true, field: 'name' });
    let maps = str(b.maps_url, { max: 500, field: 'maps_url' });
    if (maps) { maps = safeUrl(maps, 'maps_url'); if (!maps.startsWith('https://')) throw bad('invalid_maps_url', 'رابط الخريطة يجب أن يبدأ بـ https://', { field: 'maps_url' }); }
    const phoneRaw = str(b.phone, { max: 30, field: 'phone' }); const waRaw = str(b.whatsapp, { max: 30, field: 'whatsapp' });
    if (waRaw && !normalizePhone(waRaw)) throw bad('invalid_whatsapp', 'رقم واتساب غير صالح', { field: 'whatsapp' });
    if (phoneRaw && !normalizePhone(phoneRaw)) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
    return {
      name, slug: existing ? existing.slug : await uniqueSlug('branches', b.slug || name), address: str(b.address, { max: 200, field: 'address' }),
      phone: phoneRaw, whatsapp: waRaw ? normalizePhone(waRaw) : '', maps_url: maps, hours: str(b.hours, { max: 200, field: 'hours' }),
      accepts_orders: flag(b.accepts_orders, 1), delivers: flag(b.delivers, 0), active: flag(b.active, 1), sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }),
    };
  };
  r.post('/api/admin/branches', admin, async (ctx) => {
    const b = await branchBody(ctx);
    const id = (await db.run(`INSERT INTO branches (slug, name, address, phone, whatsapp, maps_url, hours, accepts_orders, delivers, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.slug, b.name, b.address, b.phone, b.whatsapp, b.maps_url, b.hours, b.accepts_orders, b.delivers, b.active, b.sort_order)).lastInsertRowid;
    await audit(ctx, 'branch.create', 'branch', id); return { id };
  });
  r.put('/api/admin/branches/:id', admin, async (ctx) => {
    const ex = await db.get('SELECT * FROM branches WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!ex) throw new HttpError(404, 'not_found', 'الفرع غير موجود');
    const b = await branchBody(ctx, ex);
    await db.run(`UPDATE branches SET name = ?, address = ?, phone = ?, whatsapp = ?, maps_url = ?, hours = ?, accepts_orders = ?, delivers = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      b.name, b.address, b.phone, b.whatsapp, b.maps_url, b.hours, b.accepts_orders, b.delivers, b.active, b.sort_order, nowIso(), ex.id);
    await audit(ctx, 'branch.update', 'branch', ex.id); return { ok: true };
  });
  r.delete('/api/admin/branches/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    if ((await getSettings()).main_branch_slug === (await db.get('SELECT slug FROM branches WHERE id = ?', id))?.slug) throw new HttpError(409, 'main_branch', 'هذا فرع الواتساب الرئيسي للباقات. غيّره من الإعدادات أولًا.');
    await db.run('DELETE FROM branches WHERE id = ?', id); await audit(ctx, 'branch.delete', 'branch', id); return { ok: true };
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  r.get('/api/admin/settings', admin, async (ctx) => ({ settings: await getSettings(), siteUrl: originOf(ctx.request) }));
  r.put('/api/admin/settings', admin, async (ctx) => {
    const b = await ctx.json(64 * 1024); const out = {};
    const text = (k, max, req = false) => { if (k in b) out[k] = str(b[k], { max, required: req, field: k }); };
    ['brand_name_ar', 'brand_name_en'].forEach((k) => text(k, 60, true));
    text('tagline', 120); text('meta_description', 300); text('hero_title', 100); text('hero_text', 300); text('hero_button_text', 40);
    text('about_title', 60); text('about_text', 4000); text('privacy_text', 8000); text('terms_text', 8000); text('rights_text', 8000);
    text('delivery_note', 200); text('currency_label', 8, true); text('tiktok_handle', 60);
    if ('currency' in b) out.currency = str(b.currency, { min: 3, max: 3, required: true, field: 'currency' }).toUpperCase();
    for (const k of ['support_phone', 'main_phone']) if (k in b) { const s = str(b[k], { max: 30, field: k }); if (s && !normalizePhone(s)) throw bad('invalid_' + k, 'رقم غير صالح', { field: k }); out[k] = s; }
    for (const k of ['support_whatsapp', 'main_whatsapp']) if (k in b) { const s = str(b[k], { max: 30, field: k }); if (s && !normalizePhone(s)) throw bad('invalid_' + k, 'رقم غير صالح', { field: k }); out[k] = s ? normalizePhone(s) : ''; }
    if ('tiktok_url' in b) { out.tiktok_url = safeUrl(b.tiktok_url, 'tiktok_url'); }
    if ('banner_interval_ms' in b) out.banner_interval_ms = int(b.banner_interval_ms, { min: 1500, max: 15000, field: 'banner_interval_ms' });
    if ('hero_button_link' in b) out.hero_button_link = safeUrl(b.hero_button_link, 'hero_button_link') || '/shop';
    if ('logo_url' in b) out.logo_url = safeImage(b.logo_url, 'logo_url') || '';
    if ('main_branch_slug' in b) { if (!(await db.get('SELECT 1 AS x FROM branches WHERE slug = ?', b.main_branch_slug))) throw bad('invalid_main_branch_slug', 'الفرع غير موجود'); out.main_branch_slug = b.main_branch_slug; }
    for (const k of ['delivery_enabled', 'cash_enabled']) if (k in b) out[k] = !!flag(b[k]);
    if ('delivery_fee' in b) out.delivery_fee = price(b.delivery_fee || 0, 'delivery_fee');
    if ('home_sections' in b) {
      const keys = DEFAULTS.home_sections.map((s) => s.key);
      const list = (Array.isArray(b.home_sections) ? b.home_sections : []).filter((s) => keys.includes(s?.key)).map((s) => ({ key: s.key, enabled: !!s.enabled }));
      for (const k of keys) if (!list.find((s) => s.key === k)) list.push({ key: k, enabled: true });
      out.home_sections = list;
    }
    const merged = { ...(await getSettings()), ...out };
    if (!merged.cash_enabled && !(await onlineMethods()).length) throw bad('no_payment_method', 'يجب إبقاء طريقة دفع واحدة على الأقل مفعّلة');
    await saveSettings(out); await audit(ctx, 'settings.update', 'settings', null, { keys: Object.keys(out) });
    return { settings: await getSettings() };
  });

  // ── Customers & support ────────────────────────────────────────────────────
  r.get('/api/admin/customers', staff, async (ctx) => {
    const q = (ctx.query.get('q') || '').trim().slice(0, 60); const where = ["p.role = 'customer'", 'p.deleted_at IS NULL']; const params = [];
    if (q) { where.push("(p.name LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')"); params.push(like(q), like(q.replace(/^0/, '218')), like(q)); }
    const { size, offset } = page(ctx);
    const w = where.join(' AND ');
    const [count, rows] = await db.batch([
      [`SELECT COUNT(*) AS n FROM profiles p WHERE ${w}`, ...params],
      [`SELECT p.id, p.name, p.phone, p.email, p.created_at, p.last_login_at, (SELECT COUNT(*) FROM orders o WHERE o.user_id = p.id) AS orders
          FROM profiles p WHERE ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...params, size, offset],
    ]);
    return { items: rows.rows, total: count.rows[0].n, pageSize: size };
  });
  // One-time reset link — generated by an admin AFTER verifying the customer's identity out-of-band.
  r.post('/api/admin/customers/:id/reset-link', admin, async (ctx) => {
    const u = await db.get("SELECT id, name FROM profiles WHERE id = ? AND role = 'customer' AND deleted_at IS NULL", int(ctx.params.id, { min: 1 }));
    if (!u) throw new HttpError(404, 'not_found', 'العميل غير موجود');
    const token = randomHex(24);
    await db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?)', u.id, sha256(token), new Date(Date.now() + 3600_000).toISOString(), ctx.user.id);
    await audit(ctx, 'customer.reset_link', 'customer', u.id);
    return { url: `${originOf(ctx.request)}/reset?token=${token}`, expiresInMinutes: 60 };
  });

  r.get('/api/admin/support', staff, async (ctx) => {
    const st = ctx.query.get('status'); const w = ['open', 'in_progress', 'resolved'].includes(st) ? 'WHERE status = ?' : '';
    return { items: await db.all(`SELECT * FROM support_requests ${w} ORDER BY (status = 'resolved'), id DESC LIMIT 200`, ...(w ? [st] : [])) };
  });
  r.patch('/api/admin/support/:id', staff, async (ctx) => {
    const b = await ctx.json(); const id = int(ctx.params.id, { min: 1 });
    if (!['open', 'in_progress', 'resolved'].includes(b.status)) throw bad('invalid_status', 'حالة غير صالحة');
    await db.run('UPDATE support_requests SET status = ?, note = ?, handled_by = ?, updated_at = ? WHERE id = ?', b.status, str(b.note, { max: 500 }), ctx.user.id, nowIso(), id);
    return { ok: true };
  });

  // ── Staff accounts ─────────────────────────────────────────────────────────
  r.get('/api/admin/staff', admin, async () => ({ items: await db.all("SELECT id, name, email, phone, role, created_at, last_login_at FROM profiles WHERE role IN ('admin','staff') AND deleted_at IS NULL ORDER BY id") }));
  r.post('/api/admin/staff', admin, async (ctx) => {
    const b = await ctx.json();
    const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' }); const email = emailOrEmpty(b.email);
    if (!email) throw bad('invalid_email', 'البريد الإلكتروني مطلوب', { field: 'email' });
    checkPasswordPolicy(b.password);
    if (await db.get('SELECT 1 AS x FROM profiles WHERE email = ?', email)) throw new HttpError(409, 'email_taken', 'البريد مستخدم بالفعل', { field: 'email' });
    const role = b.role === 'admin' ? 'admin' : 'staff';
    const id = (await db.run('INSERT INTO profiles (name, email, password_hash, role) VALUES (?, ?, ?, ?)', name, email, await hashPassword(b.password), role)).lastInsertRowid;
    await audit(ctx, 'staff.create', 'staff', id, { role }); return { id };
  });
  r.delete('/api/admin/staff/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    if (id === ctx.user.id) throw new HttpError(409, 'self', 'لا يمكنك حذف حسابك الحالي');
    const left = (await db.get("SELECT COUNT(*) AS n FROM profiles WHERE role = 'admin' AND deleted_at IS NULL AND id != ?", id)).n;
    const target = await db.get('SELECT role FROM profiles WHERE id = ?', id);
    if (target?.role === 'admin' && left < 1) throw new HttpError(409, 'last_admin', 'لا يمكن حذف المدير الوحيد');
    await db.batch([destroyUserSessionsStmt(id), ["UPDATE profiles SET deleted_at = ?, email = NULL, phone = NULL, password_hash = 'deleted' WHERE id = ? AND role IN ('admin','staff')", nowIso(), id]]);
    await audit(ctx, 'staff.delete', 'staff', id); return { ok: true };
  });

  // ── Payment gateways (credentials entered here; secrets are encrypted and never sent back) ──
  const gwView = async (row, origin) => {
    const t = types()[row.type]; const secrets = await unseal(row.secrets); let cfg = {}; try { cfg = JSON.parse(row.config || '{}'); } catch { /* */ }
    return {
      id: row.id, type: row.type, type_label: t?.label || row.type, label: row.label, enabled: !!row.enabled, mode: row.mode, sort_order: row.sort_order,
      available: !!t, config: cfg, secrets_masked: Object.fromEntries((t?.fields || []).filter((f) => f.kind === 'secret').map((f) => [f.key, mask(secrets[f.key])])),
      webhook_url: webhookUrlForId(origin, row.id), updated_at: row.updated_at,
    };
  };
  async function gatewayInput(type, b, existing) {
    const t = types()[type]; if (!t) throw bad('invalid_type', 'نوع البوابة غير متاح');
    const label = str(b.label, { min: 2, max: 60, required: true, field: 'label' });
    const mode = b.mode === 'test' ? 'test' : 'live';
    const enabled = flag(b.enabled, 0);
    const old = existing ? await unseal(existing.secrets) : {};
    const config = {}; const secrets = { ...old };
    for (const f of t.fields) {
      if (f.kind === 'secret') {
        const v = b.secrets?.[f.key];
        if (typeof v === 'string' && v.trim()) secrets[f.key] = v.trim().slice(0, 500);
        if (Array.isArray(b.clear_secrets) && b.clear_secrets.includes(f.key)) delete secrets[f.key];
      } else {
        let v = typeof b.config?.[f.key] === 'string' ? b.config[f.key].trim() : (f.def ?? '');
        if (v === '' && f.def !== undefined && f.input !== 'textarea') v = f.def;
        if (v.length > 4000) throw bad('invalid_' + f.key, 'النص طويل جدًا', { field: f.key });
        if (f.input === 'select' && v && !f.options.some(([k]) => k === v)) throw bad('invalid_' + f.key, 'قيمة غير صالحة', { field: f.key });
        if (f.input === 'url' && v) {
          let u; try { u = new URL(v); } catch { throw bad('invalid_' + f.key, 'رابط غير صالح', { field: f.key }); }
          if (u.protocol !== 'https:' && !(rt.config.allowLocalGateways && u.protocol === 'http:')) throw bad('invalid_' + f.key, 'يجب أن يبدأ الرابط بـ https://', { field: f.key });
        }
        if ((f.key === 'create_headers' || f.key === 'create_body') && v) { try { const o = JSON.parse(v); if (!o || typeof o !== 'object') throw 0; } catch { throw bad('invalid_' + f.key, 'JSON غير صالح', { field: f.key }); } }
        config[f.key] = v;
      }
    }
    if (enabled) {
      for (const f of t.fields) {
        const val = f.kind === 'secret' ? secrets[f.key] : config[f.key];
        if (f.required && !val) throw bad('invalid_' + f.key, `الحقل «${f.label}» مطلوب لتفعيل البوابة`, { field: f.key });
      }
      if (type === 'generic' && !secrets.webhook_secret) throw bad('invalid_webhook_secret', 'أدخل Webhook Secret لقبول إشعارات الدفع المؤكَّدة (أو اعتمد الاستعلام عن الحالة بعد العودة).', { field: 'webhook_secret' });
    }
    return { label, mode, enabled, config, secrets, sort_order: int(b.sort_order, { min: 0, max: 100000, required: false, def: 0 }) };
  }
  const guardPaymentMethods = async (exceptId) => {
    const others = (await db.get('SELECT COUNT(*) AS n FROM payment_gateways WHERE enabled = 1 AND id != ?', exceptId ?? -1)).n;
    if (!(await getSettings()).cash_enabled && !others) throw new HttpError(409, 'no_payment_method', 'لا يمكن تعطيل آخر طريقة دفع مفعّلة (الدفع عند الاستلام معطّل).');
  };
  r.get('/api/admin/payment-gateways', admin, async (ctx) => {
    const origin = originOf(ctx.request);
    return { items: await Promise.all((await db.all('SELECT * FROM payment_gateways ORDER BY sort_order, id')).map((row) => gwView(row, origin))), types: catalog(), siteUrl: origin };
  });
  r.post('/api/admin/payment-gateways', admin, async (ctx) => {
    const b = await ctx.json(32 * 1024); const g = await gatewayInput(b.type, b, null);
    const id = (await db.run('INSERT INTO payment_gateways (type, label, enabled, mode, config, secrets, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      b.type, g.label, g.enabled, g.mode, JSON.stringify(g.config), await seal(g.secrets), g.sort_order)).lastInsertRowid;
    await audit(ctx, 'gateway.create', 'gateway', id, { type: b.type, enabled: g.enabled });
    return { id, item: await gwView(await db.get('SELECT * FROM payment_gateways WHERE id = ?', id), originOf(ctx.request)) };
  });
  r.put('/api/admin/payment-gateways/:id', admin, async (ctx) => {
    const ex = await db.get('SELECT * FROM payment_gateways WHERE id = ?', int(ctx.params.id, { min: 1 }));
    if (!ex) throw new HttpError(404, 'not_found', 'البوابة غير موجودة');
    const b = await ctx.json(32 * 1024); const g = await gatewayInput(ex.type, b, ex);
    if (!g.enabled) await guardPaymentMethods(ex.id);
    await db.run('UPDATE payment_gateways SET label = ?, enabled = ?, mode = ?, config = ?, secrets = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      g.label, g.enabled, g.mode, JSON.stringify(g.config), await seal(g.secrets), g.sort_order, nowIso(), ex.id);
    await audit(ctx, 'gateway.update', 'gateway', ex.id, { enabled: g.enabled });
    return { item: await gwView(await db.get('SELECT * FROM payment_gateways WHERE id = ?', ex.id), originOf(ctx.request)) };
  });
  r.delete('/api/admin/payment-gateways/:id', admin, async (ctx) => {
    const id = int(ctx.params.id, { min: 1 });
    if (await db.get('SELECT 1 AS x FROM payments WHERE gateway_id = ? LIMIT 1', id)) throw new HttpError(409, 'has_payments', 'عليها عمليات دفع مسجّلة. عطّلها بدل حذفها لتبقى السجلات.');
    const ex = await db.get('SELECT enabled FROM payment_gateways WHERE id = ?', id);
    if (ex?.enabled) await guardPaymentMethods(id);
    await db.run('DELETE FROM payment_gateways WHERE id = ?', id); await audit(ctx, 'gateway.delete', 'gateway', id); return { ok: true };
  });

  // ── Image upload (binary body; validated by magic bytes; stored by the platform: disk on Node, D1 on Workers) ──
  r.post('/api/admin/upload', admin, async (ctx) => {
    const buf = await readBody(ctx.request, rt.platform.maxUploadBytes || 1024 * 1024);
    let ext = null;
    if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ext = 'webp';
    else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
    else if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
    if (!ext) throw new HttpError(415, 'bad_image', 'الملف ليس صورة صالحة (webp / jpg / png)');
    const name = await rt.platform.uploads.put(buf, ext);
    await audit(ctx, 'upload', 'file', name, { bytes: buf.length });
    return { url: `/uploads/${name}`, bytes: buf.length };
  });

  r.get('/api/admin/audit', admin, async () => ({
    items: await db.all('SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, p.name AS user_name FROM audit_log a LEFT JOIN profiles p ON p.id = a.user_id ORDER BY a.id DESC LIMIT 100'),
  }));
}
