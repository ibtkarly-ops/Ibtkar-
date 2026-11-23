// Central configuration — everything comes from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const isProd = env.NODE_ENV === 'production';
const port = Number(env.PORT || 3000);

export const config = {
  root,
  isProd,
  port,
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(root, env.DATA_DIR || './data'),
  publicDir: path.join(root, 'public'),
  siteUrl: (env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  sessionDays: Number(env.SESSION_DAYS || 14),
  orderRateMax: Number(env.ORDER_RATE_MAX || 12), // orders per IP per 10 minutes
  admin: {
    name: env.ADMIN_NAME || 'مدير المتجر',
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
  },
  payment: {
    // The sandbox gateway type is a test double. It can never exist in production.
    sandbox: env.PAYMENT_SANDBOX === '1' && !isProd,
    sandboxRequestedInProd: env.PAYMENT_SANDBOX === '1' && isProd,
  },
};
