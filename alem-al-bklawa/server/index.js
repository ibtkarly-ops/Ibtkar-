// HTTP server: routing, auth context, CSRF, errors, static files, SPA shell.
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { migrate, db } from './db.js';
import { seedIfEmpty } from './settings.js';
import { Router, readJson, sendJson, send, serveStatic, securityHeaders, sameOriginOk, clientIp } from './http.js';
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

const uploadsDir = path.join(config.dataDir, 'uploads');
const adminDir = path.join(config.publicDir, 'admin');

async function handleApi(req, res, url, ctx) {
  const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
  if (!m) throw new HttpError(404, 'not_found', 'غير موجود');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOriginOk(req)) throw new HttpError(403, 'bad_origin', 'طلب غير مسموح');
  ctx.params = m.params;
  ctx.user = currentUser(req);
  let out;
  for (const fn of m.fns) { out = await fn(ctx); }
  sendJson(req, res, ctx.status || 200, out ?? { ok: true });
}

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://local');
  const ctx = {
    req, res, url, query: url.searchParams, ip: clientIp(req), user: null, params: {}, status: 0,
    json: (limit) => readJson(req, limit),
  };
  securityHeaders(req, res);
  try {
    const p = url.pathname;
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return send(res, 405, 'Method Not Allowed');
    if (p === '/healthz') { db.prepare('SELECT 1').get(); return send(res, 200, 'ok', { 'Content-Type': 'text/plain' }); }
    if (p.startsWith('/api/')) return await handleApi(req, res, url, ctx);

    if (p.startsWith('/uploads/') && serveStatic(req, res, uploadsDir, p.slice('/uploads/'.length), { immutable: true })) return;
    if (p.startsWith('/pay/') || p.startsWith('/sandbox/')) {
      ctx.user = currentUser(req);
      if (await orderRoutes.pageRoutes(req, res, url, ctx)) return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

    if (p === '/sitemap.xml') return send(res, 200, sitemapXml(), { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
    if (p === '/robots.txt') return send(res, 200, robotsTxt(), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });

    // Admin app: separate shell, separate assets.
    if (p === '/admin' || p.startsWith('/admin/')) {
      const rel = p.slice('/admin'.length).replace(/^\/+/, '');
      if (rel && serveStatic(req, res, adminDir, rel)) return;
      return serveStatic(req, res, adminDir, 'index.html') || send(res, 404, 'not found');
    }

    if (p !== '/' && !p.endsWith('.html') && serveStatic(req, res, config.publicDir, p)) return;

    // Storefront SPA shell (with per-route SEO + embedded bootstrap data).
    const html = renderApp(p);
    return send(res, routeStatus(p), req.method === 'HEAD' ? '' : html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof HttpError) {
      const body = { error: e.code, message: e.message, ...(e.extra || {}) };
      return sendJson(req, res, e.status, body);
    }
    console.error('[error]', req.method, url.pathname, e);
    return sendJson(req, res, 500, { error: 'server_error', message: 'حدث خطأ غير متوقع. حاول مرة أخرى.' });
  } finally {
    if (url.pathname.startsWith('/api/') && process.env.LOG_REQUESTS === '1') console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

export async function start({ port = config.port, host = config.host } = {}) {
  migrate();
  seedIfEmpty();
  await bootstrapAdmin();
  if (config.payment.sandboxRequestedInProd) console.warn('[payments] PAYMENT_SANDBOX تجاهل: بوابة الاختبار ممنوعة في الإنتاج.');
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error('[fatal]', e); try { res.destroy(); } catch { /* */ } }); });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 65_000;
  await new Promise((resolve) => server.listen(port, host, resolve));
  const code = setupRoutes.ensureSetupCode();
  if (code) {
    const url = `${config.siteUrl.startsWith('http://localhost') ? `http://localhost:${server.address().port}` : config.siteUrl}/admin`;
    console.log(`\n[إعداد أولي] لا يوجد حساب مدير بعد. افتح ${url} وأنشئ حساب المدير من المتصفح.\n             من نفس الجهاز لا تحتاج رمزًا. من جهاز آخر استخدم رمز الإعداد: ${code}  (محفوظ أيضًا في ${setupRoutes.setupCodePath()})\n`);
  }
  const close = () => { server.close(() => { try { db.close(); } catch { /* */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  if (process.env.NODE_ENV !== 'test') { process.on('SIGTERM', close); process.on('SIGINT', close); }
  return server;
}
