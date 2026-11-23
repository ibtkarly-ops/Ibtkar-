// DEVELOPMENT ONLY — fills the store with sample products so you can see the design and try the flows.
// The names/prices below are invented placeholders. NEVER run this against the real store:
// the real catalogue (products, prices, bundles, banners) is entered by the owner from /admin.
import { createNodeRuntime } from '../server/node-runtime.js';
import { migrate } from '../server/dbutil.js';
import { seedIfEmpty } from '../server/settings.js';
import { productSearchText, bundleSearchText } from '../server/catalog.js';

const { config, db, platform } = createNodeRuntime();
if (config.isProd && process.argv[2] !== '--force-i-know-this-is-fake-data') {
  console.error('رفض التنفيذ: NODE_ENV=production. هذه بيانات تجريبية وهمية للتطوير فقط.');
  process.exit(1);
}
await migrate(db, platform.migrations); await seedIfEmpty();
if (await db.get('SELECT 1 AS x FROM products LIMIT 1')) { console.log('المتجر يحتوي منتجات بالفعل — لن يتم إضافة بيانات تجريبية.'); process.exit(0); }

const catRows = Object.fromEntries((await db.all('SELECT id, slug, name FROM categories')).map((c) => [c.slug, c]));
const cat = (slug) => catRows[slug].id;
const P = [
  ['bklawa', 'بكلاوه بالفستق', 'طبقات رقيقة من العجين المقرمش وحشوة الفستق وقطر خفيف.', 0, [['علبة صغيرة', 18], ['علبة وسط', 35], ['علبة كبيرة', 65]]],
  ['bklawa', 'بكلاوه بالكاجو', 'حشوة الكاجو المحمّص وطعم متوازن الحلاوة.', 0, [['علبة صغيرة', 16], ['علبة وسط', 30], ['علبة كبيرة', 55]]],
  ['bklawa', 'بكلاوه مشكلة', 'تشكيلة من أنواع البكلاوه في علبة واحدة.', 0, [['500 غ', 32], ['1 كغ', 60]]],
  ['bklawa', 'عش البلبل', 'قطع عش البلبل المحشوة بالفستق.', 0, [['علبة صغيرة', 20], ['علبة كبيرة', 70]]],
  ['juice', 'عصير برتقال طازج', 'برتقال معصور عند الطلب.', 7, []],
  ['juice', 'عصير مانجو', 'مانجو طبيعي بدون إضافات.', 9, []],
  ['juice', 'عصير ليمون بالنعناع', 'منعش ومناسب للصيف.', 6, []],
  ['sweets', 'كنافة بالقشطة', 'كنافة ناعمة مع القشطة والقطر.', 14, []],
  ['sweets', 'معمول بالتمر', 'معمول محشو بالتمر.', 0, [['6 قطع', 10], ['12 قطعة', 18]]],
  ['sweets', 'بسبوسة اللوز', 'بسبوسة طرية مع لوزة.', 8, []],
  ['other', 'قهوة عربية', 'قهوة عربية مع تمر.', 5, []],
];
for (const [i, [c, name, desc, price, variants]] of P.entries()) {
  const base = variants.length ? variants[0][1] : price;
  const p = { name, description: desc, keywords: '' };
  const id = (await db.run('INSERT INTO products (category_id, name, description, price, available, sort_order, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
    cat(c), name, desc, base * 1000, name === 'بسبوسة اللوز' ? 0 : 1, (i + 1) * 10, productSearchText(p, catRows[c].name, variants.map((v) => v[0])))).lastInsertRowid;
  if (variants.length) await db.batch(variants.map(([vn, vp], j) => ['INSERT INTO product_variants (product_id, name, price, sort_order) VALUES (?, ?, ?, ?)', id, vn, vp * 1000, j]));
}
const bundles = [
  ['باقة الأفراح', 'تشكيلة فاخرة لمناسبات الزفاف والخطوبة.', 180000, 5, 10, [['بكلاوه مشكلة 1 كغ', 2], ['معمول بالتمر 12 قطعة', 1], ['عصير طبيعي', 6]]],
  ['باقة الضيافة', 'مناسبة للاجتماعات والزيارات.', 95000, 10, 20, [['بكلاوه مشكلة 500 غ', 1], ['كنافة بالقشطة', 4], ['قهوة عربية', 4]]],
];
for (const [name, description, price, maxQty, sort, items] of bundles) {
  const id = (await db.run('INSERT INTO bundles (name, description, price, max_qty, sort_order, search_text) VALUES (?, ?, ?, ?, ?, ?)',
    name, description, price, maxQty, sort, bundleSearchText({ name, description, keywords: '' }, items.map((x) => x[0])))).lastInsertRowid;
  await db.batch(items.map(([l, q], i) => ['INSERT INTO bundle_items (bundle_id, label, quantity, sort_order) VALUES (?, ?, ?, ?)', id, l, q, i]));
}
await db.run("INSERT INTO banners (title, description, button_text, link, sort_order) VALUES ('اكتشف منتجاتنا', 'بكلاوه طازجة وحلويات وعصائر وباقات للمناسبات.', 'اكتشف منتجاتنا', '/shop', 10)");
console.log('تمت إضافة بيانات تجريبية (للتطوير فقط).');
