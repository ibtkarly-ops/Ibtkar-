// History-API router with lazy-loaded views, scroll restoration and abortable rendering.
import { emit } from './state.js';
import { html, setHtml, raw } from './util.js';
import { isAbort } from './api.js';

const table = [];
let mainEl, active = { ctl: null };
const scrollPos = new Map();
let key = 0;

export function route(pattern, loader) {
  const names = [];
  const src = pattern.replace(/\/:([a-zA-Z]+)(\?)?/g, (_, n, opt) => { names.push(n); return opt ? '(?:/([^/]+))?' : '/([^/]+)'; });
  table.push({ re: new RegExp('^' + src + '/?$'), names, loader });
}

export function setTitle(t) { document.title = t; }

async function render(url, { restore } = {}) {
  const u = new URL(url, location.origin);
  active.ctl?.abort();
  const ctl = new AbortController(); active.ctl = ctl;
  let hit = null;
  for (const r of table) { const m = r.re.exec(u.pathname); if (m) { hit = { r, m }; break; } }
  const params = {};
  if (hit) hit.r.names.forEach((n, i) => { const v = hit.m[i + 1]; if (v !== undefined) { try { params[n] = decodeURIComponent(v); } catch { params[n] = v; } } });
  const loader = hit ? hit.r.loader : () => import('./views/notfound.js');
  emit('navigate', u.pathname);
  try {
    const mod = await loader();
    if (ctl.signal.aborted) return;
    mainEl.replaceChildren();
    mainEl.classList.remove('page'); void mainEl.offsetWidth; mainEl.classList.add('page');
    await mod.default({ el: mainEl, params, query: u.searchParams, signal: ctl.signal, setTitle, navigate, path: u.pathname });
  } catch (e) {
    if (isAbort(e) || ctl.signal.aborted) return;
    console.error(e);
    setHtml(mainEl, html`<div class="wrap"><div class="empty mt2"><b>تعذّر تحميل الصفحة</b>تحقق من اتصالك بالإنترنت ثم حاول مجددًا.<div class="mt"><button class="btn btn-primary" type="button" id="retry">إعادة المحاولة</button></div></div></div>`);
    mainEl.querySelector('#retry')?.addEventListener('click', () => render(url));
  }
  if (ctl.signal.aborted) return;
  window.scrollTo(0, restore ? scrollPos.get(history.state?.k) || 0 : 0);
  if (!restore) mainEl.focus({ preventScroll: true });
}

export function navigate(to, { replace = false } = {}) {
  scrollPos.set(history.state?.k, scrollY);
  if (replace) history.replaceState({ k: history.state?.k ?? ++key }, '', to);
  else history.pushState({ k: ++key }, '', to);
  return render(to);
}

export function startRouter(el) {
  mainEl = el;
  history.scrollRestoration = 'manual';
  history.replaceState({ k: ++key }, '', location.pathname + location.search + location.hash);
  window.addEventListener('popstate', () => render(location.pathname + location.search, { restore: true }));
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.hasAttribute('data-native')) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin) return;
    if (/^\/(admin|api|uploads|pay|sandbox)(\/|$)/.test(u.pathname)) return;
    e.preventDefault();
    if (u.pathname + u.search === location.pathname + location.search) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    navigate(u.pathname + u.search + u.hash);
  });
  return render(location.pathname + location.search);
}
