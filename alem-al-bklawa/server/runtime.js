// The server core is runtime-agnostic: it runs on Node.js (node:sqlite + files) and on Cloudflare Workers (D1 + assets).
// Each runtime builds a `platform` and calls setRuntime() once; core modules read everything through `rt`.
//
//   platform = {
//     name: 'node' | 'workers',
//     assets:  { fetch(request) → Response | null, text(path) → string },        // static files
//     uploads: { put(bytes, ext) → name, get(name) → { bytes, mime } | null },    // admin-uploaded images
//     rateLimit(key, max, windowMs, { soft }) → boolean,                          // true = allowed
//     getSecretKey() → Uint8Array(32),                                            // encrypts gateway secrets
//     defaultLogo: '/assets/logo.webp' | '',
//     setup: { needsCode(request) → boolean, expectedCode() → string|null, done() },
//     dnsLookup?(host) → string[],                                                // Node only (SSRF check)
//     migrations: [{ name, sql }],
//   }
export const rt = { db: null, platform: null, config: null, ready: null };

export function setRuntime({ db, platform, config }) {
  rt.db = db; rt.platform = platform; rt.config = config;
}

/** Late-bound database facade: modules can import it at load time, before a runtime exists. */
export const db = {
  all: (...a) => rt.db.all(...a),
  get: (...a) => rt.db.get(...a),
  run: (...a) => rt.db.run(...a),
  batch: (...a) => rt.db.batch(...a),
};
