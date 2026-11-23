// Passwords (PBKDF2-SHA256 via WebCrypto), sessions (opaque random token, hashed in DB), roles.
import crypto from 'node:crypto';
import { rt } from './runtime.js';
import { nowIso } from './dbutil.js';
import { HttpError, bad } from './lib.js';
import { parseCookies, cookieHeader, isSecure, sha256, randomHex } from './http.js';

export const COOKIE = 'abk_sid';
const subtle = () => globalThis.crypto.subtle;
const b64 = (u8) => Buffer.from(u8).toString('base64');

async function pbkdf2(password, salt, iterations) {
  const key = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(pw) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const it = rt.config.passwordIterations;
  return `pbkdf2$sha256$${it}$${b64(salt)}$${b64(await pbkdf2(pw, salt, it))}`;
}

/** Hashes written by the first release of the Node server (scrypt). Still accepted so existing accounts keep working. */
function verifyLegacyScrypt(pw, stored) {
  return new Promise((resolve) => {
    try {
      const [, n, r, p, salt, key] = String(stored).split('$'); const expected = Buffer.from(key, 'base64');
      crypto.scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 },
        (err, got) => resolve(!err && got.length === expected.length && crypto.timingSafeEqual(got, expected)));
    } catch { resolve(false); }
  });
}

export async function verifyPassword(pw, stored) {
  try {
    if (String(stored).startsWith('scrypt$')) return await verifyLegacyScrypt(pw, stored);
    const [alg, hash, it, salt, key] = String(stored).split('$');
    if (alg !== 'pbkdf2' || hash !== 'sha256') { await burnTime(pw); return false; }
    const expected = Buffer.from(key, 'base64');
    const got = Buffer.from(await pbkdf2(pw, Buffer.from(salt, 'base64'), Number(it)));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}

let dummyHash = null;
/** Spend the same time as a real verification so unknown accounts can't be told apart by timing. */
export async function burnTime(pw) {
  dummyHash ||= await hashPassword('timing-equaliser-' + randomHex(8));
  const [, , it, salt] = dummyHash.split('$');
  await pbkdf2(String(pw), Buffer.from(salt, 'base64'), Number(it)).catch(() => {});
}

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string') throw bad('invalid_password', 'كلمة المرور مطلوبة', { field: 'password' });
  if (pw.length < 8) throw bad('weak_password', 'كلمة المرور يجب ألا تقل عن 8 أحرف', { field: 'password' });
  if (pw.length > 128) throw bad('weak_password', 'كلمة المرور طويلة جدًا', { field: 'password' });
  if (/^(.)\1+$/.test(pw) || /^(12345678|password|qwertyui|00000000)/i.test(pw)) throw bad('weak_password', 'كلمة المرور ضعيفة جدًا', { field: 'password' });
}

// ── Sessions ───────────────────────────────────────────────────────────────
export async function createSession(ctx, userId) {
  const token = randomHex(32);
  const days = rt.config.sessionDays;
  await rt.db.batch([
    ['INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
      sha256(token), userId, new Date(Date.now() + days * 86400_000).toISOString(), ctx.ip, String(ctx.request.headers.get('user-agent') || '').slice(0, 200)],
    ['UPDATE profiles SET last_login_at = ? WHERE id = ?', nowIso(), userId],
  ]);
  ctx.setCookie(cookieHeader(COOKIE, token, { maxAge: days * 86400, secure: isSecure(ctx.request) }));
}
export async function destroySession(ctx) {
  const token = parseCookies(ctx.request.headers)[COOKIE];
  if (token) await rt.db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
  ctx.setCookie(cookieHeader(COOKIE, '', { maxAge: 0, secure: isSecure(ctx.request) }));
}
export async function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) await rt.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, sha256(exceptToken));
  else await rt.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}
/** Statements (for a batch) that sign a user out everywhere. */
export const destroyUserSessionsStmt = (userId) => ['DELETE FROM sessions WHERE user_id = ?', userId];

/** Returns the signed-in profile (without hash) or null. */
export async function currentUser(request) {
  const token = parseCookies(request.headers)[COOKIE];
  if (!token || token.length < 32) return null;
  const row = await rt.db.get(
    `SELECT s.id AS sid, s.expires_at, p.id, p.name, p.phone, p.email, p.role, p.deleted_at
       FROM sessions s JOIN profiles p ON p.id = s.user_id WHERE s.id = ?`, sha256(token));
  if (!row || row.deleted_at || row.expires_at < nowIso()) {
    if (row) await rt.db.run('DELETE FROM sessions WHERE id = ?', row.sid);
    return null;
  }
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, role: row.role, token };
}

export const publicUser = (u) => (u ? { id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role } : null);

// ── Guards (used as route middleware; sync because ctx.user is already resolved) ──
export const requireUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول'); };
export const requireStaff = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول');
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'staff') throw new HttpError(403, 'forbidden', 'غير مصرح');
};
export const requireAdmin = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول');
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'هذه العملية للمدير فقط');
};

export async function audit(ctx, action, entity, entityId, details) {
  await rt.db.run('INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ctx.user?.id ?? null, action, entity ?? null, entityId === undefined ? null : String(entityId),
    details ? JSON.stringify(details).slice(0, 1000) : null, ctx.ip);
}

/** Create the first admin from env on startup if none exists (the normal path is the first-run form in /admin). */
export async function bootstrapAdmin() {
  if (await rt.db.get("SELECT 1 AS x FROM profiles WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1")) return;
  const { email, password, name } = rt.config.admin;
  if (!email || !password) return;
  checkPasswordPolicy(password);
  await rt.db.run("INSERT INTO profiles (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", name, email.toLowerCase(), await hashPassword(password));
  console.log('[setup] تم إنشاء حساب المدير الأول:', email);
}
