-- AI operations centre: servers (credentials stored encrypted and write-only), command log, owner chat. Super Admin only.
create table if not exists public.ops_servers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 2 and 60),
  host text not null, port int not null default 22 check (port between 1 and 65535),
  ssh_user text not null default 'root',
  auth_type text not null check (auth_type in ('password','key')),
  autonomy text not null default 'ask_destructive' check (autonomy in ('ask_destructive','full_auto')),
  host_fingerprint text,                                   -- pinned on first connect; a different key is refused
  status text not null default 'unknown' check (status in ('unknown','online','offline','error')),
  last_seen timestamptz, last_error text, os_info text,
  fail_streak int not null default 0, alerted boolean not null default false,
  watch_services text[] not null default '{}',             -- restarted automatically by the sweep when they stop
  created_by uuid, created_at timestamptz not null default now()
);
-- ciphertext only; no policy exists for this table, so only the service role (the edge function) can read or write it
create table if not exists public.ops_server_secrets (
  server_id uuid primary key references public.ops_servers(id) on delete cascade,
  ciphertext text not null, updated_at timestamptz not null default now()
);
create table if not exists public.ops_runs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid references public.ops_servers(id) on delete set null, server_name text,
  actor_id uuid, source text not null default 'chat' check (source in ('chat','alert','approval','health')),
  command text not null, why text,
  risk text not null check (risk in ('read','change','destructive')),
  status text not null check (status in ('pending_approval','running','done','failed','rejected')),
  exit_code int, output text, decided_by uuid,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists ops_runs_server_idx on public.ops_runs(server_id, created_at desc);
create index if not exists ops_runs_pending_idx on public.ops_runs(status) where status = 'pending_approval';
create table if not exists public.ops_chat (
  id bigint generated always as identity primary key,
  user_id uuid not null, role text not null check (role in ('user','assistant','system')),
  content text not null, run_ids uuid[] not null default '{}', created_at timestamptz not null default now()
);
create index if not exists ops_chat_user_idx on public.ops_chat(user_id, id desc);

alter table public.ops_servers enable row level security;
alter table public.ops_server_secrets enable row level security;
alter table public.ops_runs enable row level security;
alter table public.ops_chat enable row level security;
do $$ begin
  create policy ops_s_sel on public.ops_servers for select to authenticated using (public.is_super());
  create policy ops_r_sel on public.ops_runs for select to authenticated using (public.is_super());
  create policy ops_c_sel on public.ops_chat for select to authenticated using (public.is_super() and user_id = (select auth.uid()));
exception when duplicate_object then null; end $$;
revoke all on public.ops_server_secrets from anon, authenticated;
revoke insert, update, delete on public.ops_servers, public.ops_runs, public.ops_chat from anon, authenticated;

-- the log is evidence: it can be appended and finished, never edited or deleted
create or replace function public.ops_runs_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then raise exception 'ops_log_is_permanent'; end if;
  if new.command is distinct from old.command or new.risk is distinct from old.risk or new.server_name is distinct from old.server_name or new.created_at is distinct from old.created_at then raise exception 'ops_log_fields_locked'; end if;
  if old.status in ('done','failed','rejected') and new.status is distinct from old.status then raise exception 'ops_run_already_finished'; end if;
  return new;
end $$;
drop trigger if exists trg_ops_runs_guard on public.ops_runs;
create trigger trg_ops_runs_guard before update or delete on public.ops_runs for each row execute function public.ops_runs_guard();
revoke all on function public.ops_runs_guard() from public, anon, authenticated;
