-- =============================================================================
-- 0002 · Tenancy: organizations, workspaces, locations, teams, users,
--        memberships, role_permissions. Plus the triggers that keep invariants
--        no matter which role is writing (updated_at, user mirror, immutable
--        tenant columns, last-owner protection).
-- =============================================================================

create type app.member_role as enum ('owner', 'admin', 'member');
create type app.org_role as enum ('owner', 'admin');
create type app.actor_type as enum ('human', 'system', 'workflow', 'assistant', 'ai_employee', 'api', 'integration');

-- ---------- helper: updated_at ----------
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- helper: rank ----------
create or replace function private.role_rank(p_role text)
returns int language sql immutable parallel safe set search_path = '' as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end
$$;

-- ---------- organizations ----------
create table app.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated_at before update on app.organizations
  for each row execute function private.set_updated_at();

-- ---------- workspaces ----------
create table app.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  timezone text not null default 'America/Chicago',
  industry text not null default 'home_services',
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);
create index workspaces_organization_idx on app.workspaces (organization_id);
create trigger workspaces_updated_at before update on app.workspaces
  for each row execute function private.set_updated_at();

-- ---------- locations & teams (schema only in Milestone 1) ----------
create table app.locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  address jsonb not null default '{}'::jsonb,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index locations_workspace_idx on app.locations (workspace_id);
create trigger locations_updated_at before update on app.locations
  for each row execute function private.set_updated_at();

create table app.teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  location_id uuid references app.locations (id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index teams_workspace_idx on app.teams (workspace_id);
create trigger teams_updated_at before update on app.teams
  for each row execute function private.set_updated_at();

-- ---------- users (profile mirror of auth.users) ----------
create table app.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email extensions.citext not null unique,
  full_name text not null default '',
  avatar_url text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_updated_at before update on app.users
  for each row execute function private.set_updated_at();

-- Fault tolerant on purpose: a failure here must never block sign-up.
create or replace function private.handle_auth_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into app.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update set email = excluded.email;
  return new;
exception when others then
  raise warning 'app.users mirror failed for %: %', new.id, sqlerrm;
  return new;
end $$;

create or replace function private.handle_auth_user_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update app.users set email = new.email where id = new.id and email is distinct from new.email::extensions.citext;
  return new;
exception when others then
  raise warning 'app.users email sync failed for %: %', new.id, sqlerrm;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_auth_user_created();
create trigger on_auth_user_updated after update of email on auth.users
  for each row execute function private.handle_auth_user_updated();

-- ---------- memberships ----------
create table app.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  role app.org_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_memberships_user_idx on app.organization_memberships (user_id, organization_id);
create trigger organization_memberships_updated_at before update on app.organization_memberships
  for each row execute function private.set_updated_at();

create table app.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  role app.member_role not null default 'member',
  team_id uuid references app.teams (id) on delete set null,
  location_id uuid references app.locations (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index workspace_memberships_user_idx on app.workspace_memberships (user_id, workspace_id);
create trigger workspace_memberships_updated_at before update on app.workspace_memberships
  for each row execute function private.set_updated_at();

-- ---------- invariant: tenant columns never move ----------
create or replace function private.forbid_tenant_column_change()
returns trigger language plpgsql set search_path = '' as $$
declare
  cols text[] := tg_argv;
  c text;
  old_v text;
  new_v text;
begin
  foreach c in array cols loop
    execute format('select ($1).%I::text, ($2).%I::text', c, c) into old_v, new_v using old, new;
    if old_v is distinct from new_v then
      raise exception '% is immutable on %.%', c, tg_table_schema, tg_table_name using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

create trigger workspaces_immutable before update on app.workspaces
  for each row execute function private.forbid_tenant_column_change('organization_id');
create trigger locations_immutable before update on app.locations
  for each row execute function private.forbid_tenant_column_change('workspace_id');
create trigger teams_immutable before update on app.teams
  for each row execute function private.forbid_tenant_column_change('workspace_id');
create trigger organization_memberships_immutable before update on app.organization_memberships
  for each row execute function private.forbid_tenant_column_change('organization_id', 'user_id');
create trigger workspace_memberships_immutable before update on app.workspace_memberships
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id');

-- ---------- invariant: an organization always keeps an Owner ----------
create or replace function private.protect_last_org_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not exists (
      select 1 from app.organization_memberships m
      where m.organization_id = old.organization_id and m.role = 'owner' and m.user_id <> old.user_id
    ) then
      raise exception 'An organization must keep at least one Owner' using errcode = '23514', detail = 'last_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger organization_memberships_last_owner before update or delete on app.organization_memberships
  for each row execute function private.protect_last_org_owner();

-- ---------- invariant: a workspace keeps someone who can administer it ----------
-- A direct workspace Owner may only be demoted or removed if another direct
-- Owner remains, or an Owner of the organization (other than this user) exists.
create or replace function private.protect_last_workspace_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not exists (
      select 1 from app.workspace_memberships m
      where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id
    ) and not exists (
      select 1 from app.organization_memberships om
      join app.workspaces w on w.organization_id = om.organization_id
      where w.id = old.workspace_id and om.role = 'owner' and om.user_id <> old.user_id
    ) then
      raise exception 'A workspace must keep at least one Owner' using errcode = '23514', detail = 'last_owner';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger workspace_memberships_last_owner before update or delete on app.workspace_memberships
  for each row execute function private.protect_last_workspace_owner();

-- ---------- role_permissions (source of truth, mirrored in @hfos/core) ----------
create table app.role_permissions (
  role text not null check (role in ('owner', 'admin', 'member', 'org_owner', 'org_admin')),
  permission text not null check (permission ~ '^[a-z_]+(\.[a-z_]+)+$'),
  primary key (role, permission)
);

insert into app.role_permissions (role, permission) values
  ('owner', 'workspace.read'), ('owner', 'workspace.update'), ('owner', 'workspace.delete'),
  ('owner', 'members.read'), ('owner', 'members.invite'), ('owner', 'members.change_role'), ('owner', 'members.remove'),
  ('owner', 'invitations.read'), ('owner', 'invitations.revoke'), ('owner', 'audit.read'),
  ('admin', 'workspace.read'), ('admin', 'workspace.update'),
  ('admin', 'members.read'), ('admin', 'members.invite'), ('admin', 'members.change_role'), ('admin', 'members.remove'),
  ('admin', 'invitations.read'), ('admin', 'invitations.revoke'), ('admin', 'audit.read'),
  ('member', 'workspace.read'), ('member', 'members.read'),
  ('org_owner', 'org.read'), ('org_owner', 'org.update'), ('org_owner', 'org.delete'),
  ('org_owner', 'org.members.manage'), ('org_owner', 'workspace.create'), ('org_owner', 'org.audit.read'),
  ('org_admin', 'org.read'), ('org_admin', 'workspace.create'), ('org_admin', 'org.audit.read');

-- ---------- grants (RLS policies arrive in 0005) ----------
grant select on app.organizations, app.workspaces, app.locations, app.teams, app.users,
  app.organization_memberships, app.workspace_memberships, app.role_permissions to authenticated;
grant insert on app.workspaces to authenticated;
grant update on app.organizations, app.workspaces, app.organization_memberships, app.workspace_memberships to authenticated;
grant update (full_name, avatar_url, settings, updated_at) on app.users to authenticated;
grant delete on app.organization_memberships, app.workspace_memberships to authenticated;

grant select on app.organizations, app.workspaces, app.locations, app.teams, app.users,
  app.organization_memberships, app.workspace_memberships, app.role_permissions to service_actor;

-- PostgREST roles get nothing here even if the schema were ever exposed.
revoke all on all tables in schema app from anon;
