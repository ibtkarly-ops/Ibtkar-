// Node.js adapter: HTTP server around the shared request handler (server/app.js).
import http from 'node:http';
import { Readable } from 'node:stream';
import { rt } from './runtime.js';
import { createNodeRuntime } from './node-runtime.js';
import { handle, ensureReady } from './app.js';

/** node:http request → Web Request */
function toRequest(req, port) {
  const host = req.headers.host || `localhost:${port}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) { if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v); }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url, `http://${host}`), { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
}

/** Web Response → node:http response */
async function send(res, response, head) {
  const headers = {};
  for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v;
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (head || !response.body) return res.end();
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export async function start({ port, host, env = process.env } = {}) {
  const { config, db, platform } = createNodeRuntime(env);
  port ??= config.port; host ??= config.host;
  await ensureReady();
  if (config.sandboxRequestedInProd) console.warn('[payments] PAYMENT_SANDBOX تجاهل: بوابة الاختبار ممنوعة في الإنتاج.');
  const server = http.createServer((req, res) => {
    const started = Date.now();
    handle(toRequest(req, port), { remoteAddress: req.socket.remoteAddress })
      .then((response) => send(res, response, req.method === 'HEAD'))
      .then(() => { if (env.LOG_REQUESTS === '1' && req.url.startsWith('/api/')) console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`); })
      .catch((e) => { console.error('[fatal]', e); try { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); } catch { /* */ } });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 65_000;
  await new Promise((resolve) => server.listen(port, host, resolve));
  const code = await platform.setup.pending();
  if (code) {
    const url = `${config.siteUrl.startsWith('http://localhost') ? `http://localhost:${server.address().port}` : config.siteUrl}/admin`;
    console.log(`\n[إعداد أولي] لا يوجد حساب مدير بعد. افتح ${url} وأنشئ حساب المدير من المتصفح.\n             من نفس الجهاز لا تحتاج رمزًا. من جهاز آخر استخدم رمز الإعداد: ${code}  (محفوظ أيضًا في ${platform.setup.codePath})\n`);
  }
  const close = () => { server.close(() => { try { db.close(); } catch { /* */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  if (env.NODE_ENV !== 'test') { process.on('SIGTERM', close); process.on('SIGINT', close); }
  server.config = config; server.db = db; // handy for tests and scripts
  return server;
}

export { rt };
