// Encrypts gateway secrets at rest (AES-256-GCM). Key: APP_SECRET env (≥32 chars) or an auto-generated
// key file in DATA_DIR (mode 0600). Secrets are never sent to the browser and never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let key = null;
function loadKey() {
  if (key) return key;
  const env = process.env.APP_SECRET;
  if (env && env.length >= 32) { key = crypto.createHash('sha256').update(env).digest(); return key; }
  const file = path.join(config.dataDir, '.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return key;
}

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj || {}), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function unseal(s) {
  if (!s) return {};
  try {
    const [v, iv, tag, ct] = String(s).split(':');
    if (v !== 'v1') return {};
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
  } catch { return {}; } // wrong key / tampered → treated as "not configured"
}

export const mask = (v) => (v ? `••••${String(v).slice(-3)}` : '');
