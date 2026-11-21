"use strict";
// Shared Playwright helpers: a fake signed-in Supabase session plus mocked
// REST / RPC / Auth / Edge-Function endpoints, so the dashboard can be
// exercised end to end (and screenshotted) without touching the live project.
//
//   const { launch } = require('./mock');
//   const { page, close, calls } = await launch({ role:'super_admin', tables:{...}, functions:{...} });
//
// `calls` records every mocked request ({method,url,body}) for assertions.

const path = require('path');
const { chromium } = require('playwright');

const REF = 'ppegbmqkcdwopakewetl';
const UID = '11111111-2222-3333-4444-555555555555';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;

function makeSession({ expiresIn = 3600, name = 'ايوب' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: jwt({ sub: UID, role: 'authenticated', exp: now + expiresIn, email: 'admin@test.ly' }),
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: 'rt-' + Math.random().toString(36).slice(2),
    user: { id: UID, aud: 'authenticated', role: 'authenticated', email: 'admin@test.ly', user_metadata: { full_name: name } },
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
  'access-control-expose-headers': 'content-range',
};

async function launch(opts = {}) {
  const {
    role = 'super_admin',
    signedIn = true,
    tables = {},
    rpc = {},
    functions = {},
    viewport = { width: 390, height: 844 },
    dark = false,
    expiresIn = 3600,
    scale = 1,
  } = opts;

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  const session = makeSession({ expiresIn });
  const profile = { id: UID, full_name: 'ايوب رضاء', role, lang: 'ar', status: 'active', created_at: new Date().toISOString() };
  const T = { profiles: [profile], notifications: [], websites: [], plans: [], banners: [], ...tables };

  await context.addInitScript(([ref, sess, isIn, isDark]) => {
    try {
      if (isIn) localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(sess));
      if (isDark) localStorage.setItem('theme', 'dark');
      localStorage.setItem('lang', 'ar');
    } catch (e) { /* ignore */ }
  }, [REF, session, signedIn, dark]);

  await context.route('**/*supabase.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postDataJSON(); } catch { body = req.postData(); }
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ method, url: url.pathname + url.search, body });
    const json = (status, data, extra = {}) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: JSON.stringify(data) });

    if (url.pathname.startsWith('/auth/v1/token')) {
      const s = makeSession({ expiresIn });
      return json(200, s);
    }
    if (url.pathname.startsWith('/auth/v1/user')) return json(200, session.user);
    if (url.pathname.startsWith('/auth/v1/')) return json(200, {});

    if (url.pathname.startsWith('/functions/v1/')) {
      const name = url.pathname.split('/')[3];
      const h = functions[name];
      if (typeof h === 'function') {
        const r = await h(body, url);
        if (r && r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
        if (r && r.hang) return new Promise(() => {});
        return json(r.status || 200, r.body ?? r);
      }
      return json(200, h ?? { ok: true });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/')[4];
      const h = rpc[fn];
      const v = typeof h === 'function' ? await h(body) : h;
      return json(200, v === undefined ? true : v);
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.split('/')[3];
      const accept = req.headers()['accept'] || '';
      const rows = T[table] || [];
      if (method === 'GET' || method === 'HEAD') {
        const range = { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, ...range } });
        if (accept.includes('vnd.pgrst.object')) return json(rows.length ? 200 : 406, rows[0] || { code: 'PGRST116', message: 'no rows' }, range);
        return json(200, rows, range);
      }
      // write: echo back with an id
      const echo = Array.isArray(body) ? body : [{ id: 'new-' + Math.random().toString(36).slice(2, 8), ...(body || {}) }];
      if (method === 'POST' && Array.isArray(T[table])) T[table].push(...echo);
      if (accept.includes('vnd.pgrst.object')) return json(201, echo[0]);
      return json(method === 'POST' ? 201 : 200, echo);
    }
    return json(200, {});
  });

  const file = opts.file || path.resolve(__dirname, '..', 'public', 'index.html');
  const url = 'file://' + file + (opts.hash || '');
  const open = async (hash = '') => { await page.goto('file://' + file + hash); };

  return { browser, context, page, calls, errors, T, session, open, url, close: () => browser.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { launch, sleep, UID, REF };
