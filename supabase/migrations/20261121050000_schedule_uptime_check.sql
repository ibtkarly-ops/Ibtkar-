-- ============================================================================
-- مراقبة المواقع تلقائياً 24/7 (كل 10 دقائق) بدل الاعتماد على ضغط "فحص
-- الآن" يدوياً. يستدعي دالة uptime-check الموجودة أصلاً بلا أي تغيير في
-- منطقها (فقط أصبحت تقبل الآن استدعاء النظام نفسه، راجع التعديل على
-- supabase/functions/uptime-check/index.ts الذي يجب نشره أولاً).
--
-- ما الذي يحدث فعلاً كل 10 دقائق: تُفحص كل المواقع المنشورة، ويُسجَّل
-- نجاح/فشل كل فحص، وإن تحوّل موقع من "يعمل" إلى "متوقف" يصل العميل إشعاراً
-- فورياً. هذا "حل تلقائي فوري" بمعنى الكشف والتبليغ الفوري — لا يوجد إصلاح
-- آلي حقيقي ممكن لأي سبب تعطّل عشوائي (DNS العميل، تعطّل مزوّد استضافته
-- الخاص...)، وهذا متوقَّع ولا يمكن تجاوزه بأي كود.
--
-- بديهي لكن مهم: استبدل <SERVICE_ROLE_KEY> أدناه بمفتاحك الحقيقي قبل
-- التنفيذ (Settings -> API -> service_role في لوحة Supabase). هذا المفتاح
-- يملك صلاحية كاملة على قاعدتك، لذلك جدول cron.job هذا يجب أن يبقى مرئياً
-- فقط لك كمالك المشروع (كما هو الحال افتراضياً في Supabase).
-- ============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ibtikar-uptime-check',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://ppegbmqkcdwopakewetl.supabase.co/functions/v1/uptime-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);

-- للتحقق لاحقاً أن المهمة تعمل:
--   select * from cron.job where jobname = 'ibtikar-uptime-check';
--   select * from cron.job_run_details order by start_time desc limit 10;
-- لإيقافها مستقبلاً: select cron.unschedule('ibtikar-uptime-check');
