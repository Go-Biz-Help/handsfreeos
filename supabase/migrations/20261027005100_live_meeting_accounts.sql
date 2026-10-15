-- =============================================================================
-- The Zoom app for live coaching, apart from the one that makes meeting links
-- (HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md, round three; Chris,
-- 2026-10-14: "keep the Zoom coach separate so a slow review doesn't hold up
-- meeting links", and "people install it into their Zoom and connect it to
-- HandsFreeOS, so it knows they're an active user").
--
--        A **live meeting account** says which HandsFreeOS person a Zoom user
--        is, in one business, for the coaching app. Someone adds the app from
--        Zoom's Marketplace (or presses Connect in HandsFreeOS), signs in to
--        Zoom, then to HandsFreeOS, and picks the business: the worker keeps
--        the link. Nothing else is kept from Zoom: no tokens, since the app only
--        needs to know who started a meeting's stream.
--
--        The worker writes these; a person sees their own and may disconnect
--        it. Removing the app in Zoom disconnects it everywhere.
--
--        A claim on a meeting (app.live_meetings) is heard only when its
--        person's live meeting account started the stream, so the waiting
--        claims now name that account's Zoom user rather than the meeting-link
--        connection's.
-- =============================================================================

create table app.live_meeting_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  provider text not null default 'zoom' check (provider in ('zoom')),
  -- Zoom's id for the user, which its webhooks name (`operator_id`, `user_id`).
  external_user_id text not null check (length(external_user_id) between 1 and 200),
  account_email text check (account_email is null or (account_email = lower(account_email)
    and position('@' in account_email) > 1 and length(account_email) <= 320)),
  status text not null default 'active' check (status in ('active', 'disconnected')),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((status = 'disconnected') = (disconnected_at is not null))
);
-- One per person per business, and one person per Zoom user in a business.
create unique index live_meeting_accounts_one_per_person on app.live_meeting_accounts (workspace_id, user_id, provider)
  where status = 'active';
create unique index live_meeting_accounts_one_per_zoom_user on app.live_meeting_accounts (workspace_id, provider, external_user_id)
  where status = 'active';
create index live_meeting_accounts_external_idx on app.live_meeting_accounts (provider, external_user_id)
  where status = 'active';
create index live_meeting_accounts_user_idx on app.live_meeting_accounts (user_id);
create trigger live_meeting_accounts_updated_at before update on app.live_meeting_accounts
  for each row execute function private.set_updated_at();
create trigger live_meeting_accounts_immutable before update on app.live_meeting_accounts
  for each row execute function private.forbid_tenant_column_change('workspace_id', 'user_id', 'provider', 'external_user_id');

create or replace function private.check_live_meeting_account_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(private.workspace_has_user(new.workspace_id, new.user_id), false) then
    raise exception 'References must belong to the same workspace' using errcode = '23514', detail = 'record_workspace_mismatch';
  end if;
  return new;
end $$;
create trigger live_meeting_accounts_check_refs before insert on app.live_meeting_accounts
  for each row execute function private.check_live_meeting_account_refs();

-- People only disconnect; connecting is the worker's.
create or replace function private.guard_live_meeting_account_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.system_scope_workspace() = new.workspace_id, false) then
    return new;
  end if;
  if old.status <> 'active' or new.status <> 'disconnected' then
    raise exception 'People can only disconnect a Zoom account' using errcode = '42501', detail = 'live_meeting_account_status_transition';
  end if;
  new.disconnected_at := now();
  return new;
end $$;
create trigger live_meeting_accounts_update_guard before update on app.live_meeting_accounts
  for each row execute function private.guard_live_meeting_account_update();

-- ---------- RLS ----------
alter table app.live_meeting_accounts enable row level security;

create policy live_meeting_accounts_select on app.live_meeting_accounts for select to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid()));
create policy live_meeting_accounts_update on app.live_meeting_accounts for update to authenticated
  using (workspace_id in (select private.accessible_workspace_ids()) and user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy live_meeting_accounts_service_all on app.live_meeting_accounts for all to service_actor
  using (workspace_id = private.system_scope_workspace())
  with check (workspace_id = private.system_scope_workspace());

grant select on app.live_meeting_accounts to authenticated;
grant update (status) on app.live_meeting_accounts to authenticated;
grant select, insert, update, delete on app.live_meeting_accounts to service_actor;
revoke all on app.live_meeting_accounts from anon;

-- ---------- what the worker looks up across businesses ----------
-- Removed in Zoom: that Zoom user's links in every business.
create or replace function private.live_meeting_accounts_by_external_user(p_provider text, p_external_user_id text)
returns table (account_id uuid, workspace_id uuid, organization_id uuid)
language sql stable security definer set search_path = '' as $$
  select a.id, a.workspace_id, w.organization_id
  from app.live_meeting_accounts a join app.workspaces w on w.id = a.workspace_id
  where a.provider = p_provider and a.external_user_id = p_external_user_id and a.status = 'active'
$$;
revoke all on function private.live_meeting_accounts_by_external_user(text, text) from public;
grant execute on function private.live_meeting_accounts_by_external_user(text, text) to service_actor;

-- The waiting claims on a meeting, each with its person's coaching-app Zoom user.
create or replace function private.live_meetings_waiting(p_provider text, p_meeting_uuid text)
returns table (live_meeting_id uuid, workspace_id uuid, organization_id uuid, user_id uuid,
  external_user_id text, person_id uuid, screen_name text)
language sql stable security definer set search_path = '' as $$
  select lm.id, lm.workspace_id, w.organization_id, lm.user_id,
    (select a.external_user_id from app.live_meeting_accounts a
      where a.workspace_id = lm.workspace_id and a.user_id = lm.user_id and a.provider = lm.provider
        and a.status = 'active'
      limit 1),
    lm.person_id, lm.screen_name
  from app.live_meetings lm join app.workspaces w on w.id = lm.workspace_id
  where lm.provider = p_provider and lm.meeting_uuid = p_meeting_uuid and lm.state = 'waiting'
    and lm.created_at > now() - interval '1 hour'
  order by lm.created_at desc
  limit 20
$$;
