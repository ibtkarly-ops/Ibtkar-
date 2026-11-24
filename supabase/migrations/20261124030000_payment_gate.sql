-- Phase 6: publish gate on EVERY path (contract approved + payment condition) and manual payment approval.
-- Additive only. Existing published sites are never touched (the gate applies to the move to "published").

create table if not exists public.site_payments (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  customer_id uuid not null references auth.users(id),
  amount_received numeric(12,2) not null check (amount_received >= 0),
  approved_amount numeric(12,2) check (approved_amount >= 0),
  currency text not null default 'LYD',
  method text, reference text, note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_by uuid, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_at timestamptz
);
create index if not exists site_payments_site_idx on public.site_payments(website_id);
create index if not exists site_payments_customer_idx on public.site_payments(customer_id);
alter table public.site_payments enable row level security;
do $$ begin
  create policy sp_sel on public.site_payments for select to authenticated using (public.is_admin() or customer_id = (select auth.uid()));
exception when duplicate_object then null; end $$;
-- no insert/update/delete policies: every write goes through the two functions below

create or replace function public.sp_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'payments_are_permanent'; end if;
  if old.status <> 'pending' then raise exception 'payment_already_reviewed'; end if;
  if new.status = 'approved' and (new.approved_amount is null or new.approved_amount > new.amount_received) then raise exception 'approved_exceeds_received'; end if;
  if new.amount_received is distinct from old.amount_received or new.website_id is distinct from old.website_id or new.customer_id is distinct from old.customer_id then raise exception 'payment_fields_locked'; end if;
  return new;
end $$;
drop trigger if exists trg_sp_guard on public.site_payments;
create trigger trg_sp_guard before update or delete on public.site_payments for each row execute function public.sp_guard();
revoke all on function public.sp_guard() from public, anon, authenticated;

-- the Super Admin switches the payment condition on; it is OFF until then so nothing changes by surprise
insert into public.platform_settings(key, value) values ('publish.require_payment', 'false') on conflict (key) do nothing;

create or replace function public.admin_record_payment(p_site uuid, p_received numeric, p_method text default null, p_ref text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare w record; v uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_received is null or p_received < 0 or p_received > 10000000 then raise exception 'bad_amount'; end if;
  select id, owner_id into w from public.websites where id = p_site;
  if w.id is null then raise exception 'not_found'; end if;
  insert into public.site_payments(website_id, customer_id, amount_received, method, reference, note, created_by)
  values (p_site, w.owner_id, p_received, left(p_method, 60), left(p_ref, 120), left(p_note, 500), auth.uid()) returning id into v;
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'payment.recorded', 'site_payments', jsonb_build_object('id', v, 'site', p_site, 'received', p_received));
  return v;
end $$;
revoke all on function public.admin_record_payment(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.admin_record_payment(uuid, numeric, text, text, text) to authenticated;

-- received vs approved: only the Super Admin decides what amount counts toward the site
create or replace function public.admin_review_payment(p_payment uuid, p_action text, p_amount numeric default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare p public.site_payments;
begin
  if not public.is_super() then raise exception 'forbidden'; end if;
  select * into p from public.site_payments where id = p_payment for update;
  if not found then raise exception 'not_found'; end if;
  if p.status <> 'pending' then raise exception 'payment_already_reviewed'; end if;
  if p_action = 'approve' then
    update public.site_payments set status = 'approved', approved_amount = coalesce(p_amount, amount_received), reviewed_by = auth.uid(), reviewed_at = now() where id = p_payment;
    insert into public.notifications(user_id, type, title, body) values (p.customer_id, 'payment_approved', 'payment_approved', p.website_id::text);
  elsif p_action = 'reject' then
    update public.site_payments set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now() where id = p_payment;
  else raise exception 'unknown_action'; end if;
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'payment.' || p_action, 'site_payments', jsonb_build_object('id', p_payment, 'amount', p_amount));
end $$;
revoke all on function public.admin_review_payment(uuid, text, numeric) from public, anon;
grant execute on function public.admin_review_payment(uuid, text, numeric) to authenticated;

-- payment condition: approved payments must cover the approved quote (IBTKAR fee + AI fee); without a quote, any approved payment counts
create or replace function public.site_payment_cleared(p_site uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select case when coalesce((select value from public.platform_settings where key = 'publish.require_payment'), 'false') <> 'true' then true
    else coalesce((select sum(approved_amount) from public.site_payments where website_id = p_site and status = 'approved'), 0)
         >= greatest(coalesce((select ibtkar_fee + ai_fee from public.project_quotes where website_id = p_site and status = 'approved' order by approved_at desc nulls last limit 1), 0), 0.01)
  end;
$$;
revoke all on function public.site_payment_cleared(uuid) from public, anon;
grant execute on function public.site_payment_cleared(uuid) to authenticated, service_role;

-- one answer for every path: null = may publish, otherwise the reason code
create or replace function public.site_publish_block(p_site uuid) returns text
language sql stable security definer set search_path to 'public' as $$
  select case when not public.site_is_contract_cleared(p_site) then 'contract_pending'
              when not public.site_payment_cleared(p_site) then 'payment_pending' end;
$$;
revoke all on function public.site_publish_block(uuid) from public, anon;
grant execute on function public.site_publish_block(uuid) to authenticated, service_role;

-- path 1: request_publish (owner) — same body as before, the gate now answers contract AND payment
create or replace function public.request_publish(p_site uuid)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_html text; v_slug text; v_base text; v_root text; v_url text; v_id uuid; v_name text; v_try int := 0; v_status text; v_block text;
begin
  if not public.owns_website(p_site) then raise exception 'forbidden'; end if;
  select status into v_status from public.websites where id = p_site;
  if coalesce(v_status,'draft') <> 'published' then
    v_block := public.site_publish_block(p_site);
    if v_block is not null then raise exception '%', v_block; end if;
  end if;
  select coalesce(
           (select value from public.platform_settings where key = 'public.sites_root_domain'),
           (select value from public.platform_settings where key = 'public.sites_base_domain'),
           (select value from public.platform_settings where key = 'public.sites_domain')) into v_root;
  select value into v_base from public.platform_settings where key = 'public.sites_base_url';
  if v_root is not null and v_root !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' then v_root := null; end if;
  if v_base is not null and v_base !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' then v_base := null; end if;
  if v_root is null and v_base is null then raise exception 'hosting_not_configured'; end if;
  select config->>'html', slug, name into v_html, v_slug, v_name from public.websites where id = p_site;
  if v_html is null or length(trim(v_html)) < 20 then raise exception 'nothing_to_publish'; end if;
  if length(v_html) > 2000000 then raise exception 'page_too_large'; end if;
  if v_slug is null then
    loop
      v_slug := trim(both '-' from lower(regexp_replace(coalesce(v_name,'site'), '[^a-zA-Z0-9]+', '-', 'g')));
      if v_slug = '' then v_slug := 'site'; end if;
      v_slug := left(v_slug, 22) || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 5);
      exit when not exists (select 1 from public.websites where slug = v_slug);
      v_try := v_try + 1;
      if v_try > 5 then raise exception 'slug_failed'; end if;
    end loop;
    update public.websites set slug = v_slug where id = p_site;
  end if;
  v_url := case when v_root is not null then 'https://' || v_slug || '.' || v_root else rtrim(v_base, '/') || '/' || v_slug end;
  insert into public.published_sites (website_id, slug, html, hash)
  values (p_site, v_slug, v_html, md5(v_html))
  on conflict (website_id) do update set html = excluded.html, hash = excluded.hash, slug = excluded.slug, published_at = now();
  insert into public.deployments (website_id, status, public_url, verified_live, log, created_by)
  values (p_site, 'building', v_url, false, 'awaiting verification', auth.uid())
  returning id into v_id;
  insert into public.audit_logs (actor_id, action, entity, meta) values (auth.uid(), 'website.publish_requested', 'websites', jsonb_build_object('id', p_site, 'deployment', v_id));
  return v_id;
end $$;

-- path 2: ANY write that moves a site to "published" (owner update, admin update, service role, future code) hits the same gate
create or replace function public.ws_publish_gate() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_block text;
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    v_block := public.site_publish_block(new.id);
    if v_block is not null then raise exception '%', v_block; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_ws_publish_gate on public.websites;
create trigger trg_ws_publish_gate before insert or update of status on public.websites for each row execute function public.ws_publish_gate();
revoke all on function public.ws_publish_gate() from public, anon, authenticated;
