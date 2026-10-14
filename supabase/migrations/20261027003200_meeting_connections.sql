-- =============================================================================
-- Video meetings: Zoom (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md, step 2).
--        Each person links their own Zoom account, so HandsFreeOS can make a
--        Zoom meeting for their online appointments. Built like calendar
--        connections (20260915000300): tokens are sealed by the worker and
--        never readable by `authenticated`; people see their own connection
--        (owners and admins see everyone's) and can only disconnect it. The
--        OAuth callback now also finds a pending Zoom sign-in by its state.
-- =============================================================================

create type app.meeting_provider as enum ('zoom');

create table app.meeting_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  provider app.meeting_provider not null,
  status app.calendar_connection_status not null default 'pending',
  account_email text check (account_email is null or (account_email = lower(account_email) and position('@' in account_email) > 1)),
  -- The provider's own id for the account (Zoom's user id), for its webhooks later.
  external_user_id text check (external_user_id is null or length(external_user_id) <= 200),
  scopes text[] not null default '{}',
  oauth_state_hash text unique,
  oauth_state_expires_at timestamptz,
  pkce_verifier_enc text,
  token_enc text,
  token_key_id text,
  token_expires_at timestamptz,
  failures integer not null default 0 check (failures >= 0),
  last_error text check (last_error is null or length(last_error) <= 2000),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references app.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live connection per person and provider in a workspace (activating a reconnect disconnects the old one).
create unique index meeting_connections_one_live on app.meeting_connections (workspace_id, user_id, provider)
  where status in ('active', 'reauth_required', 'error');
create index meeting_connections_user_idx on app.meeting_connections (user_id);
create trigger meeting_connections_updated_at before update on app.meeting_connections for each row execute function private.set_updated_at();
create trigger meeting_connections_immutable before update on app.meeting_connections for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'provider', 'created_by');

-- People disconnect; signing in and tokens are the worker's.
create or replace function private.guard_meeting_connection_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status = 'disconnected' or new.status is distinct from 'disconnected' then
    raise exception 'People can only disconnect a meeting account' using errcode = '42501', detail = 'meeting_connection_status_transition';
  end if;
  new.disconnected_at := now();
  new.token_enc := null;
  new.pkce_verifier_enc := null;
  return new;
end $$;
create trigger meeting_connections_update_guard before update on app.meeting_connections for each row execute function private.guard_meeting_connection_update();

create or replace function private.check_meeting_connection_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger meeting_connections_check_refs before insert on app.meeting_connections for each row execute function private.check_meeting_connection_refs();

-- ---------- RLS ----------
alter table app.meeting_connections enable row level security;

create policy meeting_connections_select on app.meeting_connections for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids())
    and (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'calendars.manage')));
-- Only for yourself, and only a pending sign-in: the insert is granted on the whole table, so the policy keeps
-- tokens and results out.
create policy meeting_connections_insert on app.meeting_connections for insert to authenticated
  with check (private.has_permission(workspace_id, 'appointments.write') and user_id = (select auth.uid())
    and created_by = (select auth.uid()) and status = 'pending' and account_email is null
    and external_user_id is null and pkce_verifier_enc is null and token_enc is null and token_key_id is null
    and token_expires_at is null and connected_at is null and disconnected_at is null and failures = 0);
create policy meeting_connections_update on app.meeting_connections for update to authenticated
  using ((user_id = (select auth.uid()) and private.has_permission(workspace_id, 'appointments.write'))
    or private.has_permission(workspace_id, 'calendars.manage'))
  with check ((user_id = (select auth.uid()) and private.has_permission(workspace_id, 'appointments.write'))
    or private.has_permission(workspace_id, 'calendars.manage'));
create policy meeting_connections_service_all on app.meeting_connections for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

-- ---------- grants ----------
-- People see a connection's state, never its sealed tokens or sign-in secrets.
grant select (id, workspace_id, user_id, provider, status, account_email, scopes, token_expires_at, failures,
  last_error, connected_at, disconnected_at, created_by, created_at, updated_at)
  on app.meeting_connections to authenticated;
grant insert on app.meeting_connections to authenticated;
grant update (status) on app.meeting_connections to authenticated;
grant select, insert, update, delete on app.meeting_connections to service_actor;
revoke all on app.meeting_connections from anon;

-- ---------- the OAuth callback finds a Zoom sign-in too ----------
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
  union all
  select 'payment', pc.id, pc.workspace_id, w.organization_id, pc.provider::text, pc.status::text, null::uuid,
    pc.oauth_state_expires_at
  from app.payment_connections pc join app.workspaces w on w.id = pc.workspace_id
  where pc.oauth_state_hash = p_state_hash
  union all
  select 'reviews', rc.id, rc.workspace_id, w.organization_id, rc.provider::text, rc.status::text, null::uuid,
    rc.oauth_state_expires_at
  from app.review_connections rc join app.workspaces w on w.id = rc.workspace_id
  where rc.oauth_state_hash = p_state_hash
  union all
  -- Facebook Pages and Instagram accounts for the inbox: the business's, not a person's, and always Facebook's
  -- sign-in, sharing its callback with the Facebook reviews.
  select 'meta', xc.id, xc.workspace_id, w.organization_id, 'facebook', xc.status, null::uuid,
    xc.oauth_state_expires_at
  from app.meta_connections xc join app.workspaces w on w.id = xc.workspace_id
  where xc.oauth_state_hash = p_state_hash
  union all
  -- A person's own Zoom account, for video meetings.
  select 'meeting', vc.id, vc.workspace_id, w.organization_id, vc.provider::text, vc.status::text, vc.user_id,
    vc.oauth_state_expires_at
  from app.meeting_connections vc join app.workspaces w on w.id = vc.workspace_id
  where vc.oauth_state_hash = p_state_hash
$$;

create or replace function private.oauth_state_started_by(p_state_hash text)
returns uuid language sql stable security definer set search_path = '' as $$
  select x.created_by from (
    select mc.created_by from app.mailbox_connections mc where mc.oauth_state_hash = p_state_hash
    union all
    select cc.created_by from app.calendar_connections cc where cc.oauth_state_hash = p_state_hash
    union all
    select pc.created_by from app.payment_connections pc where pc.oauth_state_hash = p_state_hash
    union all
    select rc.created_by from app.review_connections rc where rc.oauth_state_hash = p_state_hash
    union all
    select mg.created_by from app.migration_connections mg where mg.oauth_state_hash = p_state_hash
    union all
    select xc.created_by from app.meta_connections xc where xc.oauth_state_hash = p_state_hash
    union all
    select vc.created_by from app.meeting_connections vc where vc.oauth_state_hash = p_state_hash
  ) x
  limit 1
$$;

revoke all on function
  private.guard_meeting_connection_update(), private.check_meeting_connection_refs(),
  private.oauth_connection_by_state(text), private.oauth_state_started_by(text)
  from public;
grant execute on function private.guard_meeting_connection_update(), private.check_meeting_connection_refs()
  to authenticated, service_actor;
grant execute on function private.oauth_connection_by_state(text), private.oauth_state_started_by(text)
  to service_actor;
