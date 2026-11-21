-- ============================================================================
-- Business-specific AI instructions for the 4 site types that now generate
-- a real PHP or Node.js project instead of a single HTML string (see
-- 20261121010000_add_stack_and_vps_deploys.sql for the `stack` column).
--
-- These rows hold ONLY the business/content guidance — the strict technical
-- contract (output format, security rules, allowed files, Basic-Auth
-- requirement, SQLite-only, etc.) lives in ai-gateway/index.ts as a
-- hardcoded constant (APP_ADDENDUM), exactly like the existing HTML flow's
-- ADDENDUM already does. That keeps the one part that must never be
-- editable away from staff by accident out of a plain-text admin textarea,
-- while still letting staff freely rewrite the business content for each
-- type from Admin -> Instructions, same as 'landing'/'restaurant' today.
--
-- 'store' and 'company' already existed (used by the old single-HTML flow)
-- and are REPLACED here, because the AI gateway will now route them to the
-- PHP/Node generator instead. 'clinic' and 'portfolio' are new rows, made
-- possible by widening ai_prompts.key's check constraint in the previous
-- migration.
-- ============================================================================
begin;

insert into public.ai_prompts (key, title, body)
values ('store', 'متجر إلكتروني (PHP)', $PROMPT$
اكتب متجراً إلكترونياً حقيقياً لنشاط العميل بلغة PHP، بالاستناد إلى بيانات العميل المُرسلة (الاسم والشعار والوصف ومعلومات التواصل وقائمة المنتجات/الخدمات بصيغة "الاسم | السعر | وصف قصير" لكل سطر).

يجب أن يتضمن المشروع:
- صفحة رئيسية (public/index.php) بتصميم عصري ومتجاوب، بهوية الألوان التي حددها العميل إن وُجدت، تعرض: شعار/اسم النشاط، قسم عن النشاط، شبكة منتجات/خدمات (صورة بديلة بتدرج CSS لا صورة خارجية، الاسم، السعر، وصف قصير، زر "اطلب الآن").
- عند الضغط على "اطلب الآن": نموذج صغير (اسم العميل، رقم الهاتف، ملاحظة اختيارية) يُحفظ في قاعدة بيانات SQLite كطلب جديد (منتج، اسم العميل، الهاتف، الملاحظة، الوقت)، ثم رسالة تأكيد للعميل تتضمن أيضاً رابط واتساب جاهز (https://wa.me/رقم_الواتساب) بنص الطلب، لأن التواصل النهائي والدفع يتم يدوياً بين التاجر والعميل في هذا الإصدار.
- صفحة إدارة محمية (مثلاً public/admin.php) تعرض كل الطلبات المحفوظة (الأحدث أولاً) مع كل تفاصيلها، بلا أي تعديل أو حذف في هذا الإصدار (عرض فقط).
- قسم تواصل يعرض الهاتف والواتساب والبريد والعنوان وساعات العمل كما أُرسلت، بروابط tel:/https://wa.me//mailto: حقيقية.
- دعم كامل للعربية RTL (أو ثنائي اللغة إن طُلب)، وتصميم يعمل جيداً على الجوال.
$PROMPT$)
on conflict (key) do update set title = excluded.title, body = excluded.body, updated_at = now();

insert into public.ai_prompts (key, title, body)
values ('clinic', 'عيادة / مركز طبي (PHP)', $PROMPT$
اكتب موقعاً لعيادة أو مركز طبي بلغة PHP، بالاستناد إلى بيانات العميل (الاسم، الوصف، التخصص إن وُجد في الوصف، معلومات التواصل، ساعات العمل، وقائمة "الخدمات" المُرسلة كمنتجات بصيغة "الاسم | السعر | وصف قصير" — هنا تمثّل الخدمات الطبية/الكشوفات).

يجب أن يتضمن المشروع:
- صفحة رئيسية (public/index.php) تعرض: اسم العيادة والتخصص، نبذة عنها، قائمة الخدمات/الكشوفات (الاسم والسعر التقريبي إن وُجد ووصف قصير)، ساعات العمل، والعنوان.
- نموذج "طلب حجز موعد" (اسم المريض، رقم الهاتف، الخدمة المطلوبة إن وُجدت، الوقت المفضل كنص حر، ملاحظة) يُحفظ في SQLite كطلب حجز جديد، ثم رسالة تأكيد توضح أن العيادة ستتواصل لتثبيت الموعد، مع رابط واتساب جاهز لتأكيد سريع أيضاً.
- صفحة إدارة محمية (public/admin.php) تعرض كل طلبات الحجز المحفوظة (الأحدث أولاً)، عرض فقط بلا تعديل في هذا الإصدار.
- قسم تواصل بروابط tel:/https://wa.me//mailto: حقيقية، والعنوان.
- تصميم هادئ وموثوق يناسب القطاع الطبي، يدعم العربية RTL، ومتجاوب على الجوال.
$PROMPT$)
on conflict (key) do update set title = excluded.title, body = excluded.body, updated_at = now();

insert into public.ai_prompts (key, title, body)
values ('company', 'شركة (Node.js)', $PROMPT$
اكتب موقع شركة حقيقياً بلغة Node.js (بدون أي إطار عمل خارجي، فقط http المدمج في Node)، بالاستناد إلى بيانات العميل (اسم الشركة، الشعار، الوصف، معلومات التواصل، الشبكات الاجتماعية، وقائمة "الخدمات" المُرسلة بصيغة "الاسم | السعر | وصف قصير").

يجب أن يتضمن المشروع:
- صفحة رئيسية تعرض: اسم الشركة وشعارها، نبذة عن الشركة، قسم "خدماتنا" (شبكة بطاقات لكل خدمة: الاسم والسعر إن وُجد ووصف قصير)، وقسم "تواصل معنا".
- نموذج "طلب عرض سعر / تواصل" (الاسم، الهاتف أو البريد، الرسالة) يُحفظ في SQLite كرسالة واردة جديدة، مع رسالة تأكيد للزائر ورابط واتساب جاهز للتواصل المباشر أيضاً.
- صفحة إدارة محمية (مسار /admin) تعرض كل الرسائل الواردة المحفوظة (الأحدث أولاً)، عرض فقط بلا تعديل في هذا الإصدار.
- روابط الشبكات الاجتماعية المُرسلة (إن وُجدت) في التذييل.
- هوية بصرية رسمية واحترافية تناسب الشركات، تدعم العربية RTL، ومتجاوبة على الجوال.
$PROMPT$)
on conflict (key) do update set title = excluded.title, body = excluded.body, updated_at = now();

insert into public.ai_prompts (key, title, body)
values ('portfolio', 'معرض أعمال (Node.js)', $PROMPT$
اكتب معرض أعمال (portfolio) حقيقياً بلغة Node.js (بدون أي إطار عمل خارجي، فقط http المدمج في Node)، بالاستناد إلى بيانات العميل (الاسم، الشعار/التخصص، الوصف، معلومات التواصل، الشبكات الاجتماعية، وقائمة "الأعمال/المشاريع" المُرسلة بصيغة "الاسم | (فارغ أو فئة) | وصف قصير").

يجب أن يتضمن المشروع:
- صفحة رئيسية تعرض: اسم الشخص أو الاستوديو والتخصص، نبذة قصيرة، شبكة أعمال/مشاريع (بطاقة لكل عمل: الاسم، الفئة إن وُجدت، وصف قصير، وبديل بصري بتدرج CSS مميز لكل بطاقة بدل صورة خارجية).
- قسم "تواصل معي" بنموذج تواصل بسيط (الاسم، البريد أو الهاتف، الرسالة) يُحفظ في SQLite كرسالة واردة جديدة، مع رسالة تأكيد ورابط واتساب/بريد مباشر أيضاً إن وُجد.
- صفحة إدارة محمية (مسار /admin) تعرض كل الرسائل الواردة المحفوظة (الأحدث أولاً)، عرض فقط.
- روابط الشبكات الاجتماعية المُرسلة في التذييل أو قسم مخصّص.
- تصميم إبداعي وعصري يعكس هوية بصرية مميزة (دون صور خارجية، فقط CSS/SVG داخلي)، يدعم العربية RTL، ومتجاوب على الجوال.
$PROMPT$)
on conflict (key) do update set title = excluded.title, body = excluded.body, updated_at = now();

commit;
