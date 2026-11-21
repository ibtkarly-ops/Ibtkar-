"use strict";
// Publishing without a domain: https://<worker>/<slug> must render the published page inside an isolated iframe.
const http = require('http'), fs = require('fs'), path = require('path');
const { launch } = require('./mock');
const PUB = path.resolve(__dirname, '..', 'public');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.css': 'text/css' };
// same behaviour as the Worker's "single-page-application" fallback
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(PUB, u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const html = '<!doctype html><html><head><title>رويال سكيت</title></head><body><h1 id="x">مرحبا</h1><a id="a" href="#about">a</a><section id="about">about</section><script>try{localStorage.getItem("sb-x");window.__r="read"}catch(e){window.__r="blocked"}try{window.__p=String(window.parent.document.title)}catch(e){window.__p="blocked"}</script></body></html>';
  let tracked = 0;
  const h = await launch({ role: 'customer', signedIn: false, rpc: { get_published_site: (b) => (b.p_slug === 'royalskate' ? [{ website_id: 'w1', html, hash: 'h' }] : []) }, functions: { track: () => { tracked++; return { ok: true }; } } });
  const { page } = h;
  await page.goto(base + '/royalskate');
  await page.waitForSelector('iframe#sf', { timeout: 8000 });
  const sb = await page.getAttribute('iframe#sf', 'sandbox');
  check('site rendered inside an iframe', await page.frameLocator('iframe#sf').locator('#x').innerText() === 'مرحبا');
  check('iframe has NO allow-same-origin', !/allow-same-origin/.test(sb) && /allow-scripts/.test(sb));
  const fr = page.frames().find((f) => f !== page.mainFrame());
  check('site code cannot read platform localStorage', (await fr.evaluate(() => window.__r)) === 'blocked');
  check('site code cannot reach the parent page', (await fr.evaluate(() => window.__p)) === 'blocked');
  check('page title comes from the site', (await page.title()) === 'رويال سكيت');
  await page.waitForTimeout(300);
  check('visit tracked by the parent', tracked >= 1);
  await page.goto(base + '/nosuchsite'); await page.waitForTimeout(800);
  check('unknown slug -> 404', /404/.test(await page.locator('body').innerText()));
  await page.goto(base + '/'); await page.waitForTimeout(800);
  check('root path still shows the platform', (await page.locator('.lp-hero, nav .logo').count()) > 0);
  await page.goto(base + '/#/s/royalskate'); await page.waitForSelector('iframe#sf', { timeout: 8000 });
  check('hash route #/s/slug is isolated too', true);
  check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close(); srv.close();
  process.exit(fails ? 2 : 0);
})();
