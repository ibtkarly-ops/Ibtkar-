-- 1) Hardening: throttle anonymous "interest" sign-ups (spam) + sane email length. Non-destructive.
create or replace function public.throttle_interest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.interest_signups where created_at > now() - interval '1 minute') >= 20 then
    raise exception 'rate_limited';
  end if;
  return new;
end $$;
create or replace trigger interest_throttle before insert on public.interest_signups for each row execute function public.throttle_interest();
do $$ begin
  alter table public.interest_signups add constraint interest_email_len check (length(email) <= 254) not valid;
exception when duplicate_object then null; end $$;

-- 2) Public bucket for site images / logos. Path: <website_id>/<file>. Only the site owner (or an admin) can write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-assets', 'site-assets', true, 2097152, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'];

do $$ begin
  create policy sa_sel on storage.objects for select to authenticated using (bucket_id = 'site-assets' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.owns_website(((storage.foldername(name))[1])::uuid) else false end);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sa_ins on storage.objects for insert to authenticated with check (bucket_id = 'site-assets' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.owns_website(((storage.foldername(name))[1])::uuid) else false end);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sa_upd on storage.objects for update to authenticated using (bucket_id = 'site-assets' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.owns_website(((storage.foldername(name))[1])::uuid) else false end);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sa_del on storage.objects for delete to authenticated using (bucket_id = 'site-assets' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.owns_website(((storage.foldername(name))[1])::uuid) else false end);
exception when duplicate_object then null; end $$;

-- 3) 24/7 monitoring every 5 minutes. The job authenticates with a random secret kept in platform_settings
--    ('cron.secret'), so the service-role key never has to be pasted anywhere.
create extension if not exists pg_cron;
create extension if not exists pg_net;
insert into public.platform_settings (key, value)
values ('cron.secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
select cron.unschedule(jobid) from cron.job where jobname = 'ibtikar-uptime-check';
select cron.schedule('ibtikar-uptime-check', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://ppegbmqkcdwopakewetl.supabase.co/functions/v1/uptime-check',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from public.platform_settings where key = 'cron.secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000);
$job$);
