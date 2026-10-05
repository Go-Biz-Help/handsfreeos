-- =============================================================================
-- The client portal's sign-in (Real Estate round two, step 2; core, for every
-- portal).
--
--        Chris decided (2026-09-30) that a client gets into their portal with
--        a private link, and on a new device types a 6-digit code emailed to
--        them; no password. Core builds this for any portal (Real Estate's now,
--        the planned Customer Portal later).
--
--        **portal_access**: one per person a business let in. The link is
--        `/c/<public_ref><code>`, the code an HMAC the worker signs over the
--        access and its `link_version` (the invoice links' scheme): nothing
--        secret is kept, and raising the version (turning it off, or a fresh
--        link) retires every link sent before.
--        **portal_codes**: a 6-digit code emailed to the address on file,
--        kept only as a hash; ten minutes, three an hour, five tries.
--        **portal_sessions**: a signed-in device. The worker makes a random
--        bearer and keeps only its hash; a session lasts 30 days from its
--        last use and 90 at most, and ends when the access is turned off.
--
--        People in the business see who has access and their devices (never
--        a hash); only the worker reads codes and checks sessions.
-- =============================================================================

create table app.portal_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- 8 random base62 characters, unique and not secret: the start of the link (/c/...).
  public_ref text not null unique default private.new_public_ref() check (public_ref ~ '^[0-9A-Za-z]{8}$'),
  link_version integer not null default 1 check (link_version >= 1),
  given_by uuid references app.users (id) on delete set null,
  given_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references app.users (id) on delete set null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, person_id),
  check ((revoked_at is null) or (revoked_at >= given_at))
);
create index portal_access_given_by_idx on app.portal_access (given_by) where given_by is not null;
create index portal_access_revoked_by_idx on app.portal_access (revoked_by) where revoked_by is not null;
create trigger portal_access_updated_at before update on app.portal_access
  for each row execute function private.set_updated_at();
create trigger portal_access_immutable before update on app.portal_access
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'person_id', 'public_ref');

comment on table app.portal_access is
  'A client let into their portal (Real Estate round two, core): the link''s reference and version, who gave it, whether it''s off.';

create table app.portal_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  access_id uuid not null references app.portal_access (id) on delete cascade,
  -- sha256 of "<access id>:<code>"; the code itself is never kept.
  code_hash bytea not null check (length(code_hash) = 32),
  attempts integer not null default 0 check (attempts between 0 and 10),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index portal_codes_access_idx on app.portal_codes (access_id, created_at desc);
create index portal_codes_workspace_idx on app.portal_codes (workspace_id);

create table app.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  access_id uuid not null references app.portal_access (id) on delete cascade,
  person_id uuid not null references app.people (id) on delete cascade,
  -- sha256 of the bearer the device holds; the bearer itself is never kept.
  token_hash bytea not null unique check (length(token_hash) = 32),
  device text check (device is null or length(device) <= 200),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason is null or ended_reason in ('signed_out', 'access_off', 'replaced')),
  check ((ended_at is null) = (ended_reason is null))
);
create index portal_sessions_access_idx on app.portal_sessions (access_id) where ended_at is null;
create index portal_sessions_person_idx on app.portal_sessions (person_id);
create index portal_sessions_workspace_idx on app.portal_sessions (workspace_id);

-- A link's version only goes up, and letting someone back in raises it: a link sent before can never work again.
create or replace function private.keep_portal_link_forward()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.link_version < old.link_version
     or (old.revoked_at is not null and new.revoked_at is null and new.link_version <= old.link_version) then
    raise exception 'A portal link''s version only goes up' using errcode = 'check_violation',
      constraint = 'portal_access_link_forward';
  end if;
  return new;
end $$;
create trigger portal_access_link_forward before update of link_version, revoked_at on app.portal_access
  for each row execute function private.keep_portal_link_forward();

-- Turning access off, or a fresh link, signs every device out.
create or replace function private.end_portal_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.revoked_at is not null and old.revoked_at is null or new.link_version <> old.link_version then
    update app.portal_sessions s set ended_at = now(), ended_reason = 'access_off'
    where s.access_id = new.id and s.ended_at is null;
  end if;
  return null;
end $$;
create trigger portal_access_ends_sessions after update of revoked_at, link_version on app.portal_access
  for each row execute function private.end_portal_sessions();

-- The worker's lookup by the link's reference, which knows nothing of row security.
create or replace function private.portal_link_lookup(p_ref text)
returns table (access_id uuid, workspace_id uuid, organization_id uuid, person_id uuid, link_version integer,
  revoked boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id, a.person_id, a.link_version, a.revoked_at is not null
  from app.portal_access a join app.workspaces w on w.id = a.workspace_id
  where a.public_ref = p_ref
$$;
revoke all on function private.portal_link_lookup(text) from public;
grant execute on function private.portal_link_lookup(text) to service_actor;

-- The worker's lookup of a signed-in device by its bearer's hash.
create or replace function private.portal_session_lookup(p_hash bytea)
returns table (session_id uuid, access_id uuid, workspace_id uuid, organization_id uuid, person_id uuid,
  last_seen_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.access_id, s.workspace_id, w.organization_id, s.person_id, s.last_seen_at, s.expires_at
  from app.portal_sessions s
  join app.portal_access a on a.id = s.access_id
  join app.workspaces w on w.id = s.workspace_id
  where s.token_hash = p_hash and s.ended_at is null and a.revoked_at is null
    and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
$$;
revoke all on function private.portal_session_lookup(bytea) from public;
grant execute on function private.portal_session_lookup(bytea) to service_actor;

-- ---------- who reads and writes them ----------
alter table app.portal_access enable row level security;
alter table app.portal_codes enable row level security;
alter table app.portal_sessions enable row level security;

-- People who may change customers give and turn off access (portal_access.give / .revoke); everyone in the
-- business sees who has it.
create policy portal_access_select on app.portal_access for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy portal_access_insert on app.portal_access for insert to authenticated
  with check (private.has_permission(workspace_id, 'records.write') and given_by = (select auth.uid())
              and revoked_at is null and last_used_at is null);
create policy portal_access_update on app.portal_access for update to authenticated
  using (private.has_permission(workspace_id, 'records.write'))
  with check (private.has_permission(workspace_id, 'records.write'));
create policy portal_access_service_all on app.portal_access for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert on app.portal_access to authenticated;
grant update (link_version, given_by, given_at, revoked_at, revoked_by) on app.portal_access to authenticated;
grant select, insert, update on app.portal_access to service_actor;
revoke all on app.portal_access from anon;

create policy portal_codes_service_all on app.portal_codes for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
grant select, insert, update on app.portal_codes to service_actor;
revoke all on app.portal_codes from anon, authenticated;

-- A business sees its clients' signed-in devices, never their hashes.
create policy portal_sessions_select on app.portal_sessions for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy portal_sessions_service_all on app.portal_sessions for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());
revoke all on app.portal_sessions from anon, authenticated;
grant select (id, workspace_id, access_id, person_id, device, created_at, last_seen_at, expires_at, ended_at,
  ended_reason) on app.portal_sessions to authenticated;
grant select, insert, update on app.portal_sessions to service_actor;
