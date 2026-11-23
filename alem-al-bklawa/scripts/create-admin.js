// Create (or reset the password of) an admin account:
//   ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD='long-unique-password' npm run create-admin
import { createNodeRuntime } from '../server/node-runtime.js';
import { migrate } from '../server/dbutil.js';
import { hashPassword, checkPasswordPolicy } from '../server/auth.js';

const { config, db, platform } = createNodeRuntime();
const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
if (!email || !password) { console.error('عيّن ADMIN_EMAIL و ADMIN_PASSWORD (ويفضّل ADMIN_NAME).'); process.exit(1); }
try { checkPasswordPolicy(password); } catch (e) { console.error(e.message); process.exit(1); }
await migrate(db, platform.migrations);
const hash = await hashPassword(password);
const ex = await db.get('SELECT id FROM profiles WHERE email = ?', email);
if (ex) { await db.run("UPDATE profiles SET password_hash = ?, role = 'admin', deleted_at = NULL WHERE id = ?", hash, ex.id); console.log('تم تحديث المدير:', email); }
else { await db.run("INSERT INTO profiles (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", config.admin.name, email, hash); console.log('تم إنشاء مدير جديد:', email); }
