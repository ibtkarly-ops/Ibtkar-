// UI primitives: toast (de-duplicated), modal with focus trap, confirm dialog, scroll lock.
import { html, setHtml, $, $$, icon, esc, raw } from './util.js';

// ── Toast ──
const recent = new Map();
export function toast(message, type = '', { action, onAction, ms = 3200 } = {}) {
  const key = type + message;
  const now = Date.now();
  if (now - (recent.get(key) || 0) < 1800) return; // never repeat the same toast
  recent.set(key, now);
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.append(document.createTextNode(message));
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action; b.onclick = () => { onAction?.(); close(); }; el.append(b); }
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  setTimeout(close, ms);
}

// ── Scroll lock (counted so nested overlays work) ──
let locks = 0;
export function lockScroll(on) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  document.body.style.overflow = locks ? 'hidden' : '';
}

// ── Focus trap ──
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function trapFocus(container, onEscape) {
  const prev = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onEscape?.(); return; }
    if (e.key !== 'Tab') return;
    const f = $$(FOCUSABLE, container).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => { container.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus({ preventScroll: true }); };
}

// ── Modal ──
const modalStack = [];
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1](); });
/** Opens a modal; returns {el, close}. `content` is an html`` result. */
export function openModal(title, content, { onClose, wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true"></div>';
  const m = wrap.firstChild;
  if (wide) m.style.maxWidth = '720px';
  setHtml(m, html`<button class="icon-btn modal-x" type="button" aria-label="إغلاق" data-close>${icon('x')}</button><h2 id="mt">${title}</h2><div class="mbody">${content}</div>`);
  m.setAttribute('aria-labelledby', 'mt');
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.style.zIndex = 105;
  document.body.append(ov, wrap);
  lockScroll(true);
  let done = false;
  const release = trapFocus(m, () => close());
  function close() {
    if (done) return; done = true;
    const i = modalStack.indexOf(close); if (i >= 0) modalStack.splice(i, 1);
    release(); wrap.remove(); ov.remove(); lockScroll(false); onClose?.();
  }
  modalStack.push(close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  ov.addEventListener('click', close);
  $$('[data-close]', m).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => ($(FOCUSABLE.replace('a[href],', ''), m.querySelector('.mbody')) || m).focus?.(), 30);
  return { el: m, body: m.querySelector('.mbody'), close };
}

export function confirmDialog(title, message, { ok = 'تأكيد', cancel = 'إلغاء', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const { el, close } = openModal(title, html`<p>${message}</p><div class="row mt"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok type="button">${ok}</button><button class="btn btn-ghost" data-close type="button">${cancel}</button></div>`, { onClose: () => resolve(result) });
    $('[data-ok]', el).addEventListener('click', () => { result = true; close(); });
  });
}

/** Show field errors returned by the API under their inputs. */
export function showFieldError(form, field, message) {
  const input = form.querySelector(`[name="${field}"]`);
  if (!input) return false;
  input.setAttribute('aria-invalid', 'true');
  let e = input.parentElement.querySelector('.err');
  if (!e) { e = document.createElement('div'); e.className = 'err'; e.setAttribute('role', 'alert'); input.after(e); }
  e.textContent = message;
  input.focus();
  return true;
}
export function clearFieldErrors(form) {
  $$('[aria-invalid]', form).forEach((i) => i.removeAttribute('aria-invalid'));
  $$('.err', form).forEach((e) => e.remove());
}

export const spinnerBtn = (btn, busy, label) => { btn.disabled = busy; if (label !== undefined) btn.textContent = label; };

/** Fade-up on scroll for elements marked .reveal (no-op when unsupported). */
export function reveal(root = document) {
  const els = $$('.reveal:not(.in)', root);
  if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
}
export { esc, raw };
