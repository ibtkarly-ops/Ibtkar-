-- the old notify RPC is replaced by issue_contract_for_site (idempotent, owner/admin only); nothing in the app calls it any more
revoke execute on function public.notify_site_needs_contract(uuid) from public, anon, authenticated;

-- the gate answers only for the site's owner or staff (a signed-in stranger learns nothing about someone else's site); service_role / triggers (no JWT) are unaffected
create or replace function public.site_is_contract_cleared(p_site uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select (auth.uid() is null or public.owns_website(p_site) or public.is_admin())
     and (exists (select 1 from public.contracts where website_id = p_site and status in ('received_signed','approved'))
          or exists (select 1 from public.project_contracts c join public.contract_signatures s on s.contract_id = c.id
                     where c.website_id = p_site and c.status = 'approved' and c.final_pdf_path is not null and c.final_sha256 is not null));
$$;
create or replace function public.site_payment_cleared(p_site uuid) returns boolean
language sql stable security definer set search_path to 'public' as $$
  select (auth.uid() is null or public.owns_website(p_site) or public.is_admin()) and
    case when coalesce((select value from public.platform_settings where key = 'publish.require_payment'), 'false') <> 'true' then true
    else coalesce((select sum(approved_amount) from public.site_payments where website_id = p_site and status = 'approved'), 0)
         >= greatest(coalesce((select ibtkar_fee + ai_fee from public.project_quotes where website_id = p_site and status = 'approved' order by approved_at desc nulls last limit 1), 0), 0.01)
  end;
$$;
