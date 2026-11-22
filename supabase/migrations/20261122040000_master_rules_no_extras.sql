-- 2026-11-22: the AI must not add anything the user did not ask for (e.g. a WhatsApp/contact bar, promo strip,
-- floating button, FAQ, fake testimonials). Appends one rule to the full master rules; safe to run twice.
update public.platform_settings
set value = value || E'\n\nقاعدة عدم الإضافة: لا تضف أي عنصر أو شاشة أو قسم لم يذكره المستخدم صراحةً (شريط تواصل أو واتساب، شريط عروض، زر عائم، بانر، نافذة منبثقة، أسئلة شائعة، آراء عملاء، إحصائيات). نفّذ ما في طلبه فقط، وما عداه لا يُضاف.'
where key = 'ai.master_rules' and value not like '%قاعدة عدم الإضافة%';
