# نشر تعديلات Supabase — خطوات يدوية

تعذّر على جلسة Claude هذه تنفيذ أي تعديل مباشر (DDL أو نشر دالة) على مشروع
`IBTKAR` (`ppegbmqkcdwopakewetl`) لأن أداة Supabase تطلب تأكيدًا تفاعليًا قبل كل
عملية تُغيّر قاعدة بيانات حيّة، ونافذة التأكيد هذه لم تكن قابلة للوصول من بيئة
الجلسة. لذلك كل التعديلات محفوظة هنا كملفات جاهزة لتُنفَّذها أنت مباشرة.

> **لا شيء مما يلي تم تطبيقه على القاعدة الحيّة فعليًا.** هذه الخطوات مطلوبة
> لتفعيل كل الإصلاحات المذكورة.

---

## 1) Migration: تنظيف RLS policies + فهارس مكررة

**الملف:** `supabase/migrations/20261121000000_consolidate_rls_policies_and_drop_dup_indexes.sql`

**ماذا يفعل:** لا يغيّر الصلاحيات الفعلية لأي مستخدم. يدمج 47 تحذير "multiple
permissive policies" (كل جدول كان لديه policy مزدوجة لنفس عملية SELECT) إلى
policy واحدة لكل عملية، ويحذف فهرسين مكررين تمامًا (`idx_subs_user`,
`idx_websites_owner`).

**التنفيذ:**
1. افتح **Supabase Dashboard → SQL Editor** للمشروع `IBTKAR`.
2. افتح الملف أعلاه، انسخ محتواه كاملاً، ولصقه في محرر SQL.
3. اضغط **Run**.
4. تحقق من النتيجة:
   ```sql
   select * from pg_policies where schemaname='public' order by tablename;
   ```
5. أعد تشغيل **Performance Advisor** من لوحة Supabase للتأكد من اختفاء تحذيرات
   "multiple permissive policies" و"duplicate index".

أو عبر CLI إذا كان المشروع مربوطًا:
```bash
supabase link --project-ref ppegbmqkcdwopakewetl
supabase db push
```

---

## 2) إصلاح باقي خطأ `ai-gateway` (كود الباقة المجانية)

**الملف:** `supabase/functions/ai-gateway/index.ts`

**الخطأ المُصلَح:** الدالة كانت تبحث عن `plans.code = 'FREE'` (حروف كبيرة)
بينما القيمة الفعلية في الجدول هي `'free'` (حروف صغيرة) — فكانت كل الحسابات
بلا اشتراك فعّال تعتمد دائمًا على القيمة الافتراضية المكتوبة في الكود (`50`)
بدل حد الباقة المجانية الحقيقي القابل للتعديل من لوحة الإدارة. حاليًا كلاهما
50 فالخلل غير ظاهر، لكنه سينكشف فور تغييرك لحد الباقة المجانية من اللوحة.

**التنفيذ:**
```bash
supabase functions deploy ai-gateway --project-ref ppegbmqkcdwopakewetl
```
أو من Dashboard → Edge Functions → ai-gateway → استبدل محتوى `index.ts` بمحتوى
الملف ثم Deploy. تأكد أن **Verify JWT** تبقى **مفعّلة** (كما كانت).

---

## 3) تحصين `uptime-check` و `verify-publish` ضد DNS rebinding

**الملفان:** `supabase/functions/uptime-check/index.ts`،
`supabase/functions/verify-publish/index.ts`

**المشكلة:** الدالتان كانتا تمنعان فقط العناوين التي تبدو حرفيًا IP داخلي
(`127.0.0.1`, `192.168.x.x`...) في نص الرابط. لكن منصتكم تسمح للعميل بإضافة
نطاق مخصص (`domains` table) — عميل يتحكم في DNS نطاقه الخاص يمكنه نظريًا جعل
اسم نطاق يبدو عاديًا يُشير إلى عنوان داخلي **وقت تنفيذ الطلب فعليًا** (هجوم
DNS rebinding)، متجاوزًا الفحص النصي البحت.

**الإصلاح:** تمت إضافة فحص فعلي لنتيجة DNS (`Deno.resolveDns`) يرفض أي نطاق
يُحلَّل إلى عنوان خاص/داخلي، مع "fail-open" فقط على طبقة الـ DNS نفسها إن لم
تكن متاحة في بيئة التشغيل (لإبقاء المراقبة والنشر يعملان حتى لو قيّدت Supabase
هذه الصلاحية مستقبلاً). هذا تحصين إضافي وليس ضمانًا مطلقًا — راجع التعليق
داخل الملفين للتفاصيل الكاملة.

**التنفيذ:**
```bash
supabase functions deploy uptime-check --project-ref ppegbmqkcdwopakewetl
supabase functions deploy verify-publish --project-ref ppegbmqkcdwopakewetl
```
تأكد أن **Verify JWT** تبقى **مفعّلة** لكلتا الدالتين.

---

## 4) تقييد معدل الطلبات على `contract-file`

**الملف:** `supabase/functions/contract-file/index.ts`

**الإضافة:** حدّ بسيط (٢٠ محاولة كل ٥ دقائق لكل `token`+IP) على مستوى العملية
الواحدة (in-memory) لمنع إرسال محاولات متكررة ضد رابط عقد واحد. هذا endpoint
عام بدون JWT عمدًا (العميل يفتحه من رابط بريد/واتساب)، والحماية الحقيقية هي
عشوائية الـ `share_token` (UUID)، لكن هذا يضيف طبقة احتكاك إضافية بلا تكلفة.

**التنفيذ:**
```bash
supabase functions deploy contract-file --project-ref ppegbmqkcdwopakewetl --no-verify-jwt
```
**مهم:** يجب أن تبقى `--no-verify-jwt` (أو `verify_jwt: false` من اللوحة) كما
كانت، لأن هذا الرابط يُفتح من عملاء غير مسجّلين عبر الـ token وحده.

---

## 5) خطوة لا يمكن أتمتتها: تفعيل Leaked Password Protection

من أدوات الفحص الأمني لـ Supabase (Security Advisor):

> Leaked Password Protection Disabled — Auth لا يرفض حاليًا كلمات مرور ظهرت في
> تسريبات بيانات معروفة (HaveIBeenPwned).

هذا إعداد في Auth config لا توجد أداة قاعدة بيانات له؛ يُفعَّل من:

**Dashboard → Authentication → Policies (أو Attack Protection) → Password
Security → فعّل "Leaked password protection".**

خطوة واحدة بالنقر، لا تحتاج أي كود.

---

## 6) دعم PHP/Node.js الحقيقي (متجر/عيادة/شركة/معرض أعمال)

هذه الميزة الجديدة تحتاج **خادم VPS منفصل** بجانب Supabase — راجع
`infra/README.md` للشرح الكامل وأمر الإعداد الواحد على الخادم. الخطوات هنا
فقط لجانب Supabase:

1. **Migrations جديدتان** (نفّذهما بنفس طريقة القسم 1 أعلاه، بالترتيب):
   - `supabase/migrations/20261121010000_add_stack_and_vps_deploys.sql`
   - `supabase/migrations/20261121020000_seed_app_stack_prompts.sql`
2. **دالة جديدة** `deploy-vps`:
   ```bash
   supabase functions deploy deploy-vps --project-ref ppegbmqkcdwopakewetl
   ```
   (Verify JWT يجب أن يبقى **مفعّلاً** — هذه الدالة تتحقق من هوية المستخدم.)
3. **أسرار جديدان** (القيم تأتي من مخرجات `infra/vps-setup.sh` على الخادم):
   ```bash
   supabase secrets set DEPLOY_AGENT_URL=https://<IP-أو-نطاق-الخادم> --project-ref ppegbmqkcdwopakewetl
   supabase secrets set DEPLOY_AGENT_SECRET=<القيمة-من-السكربت> --project-ref ppegbmqkcdwopakewetl
   ```
4. **أعد نشر `ai-gateway`** (تحتوي الآن على منطق توليد PHP/Node ويحتاج طلب
   توكن المفتاح العام أيضاً):
   ```bash
   supabase secrets set SUPABASE_ANON_KEY=<publishable key من لوحة Settings -> API> --project-ref ppegbmqkcdwopakewetl
   supabase functions deploy ai-gateway --project-ref ppegbmqkcdwopakewetl
   ```
   (SUPABASE_URL وSUPABASE_SERVICE_ROLE_KEY موجودان تلقائياً في كل الدوال؛
   SUPABASE_ANON_KEY وحده يحتاج ضبطاً يدوياً لأن ai-gateway يستخدمه لينشر
   الموقع تلقائياً بهوية العميل نفسه بعد كل بناء أو تعديل ناجح.)
5. أضف سجل DNS: `*.apps.ibtkar.ly` (أو النطاق الذي اخترته) يشير لعنوان IP
   خادم الـVPS.

بعد هذا، أي موقع من نوع متجر/عيادة/شركة/معرض أعمال يُبنى وينشر تلقائياً على
الخادم، بلا أي خطوة يدوية إضافية لكل موقع جديد.

---

## ترتيب مقترح للتنفيذ

1. المigration (القسم 1) أولاً — أثر فوري على الأداء، صفر خطر على السلوك.
2. تفعيل حماية كلمات المرور المسرّبة (القسم 5) — نقرة واحدة.
3. نشر الدوال الأربع (الأقسام 2–4) بأي ترتيب.
4. أعد تشغيل Security + Performance Advisors من لوحة Supabase للتأكد أن كل
   التحذيرات السابقة اختفت.
