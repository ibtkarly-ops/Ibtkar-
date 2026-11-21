-- ============================================================================
-- IBTIKAR — PHP/Node.js generation + VPS deployment support
--
-- Additive only: no column is dropped, no existing row is touched, no
-- existing RLS policy's behavior changes. Safe to run on the live database.
-- ============================================================================
begin;

-- Which tech stack this website is built as.
--   null / 'html' -> today's behaviour: a single self-contained HTML string
--                     in websites.config.html, published to Cloudflare
--                     Workers exactly as before. Nothing changes for these.
--   'php'         -> multi-file project in websites.config.files
--                     ({path: content}), deployed to the VPS deploy-agent.
--   'node'        -> same, Node.js project (package.json + server.js).
alter table public.websites
  add column if not exists stack text
  check (stack is null or stack = any (array['html','php','node']));

comment on column public.websites.stack is
  'html/null = static single-page generator (Cloudflare Workers, unchanged); php/node = multi-file project deployed to the VPS deploy-agent.';

-- The AI prompt library gained two more site types that now have their own
-- tailored instructions (clinic, portfolio) instead of silently falling
-- back to the generic "landing" prompt.
alter table public.ai_prompts drop constraint if exists ai_prompts_key_check;
alter table public.ai_prompts
  add constraint ai_prompts_key_check
  check (key = any (array['master','restaurant','company','landing','store','clinic','portfolio']));

-- A server row to represent the VPS in the existing admin "Servers" /
-- "Deployments" screens, reusing the exact same tables already used for
-- Cloudflare — no schema change needed for deployments/servers themselves.
insert into public.servers (name, region, provider, status)
select 'VPS (PHP/Node apps)', null, 'vps', 'not_verified'
where not exists (select 1 from public.servers where provider = 'vps');

-- Where the deploy-agent lives. The shared secret itself is NOT stored
-- here (platform_settings is plain text, not encrypted) — it lives only
-- in the deploy-vps Edge Function's own secrets (DEPLOY_AGENT_SECRET),
-- set via `supabase secrets set`, exactly like every other credential in
-- this project (see docs/SUPABASE_DEPLOY.md).
insert into public.platform_settings (key, value)
values ('public.apps_domain', 'apps.ibtkar.ly')
on conflict (key) do nothing;

commit;
