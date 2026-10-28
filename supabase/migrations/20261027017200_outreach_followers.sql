-- =============================================================================
-- Social Outreach: your Facebook followers, checked like friends
-- (docs/outreach.md, decision 113).
--
-- The owner's decision (settled):
--
--        Once a week it reads your followers, the AI checks each one like
--        a friend, and the fits go on Today for a friend request.
--
-- `followers` keeps, for each person, who follows them on Facebook as their
-- computer last read it (`seen_at`): someone who isn't their friend is
-- checked by the AI like a friend is, inside the day's checks, and a good fit
-- goes on Today for a friend request. `follower_reads` keeps when each
-- person's computer last read the list, so it's read once a week.
--
-- A check of a follower who isn't a friend says so (`checks.via` takes
-- `follower`): it counts with the checks of people the person knows, and
-- shows with the people they know only once they're friends.
--
-- Only adds: two tables, and a check that lets one more kind.
-- =============================================================================

create table addon_outreach.followers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  profile_id uuid not null,
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, profile_id),
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index followers_profile_idx on addon_outreach.followers (workspace_id, profile_id);
select private.addon_table_policies('addon_outreach.followers', 'outreach.use', 'outreach.use', null, null);
create policy followers_own on addon_outreach.followers as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table addon_outreach.follower_reads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null default 'facebook' check (platform in ('facebook')),
  read_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform)
);
select private.addon_table_policies('addon_outreach.follower_reads', 'outreach.use', 'outreach.use', null, null);
create policy follower_reads_own on addon_outreach.follower_reads as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.checks drop constraint checks_via_check;
alter table addon_outreach.checks add constraint checks_via_check
  check (via in ('known', 'found', 'follower'));
