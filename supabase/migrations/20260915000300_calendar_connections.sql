-- =============================================================================
-- 0017 · Calendar connections. Each person links their own Google or Outlook
--        calendar: HandsFreeOS reads their busy times (times only, never
--        titles) so nobody is booked over the dentist, and writes its
--        appointments back as events. Tokens are sealed by the worker and never
--        readable by `authenticated`, exactly like connected mailboxes (0012).
--        People see their own connection (owners and admins see everyone's)
--        and can only disconnect it. The OAuth callback now finds a pending
--        mailbox or calendar connection by its one-time state.
-- =============================================================================

create type app.calendar_provider as enum ('google', 'microsoft');
create type app.calendar_connection_status as enum ('pending', 'active', 'reauth_required', 'error', 'disconnected');

create table app.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  provider app.calendar_provider not null,
  status app.calendar_connection_status not null default 'pending',
  account_email text check (account_email is null or (account_email = lower(account_email) and position('@' in account_email) > 1)),
  scopes text[] not null default '{}',
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  busy_synced_at timestamptz,
  next_sync_at timestamptz,
  failures integer not null default 0 check (failures >= 0),
  last_error text check (last_error is null or length(last_error) <= 2000),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live connection per person in a workspace (activating a reconnect disconnects the old one first);
-- unfinished sign-ins may pile up until they expire.
create unique index calendar_connections_one_live on app.calendar_connections (workspace_id, user_id)
  where status in ('active', 'reauth_required', 'error');
create index calendar_connections_sync_idx on app.calendar_connections (next_sync_at) where status = 'active';
create index calendar_connections_user_idx on app.calendar_connections (user_id);
create trigger calendar_connections_updated_at before update on app.calendar_connections for each row execute function private.set_updated_at();
create trigger calendar_connections_immutable before update on app.calendar_connections for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'provider', 'created_by');

-- People disconnect a calendar; signing in, tokens and syncing are the worker's.
create or replace function private.guard_calendar_connection_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status = 'disconnected' or new.status is distinct from 'disconnected' then
    raise exception 'People can only disconnect a calendar' using errcode = '42501', detail = 'calendar_connection_status_transition';
  end if;
  new.disconnected_at := now();
  new.token_enc := null;
  new.pkce_verifier_enc := null;
  new.next_sync_at := null;
  return new;
end $$;
create trigger calendar_connections_update_guard before update on app.calendar_connections for each row execute function private.guard_calendar_connection_update();

-- ---------- busy times read from the person's calendar (the worker replaces them on every refresh) ----------
create table app.calendar_busy_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  connection_id uuid not null references app.calendar_connections (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index calendar_busy_blocks_range_idx on app.calendar_busy_blocks (workspace_id, user_id, starts_at, ends_at);
create index calendar_busy_blocks_connection_idx on app.calendar_busy_blocks (connection_id, starts_at);

-- A disconnected calendar stops blocking time at once, whoever disconnected it.
create or replace function private.clear_calendar_busy_blocks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from app.calendar_busy_blocks b where b.connection_id = new.id;
  return null;
end $$;
create trigger calendar_connections_clear_busy after update of status on app.calendar_connections
  for each row when (new.status = 'disconnected' and old.status is distinct from 'disconnected')
  execute function private.clear_calendar_busy_blocks();

-- ---------- events written into people's calendars point at the connection that wrote them ----------
alter table app.appointment_calendar_events
  add constraint appointment_calendar_events_connection_id_fkey
  foreign key (connection_id) references app.calendar_connections (id) on delete set null;
create index appointment_calendar_events_connection_idx on app.appointment_calendar_events (connection_id)
  where connection_id is not null;

-- ---------- references stay inside the workspace (and with the right person), whoever writes ----------
create or replace function private.check_calendar_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean := true;
begin
  if tg_table_name = 'calendar_connections' then
    v_ok := private.workspace_has_user(new.workspace_id, new.user_id);
  elsif tg_table_name = 'calendar_busy_blocks' then
    v_ok := exists (select 1 from app.calendar_connections c
      where c.id = new.connection_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id);
  elsif tg_table_name = 'appointment_calendar_events' then
    v_ok := new.connection_id is null or exists (select 1 from app.calendar_connections c
      where c.id = new.connection_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id);
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger calendar_connections_check_refs before insert on app.calendar_connections for each row execute function private.check_calendar_connection_refs();
create trigger calendar_busy_blocks_check_refs before insert or update of connection_id, user_id on app.calendar_busy_blocks for each row execute function private.check_calendar_connection_refs();
create trigger appointment_calendar_events_check_connection before insert or update of connection_id on app.appointment_calendar_events for each row execute function private.check_calendar_connection_refs();

-- ---------- RLS ----------
alter table app.calendar_connections enable row level security;
alter table app.calendar_busy_blocks enable row level security;

create policy calendar_connections_select on app.calendar_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'calendars.manage')));
-- Only for yourself (you sign in to your own Google or Outlook), and only a pending sign-in: the insert is
-- granted on the whole table, so the policy keeps tokens and results out.
create policy calendar_connections_insert on app.calendar_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and user_id = (select auth.uid())
    and created_by = (select auth.uid()) and status = 'pending' and account_email is null
    and pkce_verifier_enc is null and token_enc is null and token_key_id is null and token_expires_at is null
    and connected_at is null and disconnected_at is null and failures = 0);
create policy calendar_connections_update on app.calendar_connections for update to authenticated
  using ((user_id = (select auth.uid()) and private.has_permission(workspace_id, 'appointments.write'))
    or private.has_permission(workspace_id, 'calendars.manage'))
  with check ((user_id = (select auth.uid()) and private.has_permission(workspace_id, 'appointments.write'))
    or private.has_permission(workspace_id, 'calendars.manage'));
create policy calendar_connections_service_all on app.calendar_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- The team view shows everyone's busy time.
create policy calendar_busy_blocks_select on app.calendar_busy_blocks for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()));
create policy calendar_busy_blocks_service_all on app.calendar_busy_blocks for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- People see a connection's state, never its sealed tokens or sign-in secrets. RETURNING must name
-- columns from this list (a bare RETURNING * would ask for the tokens and be refused).
grant select (id, workspace_id, user_id, provider, status, account_email, scopes, token_expires_at, busy_synced_at,
  next_sync_at, failures, last_error, connected_at, disconnected_at, created_by, created_at, updated_at)
  on app.calendar_connections to authenticated;
grant insert on app.calendar_connections to authenticated;
grant update (status) on app.calendar_connections to authenticated;
grant select on app.calendar_busy_blocks to authenticated;

grant select, insert, update, delete on app.calendar_connections, app.calendar_busy_blocks to service_actor;
revoke all on app.calendar_connections, app.calendar_busy_blocks from anon;

-- ---------- the OAuth callback (the tenant is not known yet) ----------
-- The pending mailbox or calendar sign-in a one-time state (hashed) belongs to. Both kinds share
-- /oauth/:provider/callback; private.mailbox_connection_by_state stays for the mailbox code.
create or replace function private.oauth_connection_by_state(p_state_hash text)
returns table (kind text, connection_id uuid, workspace_id uuid, organization_id uuid, provider text,
  status text, user_id uuid, state_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'mailbox', mc.id, mc.workspace_id, w.organization_id, mc.provider::text, mc.status::text, mc.user_id,
    mc.oauth_state_expires_at
  from app.mailbox_connections mc join app.workspaces w on w.id = mc.workspace_id
  where mc.oauth_state_hash = p_state_hash
  union all
  select 'calendar', cc.id, cc.workspace_id, w.organization_id, cc.provider::text, cc.status::text, cc.user_id,
    cc.oauth_state_expires_at
  from app.calendar_connections cc join app.workspaces w on w.id = cc.workspace_id
  where cc.oauth_state_hash = p_state_hash
$$;

revoke all on function
  private.guard_calendar_connection_update(), private.clear_calendar_busy_blocks(),
  private.check_calendar_connection_refs(), private.oauth_connection_by_state(text)
  from public;
grant execute on function
  private.guard_calendar_connection_update(), private.clear_calendar_busy_blocks(),
  private.check_calendar_connection_refs()
  to authenticated, service_actor;
grant execute on function private.oauth_connection_by_state(text) to service_actor;
