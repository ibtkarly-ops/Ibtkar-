"use strict";
// Fixed bottom tab bar (icons) replacing the hamburger (☰) on mobile, in: customer dashboard,
// admin, and the home page. Desktop (>=1024px) is unaffected — the side drawer stays as-is.
const { launch, UID } = require('./mock');
let fails = 0; const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails++; };
(async () => {
  // ---- home page (public, mobile): 4 tabs, no "More", hamburger hidden ----
  {
    const h = await launch({ role: 'customer', signedIn: false });
    await h.open('#/'); await h.page.waitForTimeout(300);
    const info = await h.page.evaluate(() => ({
      tabs: [...document.querySelectorAll('#pubbtm .bn-i')].map((a) => a.textContent.trim()),
      more: document.querySelectorAll('#pubbtm [data-act="menu"]').length,
      menuBtnVisible: getComputedStyle(document.querySelector('#mbtn')).display !== 'none',
    }));
    check('home bottom nav has exactly 4 tabs', info.tabs.length === 4);
    check('home bottom nav has no "More" tab', info.more === 0);
    check('top hamburger hidden on mobile (replaced by bottom nav)', !info.menuBtnVisible);
    await h.close();
  }

  // ---- home page, signed-in customer: last tab is their dashboard, not "login" ----
  {
    const h = await launch({ role: 'customer' });
    await h.open('#/'); await h.page.waitForTimeout(300);
    check('signed-in home bottom nav links to the dashboard', await h.page.locator('#pubbtm a[href="#/app"]').count() === 1);
    await h.close();
  }

  // ---- desktop (>=1024px): bottom nav stays hidden, hamburger rule untouched (drawer is sticky anyway) ----
  {
    const h = await launch({ role: 'customer', signedIn: false, viewport: { width: 1280, height: 900 } });
    await h.open('#/'); await h.page.waitForTimeout(300);
    check('bottom nav hidden on desktop', await h.page.locator('#pubbtm').evaluate((el) => getComputedStyle(el).display) === 'none');
    await h.close();
  }

  // ---- customer dashboard: 4 tabs + "More" opens the existing drawer ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'store', status: 'draft', created_at: new Date().toISOString(), config: {} };
    const h = await launch({ role: 'customer', tables: { websites: [w] } });
    await h.open('#/app'); await h.page.waitForTimeout(400);
    const tabs = await h.page.evaluate(() => [...document.querySelectorAll('#v .btm-nav .bn-i')].map((a) => a.getAttribute('href') || a.dataset.act));
    check('customer bottom nav: dashboard, sites, new site, notes, more', JSON.stringify(tabs) === JSON.stringify(['#/app', '#/app/sites', '#/app/new', '#/app/notes', 'menu']));
    check('"More" tab exists and opens the side drawer', await h.page.locator('#v .btm-nav [data-act="menu"]').count() === 1);
    await h.page.click('#v .btm-nav [data-act="menu"]');
    await h.page.waitForTimeout(250);
    check('tapping "More" opens the drawer (same one the hamburger used to open)', await h.page.evaluate(() => document.body.classList.contains('dr-open')));
    check('drawer still has the other sections (apps/analytics/support/…)', await h.page.locator('#drawer a[href="#/app/apps"]').count() === 1);
    check('no page errors', h.errors.length === 0 || (console.log(h.errors), false));
    await h.close();
  }

  // ---- admin: 4 tabs + "More" opens the drawer with the rest of SIDE_A ----
  {
    const h = await launch({ role: 'super_admin' });
    await h.open('#/admin'); await h.page.waitForTimeout(400);
    const tabs = await h.page.evaluate(() => [...document.querySelectorAll('#v .btm-nav .bn-i')].map((a) => a.getAttribute('href') || a.dataset.act));
    check('admin bottom nav: dashboard, all sites, users, contracts, more', JSON.stringify(tabs) === JSON.stringify(['#/admin', '#/admin/sites', '#/admin/users', '#/admin/contracts', 'menu']));
    await h.page.click('#v .btm-nav [data-act="menu"]');
    await h.page.waitForTimeout(250);
    check('"More" opens the drawer with the rest of the admin sections', await h.page.locator('#drawer a[href="#/admin/engine"]').count() === 1);
    await h.close();
  }

  // ---- .tabs (per-site page tabs, inside vSite) is untouched / no class collision with .btm-nav ----
  {
    const w = { id: 's1', owner_id: UID, name: 'ملكي', site_type: 'store', status: 'draft', created_at: new Date().toISOString(), config: {} };
    const h = await launch({ role: 'customer', tables: { websites: [w] } });
    await h.open('#/app/site/s1/overview'); await h.page.waitForTimeout(400);
    check('.tabs (site page tabs) still present and distinct from .btm-nav', await h.page.locator('.tabs').count() === 1 && await h.page.locator('#v .btm-nav').count() === 1);
    await h.close();
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 2 : 0);
})();
