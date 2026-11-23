// Storefront entry: boot data → shell → routes → splash (driven by real loading tasks).
import { initBoot, setUser, state } from './state.js';
import { api } from './api.js';
import { route, startRouter } from './router.js';
import { mountShell } from './shell.js';
import { cart } from './cart.js';
import { $, prefersReducedMotion } from './util.js';

// The storefront is rendered by the Node.js server (it embeds the catalogue settings and talks to the database).
// If this page was opened as a plain file or from static hosting there is no server: say so clearly instead of showing a broken shop.
function noServer() {
  document.getElementById('splash')?.remove(); document.getElementById('no-app')?.remove();
  document.getElementById('root').innerHTML = '<div style="max-width:620px;margin:8vh auto;padding:24px;font-family:Cairo,sans-serif;line-height:1.9;direction:rtl"><h1 style="color:#800020">الخادم غير متصل</h1><p>هذا المتجر يحتاج إلى خادم ليعمل (Node.js، أو Cloudflare Workers مع قاعدة D1) لأن فيه قاعدة البيانات وواجهة الـ API. فتحه كملف مباشر أو رفعه على استضافة ملفات ثابتة لن يُظهر المنتجات ولا لوحة الإدارة.</p><ol><li>ثبّت Node.js 22 أو أحدث.</li><li>من داخل مجلد المتجر شغّل: <code dir=\"ltr\">npm start</code></li><li>افتح <code dir=\"ltr\">http://localhost:3000</code> (والإدارة على <code dir=\"ltr\">/admin</code>).</li></ol><p>للنشر على Cloudflare بلا سيرفر: <code dir=\"ltr\">npx wrangler@4 deploy</code>، أو على سيرفرك: <code dir=\"ltr\">docker compose up -d --build</code> (التفاصيل في README.md).</p></div>';
}
if (!document.getElementById('boot')) { noServer(); } else { main(); }

function main() {
document.getElementById('no-app')?.remove(); // the app loaded: hide the "server not connected" hint
initBoot();

route('/', () => import('./views/home.js'));
route('/shop', () => import('./views/shop.js'));
route('/product/:id/:slug?', () => import('./views/product.js'));
route('/bundles', () => import('./views/bundles.js'));
route('/bundle/:id/:slug?', () => import('./views/bundle.js'));
route('/branches', () => import('./views/branches.js'));
route('/about', () => import('./views/about.js'));
for (const k of ['privacy', 'terms', 'rights']) route('/' + k, () => import('./views/policy.js'));
route('/checkout', () => import('./views/checkout.js'));
route('/order/:number', () => import('./views/order.js'));
route('/track', () => import('./views/track.js'));
for (const p of ['/login', '/register', '/forgot', '/reset']) route(p, () => import('./views/auth.js'));
route('/account', () => import('./views/account.js'));

const main = mountShell($('#root'));

// Who is signed in? (does not block the page; the header updates when it answers)
const meTask = api('/api/auth/me').then((r) => { setUser(r.user); if (r.user) cart.restore(); }).catch(() => setUser(null));

// ── Splash: the bar reflects REAL progress of these tasks ──
const splash = $('#splash');
const fontTask = (document.fonts?.load ? Promise.all([document.fonts.load('700 16px Cairo', 'عالم البكلاوه'), document.fonts.load('400 16px Cairo', 'abc')]) : Promise.resolve()).catch(() => {});
const logoImg = $('#splash img');
const logoTask = logoImg && !logoImg.complete ? new Promise((r) => { logoImg.onload = logoImg.onerror = r; }) : Promise.resolve();
const routeTask = startRouter(main).catch((e) => console.error(e));

function runSplash(tasks) {
  const visible = splash && !document.documentElement.classList.contains('no-splash');
  if (!visible) { splash?.remove(); return; }
  const bar = $('#sp-bar'); let done = 0;
  const paint = () => { bar.style.width = `${Math.round((done / tasks.length) * 100)}%`; };
  const minWait = new Promise((r) => setTimeout(r, prefersReducedMotion() ? 250 : 1100));
  const tracked = tasks.map((t) => Promise.resolve(t).catch(() => {}).then(() => { done += 1; paint(); }));
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true;
    splash.classList.add('done'); splash.setAttribute('aria-hidden', 'true');
    try { sessionStorage.setItem('abk_splash', '1'); } catch { /* storage blocked */ }
    setTimeout(() => splash.remove(), 700);
  };
  Promise.all([Promise.all(tracked), minWait]).then(finish);
  setTimeout(finish, 9000); // never trap the visitor behind the splash
  splash.addEventListener('click', finish);
}
runSplash([fontTask, logoTask, meTask, routeTask]);
}
