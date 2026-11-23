// Read-side catalog queries (public shapes) + search index helpers. Few queries per request (D1 budgets queries).
import { rt } from './runtime.js';
import { qs } from './dbutil.js';
import { normalizeAr, tokens } from './lib.js';

const productSelect = `
  SELECT p.id, p.name, p.description, p.price, p.compare_price, p.image, p.available, p.sort_order,
         p.category_id, c.slug AS category_slug, c.name AS category_name, p.updated_at
    FROM products p JOIN categories c ON c.id = p.category_id`;

async function attachVariants(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const vs = await rt.db.all(`SELECT id, product_id, name, price, available FROM product_variants WHERE product_id IN (${qs(ids.length)}) ORDER BY sort_order, id`, ...ids);
  const by = new Map();
  for (const v of vs) { (by.get(v.product_id) || by.set(v.product_id, []).get(v.product_id)).push({ id: v.id, name: v.name, price: v.price, available: !!v.available }); }
  for (const r of rows) {
    r.available = !!r.available;
    r.variants = by.get(r.id) || [];
    if (r.variants.length) {
      const live = r.variants.filter((v) => v.available);
      r.price_from = Math.min(...(live.length ? live : r.variants).map((v) => v.price));
      r.available = r.available && live.length > 0;
    } else r.price_from = r.price;
  }
  return rows;
}

export async function listProducts({ category = '', q = '', limit = 24, offset = 0 } = {}) {
  const where = ['p.active = 1', 'c.active = 1', "c.kind = 'products'"]; const params = [];
  if (category && category !== 'all') { where.push('c.slug = ?'); params.push(category); }
  for (const t of tokens(q)) { where.push('p.search_text LIKE ?'); params.push(`%${t}%`); }
  const w = where.join(' AND ');
  const [count, page] = await rt.db.batch([
    [`SELECT COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id WHERE ${w}`, ...params],
    [`${productSelect} WHERE ${w} ORDER BY p.sort_order ASC, p.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset],
  ]);
  return { items: await attachVariants(page.rows), total: count.rows[0].n };
}

export async function getProduct(id) {
  const row = await rt.db.get(`${productSelect} WHERE p.id = ? AND p.active = 1 AND c.active = 1`, id);
  return row ? (await attachVariants([row]))[0] : null;
}

const bundleCols = 'id, name, description, price, image, max_qty, available, sort_order, updated_at';
async function attachBundleItems(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const items = await rt.db.all(`SELECT bundle_id, label, quantity FROM bundle_items WHERE bundle_id IN (${qs(ids.length)}) ORDER BY sort_order, id`, ...ids);
  const by = new Map();
  for (const it of items) (by.get(it.bundle_id) || by.set(it.bundle_id, []).get(it.bundle_id)).push({ label: it.label, quantity: it.quantity });
  for (const r of rows) { r.available = !!r.available; r.items = by.get(r.id) || []; }
  return rows;
}
export async function listBundles({ q = '', limit = 50, offset = 0 } = {}) {
  const where = ['active = 1']; const params = [];
  for (const t of tokens(q)) { where.push('search_text LIKE ?'); params.push(`%${t}%`); }
  const rows = await rt.db.all(`SELECT ${bundleCols} FROM bundles WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return attachBundleItems(rows);
}
export async function getBundle(id) {
  const row = await rt.db.get(`SELECT ${bundleCols} FROM bundles WHERE id = ? AND active = 1`, id);
  return row ? (await attachBundleItems([row]))[0] : null;
}

export async function search(q, limit = 12) {
  const toks = tokens(q);
  if (!toks.length) return { products: [], bundles: [], categories: [] };
  const norm = normalizeAr(q);
  const rank = (name, kw) => {
    const n = normalizeAr(name);
    return (n === norm ? 4 : n.startsWith(norm) ? 3 : toks.every((t) => n.includes(t)) ? 2 : kw ? 1 : 0);
  };
  const [{ items: found }, bundlesFound, cats] = await Promise.all([
    listProducts({ q, limit: 60 }), listBundles({ q, limit: 30 }),
    rt.db.all('SELECT slug, name, kind FROM categories WHERE active = 1 ORDER BY sort_order'),
  ]);
  const products = found.map((p) => ({ p, s: rank(p.name, true) })).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.p);
  const bundles = bundlesFound.map((b) => ({ b, s: rank(b.name, true) })).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.b);
  const categories = cats.filter((c) => toks.every((t) => normalizeAr(c.name).includes(t))).slice(0, 4);
  return { products, bundles, categories };
}

// ── Search index text (computed from the data being saved; no extra reads) ─
export const productSearchText = ({ name, description, keywords }, categoryName, variantNames = []) =>
  normalizeAr(`${name} ${description || ''} ${keywords || ''} ${categoryName || ''} ${variantNames.join(' ')}`);
export const bundleSearchText = ({ name, description, keywords }, itemLabels = []) =>
  normalizeAr(`${name} ${description || ''} ${keywords || ''} ${itemLabels.join(' ')} باقه باقات مناسبات`);

/** Re-index every product of a category (after the category was renamed). */
export async function refreshCategoryProducts(categoryId) {
  const cat = await rt.db.get('SELECT name FROM categories WHERE id = ?', categoryId);
  if (!cat) return;
  const products = await rt.db.all('SELECT id, name, description, keywords FROM products WHERE category_id = ?', categoryId);
  if (!products.length) return;
  const vs = await rt.db.all(`SELECT product_id, name FROM product_variants WHERE product_id IN (${qs(products.length)})`, ...products.map((p) => p.id));
  const by = new Map(); for (const v of vs) (by.get(v.product_id) || by.set(v.product_id, []).get(v.product_id)).push(v.name);
  await rt.db.batch(products.map((p) => ['UPDATE products SET search_text = ? WHERE id = ?', productSearchText(p, cat.name, by.get(p.id) || []), p.id]));
}
