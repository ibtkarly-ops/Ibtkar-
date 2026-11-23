// Configuration comes from environment variables (Node: process.env, Workers: env bindings/vars/secrets).
// makeConfig is pure so both runtimes can use it.
export function makeConfig(env = {}, extra = {}) {
  const isProd = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);
  return {
    isProd,
    port,
    host: env.HOST || '0.0.0.0',
    siteUrl: String(env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    siteUrlConfigured: !!env.SITE_URL,
    trustProxy: env.TRUST_PROXY === '1',
    sessionDays: Number(env.SESSION_DAYS || 14),
    orderRateMax: Number(env.ORDER_RATE_MAX || 12), // orders per IP per 10 minutes
    // PBKDF2-SHA256 cost for password hashing. 100k fits Cloudflare Workers; raise it where CPU time is plentiful.
    passwordIterations: Math.max(10_000, Number(env.PASSWORD_ITERATIONS || 100_000)),
    admin: { name: env.ADMIN_NAME || 'مدير المتجر', email: env.ADMIN_EMAIL || '', password: env.ADMIN_PASSWORD || '' },
    setupCode: env.SETUP_CODE || '',
    // The sandbox gateway type is a test double. It can never exist in production.
    sandbox: (env.PAYMENT_SANDBOX === '1' || env.PAYMENT_SANDBOX === 1) && !isProd,
    sandboxRequestedInProd: env.PAYMENT_SANDBOX === '1' && isProd,
    allowLocalGateways: !isProd && env.PAYMENT_ALLOW_LOCAL === '1', // tests only
    ...extra,
  };
}
