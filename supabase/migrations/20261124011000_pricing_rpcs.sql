-- Phase 2b: quote functions. Every price decision is made by a human Super Admin; nothing here lets AI or the customer set a price.
create or replace function public.score_project(p_inputs jsonb) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  with w as (select factor, unit_price from public.pricing_weights),
  parts as (select w.factor, coalesce(nullif(p_inputs->>w.factor,'')::numeric, 0) qty, w.unit_price,
                   coalesce(nullif(p_inputs->>w.factor,'')::numeric, 0) * w.unit_price amount from w)
  select jsonb_build_object('items', (select jsonb_agg(jsonb_build_object('factor',factor,'qty',qty,'unit',unit_price,'amount',amount) order by factor) from parts),
                            'total', coalesce((select sum(amount) from parts), 0));
$$;
revoke all on function public.score_project(jsonb) from public, anon;
grant execute on function public.score_project(jsonb) to authenticated, service_role;

-- Admin proposes a quote for a site. Fixed rules copy the current official fees; "complex" uses the scoring (suggested only).
create or replace function public.create_quote(p_site uuid, p_rule text, p_inputs jsonb default null) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare r public.pricing_rules; v_owner uuid; v_id uuid; v_score jsonb; v_sug numeric;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select * into r from public.pricing_rules where code = p_rule and active;
  if not found then raise exception 'unknown_rule'; end if;
  select owner_id into v_owner from public.websites where id = p_site;
  if v_owner is null then raise exception 'site_not_found'; end if;
  if r.needs_review then
    v_score := public.score_project(coalesce(p_inputs,'{}'::jsonb)); v_sug := (v_score->>'total')::numeric;
  end if;
  insert into public.project_quotes(website_id, customer_id, rule_code, ibtkar_fee, ai_fee, scoring, suggested_total, status, created_by)
  values (p_site, v_owner, r.code, r.ibtkar_fee, r.ai_fee, v_score, v_sug, 'proposed', auth.uid()) returning id into v_id;
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'quote.create', 'project_quotes', jsonb_build_object('id', v_id, 'rule', r.code));
  return v_id;
end $$;
revoke all on function public.create_quote(uuid, text, jsonb) from public, anon;
grant execute on function public.create_quote(uuid, text, jsonb) to authenticated, service_role;

-- Only the Super Admin approves; for scored projects the approved figure is entered by them (IBTKAR fee + AI fee).
create or replace function public.approve_quote(p_id uuid, p_ibtkar numeric default null, p_ai numeric default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare q public.project_quotes; v_ok boolean;
begin
  if not public.is_super() then raise exception 'forbidden'; end if;
  select * into q from public.project_quotes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if q.status = 'approved' then raise exception 'quote_locked'; end if;
  update public.project_quotes set status = 'approved', approved_by = auth.uid(), approved_at = now(),
    ibtkar_fee = coalesce(p_ibtkar, ibtkar_fee), ai_fee = coalesce(p_ai, ai_fee) where id = p_id;
  if (select needs_review from public.pricing_rules where code = q.rule_code) and (select ibtkar_fee + ai_fee from public.project_quotes where id = p_id) <= 0 then
    raise exception 'price_required';
  end if;
  insert into public.notifications(user_id, type, title, body) values (q.customer_id, 'quote', 'quote_ready', p_id::text);
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'quote.approve', 'project_quotes', jsonb_build_object('id', p_id));
end $$;
revoke all on function public.approve_quote(uuid, numeric, numeric) from public, anon;
grant execute on function public.approve_quote(uuid, numeric, numeric) to authenticated, service_role;

-- The customer chooses which external services they want and agrees to their price/period; the price is copied into the quote.
create or replace function public.select_external_services(p_quote uuid, p_services uuid[]) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare q public.project_quotes; s public.external_services; v_ext numeric := 0;
begin
  select * into q from public.project_quotes where id = p_quote;
  if not found or q.customer_id <> auth.uid() or q.status <> 'approved' then raise exception 'not_allowed'; end if;
  delete from public.quote_external_items where quote_id = p_quote;
  for s in select * from public.external_services where id = any(coalesce(p_services,'{}')) and active loop
    insert into public.quote_external_items(quote_id, service_id, name_ar, billing, price) values (p_quote, s.id, s.name_ar, s.billing, s.price);
  end loop;
  select coalesce(sum(price),0) into v_ext from public.quote_external_items where quote_id = p_quote;
  return jsonb_build_object('ibtkar_fee', q.ibtkar_fee, 'ai_fee', q.ai_fee, 'external', v_ext, 'total', q.ibtkar_fee + q.ai_fee + v_ext);
end $$;
revoke all on function public.select_external_services(uuid, uuid[]) from public, anon;
grant execute on function public.select_external_services(uuid, uuid[]) to authenticated;

-- Admin-only: estimated internal cost of a site (AI usage so far + a flat resource estimate) and a loss alert.
create or replace function public.refresh_cost_estimate(p_site uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_ai numeric; v_lim numeric; v_total numeric; v_first boolean;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select coalesce(sum(cost),0) into v_ai from public.ai_usage where website_id = p_site;
  select coalesce(nullif(value,'')::numeric, 150) into v_lim from public.platform_settings where key = 'finance.cost_alert_lyd';
  insert into public.project_cost_estimates(website_id, ai_cost_est, updated_at) values (p_site, v_ai, now())
    on conflict (website_id) do update set ai_cost_est = excluded.ai_cost_est, updated_at = now();
  v_total := v_ai + (select resource_cost_est from public.project_cost_estimates where website_id = p_site);
  select not alert_sent into v_first from public.project_cost_estimates where website_id = p_site;
  if v_total > v_lim and v_first then
    insert into public.notifications(user_id, type, title, body)
      select id, 'cost_alert', 'cost_alert', p_site::text from public.profiles where role in ('super_admin') and status = 'active';
    update public.project_cost_estimates set alert_sent = true where website_id = p_site;
  end if;
  return jsonb_build_object('estimated_cost', v_total, 'limit', v_lim, 'over', v_total > v_lim);
end $$;
revoke all on function public.refresh_cost_estimate(uuid) from public, anon;
grant execute on function public.refresh_cost_estimate(uuid) to authenticated, service_role;
