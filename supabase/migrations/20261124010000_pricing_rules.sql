-- Phase 2: official pricing rules (LYD). Additive; old `plans` table untouched (subscriptions keep working).
create table if not exists public.pricing_rules (
  code text primary key,
  name_ar text not null,
  ibtkar_fee numeric(12,2) not null check (ibtkar_fee >= 0),
  ai_fee numeric(12,2) not null check (ai_fee >= 0),
  ai_fee_is_minimum boolean not null default false,   -- rule 3: AI fee "starts from" and grows with real workload
  needs_review boolean not null default false,        -- rule 4: price comes from scoring and needs admin approval
  active boolean not null default true,
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create table if not exists public.pricing_rule_history (
  id bigint generated always as identity primary key,
  rule_code text not null, old_row jsonb, new_row jsonb,
  changed_by uuid, changed_at timestamptz not null default now()
);
create table if not exists public.pricing_weights (
  factor text primary key, label_ar text not null, unit_price numeric(12,2) not null check (unit_price >= 0), sort int default 0,
  updated_at timestamptz not null default now(), updated_by uuid
);
create table if not exists public.external_services (
  id uuid primary key default gen_random_uuid(),
  code text unique not null, name_ar text not null,
  billing text not null check (billing in ('one_time','monthly','annual')),
  price numeric(12,2) not null check (price >= 0), active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.project_quotes (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  customer_id uuid not null references auth.users(id),
  rule_code text not null references public.pricing_rules(code),
  ibtkar_fee numeric(12,2) not null, ai_fee numeric(12,2) not null,
  scoring jsonb, suggested_total numeric(12,2),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  approved_by uuid, approved_at timestamptz, created_by uuid, created_at timestamptz not null default now()
);
create index if not exists project_quotes_site_idx on public.project_quotes(website_id);
create index if not exists project_quotes_customer_idx on public.project_quotes(customer_id);
create table if not exists public.quote_external_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.project_quotes(id) on delete cascade,
  service_id uuid references public.external_services(id),
  name_ar text not null, billing text not null, price numeric(12,2) not null,   -- snapshot: later price changes never touch it
  selected_at timestamptz not null default now(), unique (quote_id, service_id)
);
-- internal estimate of what a project costs IBTKAR (admin only)
create table if not exists public.project_cost_estimates (
  website_id uuid primary key references public.websites(id) on delete cascade,
  ai_cost_est numeric(12,2) not null default 0, resource_cost_est numeric(12,2) not null default 0,
  alert_sent boolean not null default false, updated_at timestamptz not null default now()
);

alter table public.pricing_rules enable row level security;
alter table public.pricing_rule_history enable row level security;
alter table public.pricing_weights enable row level security;
alter table public.external_services enable row level security;
alter table public.project_quotes enable row level security;
alter table public.quote_external_items enable row level security;
alter table public.project_cost_estimates enable row level security;

do $$ begin
  -- rules / services are readable by signed-in users (customers must see what they pay for); only the super admin writes
  create policy pr_sel on public.pricing_rules for select to authenticated using (active or public.is_super());
  create policy pr_all on public.pricing_rules for all to authenticated using (public.is_super()) with check (public.is_super());
  create policy prh_sel on public.pricing_rule_history for select to authenticated using (public.is_super());
  create policy pw_all on public.pricing_weights for all to authenticated using (public.is_super()) with check (public.is_super());
  create policy es_sel on public.external_services for select to authenticated using (active or public.is_super());
  create policy es_all on public.external_services for all to authenticated using (public.is_super()) with check (public.is_super());
  -- a customer only sees their own APPROVED quote; staff see all; nobody writes directly (RPCs only)
  create policy pq_sel on public.project_quotes for select to authenticated using (public.is_admin() or (customer_id = auth.uid() and status = 'approved'));
  create policy qi_sel on public.quote_external_items for select to authenticated using (
    public.is_admin() or exists (select 1 from public.project_quotes q where q.id = quote_id and q.customer_id = auth.uid() and q.status = 'approved'));
  create policy pce_sel on public.project_cost_estimates for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;

-- history + audit on every rule change
create or replace function public.log_pricing_rule() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.pricing_rule_history(rule_code, old_row, new_row, changed_by)
  values (coalesce(new.code, old.code), case when tg_op='INSERT' then null else to_jsonb(old) end, to_jsonb(new), auth.uid());
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'pricing.rule_change', 'pricing_rules', jsonb_build_object('code', new.code, 'ibtkar_fee', new.ibtkar_fee, 'ai_fee', new.ai_fee));
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_log_pricing_rule on public.pricing_rules;
create trigger trg_log_pricing_rule before insert or update on public.pricing_rules for each row execute function public.log_pricing_rule();
revoke all on function public.log_pricing_rule() from public, anon, authenticated;

-- an approved/issued quote is a snapshot: fees and total can never change (no retroactive price change, no AI/service-role edits)
create or replace function public.guard_quote() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'approved' and (new.ibtkar_fee, new.ai_fee, new.rule_code, new.website_id, new.customer_id) is distinct from (old.ibtkar_fee, old.ai_fee, old.rule_code, old.website_id, old.customer_id) then
    raise exception 'quote_locked';
  end if;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') and not public.is_super() then
    raise exception 'only_super_admin_approves';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_quote on public.project_quotes;
create trigger trg_guard_quote before insert or update on public.project_quotes for each row execute function public.guard_quote();
revoke all on function public.guard_quote() from public, anon, authenticated;

insert into public.pricing_rules(code, name_ar, ibtkar_fee, ai_fee, ai_fee_is_minimum, needs_review, sort) values
 ('custom',        'مشروع مخصص',                         200, 400, false, false, 1),
 ('template',      'مشروع بسيط على قالب',                100, 100, false, false, 2),
 ('simple_custom', 'مشروع بسيط بتخصيص أكبر',             100, 150, true,  false, 3),
 ('complex',       'مشروع متوسط أو معقد (يُقيَّم)',        0,   0, false, true,  4)
on conflict (code) do nothing;
-- starting weights for the scoring of medium/complex projects. They are only a first proposal: the Super Admin edits them and approves every price.
insert into public.pricing_weights(factor, label_ar, unit_price, sort) values
 ('pages','كل صفحة',15,1),('functions','كل وظيفة',25,2),('design','تعقيد التصميم (0–3)',50,3),('code_kloc','حجم الكود (ألف سطر)',40,4),
 ('api','كل تكامل API',60,5),('database','قاعدة بيانات (0/1)',100,6),('users_roles','نظام مستخدمين وصلاحيات (0/1)',120,7),
 ('store','متجر وطلبات (0/1)',150,8),('admin_fn','كل وظيفة إدارية',20,9),('customization','حجم التخصيص (0–3)',40,10)
on conflict (factor) do nothing;
insert into public.platform_settings(key, value) values ('finance.cost_alert_lyd','150') on conflict (key) do nothing;
