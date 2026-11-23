// Passwords (scrypt), sessions (opaque random token, hashed in DB), roles.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { all, get, run, nowIso } from './db.js';
import { HttpError, bad } from './lib.js';
import { parseCookies, cookieHeader, isSecure, sha256, randomHex, clientIp } from './http.js';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const COOKIE = 'abk_sid';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY = await hashPassword('timing-equaliser-' + randomHex(8));

export async function verifyPassword(pw, stored) {
  try {
    const [alg, n, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') { await verifyAgainstDummy(pw); return false; }
    const expected = Buffer.from(key, 'base64');
    const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
async function verifyAgainstDummy(pw) { await verifyPassword(pw, DUMMY).catch(() => {}); }
export const burnTime = (pw) => verifyAgainstDummy(pw);

export function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string') throw bad('invalid_password', 'كلمة المرور مطلوبة', { field: 'password' });
  if (pw.length < 8) throw bad('weak_password', 'كلمة المرور يجب ألا تقل عن 8 أحرف', { field: 'password' });
  if (pw.length > 128) throw bad('weak_password', 'كلمة المرور طويلة جدًا', { field: 'password' });
  if (/^(.)\1+$/.test(pw) || /^(12345678|password|qwertyui|00000000)/i.test(pw)) throw bad('weak_password', 'كلمة المرور ضعيفة جدًا', { field: 'password' });
}

// ── Sessions ───────────────────────────────────────────────────────────────
export function createSession(req, res, userId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000).toISOString();
  run('INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, expires, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  run('UPDATE profiles SET last_login_at = ? WHERE id = ?', nowIso(), userId);
  res.setHeader('Set-Cookie', cookieHeader(COOKIE, token, { maxAge: config.sessionDays * 86400, secure: isSecure(req) }));
}
export function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.setHeader('Set-Cookie', cookieHeader(COOKIE, '', { maxAge: 0, secure: isSecure(req) }));
}
export function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, sha256(exceptToken));
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
}

/** Returns the signed-in profile (without hash) or null. */
export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length < 32) return null;
  const row = get(
    `SELECT s.id AS sid, s.expires_at, p.id, p.name, p.phone, p.email, p.role, p.deleted_at
       FROM sessions s JOIN profiles p ON p.id = s.user_id WHERE s.id = ?`, sha256(token));
  if (!row || row.deleted_at || row.expires_at < nowIso()) {
    if (row) run('DELETE FROM sessions WHERE id = ?', row.sid);
    return null;
  }
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, role: row.role, token };
}

export function publicUser(u) {
  return u ? { id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role } : null;
}

// ── Guards (used as route middleware) ──────────────────────────────────────
export const requireUser = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول');
};
export const requireStaff = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول');
  if (ctx.user.role !== 'admin' && ctx.user.role !== 'staff') throw new HttpError(403, 'forbidden', 'غير مصرح');
};
export const requireAdmin = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'unauthorized', 'يجب تسجيل الدخول');
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'هذه العملية للمدير فقط');
};

export function audit(ctx, action, entity, entityId, details) {
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ctx.user?.id ?? null, action, entity ?? null, entityId === undefined ? null : String(entityId),
    details ? JSON.stringify(details).slice(0, 1000) : null, ctx.ip);
}

/** Create the first admin from env on startup if none exists. */
export async function bootstrapAdmin() {
  if (get("SELECT 1 AS x FROM profiles WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1")) return;
  const { email, password, name } = config.admin;
  if (!email || !password) return; // no env credentials: the owner creates the account from /admin (first-run setup)
  checkPasswordPolicy(password);
  run("INSERT INTO profiles (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", name, email.toLowerCase(), await hashPassword(password));
  console.log('[setup] تم إنشاء حساب المدير الأول:', email);
}
