// Outbound calls to payment gateways: https only, no private/loopback targets (SSRF), timeouts, size cap, no redirects.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

const allowLocal = () => !config.isProd && process.env.PAYMENT_ALLOW_LOCAL === '1'; // tests only

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return m ? privateV4(m[1]) : false;
}

export async function assertPublicHttps(urlStr) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('رابط البوابة غير صالح'); }
  if (u.protocol !== 'https:' && !(allowLocal() && u.protocol === 'http:')) throw new Error('يجب أن يبدأ رابط البوابة بـ https://');
  if (u.username || u.password) throw new Error('لا تضع بيانات دخول داخل الرابط');
  if (allowLocal()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('عنوان البوابة يشير إلى شبكة داخلية وغير مسموح');
  return u;
}

export async function gatewayFetch(urlStr, { method = 'GET', headers = {}, body, timeout = 20000, maxBytes = 512 * 1024 } = {}) {
  const u = await assertPublicHttps(urlStr);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(u, { method, headers, body, redirect: 'error', signal: ctl.signal });
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
