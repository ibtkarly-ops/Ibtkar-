// Accounts: register / login / logout / profile / password / orders / saved cart / delete / reset.
import { all, get, run, tx, nowIso } from '../db.js';
import { HttpError, str, emailOrEmpty, normalizePhone, bad } from '../lib.js';
import { rateLimit, rateLimitReset, sha256 } from '../http.js';
import {
  hashPassword, verifyPassword, burnTime, checkPasswordPolicy, createSession, destroySession,
  destroyUserSessions, publicUser, requireUser,
} from '../auth.js';
import { orderListView } from './orders.js';

function limited(key, max, windowMs) {
  if (!rateLimit(key, max, windowMs)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.');
}

function identify(raw) {
  const s = str(raw, { max: 120, required: true, field: 'identifier' });
  if (s.includes('@')) return { col: 'email', val: s.toLowerCase() };
  const phone = normalizePhone(s);
  if (!phone) throw bad('invalid_identifier', 'رقم الهاتف أو البريد الإلكتروني غير صالح', { field: 'identifier' });
  return { col: 'phone', val: phone };
}

export function register(r) {
  r.get('/api/auth/me', (ctx) => ({ user: publicUser(ctx.user) }));

  r.post('/api/auth/register', async (ctx) => {
    limited(`reg:${ctx.ip}`, 10, 3600_000);
    const b = await ctx.json();
    const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' });
    const phone = normalizePhone(b.phone);
    if (!phone) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
    const email = emailOrEmpty(b.email);
    checkPasswordPolicy(b.password);
    if (get('SELECT 1 AS x FROM profiles WHERE phone = ?', phone)) throw new HttpError(409, 'phone_taken', 'هذا الرقم مسجّل بالفعل. جرّب تسجيل الدخول.', { field: 'phone' });
    if (email && get('SELECT 1 AS x FROM profiles WHERE email = ?', email)) throw new HttpError(409, 'email_taken', 'هذا البريد مسجّل بالفعل. جرّب تسجيل الدخول.', { field: 'email' });
    const info = run('INSERT INTO profiles (name, phone, email, password_hash) VALUES (?, ?, ?, ?)', name, phone, email || null, await hashPassword(b.password));
    const id = Number(info.lastInsertRowid);
    createSession(ctx.req, ctx.res, id);
    return { user: publicUser(get('SELECT id, name, phone, email, role FROM profiles WHERE id = ?', id)) };
  });

  r.post('/api/auth/login', async (ctx) => {
    limited(`login-ip:${ctx.ip}`, 25, 15 * 60_000);
    const b = await ctx.json();
    const id = identify(b.identifier);
    const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    limited(`login-id:${id.val}`, 8, 15 * 60_000);
    const user = get(`SELECT * FROM profiles WHERE ${id.col} = ? AND deleted_at IS NULL`, id.val);
    if (!user) { await burnTime(pw); throw new HttpError(401, 'invalid_credentials', 'بيانات الدخول غير صحيحة'); }
    if (!(await verifyPassword(pw, user.password_hash))) throw new HttpError(401, 'invalid_credentials', 'بيانات الدخول غير صحيحة');
    rateLimitReset(`login-id:${id.val}`);
    createSession(ctx.req, ctx.res, user.id);
    return { user: publicUser(user) };
  });

  r.post('/api/auth/logout', (ctx) => { destroySession(ctx.req, ctx.res); return { ok: true }; });

  // Complete a reset with a one-time token the support team generated after verifying the customer.
  r.post('/api/auth/reset', async (ctx) => {
    limited(`reset:${ctx.ip}`, 10, 3600_000);
    const b = await ctx.json();
    checkPasswordPolicy(b.password);
    const token = str(b.token, { max: 200, required: true, field: 'token' });
    const row = get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token));
    if (!row || row.used_at || row.expires_at < nowIso()) throw new HttpError(400, 'invalid_token', 'رابط الاستعادة غير صالح أو منتهي. تواصل مع الدعم.');
    const hash = await hashPassword(b.password);
    tx(() => {
      run('UPDATE profiles SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), row.user_id);
      run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), row.id);
      destroyUserSessions(row.user_id);
    });
    return { ok: true };
  });

  // ── Profile ──
  r.patch('/api/account', requireUser, async (ctx) => {
    const b = await ctx.json();
    const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' });
    const phone = normalizePhone(b.phone);
    if (!phone) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
    const email = emailOrEmpty(b.email);
    if (get('SELECT 1 AS x FROM profiles WHERE phone = ? AND id != ?', phone, ctx.user.id)) throw new HttpError(409, 'phone_taken', 'هذا الرقم مستخدم في حساب آخر', { field: 'phone' });
    if (email && get('SELECT 1 AS x FROM profiles WHERE email = ? AND id != ?', email, ctx.user.id)) throw new HttpError(409, 'email_taken', 'هذا البريد مستخدم في حساب آخر', { field: 'email' });
    run('UPDATE profiles SET name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?', name, phone, email || null, nowIso(), ctx.user.id);
    return { user: publicUser(get('SELECT id, name, phone, email, role FROM profiles WHERE id = ?', ctx.user.id)) };
  });

  r.post('/api/account/password', requireUser, async (ctx) => {
    limited(`pw:${ctx.user.id}`, 8, 15 * 60_000);
    const b = await ctx.json();
    const row = get('SELECT password_hash FROM profiles WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(typeof b.current === 'string' ? b.current : '', row.password_hash))) throw new HttpError(403, 'wrong_password', 'كلمة المرور الحالية غير صحيحة', { field: 'current' });
    checkPasswordPolicy(b.password);
    run('UPDATE profiles SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(b.password), nowIso(), ctx.user.id);
    destroyUserSessions(ctx.user.id, ctx.user.token); // sign out other devices
    return { ok: true };
  });

  // ── Orders (own) ──
  r.get('/api/account/orders', requireUser, (ctx) => ({
    items: orderListView(all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100', ctx.user.id)),
  }));

  // ── Saved cart (restored on any device after login) ──
  r.get('/api/account/cart', requireUser, (ctx) => {
    const row = get('SELECT data FROM user_carts WHERE user_id = ?', ctx.user.id);
    let items = []; try { items = row ? JSON.parse(row.data) : []; } catch { /* empty */ }
    return { items: Array.isArray(items) ? items.slice(0, 40) : [] };
  });
  r.put('/api/account/cart', requireUser, async (ctx) => {
    const b = await ctx.json();
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map((i) => ({
      type: i?.type === 'bundle' ? 'bundle' : 'product', id: Number(i?.id) || 0, variantId: i?.variantId ? Number(i.variantId) : null,
      qty: Math.min(Math.max(Number(i?.qty) || 1, 1), 100), note: typeof i?.note === 'string' ? i.note.slice(0, 200) : '',
    })).filter((i) => i.id > 0);
    run(`INSERT INTO user_carts (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, ctx.user.id, JSON.stringify(items), nowIso());
    return { ok: true };
  });

  // ── Delete account (password + typed confirmation; scrubs personal data, keeps accounting rows) ──
  r.delete('/api/account', requireUser, async (ctx) => {
    limited(`del:${ctx.user.id}`, 5, 15 * 60_000);
    if (ctx.user.role !== 'customer') throw new HttpError(403, 'forbidden', 'لا يمكن حذف حساب الإدارة من هنا');
    const b = await ctx.json();
    if (b.confirm !== 'حذف') throw bad('confirm_required', 'اكتب كلمة «حذف» للتأكيد', { field: 'confirm' });
    const row = get('SELECT password_hash FROM profiles WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(typeof b.password === 'string' ? b.password : '', row.password_hash))) throw new HttpError(403, 'wrong_password', 'كلمة المرور غير صحيحة', { field: 'password' });
    const active = get("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status NOT IN ('delivered','cancelled')", ctx.user.id).n;
    if (active > 0) throw new HttpError(409, 'active_orders', 'لديك طلبات جارية. انتظر اكتمالها أو تواصل مع الدعم لإلغائها ثم أعد المحاولة.');
    tx(() => {
      // Orders keep totals/items for accounting; personal details are removed.
      run(`UPDATE orders SET customer_name = 'عميل محذوف', customer_phone = 'deleted', customer_email = NULL, address = NULL, notes = NULL,
                  user_id = NULL, scrubbed_at = ?, updated_at = ? WHERE user_id = ?`, nowIso(), nowIso(), ctx.user.id);
      run('DELETE FROM user_carts WHERE user_id = ?', ctx.user.id);
      run('DELETE FROM password_resets WHERE user_id = ?', ctx.user.id);
      run("UPDATE support_requests SET user_id = NULL, name = '', phone = '', message = '' WHERE user_id = ?", ctx.user.id);
      destroyUserSessions(ctx.user.id);
      run(`UPDATE profiles SET name = 'حساب محذوف', phone = NULL, email = NULL, password_hash = 'deleted',
                  deleted_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), ctx.user.id);
    });
    destroySession(ctx.req, ctx.res);
    return { ok: true };
  });
}
