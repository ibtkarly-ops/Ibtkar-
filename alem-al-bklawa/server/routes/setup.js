// First-run setup: while NO admin exists, /admin offers a one-time "create the owner account" form.
//  • The platform decides whether a code is needed (rt.platform.setup):
//      Node     – none from the same computer (loopback, no proxy headers); otherwise a one-time code from the server log /
//                 data/setup-code.txt, so a stranger who finds a fresh public server cannot claim it.
//      Workers  – none by default (the owner opens /admin right after deploying); set the SETUP_CODE variable to require one.
//  • Once an admin exists the endpoint is permanently closed (409).
import crypto from 'node:crypto';
import { rt, db } from '../runtime.js';
import { HttpError, str, emailOrEmpty, normalizePhone, bad } from '../lib.js';
import { rateLimit } from '../http.js';
import { hashPassword, checkPasswordPolicy, createSession, publicUser } from '../auth.js';

export const adminExists = async () => !!(await db.get("SELECT 1 AS x FROM profiles WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1"));

export function register(r) {
  r.get('/api/setup/status', async (ctx) => {
    const needs = !(await adminExists());
    const needsCode = needs && rt.platform.setup.needsCode(ctx.request, ctx.info);
    return { needsSetup: needs, needsCode, openClaim: needs && !needsCode && rt.platform.name === 'workers', codeWhere: rt.platform.setup.codeWhere || '' };
  });

  r.post('/api/setup', async (ctx) => {
    if (!(await rateLimit(`setup:${ctx.ip}`, 10, 15 * 60_000))) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. انتظر قليلًا.');
    if (await adminExists()) throw new HttpError(409, 'already_setup', 'تم إعداد المتجر بالفعل. سجّل الدخول.');
    const b = await ctx.json();
    if (rt.platform.setup.needsCode(ctx.request, ctx.info)) {
      const want = (await rt.platform.setup.expectedCode()) || '';
      const got = String(b.code || '').toUpperCase().replace(/[\s-]/g, '');
      const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!ok) throw new HttpError(403, 'bad_code', rt.platform.setup.codeHint || 'رمز الإعداد غير صحيح.', { field: 'code' });
    }
    const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' });
    const email = emailOrEmpty(b.email);
    if (!email) throw bad('invalid_email', 'البريد الإلكتروني مطلوب', { field: 'email' });
    const phone = b.phone ? normalizePhone(b.phone) : '';
    if (b.phone && !phone) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
    checkPasswordPolicy(b.password);
    if (b.password !== b.confirm) throw bad('password_mismatch', 'كلمتا المرور غير متطابقتين', { field: 'confirm' });
    const hash = await hashPassword(b.password);
    if (await db.get('SELECT 1 AS x FROM profiles WHERE email = ?', email)) throw new HttpError(409, 'email_taken', 'هذا البريد مسجّل كعميل. استخدم بريدًا آخر للمدير.', { field: 'email' });
    // One atomic statement: the row exists only if there is still no admin (two simultaneous requests cannot both win).
    let res;
    try {
      res = await db.run(`INSERT INTO profiles (name, email, phone, password_hash, role)
                          SELECT ?, ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM profiles WHERE role = 'admin' AND deleted_at IS NULL)`, name, email, phone || null, hash);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message))) throw new HttpError(409, 'email_taken', 'هذا البريد أو الهاتف مسجّل مسبقًا.', { field: 'email' });
      throw e;
    }
    if (!res.changes) throw new HttpError(409, 'already_setup', 'تم إعداد المتجر بالفعل. سجّل الدخول.');
    await rt.platform.setup.done();
    await createSession(ctx, res.lastInsertRowid);
    return { user: publicUser(await db.get('SELECT id, name, phone, email, role FROM profiles WHERE id = ?', res.lastInsertRowid)) };
  });
}
