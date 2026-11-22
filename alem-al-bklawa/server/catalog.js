// Read-side catalog queries (public shapes) + search index maintenance.
import { all, get, run } from './db.js';
import { normalizeAr, tokens } from './lib.js';

const productSelect = `
  SELECT p.id, p.name, p.description, p.price, p.compare_price, p.image, p.available, p.sort_order,
         p.category_id, c.slug AS category_slug, c.name AS category_name, p.updated_at
    FROM products p JOIN categories c ON c.id = p.category_id`;

function attachVariants(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const vs = all(
    `SELECT id, product_id, name, price, available FROM product_variants
      WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`, ...ids);
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

export function listProducts({ category = '', q = '', limit = 24, offset = 0 } = {}) {
  const where = ['p.active = 1', 'c.active = 1', "c.kind = 'products'"]; const params = [];
  if (category && category !== 'all') { where.push('c.slug = ?'); params.push(category); }
  for (const t of tokens(q)) { where.push('p.search_text LIKE ?'); params.push(`%${t}%`); }
  const sql = `${productSelect} WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id WHERE ${where.join(' AND ')}`, ...params).n;
  const rows = all(`${sql} ORDER BY p.sort_order ASC, p.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { items: attachVariants(rows), total };
}

export function getProduct(id) {
  const row = get(`${productSelect} WHERE p.id = ? AND p.active = 1 AND c.active = 1`, id);
  return row ? attachVariants([row])[0] : null;
}

const bundleCols = 'id, name, description, price, image, max_qty, available, sort_order, updated_at';
function attachBundleItems(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const items = all(
    `SELECT bundle_id, label, quantity FROM bundle_items WHERE bundle_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`, ...ids);
  const by = new Map();
  for (const it of items) (by.get(it.bundle_id) || by.set(it.bundle_id, []).get(it.bundle_id)).push({ label: it.label, quantity: it.quantity });
  for (const r of rows) { r.available = !!r.available; r.items = by.get(r.id) || []; }
  return rows;
}
export function listBundles({ q = '', limit = 50, offset = 0 } = {}) {
  const where = ['active = 1']; const params = [];
  for (const t of tokens(q)) { where.push('search_text LIKE ?'); params.push(`%${t}%`); }
  const rows = all(`SELECT ${bundleCols} FROM bundles WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return attachBundleItems(rows);
}
export function getBundle(id) {
  const row = get(`SELECT ${bundleCols} FROM bundles WHERE id = ? AND active = 1`, id);
  return row ? attachBundleItems([row])[0] : null;
}

export function search(q, limit = 12) {
  const toks = tokens(q);
  if (!toks.length) return { products: [], bundles: [], categories: [] };
  const norm = normalizeAr(q);
  const rank = (name, kw) => {
    const n = normalizeAr(name);
    return (n === norm ? 4 : n.startsWith(norm) ? 3 : toks.every((t) => n.includes(t)) ? 2 : kw ? 1 : 0);
  };
  const products = listProducts({ q, limit: 60 }).items
    .map((p) => ({ p, s: rank(p.name, true) })).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.p);
  const bundles = listBundles({ q, limit: 30 })
    .map((b) => ({ b, s: rank(b.name, true) })).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.b);
  const categories = all("SELECT slug, name, kind FROM categories WHERE active = 1 ORDER BY sort_order")
    .filter((c) => toks.every((t) => normalizeAr(c.name).includes(t))).slice(0, 4);
  return { products, bundles, categories };
}

// ── Search index maintenance (called by admin writes) ──────────────────────
export function refreshProductSearch(id) {
  const p = get(`SELECT p.id, p.name, p.description, p.keywords, c.name AS cat FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, id);
  if (!p) return;
  const vs = all('SELECT name FROM product_variants WHERE product_id = ?', id).map((v) => v.name).join(' ');
  run('UPDATE products SET search_text = ? WHERE id = ?', normalizeAr(`${p.name} ${p.description} ${p.keywords} ${p.cat} ${vs}`), id);
}
export function refreshBundleSearch(id) {
  const b = get('SELECT id, name, description, keywords FROM bundles WHERE id = ?', id);
  if (!b) return;
  const items = all('SELECT label FROM bundle_items WHERE bundle_id = ?', id).map((i) => i.label).join(' ');
  run('UPDATE bundles SET search_text = ? WHERE id = ?', normalizeAr(`${b.name} ${b.description} ${b.keywords} ${items} باقه باقات مناسبات`), id);
}
export function refreshCategoryProducts(categoryId) {
  for (const r of all('SELECT id FROM products WHERE category_id = ?', categoryId)) refreshProductSearch(r.id);
}
