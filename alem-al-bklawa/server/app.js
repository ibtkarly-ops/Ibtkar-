// Request handler shared by every runtime: takes a Web `Request`, returns a Web `Response`.
// Node (server/index.js) and Cloudflare Workers (cloudflare/worker.js) only provide the `platform` and call handle().
import { rt, db } from './runtime.js';
import { migrate } from './dbutil.js';
import { seedIfEmpty } from './settings.js';
import { Router, readJson, jsonResponse, textResponse, applySecurityHeaders, sameOriginOk, clientIp, originOf } from './http.js';
import { currentUser, bootstrapAdmin } from './auth.js';
import { HttpError } from './lib.js';
import { renderApp, sitemapXml, robotsTxt, routeStatus } from './seo.js';
import * as publicRoutes from './routes/public.js';
import * as accountRoutes from './routes/account.js';
import * as orderRoutes from './routes/orders.js';
import * as adminRoutes from './routes/admin.js';
import * as setupRoutes from './routes/setup.js';

const router = new Router();
for (const m of [publicRoutes, accountRoutes, orderRoutes, adminRoutes, setupRoutes]) m.register(router);

/** Create / upgrade the schema and seed the real starting data (categories, branches). Once per process / isolate. */
export function ensureReady() {
  rt.ready ||= (async () => {
    await migrate(rt.db, rt.platform.migrations);
    await seedIfEmpty();
    await bootstrapAdmin();
  })().catch((e) => { rt.ready = null; throw e; });
  return rt.ready;
}

const finalize = (res, request, cookies) => {
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers, request);
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, statusText: res.statusText, headers });
};

const UPLOAD_NAME = /^[a-z0-9_-]{8,64}\.(webp|jpg|png)$/;
const ROUTED = /^\/(api|pay|sandbox)\//;

/** @param {Request} request @param {{ remoteAddress?: string }} [info] connection details the runtime knows (Node: socket address) */
export async function handle(request, info = {}) {
  const url = new URL(request.url);
  const cookies = [];
  const done = (res) => finalize(res, request, cookies);
  try {
    const p = url.pathname;
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return done(textResponse(405, 'Method Not Allowed'));
    await ensureReady();

    if (p === '/healthz') { await db.get('SELECT 1 AS ok'); return done(textResponse(200, 'ok')); }

    const ctx = {
      request, info, url, query: url.searchParams, ip: clientIp(request, info), user: null, params: {}, status: 0,
      origin: originOf(request), json: (limit) => readJson(request, limit), setCookie: (c) => cookies.push(c),
    };

    if (ROUTED.test(p)) {
      const m = router.match(request.method === 'HEAD' ? 'GET' : request.method, p);
      if (!m) throw new HttpError(404, 'not_found', 'غير موجود');
      if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOriginOk(request)) throw new HttpError(403, 'bad_origin', 'طلب غير مسموح');
      ctx.params = m.params;
      ctx.user = await currentUser(request);
      let out;
      for (const fn of m.fns) out = await fn(ctx);
      if (out instanceof Response) return done(out);
      return done(jsonResponse(ctx.status || 200, out ?? { ok: true }));
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return done(textResponse(405, 'Method Not Allowed'));

    if (p.startsWith('/uploads/')) {
      const name = p.slice('/uploads/'.length);
      const f = UPLOAD_NAME.test(name) ? await rt.platform.uploads.get(name) : null;
      if (!f) return done(textResponse(404, 'not found'));
      return done(new Response(f.bytes, { status: 200, headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=31536000, immutable' } }));
    }
    if (p === '/sitemap.xml') return done(textResponse(200, await sitemapXml(request), 'application/xml; charset=utf-8', { 'cache-control': 'public, max-age=600' }));
    if (p === '/robots.txt') return done(textResponse(200, robotsTxt(request), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600' }));

    // Admin app: separate shell, separate assets.
    if (p === '/admin' || p.startsWith('/admin/')) {
      const rel = p.slice('/admin'.length).replace(/^\/+/, '');
      if (rel && !rel.endsWith('.html')) { const f = await rt.platform.assets.fetch(request); if (f) return done(f); }
      const shell = await rt.platform.assets.text('/admin/index.html');
      return done(textResponse(200, shell, 'text/html; charset=utf-8', { 'cache-control': 'no-cache' }));
    }

    if (p !== '/' && !p.endsWith('.html')) { const f = await rt.platform.assets.fetch(request); if (f) return done(f); }

    // Storefront SPA shell (with per-route SEO + embedded bootstrap data).
    return done(textResponse(routeStatus(p), await renderApp(request, p), 'text/html; charset=utf-8', { 'cache-control': 'no-cache' }));
  } catch (e) {
    if (e instanceof HttpError) return done(jsonResponse(e.status, { error: e.code, message: e.message, ...(e.extra || {}) }));
    console.error('[error]', request.method, url.pathname, e);
    return done(jsonResponse(500, { error: 'server_error', message: 'حدث خطأ غير متوقع. حاول مرة أخرى.' }));
  }
}
