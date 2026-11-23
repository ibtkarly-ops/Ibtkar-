// First-run setup: a fresh store (no admin, no env credentials) must be claimable by its owner from the browser,
// and must not be claimable by a stranger on a public server. Runs in its own process (own database).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3988;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abk-setup-'));
Object.assign(process.env, { DATA_DIR: dir, NODE_ENV: 'test', SITE_URL: `http://127.0.0.1:${PORT}`, PORT: String(PORT) });
delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_PASSWORD;
const base = `http://127.0.0.1:${PORT}`;
let server;
const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, cookie: (res.headers.getSetCookie?.() || [])[0] || '' };
};
before(async () => { const { start } = await import('../server/index.js'); server = await start({ port: PORT, host: '127.0.0.1' }); });
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 100).unref(); });

test('fresh store: needs setup, a setup code is generated, the shop works but is empty', async () => {
  assert.equal((await call('GET', '/api/setup/status')).json.needsSetup, true);
  assert.equal((await call('GET', '/api/setup/status', undefined, { 'x-forwarded-for': '8.8.8.8' })).json.needsCode, true); // behind a proxy ⇒ code required
  assert.equal((await call('GET', '/api/setup/status')).json.needsCode, false);                                           // same machine ⇒ no code
  assert.match(fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8').trim(), /^[A-Z2-9]{8}$/);
  assert.equal((await call('GET', '/api/products')).json.total, 0);
  assert.equal((await call('GET', '/healthz')).status, 200);
  // the real logo is served from the first request
  assert.equal((await call('GET', '/api/bootstrap')).json.settings.logo_url, '/assets/logo.webp');
  assert.match((await call('GET', '/')).text, /<img src="\/assets\/logo\.webp"/);
});

test('a stranger (via proxy) cannot claim the store without the setup code', async () => {
  const proxy = { 'x-forwarded-for': '203.0.113.9' };
  const body = { name: 'مالك', email: 'owner@example.ly', password: 'Owner-Strong-Pass-9', confirm: 'Owner-Strong-Pass-9' };
  assert.equal((await call('POST', '/api/setup', body, proxy)).status, 403);
  assert.equal((await call('POST', '/api/setup', { ...body, code: 'WRONGCODE' }, proxy)).status, 403);
  assert.equal((await call('GET', '/api/setup/status')).json.needsSetup, true);
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'owner@example.ly', password: 'Owner-Strong-Pass-9' })).status, 401);
});

test('owner creates the account from the browser; validation; then setup closes for good', async () => {
  const ok = { name: 'مالك المتجر', email: 'Owner@Example.ly', password: 'Owner-Strong-Pass-9', confirm: 'Owner-Strong-Pass-9' };
  assert.equal((await call('POST', '/api/setup', { ...ok, password: '123', confirm: '123' })).status, 400);                // weak password
  assert.equal((await call('POST', '/api/setup', { ...ok, confirm: 'different-pass-1' })).status, 400);                    // mismatch
  assert.equal((await call('POST', '/api/setup', { ...ok, email: 'not-an-email' })).status, 400);
  const code = fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8').trim();
  const res = await call('POST', '/api/setup', { ...ok, code: code.toLowerCase().replace(/^(....)/, '$1-') }, { 'x-forwarded-for': '203.0.113.9' }); // remote + correct code (any case/dash)
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.user.role, 'admin'); assert.equal(res.json.user.email, 'owner@example.ly');
  assert.match(res.cookie, /abk_sid=/);
  assert.equal(fs.existsSync(path.join(dir, 'setup-code.txt')), false);                                                    // code file removed
  assert.equal((await call('GET', '/api/setup/status')).json.needsSetup, false);
  assert.equal((await call('POST', '/api/setup', ok)).status, 409);                                                         // closed
  const login = await call('POST', '/api/auth/login', { identifier: 'owner@example.ly', password: 'Owner-Strong-Pass-9' });
  assert.equal(login.status, 200); assert.equal(login.json.user.role, 'admin');
  // the new admin can reach the admin API and sees the real "get started" state
  const d = await call('GET', '/api/admin/dashboard', undefined, { cookie: login.cookie.split(';')[0] });
  assert.equal(d.status, 200);
  assert.equal(d.json.setup.products, 0); assert.equal(d.json.setup.logo, true);
});
