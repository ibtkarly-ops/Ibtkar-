-- ============================================================================
-- IBTIKAR / ابتكار — RLS & index cleanup
--
-- WHY: Supabase's performance advisor flags 47 "multiple permissive policies"
-- warnings: 11 tables each have a `FOR ALL` policy (named "<x>_all") AND a
-- separate `FOR SELECT` policy (named "<x>_sel"). Postgres has to evaluate
-- BOTH policies (OR'd together) on every SELECT, which is wasted work.
-- It also flags 2 exact duplicate indexes.
--
-- WHAT THIS DOES: for each table, the `_sel` policy's condition is updated
-- (via ALTER POLICY) to OR-in whatever the `_all` policy additionally
-- allowed, so nothing that could previously SELECT loses access. Then the
-- `_all` policy is dropped and replaced with three policies scoped to
-- INSERT / UPDATE / DELETE only (same qual/with_check as before), so SELECT
-- is handled solely by `_sel`. End result: identical access control,
-- half the policy evaluations per query.
--
-- This migration is a pure cleanup: it does not grant or revoke access to
-- any role beyond what already existed. It was generated after reading the
-- live policies with `pg_policies` on project ppegbmqkcdwopakewetl (IBTKAR).
--
-- HOW TO RUN: paste this whole file into Supabase Studio -> SQL Editor and
-- run it, or `supabase db push` if you use the CLI with migrations linked.
-- It is idempotent-ish (IF EXISTS guards) but is meant to run once.
-- ============================================================================

begin;

-- ---- Drop exact-duplicate indexes (identical to another index already kept) ----
drop index if exists public.idx_subs_user;      -- duplicate of subscriptions_user_id_idx
drop index if exists public.idx_websites_owner; -- duplicate of websites_owner_id_idx

-- ================================ backups ================================
alter policy bk_sel on public.backups using (owns_website(website_id) or is_admin());
drop policy if exists bk_all on public.backups;
create policy bk_ins on public.backups for insert with check (is_admin());
create policy bk_upd on public.backups for update using (is_admin()) with check (is_admin());
create policy bk_del on public.backups for delete using (is_admin());

-- ================================ banners =================================
alter policy b_sel on public.banners using (active or is_admin());
drop policy if exists b_all on public.banners;
create policy b_ins on public.banners for insert to authenticated with check (is_admin());
create policy b_upd on public.banners for update to authenticated using (is_admin()) with check (is_admin());
create policy b_del on public.banners for delete to authenticated using (is_admin());

-- =============================== deployments ===============================
alter policy dp_sel on public.deployments using (owns_website(website_id) or is_admin());
drop policy if exists dp_all on public.deployments;
create policy dp_ins on public.deployments for insert with check (is_admin());
create policy dp_upd on public.deployments for update using (is_admin()) with check (is_admin());
create policy dp_del on public.deployments for delete using (is_admin());

-- ===== invoices: billing.manage preserved via OR, so no behavior change =====
alter policy inv_sel on public.invoices
  using ((user_id = (select auth.uid())) or has_perm('billing.read') or has_perm('billing.manage'));
drop policy if exists inv_all on public.invoices;
create policy inv_ins on public.invoices for insert with check (has_perm('billing.manage'));
create policy inv_upd on public.invoices for update using (has_perm('billing.manage')) with check (has_perm('billing.manage'));
create policy inv_del on public.invoices for delete using (has_perm('billing.manage'));

-- =============================== org_members ===============================
drop policy if exists om_all on public.org_members;
create policy om_ins on public.org_members for insert with check (
  (exists (select 1 from public.organizations g where g.id = org_members.org_id and g.owner_id = (select auth.uid()))) or is_admin()
);
create policy om_upd on public.org_members for update
  using ((exists (select 1 from public.organizations g where g.id = org_members.org_id and g.owner_id = (select auth.uid()))) or is_admin())
  with check ((exists (select 1 from public.organizations g where g.id = org_members.org_id and g.owner_id = (select auth.uid()))) or is_admin());
create policy om_del on public.org_members for delete
  using ((exists (select 1 from public.organizations g where g.id = org_members.org_id and g.owner_id = (select auth.uid()))) or is_admin());

-- ================================== plans ===================================
alter policy pl_sel on public.plans using (active or is_admin() or is_super());
drop policy if exists pl_all on public.plans;
create policy pl_ins on public.plans for insert with check (is_super());
create policy pl_upd on public.plans for update using (is_super()) with check (is_super());
create policy pl_del on public.plans for delete using (is_super());

-- ============================ platform_settings =============================
alter policy pset_sel on public.platform_settings using ((key ~~ 'public.%') or is_super());
drop policy if exists pset_all on public.platform_settings;
create policy pset_ins on public.platform_settings for insert with check (is_super());
create policy pset_upd on public.platform_settings for update using (is_super()) with check (is_super());
create policy pset_del on public.platform_settings for delete using (is_super());

-- ============================== role_permissions =============================
alter policy rp_sel on public.role_permissions using (is_staff() or is_admin());
drop policy if exists rp_all on public.role_permissions;
create policy rp_ins on public.role_permissions for insert with check (is_admin());
create policy rp_upd on public.role_permissions for update using (is_admin()) with check (is_admin());
create policy rp_del on public.role_permissions for delete using (is_admin());

-- ================================= servers ===================================
alter policy sv_sel on public.servers using (is_staff() or is_admin());
drop policy if exists sv_all on public.servers;
create policy sv_ins on public.servers for insert with check (is_admin());
create policy sv_upd on public.servers for update using (is_admin()) with check (is_admin());
create policy sv_del on public.servers for delete using (is_admin());

-- =============================== site_content ================================
alter policy sc_sel on public.site_content using ((status = 'published') or has_perm('content.edit'));
drop policy if exists sc_all on public.site_content;
create policy sc_ins on public.site_content for insert with check (has_perm('content.edit'));
create policy sc_upd on public.site_content for update using (has_perm('content.edit')) with check (has_perm('content.edit'));
create policy sc_del on public.site_content for delete using (has_perm('content.edit'));

-- =============================== subscriptions ================================
alter policy s_sel on public.subscriptions using ((user_id = (select auth.uid())) or is_admin());
drop policy if exists s_all on public.subscriptions;
create policy s_ins on public.subscriptions for insert to authenticated with check (is_admin());
create policy s_upd on public.subscriptions for update to authenticated using (is_admin()) with check (is_admin());
create policy s_del on public.subscriptions for delete to authenticated using (is_admin());

commit;

-- After running, verify with:
--   select * from pg_policies where schemaname='public' order by tablename;
-- and re-run the Performance advisor — the 47 "multiple permissive policies"
-- warnings and the 2 duplicate-index warnings should be gone.
