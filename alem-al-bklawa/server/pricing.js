// Authoritative cart pricing. The browser's prices are NEVER trusted: every line is re-priced
// from the database here, both for the cart preview and again when the order is created.
import { all, get } from './db.js';
import { HttpError } from './lib.js';
import { getSettings } from './settings.js';

export const MAX_LINES = 40;
export const MAX_PRODUCT_QTY = 50;

/**
 * @param {Array<{type:string,id:number,variantId?:number,qty:number,note?:string}>} items
 * @param {{fulfillment?:'pickup'|'delivery', branchId?:number}} opts
 * @returns {{lines:object[], subtotal:number, deliveryFee:number, total:number, ok:boolean, problems:string[]}}
 */
export function priceCart(items, { fulfillment = 'pickup', branchId = null } = {}) {
  if (!Array.isArray(items)) throw new HttpError(400, 'invalid_items', 'السلة غير صالحة');
  if (items.length > MAX_LINES) throw new HttpError(400, 'too_many_lines', 'عدد الأصناف في السلة كبير جدًا');
  const settings = getSettings();
  const lines = []; const problems = [];

  for (const raw of items) {
    const type = raw?.type === 'bundle' ? 'bundle' : raw?.type === 'product' ? 'product' : null;
    const id = Number(raw?.id); const qty = Number(raw?.qty);
    const variantId = raw?.variantId ? Number(raw.variantId) : null;
    const note = typeof raw?.note === 'string' ? raw.note.trim().slice(0, 200) : '';
    const key = `${type}:${id}:${variantId || 0}`;
    const line = { key, type, id, variantId, qty, note, name: '', variantName: null, unitPrice: 0, lineTotal: 0, image: null, available: false, problem: null, maxQty: MAX_PRODUCT_QTY };

    if (!type || !Number.isInteger(id) || id < 1) { line.problem = 'invalid'; }
    else if (type === 'product') {
      const p = get(`SELECT p.id, p.name, p.price, p.image, p.available, p.active, c.active AS cat_active
                       FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, id);
      if (!p || !p.active || !p.cat_active) line.problem = 'unavailable';
      else {
        line.name = p.name; line.image = p.image; line.unitPrice = p.price;
        const vs = all('SELECT id, name, price, available FROM product_variants WHERE product_id = ? ORDER BY sort_order, id', id);
        if (vs.length) {
          const v = vs.find((x) => x.id === variantId);
          if (!v) line.problem = 'variant_required';
          else { line.variantName = v.name; line.unitPrice = v.price; line.available = !!p.available && !!v.available; }
        } else if (variantId) line.problem = 'variant_invalid';
        else line.available = !!p.available;
        if (!line.problem && !line.available) line.problem = 'unavailable';
      }
    } else {
      const b = get('SELECT id, name, price, image, max_qty, available, active FROM bundles WHERE id = ?', id);
      if (!b || !b.active) line.problem = 'unavailable';
      else {
        line.name = b.name; line.image = b.image; line.unitPrice = b.price; line.maxQty = b.max_qty; line.available = !!b.available;
        if (!line.available) line.problem = 'unavailable';
      }
    }
    if (!line.problem && (!Number.isInteger(qty) || qty < 1 || qty > line.maxQty)) line.problem = 'qty_invalid';
    if (Number.isInteger(qty) && qty >= 1) line.lineTotal = line.problem ? 0 : line.unitPrice * qty;
    if (line.problem) problems.push(`${line.name || key}:${line.problem}`);
    lines.push(line);
  }

  const subtotal = lines.reduce((s, l) => s + (l.problem ? 0 : l.lineTotal), 0);
  let deliveryFee = 0;
  if (fulfillment === 'delivery') {
    if (!settings.delivery_enabled) problems.push('delivery:disabled');
    else {
      if (branchId) {
        const b = get('SELECT delivers FROM branches WHERE id = ? AND active = 1', branchId);
        if (!b || !b.delivers) problems.push('delivery:branch_no_delivery');
      }
      deliveryFee = Math.max(0, Math.round(Number(settings.delivery_fee) || 0));
    }
  }
  return { lines, subtotal, deliveryFee, total: subtotal + deliveryFee, ok: problems.length === 0 && lines.length > 0, problems };
}
