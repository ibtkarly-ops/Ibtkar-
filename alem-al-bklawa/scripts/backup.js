// Consistent online backup of the SQLite database (safe while the store is running):
//   node scripts/backup.js [target-dir]      → <target>/store-YYYYMMDD-HHMMSS.db   (keeps the 14 newest)
// Uploaded images live in DATA_DIR/uploads and the encryption key in DATA_DIR/.secret — copy those too (the Docker volume).
// (On Cloudflare the database is D1: use `npx wrangler d1 export` — see docs/DEPLOY-CLOUDFLARE.md.)
import fs from 'node:fs';
import path from 'node:path';
import { createNodeRuntime } from '../server/node-runtime.js';

const { config, db } = createNodeRuntime();
const target = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(target, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const file = path.join(target, `store-${stamp}.db`);
db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
const keep = fs.readdirSync(target).filter((f) => /^store-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
for (const old of keep.slice(14)) fs.rmSync(path.join(target, old), { force: true });
console.log(`backup ok: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
