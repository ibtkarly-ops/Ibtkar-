// Outbound calls to payment gateways: https only, no private/internal targets (SSRF), timeouts, size cap, no redirects.
// Node additionally resolves the hostname (platform.dnsLookup) and rejects private addresses; on Cloudflare Workers
// requests to internal networks cannot be made at all, so literal-address and reserved-name checks are enough.
import { rt } from '../runtime.js';

const V4 = /^\d{1,3}(\.\d{1,3}){3}$/;
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function isPrivateIp(ip) {
  if (V4.test(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return m ? privateV4(m[1]) : false;
}

export async function assertPublicHttps(urlStr) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('رابط البوابة غير صالح'); }
  const local = rt.config.allowLocalGateways;
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('يجب أن يبدأ رابط البوابة بـ https://');
  if (u.username || u.password) throw new Error('لا تضع بيانات دخول داخل الرابط');
  if (local) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('عنوان البوابة غير مسموح');
  const literal = V4.test(host) || host.includes(':');
  if (literal && isPrivateIp(host)) throw new Error('عنوان البوابة يشير إلى شبكة داخلية وغير مسموح');
  if (!literal && rt.platform.dnsLookup) {
    const ips = await rt.platform.dnsLookup(host);
    if (!ips.length || ips.some(isPrivateIp)) throw new Error('عنوان البوابة يشير إلى شبكة داخلية وغير مسموح');
  }
  return u;
}

export async function gatewayFetch(urlStr, { method = 'GET', headers = {}, body, timeout = 20000, maxBytes = 512 * 1024 } = {}) {
  const u = await assertPublicHttps(urlStr);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(u, { method, headers, body, redirect: 'manual', signal: ctl.signal });
    if (res.status >= 300 && res.status < 400) throw new Error('أعادت البوابة تحويلًا غير متوقع');
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > maxBytes) { ctl.abort(); throw new Error('رد البوابة كبير جدًا'); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ok: res.ok, text, json };
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('انتهت مهلة الاتصال بالبوابة');
    throw e;
  } finally { clearTimeout(t); }
}
