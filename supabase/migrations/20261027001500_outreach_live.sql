-- =============================================================================
-- Social Outreach (outreach): live status and control (docs/outreach.md,
-- decision 41).
--
--        `computers` keeps each place the extension runs for a person: the
--        id it made once, a plain name ("Chrome on Windows"), when it was
--        last seen and last used, what it shows right now, and when the app
--        was last told about its line. Only the most recently used one
--        works; the others stand by.
--
--        `days` is the record of the person's day: started or stopped, why,
--        from where, and when. The extension follows it.
--
--        `live_steps` is the feed of each step the extension takes, and the
--        day's starts, stops and warnings. Today's are shown; a week is kept.
--
-- Each person's rows are their own on the database (see the end): owners and
-- admins see the team's status and counts through private functions that give
-- no line.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

create table addon_outreach.computers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The id the extension made once and keeps in its own storage.
  install_id uuid not null,
  name text not null check (char_length(name) between 1 and 60),
  version text check (version is null or char_length(version) <= 20),
  last_seen_at timestamptz not null,
  -- The last time the person used it: the panel opened, a step of their own, sign-in, Start or Stop there.
  active_at timestamptz,
  -- What it shows right now, as it last said.
  state text not null default 'idle'
    check (state in ('working', 'waiting', 'idle', 'stopped', 'off', 'standby', 'trouble', 'signed_out')),
  line text check (line is null or char_length(line) <= 300),
  line_at timestamptz,
  next_at timestamptz,
  -- When it last told the app: a change to its line alone tells it at most every 45 seconds.
  told_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, install_id)
);
create index computers_user_idx on addon_outreach.computers (workspace_id, user_id, active_at desc nulls last);
select private.addon_table_policies('addon_outreach.computers', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.days (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The business's day it's for: a row for an earlier day means nothing pressed today.
  day date not null,
  state text not null check (state in ('started', 'stopped')),
  why text check (why is null or why in ('person', 'warning')),
  via text not null check (via in ('web', 'mobile', 'extension')),
  -- When it was pressed (the moment the extension or phone sent): an older press never undoes a newer one.
  changed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id),
  check ((state = 'stopped') = (why is not null))
);
select private.addon_table_policies('addon_outreach.days', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.live_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  -- The computer that took it; null for a line HandsFreeOS wrote (a day started or stopped, a warning).
  computer_id uuid,
  -- The extension's own id for the line: a beat sent again keeps it once.
  client_id uuid not null default gen_random_uuid(),
  at timestamptz not null,
  kind text not null check (kind in ('done', 'passed', 'job', 'stopped', 'day')),
  line text not null check (char_length(line) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, client_id),
  foreign key (workspace_id, computer_id) references addon_outreach.computers (workspace_id, id)
    on delete cascade
);
create index live_steps_user_idx on addon_outreach.live_steps (workspace_id, user_id, at desc);
create index live_steps_computer_idx on addon_outreach.live_steps (computer_id);
select private.addon_table_policies('addon_outreach.live_steps', 'outreach.use', 'outreach.use', null, null);

-- Each person's own, on the database too: a person reads and writes only
-- their own computers, day and feed. A computer's line says what it's doing,
-- naming the people reached, so owners and admins (outreach.manage) see the
-- team's computers only through private.outreach_team_computers below, which
-- gives no line. A day holds no words (started or stopped, why, from where),
-- so they may read the team's days, for its status (outreach.live.team);
-- never change them. The feed stays the person's alone. The worker runs as
-- service_actor, which these don't narrow.
create policy computers_own_read on addon_outreach.computers as restrictive for select to authenticated
  using (user_id = (select auth.uid()));
create policy computers_own_insert on addon_outreach.computers as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy computers_own_update on addon_outreach.computers as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy days_own_read on addon_outreach.days as restrictive for select to authenticated
  using (user_id = (select auth.uid()) or private.has_permission(workspace_id, 'outreach.manage'));
create policy days_own_insert on addon_outreach.days as restrictive for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy days_own_update on addon_outreach.days as restrictive for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy live_steps_own on addon_outreach.live_steps as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Whether the caller may count for these people in a business (the team view,
-- Waiting for you): owners and admins (outreach.manage) for anyone; a person
-- for themself alone; the worker scoped to the business, told by its role,
-- which nobody else can take.
create or replace function private.outreach_may_count(p_ws uuid, p_users uuid[])
returns boolean language sql stable security definer set search_path = '' as $$
  select p_ws is not null and (
    (current_setting('role', true) = 'service_actor' and p_ws = private.system_scope_workspace())
    or private.has_permission(p_ws, 'outreach.manage')
    or (private.has_permission(p_ws, 'outreach.use') and p_users <@ array[(select auth.uid())]))
$$;

-- The team's computers as owners and admins see them (outreach.live.team):
-- which one works, its state and when it was last seen; never its line.
create or replace function private.outreach_team_computers(p_ws uuid)
returns table (id uuid, user_id uuid, name text, state text, last_seen_at timestamptz, active_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.user_id, c.name, c.state, c.last_seen_at, c.active_at
  from addon_outreach.computers c
  where c.workspace_id = p_ws
    and private.outreach_may_count(p_ws, array[c.user_id])
$$;
revoke all on function private.outreach_may_count(uuid, uuid[]) from public;
revoke all on function private.outreach_team_computers(uuid) from public;
grant execute on function private.outreach_may_count(uuid, uuid[]) to authenticated, service_actor;
grant execute on function private.outreach_team_computers(uuid) to authenticated, service_actor;
