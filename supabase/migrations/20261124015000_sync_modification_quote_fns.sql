-- Sync only: these two functions already exist in the live database (created before migrations were tracked) but were missing from the repo.
-- Definitions are identical to the live ones, so applying this file is a no-op; it makes a fresh database match production.
-- They belong to the original modification_requests flow: admin quotes a price -> customer accepts/rejects.
create or replace function public.quote_modification(p_id uuid, p_price numeric) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid price'; end if;
  update public.modification_requests set final_price = p_price, status = 'quoted' where id = p_id returning user_id into v_user;
  if v_user is null then raise exception 'not found'; end if;
  insert into public.notifications(user_id, type, title) values (v_user, 'modification', 'quote_ready');
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'modification.quote', 'modification_requests', jsonb_build_object('id', p_id, 'price', p_price));
end $$;
revoke all on function public.quote_modification(uuid, numeric) from public, anon;
grant execute on function public.quote_modification(uuid, numeric) to authenticated, service_role;

create or replace function public.respond_quote(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.modification_requests
     set status = case when p_accept then 'approved' else 'rejected' end
   where id = p_id and user_id = auth.uid() and status = 'quoted';
  if not found then raise exception 'not allowed'; end if;
  insert into public.audit_logs(actor_id, action, entity, meta) values (auth.uid(), 'modification.respond', 'modification_requests', jsonb_build_object('id', p_id, 'accept', p_accept));
end $$;
revoke all on function public.respond_quote(uuid, boolean) from public, anon;
grant execute on function public.respond_quote(uuid, boolean) to authenticated, service_role;
