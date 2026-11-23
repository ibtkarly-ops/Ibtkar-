// First-run setup: while NO admin exists, /admin offers a one-time "create the owner account" form.
//  • From the same computer (loopback, no proxy headers) no code is needed.
//  • From anywhere else a one-time setup code is required; it is printed in the server log and saved in
//    DATA_DIR/setup-code.txt, so a stranger who finds a fresh public server cannot claim it.
//  • Once an admin exists the endpoint is permanently closed (409) and the code file is deleted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, run, tx } from '../db.js';
import { HttpError, str, emailOrEmpty, normalizePhone, bad } from '../lib.js';
import { rateLimit } from '../http.js';
import { hashPassword, checkPasswordPolicy, createSession, publicUser } from '../auth.js';

const codeFile = path.join(config.dataDir, 'setup-code.txt');
export const adminExists = () => !!get("SELECT 1 AS x FROM profiles WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1");

/** Returns the pending setup code (creating it) or null when an admin already exists. */
export function ensureSetupCode() {
  if (adminExists()) { try { fs.rmSync(codeFile, { force: true }); } catch { /* */ } return null; }
  try { const c = fs.readFileSync(codeFile, 'utf8').trim(); if (c) return c; } catch { /* create below */ }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  fs.writeFileSync(codeFile, code + '\n', { mode: 0o600 });
  return code;
}
export const setupCodePath = () => codeFile;

const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-host'];
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !FORWARD_HEADERS.some((h) => req.headers[h]);

export function register(r) {
  r.get('/api/setup/status', (ctx) => {
    const needs = !adminExists();
    return { needsSetup: needs, needsCode: needs && !isLocal(ctx.req) };
  });

  r.post('/api/setup', async (ctx) => {
    if (!rateLimit(`setup:${ctx.ip}`, 10, 15 * 60_000)) throw new HttpError(429, 'rate_limited', 'محاولات كثيرة. انتظر قليلًا.');
    if (adminExists()) throw new HttpError(409, 'already_setup', 'تم إعداد المتجر بالفعل. سجّل الدخول.');
    const b = await ctx.json();
    if (!isLocal(ctx.req)) {
      const want = ensureSetupCode() || '';
      const got = String(b.code || '').toUpperCase().replace(/[\s-]/g, '');
      const ok = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!ok) throw new HttpError(403, 'bad_code', 'رمز الإعداد غير صحيح. تجده في سجل تشغيل الخادم أو في الملف data/setup-code.txt.', { field: 'code' });
    }
    const name = str(b.name, { min: 2, max: 80, required: true, field: 'name' });
    const email = emailOrEmpty(b.email);
    if (!email) throw bad('invalid_email', 'البريد الإلكتروني مطلوب', { field: 'email' });
    const phone = b.phone ? normalizePhone(b.phone) : '';
    if (b.phone && !phone) throw bad('invalid_phone', 'رقم الهاتف غير صالح', { field: 'phone' });
    checkPasswordPolicy(b.password);
    if (b.password !== b.confirm) throw bad('password_mismatch', 'كلمتا المرور غير متطابقتين', { field: 'confirm' });
    const hash = await hashPassword(b.password);
    const id = tx(() => {
      if (adminExists()) throw new HttpError(409, 'already_setup', 'تم إعداد المتجر بالفعل. سجّل الدخول.');
      if (get('SELECT 1 AS x FROM profiles WHERE email = ?', email)) throw new HttpError(409, 'email_taken', 'هذا البريد مسجّل كعميل. استخدم بريدًا آخر للمدير.', { field: 'email' });
      return Number(run("INSERT INTO profiles (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')", name, email, phone || null, hash).lastInsertRowid);
    });
    try { fs.rmSync(codeFile, { force: true }); } catch { /* */ }
    createSession(ctx.req, ctx.res, id);
    return { user: publicUser(get('SELECT id, name, phone, email, role FROM profiles WHERE id = ?', id)) };
  });
}
