-- Phase 3-6: central contract IMAGE system. One official contract (multi-page, versioned, immutable originals) uploaded once by
-- the Super Admin, issued automatically per customer site, signed by the customer only, final PDF + hashes + audit trail.
-- Additive: the old `contracts` table and public token page keep working for already-issued contracts.
create sequence if not exists public.project_contract_seq;

create table if not exists public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'IBTIKAR official contract',
  active boolean not null default true,
  auto_send boolean not null default true,
  active_version_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists contract_templates_singleton on public.contract_templates ((true));

create table if not exists public.contract_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.contract_templates(id),
  version int not null,
  pages jsonb not null check (jsonb_typeof(pages) = 'array' and jsonb_array_length(pages) between 1 and 12),
  layout jsonb not null,                -- {sig:{page,x,y,w,h}, name:{...}, date:{...}} as fractions of the page (y from the top)
  original_sha256 text not null,        -- hash over the page hashes, fixed forever
  created_by uuid, created_at timestamptz not null default now(),
  unique (template_id, version)
);
alter table public.contract_templates drop constraint if exists contract_templates_active_version_fk;
alter table public.contract_templates add constraint contract_templates_active_version_fk foreign key (active_version_id) references public.contract_template_versions(id);

create table if not exists public.project_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number text not null unique,
  website_id uuid not null references public.websites(id) on delete restrict,
  customer_id uuid not null references auth.users(id) on delete restrict,
  template_version_id uuid not null references public.contract_template_versions(id),
  status text not null default 'awaiting_signature' check (status in ('awaiting_signature','viewed','signed','approved','rejected','cancelled','superseded','delivery_failed')),
  delivered_at timestamptz not null default now(), viewed_at timestamptz, signed_at timestamptz,
  approved_at timestamptz, approved_by uuid, rejected_reason text,
  final_pdf_path text, final_sha256 text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists project_contracts_customer_idx on public.project_contracts(customer_id);
create index if not exists project_contracts_site_idx on public.project_contracts(website_id);
create index if not exists project_contracts_tv_idx on public.project_contracts(template_version_id);
-- one live contract per site: a repeated trigger can never create a duplicate
create unique index if not exists project_contracts_one_live on public.project_contracts(website_id) where status in ('awaiting_signature','viewed','signed','approved');

create table if not exists public.contract_signatures (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null unique references public.project_contracts(id) on delete restrict,
  customer_id uuid not null, signer_name text not null,
  signature_path text not null, name_image_path text,
  ip text, user_agent text,
  viewed_at timestamptz, agreed_at timestamptz not null default now(), signed_at timestamptz not null default now(),
  template_version int, original_sha256 text not null, final_sha256 text not null,
  consent_text text not null
);
create table if not exists public.contract_events (
  id bigint generated always as identity primary key,
  contract_id uuid references public.project_contracts(id) on delete restrict, website_id uuid,
  actor_id uuid, type text not null, meta jsonb, created_at timestamptz not null default now()
);
create index if not exists contract_events_contract_idx on public.contract_events(contract_id, created_at);
create table if not exists public.contract_delivery_logs (
  id bigint generated always as identity primary key,
  website_id uuid, contract_id uuid, channel text not null default 'in_app',
  status text not null check (status in ('sent','failed','skipped')), error text, attempt int not null default 1,
  created_at timestamptz not null default now()
);

alter table public.contract_templates enable row level security;
alter table public.contract_template_versions enable row level security;
alter table public.project_contracts enable row level security;
alter table public.contract_signatures enable row level security;
alter table public.contract_events enable row level security;
alter table public.contract_delivery_logs enable row level security;
do $$ begin
  create policy cx_t_sel on public.contract_templates for select to authenticated using (public.is_admin());
  create policy cx_v_sel on public.contract_template_versions for select to authenticated using (public.is_admin());
  create policy cx_c_sel on public.project_contracts for select to authenticated using (public.is_admin() or customer_id = auth.uid());
  create policy cx_s_sel on public.contract_signatures for select to authenticated using (public.is_admin() or customer_id = auth.uid());
  create policy cx_e_sel on public.contract_events for select to authenticated using (public.is_admin() or exists (select 1 from public.project_contracts c where c.id = contract_id and c.customer_id = auth.uid()));
  create policy cx_d_sel on public.contract_delivery_logs for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;

-- immutability: originals, signatures and the event trail can never be edited or deleted through SQL by clients or by mistake
create or replace function public.ct_immutable() returns trigger language plpgsql set search_path to 'public' as $$
begin raise exception 'immutable_record'; end $$;
drop trigger if exists trg_ct_v_imm on public.contract_template_versions;
create trigger trg_ct_v_imm before update or delete on public.contract_template_versions for each row execute function public.ct_immutable();
drop trigger if exists trg_ct_s_imm on public.contract_signatures;
create trigger trg_ct_s_imm before update or delete on public.contract_signatures for each row execute function public.ct_immutable();
drop trigger if exists trg_ct_e_imm on public.contract_events;
create trigger trg_ct_e_imm before update or delete on public.contract_events for each row execute function public.ct_immutable();
revoke all on function public.ct_immutable() from public, anon, authenticated;

-- status machine enforced in the database (the UI can never jump states)
create or replace function public.ct_guard_status() returns trigger language plpgsql set search_path to 'public' as $$
declare ok boolean;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    ok := case old.status
      when 'awaiting_signature' then new.status in ('viewed','signed','rejected','cancelled','superseded')
      when 'viewed'             then new.status in ('signed','rejected','cancelled','superseded')
      when 'signed'             then new.status in ('approved','rejected','cancelled')
      when 'approved'           then new.status in ('cancelled')
      else false end;
    if not ok then raise exception 'invalid_transition % -> %', old.status, new.status; end if;
    if new.status = 'signed' and not exists (select 1 from public.contract_signatures s where s.contract_id = new.id) then raise exception 'signature_required'; end if;
    if new.status = 'approved' and (new.final_pdf_path is null or new.final_sha256 is null) then raise exception 'final_copy_required'; end if;
  end if;
  if tg_op = 'UPDATE' and (new.website_id, new.customer_id, new.template_version_id, new.contract_number) is distinct from (old.website_id, old.customer_id, old.template_version_id, old.contract_number) then raise exception 'contract_fixed'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_ct_guard_status on public.project_contracts;
create trigger trg_ct_guard_status before insert or update on public.project_contracts for each row execute function public.ct_guard_status();
revoke all on function public.ct_guard_status() from public, anon, authenticated;

create or replace function public.ct_log(p_contract uuid, p_site uuid, p_type text, p_meta jsonb default null) returns void
language sql security definer set search_path to 'public' as $$
  insert into public.contract_events(contract_id, website_id, actor_id, type, meta) values (p_contract, p_site, auth.uid(), p_type, p_meta);
$$;
revoke all on function public.ct_log(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- called only by the edge function (service role) after it validated and stored the original images
create or replace function public.ct_create_template_version(p_pages jsonb, p_layout jsonb, p_by uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare t public.contract_templates; v_ver int; v_id uuid; v_hash text;
begin
  select * into t from public.contract_templates limit 1;
  if not found then insert into public.contract_templates default values returning * into t; end if;
  select coalesce(max(version),0) + 1 into v_ver from public.contract_template_versions where template_id = t.id;
  select encode(sha256(convert_to(string_agg(p->>'sha256', ',' order by ord), 'UTF8')), 'hex') into v_hash from jsonb_array_elements(p_pages) with ordinality as e(p, ord);
  insert into public.contract_template_versions(template_id, version, pages, layout, original_sha256, created_by) values (t.id, v_ver, p_pages, p_layout, v_hash, p_by) returning id into v_id;
  update public.contract_templates set active_version_id = v_id, active = true, updated_at = now() where id = t.id;
  insert into public.contract_events(contract_id, website_id, actor_id, type, meta) values (null, null, p_by, 'template_activated', jsonb_build_object('version', v_ver, 'sha256', v_hash, 'version_id', v_id));
  insert into public.audit_logs(actor_id, action, entity, meta) values (p_by, 'contract.template_activate', 'contract_template_versions', jsonb_build_object('version', v_ver));
  return v_id;
end $$;
revoke all on function public.ct_create_template_version(jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.ct_create_template_version(jsonb, jsonb, uuid) to service_role;

create or replace function public.ct_set_template_flags(p_active boolean, p_auto boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_super() then raise exception 'forbidden'; end if;
  update public.contract_templates set active = coalesce(p_active, active), auto_send = coalesce(p_auto, auto_send), updated_at = now();
  perform public.ct_log(null, null, 'template_flags', jsonb_build_object('active', p_active, 'auto_send', p_auto));
end $$;
revoke all on function public.ct_set_template_flags(boolean, boolean) from public, anon;
grant execute on function public.ct_set_template_flags(boolean, boolean) to authenticated;

-- AUTOMATIC DELIVERY: idempotent; called when a site is ready to publish (or by an admin to resend).
create or replace function public.issue_contract_for_site(p_site uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare w record; t public.contract_templates; v_exist uuid; v_id uuid; v_num text; v_admin boolean := public.is_admin();
begin
  select id, owner_id, name, config into w from public.websites where id = p_site;
  if w.id is null then return jsonb_build_object('ok', false, 'reason', 'site_not_found'); end if;
  if auth.uid() is not null and not (v_admin or w.owner_id = auth.uid()) then raise exception 'forbidden'; end if;
  if coalesce(w.config->>'html', '') = '' or not exists (select 1 from public.profiles where id = w.owner_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_ready');
  end if;
  select id into v_exist from public.project_contracts where website_id = p_site and status in ('awaiting_signature','viewed','signed','approved');
  if v_exist is not null then return jsonb_build_object('ok', true, 'reason', 'exists', 'id', v_exist); end if;
  select * into t from public.contract_templates limit 1;
  if t.id is null or not t.active or t.active_version_id is null then
    insert into public.contract_delivery_logs(website_id, status, error) values (p_site, 'failed', 'no_active_template');
    insert into public.notifications(user_id, type, title, body) select id, 'contract_delivery_failed', 'contract_delivery_failed', w.name from public.profiles where role in ('super_admin','admin') and status = 'active';
    return jsonb_build_object('ok', false, 'reason', 'no_template');
  end if;
  if not t.auto_send and not v_admin then
    insert into public.contract_delivery_logs(website_id, status, error) values (p_site, 'skipped', 'auto_send_off');
    return jsonb_build_object('ok', false, 'reason', 'auto_send_off');
  end if;
  v_num := 'IBT-C-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.project_contract_seq')::text, 4, '0');
  insert into public.project_contracts(contract_number, website_id, customer_id, template_version_id) values (v_num, p_site, w.owner_id, t.active_version_id) returning id into v_id;
  insert into public.contract_delivery_logs(website_id, contract_id, status) values (p_site, v_id, 'sent');
  insert into public.notifications(user_id, type, title, body) values (w.owner_id, 'contract_v2', 'contract_ready', v_id::text);
  perform public.ct_log(v_id, p_site, 'delivered', jsonb_build_object('number', v_num));
  insert into public.notifications(user_id, type, title, body) select id, 'contract_delivered_admin', 'contract_delivered', v_num from public.profiles where role = 'super_admin' and status = 'active';
  return jsonb_build_object('ok', true, 'reason', 'issued', 'id', v_id, 'number', v_num);
end $$;
revoke all on function public.issue_contract_for_site(uuid) from public, anon;
grant execute on function public.issue_contract_for_site(uuid) to authenticated, service_role;

create or replace function public.ct_mark_viewed(p_contract uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare c public.project_contracts;
begin
  select * into c from public.project_contracts where id = p_contract;
  if not found or c.customer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if c.status = 'awaiting_signature' then update public.project_contracts set status = 'viewed', viewed_at = now() where id = p_contract; end if;
  perform public.ct_log(p_contract, c.website_id, 'opened', null);
end $$;
revoke all on function public.ct_mark_viewed(uuid) from public, anon;
grant execute on function public.ct_mark_viewed(uuid) to authenticated;

create or replace function public.ct_pages_seen(p_contract uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare c public.project_contracts;
begin
  select * into c from public.project_contracts where id = p_contract;
  if not found or c.customer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.contract_events where contract_id = p_contract and type = 'all_pages_viewed') then
    perform public.ct_log(p_contract, c.website_id, 'all_pages_viewed', null);
  end if;
end $$;
revoke all on function public.ct_pages_seen(uuid) from public, anon;
grant execute on function public.ct_pages_seen(uuid) to authenticated;

-- ATOMIC finalize (service role only; the edge function has already validated the images and built the PDF)
create or replace function public.ct_finalize_signature(p_contract uuid, p_user uuid, p_name text, p_sig_path text, p_name_path text, p_pdf_path text, p_final_sha text, p_ip text, p_ua text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c public.project_contracts; v public.contract_template_versions; v_viewed timestamptz;
begin
  select * into c from public.project_contracts where id = p_contract for update;
  if not found or c.customer_id <> p_user then raise exception 'forbidden'; end if;
  if c.status not in ('awaiting_signature','viewed') then raise exception 'not_awaiting_signature'; end if;
  if exists (select 1 from public.contract_signatures where contract_id = p_contract) then raise exception 'already_signed'; end if;
  select created_at into v_viewed from public.contract_events where contract_id = p_contract and type = 'all_pages_viewed' order by id limit 1;
  if v_viewed is null then raise exception 'review_required'; end if;
  select * into v from public.contract_template_versions where id = c.template_version_id;
  insert into public.contract_signatures(contract_id, customer_id, signer_name, signature_path, name_image_path, ip, user_agent, viewed_at, template_version, original_sha256, final_sha256, consent_text)
  values (p_contract, p_user, left(p_name, 120), p_sig_path, p_name_path, left(p_ip, 64), left(p_ua, 300), v_viewed, v.version, v.original_sha256, p_final_sha,
          'أقرّ بأنني قرأت العقد كاملاً وأوافق على محتواه وأوقّعه بنفسي.');
  update public.project_contracts set status = 'signed', signed_at = now(), final_pdf_path = p_pdf_path, final_sha256 = p_final_sha where id = p_contract;
  insert into public.contract_events(contract_id, website_id, actor_id, type, meta) values (p_contract, c.website_id, p_user, 'signed', jsonb_build_object('final_sha256', p_final_sha, 'original_sha256', v.original_sha256, 'version', v.version));
  insert into public.notifications(user_id, type, title, body) values (p_user, 'contract_signed_ok', 'contract_signed_ok', p_contract::text);
  insert into public.notifications(user_id, type, title, body) select id, 'contract_signed_admin', 'contract_signed', c.contract_number from public.profiles where role in ('super_admin','admin') and status = 'active';
  return jsonb_build_object('ok', true, 'number', c.contract_number);
end $$;
revoke all on function public.ct_finalize_signature(uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ct_finalize_signature(uuid, uuid, text, text, text, text, text, text, text) to service_role;

create or replace function public.ct_admin_action(p_contract uuid, p_action text, p_reason text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare c public.project_contracts;
begin
  select * into c from public.project_contracts where id = p_contract for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'reject_customer' then
    if c.customer_id <> auth.uid() then raise exception 'forbidden'; end if;
    update public.project_contracts set status = 'rejected', rejected_reason = left(p_reason, 500) where id = p_contract;
    insert into public.notifications(user_id, type, title, body) select id, 'contract_rejected_admin', 'contract_rejected', c.contract_number from public.profiles where role in ('super_admin','admin') and status = 'active';
  else
    if not public.is_admin() then raise exception 'forbidden'; end if;
    if p_action = 'approve' then
      update public.project_contracts set status = 'approved', approved_at = now(), approved_by = auth.uid() where id = p_contract;
      insert into public.notifications(user_id, type, title, body) values (c.customer_id, 'contract_approved_v2', 'contract_approved', p_contract::text);
    elsif p_action = 'reject' then update public.project_contracts set status = 'rejected', rejected_reason = left(p_reason, 500) where id = p_contract;
    elsif p_action = 'cancel' then update public.project_contracts set status = 'cancelled', rejected_reason = left(p_reason, 500) where id = p_contract;
    elsif p_action = 'resend' then
      if c.status not in ('awaiting_signature','viewed') then raise exception 'not_pending'; end if;
      insert into public.notifications(user_id, type, title, body) values (c.customer_id, 'contract_v2', 'contract_ready', p_contract::text);
      insert into public.contract_delivery_logs(website_id, contract_id, status, attempt) values (c.website_id, p_contract, 'sent', (select count(*) + 1 from public.contract_delivery_logs where contract_id = p_contract));
    else raise exception 'unknown_action'; end if;
  end if;
  perform public.ct_log(p_contract, c.website_id, p_action, jsonb_build_object('reason', p_reason));
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'contract.' || p_action, 'project_contracts', jsonb_build_object('id', p_contract));
end $$;
revoke all on function public.ct_admin_action(uuid, text, text) from public, anon;
grant execute on function public.ct_admin_action(uuid, text, text) to authenticated;

-- PUBLISH GATE: old gate (legacy contracts) OR the new approved image contract. request_publish already calls this function.
create or replace function public.site_is_contract_cleared(p_site uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.contracts where website_id = p_site and status in ('received_signed','approved'))
      or exists (select 1 from public.project_contracts c join public.contract_signatures s on s.contract_id = c.id
                 where c.website_id = p_site and c.status = 'approved' and c.final_pdf_path is not null and c.final_sha256 is not null);
$$;

create or replace function public.ct_stats() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case when public.is_admin() then
    (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.project_contracts group by status) x)
    || jsonb_build_object('failed_deliveries', (select count(*) from public.contract_delivery_logs where status = 'failed'))
  else '{}'::jsonb end;
$$;
revoke all on function public.ct_stats() from public, anon;
grant execute on function public.ct_stats() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ibtkar-contracts-private', 'ibtkar-contracts-private', false, 10485760, array['image/png','image/jpeg','application/pdf'])
on conflict (id) do nothing;
