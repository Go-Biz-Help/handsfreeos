-- =============================================================================
-- Social Outreach (outreach): groups, scored against the playbooks, with the
-- people found in them (the plan's Phase 1 step 4, docs/outreach.md).
--
--        The extension saves the groups the person sees (their own groups,
--        search results, a group's page) with what the page says about each:
--        public or private, how many members, the line under its name. How
--        each fits the playbooks is worked out when it's read, never kept, so
--        a changed playbook changes it at once (groups.ts).
--
--        `group_people` are the people saved from a group's People tab, each
--        with the lines under their name and the part of the list they were in.
--        Admins and moderators are kept as such (`runs_group`), so nobody who
--        runs a group is ever suggested. The tab shows only a few of them until
--        its See all page is read: `admins_read_at` says it has been, and only
--        then are a group's members suggested for friend requests.
--
--        `my_groups` says which groups each person is in, as their Facebook
--        showed it.
-- =============================================================================

alter table addon_outreach.groups
  add column privacy text check (privacy in ('public', 'private')),
  add column members integer check (members is null or members >= 0),
  add column detail text check (detail is null or length(btrim(detail)) between 1 and 300),
  add column admins_read_at timestamptz,
  add column seen_at timestamptz;

create table addon_outreach.group_people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  group_id uuid not null,
  profile_id uuid not null,
  -- An admin or a moderator: never approached.
  runs_group boolean not null default false,
  -- The part of the list they were in: "Members near you", "Admins and moderators".
  part text check (part is null or length(btrim(part)) between 1 and 100),
  -- The lines under their name: "Owner at Pine Street Bakery", "Lives in Austin".
  lines text[] not null default '{}' check (cardinality(lines) <= 4),
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (group_id, profile_id),
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, profile_id) references addon_outreach.profiles (workspace_id, id) on delete cascade
);
create index group_people_profile_idx on addon_outreach.group_people (profile_id);
select private.addon_table_policies('addon_outreach.group_people', 'outreach.use', 'outreach.use', null, null);

create table addon_outreach.my_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app.workspaces (id) on delete cascade,
  user_id uuid not null references app.users (id) on delete cascade,
  group_id uuid not null,
  joined boolean not null,
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, user_id, group_id),
  foreign key (workspace_id, group_id) references addon_outreach.groups (workspace_id, id) on delete cascade
);
create index my_groups_group_idx on addon_outreach.my_groups (group_id);
select private.addon_table_policies('addon_outreach.my_groups', 'outreach.use', 'outreach.use', null, null);
