# النشر عبر Cloudflare (سيرفر Node + Cloudflare Tunnel)

**لماذا ليس Workers/Pages مباشرة؟** المتجر تطبيق Node.js بقاعدة SQLite ورفع صور على القرص. Workers/Pages لا تشغّل `node:sqlite` ولا تملك قرصًا دائمًا، وقرص Cloudflare Containers مؤقت. الحل المعتمد: يعمل المتجر على سيرفر (أي VPS أو جهاز يشغّل Docker)، وCloudflare أمامه يوفّر النطاق وSSL وCDN والحماية — **بدون فتح أي منفذ** على السيرفر (Tunnel).

## الخطوات

1. **على السيرفر** (يلزم Docker): انسخ مجلد المتجر، ثم `cp .env.example .env` وعدّل:
   - `SITE_URL=https://shop.yourdomain.com` (يجب https)
   - `APP_SECRET=` سلسلة عشوائية 32+ حرفًا (تشفّر مفاتيح بوابات الدفع)
   - `TUNNEL_TOKEN=` من الخطوة 2.
2. **في Cloudflare** → Zero Trust → Networks → Tunnels → *Create a tunnel* → Cloudflared → انسخ **التوكن**. في *Public hostname*: النطاق الفرعي (مثل `shop`) ← Service: `HTTP` ← `store:3000`. (يُنشئ سجل DNS تلقائيًا.)
3. **شغّل:**
   ```bash
   docker compose -f deploy/cloudflare/docker-compose.yml --env-file .env up -d --build
   docker compose -f deploy/cloudflare/docker-compose.yml logs store   # فيه سطر «إعداد أولي» ورمز الإعداد
   ```
4. افتح `https://shop.yourdomain.com/admin` → أنشئ حساب المدير (أدخل رمز الإعداد من السجل، لأن الطلب يأتي عبر Cloudflare).

## إعدادات Cloudflare الموصى بها
- SSL/TLS: **Full** · Always Use HTTPS: تشغيل.
- Rules → Cache Rules: *Bypass cache* لمسارات `/api/*` و`/admin*` و`/pay/*` (الملفات الثابتة والصور تُخزَّن تلقائيًا).
- WAF → Rate limiting: على `POST /api/auth/login` (مثلًا 10 طلبات/دقيقة/IP).
- (اختياري) Zero Trust Access أمام `/admin*` لطبقة حماية إضافية.
- ضع رابط الـ Webhook لبوابة الدفع: `https://shop.yourdomain.com/api/payments/webhook/<id>` (يظهر في الإدارة ← بوابات الدفع).

## النسخ الاحتياطي (مهم: الطلبات في ملف واحد)
```bash
docker compose -f deploy/cloudflare/docker-compose.yml exec store node scripts/backup.js /data/backups   # نسخة متسقة أثناء التشغيل
```
جدولها يوميًا بـ cron، وانسخ `/data` (النسخ + `uploads/` + `.secret`) خارج السيرفر (مثلًا إلى R2 بـ rclone).

## التحديث
```bash
git pull && docker compose -f deploy/cloudflare/docker-compose.yml --env-file .env up -d --build
```
