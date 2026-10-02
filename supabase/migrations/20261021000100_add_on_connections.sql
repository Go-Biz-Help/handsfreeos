-- =============================================================================
-- An add-on's connections to other services (Real Estate, round five, step 1).
--
--        A business couldn't give an add-on its account somewhere else: the
--        add-on guide listed "an add-on's own credentials" under Not yet,
--        and round five's listing feeds (Repliers, AnyProp, an MLS's RESO
--        Web API) and e-sign need exactly that. Chris decided (2026-10-02)
--        that HandsFreeOS's own Repliers account is used by default, and a
--        brokerage can connect its own instead.
--
--        **A connection.** One row per service an add-on is connected to for
--        one of the things its manifest says it connects (`connector`, say
--        listing_data): a key the business pasted (`key`), a sign-in
--        (`oauth`), or HandsFreeOS's own account (`platform`), whose key
--        lives only in the worker's environment.
--
--        **Secrets are the worker's.** The worker tries a key with the
--        service before anything is kept, then seals it with its own key
--        (as Twilio keys and calendar tokens are). Nobody selects a sealed
--        column, and every write is the worker's (the service role); a
--        person asks through the worker's route, or the functions below,
--        which check their permission.
--
--        **Health.** Each says when it last worked, since when it's failing
--        and why, so a screen can say what's affected, and nothing is
--        marked done because a service was down.
--
--        **Turning the add-on off.** Disabled, its connections wait. Once
--        uninstalled, their secrets are wiped; purging deletes them.
-- =============================================================================

create table app.addon_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  addon_id text not null check (addon_id ~ '^[a-z]{2,16}$'),
  -- What it's for, as the add-on's manifest names it (listing_data, esign), and the service (repliers).
  connector text not null check (connector ~ '^[a-z][a-z0-9_]{0,39}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,39}$'),
  auth text not null check (auth in ('key', 'oauth', 'platform')),
  status text not null default 'active'
    check (status in ('pending', 'active', 'reauth_required', 'error', 'disconnected')),
  -- The add-on permission it takes to manage it (from the manifest), and to see it here.
  permission text not null,
  -- Who it is at the service, as people there would know it ("data@x.com", "Unlock MLS"). Never a secret.
  label text check (label is null or length(label) <= 200),
  -- The service's own id for the account: how its updates find this connection.
  account_ref text check (account_ref is null or length(account_ref) <= 200),
  -- What else is safe to show (the MLSs it covers, the scopes granted). Never a secret.
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  -- Sealed by the worker (v1.<key id>.…); nobody else reads it.
  secret_enc text,
  key_id text,
  token_expires_at timestamptz,
  -- A sign-in under way: its one-time state (hashed) and the PKCE verifier, sealed.
  oauth_state_hash bytea,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  -- Its own address for the service's updates (step 2): only the token's hash is kept.
  webhook_token_hash bytea unique,
  webhook_secret_enc text,
  last_success_at timestamptz,
  failing_since timestamptz,
  failures integer not null default 0 check (failures >= 0),
  last_error text check (last_error is null or length(last_error) <= 500),
  connected_by uuid references app.users (id) on delete set null,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (permission like addon_id || '.%'),
  -- A pasted key that's in use has its sealed secret; a disconnected one has none.
  check (auth <> 'key' or status not in ('active', 'error') or secret_enc is not null),
  check (status <> 'disconnected' or (secret_enc is null and pkce_verifier_enc is null))
);
-- One live connection per service for each thing an add-on connects: the business's own, and HandsFreeOS's beside it.
create unique index addon_connections_live_idx
  on app.addon_connections (workspace_id, addon_id, connector, provider, (auth = 'platform'))
  where status <> 'disconnected';
create index addon_connections_workspace_idx on app.addon_connections (workspace_id, addon_id);
create index addon_connections_account_idx on app.addon_connections (addon_id, provider, account_ref)
  where account_ref is not null and status <> 'disconnected';
create index addon_connections_connected_by_idx on app.addon_connections (connected_by) where connected_by is not null;
create trigger addon_connections_updated_at before update on app.addon_connections
  for each row execute function private.set_updated_at();
create trigger addon_connections_immutable before update on app.addon_connections
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'addon_id', 'connector', 'provider');

comment on table app.addon_connections is
  'An add-on''s account at another service, for one thing it connects (round five): a pasted key or sign-in sealed '
  'by the worker, or HandsFreeOS''s own account. Nobody selects a sealed column; only the worker writes.';

alter table app.addon_connections enable row level security;
-- People who may manage it see it (never its sealed columns, below).
create policy addon_connections_select on app.addon_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
         and private.has_permission(workspace_id, permission));
-- Every write is the worker's: trying a key with the service and sealing it, or wiping it.
create policy addon_connections_service_all on app.addon_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

revoke all on app.addon_connections from public, anon, authenticated;
grant select (id, workspace_id, addon_id, connector, provider, auth, status, permission, label, details,
  token_expires_at, last_success_at, failing_since, failures, last_error, connected_by, connected_at,
  disconnected_at, created_at, updated_at) on app.addon_connections to authenticated;
grant select, insert, update, delete on app.addon_connections to service_actor;

-- What an add-on's screens may know about one of its connections, for anyone who uses the add-on (not only those
-- who manage it) and for the worker in that business: which service, whether it works, and since when it doesn't.
-- Never a secret.
create or replace function private.addon_connection_live(p_ws uuid, p_addon text, p_connector text)
returns table (id uuid, provider text, auth text, status text, label text, last_success_at timestamptz,
               failing_since timestamptz, last_error text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.provider, c.auth, c.status, c.label, c.last_success_at, c.failing_since, c.last_error
  from app.addon_connections c
  where c.workspace_id = p_ws and c.addon_id = p_addon and c.connector = p_connector
    and c.status <> 'disconnected'
    and private.may_ask_about(p_ws)
    and private.addon_in_use(p_ws, p_addon, false)
  order by (c.auth = 'platform'), c.connected_at desc nulls last
$$;
grant execute on function private.addon_connection_live(uuid, text, text) to authenticated, service_actor;

-- Letting one go: a person who may manage it. The secret is wiped there and then.
create or replace function private.disconnect_addon_connection(p_ws uuid, p_connection uuid)
returns table (connector text, provider text, auth text, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v app.addon_connections;
begin
  select * into v from app.addon_connections c where c.id = p_connection and c.workspace_id = p_ws for update;
  if v.id is null or p_ws not in (select private.accessible_workspace_ids())
     or not private.has_permission(p_ws, v.permission) then
    raise exception 'No such connection here' using errcode = 'P0002', detail = 'addon_connection_not_found';
  end if;
  if v.auth = 'platform' and not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff turn off its own account'
      using errcode = '42501', detail = 'addon_connection_platform_is_ours';
  end if;
  if v.status = 'disconnected' then
    return query select v.connector, v.provider, v.auth, false;
    return;
  end if;
  update app.addon_connections c
  set status = 'disconnected', secret_enc = null, key_id = null, pkce_verifier_enc = null, oauth_state_hash = null,
      webhook_token_hash = null, webhook_secret_enc = null, disconnected_at = now()
  where c.id = v.id;
  return query select v.connector, v.provider, v.auth, true;
end $$;
grant execute on function private.disconnect_addon_connection(uuid, uuid) to authenticated;

-- HandsFreeOS's own account for a business (Chris, 2026-10-02: on by default, turned on when staff hand the add-on
-- over). Staff only; its key is in the worker's environment, never here.
create or replace function private.set_addon_platform_connection(
  p_ws uuid, p_addon text, p_connector text, p_provider text, p_permission text, p_label text, p_on boolean)
returns table (connection_id uuid, changed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not private.staff_can('platform.addons.manage') then
    raise exception 'Only HandsFreeOS staff turn on its own account for a business'
      using errcode = '42501', detail = 'addon_connection_platform_is_ours';
  end if;
  if not exists (select 1 from app.workspaces w where w.id = p_ws) then
    raise exception 'No business with that id' using errcode = '23503', detail = 'no_workspace';
  end if;
  select c.id into v_id from app.addon_connections c
  where c.workspace_id = p_ws and c.addon_id = p_addon and c.connector = p_connector and c.provider = p_provider
    and c.auth = 'platform' and c.status <> 'disconnected';
  if p_on then
    if v_id is not null then
      return query select v_id, false;
      return;
    end if;
    insert into app.addon_connections (workspace_id, addon_id, connector, provider, auth, status, permission, label,
                                       connected_by, connected_at)
    values (p_ws, p_addon, p_connector, p_provider, 'platform', 'active', p_permission, nullif(btrim(p_label), ''),
            auth.uid(), now())
    returning id into v_id;
    return query select v_id, true;
  else
    if v_id is null then
      return query select null::uuid, false;
      return;
    end if;
    update app.addon_connections c set status = 'disconnected', disconnected_at = now() where c.id = v_id;
    return query select v_id, true;
  end if;
end $$;
grant execute on function private.set_addon_platform_connection(uuid, text, text, text, text, text, boolean)
  to authenticated;

-- Uninstalled: an add-on that's gone holds no business's keys. Purging: its connections go with its data.
create or replace function private.addon_connections_follow_install()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.state in ('uninstalled', 'purging', 'purged') and new.state is distinct from old.state then
    update app.addon_connections c
    set status = 'disconnected', secret_enc = null, key_id = null, pkce_verifier_enc = null, oauth_state_hash = null,
        webhook_token_hash = null, webhook_secret_enc = null, disconnected_at = coalesce(c.disconnected_at, now())
    where c.workspace_id = new.workspace_id and c.addon_id = new.addon_id and c.status <> 'disconnected';
  end if;
  if new.state in ('purging', 'purged') and new.state is distinct from old.state then
    delete from app.addon_connections c where c.workspace_id = new.workspace_id and c.addon_id = new.addon_id;
  end if;
  return new;
end $$;
create trigger addon_installations_connections after update of state on app.addon_installations
  for each row execute function private.addon_connections_follow_install();
