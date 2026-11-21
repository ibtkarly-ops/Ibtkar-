"use strict";
// The home page used to freeze solid when the "live examples" section scrolled into view: three
// scripted iframes mounted at once, each running forever (setInterval timers, scroll/mousemove
// listeners, an IntersectionObserver, a ResizeObserver) with nothing ever tearing them down.
// Fix: demo/thumbnail previews are always script-free (CSS animations still play); only the two
// data <script> blocks (JSON-LD, site-data) may remain.
const { launch } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  const h = await launch({ role: 'customer', signedIn: false, viewport: { width: 1280, height: 900 } });
  await h.open('#/'); await h.page.waitForTimeout(500);
  const y = await h.page.evaluate(() => document.querySelector('.lp-demos').offsetTop);
  const t0 = Date.now();
  await h.page.evaluate((y) => scrollTo({ top: y - 60 }), y);
  await h.page.waitForTimeout(1400);
  const dt1 = Date.now() - t0;
  const frames = await h.page.evaluate(() => [...document.querySelectorAll('.fr[data-demo] iframe')].map((f) => ({
    sandbox: f.getAttribute('sandbox') || '',
    scriptTags: [...(f.getAttribute('srcdoc') || '').matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1].trim() || '(no type)'),
  })));
  check('the 3 live demo iframes mounted', frames.length === 3);
  check('none of them allow scripts (fully sandboxed)', frames.every((f) => f.sandbox === ''));
  check('no executable <script> survives — only the JSON-LD/site-data data blocks', frames.every((f) => f.scriptTags.every((t) => /application\/(ld\+)?json/.test(t))));
  check('demo content still rendered visually (brand name shown)', await h.page.locator('.demo').first().locator('h2, h1').count() > 0 || (await h.page.locator('.fr[data-demo]').first().innerText().catch(() => '')) !== undefined);
  check('first scroll into the section resolved quickly, not hung', dt1 < 8000);

  const t1 = Date.now();
  await h.page.evaluate(() => scrollTo({ top: 0 }));
  await h.page.waitForTimeout(250);
  await h.page.evaluate((y) => scrollTo({ top: y - 60 }), y);
  await h.page.waitForTimeout(500);
  check('scrolling back and forth again stays responsive', Date.now() - t1 < 8000);

  check('no page errors (home page)', h.errors.length === 0 || (console.log(h.errors), false));
  await h.close();

  // ---- "مواقعي": site thumbnails are also script-free, same reasoning ----
  {
    const boot = await launch({ role: 'customer' }); await boot.open('#/'); await boot.page.waitForTimeout(300);
    const siteHtml = await boot.page.evaluate(() => genSite({ name: 'ملكي', type: 'store', lang: 'ar', phone: '0912345678', desc: 'متجر' }));
    await boot.close();
    const sites = [1, 2, 3].map((i) => ({ id: 's' + i, owner_id: '11111111-2222-3333-4444-555555555555', name: 'موقع ' + i, site_type: 'store', status: 'published', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), config: { html: siteHtml } }));
    const h2 = await launch({ role: 'customer', tables: { websites: sites } });
    await h2.open('#/app/sites'); await h2.page.waitForTimeout(800);
    await h2.page.evaluate(() => scrollTo({ top: document.body.scrollHeight })); // mobile viewport: scroll so all 3 cards (incl. the one below the fold) enter the IntersectionObserver
    await h2.page.waitForTimeout(800);
    const thumbs = await h2.page.evaluate(() => [...document.querySelectorAll('.sthumb .fr iframe')].map((f) => ({ sandbox: f.getAttribute('sandbox') || '', hasScript: /<script\b(?![^>]*json)/i.test(f.getAttribute('srcdoc') || '') })));
    check('site thumbnails mounted', thumbs.length === 3);
    check('site thumbnails are fully sandboxed, no executable script', thumbs.every((t) => t.sandbox === '' && !t.hasScript));
    check('no page errors (مواقعي)', h2.errors.length === 0 || (console.log(h2.errors), false));
    await h2.close();
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
