-- App builder (Expo / React Native): super admin + users the super admin enables, private project files,
-- and vault-backed secrets for automated EAS builds. Additive only.

alter table public.profiles add column if not exists apps_access boolean not null default false;

create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is not null then
    if new.role is distinct from old.role and not public.is_super() then
      raise exception 'only super admin can change roles';
    end if;
    if new.apps_access is distinct from old.apps_access and not public.is_super() then
      raise exception 'only super admin can enable apps';
    end if;
    if new.status is distinct from old.status then
      if not public.is_admin() then raise exception 'not allowed to change status'; end if;
      if old.role = 'super_admin' and not public.is_super() then raise exception 'cannot change a super admin'; end if;
    end if;
  end if;
  return new;
end $function$;

create or replace function public.can_build_apps()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'active' and (role = 'super_admin' or apps_access));
$$;

create or replace function public.guard_app_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.site_type = 'app' and auth.uid() is not null and not public.can_build_apps() then
    raise exception 'apps_not_enabled';
  end if;
  return new;
end $function$;

create trigger trg_guard_app_insert before insert on public.websites for each row execute function public.guard_app_insert();

-- project files for "View in Expo Go" (served to Expo Snack through short-lived signed URLs only)
insert into storage.buckets (id, name, public) values ('app-files', 'app-files', false) on conflict (id) do nothing;

-- secrets for the EAS build pipeline (GitHub token to start the workflow, shared secret the workflow calls back with)
create table if not exists public.integration_secrets (
  name text primary key check (name in ('github_token', 'build_secret')),
  secret_id uuid not null,
  updated_at timestamptz not null default now()
);
alter table public.integration_secrets enable row level security;

create or replace function public.admin_set_integration_secret(p_name text, p_value text)
returns void language plpgsql security definer set search_path to 'public', 'vault' as $function$
declare v_secret uuid;
begin
  if not public.is_super() then raise exception 'forbidden'; end if;
  if p_name not in ('github_token', 'build_secret') then raise exception 'unknown secret'; end if;
  if p_value is null or length(trim(p_value)) < 8 then raise exception 'invalid value'; end if;
  select secret_id into v_secret from public.integration_secrets where name = p_name;
  if v_secret is null then
    v_secret := vault.create_secret(trim(p_value), 'integration_' || p_name, 'integration secret');
    insert into public.integration_secrets (name, secret_id) values (p_name, v_secret);
  else
    perform vault.update_secret(v_secret, trim(p_value));
    update public.integration_secrets set updated_at = now() where name = p_name;
  end if;
  insert into public.audit_logs (actor_id, action, entity, meta) values (auth.uid(), 'integration.secret_set', 'integration_secrets', jsonb_build_object('name', p_name));
end $function$;

create or replace function public.integration_secret_status()
returns table (name text, updated_at timestamptz) language sql stable security definer set search_path to 'public' as $$
  select name, updated_at from public.integration_secrets where public.is_super();
$$;

create or replace function public.get_integration_secret(p_name text)
returns text language sql stable security definer set search_path to 'public', 'vault' as $$
  select d.decrypted_secret from public.integration_secrets s join vault.decrypted_secrets d on d.id = s.secret_id where s.name = p_name;
$$;
revoke execute on function public.get_integration_secret(text) from public, anon, authenticated;
