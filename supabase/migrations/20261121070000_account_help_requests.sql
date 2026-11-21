-- "Forgot my email": the visitor gets a 6-digit code on screen and is sent to WhatsApp with that code.
-- The code is also stored here so the support agent (admin) can match the chat to the request.
create table if not exists public.account_help_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[0-9]{6}$'),
  handled boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.account_help_requests enable row level security;
do $$ begin
  create policy ahr_ins on public.account_help_requests for insert to anon, authenticated with check (code ~ '^[0-9]{6}$' and handled = false);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ahr_sel on public.account_help_requests for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ahr_upd on public.account_help_requests for update to authenticated using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;
create or replace function public.throttle_help() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.account_help_requests where created_at > now() - interval '1 minute') >= 20 then raise exception 'rate_limited'; end if;
  return new;
end $$;
create or replace trigger help_throttle before insert on public.account_help_requests for each row execute function public.throttle_help();
insert into public.platform_settings (key, value) values ('public.support_whatsapp', '') on conflict (key) do nothing;
