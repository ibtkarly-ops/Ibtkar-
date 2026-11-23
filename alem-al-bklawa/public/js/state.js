// Global app state + tiny event bus.
import { setCurrency } from './util.js';

const listeners = new Map();
export const on = (evt, fn) => { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); return () => listeners.get(evt)?.delete(fn); };
export const emit = (evt, data) => listeners.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

export const state = {
  boot: null,       // settings, categories, branches, banners, payments, delivery, mainBranchId
  user: null,       // signed-in profile or null
  userReady: false,
};

export function initBoot() {
  const el = document.getElementById('boot');
  state.boot = el ? JSON.parse(el.textContent) : { settings: {}, categories: [], branches: [], banners: [], payments: { cash: true, online: [] }, delivery: {} };
  setCurrency(state.boot.settings.currency_label);
  return state.boot;
}
export const settings = () => state.boot.settings;
export const branches = () => state.boot.branches;
export const mainBranch = () => state.boot.branches.find((b) => b.id === state.boot.mainBranchId) || state.boot.branches[0];
export function setUser(u) { state.user = u; state.userReady = true; emit('user', u); }

/** Resolves once /api/auth/me has answered (or after `ms`), so views don't render a signed-in user as a guest. */
export async function waitUser(ms = 3000) {
  const t0 = Date.now();
  while (!state.userReady && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}
