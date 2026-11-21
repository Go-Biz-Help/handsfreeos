-- =============================================================================
-- Social Outreach: events near you on Facebook, and a Today card listing them
-- (docs/outreach.md, decision 188; the owner's pick 7a of 20 Nov 2026).
--
-- The owner's decision (settled):
--
--        Local Facebook events are read once a week like Alignable's, and
--        the hosts and people going get the AI's check, with nothing
--        pressed. Plus a Today card listing the events so you can go in
--        person.
--
--        event_reads    takes 'facebook' beside 'alignable'.
--        events         each event a person's computer read near them: its
--                       name, when and where as the page said, and who hosts
--                       it, for Today's card. Put aside with Not going.
--        event_people   on Facebook, who hosts or is going to each event:
--                       checked by the AI like friends (`checks.via` takes
--                       `event`), and a good fit goes on Today for a friend
--                       request.
--
-- Only adds: two tables with their policies, and two wider checks.
-- =============================================================================

alter table addon_outreach.event_reads drop constraint event_reads_platform_check;
alter table addon_outreach.event_reads add constraint event_reads_platform_check
  check (platform in ('alignable', 'facebook'));

create table addon_outreach.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  platform text not null check (platform in ('alignable', 'facebook')),
  url text not null check (length(url) between 1 and 500),
  name text not null check (length(btrim(name)) between 1 and 200),
  when_text text check (when_text is null or length(btrim(when_text)) between 1 and 120),
  starts_at timestamptz,
  place text check (place is null or length(btrim(place)) between 1 and 200),
  hosts text[] not null default '{}' check (cardinality(hosts) <= 10),
  seen_at timestamptz not null,
  skipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, platform, url)
);
create index events_user_idx on addon_outreach.events (workspace_id, user_id, platform, starts_at);
select private.addon_table_policies('addon_outreach.events', 'outreach.use', 'outreach.use', null, null);
create policy events_own on addon_outreach.events as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table addon_outreach.event_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  event_id uuid not null,
  profile_id uuid not null,
  host boolean not null default false,
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, event_id, profile_id),
  foreign key (workspace_id, event_id) references addon_outreach.events (workspace_id, id) on delete cascade,
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index event_people_profile_idx on addon_outreach.event_people (workspace_id, profile_id);
create index event_people_user_idx on addon_outreach.event_people (workspace_id, user_id, seen_at desc);
select private.addon_table_policies('addon_outreach.event_people', 'outreach.use', 'outreach.use', null, null);
create policy event_people_own on addon_outreach.event_people as restrictive for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

alter table addon_outreach.checks drop constraint checks_via_check;
alter table addon_outreach.checks add constraint checks_via_check
  check (via in ('known', 'found', 'follower', 'member', 'request', 'event'));
