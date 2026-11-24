-- Phase 1 security hardening (additive, idempotent).
-- Trigger-only functions never need to be callable through the REST API.
revoke all on function public.enforce_site_asset_quota() from public, anon, authenticated;
revoke all on function public.throttle_help()            from public, anon, authenticated;
revoke all on function public.throttle_interest()        from public, anon, authenticated;

-- Functions that only make sense for a signed-in user (they already check ownership inside).
revoke all on function public.notify_site_needs_contract(uuid) from public, anon;
grant execute on function public.notify_site_needs_contract(uuid) to authenticated, service_role;
revoke all on function public.site_is_contract_cleared(uuid) from public, anon;
grant execute on function public.site_is_contract_cleared(uuid) to authenticated, service_role;
revoke all on function public.site_asset_bytes(uuid) from public, anon;
grant execute on function public.site_asset_bytes(uuid) to authenticated, service_role;

-- site_asset_bytes used to disclose any site's storage size to anyone: owner / staff / internal only.
create or replace function public.site_asset_bytes(p_site uuid) returns bigint
language sql stable security definer set search_path to 'public' as $$
  select case when auth.uid() is null or public.owns_website(p_site) or public.is_admin()
    then coalesce((select sum((metadata->>'size')::bigint) from storage.objects
                   where bucket_id='site-assets' and split_part(name,'/',1) = p_site::text), 0)
    else 0 end;
$$;

-- Explicit "nobody through the API" policy; the service role (edge functions / vault helpers) bypasses RLS.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='integration_secrets' and policyname='is_no_api_access') then
    create policy is_no_api_access on public.integration_secrets for all to anon, authenticated using (false) with check (false);
  end if;
end $$;
