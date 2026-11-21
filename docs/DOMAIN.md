# ربط نطاق لتصبح روابط المواقع بالشكل `اسم-الموقع.نطاقك.com`

الوضع الحالي: الروابط بالشكل `https://ibtkar-app.pages.dev/اسم-الموقع` (لا تحتاج نطاقاً).
عندما تشتري نطاقاً، اتبع الخطوات التالية مرة واحدة فقط (أمثلة بنطاق `mysite.com`).

## 1) النطاق في Cloudflare
1. اشترِ النطاق (من Cloudflare Registrar مباشرة أو أي مسجّل).
2. إن اشتريته من مسجّل آخر: Cloudflare ← Add a site ← أدخل النطاق ← اختر الخطة المجانية ← انسخ الـ Nameservers الذي يعطيك إياه وضعه عند المسجّل. انتظر حتى تصبح الحالة Active.

## 2) منصتك على النطاق الرئيسي (اختياري)
Workers & Pages ← مشروع `ibtkar-app` ← Custom domains ← Set up a domain ← `app.mysite.com` (أو النطاق الرئيسي).

## 3) الـ Worker الذي يخدم الروابط الفرعية
1. Workers & Pages ← Create ← Create Worker ← سمّه `sites-proxy` ← Deploy ← Edit code.
2. الصق محتوى الملف `worker/sites-proxy.js` (غيّر `ibtkar-app.pages.dev` إلى رابط مشروعك إن اختلف) ← Deploy.
3. من إعدادات الـ Worker ← Settings ← Domains & Routes ← Add ← Route:
   - Route: `*.mysite.com/*`
   - Zone: `mysite.com`

## 4) سجل DNS لكل النطاقات الفرعية
DNS ← Add record:
- Type: `A` ، Name: `*` ، IPv4: `192.0.2.1` ، Proxy status: **Proxied** (السحابة البرتقالية).

## 5) أخبر المنصة بالنطاق (يغيّره المطور أو أنت من SQL)
```sql
update public.platform_settings set value = 'mysite.com' where key = 'public.sites_root_domain';
```
بعدها يصبح رابط أي موقع جديد `https://اسم-الموقع.mysite.com`، ويعيد زر «نشر» نشر المواقع القديمة بالرابط الجديد.

## تأكد أنه يعمل
افتح `https://أي-اسم.mysite.com` ⇒ يجب أن يظهر «404» (لأنه لا يوجد موقع بهذا الاسم). ثم انشر موقعاً حقيقياً وافتح رابطه.

## لماذا لا يمكن `اسم.ibtkar-app.pages.dev`؟
Cloudflare لا تسمح بنطاقات فرعية عشوائية تحت `pages.dev`؛ تحتاج نطاقاً تملكه.
