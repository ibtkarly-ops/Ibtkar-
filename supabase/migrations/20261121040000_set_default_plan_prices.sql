-- ============================================================================
-- أسعار مبدئية للباقات، بناءً على طلب صريح ("احتاج تحط أسعار من رأيك
-- الشخصي"). كل الباقات كانت بسعر 0.00 — قيمة بديهية غير حقيقية لمنتج SaaS.
--
-- هذه أرقام مقترحة فقط حسب حدود كل باقة (عدد المواقع وحد طلبات الذكاء
-- الاصطناعي شهرياً)، وليست دراسة سوق — غيّرها بثقة من لوحة الإدارة
-- (Admin -> الباقات) في أي وقت، نفس الصفحة تدعم التعديل مباشرة.
-- ============================================================================
begin;

update public.plans set price = 0  where code = 'free';       -- تبقى مجانية كما هي
update public.plans set price = 9  where code = 'social';     -- موقع واحد، استخدام AI محدود
update public.plans set price = 15 where code = 'hosting';    -- عدة مواقع، استضافة أساسية
update public.plans set price = 19 where code = 'web';        -- 5 مواقع، استخدام AI متوسط
update public.plans set price = 29 where code = 'business';   -- موقع واحد لكن استخدام AI كبير
update public.plans set price = 79 where code = 'all_in_one'; -- 20 موقعاً، مناسب لوكالة صغيرة
update public.plans set price = 199 where code = 'enterprise'; -- 100 موقع، استخدام ضخم

commit;
