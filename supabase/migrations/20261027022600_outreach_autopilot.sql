-- =============================================================================
-- Social Outreach: Autopilot, with a daily OK on the people it reaches
-- (docs/outreach.md, decision 151).
--
-- The owner's decision (3 Nov 2026, "1a 2a 3a 4a 5a 6a 7a"): a new setting
-- beside Everything on its own. Everything goes on its own on every network
-- the person works, and each day it asks them to OK the people it plans to
-- reach for the first time, so they can catch anyone who should be Don't
-- pitch or Never contact first. Once OK'd, the steps after go without asking.
--
--        `automation.autopilot` is the switch; the person's own choices stay
--        kept under it, and come back when it's off. `autopilot_listed_on` is
--        the business's day its list was last made for them: once a day, an
--        hour before their working hours, and anyone found later waits for
--        the next day's list.
--
--        `autopilot_people` keeps each person it asked about, one row a
--        person and profile: waiting for the OK, OK'd for good, or left out
--        for the day (`not_today`); the day of the list they were last on,
--        what it planned for them and why, and whether they were a spare past
--        the day's limits.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.automation
  add column autopilot boolean not null default false,
  add column autopilot_listed_on date;

create table addon_outreach.autopilot_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  platform text not null check (platform in ('facebook', 'linkedin', 'instagram', 'alignable')),
  -- The business's day of the list they were last on: "2026-11-04".
  day date not null,
  state text not null default 'waiting' check (state in ('waiting', 'ok', 'not_today')),
  -- What it planned for them that day: a step on Today's list ("warm_up", "friend_request", "opener" ...).
  kind text not null check (length(kind) between 1 and 40),
  why text[] not null default '{}',
  spare boolean not null default false,
  okd_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index autopilot_people_day_idx on addon_outreach.autopilot_people (workspace_id, user_id, day);
create index autopilot_people_profile_idx on addon_outreach.autopilot_people (profile_id);
select private.addon_table_policies('addon_outreach.autopilot_people', 'outreach.use', 'outreach.use', null, null);
create policy autopilot_people_own on addon_outreach.autopilot_people as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
