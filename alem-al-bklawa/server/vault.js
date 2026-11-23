// Encrypts gateway secrets at rest (AES-256-GCM via WebCrypto — same code on Node and Workers).
// The 32-byte key comes from the platform: APP_SECRET, or an auto-generated key kept next to the data.
// Secrets are never sent to the browser and never logged.
import crypto from 'node:crypto';
import { rt } from './runtime.js';

let keyPromise = null;
const getKey = () => (keyPromise ||= (async () => {
  const raw = await rt.platform.getSecretKey();
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
})());
const b64 = (u8) => Buffer.from(u8).toString('base64');

export async function seal(obj) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(JSON.stringify(obj || {}))));
  return `v2:${b64(iv)}:${b64(ct)}`; // ct includes the GCM authentication tag
}

export async function unseal(s) {
  if (!s) return {};
  try {
    const parts = String(s).split(':');
    if (parts[0] === 'v1') { // first release (Node crypto, separate auth tag) — same key, still readable
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(await rt.platform.getSecretKey()), Buffer.from(parts[1], 'base64'));
      d.setAuthTag(Buffer.from(parts[2], 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8'));
    }
    const [v, iv, ct] = parts;
    if (v !== 'v2') return {};
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, await getKey(), Buffer.from(ct, 'base64'));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return {}; } // wrong key / tampered → treated as "not configured"
}

export const mask = (v) => (v ? `••••${String(v).slice(-3)}` : '');
