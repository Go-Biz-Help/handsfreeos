-- =============================================================================
-- Social Outreach (outreach): the extension on its own (docs/outreach.md,
-- decisions 26 to 36).
--
--        `automation` keeps what each person lets the extension do for them
--        on Facebook without pressing anything, and when: sending, replies,
--        tidying, liking a post before a friend request, confirming
--        requests that fit, collecting once a day, joining groups, their
--        working hours, and the training wheels for the fully automatic
--        choices. One a person in a business; until they save theirs, the
--        defaults stand.
--
--        `touches.auto` marks a step the extension took on its own, not one
--        the person pressed.
--
--        `profiles.warm_up_missed_at` marks a profile with no post to like
--        before a friend request: the request goes without.
--
-- Only adds: nothing is dropped or changed.
-- =============================================================================

alter table addon_outreach.touches
  add column auto boolean not null default false;

alter table addon_outreach.profiles
  add column warm_up_missed_at timestamptz;

create table addon_outreach.automation (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  sending text not null default 'off' check (sending in ('off', 'steps', 'everything', 'approve_all')),
  replies text not null default 'draft' check (replies in ('draft', 'simple', 'everything')),
  tidying text not null default 'off' check (tidying in ('off', 'cancel', 'cancel_unfriend')),
  warm_up boolean not null default true,
  confirm_requests boolean not null default true,
  collect boolean not null default true,
  join_groups boolean not null default false,
  -- On the business's clock; days are 0 (Sunday) to 6.
  hours_start smallint not null default 9 check (hours_start between 0 and 23),
  hours_end smallint not null default 17 check (hours_end between 1 and 24 and hours_end > hours_start),
  days smallint[] not null default '{1,2,3,4,5}'
    check (cardinality(days) between 1 and 7 and days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  -- Training wheels for the fully automatic choices: since when, messages OK'd, and whether each of the last ones
  -- was changed first.
  wheels_from timestamptz,
  wheels_ok integer not null default 0 check (wheels_ok >= 0),
  wheels_edits boolean[] not null default '{}' check (cardinality(wheels_edits) <= 10),
  wheels_done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id)
);
select private.addon_table_policies('addon_outreach.automation', 'outreach.use', 'outreach.use', null, null);
